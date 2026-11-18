import { sha, uid } from './store.mjs';

const NS_DEFAULT = 'https://example.org/ontology/model#';
const safe = s => String(s).replace(/[^\w.-]/g, '_');
const ref = (m, locator) => ({ sourceId: m.sourceId, sourceName: m.sourceName, locator });

function baseModel(name, namespace) {
  return {
    schema: 'omw.canonical/1.0', id: uid('model'), name,
    namespace: namespace || NS_DEFAULT, version: 'draft', status: 'draft',
    createdAt: new Date().toISOString(),
    sources: [], classes: [], dataProperties: [], objectProperties: [],
    constraints: [], processSegments: [], rowsByTable: {}, conflicts: [],
    glossary: [], notes: []
  };
}

function addConflict(model, kind, subject, claims, severity = 'blocker') {
  const duplicate = model.conflicts.find(c => c.kind === kind && c.subject === subject && c.status === 'open');
  if (duplicate) return duplicate;
  const c = { id: uid('cf'), kind, subject, claims, severity, status: 'open', resolution: null };
  model.conflicts.push(c);
  return c;
}

/* 一张表最多随项目存多少行：客户上载的表格本身就是实例数据的来源，
   存太少会让实例图谱只剩个位数单据，存太多又会让项目文件过大。 */
const MAX_SAMPLE_ROWS = 2000;
const SCHEMA_TYPES = new Set(['dictionary', 'ddl', 'csv', 'workbook']);
const TYPE_ORDER = { dictionary: 0, ddl: 1, csv: 2, workbook: 3 };

export function buildCanonical({ name, namespace, materials }) {
  const model = baseModel(name, namespace);
  /* 所有带表结构的材料一起建模，不是只取第一份。
     以前这里写作 [...dictionaries, ...ddls, ...csvs, ...workbooks][0]：
     客户把 7 张表拆成 7 个 xlsx 上传时，只有第一个文件被当成表结构，
     其余 6 个既不合并也不报错——页面上就只剩 1 张表。 */
  const schemaMaterials = materials.filter(m => SCHEMA_TYPES.has(m.sourceType))
    .slice().sort((a, b) => (TYPE_ORDER[a.sourceType] ?? 9) - (TYPE_ORDER[b.sourceType] ?? 9));
  // 任何材料都可以携带可引用片段（工作簿的说明行、CSV 表头、流程描述）
  const processes = materials.filter(m => (m.segments || []).length);
  for (const m of materials) model.sources.push({ id: m.sourceId, name: m.sourceName, type: m.sourceType, sha256: m.sha256 });
  for (const p of processes) for (const s of p.segments) model.processSegments.push({ ...s, sourceId: p.sourceId, sourceName: p.sourceName });

  if (!schemaMaterials.length) throw Error('缺少表结构材料：请提供 JSON 字段字典、SQL DDL、CSV、Excel 工作簿，或表结构截图。');
  const ns = model.namespace;
  const classByTable = new Map();
  const owner = new Map();     /* 表名 → 第一份声明它的材料 */
  const dups = [];             /* 同名表在多份材料里都出现，逐字段对一遍 */

  for (const m of schemaMaterials) {
    for (const t of m.tables || []) {
      if (owner.has(t.name)) { dups.push({ table: t, material: m, first: owner.get(t.name).material }); continue; }
      owner.set(t.name, { table: t, material: m });
      const id = safe(t.name);
      const cls = {
        id, iri: ns + encodeURIComponent(id), localName: t.label || t.name,
        description: t.description || '', parent: null,
        sourceTable: t.name, primaryKey: t.primaryKey || [],
        sourceRefs: [ref(m, 'table:' + t.name)],
        confidence: 'high', status: 'draft', origin: 'deterministic'
      };
      model.classes.push(cls);
      classByTable.set(t.name, cls);
      for (const f of t.fields || []) {
        const pid = id + '__' + safe(f.name);
        model.dataProperties.push({
          id: pid, iri: ns + encodeURIComponent(pid), localName: f.label || f.description || f.name,
          domain: cls.iri, range: 'http://www.w3.org/2001/XMLSchema#' + (f.type || 'string'),
          sourceTable: t.name, sourceColumn: f.name, required: !!f.required, isKey: /PK/i.test(f.key || ''),
          sourceRefs: [ref(m, t.name + '.' + f.name)],
          confidence: 'high', status: 'draft', origin: 'deterministic'
        });
      }
      (t.rows || []).slice(0, MAX_SAMPLE_ROWS).forEach(row => { (model.rowsByTable[t.name] ||= []).push(row); });
    }
  }

  for (const { table: t, material: m } of owner.values()) {
    for (const [i, fk] of (t.foreignKeys || []).entries()) {
      const from = classByTable.get(t.name), to = classByTable.get(fk.refTable);
      const pid = safe(t.name) + '__rel' + (i + 1);
      model.objectProperties.push({
        id: pid, iri: ns + encodeURIComponent(pid),
        localName: '关联' + (to?.localName || fk.refTable),
        domain: from?.iri || '', range: to?.iri || '',
        sourceTable: t.name, sourceColumns: fk.fields || [],
        refTable: fk.refTable, refColumns: fk.refFields || [],
        characteristics: [], cardinality: null,
        sourceRefs: [ref(m, t.name + ' -> ' + fk.refTable)],
        confidence: 'high', status: 'draft', origin: 'deterministic'
      });
      if (!to) addConflict(model, 'unresolved_reference',
        t.name + ' → ' + fk.refTable,
        [{ source: m.sourceName, value: '外键指向的表未包含在本次录入的表结构中' }], 'warning');
    }
  }

  /* 交叉校验：同一张表在两份来源里都声明过，字段集合 / 类型不一致必须显式上报，禁止静默择一。
     表彼此不同（拆成多个文件上传）不算冲突——那本来就是同一次上传。 */
  for (const { table: t, material: m, first } of dups) {
    const mainFields = model.dataProperties.filter(p => p.sourceTable === t.name).map(p => p.sourceColumn);
    const otherFields = (t.fields || []).map(f => f.name);
    const missing = mainFields.filter(f => !otherFields.includes(f));
    const extra = otherFields.filter(f => !mainFields.includes(f));
    if (missing.length || extra.length) addConflict(model, 'field_set_mismatch', t.name, [
      { source: first.sourceName, value: mainFields.join(', ') },
      { source: m.sourceName, value: otherFields.join(', ') }
    ]);
    for (const f of t.fields || []) {
      const p = model.dataProperties.find(p => p.sourceTable === t.name && p.sourceColumn === f.name);
      if (p && p.range.split('#').pop() !== f.type) addConflict(model, 'type_mismatch', t.name + '.' + f.name, [
        { source: first.sourceName, value: p.range.split('#').pop() },
        { source: m.sourceName, value: f.type }
      ]);
    }
  }

  if (processes.length) model.notes.push('流程描述已切分为 ' + model.processSegments.length + ' 个语义片段，等待 agent 工位抽取业务关系与约束。');
  model.stats = {
    classes: model.classes.length, dataProperties: model.dataProperties.length,
    objectProperties: model.objectProperties.length, processSegments: model.processSegments.length,
    sampleRows: Object.values(model.rowsByTable).reduce((n, rows) => n + rows.length, 0)
  };
  return model;
}

export function mergeProposal(model, proposal) {
  if (!proposal || typeof proposal !== 'object') throw Error('提案内容无效');
  const segIds = new Set(model.processSegments.map(s => s.id));
  const resolveRefs = list => (list || []).map(r => {
    if (typeof r === 'string' && segIds.has(r)) return { sourceName: '流程描述', locator: model.processSegments.find(s => s.id === r).heading, segmentId: r, verified: true };
    if (typeof r === 'string') return { sourceName: '流程描述', locator: r, verified: false };
    return { ...r, verified: !!r.segmentId && segIds.has(r.segmentId) };
  });
  const unverified = [];
  const checkRefs = (label, refs) => { if (refs.some(r => r.verified === false)) unverified.push(label); return refs; };

  for (const item of proposal.classes || []) {
    const cls = model.classes.find(c => c.id === item.id || c.sourceTable === item.table || c.localName === item.label);
    if (!cls) continue;
    const refs = resolveRefs(item.sourceRefs);
    if (item.label && item.label !== cls.localName) cls.localName = item.label;
    if (item.description) cls.description = item.description;
    if (item.parent) cls.parent = item.parent;
    cls.sourceRefs = [...cls.sourceRefs, ...checkRefs(cls.id, refs)];
    cls.origin = 'agent-reviewed';
    cls.confidence = 'medium';
    cls.notes = item.notes || '';
  }
  for (const item of proposal.relations || []) {
    const find = key => model.classes.find(c => c.id === key || c.sourceTable === key || c.localName === key);
    const from = find(item.from), to = find(item.to);
    if (!from || !to) { addConflict(model, 'semantic_conflict', (item.from || '?') + ' → ' + (item.to || '?'), [{ source: 'agent 提案', value: '关系端点无法对应到已录入的表/对象' }], 'warning'); continue; }
    const pid = 'sem_' + (model.objectProperties.filter(p => String(p.id).startsWith('sem_')).length + 1);
    if (model.objectProperties.some(p => p.id === pid)) continue;
    model.objectProperties.push({
      id: pid, iri: model.namespace + encodeURIComponent(pid), localName: item.label || '业务关系',
      domain: from.iri, range: to.iri, characteristics: item.characteristics || [],
      cardinality: item.cardinality || null, description: item.description || '',
      sourceRefs: checkRefs(pid, resolveRefs(item.sourceRefs)),
      confidence: 'medium', status: 'draft', origin: 'agent'
    });
  }
  for (const item of proposal.constraints || []) {
    model.constraints.push({
      id: uid('rule'), kind: item.kind || 'businessRule', target: item.target || '',
      expression: item.expression || '', text: item.text || '',
      sourceRefs: checkRefs(item.target, resolveRefs(item.sourceRefs)),
      confidence: 'medium', status: 'draft', origin: 'agent'
    });
  }
  for (const g of proposal.glossary || []) model.glossary.push({ term: g.term, definition: g.definition, sourceRefs: resolveRefs(g.sourceRefs) });
  if (unverified.length) addConflict(model, 'unverified_source', unverified.join(', '),
    [{ source: 'agent 提案', value: '引用了无法定位到原文的出处，需人工复核' }], 'warning');
  model.stats.agentRelations = (proposal.relations || []).length;
  model.stats.agentConstraints = (proposal.constraints || []).length;
  return model;
}

export function review(model, decisions = {}) {
  for (const d of decisions.conflicts || []) {
    const c = model.conflicts.find(x => x.id === d.id);
    if (!c) continue;
    if (['accept_a', 'accept_b', 'rename', 'reject', 'ignore'].includes(d.action)) {
      c.status = 'resolved';
      c.resolution = { action: d.action, value: d.value || null, at: new Date().toISOString(), by: d.by || 'reviewer' };
      if (d.action === 'rename' && d.value) {
        const cls = model.classes.find(x => x.id === c.subject);
        if (cls) cls.localName = d.value;
      }
    }
  }
  if (decisions.confirmDraft) for (const list of [model.classes, model.dataProperties, model.objectProperties, model.constraints]) for (const x of list) if (x.status === 'draft') x.status = 'confirmed';
  for (const d of decisions.overrides || []) {
    const target = [...model.classes, ...model.dataProperties, ...model.objectProperties].find(x => x.id === d.id);
    if (target) Object.assign(target, d.patch || {}, { status: 'confirmed', origin: 'human' });
  }
  model.status = 'reviewed';
  model.reviewedAt = new Date().toISOString();
  return model;
}

export function blockers(model) {
  return model.conflicts.filter(c => c.status === 'open' && c.severity === 'blocker');
}
export function modelHash(model) {
  return sha({ classes: model.classes, dataProperties: model.dataProperties, objectProperties: model.objectProperties, constraints: model.constraints });
}
