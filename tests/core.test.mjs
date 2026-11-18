import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createProject, getProject, resolveConflicts,
  compileProject, parseOwlInto, exportFile, PROJECT_DIR, ConflictBlock, LedgerBlock,
  confirmLedger, publishProjectRules, runProjectRules, saveProjectRules,
  generateUnderstandingProject, finalizeUnderstandingProject, reopenUnderstandingProject, UnderstandingBlock
} from '../core/studio.mjs';
import { validateProposal, draftProposal } from '../core/ai.mjs';
import { toOwlXml } from '../core/owl.mjs';
import { compileSql, compileRule } from '../core/rules.mjs';
import { makeFixture, externalWorkbookFiles, manualUnderstandingInput } from './fixture.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const created = [];
after(async () => { for (const id of created) await rm(path.join(PROJECT_DIR, id + '.json'), { force: true }); });

/** 主链路：手工建模出稿 → 在图谱确认里给关系命名（命名即确认）→ 一次定稿 → 台账确认 */
async function confirmRelations(id, value = '关联') {
  const u = await generateUnderstandingProject(id, { mode: 'manual', manual: manualUnderstandingInput(), by: '测试' });
  const annotations = (u.understanding.relations || [])
    .map(r => ({ targetId: r.id, kind: 'renameRelation', value }));
  return finalizeUnderstandingProject(id, { annotations, approval: { confirmed: true }, by: '测试' });
}

async function fresh(override = {}, preConfirm = true) {
  const fx = makeFixture();
  const p = await createProject({ name: '通用单元测试', description: fx.description, files: fx.files, ...override });
  created.push(p.id);
  if (preConfirm) {
    await confirmRelations(p.id);
    await confirmLedger(p.id, { all: true, comment: '测试预置确认', by: '测试' });
  }
  return p;
}

test('通用夹具解析：3 表 / 外键 / 样例行 / 流程片段，且不预置规则', async () => {
  const p = await fresh({}, false);
  assert.equal(p.canonical.stats.classes, 3);
  assert.ok(p.canonical.stats.dataProperties >= 12);
  assert.ok(p.canonical.stats.objectProperties >= 2);
  assert.equal(p.canonical.stats.sampleRows, 6);
  assert.ok(p.canonical.stats.processSegments >= 1);
  assert.equal(p.rules.length, 0, '产品不得预置任何规则');
  assert.equal(p.referenceResults.length, 0, '产品不得预置预期结果');
  assert.equal(p.owlJson, null);
});

test('闸门 B 已并入图谱确认：台账勾选只固化跨表关联，不再阻断编译', async () => {
  const p = await fresh({}, false);
  assert.ok(p.semantics.stats.blocking > 0);
  assert.ok(p.semantics.idAlignments.length > 0, '跨表同名键应形成候选');
  // 定稿时不给关系命名：这些边视为未确认，不进本体
  await generateUnderstandingProject(p.id, { mode: 'manual', manual: manualUnderstandingInput(), by: '测试' });
  await finalizeUnderstandingProject(p.id, { annotations: [], approval: { confirmed: true }, by: '测试' });
  const unnamed = await compileProject(p.id, {});
  assert.equal(unnamed.validation.summary.failed, 0, '台账未逐条勾选也不再阻断编译');
  assert.equal(unnamed.owlJson.objectProperties.length, 0, '未命名的「待确认关系」不进本体');
  const pendingEdges = unnamed.graph.schema.elements.filter(e => e.data?.source && e.data?.target);
  assert.ok(pendingEdges.length > 0, '未确认关系仍显示在图谱中供用户审阅');
  assert.ok(pendingEdges.every(e => e.data.pending && e.data.status === 'candidate'), '未确认边必须标成候选');
  assert.equal(unnamed.relationStats.pending > 0, true, '未命名关系保留为候选');
  const c = await confirmLedger(p.id, { all: true, comment: '测试', by: '测试' });
  assert.equal(c.gates.ledgerBlocking, 0);
  assert.ok(c.canonical.objectProperties.some(x => x.origin === 'id-mapping'), '确认的候选应固化成关系');
  assert.ok(c.semantics.confirmations.filter(x => x.status === 'confirmed').every(x => x.decidedBy && x.decidedAt));
  const fp = c.gates.ruleBase.fingerprint;
  assert.equal((await confirmLedger(p.id, { decisions: [] })).gates.ruleBase.fingerprint, fp);
});

test('流程基线：事件按字段形态发现，未确认约束时不臆造差异', async () => {
  const p = await fresh();
  assert.ok(p.processState.events.length >= 2);
  assert.ok(p.processState.events.every(e => !!e.timeField));
  assert.equal(p.processState.stats.differences, 0);
  assert.ok(p.processState.rawStatements.every(x => !!x.source?.locator));
});

test('提案校验：拒绝夹带格式文本、越界表与无法落回表的关系端点', async () => {
  const p = await fresh();
  const model = (await getProject(p.id)).canonical;
  const r1 = validateProposal({ classes: [{ table: 'ghost_table', label: '幽灵' }] }, model);
  assert.equal(r1.proposal.classes.length, 0);
  const r2 = validateProposal({ relations: [{ from: 'ghost_a', to: 'ghost_b' }] }, model);
  assert.equal(r2.proposal.relations.length, 0);
  assert.throws(() => validateProposal({ constraints: [{ text: '<Ontology>非法</Ontology>' }] }, model), /夹带 OWL/);
  const r3 = validateProposal({ relations: [{ from: 'event_log', to: 'entity_master', label: '归属' }] }, model);
  assert.equal(r3.proposal.relations.length, 1);
  const a = draftProposal(model), b = draftProposal(model);
  assert.deepEqual(a.classes, b.classes);
});

test('编译 → 活图谱 → 编辑回写 → 反解析闭环', async () => {
  const p = await fresh();
  const c = await compileProject(p.id, {});
  assert.equal(c.validation.summary.failed, 0);
  assert.equal(c.graph.schema.stats.nodes, 3);
  assert.ok(c.graph.schema.stats.edges >= 2);
  assert.equal(c.graph.instance.stats.nodes, 6);
  const owl = JSON.parse(JSON.stringify(c.owlJson));
  owl.classes[0].localName = '对象主表（改名）';
  const w = await compileProject(p.id, { owlJson: owl, note: '改名' });
  assert.equal(w.validation.summary.failed, 0);
  assert.ok(w.owlXmlPreview.includes('对象主表（改名）'));
  const xml = exportFile(await getProject(p.id), 'owl').body;
  assert.ok(xml.startsWith('<?xml') && xml.trimEnd().endsWith('</Ontology>'));
  const re = await parseOwlInto(p.id, { text: xml, filename: 'roundtrip.owl' });
  assert.equal(re.parsedStats.classes, 3);
  assert.ok(re.owlXmlPreview.includes('对象主表（改名）'));
  assert.equal(toOwlXml((await getProject(p.id)).owlJson).startsWith('<?xml'), true);
});

test('规则层：不预置、用户定义、多方言 SQL、通用解释与证据链', async () => {
  const p = await fresh();
  await assert.rejects(() => runProjectRules(p.id), /规则未发布|不得发布/);
  const rule = {
    id: 'R-UNIT-1', name: '通用阈值检查', version: '1.0', enabled: true,
    path: { nodes: [{ id: 'n1', table: 'event_log' }], edges: [], branches: [], aggregates: [] },
    conditions: [{ kind: 'fieldCompare', operator: 'gt', left: { table: 'event_log', field: 'amount' }, right: { literal: 150 } }],
    source: { rawText: '看数值是否大于 150' }
  };
  const saved = await saveProjectRules(p.id, { rules: [rule] });
  assert.equal(saved.rules.length, 1);
  assert.ok(['ansi', 'mysql', 'postgresql'].every(d => saved.rules[0].compiled.sql[d].includes('WHERE')));
  assert.ok(compileSql(rule, 'mysql').includes('`'));
  assert.doesNotThrow(() => compileRule({ ...rule, path: { nodes: [], edges: [] } }));
  await publishProjectRules(p.id);
  const ran = await runProjectRules(p.id);
  const run = ran.ruleRuns[0];
  assert.ok(run.summary.total > 0);
  assert.ok(run.hits.every(h => /不代表违规认定/.test(h.conclusionNote)));
  assert.ok(run.hits.every(h => h.evidenceChain.every(e => e.left?.table && e.left?.field && e.locator?.material)));
  assert.ok(run.hits.every(h => h.versions.ontology && h.versions.ledger && h.versions.baseline && h.snapshotId));
  assert.equal(run.expectedComparison.total, 0, '未提供测试用例时不比对');
});

test('新增导出格式均为合法 JSON', async () => {
  const p = await fresh();
  await compileProject(p.id, {});
  const full = await getProject(p.id);
  for (const f of ['ledger', 'baseline', 'rules', 'evidence']) {
    const out = exportFile(full, f);
    assert.ok(out.body.length > 0);
    assert.doesNotThrow(() => JSON.parse(out.body));
  }
});

test('口径漂移：字段集合不一致必须上报阻断级冲突并阻止编译', async () => {
  const fx = makeFixture();
  const files = fx.files.map(f => f.name === 'fixture-schema.sql'
    ? { ...f, content: f.content.replace(/,\s*"amount" DECIMAL/, '') } : f);
  const p = await createProject({ name: '字段漂移', files });
  created.push(p.id);
  assert.ok(p.blockers.length > 0);
  await assert.rejects(() => compileProject(p.id, {}), e => e instanceof ConflictBlock && e.code === 409);
  await resolveConflicts(p.id, p.blockers.map(c => ({ id: c.id, action: 'accept_a', value: '以字段字典为主', by: '测试' })));
  await generateUnderstandingProject(p.id, { mode: 'manual', manual: manualUnderstandingInput(), by: '测试' });
  await finalizeUnderstandingProject(p.id, { annotations: [], approval: { confirmed: true }, by: '测试' });
  await confirmLedger(p.id, { all: true, comment: '测试', by: '测试' });
  assert.equal((await compileProject(p.id, {})).validation.summary.failed, 0);
});

test('去样例化：产品代码不出现任何业务表名 / 字段名 / 案例常量', async () => {
  const dir = path.join(ROOT, 'core');
  // 禁用词清单：只用于断言扫描，不是产品内容；拼接构造避免交付包里出现完整业务词
  const forbidden = new RegExp([
    'procurement' + '_contract', 'award' + '_result', 'subject' + '_change_approval',
    'contract' + '_lot_link', 'exception' + '_review', 'signing' + '_supplier_id',
    'awarded' + '_supplier_id', 'signed' + '_at', 'approved' + '_at',
    'C00' + '7', 'C00' + '8', 'HT-' + 'DEMO', '案例结构与' + '样例数据'
  ].join('|'));
  const files = (await readdir(dir)).filter(f => f.endsWith('.mjs'));
  for (const f of files) {
    const text = await readFile(path.join(dir, f), 'utf8');
    assert.equal(forbidden.test(text), false, `${f} 里仍有业务硬编码`);
  }
  const server = await readFile(path.join(ROOT, 'server.mjs'), 'utf8');
  assert.equal(forbidden.test(server), false);
});

test('外部 Excel 夹具回归（仅当 TEST_FIXTURE_XLSX 提供时）', async (t) => {
  const ext = externalWorkbookFiles();
  if (!ext) return t.skip('未提供 TEST_FIXTURE_XLSX，跳过');
  const { readWorkbook } = await import('../core/xlsx.mjs');
  const { tablesFromWorkbook } = await import('../core/table-spec.mjs');
  const wb = readWorkbook(Buffer.from(ext[0].content, 'base64'));
  assert.ok(wb.sheets.length >= 10, '应读出多 sheet');
  assert.ok(wb.sheets.some(s => s.hidden), '隐藏 sheet 不能漏');
  const spec = tablesFromWorkbook(wb, { name: '外部夹具', id: 'src-test' });
  assert.ok(spec.tables.length >= 10);
  assert.ok(spec.diagnostics.hiddenIncluded >= 1);
  assert.ok(spec.statements.some(s => s.kind === '填写说明' || s.kind === '业务规则线索'));
  assert.ok(spec.idCandidates.length > 0, '跨表同名键应形成候选');
  const p = await createProject({ name: '外部夹具', description: '', files: ext });
  created.push(p.id);
  await generateUnderstandingProject(p.id, { mode: 'manual', manual: manualUnderstandingInput(), by: '测试' });
  await finalizeUnderstandingProject(p.id, { annotations: [], approval: { confirmed: true }, by: '测试' });
  await confirmLedger(p.id, { all: true, comment: '测试', by: '测试' });
  const c = await compileProject(p.id, {});
  assert.equal(c.validation.summary.failed, 0);
  assert.ok(c.graph.schema.stats.edges > 0, '确认后图谱应连边');
});

test('B 批 · 理解稿闸门：未定稿不编译，手工建模是一等公民路径', async () => {
  const fx = makeFixture();
  const p = await createProject({ name: '理解稿闸门', description: fx.description, files: fx.files });
  created.push(p.id);
  assert.equal(p.gates.understandingFinalized, false);
  await assert.rejects(() => compileProject(p.id, {}), e => e instanceof UnderstandingBlock && e.code === 409);
  const g = await generateUnderstandingProject(p.id, { mode: 'manual', manual: manualUnderstandingInput(), by: '测试' });
  assert.equal(g.understanding.version, 1);
  assert.equal(g.understanding.origin, 'manual');
  assert.equal(g.understanding.tables.length, 3);
  assert.equal(g.understanding.stages.length, 2);
  assert.ok(g.understanding.tables.every(t => t.meaning));
  // 不做真实模型调用（避免测试依赖外部服务或本机密钥），只校验规约与「绝不生成伪稿」的契约
  const { getModelStatus } = await import('../core/ai.mjs');
  const cfg = await getModelStatus();
  assert.ok(cfg.understandingRules && /不得生成/.test(cfg.understandingRules));
  assert.notEqual(g.understanding.origin, 'draft');
  assert.equal(g.understanding.note.includes('手工填写'), true);
});

test('B 批 · 一次确认 + 局部批注：只产生 v1/v2，批注全部处理并回写业务语义', async () => {
  const fx = makeFixture();
  const p = await createProject({ name: '一次确认', description: fx.description, files: fx.files });
  created.push(p.id);
  await generateUnderstandingProject(p.id, { mode: 'manual', manual: manualUnderstandingInput(), by: '业务用户' });
  const f = await finalizeUnderstandingProject(p.id, {
    annotations: [
      { targetId: 'event_log', kind: 'changeMeaning', value: '业务发生的一次事件（批注修订）', comment: '措辞更准确' },
      { targetId: 'detail_line', kind: 'changeRole', value: 'result', comment: '应属于结果记录' },
      { targetId: '准备', kind: 'addStage', value: '补充阶段' }
    ],
    approval: { confirmed: true }, by: '业务用户'
  });
  assert.equal(f.understandingFinal.version, 2);
  assert.equal(f.understandingHistory.length, 2, '只产生 v1 与定稿版两个版本');
  assert.equal(f.understandingFinal.revisionLog.length, 3);
  assert.ok(f.understandingFinal.diffSummary.every(x => x.handled));
  assert.equal(f.understandingFinal.tables.find(t => t.table === 'event_log').meaning, '业务发生的一次事件（批注修订）');
  assert.equal(f.understandingFinal.tables.find(t => t.table === 'detail_line').role, 'result');
  assert.equal(f.understandingFinal.approval.scope, 'whole');
  const full = await getProject(p.id);
  assert.ok(full.canonical.classes.every(c => c.role && c.businessMeaning));
  assert.equal(full.canonical.businessStages.length, 3);
  await confirmLedger(p.id, { all: true, comment: '测试', by: '测试' });
  const c = await compileProject(p.id, {});
  assert.ok(c.owlXmlPreview.includes('业务发生的一次事件（批注修订）'), '业务含义应落进 OWL 注释');
});

test('B 批 · 重新开启理解稿保留定稿快照，需再次确认', async () => {
  const p = await fresh();
  const r = await reopenUnderstandingProject(p.id, { by: '测试' });
  assert.equal(r.understandingFinal, null);
  assert.ok(r.understanding.version >= 3);
  assert.equal(r.gates.understandingFinalized, false);
  await assert.rejects(() => compileProject(p.id, {}), e => e instanceof UnderstandingBlock);
  await finalizeUnderstandingProject(p.id, { annotations: [], approval: { confirmed: true }, by: '测试' });
  assert.equal((await compileProject(p.id, {})).validation.summary.failed, 0);
});

test('B 批 · 导出理解稿文件', async () => {
  const p = await fresh();
  const out = exportFile(await getProject(p.id), 'understanding');
  const d = JSON.parse(out.body);
  assert.ok(d.draft && d.final && Array.isArray(d.history));
  assert.equal(d.final.version, 2);
});
