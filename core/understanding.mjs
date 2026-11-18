/* 业务理解稿（V2.1 B 批）：把「这批表在讲什么业务、链路什么样、靠什么串起来」
   变成一张业务用户能整稿确认的稿子。
   纪律：只引用已上传的表名/字段名与材料片段；推断单列标 low；
        不输出 OWL/SQL；无模型时不生成伪理解稿，改走手工建模（一等公民路径）；
        一次整稿确认 + 局部批注，只产生 v1 与定稿版两个版本。 */
import { sha, uid } from './store.mjs';

export const ROLES = [
  { id: 'master', label: '主数据', hint: '被反复引用的基础对象' },
  { id: 'event', label: '业务事件', hint: '发生一次、通常带时间与状态' },
  { id: 'bridge', label: '关联桥', hint: '把两个对象连起来，常含多个外键' },
  { id: 'evidence', label: '证据/附件', hint: '指向原文或凭证' },
  { id: 'result', label: '结果记录', hint: '判断、评估、核查的输出' },
  { id: 'snapshot', label: '快照/配置', hint: '技术性版本或批次记录' },
  { id: 'unspecified', label: '未指定', hint: '尚未确认角色' }
];
const ROLE_IDS = new Set(ROLES.map(r => r.id));
const FORMAT_TEXT = /<Ontology[\s>]|@prefix\s+\w+:|owl:Class|SELECT\s+.+\s+FROM|```/i;

/* 关系名纪律：图上每条边必须是业务关系（「订单 包含 物料」），
   不是字段映射（「物料编码 → 物料编码」）。技术形态的名字一律降级为待确认。 */
const TECH_PREDICATE = /(_id|_code|_no|_key|_sn|^fk_|^rel_|^sem_|__|^[a-z]+_[a-z]+$)/i;
const PREDICATE_MAX = 24;

/* 只有通用动词、没有业务动作的关系名：读不出「这条边在业务上到底在做什么事」。
   不丢弃（边本身是对的），但标出来让人补成具体业务语义。 */
const GENERIC_VERBS = ['属于', '包含', '关联', '依据', '对应', '产生', '引用', '指向', '使用', '拥有', '涉及', '归属', '继承', '衍生'];
export const isGenericPredicate = p => {
  const s = String(p || '').trim();
  if (!s || s === '待确认关系') return false;
  const hit = GENERIC_VERBS.find(v => s.startsWith(v));
  if (!hit) return false;
  /* 「包含物料明细」也算泛：动词后面只跟了一个对象名词，没有动作。
     判断依据是去掉动词后剩余部分是否很短且不含动作性后缀（收货/开票/结算/验收/核销…）。 */
  const rest = s.slice(hit.length);
  const ACTION = /(收货|入库|出库|开票|结算|付款|验收|核销|领用|退回|冲销|结转|锁定|变更|终止|生效|审批|签约|履约|对账|计提|摊|报废|盘点|调拨|预提|预付|开票|计税|扣款)/;
  if (!rest) return true;
  return !ACTION.test(rest);
};

export const RELATION_STATUS = ['candidate', 'confirmed', 'rejected'];

function normalizeRelations(raw, known, warnings, originTag = 'relations') {
  const out = [];
  const seen = new Set();
  (Array.isArray(raw) ? raw : []).forEach((r, i) => {
    if (!r || typeof r !== 'object') return;
    const subject = String(r.subject || r.from || '').trim();
    const object = String(r.object || r.to || '').trim();
    if (!known.has(subject) || !known.has(object)) {
      warnings.push(`${originTag}[${i}] 端点不在已上传表内（${subject || '?'} → ${object || '?'}），已丢弃`);
      return;
    }
    if (subject === object) { warnings.push(`${originTag}[${i}] 自环关系已忽略`); return; }
    let predicate = String(r.predicate || r.label || '').trim().slice(0, PREDICATE_MAX);
    if (!predicate) { warnings.push(`${originTag}[${i}] 缺关系名，已丢弃`); return; }
    if (TECH_PREDICATE.test(predicate)) {
      warnings.push(`${originTag}[${i}] 关系名「${predicate}」是字段/技术形态，已置为待确认`);
      predicate = '待确认关系';
    }
    const meaning = String(r.meaning || r.businessMeaning || r.description || '').trim().slice(0, 240);
    const key = `${subject}|${predicate}|${object}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({
      id: 'r' + (out.length + 1) + '_' + sha(key).slice(0, 6),
      subject, object, predicate,
      /* 业务含义：这条边在业务上到底在做什么事、约束了什么。
         「关联/依据」这种只有动词没有动作的名字，光靠 predicate 读不出含义，
         所以含义单独存一份，进图谱详情、也进 OWL 注释。 */
      meaning,
      vague: isGenericPredicate(predicate),
      via: (Array.isArray(r.via) ? r.via : []).map(String).slice(0, 4),
      cardinality: ['1:1', '1:N', 'N:1', 'N:N'].includes(r.cardinality) ? r.cardinality : '',
      basis: String(r.basis || r.evidenceBasis || '').slice(0, 300),
      origin: originTag,
      status: RELATION_STATUS.includes(r.status) ? r.status : 'candidate',
      confidence: ['high', 'medium', 'low'].includes(r.confidence) ? r.confidence : 'medium',
      sourceRefs: Array.isArray(r.sourceRefs) ? r.sourceRefs : []
    });
  });
  /* 汇总提示，不逐条刷屏：用户要的是「这些边得补业务含义」，不是 17 条重复告警 */
  const missing = out.filter(r => r.predicate !== '待确认关系' && !r.meaning);
  if (missing.length) {
    warnings.push(`${missing.length} 条关系只写了关系名、没有写业务含义（${missing.slice(0, 3).map(r => r.subject + ' ' + r.predicate + ' ' + r.object).join('、')}${missing.length > 3 ? ' 等' : ''}），建议在图谱确认里补上一句话说明`);
  }
  const vague = out.filter(r => r.vague && r.predicate !== '待确认关系');
  if (vague.length) {
    warnings.push(`${vague.length} 条关系名只有通用动词、读不出具体业务动作（${vague.slice(0, 3).map(r => r.predicate).join('、')}${vague.length > 3 ? ' 等' : ''}），建议改成「按订单收货」这类写法`);
  }
  return out;
}

export const UNDERSTANDING_CONTRACT = {
  tables: [{ table: '表名（必须来自已上传材料）', role: 'master|event|bridge|evidence|result|snapshot', meaning: '一句话业务含义', logic: '背后的业务逻辑', stage: '所属链路阶段', sourceRefs: ['片段id'], confidence: 'high|medium|low' }],
  stages: [{ order: 1, name: '阶段名', events: ['事件'], tableRefs: ['表名'], sourceRefs: ['片段id'] }],
  relations: [{
    subject: '源业务对象（表名）',
    predicate: '业务动作短语（动宾，8–16 字），要能读出「在做什么业务动作」，如 按订单收货 / 按发票结算 / 由供应商履约 / 按批次质检。禁止只写 属于 / 包含 / 关联 / 依据 / 对应 这类通用词，也禁止用字段名或 fk_xxx',
    object: '目标业务对象（表名）',
    meaning: '这条关系的业务含义：什么动作、在什么条件下成立、约束了什么（一句话，≤60 字，如「入库按采购订单的到货批次逐批验收，累计入库量不得超过订单未入库量」）',
    via: ['支撑该关系的字段，如 订单.订单号 → 订单明细.订单号'],
    cardinality: '1:1|1:N|N:1|N:N',
    basis: '材料依据或推断说明',
    confidence: 'high|medium|low'
  }],
  idDependencies: [{ from: '源表', to: '目标表', fields: ['关联字段'], status: 'candidate', sourceRefs: ['片段id'] }],
  gaps: [{ subject: '缺口对象', kind: 'field|table|source', note: '说明', sourceRefs: [] }],
  uncertainties: [{ subject: '对象', text: '推断内容与依据', sourceRefs: [] }]
};

/** 服务端强校验：模型返回的理解稿不得越界、不得夹带格式产物 */
export function validateUnderstanding(raw, model) {
  const warnings = [];
  if (!raw || typeof raw !== 'object') throw Error('理解稿不是 JSON 对象');
  for (const k of ['tables', 'stages', 'relations', 'idDependencies', 'gaps', 'uncertainties']) {
    if (raw[k] !== undefined && !Array.isArray(raw[k])) throw Error(`理解稿字段 ${k} 必须是数组`);
  }
  if (FORMAT_TEXT.test(JSON.stringify(raw))) throw Error('理解稿夹带 OWL / SQL / 代码围栏，已拒绝');
  const known = new Set((model.classes || []).map(c => c.sourceTable));
  const labels = new Map((model.classes || []).map(c => [c.sourceTable, c.localName]));
  const segIds = new Set((model.processSegments || []).map(s => s.id));
  const checkRefs = (label, refs) => {
    for (const r of (Array.isArray(refs) ? refs : [])) {
      const sid = typeof r === 'string' ? r : r?.segmentId;
      if (sid && !segIds.has(sid)) warnings.push(`${label} 引用了无法定位的材料片段 ${sid}`);
    }
  };
  const tables = (raw.tables || []).filter((t, i) => {
    if (!t || typeof t !== 'object') return false;
    const key = t.table || t.name;
    if (!known.has(key)) { warnings.push(`tables[${i}] 引用了未上传的表 ${key}，已丢弃`); return false; }
    if (t.role && !ROLE_IDS.has(t.role)) { warnings.push(`tables[${i}] 角色 ${t.role} 不在白名单，置为未指定`); t.role = 'unspecified'; }
    checkRefs(`tables[${i}]`, t.sourceRefs);
    return true;
  }).map(t => ({
    table: t.table || t.name, tableLabel: labels.get(t.table || t.name) || '',
    role: t.role || 'unspecified', meaning: String(t.meaning || '').slice(0, 300),
    logic: String(t.logic || '').slice(0, 400), stage: t.stage ? String(t.stage).slice(0, 80) : '',
    sourceRefs: Array.isArray(t.sourceRefs) ? t.sourceRefs : [],
    confidence: ['high', 'medium', 'low'].includes(t.confidence) ? t.confidence : 'medium'
  }));
  const stages = (raw.stages || []).filter(s => s && typeof s === 'object').map((s, i) => ({
    order: Number.isFinite(Number(s.order)) ? Number(s.order) : i + 1,
    name: String(s.name || '未命名阶段').slice(0, 100),
    events: Array.isArray(s.events) ? s.events.map(String) : [],
    tableRefs: (Array.isArray(s.tableRefs) ? s.tableRefs : []).filter(t => known.has(t)),
    sourceRefs: Array.isArray(s.sourceRefs) ? s.sourceRefs : []
  })).sort((a, b) => a.order - b.order);
  stages.forEach((s, i) => checkRefs(`stages[${i}]`, s.sourceRefs));
  /* 模型经常把关系全塞进 idDependencies，relations 留空——提示词里「宁可少画」
     被它执行成了「一条不画」，草稿图谱就一条边都没有，用户看到的是一片散点。
     这里补兜底：先按模型自己判断的字段依赖生成待确认关系，再退回表结构外键/同名键。
     这些边关系名一律是「待确认关系」，用户在图谱上改成业务动作或删除即可。 */
  let relations = normalizeRelations(raw.relations, known, warnings, 'relations');
  const idDependencies = (raw.idDependencies || []).filter(d => d && known.has(d.from) && known.has(d.to)).map(d => ({
    from: d.from, to: d.to, fields: Array.isArray(d.fields) ? d.fields.map(String) : [],
    status: 'candidate', sourceRefs: Array.isArray(d.sourceRefs) ? d.sourceRefs : []
  }));
  if (!relations.length) relations = relationsFromDependencies(idDependencies, warnings);
  if (!relations.length) relations = structureRelations(model, tables, []);
  const gaps = (raw.gaps || []).filter(g => g && typeof g === 'object').slice(0, 30);
  const uncertainties = (raw.uncertainties || []).filter(u => u && typeof u === 'object').slice(0, 30);
  return {
    understanding: { version: 1, origin: 'ai', generatedAt: new Date().toISOString(), tables, stages, relations, idDependencies, gaps, uncertainties,
      note: '由模型依据上传材料生成；关系为业务关系，推断内容单列于 uncertainties，需业务用户确认。' },
    warnings
  };
}

/** 手工建模旁路：用用户在结构化表单里填的内容生成同结构理解稿，不伪造 AI 推断 */
export function manualUnderstanding(model, input = {}) {
  const submitted = new Map((Array.isArray(input.tables) ? input.tables : []).map(t => [t.table, t]));
  const tables = (model.classes || []).map(c => {
    const s = submitted.get(c.sourceTable) || {};
    return {
      table: c.sourceTable, tableLabel: c.localName,
      role: ROLE_IDS.has(s.role) ? s.role : 'unspecified',
      meaning: String(s.meaning || '').trim() || c.localName,
      logic: String(s.logic || '').trim(), stage: String(s.stage || '').trim(),
      sourceRefs: [], confidence: s.meaning ? 'high' : 'low'
    };
  });
  const explicit = (Array.isArray(input.stages) ? input.stages : []).filter(s => s && String(s.name || '').trim());
  let stages;
  if (explicit.length) {
    stages = explicit.map((s, i) => ({
      order: Number.isFinite(Number(s.order)) ? Number(s.order) : i + 1,
      name: String(s.name).slice(0, 100), events: Array.isArray(s.events) ? s.events.map(String) : [],
      tableRefs: Array.isArray(s.tableRefs) ? s.tableRefs : [], sourceRefs: []
    })).sort((a, b) => a.order - b.order);
    /* 阶段没对上对象时，用每张表填的「链路阶段」补上——
       否则业务链路里每个阶段下面都是空的，看着像没生效 */
    const byStage = new Map();
    tables.forEach(t => { if (t.stage) { if (!byStage.has(t.stage)) byStage.set(t.stage, []); byStage.get(t.stage).push(t.table); } });
    stages = stages.map(s => (s.tableRefs.length ? s : { ...s, tableRefs: byStage.get(s.name) || [] }));
  } else {
    const byStage = new Map();
    tables.forEach(t => { if (t.stage) { if (!byStage.has(t.stage)) byStage.set(t.stage, []); byStage.get(t.stage).push(t.table); } });
    stages = [...byStage].map(([name, tableRefs], i) => ({ order: i + 1, name, events: [], tableRefs, sourceRefs: [] }));
  }
  const uncertainties = tables.filter(t => t.role === 'unspecified' || !t.stage || !s_hasMeaning(t, submitted))
    .map(t => ({ subject: t.table, text: '角色、链路阶段或业务含义未填写，需业务用户补充', sourceRefs: [] }));
  const known = new Set(tables.map(t => t.table));
  const warn = [];
  let relations = normalizeRelations(input.relations, known, warn, 'manual');
  if (!relations.length) relations = structureRelations(model, tables, input.alignments || []);
  return {
    version: 1, origin: 'manual', generatedAt: new Date().toISOString(), tables, stages, relations,
    idDependencies: (Array.isArray(input.idDependencies) ? input.idDependencies : []).filter(d => d && d.from && d.to),
    gaps: (Array.isArray(input.gaps) ? input.gaps : []).filter(g => g && typeof g === 'object'),
    uncertainties, warnings: warn,
    note: '由业务用户手工填写生成；预填的业务含义取自材料中的表原名，不是模型推断。未填项列入待补。'
  };
}
function s_hasMeaning(t, submitted) {
  const s = submitted.get(t.table);
  return !!(s && String(s.meaning || '').trim());
}

/** 模型只给了字段依赖、没给业务关系时，把依赖翻成「待确认关系」边：
    至少让草稿图谱上有东西可以改，而不是一片散点。 */
export function relationsFromDependencies(deps, warnings = []) {
  const out = [];
  const seen = new Set();
  for (const d of Array.isArray(deps) ? deps : []) {
    if (!d || !d.from || !d.to || d.from === d.to) continue;
    const key = `${d.from}|${d.to}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const via = (Array.isArray(d.fields) ? d.fields : []).map(f => `${d.from}.${f} ↔ ${d.to}.${f}`);
    out.push({
      id: 'r' + (out.length + 1) + '_' + sha(key).slice(0, 6),
      subject: d.from, object: d.to, predicate: '待确认关系',
      meaning: '', vague: true, via: via.slice(0, 4),
      cardinality: '', basis: '来自模型判断的字段依赖，业务关系名待确认',
      origin: 'idDependency', status: 'candidate', confidence: 'low',
      sourceRefs: Array.isArray(d.sourceRefs) ? d.sourceRefs : []
    });
  }
  if (out.length) {
    warnings.push(`模型没写业务关系名，已按它判断的 ${out.length} 条字段依赖生成待确认关系，请在图谱上改成业务动作（如「按订单收货」）`);
  }
  return out;
}

/** 结构兜底：模型没给关系时，用「已声明的外键 + 跨表同名键候选」生成待确认关系边，
    保证草稿图谱有内容可清理。这些边关系名一律是「待确认关系」，等用户在图谱上改成业务关系或删除。 */
export function structureRelations(model, tables, alignments = []) {
  const known = new Set((tables || []).map(t => (typeof t === 'string' ? t : t.table)));
  const out = [];
  const seen = new Set();
  const push = (subject, object, via, basis) => {
    if (!known.has(subject) || !known.has(object) || subject === object) return;
    const key = `${subject}|${object}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({
      id: 'r' + (out.length + 1) + '_' + sha(key).slice(0, 6),
      subject, object, predicate: '待确认关系',
      via: via ? [via] : [],
      cardinality: '', basis, origin: 'structure',
      status: 'candidate', confidence: 'low', sourceRefs: []
    });
  };
  for (const p of (model.objectProperties || [])) {
    const left = (p.sourceColumns || [])[0] || '', right = (p.refColumns || [])[0] || '';
    push(p.sourceTable, p.refTable, left ? `${p.sourceTable}.${left} → ${p.refTable}.${right}` : '', '来自表结构外键声明，业务语义待确认');
  }
  for (const a of (Array.isArray(alignments) ? alignments : [])) {
    const l = a.left || {}, r = a.right || {};
    if (!l.table || !r.table) continue;
    const via = `${l.tableLabel || l.table}.${l.column} ↔ ${r.tableLabel || r.table}.${r.column}`;
    const sample = Array.isArray(l.sample) && l.sample.length ? `，样本 ${l.sample.length} 行` : '';
    push(l.table, r.table, via, `来自跨表同名字段候选（${l.column}）${sample}；是否同一业务关系需确认`);
  }
  return out;
}

/** 一次整稿确认 + 局部批注：按批注一次性生成定稿版，附差异清单，不再产生 v3 */
export function finalizeUnderstanding(draft, { annotations = [], approval = {}, by = '工作台业务用户' } = {}) {
  if (!draft) throw Error('尚未生成理解稿');
  if (!approval.confirmed) throw Error('理解稿需要一次整稿确认');
  const final = JSON.parse(JSON.stringify(draft));
  final.version = 2;
  final.basedOn = draft.version;
  final.status = 'confirmed';
  final.approval = { confirmedBy: by, confirmedAt: new Date().toISOString(), scope: 'whole' };
  final.revisionLog = [];
  final.diffSummary = [];
  for (const a of (Array.isArray(annotations) ? annotations : [])) {
    const log = { id: uid('rev'), targetId: a.targetId || '', kind: a.kind || 'query', value: a.value ?? null, comment: a.comment || '', at: new Date().toISOString(), by };
    final.revisionLog.push(log);
    const applyToTable = t => {
      if (a.kind === 'changeMeaning' && a.value != null) { const before = t.meaning; t.meaning = String(a.value); return `业务含义：「${before}」→「${t.meaning}」`; }
      if (a.kind === 'changeRole' && ROLE_IDS.has(a.value)) { const before = t.role; t.role = a.value; return `角色：${before} → ${t.role}`; }
      if (a.kind === 'changeStage' && a.value != null) { const before = t.stage; t.stage = String(a.value); return `链路阶段：「${before}」→「${t.stage}」`; }
      if (a.kind === 'changeLogic' && a.value != null) { t.logic = String(a.value); return '业务逻辑已按批注更新'; }
      return null;
    };
    let changed = null;
    /* 关系批注：图谱确认环节的「保留 / 删除 / 改名 / 反向 / 新增」 */
    const rels = final.relations || (final.relations = []);
    const rel = rels.find(x => x.id === a.targetId);
    const relLabel = r => `「${r.subject} ${r.predicate} ${r.object}」`;
    if (a.kind === 'confirmRelation' && rel) { rel.status = 'confirmed'; changed = `关系保留：${relLabel(rel)}`; }
    if (a.kind === 'rejectRelation' && rel) { rel.status = 'rejected'; changed = `关系删除：${relLabel(rel)}`; }
    if (a.kind === 'renameRelation' && rel && a.value) {
      const before = rel.predicate;
      rel.predicate = String(a.value).trim().slice(0, PREDICATE_MAX) || before;
      rel.vague = isGenericPredicate(rel.predicate);
      changed = `关系名：「${before}」→「${rel.predicate}」`;
    }
    if (a.kind === 'describeRelation' && rel && a.value !== undefined) {
      const before = rel.meaning || '（空）';
      rel.meaning = String(a.value || '').trim().slice(0, 240);
      changed = `关系业务含义：「${before.slice(0, 20)}」→「${(rel.meaning || '（清空）').slice(0, 30)}」`;
    }
    if (a.kind === 'reverseRelation' && rel) {
      [rel.subject, rel.object] = [rel.object, rel.subject];
      changed = `关系方向已反转：${relLabel(rel)}`;
    }
    if (a.kind === 'addRelation' && a.value) {
      /* 格式：主语|关系名|宾语 或 主语|关系名|宾语|业务含义（人工补边时可带一句话含义） */
      const [subject, predicate, object, meaning] = String(a.value).split('|').map(x => (x || '').trim());
      const known = new Set(final.tables.map(t => t.table));
      if (known.has(subject) && known.has(object) && predicate && subject !== object) {
        const key = `${subject}|${predicate}|${object}`;
        rels.push({
          id: 'r' + (rels.length + 1) + '_' + sha(key).slice(0, 6),
          subject, object, predicate: predicate.slice(0, PREDICATE_MAX), via: [],
          meaning: String(meaning || '').slice(0, 240),
          vague: isGenericPredicate(predicate),
          cardinality: '', basis: `由 ${by} 在定稿时补充`, origin: 'human',
          status: 'confirmed', confidence: 'medium', sourceRefs: []
        });
        changed = `新增关系：${relLabel({ subject, predicate, object })}`;
      } else {
        changed = null;
      }
    }
    const table = final.tables.find(t => t.table === a.targetId || t.tableLabel === a.targetId);
    if (table) changed = applyToTable(table);
    if (a.kind === 'renameStage') {
      const st = final.stages.find(s => s.name === a.targetId);
      if (st && a.value != null) { const before = st.name; st.name = String(a.value); changed = `阶段名：「${before}」→「${st.name}」`; }
    }
    if (a.kind === 'addStage' && a.value) {
      final.stages.push({ order: final.stages.length + 1, name: String(a.value), events: [], tableRefs: [], sourceRefs: [] });
      changed = `补充链路阶段「${a.value}」`;
    }
    if (a.kind === 'removeStage') {
      const before = final.stages.length;
      final.stages = final.stages.filter(s => s.name !== a.targetId);
      changed = before !== final.stages.length ? `删除阶段「${a.targetId}」` : null;
    }
    if (a.kind === 'addGap' && a.value) {
      final.gaps.push({ subject: a.targetId || '', kind: 'source', note: String(a.value), sourceRefs: [] });
      changed = `登记缺口：${String(a.value).slice(0, 60)}`;
    }
    if (a.kind === 'query') {
      final.uncertainties.push({ subject: a.targetId || '', text: String(a.comment || a.value || '标记存疑'), sourceRefs: [] });
      changed = `标记存疑：${a.targetId || ''}`;
    }
    final.diffSummary.push({ targetId: a.targetId || '', kind: a.kind || 'query', result: changed || '已记录批注，未改动正文', handled: !!changed || a.kind === 'query' });
  }
  final.stages = final.stages.map((s, i) => ({ ...s, order: i + 1 }));
  /* 整稿确认 = 认可整张稿子：已给业务名的关系默认保留；
     仍叫「待确认关系」的一律视为未确认，不进本体（避免把字段映射噪音写进 OWL） */
  for (const r of (final.relations || [])) {
    if (r.status === 'candidate' && r.predicate !== '待确认关系') { r.status = 'confirmed'; r.autoConfirmed = true; }
  }
  /* 统计必须放在自动采纳之后，否则 confirmed 会与真实进本体条数不一致 */
  const rels = final.relations || [];
  final.relationStats = {
    total: rels.length,
    confirmed: rels.filter(r => r.status === 'confirmed').length,
    rejected: rels.filter(r => r.status === 'rejected').length,
    pending: rels.filter(r => r.status === 'candidate').length,
    autoConfirmed: rels.filter(r => r.autoConfirmed).length,
    unconfirmed: rels.filter(r => r.status === 'candidate').length
  };
  final.fingerprint = sha({ tables: final.tables, stages: final.stages, relations: final.relations, revisionLog: final.revisionLog }).slice(0, 12);
  return { draft, final, summary: { version: final.version, annotations: final.revisionLog.length, handled: final.diffSummary.filter(x => x.handled).length, fingerprint: final.fingerprint } };
}

/** 定稿后把业务含义、角色、阶段、依赖回写进规范模型与台账，让后续 OWL / 图谱带上业务语义 */
export function applyUnderstandingToProject(p) {
  const u = p.understandingFinal;
  if (!u || !p.canonical) return 0;
  let n = 0;
  const byTable = new Map(u.tables.map(t => [t.table, t]));
  for (const c of p.canonical.classes) {
    const t = byTable.get(c.sourceTable);
    if (!t) continue;
    c.role = t.role;
    c.businessMeaning = t.meaning;
    c.businessStage = t.stage || '';
    c.description = [t.meaning, t.logic].filter(Boolean).join(' · ').slice(0, 400) || c.description;
    c.status = 'confirmed';
    n++;
  }
  p.canonical.businessStages = u.stages;
  p.canonical.understandingVersion = u.version;
  /* 业务关系落进规范模型：confirmed 的关系成为对象属性，名字用业务动词；
     被删除的移除；未确认的留作候选但不参与编译。 */
  const clsByTable = new Map(p.canonical.classes.map(c => [c.sourceTable, c]));
  const rels = Array.isArray(u.relations) ? u.relations : [];
  let relApplied = 0;
  const keptTables = new Set();
  for (const r of rels) {
    if (r.status !== 'confirmed') continue;
    const from = clsByTable.get(r.subject), to = clsByTable.get(r.object);
    if (!from || !to) continue;
    keptTables.add(`${r.subject}|${r.object}`);
    const exists = p.canonical.objectProperties.find(x => x.sourceTable === r.subject && x.refTable === r.object);
    if (exists) {
      exists.localName = r.predicate;
      exists.businessPredicate = r.predicate;
      exists.cardinality = r.cardinality || exists.cardinality || null;
      exists.relationBasis = r.basis || '';
      /* 业务含义进 description → OWL 的 rdfs:comment；另存一份 relationMeaning 供注释与图谱详情用 */
      exists.relationMeaning = r.meaning || '';
      exists.description = r.meaning || exists.description || '';
      exists.relationVia = r.via || [];
      exists.relationId = r.id;
      exists.origin = r.origin === 'human' ? 'human' : 'understanding';
      exists.status = 'confirmed';
    } else {
      const pid = 'rel_' + (p.canonical.objectProperties.filter(x => String(x.id).startsWith('rel_')).length + 1);
      p.canonical.objectProperties.push({
        id: pid, iri: p.canonical.namespace + encodeURIComponent(pid),
        localName: r.predicate, businessPredicate: r.predicate,
        domain: from.iri, range: to.iri,
        sourceTable: r.subject, sourceColumns: [], refTable: r.object, refColumns: [],
        relationVia: r.via || [], relationBasis: r.basis || '', relationId: r.id,
        relationMeaning: r.meaning || '', description: r.meaning || '',
        characteristics: [], cardinality: r.cardinality || null,
        origin: r.origin === 'human' ? 'human' : 'understanding', status: 'confirmed'
      });
    }
    relApplied++;
  }
  const rejectedKeys = new Set(rels.filter(r => r.status === 'rejected').map(r => `${r.subject}|${r.object}`));
  p.canonical.objectProperties = p.canonical.objectProperties.filter(op => {
    const key = `${op.sourceTable}|${op.refTable}`;
    if (rejectedKeys.has(key)) return false;
    if (!keptTables.has(key) && op.status !== 'confirmed') { op.status = 'candidate'; }
    return true;
  });
  p.canonical.relationSource = { origin: '业务理解稿', confirmed: relApplied, total: rels.length };
  /* 关系是定稿后才补进来的，stats 还是解析时算的旧值（objectProperties 一直是 0）。
     这里重算一次，界面与导出看到的条数才和规范模型一致。 */
  p.canonical.stats = {
    ...(p.canonical.stats || {}),
    classes: p.canonical.classes.length,
    dataProperties: p.canonical.dataProperties.length,
    objectProperties: p.canonical.objectProperties.length
  };
  if (p.semantics) {
    p.semantics.understanding = { version: u.version, origin: u.origin, fingerprint: u.fingerprint, stages: u.stages.length, tables: u.tables.length };
    const known = new Set((p.semantics.establishedMappings || []).map(e => `${e.left.table}|${e.right.table}`));
    for (const d of u.idDependencies || []) {
      const key = `${d.from}|${d.to}`;
      if (known.has(key)) continue;
      p.semantics.establishedMappings.push({
        id: uid('idest'), left: { table: d.from, column: (d.fields || [])[0] || '', sample: [] },
        right: { table: d.to, column: (d.fields || [])[0] || '', sample: [] },
        origin: '业务理解稿', overlap: 0, status: 'candidate'
      });
      known.add(key);
    }
  }
  return n;
}
