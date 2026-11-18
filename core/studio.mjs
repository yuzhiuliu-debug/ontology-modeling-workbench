import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { sha, uid, SAMPLE_DIR } from './store.mjs';
import { ROOT, PROJECT_DIR } from './paths.mjs';
import { prepareSources, parseMaterial, guessType } from './ingest.mjs';
import { buildCanonical, mergeProposal, review, blockers, modelHash } from './canonical.mjs';
import { toOwlJson, toOwlXml, toTurtle } from './owl.mjs';
import { buildReport, toShacl } from './validate.mjs';
import { schemaGraph, instanceGraph, toTriples, draftGraph, decorateSchemaEdges } from './graph.mjs';
import { propose, proposeUnderstanding, proposeRuleSpecs, salvageJson } from './ai.mjs';
import { ROLES, manualUnderstanding, finalizeUnderstanding, applyUnderstandingToProject, structureRelations } from './understanding.mjs';
import { validateRuleSpecs, compileRuleSpecs, graphDigest, ruleSqlBundle } from './rulespec.mjs';
import { buildSemantics, applyConfirmations, confirmedRuleBase, blockingConfirmations } from './semantics.mjs';
import { buildProcessState, applyDifferenceDecisions, pendingDifferences } from './process.mjs';
import { compileRule, runRules, publishRules, RulesBlocked } from './rules.mjs';
import { instantiateProject, instantiateFromMaterials, toAboxXml } from './instance.mjs';
import { isImageName, readImage, visionToMaterial, readDocumentRows } from './vision.mjs';

export { PROJECT_DIR };

// owl-parser.js 同时供浏览器 <script> 与服务端使用；在 ESM 包内用独立上下文按 CJS 语义加载
const parserSandbox = { module: { exports: {} }, exports: {}, console };
vm.runInNewContext(readFileSync(path.join(ROOT, 'public', 'owl-parser.js'), 'utf8'), parserSandbox, { filename: 'owl-parser.js' });
const OwlParser = parserSandbox.OwlParser || parserSandbox.module.exports;
if (typeof OwlParser?.parse !== 'function') throw Error('OWL 解析器加载失败');

const OWL = 'http://www.w3.org/2002/07/owl#';
const RDFS = 'http://www.w3.org/2000/01/rdf-schema#';
const XSD = 'http://www.w3.org/2001/XMLSchema#';
const OMW = 'urn:omw:provenance:';
const NS_DEFAULT = 'https://example.org/ontology/studio#';
const OWL_EXT = /\.(owl|ttl|nt|rdf|rdfxml|xml)$/i;

const projectFile = id => path.join(PROJECT_DIR, id + '.json');
const isId = id => /^prj-[0-9a-f]{8}$/.test(String(id || ''));

function isOwlFile(f) {
  const n = String(f.name || '').toLowerCase();
  const t = String(f.content || '').trim();
  if (/\.json$/i.test(n) && t.startsWith('{') && /"classes"\s*:/.test(t.slice(0, 1200)) && !/"tables"\s*:/.test(t.slice(0, 1200))) return true;
  if (OWL_EXT.test(n) && /<Ontology[\s>]|<rdf:RDF|@prefix|^\{|^\s*<http/i.test(t.slice(0, 400))) return true;
  return /^<Ontology[\s>]|^<rdf:RDF|^@prefix\s+\w+:/i.test(t.slice(0, 400));
}

/** CSV 样例数据：文件名与表名一致时，作为该表的行数据绑定，不新建一个「uploaded」类 */
function csvRows(text, sep) {
  const lines = String(text).replace(/^\uFEFF/, '').split(/\r?\n/).filter(l => l.trim());
  if (!lines.length) return { header: [], rows: [] };
  const split = line => {
    const out = []; let buf = '', quoted = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') { if (quoted && line[i + 1] === '"') { buf += '"'; i++; } else quoted = !quoted; continue; }
      if (ch === sep && !quoted) { out.push(buf.trim()); buf = ''; continue; }
      buf += ch;
    }
    out.push(buf.trim()); return out;
  };
  const header = split(lines[0]);
  const rows = lines.slice(1).map(l => {
    const cells = split(l);
    return Object.fromEntries(header.map((h, i) => [h, cells[i] ?? '']));
  });
  return { header, rows };
}

export async function saveProject(p) {
  await mkdir(PROJECT_DIR, { recursive: true });
  p.updatedAt = new Date().toISOString();
  await writeFile(projectFile(p.id), JSON.stringify(p, null, 2), 'utf8');
  return p;
}
export async function getProject(id) {
  if (!isId(id)) throw Error('项目编号无效');
  try { return JSON.parse(await readFile(projectFile(id), 'utf8')); }
  catch { throw Error('项目不存在或已被清理：' + id); }
}
export async function listProjects() {
  await mkdir(PROJECT_DIR, { recursive: true });
  const files = await readdir(PROJECT_DIR);
  const out = [];
  for (const f of files.filter(x => x.endsWith('.json'))) {
    try {
      const p = JSON.parse(await readFile(path.join(PROJECT_DIR, f), 'utf8'));
      out.push({ id: p.id, name: p.name, createdAt: p.createdAt, updatedAt: p.updatedAt, stage: p.stage,
        materials: (p.materials || []).length, classes: p.canonical?.classes?.length || p.owlJson?.classes?.length || 0,
        relations: p.canonical?.objectProperties?.length || p.owlJson?.objectProperties?.length || 0 });
    } catch { /* skip */ }
  }
  return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

function emptyProject({ name, namespace, description }) {
  const now = new Date().toISOString();
  return {
    id: uid('prj'), name: (name || '未命名本体项目').slice(0, 80),
    namespace: namespace || NS_DEFAULT, description: description || '',
    createdAt: now, updatedAt: now, stage: 0,
    materials: [], owlInputs: [], canonical: null,
    semantics: null, processState: null, rules: [], ruleRuns: [], referenceResults: [],
    ruleSpecs: null,
    instanceData: null,
    understanding: null, understandingFinal: null, understandingHistory: [],
    proposal: null, proposalMode: null, proposalNote: '', proposalWarnings: [],
    owlJson: null, owlXml: '', turtle: '', shacl: '', triples: '',
    graph: null, validation: null, history: []
  };
}

/** 材料统一入口：表结构/样例数据/流程描述 → 规范模型；OWL 文件 → 直接反解析出图 */
export async function createProject({ name, namespace, description, files = [] }) {
  const p = emptyProject({ name, namespace, description });
  const owlInputs = files.filter(isOwlFile);
  const structureFiles = files.filter(f => !isOwlFile(f));
  p.owlInputs = owlInputs.map(f => ({ name: f.name, bytes: Buffer.byteLength(f.content || ''), sha256: sha(f.content || '') }));

  if (structureFiles.length) {
    /* 图片材料先过一遍视觉识别，转成「表结构 JSON」或「流程描述文本」再进正常解析链路：
       这样解析、建模、出图都不用为图片单开一条分支。
       使用用户配置且支持图片输入的模型；识别失败不挡流程，只是记一条提醒。 */
    const images = structureFiles.filter(f => isImageName(f.name));
    const rest = structureFiles.filter(f => !isImageName(f.name));
    const imageNotes = [];
    const roleByName = new Map();
    for (const f of images) {
      try {
        const binary = Buffer.from(String(f.content ?? ''), 'base64');
        const seen = await readImage({ name: f.name, binary });
        const conv = visionToMaterial(f.name, seen);
        const isTable = conv.file.type === 'dictionary';
        rest.push({ ...conv.file, role: isTable ? '表结构（图片识别）' : '业务描述（图片识别）', fromImage: f.name });
        roleByName.set(conv.file.name, isTable ? '表结构（图片识别）' : '业务描述（图片识别）');
        imageNotes.push(`${f.name} → ${conv.note}`);
      } catch (e) {
        imageNotes.push(`${f.name}：识别失败（${e.message}）`);
      }
    }
    const sources = await prepareSources(rest.map(f => ({
      name: f.name, content: String(f.content ?? ''), encoding: f.encoding,
      type: f.type || guessType(f.name)
    })), SAMPLE_DIR);
    const parsedAll = sources.map(s => ({ src: s, parsed: parseMaterial(s) }));
    const tableNames = new Set(parsedAll.flatMap(x => x.parsed.tables.map(t => t.name)));
    const sampleRows = {};
    const schemaSources = [];
    for (const x of parsedAll) {
      const stem = x.src.name.replace(/\.[^.]+$/, '');
      const isData = x.src.type === 'csv' && tableNames.has(stem);
      if (isData) {
        const sep = /\.tsv$/i.test(x.src.name) ? '\t' : ',';
        sampleRows[stem] = (sampleRows[stem] || []).concat(csvRows(x.src.text, sep).rows).slice(0, 50);
      } else schemaSources.push(x);
      p.materials.push({
        id: x.src.id, name: x.src.name, type: x.src.type, sha256: x.src.sha256, bytes: x.src.bytes,
        role: roleByName.get(x.src.name) || (isData ? '样例数据' : (x.src.type === 'process' ? '业务描述' : '表结构')),
        text: x.src.text,
        rows: isData ? sampleRows[stem].length : 0
      });
    }
    const materials = schemaSources.map(x => x.parsed);
    /* 只传了图片又识别失败时，要直接说清是识别没成，而不是甩一句「缺少表结构材料」 */
    if (!schemaSources.length && imageNotes.length) {
      throw Error('图片没能识别出表结构：' + imageNotes.join('；')
        + '。请在模型设置里配置支持图片输入的模型；也可以补一份字段字典 / SQL / Excel。');
    }
    p.canonical = buildCanonical({ name: p.name, namespace: p.namespace, materials });
    for (const [table, rows] of Object.entries(sampleRows)) {
      if (p.canonical.classes.some(c => c.sourceTable === table)) p.canonical.rowsByTable[table] = rows;
    }
    p.canonical.stats.sampleRows = Object.values(p.canonical.rowsByTable).reduce((n, rows) => n + rows.length, 0);
    // 预期结果只来自用户显式上传的测试用例材料，不再从演示数据里取
    p.referenceResults = rest.filter(f => f.type === 'testcases')
      .flatMap(f => { try { const d = JSON.parse(String(f.content)); return Array.isArray(d) ? d : (d.cases || []); } catch { return []; } });
    // V2.1：规则不再预置，初始为空；业务理解稿在 B 批接入，A 批先建结构与台账
    const workbookSpec = {
      idCandidates: parsedAll.flatMap(x => x.parsed.extras?.tableSpec?.idCandidates || []),
      sameNameWarnings: parsedAll.flatMap(x => x.parsed.extras?.tableSpec?.sameNameWarnings || []),
      diagnostics: parsedAll.flatMap(x => x.parsed.extras?.tableSpec?.diagnostics ? [x.parsed.extras.tableSpec.diagnostics] : [])
    };
    p.semantics = buildSemantics(p.canonical, p.description, workbookSpec);
    p.processState = buildProcessState(p.canonical, p.semantics.statements);
    p.rules = [];
    p.stage = 1;
    if (imageNotes.length) {
      p.imageNotes = imageNotes;
      p.history.push({ at: p.createdAt, action: '图片识别', detail: imageNotes.join('；'), fingerprint: null });
    }
    p.history.push({ at: p.createdAt, action: '解析材料', detail: `${schemaSources.length} 份表结构/流程材料 + ${Object.keys(sampleRows).length} 份样例数据，${p.canonical.classes.length} 张表 / ${p.canonical.processSegments.length} 个流程片段 / ${p.canonical.stats.sampleRows} 行样例数据`, fingerprint: modelHash(p.canonical).slice(0, 12) });
  }

  if (owlInputs.length) {
    const f = owlInputs[0];
    const parsed = OwlParser.parse(String(f.content || ''), f.name);
    await adoptParsed(p, parsed, f.name);
    p.stage = Math.max(p.stage, 4);
    p.history.push({ at: new Date().toISOString(), action: '导入已有 OWL', detail: `${f.name}：${parsed.stats.classes} 类 / ${parsed.stats.objectProperties} 关系 / ${parsed.stats.individuals} 实例`, fingerprint: sha(parsed.stats).slice(0, 12) });
  }
  await saveProject(p);
  return summarize(p);
}

/** 把解析器输出换算成可编辑的 OwlOntology JSON，保证「OWL → 图谱 → 编辑 → OWL」闭环 */
export function parsedToOwlJson(parsed, base) {
  const iri = parsed.ontologyIRI || base?.iri || 'https://example.org/ontology/imported';
  const ns = iri.endsWith('#') ? iri : iri + '#';
  const used = new Set();
  const idOf = (v, fallback) => {
    let s = String(v || fallback || 'x').replace(/[^\w.-]/g, '_').slice(0, 60) || 'x';
    let n = s, i = 2;
    while (used.has(n)) n = s + '_' + i++;
    used.add(n); return n;
  };
  const anns = (e, extra = []) => [
    ...(e.label ? [{ id: e.iri + '-label', property: 'rdfs:label', value: e.label, language: 'zh' }] : []),
    ...(e.comment ? [{ id: e.iri + '-comment', property: 'rdfs:comment', value: e.comment, language: 'zh' }] : []),
    ...extra
  ];
  const classes = parsed.classes.map(c => ({
    id: idOf(OwlParser.localName(c.iri), c.localName), iri: c.iri,
    localName: c.label || c.localName, annotations: anns(c),
    superClassExpressions: (c.parents || []).map(x => ({ id: 'sup-' + sha(x).slice(0, 8), type: 'namedClass', classIRI: x })),
    equivalentClassExpressions: [], disjointWith: []
  }));
  const objectProperties = parsed.objectProperties.map(x => ({
    id: idOf(OwlParser.localName(x.iri), x.localName), iri: x.iri,
    localName: x.label || x.localName, annotations: anns(x),
    superProperties: [], domains: x.domains || [], ranges: x.ranges || [],
    characteristics: x.characteristics || [], inverseOf: null
  }));
  const dataProperties = parsed.dataProperties.map(x => ({
    id: idOf(OwlParser.localName(x.iri), x.localName), iri: x.iri,
    localName: x.label || x.localName, annotations: anns(x),
    superProperties: [], domains: x.domains || [],
    ranges: x.ranges?.length ? x.ranges : [XSD + 'string'], functional: !!x.functional
  }));
  const individuals = parsed.individuals.map(x => ({
    id: 'instance/' + idOf(OwlParser.localName(x.iri), x.localName), iri: x.iri,
    localName: x.label || x.localName, annotations: [], types: x.types || [], sameAs: [], differentFrom: [],
    dataPropertyAssertions: (x.dataAssertions || []).map((a, i) => ({
      id: x.iri + '::dp' + i, propertyIRI: a.property, value: a.value, datatype: a.datatype || XSD + 'string'
    })),
    objectPropertyAssertions: (x.objectAssertions || []).map((a, i) => ({
      id: x.iri + '::op' + i, propertyIRI: a.property, targetIndividualIRI: a.target
    }))
  }));
  return {
    id: base?.id || uid('ont'), iri: iri.replace(/#$/, ''), versionIRI: ns + 'version/imported-' + sha(parsed.stats).slice(0, 8),
    annotations: [{ id: 'ont-name', property: 'rdfs:label', value: '由 OWL 导入的本体', language: 'zh' }],
    namespaces: [{ prefix: 'omw', iri: ns }, { prefix: 'xsd', iri: XSD }, { prefix: 'rdfs', iri: RDFS }],
    classes, objectProperties, dataProperties, individuals
  };
}

/** 统一编译：从规范模型或「页面编辑后的 owlJson」生成全部权威产物 */
function materialize(p, owl, sourceLabel) {
  const xml = toOwlXml(owl), turtle = toTurtle(owl), shacl = toShacl(owl), triples = toTriples(owl);
  const graph = { schema: schemaGraph(owl), instance: instanceGraph(owl) };
  decorateSchemaEdges(graph.schema, p.canonical, p.understandingFinal);
  const modelLike = p.canonical || {
    namespace: owl.iri + '#', conflicts: [],
    classes: owl.classes, objectProperties: owl.objectProperties, dataProperties: owl.dataProperties
  };
  const validation = buildReport(modelLike, owl, xml, turtle);
  p.owlJson = owl; p.owlXml = xml; p.turtle = turtle; p.shacl = shacl; p.triples = triples;
  p.graph = graph; p.validation = validation;
  p.history.push({
    at: new Date().toISOString(), action: sourceLabel,
    detail: `${owl.classes.length} 类 / ${owl.objectProperties.length} 关系 / ${owl.dataProperties.length} 字段 / ${owl.individuals.length} 实例，校验 ${validation.summary.passed}/${validation.summary.total}`,
    fingerprint: validation.fingerprint
  });
  if (p.history.length > 40) p.history = p.history.slice(-40);
  return { xml, turtle, shacl, triples, graph, validation };
}

export class ConflictBlock extends Error {
  constructor(conflicts) { super('存在未裁决的阻断级口径冲突，系统不会静默择一'); this.conflicts = conflicts; this.code = 409; }
}
export class LedgerBlock extends Error {
  constructor(items) { super('业务语义台账存在未确认的疑似落点、缺口或 ID 对齐候选，编译前须由业务用户勾选确认'); this.items = items; this.code = 409; }
}
export class UnderstandingBlock extends Error {
  constructor() {
    super('业务理解稿尚未定稿：请先用模型出稿或手工建模，再做一次整稿确认，之后才能生成 OWL');
    this.code = 409;
    this.items = [{ id: 'understanding', subject: '业务理解稿', detail: '未出稿或未定稿' }];
  }
}

export async function compileProject(id, { owlJson = null, note = '' } = {}) {
  const p = await getProject(id);
  let owl;
  if (owlJson && typeof owlJson === 'object' && Array.isArray(owlJson.classes)) {
    owl = normalizeEditable(owlJson, p);
  } else {
    if (!p.canonical) throw Error('当前项目没有表结构规范模型，请先上传材料，或直接导入 OWL 文件。');
    const open = blockers(p.canonical);
    if (open.length) throw new ConflictBlock(open);
    // 闸门 ①：业务理解稿必须一次整稿确认并定稿（含业务关系确认）
    if (!p.understandingFinal) throw new UnderstandingBlock();
    /* 旧闸门②（逐字段勾选台账）已并入「图谱确认」：关系在理解稿定稿时即完成保留/删除，
       不再额外阻断编译。字段落点信息仍保留在台账里供查阅。 */
    owl = toOwlJson(p.canonical, '1.0.' + modelHash(p.canonical).slice(0, 8));
  }
  materialize(p, owl, owlJson ? '图谱编辑回写 OWL' + (note ? ' · ' + note : '') : '生成 OWL 与活图谱');
  p.stage = 4;
  /* 一次上传两用：材料里带的数据行，编译完直接出实例图谱，不必让客户再传一遍。
     客户自己传过更完整的单据（origin=files）就不覆盖，免得把人工装载的结果冲掉。 */
  if (p.canonical?.stats?.sampleRows && (!p.instanceData || p.instanceData.origin === 'materials')) {
    try {
      const data = instantiateFromMaterials({ project: p });
      if (data) {
        p.instanceData = data;
        const st = data.integrity.stats;
        p.history.push({
          at: data.loadedAt, action: '按材料自带数据出实例图谱',
          detail: `${data.stats.rows} 行 / ${data.stats.tables} 张表 → ${data.stats.individuals} 个实例；完整性：${st.errors} 处错误、${st.warns} 处提醒`,
          fingerprint: `${data.stats.rows}-${data.stats.individuals}`
        });
      }
    } catch { /* 材料里的样例数据不完整不该挡编译：实例层出不来，逻辑模型照常发布 */ }
  }
  await saveProject(p);
  return summarize(p);
}

/** 页面编辑结果落到服务端前做结构归一，避免前端脏数据写进权威本体 */
function normalizeEditable(o, p) {
  const base = p.owlJson || {};
  const arr = v => Array.isArray(v) ? v : [];
  // localName 是编辑主字段，但 OWL/XML 的标签来自 rdfs:label 注解；此处统一同步，杜绝两者漂移
  const syncLabel = e => {
    const list = arr(e.annotations);
    const name = String(e.localName || '').trim() ||
      list.find(a => String(a.property).endsWith('label'))?.value || OwlParser.localName(e.iri || '');
    e.localName = name;
    const label = list.find(a => String(a.property).endsWith('label'));
    if (label) { label.value = name; label.language = label.language || 'zh'; }
    else list.push({ id: (e.iri || 'x') + '-label', property: 'rdfs:label', value: name, language: 'zh' });
    e.annotations = list;
    return e;
  };
  return {
    id: o.id || base.id || uid('ont'),
    iri: o.iri || base.iri || p.namespace.replace(/#$/, ''),
    versionIRI: o.versionIRI || base.versionIRI || p.namespace + 'version/edited',
    annotations: arr(o.annotations).length ? o.annotations : (base.annotations || []),
    namespaces: arr(o.namespaces).length ? o.namespaces : (base.namespaces || [
      { prefix: 'omw', iri: p.namespace }, { prefix: 'xsd', iri: XSD }, { prefix: 'rdfs', iri: RDFS }
    ]),
    classes: arr(o.classes).map(c => syncLabel({
      ...c, annotations: arr(c.annotations), superClassExpressions: arr(c.superClassExpressions),
      equivalentClassExpressions: [], disjointWith: []
    })),
    objectProperties: arr(o.objectProperties).map(x => syncLabel({
      ...x, annotations: arr(x.annotations), domains: arr(x.domains), ranges: arr(x.ranges),
      characteristics: arr(x.characteristics)
    })),
    dataProperties: arr(o.dataProperties).map(x => syncLabel({
      ...x, annotations: arr(x.annotations), domains: arr(x.domains),
      ranges: arr(x.ranges).length ? x.ranges : [XSD + 'string']
    })),
    individuals: arr(o.individuals).map(x => ({
      ...x, annotations: [], types: arr(x.types),
      dataPropertyAssertions: arr(x.dataPropertyAssertions), objectPropertyAssertions: arr(x.objectPropertyAssertions)
    }))
  };
}

async function adoptParsed(p, parsed, filename) {
  const owl = parsedToOwlJson(parsed, p.owlJson);
  materialize(p, owl, '从 OWL 重新解析 · ' + filename);
  p.parsedStats = parsed.stats;
  p.parsedFormat = parsed.format;
}

export async function parseOwlInto(id, { text, filename = 'pasted.owl' }) {
  if (typeof text !== 'string' || text.trim().length < 20) throw Error('OWL 内容为空或过短');
  const p = await getProject(id);
  const parsed = OwlParser.parse(text, filename);
  await adoptParsed(p, parsed, filename);
  p.stage = 4;
  await saveProject(p);
  return { ...summarize(p), parsedStats: parsed.stats, parsedFormat: parsed.format, parsedNotes: parsed.notes };
}

export async function applyProposal(id, { mode = 'draft', description = '' } = {}) {
  const p = await getProject(id);
  if (!p.canonical) throw Error('当前项目没有表结构规范模型，无法做语义提案。');
  const result = await propose(p.canonical, { mode, description: description || p.description });
  p.canonical = mergeProposal(p.canonical, result.proposal);
  p.proposal = result.proposal;
  p.proposalMode = result.mode;
  p.proposalNote = result.note;
  p.proposalWarnings = result.warnings;
  p.proposalStats = result.stats;
  p.stage = 2;
  p.history.push({ at: result.at, action: result.mode === 'ai' ? 'AI 语义提案' : '确定性草案',
    detail: `类 ${result.stats.classes} / 关系 ${result.stats.relations} / 规则 ${result.stats.constraints}，警告 ${result.warnings.length} 项`,
    fingerprint: sha(result.proposal).slice(0, 12) });
  await saveProject(p);
  return summarize(p);
}

export async function resolveConflicts(id, decisions = []) {
  const p = await getProject(id);
  if (!p.canonical) throw Error('当前项目没有规范模型');
  p.canonical = review(p.canonical, { conflicts: decisions, by: '工作台人工裁决' });
  p.history.push({ at: new Date().toISOString(), action: '人工裁决口径冲突', detail: decisions.map(d => `${d.id}:${d.action}`).join('、') || '无', fingerprint: sha(decisions).slice(0, 12) });
  await saveProject(p);
  return summarize(p);
}

/* ---------------- B 批：业务理解稿 / 手工建模旁路 / 一次确认 + 局部批注 ---------------- */

/** 生成理解稿 v1。mode=ai 走大模型（位置一）；mode=manual 走一等公民的手工建模旁路。
    无密钥时不生成伪理解稿，明确提示配置模型或手工填写。 */
export async function generateUnderstandingProject(id, { mode = 'ai', manual = {}, by = '工作台业务用户' } = {}) {
  const p = await getProject(id);
  if (!p.canonical) throw Error('当前项目没有表结构规范模型');
  if (p.understandingFinal) throw Error('理解稿已定稿；如需重做请先「重新开启理解稿」');
  let draft, warnings = [], origin;
  if (mode === 'manual') {
    draft = manualUnderstanding(p.canonical, { ...manual, alignments: p.semantics?.idAlignments || [] });
    origin = 'manual';
  } else if (mode === 'ai') {
    try {
      const r = await proposeUnderstanding(p.canonical, { description: p.description });
      draft = r.understanding; warnings = r.warnings; origin = 'ai';
    } catch (e) {
      /* 别把所有失败都说成「密钥没配」：以前一句提示把截断错误指到了配置页，
         排查方向直接被带偏。只有确实跟鉴权/密钥有关时才提密钥。 */
      const msg = String(e?.message || e);
      const authLike = /密钥|apiKey|401|403|鉴权|Unauthorized|unauthorized/.test(msg);
      const hint = authLike
        ? '请在「模型配置」填入密钥后重试。'
        : '可以直接重试；表多时可改「手工建模」逐表补。系统不会生成伪理解稿。';
      throw Error('模型不可用：' + msg + ' ' + hint);
    }
  } else throw Error('不支持的理解稿生成方式：' + mode);
  /* 模型没给业务关系时，用表结构外键补「待确认关系」边，保证草稿图谱有内容可清理 */
  if (!Array.isArray(draft.relations) || !draft.relations.length) {
    draft.relations = structureRelations(p.canonical, draft.tables, p.semantics?.idAlignments || []);
    if (draft.relations.length) warnings.push(`模型未给出业务关系，已用跨表同名键候选补 ${draft.relations.length} 条待确认关系，请在草稿图谱上逐条改成业务关系或删除`);
  }
  draft.relationStats = {
    total: draft.relations.length,
    confirmed: draft.relations.filter(r => r.status === 'confirmed').length,
    rejected: 0,
    pending: draft.relations.filter(r => r.status === 'candidate').length
  };
  p.understanding = draft;
  p.understandingFinal = null;
  p.understandingWarnings = warnings;
  p.understandingHistory = [{
    version: 1, action: origin === 'ai' ? '模型生成理解稿 v1' : '手工建模生成理解稿 v1',
    at: new Date().toISOString(), by,
    detail: `${draft.tables.length} 张表 / ${draft.relations.length} 条业务关系 / ${draft.stages.length} 个链路阶段 / ${draft.idDependencies.length} 条依赖 / ${draft.uncertainties.length} 处待补`,
    warnings, fingerprint: sha(draft.tables).slice(0, 12)
  }];
  p.stage = 2;
  await saveProject(p);
  return summarize(p);
}

/** 一次整稿确认 + 局部批注：系统按批注一次性生成定稿版，附差异清单，不产生 v3 */
export async function finalizeUnderstandingProject(id, { annotations = [], approval = { confirmed: true }, by = '工作台业务用户' } = {}) {
  const p = await getProject(id);
  if (!p.understanding) throw Error('尚未生成业务理解稿');
  const r = finalizeUnderstanding(p.understanding, { annotations, approval, by });
  p.understandingFinal = r.final;
  const applied = applyUnderstandingToProject(p);
  p.understandingHistory.push({
    version: 2, action: '一次整稿确认并定稿', at: new Date().toISOString(), by,
    detail: `${r.summary.annotations} 条局部批注全部处理，回写 ${applied} 张表的业务含义与角色，生成 ${r.final.stages.length} 个链路阶段`,
    diffSummary: r.final.diffSummary, revisionLog: r.final.revisionLog, fingerprint: r.final.fingerprint
  });
  p.stage = 3;
  await saveProject(p);
  return summarize(p);
}

/** 重新开启理解稿：保留上一版定稿快照，生成新的 v3 草稿，仍需再次一次确认 */
export async function reopenUnderstandingProject(id, { by = '工作台业务用户' } = {}) {
  const p = await getProject(id);
  if (!p.understandingFinal) throw Error('当前没有已定稿的理解稿');
  const base = JSON.parse(JSON.stringify(p.understandingFinal));
  base.version = (p.understandingHistory?.length || 2) + 1;
  base.status = 'draft';
  base.approval = null;
  base.revisionLog = [];
  base.diffSummary = [];
  delete base.fingerprint;
  p.understanding = base;
  p.understandingFinal = null;
  p.understandingHistory.push({ version: base.version, action: '重新开启理解稿', at: new Date().toISOString(), by, detail: '保留上一版定稿快照，需重新一次确认' });
  await saveProject(p);
  return summarize(p);
}

/* ---------------- 规则设立：文档 + 图谱口径 → 业务审查规则 → SQL ---------------- */

/** 用户提供审查依据（文字或文档）→ 模型解析成规则语义 → 确定性代码编译 SQL。
    本平台只产规则与 SQL，不执行规则；执行交给客户侧的规则引擎。 */
export async function generateRuleSpecs(id, { document = '', by = '工作台业务用户', dialect = 'ansi' } = {}) {
  const p = await getProject(id);
  if (!p.canonical) throw Error('当前项目没有表结构规范模型，先上传材料并解析');
  if (!p.understandingFinal) throw Error('请先把业务理解稿一次确认并定稿：规则要落在已确认的业务关系上');
  const doc = String(document || '').trim() || String(p.description || '').trim();
  if (!doc) throw Error('请提供审查依据：粘贴条款文字，或上载一份制度/规范文档');
  const graph = graphDigest(p.canonical, p.understandingFinal);
  /* 规则条数随文档长度涨，一次写不完就会在中间被截断。
     做法：截断时先救回已写出的规则，再把「已覆盖的审查点」带回去续写，
     最多续 3 轮；仍然覆盖不全就如实告警，不假装拿到了完整清单。 */
  const collected = [];
  const notes = [];
  let complete = false, rounds = 0;
  for (let round = 1; round <= 4; round++) {
    rounds = round;
    const exclude = collected.map(r => String(r?.name || '').trim()).filter(Boolean);
    try {
      const raw = await proposeRuleSpecs(graph, doc, { exclude });
      for (const r of (Array.isArray(raw?.rules) ? raw.rules : [])) collected.push(r);
      complete = true;
      break;
    } catch (e) {
      const authLike = /密钥|apiKey|401|403|鉴权|Unauthorized/.test(String(e?.message || e));
      if (!e?.truncated) {
        throw Error('模型不可用：' + String(e?.message || e) + (authLike
          ? ' 请在「模型配置」填入密钥后重试。'
          : ' 规则语义必须由模型解析，SQL 由确定性代码编译；可以直接重试，或把长文档拆成几段分别生成。'));
      }
      const saved = salvageJson(e.partial) || {};
      const got = (Array.isArray(saved.rules) ? saved.rules : []).filter(r => r && (r.name || r.intent));
      for (const r of got) collected.push(r);
      if (!got.length) {
        /* 一条都没救回来：说明单纯加长上下文也没用，直接把话说明白 */
        if (!collected.length) {
          throw Error('模型在第一条规则就没写完（输出上限 ' + (e.message.match(/(\d+)\s*tokens/) || [])[1] + ' tokens）。'
            + '请把文档拆成几段分别生成，或减少一次提交的审查点数量。');
        }
        notes.push(`第 ${round} 轮没有救回可用规则，停止续写；已获得 ${collected.length} 条`);
        break;
      }
      notes.push(`第 ${round} 轮输出达到上限，已保留 ${got.length} 条，正在续写剩余审查点`);
    }
  }

  /* 续写轮次之间可能重复出同一条规则，按规则名去重（保留先出现的） */
  const seenName = new Set();
  const deduped = [];
  for (const r of collected) {
    const key = String(r?.name || '').trim().replace(/\s+/g, '');
    if (key && seenName.has(key)) continue;
    if (key) seenName.add(key);
    deduped.push(r);
  }
  if (!deduped.length) throw Error('模型没有产出可用规则，请确认文档里确实写了审查要求，或换一份更明确的材料');

  const checked = validateRuleSpecs({ rules: deduped }, p.canonical);
  const rules = checked.rules;
  /* 续写时同一处越界/落不到字段的提示会出现多次，去重后再展示 */
  const warnings = [...new Set(checked.warnings.filter(Boolean))];
  if (!complete) warnings.unshift('规则输出达到模型上限，已分 ' + rounds + ' 轮生成；文档里可能还有审查点没覆盖到，建议拆成几段再生成一次补齐');
  for (const n of notes) warnings.push(n);
  const compiled = compileRuleSpecs(rules, dialect);
  p.ruleSpecs = {
    at: new Date().toISOString(), by, dialect,
    source: { document: doc.slice(0, 20000), chars: doc.length },
    graph: {
      classes: graph.tables.length, relations: graph.relations.length,
      understandingVersion: p.understandingFinal.version,
      fingerprint: p.understandingFinal.fingerprint || null
    },
    rules: compiled, warnings,
    rounds, truncated: !complete,
    note: '规则条件成立即命中；命中结果为待核查线索，不代表违规认定。本平台不执行规则。'
  };
  p.stage = Math.max(p.stage || 0, 5);
  p.history.push({
    at: p.ruleSpecs.at, action: '规则设立',
    detail: `依据 ${doc.length} 字文档，生成 ${compiled.length} 条业务审查规则（${dialect.toUpperCase()} 方言 SQL）`,
    fingerprint: sha(compiled.map(r => r.id + r.name)).slice(0, 12)
  });
  if (p.history.length > 40) p.history = p.history.slice(-40);
  await saveProject(p);
  return summarize(p);
}

/** 换 SQL 方言：不重新调用模型，只重新编译已有规则语义 */
export async function setRuleDialect(id, { dialect = 'ansi' } = {}) {
  const p = await getProject(id);
  if (!p.ruleSpecs?.rules?.length) throw Error('还没有生成规则');
  p.ruleSpecs.dialect = dialect;
  p.ruleSpecs.rules = compileRuleSpecs(p.ruleSpecs.rules, dialect);
  await saveProject(p);
  return summarize(p);
}

/** 删掉一条规则：规则语义留在理解稿里，只从本项目的规则清单移除 */
export async function removeRuleSpec(id, { ruleId } = {}) {
  const p = await getProject(id);
  if (!p.ruleSpecs?.rules?.length) throw Error('还没有生成规则');
  const before = p.ruleSpecs.rules.length;
  const target = p.ruleSpecs.rules.find(r => r.id === ruleId);
  p.ruleSpecs.rules = p.ruleSpecs.rules.filter(r => r.id !== ruleId);
  if (p.ruleSpecs.rules.length === before) throw Error('未找到该规则');
  p.history.push({ at: new Date().toISOString(), action: '删除规则', detail: target?.name || ruleId });
  await saveProject(p);
  return summarize(p);
}

/* ---------------- 第一批新增：台账确认 / 流程差异处置 / 规则发布与执行 ---------------- */

/** 已确认的 ID 对齐候选固化成规范模型里的对象属性，让草稿/最终图谱真正连起来。
    每次按当前确认态全量重算，驳回或改确认会即时反映，不累积脏关系。 */
function syncConfirmedMappings(p) {
  if (!p.canonical || !p.semantics) return 0;
  const confirmed = new Set((p.semantics.confirmations || []).filter(c => c.status === 'confirmed').map(c => c.refId));
  p.canonical.objectProperties = (p.canonical.objectProperties || []).filter(x => x.origin !== 'id-mapping');
  const byTable = new Map(p.canonical.classes.map(c => [c.sourceTable, c]));
  let n = 0;
  for (const a of p.semantics.idAlignments || []) {
    if (!confirmed.has(a.id)) continue;
    const from = byTable.get(a.left.table), to = byTable.get(a.right.table);
    if (!from || !to) continue;
    const id = 'idrel_' + sha(a.left.table + '|' + a.right.table + '|' + a.left.column).slice(0, 10);
    p.canonical.objectProperties.push({
      id, iri: p.canonical.namespace + encodeURIComponent(id),
      localName: a.left.column + ' → ' + a.right.column,
      domain: from.iri, range: to.iri,
      sourceTable: a.left.table, refTable: a.right.table,
      sourceColumns: a.left.field ? [a.left.field] : [], refColumns: a.right.field ? [a.right.field] : [],
      characteristics: [], cardinality: null,
      sourceRefs: [{ sourceName: '业务语义台账', locator: `${a.left.table}.${a.left.column} ↔ ${a.right.table}.${a.right.column}` }],
      confidence: 'high', status: 'confirmed', origin: 'id-mapping'
    });
    n++;
  }
  p.canonical.stats.objectProperties = p.canonical.objectProperties.length;
  return n;
}

/** 闸门 A：页面勾选确认。all=true 时一次确认全部阻断项，仍逐条留痕 */
export async function confirmLedger(id, { decisions = [], all = false, by = '工作台业务用户', comment = '' } = {}) {
  const p = await getProject(id);
  if (!p.semantics) throw Error('当前项目没有业务语义台账');
  const list = all ? blockingConfirmations(p.semantics).map(c => ({ id: c.id, action: 'confirm', comment: comment || '批量确认' })) : decisions;
  const r = applyConfirmations(p.semantics, list, by);
  const relations = syncConfirmedMappings(p);
  p.history.push({ at: new Date().toISOString(), action: '台账勾选确认', detail: `${r.changed} 项由 ${by} 确认，固化 ${relations} 条跨表关联，剩余阻断 ${r.stats.blocking} 项`, fingerprint: confirmedRuleBase(p.semantics).fingerprint });
  await saveProject(p);
  return summarize(p);
}

/** 闸门 B：流程差异三选一处置；adopt 会提升基线版本，exception 需带齐条件 */
export async function decideProcess(id, { decisions = [], by = '工作台业务用户' } = {}) {
  const p = await getProject(id);
  if (!p.processState) throw Error('当前项目没有流程基线');
  const r = applyDifferenceDecisions(p.processState, decisions, by);
  p.history.push({ at: new Date().toISOString(), action: '流程差异处置',
    detail: `${r.changed} 项裁决（${decisions.map(d => d.action).join('、')}），基线版本 v${r.version}，状态 ${r.status}`,
    fingerprint: sha(decisions).slice(0, 12) });
  await saveProject(p);
  return summarize(p);
}

/** 用户定义规则（A 批最小入口：结构化条件，后续 B–D 批改为图上点选路径 + 文字翻译） */
export async function saveProjectRules(id, { rules = [], replace = true } = {}) {
  const p = await getProject(id);
  const list = (Array.isArray(rules) ? rules : [rules]).filter(r => r && typeof r === 'object');
  for (const r of list) {
    if (!r.id) throw Error('规则缺少 id');
    if (!Array.isArray(r.conditions) || !r.conditions.length) throw Error('规则缺少条件');
    for (const c of r.conditions) {
      if (!c.operator || !Object.prototype.hasOwnProperty.call(c, 'left')) throw Error('条件缺少运算符或左值');
      const known = new Set(p.canonical.classes.map(c2 => c2.sourceTable));
      for (const side of [c.left, c.right]) if (side?.table && !known.has(side.table)) throw Error(`条件引用了未上传的表：${side.table}`);
    }
  }
  p.rules = replace ? list.map(r => ({ ...r, status: 'draft', version: r.version || '1.0', enabled: r.enabled !== false })) : [...p.rules, ...list];
  p.rules = p.rules.map(r => ({ ...r, compiled: compileRule(r) }));
  p.history.push({ at: new Date().toISOString(), action: '用户定义规则', detail: `${list.length} 条规则（领域无关条件树）`, fingerprint: sha(list).slice(0, 12) });
  await saveProject(p);
  return summarize(p);
}

/** 第 6 步：装载客户真实单据数据，生成实例（ABox）与完整性报告。
    只出实例与报告，不做规则判定——判定交给外部规则引擎。
    单据除了 CSV / xlsx，也可以是照片：拍照的单据先按已知表结构读成数据行，再走同一条装载链路。 */
export async function loadInstanceData(id, { files = [], by = '工作台业务用户' } = {}) {
  const p = await getProject(id);
  if (!p.canonical) throw Error('当前项目还没有规范模型，请先完成第 1—3 步');
  if (!p.understandingFinal) throw Error('请先在图谱确认里确认业务关系并生成 OWL，再装载实例数据');
  if (!files.length) throw Error('请选择要装载的单据文件（CSV / xlsx，也可以直接传单据照片）');

  const images = files.filter(f => isImageName(f.name));
  const rest = files.filter(f => !isImageName(f.name));
  const imageNotes = [];
  if (images.length) {
    const tableSpec = p.canonical.classes.map(c => ({
      table: c.sourceTable,
      label: c.localName,
      fields: (p.canonical.dataProperties || [])
        .filter(d => d.sourceTable === c.sourceTable)
        .map(d => ({ key: d.sourceColumn, name: d.localName || d.sourceColumn }))
    }));
    for (const f of images) {
      try {
        const binary = Buffer.from(String(f.content ?? ''), 'base64');
        const read = await readDocumentRows({ name: f.name, binary, tables: tableSpec });
        imageNotes.push(`${f.name} → ${read.note}（${read.rowCount} 行，${read.tables.join('、') || '未对上表'}）`);
        for (const csv of read.files) rest.push(csv);
      } catch (e) {
        imageNotes.push(`${f.name}：识别失败（${e.message}）`);
      }
    }
    if (!rest.length) {
      throw Error('单据照片没读出可用数据行：' + imageNotes.join('；'));
    }
  }

  const data = await instantiateProject({ project: p, files: rest, sampleDir: SAMPLE_DIR, by });
  data.imageNotes = imageNotes;
  p.instanceData = data;
  const st = data.integrity.stats;
  const srcNote = imageNotes.length ? `（含 ${images.length} 张单据照片）` : '';
  p.history.push({
    at: data.loadedAt, action: '装载实例数据',
    detail: `${data.stats.rows} 行 / ${data.stats.tables} 张表 → ${data.stats.individuals} 个实例${srcNote}；完整性：${st.errors} 处错误、${st.warns} 处提醒`,
    fingerprint: `${data.stats.rows}-${data.stats.individuals}`
  });
  if (imageNotes.length) {
    p.imageNotes = [...(p.imageNotes || []), ...imageNotes];
    p.history.push({ at: data.loadedAt, action: '单据照片识别', detail: imageNotes.join('；'), fingerprint: null });
  }
  await saveProject(p);
  return summarize(p);
}

/** 规则发布：两道闸门都通过才允许；发布前重新编译草图 */
export async function publishProjectRules(id) {
  const p = await getProject(id);
  const blockers = [
    ...blockingConfirmations(p.semantics).map(c => ({ kind: '台账待确认', subject: c.subject })),
    ...pendingDifferences(p.processState).map(d => ({ kind: '流程差异待裁决', subject: d.subject }))
  ];
  if (blockers.length) throw new RulesBlocked(blockers);
  const r = publishRules(p.rules, []);
  p.rules = p.rules.map(x => ({ ...x, compiled: compileRule(x) }));
  p.stage = 5;
  p.history.push({ at: r.at, action: '规则发布', detail: `${r.published} 条规则发布，基线 v${p.processState?.version || 1}`, fingerprint: sha(p.rules.map(x => x.id + x.status)).slice(0, 12) });
  await saveProject(p);
  return summarize(p);
}

/** 规则执行：只对已发布规则跑；输出完整证据链并与案例预期逐笔比对 */
export async function runProjectRules(id) {
  const p = await getProject(id);
  if (!p.canonical) throw Error('当前项目没有可执行的样例数据');
  if (!p.rules.some(r => r.status === 'published')) throw new RulesBlocked([{ kind: '规则未发布', subject: '请先在两道闸门确认后发布规则' }]);
  const result = runRules(p.canonical, p.rules, {
    versions: {
      ontology: p.owlJson?.versionIRI || p.canonical.version || '未编译',
      ledger: 'v' + (p.semantics?.version || 0),
      baseline: 'v' + (p.processState?.version || 0),
      rules: 'v1.0'
    },
    expected: p.referenceResults || []
  });
  p.ruleRuns = [result, ...(p.ruleRuns || [])].slice(0, 10);
  p.stage = 6;
  p.history.push({ at: result.at, action: '规则执行', detail: `命中 ${result.summary.HIT} 条待核查线索 / 资料不足 ${result.summary.INSUFFICIENT} 条，证据链 ${result.summary.evidenceSteps} 步，与案例预期 ${result.expectedComparison.matched}/${result.expectedComparison.total} 一致`, fingerprint: sha(result.summary).slice(0, 12) });
  await saveProject(p);
  return summarize(p);
}

export async function reviewHit(id, { hitId, decision = 'pending', reviewer = '', comment = '' } = {}) {
  const p = await getProject(id);
  let found = false;
  for (const run of p.ruleRuns || []) for (const h of run.hits) {
    if (h.id !== hitId) continue;
    h.humanReview = { status: decision, reviewer, comment, at: new Date().toISOString() };
    found = true;
  }
  if (!found) throw Error('未找到该命中记录');
  p.history.push({ at: new Date().toISOString(), action: '人工复核线索', detail: `${hitId} · ${decision} · ${reviewer || '未署名'}`, fingerprint: sha({ hitId, decision }).slice(0, 12) });
  await saveProject(p);
  return summarize(p);
}

/** 实例装载结果回传给页面：图上的节点才带上字段值，避免几万条断言全塞进响应。 */
function instanceBrief(p) {
  const d = p.instanceData;
  if (!d) return null;
  const onGraph = new Set((d.graph?.elements || []).filter(e => !e.data?.source).map(e => e.data.id));
  return {
    id: d.id, loadedAt: d.loadedAt, by: d.by, origin: d.origin || 'files',
    files: d.files, unmatched: d.unmatched, stats: d.stats,
    integrity: d.integrity, graph: d.graph, relations: d.relations || null,
    imageNotes: d.imageNotes || [],
    individuals: (d.individuals || []).filter(i => onGraph.has(i.iri))
  };
}

export function summarize(p) {
  return {
    id: p.id, name: p.name, namespace: p.namespace, description: p.description,
    createdAt: p.createdAt, updatedAt: p.updatedAt, stage: p.stage,
    materials: p.materials.map(m => ({ id: m.id, name: m.name, type: m.type, role: m.role, bytes: m.bytes, rows: m.rows || 0, sha256: m.sha256.slice(0, 12) })),
    /* 图片材料的识别结论：页面上要让人看到「这张截图认成了哪张表」 */
    imageNotes: p.imageNotes || [],
    owlInputs: p.owlInputs,
    canonical: p.canonical ? {
      /* stats 按当前模型重算：关系是定稿后才补进来的，直接用解析时那份会一直显示 0 条关系 */
      stats: {
        ...(p.canonical.stats || {}),
        classes: p.canonical.classes.length,
        dataProperties: (p.canonical.dataProperties || []).length,
        objectProperties: (p.canonical.objectProperties || []).length
      },
      status: p.canonical.status,
      classes: p.canonical.classes.map(c => ({ id: c.id, iri: c.iri, localName: c.localName, description: c.description, parent: c.parent, sourceTable: c.sourceTable, confidence: c.confidence, origin: c.origin })),
      objectProperties: p.canonical.objectProperties.map(x => ({
        id: x.id, iri: x.iri, localName: x.localName, sourceTable: x.sourceTable, refTable: x.refTable,
        /* status / cardinality 给画布用：确认过的边要实线高亮，候选的橙色虚线，
           声明了基数的边上标出 1:N 这类符号 */
        status: x.status || 'draft', cardinality: x.cardinality || '',
        sourceColumns: x.sourceColumns || [], refColumns: x.refColumns || [],
        origin: x.origin, confidence: x.confidence
      })),
      processSegments: p.canonical.processSegments.map(s => ({ id: s.id, heading: s.heading })),
      /* 列的内部标识（t5_05236a_f2）对业务用户没有意义：把「表 → {列: 业务名}」一起回传，
         页面显示字段依据、关系落地时替换成真实业务字段名 */
      columnLabels: (p.canonical.dataProperties || []).reduce((acc, d) => {
        if (!d.sourceTable || !d.sourceColumn) return acc;
        (acc[d.sourceTable] ||= {})[d.sourceColumn] = d.localName || d.sourceColumn;
        return acc;
      }, {}),
      conflicts: p.canonical.conflicts, sources: p.canonical.sources,
      constraints: p.canonical.constraints, glossary: p.canonical.glossary, notes: p.canonical.notes,
      businessStages: p.canonical.businessStages || [], understandingVersion: p.canonical.understandingVersion || null
    } : null,
    blockers: p.canonical ? blockers(p.canonical) : [],
    proposal: p.proposal, proposalMode: p.proposalMode, proposalNote: p.proposalNote,
    proposalWarnings: p.proposalWarnings, proposalStats: p.proposalStats,
    owlJson: p.owlJson, owlXmlPreview: p.owlXml ? p.owlXml.slice(0, 12000) : '',
    owlXmlBytes: Buffer.byteLength(p.owlXml || ''), turtlePreview: p.turtle ? p.turtle.slice(0, 4000) : '',
    graph: p.graph, validation: p.validation, parsedStats: p.parsedStats, parsedFormat: p.parsedFormat,
    semantics: p.semantics, processState: p.processState, rules: p.rules,
    ruleSpecs: p.ruleSpecs || null,
    instanceData: instanceBrief(p),
    ruleRuns: p.ruleRuns, referenceResults: p.referenceResults,
    understanding: p.understanding, understandingFinal: p.understandingFinal,
    understandingHistory: p.understandingHistory, understandingWarnings: p.understandingWarnings,
    roles: ROLES,
    draftGraph: p.canonical && (p.understandingFinal || p.understanding)
      ? draftGraph(p.canonical, p.understandingFinal || p.understanding) : null,
    relationStats: (p.understandingFinal || p.understanding)?.relationStats || null,
    gates: {
      understandingFinalized: !!p.understandingFinal,
      ledgerBlocking: blockingConfirmations(p.semantics).length,
      processBlocking: pendingDifferences(p.processState).length,
      rulesPublished: p.rules.some(r => r.status === 'published'),
      ruleBase: p.semantics ? confirmedRuleBase(p.semantics) : null
    },
    history: p.history
  };
}

export function exportFile(p, format) {
  switch (format) {
    case 'owl': return { name: 'ontology.owl', type: 'application/xml', body: p.owlXml };
    case 'ttl': return { name: 'ontology.ttl', type: 'text/turtle', body: p.turtle };
    case 'json': return { name: 'owl-ontology.json', type: 'application/json', body: JSON.stringify(p.owlJson, null, 2) };
    case 'graph': return { name: 'graph.json', type: 'application/json', body: JSON.stringify(p.graph, null, 2) };
    case 'shacl': return { name: 'shapes.ttl', type: 'text/turtle', body: p.shacl };
    case 'nt': return { name: 'triples.nt', type: 'application/n-triples', body: p.triples };
    case 'model': return { name: 'canonical-model.json', type: 'application/json', body: JSON.stringify(p.canonical, null, 2) };
    case 'ledger': return { name: 'business-ledger.json', type: 'application/json', body: JSON.stringify({ semantics: p.semantics, ruleBase: p.semantics ? confirmedRuleBase(p.semantics) : null }, null, 2) };
    case 'baseline': return { name: 'process-baseline.json', type: 'application/json', body: JSON.stringify(p.processState, null, 2) };
    case 'rules': return { name: 'rules.json', type: 'application/json', body: JSON.stringify(p.rules, null, 2) };
    case 'rulesql': return {
      name: 'business-rule-review.sql', type: 'application/sql',
      body: ruleSqlBundle(p.ruleSpecs?.rules || [], p)
    };
    case 'abox': {
      if (!p.instanceData?.individuals?.length) throw Error('还没有装载实例数据');
      return { name: 'instance-abox.owl', type: 'application/rdf+xml', body: toAboxXml(p.canonical, p.instanceData.individuals) };
    }
    case 'rulespec': return { name: 'rule-specs.json', type: 'application/json', body: JSON.stringify(p.ruleSpecs || null, null, 2) };
    case 'evidence': return { name: 'rule-runs-evidence.json', type: 'application/json', body: JSON.stringify(p.ruleRuns, null, 2) };
    case 'understanding': return { name: 'business-understanding.json', type: 'application/json', body: JSON.stringify({ draft: p.understanding, final: p.understandingFinal, history: p.understandingHistory }, null, 2) };
    default: throw Error('不支持的导出格式：' + format);
  }
}

/* V2.1 硬纪律：产品不提供任何内置样例 / demo 数据。
   回归测试所需的材料由测试脚本自行构造，或通过外部路径参数传入用户提供的测试夹具。 */
