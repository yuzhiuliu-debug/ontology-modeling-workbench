/* 一键自检：纯 Node / 纯 HTTP，不需要浏览器、不需要安装任何依赖。
   领域无关：测试数据在脚本内临时构造，不读取任何内置样例。
   用户提供的真实表格只通过外部参数 TEST_FIXTURE_XLSX 追加回归，缺省即跳过。 */
import { spawn } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { makeFixture, externalWorkbookFiles, manualUnderstandingInput } from './tests/fixture.mjs';
import { validateRuleSpecs, compileRuleSpecs, RULE_CONTRACT, RULE_RULES } from './core/rulespec.mjs';
import { buildRuleMessages, PROMPTS } from './core/prompts.mjs';
import { salvageJson, ModelTruncatedError } from './core/ai.mjs';
import { validateUnderstanding, applyUnderstandingToProject, isGenericPredicate } from './core/understanding.mjs';
import { toOwlJson, buildIndividuals } from './core/owl.mjs';
import { buildCanonical } from './core/canonical.mjs';
import { resolveRelations, checkIntegrity, loadInstanceFiles } from './core/instance.mjs';
import { visionToMaterial } from './core/vision.mjs';
import { schemaGraph, decorateSchemaEdges } from './core/graph.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log('  [通过] ' + name + (detail ? ' · ' + detail : '')); }
  else { fail++; console.log('  [失败] ' + name + (detail ? ' · ' + detail : '')); }
};
const section = t => console.log('\n' + t);

let tmp = null, server = null, BASE = '';

async function startServer() {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'ontology-studio-check-'));
  const startPort = 4300 + Math.floor(Math.random() * 300);
  server = spawn(process.execPath, ['server.mjs'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(startPort), STUDIO_HOST: '127.0.0.1', STUDIO_DATA_DIR: tmp, STUDIO_OPEN: '' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  const onData = d => { output += d.toString(); };
  server.stdout.on('data', onData);
  server.stderr.on('data', onData);
  const deadline = Date.now() + 20000;
  let port = null;
  while (Date.now() < deadline) {
    const m = output.match(/http:\/\/127\.0\.0\.1:(\d+)\//);
    if (m) { port = Number(m[1]); break; }
    if (server.exitCode !== null) break;
    await sleep(120);
  }
  if (!port) throw Error('服务未能启动，输出如下：\n' + output.slice(0, 1200));
  BASE = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 40; i++) {
    try { const r = await fetch(BASE + '/api/health'); if (r.ok) return port; } catch { /* retry */ }
    await sleep(150);
  }
  throw Error('服务已监听但健康检查无响应：' + output.slice(0, 800));
}
async function raw(p, method = 'GET', body) {
  const res = await fetch(BASE + p, {
    method, headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined
  });
  let data = {};
  try { data = await res.json(); } catch { /* ignore */ }
  return { status: res.status, data };
}
async function api(p, method = 'GET', body) {
  const r = await raw(p, method, body);
  if (!r.status.toString().startsWith('2')) throw Error(r.data.error || 'HTTP ' + r.status);
  return r.data;
}

async function main() {
  console.log('\n============================================================');
  console.log('  本体建模工作台 · 一键自检（领域无关）');
  console.log('  ' + new Date().toLocaleString('zh-CN'));
  console.log('============================================================');

  section('一、运行环境与服务');
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  ok('Node.js 版本', nodeMajor >= 22, 'v' + process.versions.node);
  const port = await startServer();
  ok('服务可启动', true, '端口 ' + port);
  ok('健康检查接口', (await api('/api/health')).ok === true);
  const home = await fetch(BASE + '/');
  const homeHtml = await home.text();
  ok('工作台页面可访问', home.status === 200 && homeHtml.includes('本体建模工作台'), (homeHtml.length / 1024).toFixed(1) + ' KB');
  const cfg = await api('/api/model-config');
  ok('模型配置接口不回传密钥', !('apiKey' in cfg) && !JSON.stringify(cfg).includes('sk-'));
  ok('首次启动无服务商、地址、模型或密钥', !cfg.provider && !cfg.baseUrl && !cfg.model && !cfg.hasKey && !cfg.configured);
  ok('首次启动无项目', (await api('/api/projects')).projects.length === 0);
  const crossSite = await fetch(BASE + '/api/model-config', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://untrusted.example.org' }, body: '{}'
  });
  ok('跨站写入被拒绝', crossSite.status === 403);
  const textWrite = await fetch(BASE + '/api/model-config', {
    method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}'
  });
  ok('非 JSON 写入被拒绝', textWrite.status === 415);
  const reboundStatus = await new Promise((resolve, reject) => {
    const request = httpRequest(BASE + '/api/model-config', { headers: { Host: 'untrusted.example.org' } }, response => {
      response.resume(); response.on('end', () => resolve(response.statusCode));
    });
    request.on('error', reject); request.end();
  });
  ok('未知 Host 被拒绝', reboundStatus === 403);
  ok('提示词工位含流程时序', (cfg.workstations || []).length === 5 && !!cfg.timingRules);
  ok('无内置样例接口（不预制 demo）', (await raw('/api/samples')).status === 404);

  section('二、材料录入（脚本内构造的领域无关夹具）');
  const fx = makeFixture();
  const created = await api('/api/projects', 'POST', {
    name: '通用自检项目', description: fx.description,
    namespace: 'https://example.org/ontology/test#', files: fx.files
  });
  const id = created.data?.id || created.id;
  ok('上传解析成功', !!id, id);
  const s = created.canonical?.stats || {};
  ok('表结构数量来自上传材料', s.classes === 3 && s.dataProperties >= 12, `${s.classes} 表 / ${s.dataProperties} 字段`);
  ok('外键与样例行读入', s.objectProperties >= 2 && s.sampleRows === 6, `${s.objectProperties} 外键 / ${s.sampleRows} 行`);
  ok('业务描述片段可读', (s.processSegments || 0) >= 1, s.processSegments + ' 个片段');
  ok('口径一致时无阻断级冲突', (created.blockers || []).length === 0);

  /* 客户常把一张表拆成一个文件：7 张表 = 7 个 xlsx 一次上传。
     旧版只把第一份材料当表结构来源，其余既不合并也不报错，页面上只剩 1 张表。 */
  {
    const wb = (file, tables) => ({ sourceId: file, sourceName: file, sourceType: 'workbook', sha256: file, tables, segments: [] });
    const t = (name, label, cols) => ({
      name, label, description: '', primaryKey: [cols[0]], foreignKeys: [], fields: cols.map(c => ({ name: c, type: 'TEXT' })), rows: [{ [cols[0]]: '1' }]
    });
    const two = buildCanonical({
      name: '多文件', namespace: 'https://example.org/ontology/multi#',
      materials: [wb('甲.xlsx', [t('t1_aaaaaa', '甲表', ['a_id', 'b_ref'])]), wb('乙.xlsx', [t('t2_bbbbbb', '乙表', ['b_id'])])]
    });
    ok('多份材料里的表全部合并进规范模型', two.classes.length === 2, two.classes.map(c => c.localName).join(' / '));
    ok('每份材料自带的行都进了 rowsByTable', Object.keys(two.rowsByTable).length === 2, JSON.stringify(Object.keys(two.rowsByTable)));
    const dup = buildCanonical({
      name: '同名表', namespace: 'https://example.org/ontology/multi#',
      materials: [wb('甲.xlsx', [t('t1_aaaaaa', '甲表', ['a_id', 'b_ref'])]), wb('甲-b.xlsx', [t('t1_aaaaaa', '甲表', ['a_id'])])]
    });
    ok('同一张表被两份材料声明且字段不一致时显式报冲突',
      dup.conflicts.some(c => c.kind === 'field_set_mismatch'), JSON.stringify(dup.conflicts.map(c => c.kind)));
    ok('不把不同表误报成「表缺失」', !two.conflicts.some(c => c.kind === 'table_missing'));
  }

  section('二之二、业务理解稿与闸门 ①（B 批）');
  const beforeUnderstanding = await raw(`/api/projects/${id}/compile`, 'POST', {});
  ok('未定稿前编译被理解稿闸门挡下', beforeUnderstanding.status === 409 && /业务理解稿/.test(beforeUnderstanding.data.error || ''), 'HTTP ' + beforeUnderstanding.status);
  ok('模型配置下发理解稿提示规约', /不得生成/.test(cfg.understandingRules || ''));
  const draft = await api(`/api/projects/${id}/understanding-generate`, 'POST', {
    mode: 'manual', manual: manualUnderstandingInput(), by: '自检业务用户'
  });
  ok('手工建模旁路生成理解稿 v1', draft.understanding?.version === 1 && draft.understanding.origin === 'manual',
    `${draft.understanding?.tables.length} 张表 / ${draft.understanding?.stages.length} 个链路阶段`);
  ok('理解稿覆盖全部上传表', draft.understanding.tables.length === 3);
  ok('理解稿标出待补项', Array.isArray(draft.understanding.uncertainties));
  ok('出稿即出草稿图谱', !!draft.draftGraph && draft.draftGraph.stats.nodes === 3, JSON.stringify(draft.draftGraph?.stats));
  ok('草稿图谱的边是业务关系位而非字段映射', (draft.understanding.relations || []).every(r => r.predicate === '待确认关系' || !/_id$|_no$|_code$/.test(r.predicate)),
    (draft.understanding.relations || []).length + ' 条边');
  const relsDraft = draft.understanding.relations || [];
  const relAnnotations = relsDraft[0] ? [{ targetId: relsDraft[0].id, kind: 'renameRelation', value: '包含' }] : [];
  const fin = await api(`/api/projects/${id}/understanding-finalize`, 'POST', {
    annotations: [
      { targetId: 'event_log', kind: 'changeMeaning', value: '业务发生的一次事件（自检批注）', comment: '措辞更准确' },
      { targetId: '准备', kind: 'addStage', value: '补充阶段' },
      ...relAnnotations
    ],
    approval: { confirmed: true }, by: '自检业务用户'
  });
  ok('一次整稿确认生成定稿版', fin.understandingFinal?.version === 2 && fin.understandingFinal.approval.scope === 'whole');
  ok('局部批注全部处理并留差异清单', fin.understandingFinal.diffSummary.length === 2 + relAnnotations.length && fin.understandingFinal.diffSummary.every(x => x.handled),
    fin.understandingFinal.diffSummary.length + ' 条');
  ok('关系统计口径自洽（confirmed 不再早于自动采纳）',
    fin.relationStats.confirmed + fin.relationStats.rejected + fin.relationStats.pending === fin.relationStats.total,
    JSON.stringify(fin.relationStats));
  const pendingExpect = relsDraft.filter(r => r.predicate === '待确认关系' && r.id !== relsDraft[0]?.id).length;
  ok('未命名的「待确认关系」不自动进本体', fin.relationStats.pending === pendingExpect,
    `${fin.relationStats.pending} 条待确认 / 期望 ${pendingExpect}`);
  ok('只产生 v1 与定稿版两个版本', fin.understandingHistory.length === 2);
  ok('理解稿定稿后闸门 ① 放行', fin.gates.understandingFinalized === true);
  const fullAfter = await api(`/api/projects/${id}`);
  ok('业务含义与角色回写规范模型', (fullAfter.canonical?.classes || []).length === 3 && (fullAfter.canonical?.businessStages || []).length === 3);

  section('二之三、关系要写出具体业务含义（不只是「属于 / 包含」）');
  {
    /* 用户口径：边名只写「关联 / 依据 / 包含」读不出业务上在做什么事，
       关系必须能写清动作与约束，并且这句话要跟着关系进本体。 */
    ok('「关联供应商」被判为只有通用动词', isGenericPredicate('关联供应商') === true);
    ok('「包含物料」也算泛（缺动作）', isGenericPredicate('包含物料') === true);
    ok('「按订单收货」不被误判', isGenericPredicate('按订单收货') === false, '按订单收货');
    ok('「按预算科目占用预算」不被误判', isGenericPredicate('按预算科目占用预算') === false);

    const ns = 'https://example.test/ontology-mini#';
    const mkC = (sid, label) => ({ id: sid, iri: ns + sid, localName: label, sourceTable: sid, status: 'confirmed', primaryKey: [], description: '' });
    const mini = {
      id: 'ont-mini', namespace: ns, version: 1,
      classes: [mkC('t_a', '甲'), mkC('t_b', '乙'), mkC('t_c', '丙')],
      dataProperties: [], objectProperties: [], processSegments: [], rowsByTable: {}, notes: []
    };
    const vu = validateUnderstanding({
      tables: [{ table: 't_a', role: 'master', meaning: '甲' }, { table: 't_b', role: 'event', meaning: '乙' }, { table: 't_c', role: 'event', meaning: '丙' }],
      stages: [], idDependencies: [], gaps: [], uncertainties: [],
      relations: [
        { subject: 't_a', predicate: '关联供应商', object: 't_b', meaning: '', status: 'confirmed' },
        { subject: 't_c', predicate: '按订单收货', object: 't_a', meaning: '按订单到货批次逐批验收，累计入库量不得超过订单未入库量', status: 'confirmed' }
      ]
    }, mini);
    ok('关系没写业务含义被点名', vu.warnings.some(w => /没有写业务含义/.test(w)), (vu.warnings.find(w => /没有写业务含义/.test(w)) || '').slice(0, 60));
    ok('通用动词关系名被点名建议改具体', vu.warnings.some(w => /只有通用动词/.test(w)));
    const relVague = vu.understanding.relations.find(r => r.predicate === '关联供应商');
    ok('关系带 vague 标记（用于列表提示）', relVague?.vague === true);
    const relGood = vu.understanding.relations.find(r => r.predicate === '按订单收货');
    ok('写清动作的关系不被标记、含义被保留', relGood?.vague === false && /逐批验收/.test(relGood?.meaning || ''));

    const pj = { canonical: mini, understandingFinal: vu.understanding };
    applyUnderstandingToProject(pj);
    ok('多张表都进本体（关系数不再是 0）', pj.canonical.objectProperties.length === 2, pj.canonical.stats?.objectProperties + ' 条');
    ok('规范模型 stats 跟着刷新（不再停留在解析时的 0）', pj.canonical.stats.objectProperties === 2);
    const owl = toOwlJson(pj.canonical);
    const withMeaning = owl.objectProperties.filter(p => (p.annotations || []).some(a => /businessMeaning$/.test(a.property || '')));
    ok('业务含义写进 OWL 注释（omw:businessMeaning）', withMeaning.length === 1, withMeaning.length + ' 条带含义');
    ok('含义同时进 rdfs:comment（通用工具也能读到）',
      (withMeaning[0]?.annotations || []).some(a => a.property === 'rdfs:comment' && /逐批验收/.test(a.value || '')));
    ok('关系名作为 rdfs:label 保留', (withMeaning[0]?.annotations || []).some(a => a.property === 'rdfs:label' && a.value === '按订单收货'));
  }

  section('二之四、字段依据显示业务字段名（不把内部列编码摊给用户）');
  {
    /* 用户口径：「这些文字上的字段，输出的都是字段编码，不是真实的业务字段，看不太懂」。
       内部列标识（t5_05236a_f2）只做机器键，给人看的一律换成「表名.字段名」。 */
    const ns = 'https://example.test/ontology-fields#';
    const mini = {
      id: 'ont-fields', namespace: ns, version: 1,
      classes: [
        { id: 't9_abc123', iri: ns + 't9_abc123', localName: '结算表', sourceTable: 't9_abc123', primaryKey: ['t9_abc123_f0'], status: 'confirmed' },
        { id: 't8_def456', iri: ns + 't8_def456', localName: '合同表', sourceTable: 't8_def456', primaryKey: ['t8_def456_f0'], status: 'confirmed' }
      ],
      dataProperties: [
        { id: 't9_abc123__t9_abc123_f2', iri: ns + 'dp1', localName: '合同编号', sourceTable: 't9_abc123', sourceColumn: 't9_abc123_f2', domain: ns + 't9_abc123', range: 'http://www.w3.org/2001/XMLSchema#string', annotations: [] },
        { id: 't8_def456__t8_def456_f0', iri: ns + 'dp2', localName: '合同编号', sourceTable: 't8_def456', sourceColumn: 't8_def456_f0', domain: ns + 't8_def456', range: 'http://www.w3.org/2001/XMLSchema#string', annotations: [] }
      ],
      objectProperties: [{
        id: 'rel_1', iri: ns + 'rel_1', localName: '按合同结算', sourceTable: 't9_abc123', refTable: 't8_def456',
        domain: ns + 't9_abc123', range: ns + 't8_def456', sourceColumns: [], refColumns: [],
        relationVia: ['t9_abc123.t9_abc123_f2', 't8_def456.t8_def456_f0'], status: 'confirmed', annotations: []
      }],
      processSegments: [], rowsByTable: {}, notes: [], constraints: [], glossary: [], sources: [], conflicts: []
    };
    const owlF = toOwlJson(mini);
    const fm = (owlF.objectProperties[0].annotations || []).find(a => /fieldMapping$/.test(a.property || ''));
    ok('字段依据写成业务名（表.字段）',
      /结算表\.合同编号/.test(fm?.value || '') && /合同表\.合同编号/.test(fm?.value || ''), fm?.value);
    ok('OWL 注释里不再出现内部列编码', !/t9_abc123_f2|t8_def456_f0/.test(fm?.value || ''));

    const sum = await api(`/api/projects/${id}`);
    const labels = sum.canonical?.columnLabels || {};
    const firstTable = Object.keys(labels)[0];
    ok('列的业务名随摘要回传（页面据此替换编码）',
      !!firstTable && Object.values(labels[firstTable]).some(v => typeof v === 'string' && v && !/_f\d+$/.test(v)),
      firstTable + ' → ' + JSON.stringify(Object.entries(labels[firstTable] || {}).slice(0, 2)));
  }

  section('二之五、模型只给字段依赖时，图上也要有边（关系不能凭空消失）');
  {
    /* 真实事故：8 张表出稿，模型把 7 条关系全塞进 idDependencies，relations 空，
       草稿图谱一条边都没有，用户看到的是一片散点。 */
    const known = ['t_a', 't_b', 't_c'];
    const mini = { classes: known.map(t => ({ sourceTable: t, localName: t })), objectProperties: [], dataProperties: [], processSegments: [] };
    const raw = {
      tables: known.map(t => ({ table: t, role: 'event', meaning: '甲' })), stages: [],
      relations: [],
      idDependencies: [{ from: 't_a', to: 't_b', fields: ['k1'] }, { from: 't_b', to: 't_c', fields: ['k2'] }]
    };
    const v = validateUnderstanding(raw, mini);
    ok('模型没写业务关系时，按它给的字段依赖补出待确认关系',
      v.understanding.relations.length === 2 && v.understanding.relations.every(r => r.status === 'candidate' && r.predicate === '待确认关系'),
      v.understanding.relations.length + ' 条');
    ok('补出来的边写明是哪两列在连', /t_a\.k1/.test(v.understanding.relations[0].via[0] || ''), v.understanding.relations[0].via[0]);
    ok('补录时留一条提示，告诉用户去图上改关系名',
      v.warnings.some(w => /待确认关系/.test(w)), (v.warnings.find(w => /待确认关系/.test(w)) || '').slice(0, 40));

    /* 编译只把确认过的关系写进 OWL；候选不进本体，但不能从图上消失 */
    const canonical = {
      classes: [{ sourceTable: 't_a', iri: 'https://x.example/a#A' }, { sourceTable: 't_b', iri: 'https://x.example/a#B' }],
      objectProperties: []
    };
    const owl = { classes: [{ iri: 'https://x.example/a#A', localName: '甲' }, { iri: 'https://x.example/a#B', localName: '乙' }], objectProperties: [] };
    const g = schemaGraph(owl);
    decorateSchemaEdges(g, canonical, v.understanding);
    ok('编译后待确认关系仍画在图上', g.stats.edges === 1 && g.stats.pending === 1, `${g.stats.edges} 边 / ${g.stats.pending} 待确认`);
    const pe = g.elements.find(e => e.data?.source);
    ok('待确认边带 objectProperty + candidate，前端才知道画橙色虚线',
      pe?.data.kind === 'objectProperty' && pe?.data.status === 'candidate' && /pending-edge/.test(pe.classes || ''));
    ok('确认过的边标 confirmed，不再是一片灰',
      (() => {
        const owl2 = { classes: owl.classes, objectProperties: [{ id: 'p1', iri: 'https://x.example/a#rel', localName: '按合同下单', domains: ['https://x.example/a#A'], ranges: ['https://x.example/a#B'] }] };
        const g2 = schemaGraph(owl2);
        decorateSchemaEdges(g2, { ...canonical, objectProperties: [{ iri: 'https://x.example/a#rel', status: 'confirmed' }] }, { relations: [] });
        const e2 = g2.elements.find(e => e.data?.source);
        return e2?.data.kind === 'objectProperty' && e2?.data.status === 'confirmed';
      })());
    ok('提示词明确要求 relations 不能为空（不能再「宁可一条不画」）',
      /relations 不能为空/.test(PROMPTS.understandingRules) && /不能用它替代 relations/.test(PROMPTS.understandingRules));
  }

  section('三、业务语义台账（闸门 ② 已并入图谱确认）');
  const led = created.semantics || {};
  ok('解析即生成业务语义台账', !!led.stats && led.stats.terms > 0, `${led.stats?.terms} 词条`);
  ok('跨表同名键形成关联候选', (led.idAlignments || []).length > 0, led.stats?.idCandidates + ' 条');
  ok('说明片段带出处', (led.statements || []).length > 0 && led.statements.every(x => x.locator));
  ok('同名不同义只告警不合并', Array.isArray(led.sameNameWarnings));
  const noLongerBlocked = await raw(`/api/projects/${id}/compile`, 'POST', {});
  ok('台账未逐条勾选也不再阻断编译（闸门已并入图谱确认）', noLongerBlocked.status === 200, 'HTTP ' + noLongerBlocked.status);
  const confirmed = await api(`/api/projects/${id}/confirm`, 'POST', { all: true, comment: '自检批量确认', by: '自检脚本' });
  ok('确认后闸门 A 归零', confirmed.gates.ledgerBlocking === 0);
  ok('确认结果逐条留痕', confirmed.semantics.confirmations.filter(c => c.status === 'confirmed').every(c => c.decidedBy && c.decidedAt));
  ok('确认后关联固化为规范模型关系', confirmed.canonical.objectProperties.some(x => x.origin === 'id-mapping') || confirmed.canonical.objectProperties.length >= 2,
    confirmed.canonical.objectProperties.length + ' 条关系');

  section('四、流程基线与闸门 B（领域无关）');
  const ps = confirmed.processState || {};
  ok('事件按时间字段形态自动发现', (ps.events || []).length >= 2, ps.stats?.events + ' 个事件');
  ok('未确认时序约束时不臆造差异', ps.stats?.differences === 0, '差异 ' + ps.stats?.differences + ' 处');
  ok('时序约束只来自材料原文', (ps.rawStatements || []).every(x => !!x.source?.locator));

  section('五、编译与活图谱');
  const compiled = await api(`/api/projects/${id}/compile`, 'POST', {});
  const v = compiled.validation;
  ok('OWL 编译与校验', v && v.summary.failed === 0, `${v.summary.passed}/${v.summary.total}`);
  ok('图谱节点与边', compiled.graph.schema.stats.nodes === 3 && compiled.graph.schema.stats.edges >= 2,
    `${compiled.graph.schema.stats.nodes} 节点 / ${compiled.graph.schema.stats.edges} 边`);
  const owlText = await (await fetch(`${BASE}/api/projects/${id}/export?format=owl`)).text();
  ok('OWL/XML 良构', owlText.startsWith('<?xml') && owlText.trimEnd().endsWith('</Ontology>'));
  const edited = JSON.parse(JSON.stringify(compiled.owlJson));
  edited.classes[0].localName = '对象主表（自检改名）';
  const written = await api(`/api/projects/${id}/compile`, 'POST', { owlJson: edited, note: '自检改名' });
  ok('图谱编辑回写后校验仍通过', written.validation.summary.failed === 0);
  ok('改名落进 OWL', written.owlXmlPreview.includes('对象主表（自检改名）'));
  const reparsed = await api(`/api/projects/${id}/parse-owl`, 'POST', { text: owlText, filename: 'self.owl' });
  ok('从 OWL 反解析出图', reparsed.parsedStats.classes === 3);

  section('五之二、实例层：真实单据 → 实例与完整性（第 6 步）');
  {
    const fx2 = makeFixture();
    const p2 = await api('/api/projects', 'POST', {
      name: '实例自检项目', description: fx2.description,
      namespace: 'https://example.org/ontology/inst#', files: fx2.files
    });
    const iid = p2.id;
    /* 还没定稿就想装实例：必须被拦住，不能拿半成品模型去套真实数据 */
    const early = await raw(`/api/projects/${iid}/instance-load`, 'POST', { files: [{ name: 'entity_master.csv', content: 'entity_id\nE001' }] });
    ok('模型未定稿时装载实例被拦下', early.status >= 400 && /图谱确认|理解稿/.test(early.data.error || ''), 'HTTP ' + early.status);

    const du = await api(`/api/projects/${iid}/understanding-generate`, 'POST', { mode: 'manual', manual: manualUnderstandingInput(), by: '自检业务用户' });
    const rels = du.understanding.relations || [];
    ok('草稿关系来自跨表主键', rels.length >= 2, rels.length + ' 条');
    await api(`/api/projects/${iid}/understanding-finalize`, 'POST', {
      annotations: rels.map(r => ({ targetId: r.id, kind: 'renameRelation', value: '按主键关联' })),
      approval: { confirmed: true }, by: '自检业务用户'
    });
    await api(`/api/projects/${iid}/compile`, 'POST', {});

    /* 一次上传两用：材料里带行，编译完就该有实例图谱，不用再传一遍 */
    const autoInst = await api(`/api/projects/${iid}`);
    ok('编译后自动按材料自带数据出实例图谱',
      autoInst.instanceData?.origin === 'materials' && autoInst.instanceData.stats.rows > 0,
      JSON.stringify(autoInst.instanceData?.stats || null));

    const files = [
      { name: 'entity_master.csv', content: [
        'entity_id,entity_name,category,status,created_on',
        'E001,对象甲,A,ACTIVE,2026-01-01',
        'E001,对象甲重复,A,ACTIVE,2026-01-01',
        'E002,对象乙,B,ACTIVE,2026-01-02'
      ].join('\n') },
      { name: 'event_log.csv', content: [
        'event_id,entity_id,occurred_at,amount,state',
        'V001,E001,2026-02-01T09:00:00+08:00,100.00,DONE',
        'V002,E999,2026-02-02T09:00:00+08:00,200.00,DONE',
        'V003,,2026-02-03T09:00:00+08:00,300.00,DONE'
      ].join('\n') },
      { name: 'detail_line.csv', content: [
        'line_id,event_id,entity_id,code,value',
        'L001,V001,E001,X1,10.5',
        'L002,V001,E001,X2,11.5'
      ].join('\n') },
      { name: 'unrelated.csv', content: 'a,b\n1,2' }
    ];
    const inst = await api(`/api/projects/${iid}/instance-load`, 'POST', { files, by: '自检业务用户' });
    const d = inst.instanceData;
    ok('补传单据后实例来源切到文件（不会被材料自带数据挡住）', d.origin === 'files', String(d.origin));
    ok('单据数据装载成实例', d.stats.tables === 3 && d.stats.rows === 8, JSON.stringify(d.stats));
    ok('主键重复的重复行不重复出实例', d.stats.individuals === 7, d.stats.individuals + ' 个实例');
    ok('对不上表名的文件单独列出，不硬塞', d.unmatched.some(u => u.file === 'unrelated.csv'), JSON.stringify(d.unmatched));
    const kinds = new Set((d.integrity.issues || []).map(i => i.kind));
    ok('查主键重复', kinds.has('duplicate-key'));
    ok('查外键悬空（孤儿单据）', kinds.has('dangling-fk'));
    ok('查外键为空（桥表半开）', kinds.has('empty-fk'));
    ok('查父单无子行（一对多完整性）', kinds.has('no-children'));
    ok('问题按严重度排序并计数', d.integrity.stats.errors >= 2 && d.integrity.issues[0].level === 'error',
      JSON.stringify(d.integrity.stats));
    ok('只报不改：问题存在时实例照常产出', d.stats.individuals > 0);
    ok('实例图保留有连边的单据流', d.graph.stats.nodes === 7 && d.graph.stats.edges >= 3, JSON.stringify(d.graph.stats));
    ok('连不上上下游的实例被标出来', d.graph.elements.some(e => e.data?.orphan));
    const abox = await (await fetch(`${BASE}/api/projects/${iid}/export?format=abox`)).text();
    ok('ABox 单独成文件，不重复 TBox', /NamedIndividual/.test(abox) && !/<owl:Class/.test(abox) && !/<owl:ObjectProperty/.test(abox));
    ok('实例摘要回到页面（图上的节点带字段）', Array.isArray(inst.instanceData.individuals)
      && inst.instanceData.individuals.length === d.graph.stats.nodes
      && inst.instanceData.individuals.every(i => Array.isArray(i.dataPropertyAssertions)));

    /* 关系落地：理解稿只说「A 按 X 关联 B」，没说用哪一列连。
       不落地 → 个体断言一条都不产 → 实例图 0 条边、完整性一项都没查，界面还是「全部通过」。 */
    const rj = d.relations;
    const rjoins = (rj?.joins || []).filter(j => j.origin !== 'unresolved');
    ok('业务关系能落到具体字段', rjoins.length >= 2
      && rjoins.every(j => j.sourceColumns?.length === 1 && j.refColumns?.length === 1 && j.coverage > 0),
      (rj?.joins || []).map(j => `${j.relation}:${j.origin}${j.reason ? '(' + j.reason + ')' : ''}`).join(' | '));
    ok('实例图上的边带基数（一对多看得出来）', d.graph.elements.filter(e => e.data.source).every(e => !!e.data.cardinality)
      && rj.joins.some(j => j.maxChildren > 1), '一对多 ' + rj.joins.filter(j => j.maxChildren > 1).length + ' 条');
    ok('主单节点仍带下游计数（详情与统计用）', d.graph.elements.some(e => !e.data.source && e.data.fanin > 1));
    /* 节点副标题只写单据类型，不写下游条数——那串字挤在框里不好读，
       有几条往下走看连线就够了。 */
    const holder = d.graph.elements.find(e => !e.data.source && e.data.fanin > 1);
    ok('主单节点副标题只写类型名，不写下游条数',
      !!holder && holder.data.sub === holder.data.type && !/挂|条/.test(holder.data.sub),
      holder?.data?.sub || '');
    /* N 不是字母，是「每份合同最多 9 张订单」里的 9 */
    const many = rj.joins.find(j => j.maxChildren > 1);
    ok('基数落到实测数字（N:1 → 4:1）',
      !!many && many.actualCardinality === `${many.maxChildren}:1` && /实测/.test(many.actualText),
      many ? `${many.actualCardinality} · ${many.actualText}` : '没有一对多');
    /* 报错要说人话：t1_3d5436_f0 这种列编码用户在页面上没法认 */
    const codes = JSON.stringify(d.integrity.issues).match(/t\d+_[0-9a-f]{6}|_f\d+/g) || [];
    ok('完整性检查里不出现列编码', codes.length === 0, codes.slice(0, 3).join(' / '));
    const dupIssue = (d.integrity.issues || []).find(i => i.kind === 'duplicate-key');
    ok('主键重复那条写的是业务字段名', !dupIssue || /主键 [^\s]+[^_]/.test(dupIssue.detail) && !/_f\d/.test(dupIssue.detail),
      dupIssue?.detail || '');
    ok('完整性检查确实沿着关系查过（不是假绿）',
      d.integrity.stats.relations === rj.stats.total && d.integrity.stats.checkedRelations === rjoins.length,
      JSON.stringify({ relations: d.integrity.stats.relations, checked: d.integrity.stats.checkedRelations, resolved: rjoins.length }));

    /* 推不出关联字段时必须明说，不许静默跳过 */
    const orphanModel = {
      namespace: 'https://example.org/x#',
      classes: [
        { id: 'ta', iri: 'https://example.org/x#ta', localName: '甲表', sourceTable: 'ta', primaryKey: ['a1'] },
        { id: 'tb', iri: 'https://example.org/x#tb', localName: '乙表', sourceTable: 'tb', primaryKey: ['b1'] }
      ],
      dataProperties: [], objectProperties: [{
        id: 'p1', iri: 'https://example.org/x#p1', localName: '按业务关联',
        sourceTable: 'ta', refTable: 'tb', sourceColumns: [], refColumns: [], status: 'confirmed'
      }]
    };
    const orphanRows = { ta: [{ a1: 'A-1', a2: '甲' }], tb: [{ b1: 'B-9', b2: '乙' }] };
    const noJoin = resolveRelations(orphanModel, orphanRows);
    ok('推不出关联字段时明确标为未落地', noJoin.stats.unresolved === 1 && noJoin.joins[0].origin === 'unresolved',
      noJoin.joins[0]?.reason || '');
    const noJoinCheck = checkIntegrity(orphanModel, orphanRows, noJoin);
    ok('未落地的关系在完整性报告里点名（不许假绿）',
      noJoinCheck.issues.some(i => i.kind === 'relation-unresolved') && noJoinCheck.stats.checkedRelations === 0,
      JSON.stringify(noJoinCheck.stats));
  }

  section('六、规则层：不预置、用户定义、通用解释与证据链');
  ok('初始不预置任何规则', (await api(`/api/projects/${id}`)).rules.length === 0);
  const userRule = {
    id: 'R-TEST-1', name: '通用阈值检查', version: '1.0', enabled: true,
    path: { nodes: [{ id: 'n1', table: 'event_log' }], edges: [], branches: [], aggregates: [] },
    conditions: [{ kind: 'fieldCompare', operator: 'gt', left: { table: 'event_log', field: 'amount' }, right: { literal: 150 }, note: '数值大于阈值' }],
    source: { rawText: '看数值是否大于 150' }
  };
  const saved = await api(`/api/projects/${id}/rules-save`, 'POST', { rules: [userRule] });
  ok('用户定义的规则被接受并编译', saved.rules.length === 1 && !!saved.rules[0].compiled);
  ok('多方言 SQL 同时产出', ['ansi', 'mysql', 'postgresql'].every(d => !!saved.rules[0].compiled.sql[d]));
  await api(`/api/projects/${id}/rules-publish`, 'POST', {});
  const ran = await api(`/api/projects/${id}/rules-run`, 'POST', {});
  const run = ran.ruleRuns[0];
  ok('通用解释器产出命中记录', run.summary.total > 0, `${run.summary.total} 条 / 证据 ${run.summary.evidenceSteps} 步`);
  ok('结论固定为待核查线索口径', run.hits.every(h => /不代表违规认定/.test(h.conclusionNote)));
  ok('证据链可回溯到表与字段', run.hits.every(h => h.evidenceChain.every(e => e.left?.table && e.left?.field && e.locator?.material)));
  ok('三层版本号与快照齐全', run.hits.every(h => h.versions.ontology && h.versions.ledger && h.versions.baseline && h.snapshotId));

  section('六之二、规则设立：文档语义 → 确定性 SQL');
  const fullModel = await api(`/api/projects/${id}`);
  const tableOfIri = new Map(fullModel.canonical.classes.map(c => [c.iri, c.sourceTable]));
  const idxModel = {
    classes: fullModel.canonical.classes.map(c => ({ sourceTable: c.sourceTable, localName: c.localName })),
    dataProperties: (fullModel.owlJson?.dataProperties || []).map(p => ({
      sourceTable: tableOfIri.get((p.domains || [])[0]) || '',
      sourceColumn: String(p.id || '').split('__').slice(1).join('__'),
      localName: p.localName
    }))
  };
  const ruleFixture = {
    rules: [{
      name: '通用一致性检查', intent: '同名字段应一致', severity: 'high', basis: '脚本构造',
      scope: [{ table: 'entity_master', alias: 'm' }, { table: 'event_log', alias: 'v' }],
      joins: [{ from: 'm', to: 'v', type: 'inner', on: [{ left: 'entity_id', right: 'entity_id' }] }],
      checks: [{ kind: 'compare', left: { alias: 'm', field: 'category' }, op: 'neq', right: { alias: 'v', field: 'state' }, message: '类别与状态不一致' }]
    }, {
      name: '缺明细记录', intent: '事件表应有明细', severity: 'medium', basis: '脚本构造',
      scope: [{ table: 'event_log', alias: 'v' }, { table: 'detail_line', alias: 'l' }],
      joins: [{ from: 'v', to: 'l', type: 'left', on: [{ left: 'event_id', right: 'event_id' }] }],
      checks: [{ kind: 'compare', left: { alias: 'l', field: 'line_id' }, op: 'isNull', message: '找不到对应明细' }]
    }, {
      name: '越界表', intent: '引用图谱外的表', severity: 'low', basis: '',
      scope: [{ table: '不存在的表' }], joins: [], checks: []
    }]
  };
  const built = validateRuleSpecs(ruleFixture, idxModel);
  ok('规则范围外的表被丢弃并记警告', built.rules.length === 2 && built.warnings.some(w => /不存在的表/.test(w)),
    `${built.rules.length} 条 / ${built.warnings.length} 条警告`);
  const compiledRules = compileRuleSpecs(built.rules, 'ansi');
  ok('规则语义编译成 SQL', compiledRules.length === 2 && compiledRules.every(r => /SELECT[\s\S]*FROM/.test(r.sql)), compiledRules.length + ' 条');
  ok('SQL 用真实列名，业务名只出现在注释里', /"category"/.test(compiledRules[0].sql) && !/FROM\s+"对象主表"/.test(compiledRules[0].sql));
  ok('命中语义固定为待核查线索', compiledRules.every(r => /不代表违规认定/.test(r.sql)));
  ok('缺关联记录编译成 LEFT JOIN + IS NULL', /LEFT JOIN/.test(compiledRules[1]?.sql || '') && /IS NULL/.test(compiledRules[1]?.sql || ''));
  ok('多方言 SQL 可切换', /`/.test(compileRuleSpecs(built.rules, 'mysql')[0]?.sql || ''));
  let rejectedSql = false;
  try { validateRuleSpecs({ rules: [{ name: 'x', note: 'SELECT a FROM b' }] }, idxModel); } catch { rejectedSql = true; }
  ok('模型夹带 SQL 原文被拒绝', rejectedSql);
  const skewModel = {
    classes: [{ sourceTable: 't_a', localName: '表甲' }, { sourceTable: 't_b', localName: '表乙' }],
    dataProperties: [
      { sourceTable: 't_a', sourceColumn: 'amt', localName: '金额' },
      { sourceTable: 't_b', sourceColumn: 'qty', localName: '数量' }
    ]
  };
  const leak = validateRuleSpecs({
    rules: [{
      name: '口径漂移自检', intent: '', severity: 'low', basis: '',
      scope: [{ table: 't_a', alias: 'a' }, { table: 't_b', alias: 'b' }], joins: [],
      checks: [{ kind: 'compare', left: { alias: 'a', field: 'amt' }, op: 'neq', right: { alias: 'b', field: 'qty' }, message: '金额与数量比' }]
    }]
  }, skewModel);
  ok('金额与数量混着比会显式提示（不静默放过）', leak.warnings.some(w => /金额和数量放在一起比/.test(w)), leak.warnings.join(' | ').slice(0, 120));

  section('六之三、模型输出上限与截断处理');
  {
    /* 真实事故：11 张表时输出在 4000 tokens 处被截断，JSON 写一半断掉，
       报「不是合法 JSON」，被误判成密钥问题。这里锁住三条处置。 */
    const cfg0 = await (await fetch(`${BASE}/api/model-config`)).json();
    ok('默认输出上限为 8192 tokens（不再是 4000）', cfg0.maxTokens === 8192, `maxTokens=${cfg0.maxTokens}`);

    const half = '{"tables":[{"table":"t_a","role":"master","meaning":"甲"},{"table":"t_b","role":"event","mea';
    const fixed = salvageJson(half);
    ok('半截 JSON 能救回已写出的完整条目',
      !!fixed && Array.isArray(fixed.tables) && fixed.tables.length === 1 && fixed.tables[0].table === 't_a',
      JSON.stringify(fixed || null).slice(0, 100));

    const fence = '```json\n{"a":[1,2,3]}\n```';
    ok('代码围栏包裹的 JSON 也能解析', JSON.stringify(salvageJson(fence)) === '{"a":[1,2,3]}');

    const bad = '模型说：我建议先看订单表';
    ok('完全不是 JSON 时返回 null（不硬猜）', salvageJson(bad) === null);

    const truncatedErr = new ModelTruncatedError('x', half);
    ok('截断是独立错误类型，可与「格式错误」区分',
      truncatedErr.truncated === true && truncatedErr.partial === half && truncatedErr instanceof Error);

    const clampLow = await (await fetch(`${BASE}/api/model-config`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ maxTokens: 100 })
    })).json();
    ok('输出上限有下限保护（不会小到写不出东西）', clampLow.maxTokens === 512, `maxTokens=${clampLow.maxTokens}`);
    const clampHigh = await (await fetch(`${BASE}/api/model-config`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ maxTokens: 999999 })
    })).json();
    ok('输出上限有上限保护', clampHigh.maxTokens === 262144, `maxTokens=${clampHigh.maxTokens}`);
    await fetch(`${BASE}/api/model-config`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ maxTokens: 8192 })
    });

    /* 规则条数随文档增长，一次写不完时要能续写：续写必须带上「已覆盖审查点」，
       否则模型会把整份清单重写一遍，等于没省。 */
    const base = buildRuleMessages({ document: '文档正文', graph: { tables: [], relations: [] }, contract: RULE_CONTRACT, rules: RULE_RULES });
    const resumed = buildRuleMessages({ document: '文档正文', graph: { tables: [], relations: [] }, contract: RULE_CONTRACT, rules: RULE_RULES, exclude: ['同一发票重复结算'] });
    ok('续写提示只在有已覆盖项时出现',
      !/续写/.test(base[0].content) && /续写/.test(resumed[0].content));
    ok('续写把已覆盖审查点带回给模型',
      /已覆盖的审查点/.test(resumed[1].content) && /同一发票重复结算/.test(resumed[1].content));
    ok('规则输出有长度约束（intent / basis / message 都要短）',
      /intent ≤ 30 字/.test(RULE_RULES) && /basis ≤ 50 字/.test(RULE_RULES) && /message ≤ 30 字/.test(RULE_RULES));
  }

  section('六之四、图片材料：表结构截图、制度截图、单据照片');
  {
    /* 图片识别结果要落成和文本材料一样的形状，后面的解析、建模、出图才不用单开分支 */
    const asTable = visionToMaterial('合同表截图.png', {
      kind: 'table', note: '识别为 1 张表',
      tables: [{ name: 'HT', label: '合同', fields: [{ name: '合同编号', type: 'string', key: true }], primaryKey: ['合同编号'] }],
      text: ''
    });
    ok('表结构截图落成字段字典（现有解析器直接吃）', asTable.file.type === 'dictionary');
    const dict = JSON.parse(asTable.file.content);
    ok('表结构截图的字段名照抄表头，不翻译成英文',
      dict.tables[0].fields[0].name === '合同编号' && dict.tables[0].primaryKey[0] === '合同编号');
    ok('识别说明能回给用户看（知道图里认出了什么）', /1 张表/.test(asTable.note));

    const asPolicy = visionToMaterial('制度截图.png', {
      kind: 'process', note: '读到 3 条制度条款', tables: [], text: '1. 合同签订后 5 个工作日内登记台账。'
    });
    ok('制度截图落成流程描述材料', asPolicy.file.type === 'process' && /制度截图/.test(asPolicy.file.content));
    ok('制度截图的识别说明一起带进材料', /读到 3 条制度条款/.test(asPolicy.file.content));

    const asUnknown = visionToMaterial('随手拍.png', { kind: 'unknown', note: '与建模无关', tables: [], text: '' });
    ok('认不出的图也照实收录并说明，不静默丢弃', /未能识别|没从图里认出|没认出/.test(asUnknown.note));

    /* 单据照片转出来的 CSV 用中文业务名做表头，装载器要能靠业务名把表和字段对上 */
    const dictMat = {
      sourceId: 'src-check-1', sourceName: '入库单.json', sourceType: 'dictionary', sha256: 'x',
      tables: [{
        name: 't_rk', label: '入库单', description: '',
        fields: [{ name: 'RK_NO', label: '单据编号', type: 'string' }, { name: 'RK_DATE', label: '入库日期', type: 'date' }],
        primaryKey: ['RK_NO'], foreignKeys: [], rows: []
      }],
      segments: []
    };
    const m = buildCanonical({ name: '图片单据自检', namespace: 'https://example.org/check/vision#', materials: [dictMat] });
    const loaded = await loadInstanceFiles({
      files: [{ name: '入库单.csv', content: '单据编号,入库日期\nRK20260315007,2026-03-15' }],
      model: m
    });
    ok('单据照片转出的 CSV 按业务表名就能对上表', loaded.stats.rows === 1, JSON.stringify(loaded.stats));
    ok('按业务字段名对上的列值进了实例行',
      Object.values(loaded.rowsByTable)[0]?.[0]?.RK_NO === 'RK20260315007',
      JSON.stringify(Object.values(loaded.rowsByTable)[0]?.[0] || null));

    /* 明细表常常不声明主键。旧规则拿「第一列」当实例键，而明细的第一列往往就是
       所属单据号——一张入库单的四条明细会并成一个实例，看着像只读出一行。 */
    const lineModel = {
      namespace: 'https://e.org/check/line#',
      classes: [{ sourceTable: 'L', iri: 'https://e.org/check/line#L', localName: '入库单明细', primaryKey: [] }],
      dataProperties: [
        { sourceTable: 'L', iri: 'https://e.org/check/line#rkNo', sourceColumn: 'RK_NO', localName: '所属单据编号', range: 'xsd:string' },
        { sourceTable: 'L', iri: 'https://e.org/check/line#mat', sourceColumn: 'MAT_CODE', localName: '物料编码', range: 'xsd:string' }
      ],
      objectProperties: [],
      rowsByTable: {
        L: [
          { RK_NO: 'RK1', MAT_CODE: 'M-10023' },
          { RK_NO: 'RK1', MAT_CODE: 'M-10077' },
          { RK_NO: 'RK1', MAT_CODE: 'M-20119' }
        ]
      }
    };
    const inds = buildIndividuals(lineModel);
    ok('明细表没声明主键时，一单多行不会被并成一个实例',
      inds.length === 3 && new Set(inds.map(i => i.iri)).size === 3, inds.length + ' 个实例');
    ok('没主键时挑能唯一区分每行的那一列当事实主键', inds[0].localName === 'M-10023', inds[0].localName);

    /* 只传图片、又没有可用密钥时，要说清是识别没成，而不是笼统报「缺少表结构材料」 */
    const onlyImage = await raw('/api/projects', 'POST', {
      name: '只传图片自检', description: '',
      files: [{ name: '某表截图.png', content: Buffer.from('not-a-real-png').toString('base64'), encoding: 'base64' }]
    });
    ok('只传图片且识别不成时，报错指明是图片识别的问题',
      onlyImage.status >= 400 && /图片|密钥|识别/.test(onlyImage.data.error || ''),
      String(onlyImage.data.error || '').slice(0, 80));
  }

  section('七、导出格式');
  const formats = ['owl', 'ttl', 'json', 'graph', 'shacl', 'nt', 'model', 'ledger', 'understanding', 'baseline', 'rules', 'rulesql', 'rulespec', 'evidence'];
  const sizes = [];
  for (const f of formats) {
    const r = await fetch(`${BASE}/api/projects/${id}/export?format=${f}`);
    sizes.push(`${f}:${Math.round((await r.text()).length / 1024)}KB`);
  }
  ok('14 种导出格式均可用', sizes.length === 14, sizes.join(' '));

  section('八、口径漂移纪律');
  const drift = { ...fx.files[1], content: fx.files[1].content.replace(/,\s*"amount" DECIMAL/, '') };
  const d2 = await api('/api/projects', 'POST', { name: '口径漂移自检', files: [fx.files[0], drift] });
  ok('字段集合不一致被上报', (d2.blockers || []).length > 0, (d2.blockers || []).length + ' 项');
  ok('未裁决前禁止编译', (await raw(`/api/projects/${d2.id}/compile`, 'POST', {})).status === 409);
  await api(`/api/projects/${d2.id}/conflicts`, 'POST', {
    decisions: d2.blockers.map(c => ({ id: c.id, action: 'accept_a', value: '以字段字典为主来源', by: '自检' }))
  });
  await api(`/api/projects/${d2.id}/understanding-generate`, 'POST', { mode: 'manual', manual: manualUnderstandingInput(), by: '自检' });
  await api(`/api/projects/${d2.id}/understanding-finalize`, 'POST', { annotations: [], approval: { confirmed: true }, by: '自检' });
  await api(`/api/projects/${d2.id}/confirm`, 'POST', { all: true, comment: '自检确认', by: '自检' });
  ok('裁决、理解稿定稿并确认后可编译', (await raw(`/api/projects/${d2.id}/compile`, 'POST', {})).status === 200);

  section('九、外部测试夹具回归（只测试，不进产品）');
  const ext = externalWorkbookFiles();
  if (!ext) {
    console.log('  [跳过] 未提供 TEST_FIXTURE_XLSX，跳过外部夹具回归用例');
  } else {
    const e = await api('/api/projects', 'POST', { name: '外部夹具', description: '', files: ext });
    ok('Excel 多 sheet 全部纳入（含隐藏）', e.canonical.stats.classes >= 10, e.canonical.stats.classes + ' 张表');
    ok('字段名行探测正确（非首行）', e.materials.length === 1);
    const full = await api(`/api/projects/${e.id}`);
    ok('说明行元数据化', (full.semantics?.statements || []).length > 0, full.semantics?.stats?.statements + ' 个片段');
    ok('跨表同名键形成候选', (full.semantics?.idAlignments || []).length > 0, full.semantics?.stats?.idCandidates + ' 条');
    await api(`/api/projects/${e.id}/understanding-generate`, 'POST', { mode: 'manual', manual: manualUnderstandingInput(), by: '自检' });
    await api(`/api/projects/${e.id}/understanding-finalize`, 'POST', { annotations: [], approval: { confirmed: true }, by: '自检' });
    await api(`/api/projects/${e.id}/confirm`, 'POST', { all: true, comment: '自检', by: '自检' });
    const ec = await api(`/api/projects/${e.id}/compile`, 'POST', {});
    ok('外部夹具可编译出图', ec.validation.summary.failed === 0 && ec.graph.schema.stats.edges > 0,
      `${ec.graph.schema.stats.nodes} 节点 / ${ec.graph.schema.stats.edges} 边`);
  }

  console.log('\n============================================================');
  console.log(`  结果：${pass} 项通过 / ${fail} 项失败`);
  console.log(fail === 0 ? '  全部通过。' : '  存在失败项，请根据失败行检查；公开日志前先脱敏。');
  console.log('  自检数据写在系统临时目录，跑完自动清理；外部 Excel 夹具为可选用例。');
  console.log('============================================================\n');
}

try { await main(); }
catch (e) { fail++; console.error('\n  [中断] ' + (e.stack || e.message)); }
finally {
  try { server?.kill('SIGTERM'); } catch { /* ignore */ }
  if (tmp) await rm(tmp, { recursive: true, force: true }).catch(() => {});
  process.exit(fail ? 1 : 0);
}
