/* 业务语义台账：业务描述 ↔ 表字段的覆盖矩阵、跨系统 ID 对齐、业务流串联、统一确认态。
   纪律：只从材料里抽词条，不按常识补业务概念；非精确落点一律标「疑似」；
        同名不同义收紧条件只告警不自动合并；确认前不固化，确认后写入规则库并留版本。 */
import { sha, uid } from './store.mjs';

const TERM_LINES = /^(案例对象|案例属性)[：:]\s*(.+)$/;
const RULE_LINES = /^(判断条件|有效例外|资料不足|校验)[：:]\s*(.+)$/;
const SPLIT = /[、，,；;。]/;
const ID_RE = /(^|_)(id|code|no|key|num)(_|$)|编号|代码|标识/i;
/* 通用技术键形态（租户 / 快照 / 批次 / 版本 / 日志 / 追踪），不列任何具体业务键名 */
const TECH_KEYS = /(tenant|snapshot|run|batch|version|release|trace|log|audit|request)_?(id|code|no|key)?$|^(row|seq|rownum|guid|uuid)$/i;
const BAD_TERM = /(不得|不能|必须|应当|应|允许|禁止|唯一|暂缺|显示|保存|不要求|不能只|不等于|未|无痕|绕过|替代)/;
/* 中文字段名 ↔ 英文列名的技术性对照表：只用于给「疑似落点」候选，不产生业务结论，也不写成已命中 */
const SEMANTIC_HINTS = [
  { re: /(时间|日期|时点|生效|失效|起点|终点)/, col: /(_at|date|time|valid_from|valid_to|_from|_to|effective)/i, score: 0.62 },
  { re: /(撤销|撤回)/, col: /(revocation|revoke|cancel)/i, score: 0.64 },
  { re: /(权限|核验|授权)/, col: /(authority|permission|check|verified)/i, score: 0.6 },
  { re: /(代码|编码|信用代码)/, col: /(code|_no)/i, score: 0.66 },
  { re: /(主体|对象|实体|参与方)/, col: /(subject|party|entity|object)/i, score: 0.6 },
  { re: /(组织|机构)/, col: /(org|organization)/i, score: 0.6 },
  { re: /(状态|结果)/, col: /(status|state|outcome|result)/i, score: 0.58 },
  { re: /(名称|显示名)/, col: /(name|label|title)/i, score: 0.58 },
  { re: /(证据|原文)/, col: /(evidence|source|doc)/i, score: 0.58 },
  { re: /(编号|ID|标识)/, col: /(_id|_code|_no)$/i, score: 0.58 }
];

const norm = s => String(s || '').replace(/[\s_\-（）()·、，,。；;：:"'“”‘’]/g, '').toLowerCase();
const ngrams = (s, n = 2) => {
  const t = norm(s), out = new Set();
  for (let i = 0; i + n <= t.length; i++) out.add(t.slice(i, i + n));
  return out;
};
const jaccard = (a, b) => {
  if (!a.size || !b.size) return 0;
  let hit = 0;
  for (const x of a) if (b.has(x)) hit++;
  return hit / (a.size + b.size - hit);
};

/** 词条只来自「案例对象 / 案例属性」这类结构化定义行；判断条件等整行留作业务规则原文 */
function extractMaterial(model, description) {
  const terms = [], statements = [];
  const pushTerm = (raw, sourceName, locator, sentence, contextObject = '') => {
    let t = String(raw || '').trim().replace(/^.{1,6}的/, '').replace(/[（(].*?[)）]/g, '').replace(/[“”"'‘’]/g, '').trim();
    if (t.length < 2 || t.length > 12 || BAD_TERM.test(t) || /\//.test(t) || /^[\dA-Za-z_\-.]+$/.test(t)) return;
    terms.push({ term: t, contextObject, sourceName, locator, sentence: String(sentence || '').slice(0, 220) });
  };
  for (const seg of model.processSegments || []) {
    for (const line of String(seg.text || '').split(/\r?\n/)) {
      const l = line.trim(), m = l.match(TERM_LINES), r = l.match(RULE_LINES);
      if (m) {
        // 「案例属性：合同的 A、B；供应商的 C」保留对象上下文，用于把疑似候选优先落到对应业务表
        for (const clause of m[2].split(/[；;]/)) {
          const cm = clause.trim().match(/^(.{1,8}?)的(.+)$/);
          const ctx = cm ? cm[1] : '', rest = cm ? cm[2] : clause;
          for (const part of rest.split(SPLIT)) pushTerm(part, seg.sourceName || '流程描述', seg.heading, l, ctx);
        }
      }
      if (r) statements.push({ id: uid('stmt'), kind: r[1], text: r[2].slice(0, 400), locator: seg.heading, sourceName: seg.sourceName || '流程描述', segmentId: seg.id });
      // 通用适配层登记的片段（工作簿说明行、伪公式降级等）也作为可引用原文收录
      if (seg.kind && !statements.some(s => s.text === seg.text)) statements.push({
        id: uid('stmt'), kind: seg.kind, text: String(seg.text || '').slice(0, 400),
        locator: seg.locator || seg.heading, sourceName: seg.sourceName || '材料', segmentId: seg.id
      });
    }
  }
  for (const part of String(description || '').split(/[、，,；;。\n]/)) pushTerm(part, '业务描述输入框', '业务描述', String(description || '').slice(0, 220));
  // 材料里没有结构化业务定义行时，用表字段名与表标签作为「材料明示」的词条来源，
  // 不做任何语义推断；让业务用户看到系统读到了哪些概念，并逐条确认业务含义。
  if (terms.length < 5) {
    const byTable = new Map((model.classes || []).map(c => [c.sourceTable, c.localName]));
    for (const p of (model.dataProperties || []).slice(0, 120)) {
      const label = String(p.localName || '').trim();
      if (label.length < 2 || label.length > 12) continue;
      terms.push({
        term: label, contextObject: byTable.get(p.sourceTable) || '',
        sourceName: '表结构字段名', locator: `${p.sourceTable}.${p.sourceColumn || ''}`,
        sentence: `字段：${label}${p.description ? ' · 说明：' + String(p.description).slice(0, 80) : ''}`,
        origin: 'field-name'
      });
    }
  }
  const map = new Map();
  for (const t of terms) {
    const key = norm(t.term);
    if (!map.has(key)) map.set(key, { ...t, count: 0, sources: [] });
    const e = map.get(key);
    e.count++;
    if (e.contextObject && !e.contextObjectList?.includes(e.contextObject)) (e.contextObjectList ||= []).push(e.contextObject);
    else if (t.contextObject && !e.contextObject) e.contextObject = t.contextObject;
    if (e.sources.length < 3) e.sources.push({ sourceName: t.sourceName, locator: t.locator, sentence: t.sentence });
  }
  return { terms: [...map.values()].sort((a, b) => b.count - a.count).slice(0, 40), statements };
}

function fieldIndex(model) {
  const tableBy = new Map(model.classes.map(c => [c.sourceTable, c]));
  return (model.dataProperties || []).map(p => ({
    table: p.sourceTable, tableLabel: tableBy.get(p.sourceTable)?.localName || p.sourceTable,
    column: p.sourceColumn || p.localName, label: p.localName, description: (p.description || p.localName || '').slice(0, 40),
    isKey: !!p.isKey
  }));
}

function matchTerm(term, index, classes, contextObject = '') {
  const tn = norm(term), tg = ngrams(term);
  const ctx = norm(contextObject);
  const inContext = f => !!ctx && (norm(f.tableLabel).includes(ctx) || ctx.includes(norm(f.tableLabel)) || norm(f.table).includes(ctx));
  const scored = [];
  // 对象级精确命中优先
  for (const c of classes) {
    const cn = norm(c.localName), exact = cn === tn;
    const sim = exact ? 1 : Math.max(jaccard(tg, ngrams(c.localName)), jaccard(tg, ngrams(c.description || '')) * 0.35);
    if (exact || sim >= 0.25) scored.push({
      table: c.sourceTable, tableLabel: c.localName, column: '（对象级）', label: c.localName,
      description: (c.description || '').slice(0, 60), score: exact ? 1 : Math.round(sim * 100) / 100, objectLevel: true
    });
  }
  for (const f of index) {
    const colN = norm(f.column), labN = norm(f.label), descN = norm(f.description);
    let score = 0;
    if (colN === tn || labN === tn || (descN.length <= 12 && descN === tn)) score = 1;
    else if (descN.length <= 14 && (descN.includes(tn) || tn.includes(descN))) score = 0.92;
    else score = Math.max(jaccard(tg, ngrams(f.label)) * 0.9, jaccard(tg, ngrams(f.description)) * 0.7, jaccard(tg, ngrams(f.column)) * 0.5);
    if (score >= 0.22) scored.push({ ...f, score: Math.round(Math.min(0.95, score + (inContext(f) ? 0.15 : 0)) * 100) / 100, objectLevel: false });
  }
  // 中文业务词 ↔ 英文列名：只取最贴切的一条对照规则，补「疑似」候选，不冒充已确认落点
  const hint = SEMANTIC_HINTS.find(h => h.re.test(term));
  if (hint) {
    const matches = index.filter(x => hint.col.test(x.column))
      .sort((a, b) => (inContext(b) ? 1 : 0) - (inContext(a) ? 1 : 0)
        || jaccard(tg, ngrams(b.description)) - jaccard(tg, ngrams(a.description))
        || a.column.length - b.column.length);
    for (const f of matches.slice(0, 4)) {
      if (scored.some(x => x.table === f.table && x.column === f.column)) continue;
      scored.push({ ...f, score: Math.round(Math.min(0.9, hint.score + (inContext(f) ? 0.24 : 0)) * 100) / 100, objectLevel: false, hint: '字段名对照表' });
    }
  }
  scored.sort((a, b) => b.score - a.score || (b.objectLevel ? 1 : 0) - (a.objectLevel ? 1 : 0));
  const top = scored.slice(0, 3);
  const level = top.some(x => x.score >= 0.98) ? 'matched' : top.length ? 'suspected' : 'missing';
  let gap = 'none';
  if (level === 'missing') {
    const related = classes.some(c => jaccard(tg, ngrams(c.localName)) >= 0.25);
    // 不做领域词判断：与已有对象相似 → 疑似补字段；短名词且与所有对象都不相似 → 疑似补表；其余 → 疑似补来源
    gap = related ? 'field' : (term.length >= 2 && term.length <= 6 ? 'table' : 'source');
  }
  return { level, gap, candidates: top.map(x => ({ table: x.table, tableLabel: x.tableLabel, column: x.column, label: x.label, score: x.score, objectLevel: !!x.objectLevel, hint: x.hint || null })) };
}

function valueProfile(rows, column) {
  const vals = (rows || []).map(r => String(r[column] ?? '')).filter(v => v && v !== 'null');
  const uniq = [...new Set(vals)];
  return { values: new Set(uniq), fmt: uniq.slice(0, 8).map(v => v.replace(/[A-Za-z]/g, 'A').replace(/\d/g, '9')).sort().join('|'), sample: uniq.slice(0, 4) };
}

/** ID 对齐：已建立映射（来自外键，带取值核验）与疑似候选（无外键、四类信号）分开呈现 */
function buildIdAlignments(model) {
  const rowsBy = model.rowsByTable || {};
  const established = [], fkPairs = new Set();
  for (const p of model.objectProperties || []) {
    if (!p.sourceTable || !p.refTable || !p.sourceColumns?.length) continue;
    // 复合外键里跳过技术快照键，展示真正承载业务含义的那一列
    const idx = Math.max(0, p.sourceColumns.findIndex(c => !TECH_KEYS.test(c)));
    const col = p.sourceColumns[idx] || p.sourceColumns[0];
    const refCol = p.refColumns?.[idx] || p.refColumns?.[0] || '';
    const a = valueProfile(rowsBy[p.sourceTable], col);
    const b = valueProfile(rowsBy[p.refTable], refCol);
    let inter = 0;
    for (const v of a.values) if (b.values.has(v)) inter++;
    established.push({
      id: uid('idest'), left: { table: p.sourceTable, column: col, sample: a.sample },
      right: { table: p.refTable, column: refCol, sample: b.sample }, origin: '表结构外键',
      overlap: b.values.size ? Math.round(inter / Math.min(a.values.size || 1, b.values.size) * 100) / 100 : 0,
      status: 'established'
    });
    p.sourceColumns.forEach((c, i) => {
      const r = p.refColumns?.[i] || '';
      fkPairs.add(`${p.sourceTable}.${c}|${p.refTable}.${r}`);
      fkPairs.add(`${p.refTable}.${r}|${p.sourceTable}.${c}`);
    });
  }
  const cols = [];
  const fkColumns = new Set([...fkPairs].map(k => k.split('|')[0]));
  for (const p of model.dataProperties || []) {
    const name = p.sourceColumn || p.localName;
    if (!ID_RE.test(name) || TECH_KEYS.test(name)) continue;
    const pf = valueProfile(rowsBy[p.sourceTable], name);
    if (!pf.values.size) continue;
    cols.push({ table: p.sourceTable, column: name, isKey: !!p.isKey, isFk: fkColumns.has(`${p.sourceTable}.${name}`), ...pf });
  }
  const candidates = [], warnings = [];
  for (let i = 0; i < cols.length; i++) for (let j = i + 1; j < cols.length; j++) {
    const a = cols[i], b = cols[j];
    if (a.table === b.table) continue;
    if (fkPairs.has(`${a.table}.${a.column}|${b.table}.${b.column}`)) continue;
    const an = norm(a.column).replace(/^(signing|awarded|from|to|actual|source|target|ref)/, '');
    const bn = norm(b.column).replace(/^(signing|awarded|from|to|actual|source|target|ref)/, '');
    const nameSim = an === bn ? 1 : an.includes(bn) || bn.includes(an) ? 0.8 : jaccard(ngrams(a.column), ngrams(b.column));
    if (nameSim < 0.45) continue;
    let inter = 0;
    for (const v of a.values) if (b.values.has(v)) inter++;
    const overlap = inter / Math.min(a.values.size, b.values.size);
    const fmtSame = a.fmt === b.fmt ? 1 : 0;
    const structure = a.isKey || b.isKey ? 1 : 0;
    if (nameSim >= 0.98 && overlap === 0 && !a.isFk && !b.isFk && a.values.size >= 3 && b.values.size >= 3 && a.fmt !== b.fmt) {
      warnings.push({ id: uid('warn'), left: { table: a.table, column: a.column }, right: { table: b.table, column: b.column }, reason: '命名相同、取值域完全不重叠且格式不同，疑似同名不同义，禁止自动合并' });
      continue;
    }
    const score = Math.round((nameSim * 0.4 + overlap * 0.4 + fmtSame * 0.1 + structure * 0.1) * 100) / 100;
    if (score < 0.6 || overlap === 0) continue;
    candidates.push({
      id: uid('idmap'), left: { table: a.table, column: a.column, sample: a.sample },
      right: { table: b.table, column: b.column, sample: b.sample },
      signals: [
        { kind: '命名同义', value: a.column + ' / ' + b.column, score: Math.round(nameSim * 100) / 100 },
        { kind: '样例取值重叠', value: `${inter} 个共同取值 / 较小集合 ${Math.min(a.values.size, b.values.size)} 个`, score: Math.round(overlap * 100) / 100 },
        { kind: '取值格式', value: fmtSame ? '一致' : '不一致', score: fmtSame },
        { kind: '主键结构', value: structure ? '至少一侧为主键' : '均非主键', score: structure }
      ],
      score, confidence: score >= 0.8 ? 'high' : score >= 0.68 ? 'medium' : 'low',
      note: '本批材料未含来源系统标识，按材料文件归属；候选仅为疑似，需业务用户确认后固化。'
    });
  }
  candidates.sort((x, y) => y.score - x.score);
  return { established, candidates: candidates.slice(0, 20), sameNameWarnings: warnings.slice(0, 8) };
}

/** 基于已建立映射，从核心业务对象出发串出可达的业务链路 */
function buildBusinessFlow(model, established) {
  const adj = new Map();
  for (const e of established) {
    if (!adj.has(e.left.table)) adj.set(e.left.table, []);
    if (!adj.has(e.right.table)) adj.set(e.right.table, []);
    adj.get(e.left.table).push({ to: e.right.table, via: e.left.column });
    adj.get(e.right.table).push({ to: e.left.table, via: e.right.column });
  }
  // 起点按结构特征选：字段最多且带主键的类；不预设任何业务表名
  const start = [...(model.classes || [])].sort((a, b) => {
    const fa = (model.dataProperties || []).filter(p => p.sourceTable === a.sourceTable).length;
    const fb = (model.dataProperties || []).filter(p => p.sourceTable === b.sourceTable).length;
    return (fb + (b.primaryKey?.length ? 1 : 0)) - (fa + (a.primaryKey?.length ? 1 : 0));
  })[0]?.sourceTable || model.classes[0]?.sourceTable;
  const byTable = new Map(model.classes.map(c => [c.sourceTable, c.localName]));
  const seen = new Set([start]), queue = [{ table: start, depth: 0, path: [byTable.get(start) || start], via: '' }], steps = [];
  while (queue.length) {
    const cur = queue.shift();
    steps.push({ table: cur.table, label: byTable.get(cur.table) || cur.table, depth: cur.depth, via: cur.via, path: cur.path.join(' → ') });
    if (cur.depth >= 3) continue;
    for (const n of adj.get(cur.table) || []) {
      if (seen.has(n.to)) continue;
      seen.add(n.to);
      queue.push({ table: n.to, depth: cur.depth + 1, path: [...cur.path, byTable.get(n.to) || n.to], via: n.via });
    }
  }
  return { start, steps };
}

export function buildSemantics(model, description = '', workbook = {}) {
  const { terms: rawTerms, statements } = extractMaterial(model, description);
  const index = fieldIndex(model);
  const terms = rawTerms.map(t => {
    const m = matchTerm(t.term, index, model.classes, t.contextObject);
    return {
      id: uid('term'), term: t.term, contextObject: t.contextObject || '', count: t.count, level: m.level, gap: m.gap,
      candidates: m.candidates, sources: t.sources,
      gapLabel: { none: '已有精确落点', field: '疑似该补字段', table: '疑似该补表', source: '疑似该补来源' }[m.gap],
      confidence: m.level === 'matched' ? 'high' : m.level === 'suspected' ? 'medium' : 'low'
    };
  });
  const align = buildIdAlignments(model);
  // 工作簿探测到的跨表同名键：转成统一的疑似对齐候选，全部标为待确认
  const fromWorkbook = (workbook.idCandidates || []).map(c => ({
    id: c.id,
    left: { table: c.left.table, column: c.column, field: c.left.field, sample: [], tableLabel: c.left.tableLabel },
    right: { table: c.right.table, column: c.column, field: c.right.field, sample: [], tableLabel: c.right.tableLabel },
    signals: [
      { kind: '跨表同名字段', value: c.column, score: 1 },
      { kind: '样例取值重叠', value: `重叠 ${c.overlap} / 样本 ${c.sampleSize} 行`, score: c.overlap },
      { kind: '样本量', value: c.sampleSize < 3 ? '样例行不足 3 行，置信度低' : '样本充足', score: c.sampleSize < 3 ? 0 : 1 }
    ],
    score: c.overlap, confidence: c.confidence, note: c.note, origin: 'workbook'
  }));
  align.candidates = [...fromWorkbook, ...align.candidates].slice(0, 40);
  align.sameNameWarnings = [...(workbook.sameNameWarnings || []).map(w => ({
    id: w.id, left: { table: w.left.table, column: w.column }, right: { table: w.right.table, column: w.column }, reason: w.reason
  })), ...align.sameNameWarnings].slice(0, 12);
  const flow = buildBusinessFlow(model, align.established);
  const confirmations = [];
  for (const t of terms) confirmations.push({
    id: uid('cfm'), category: 'term-mapping', refId: t.id, subject: t.term,
    detail: t.level === 'matched' ? `精确落点：${t.candidates[0]?.tableLabel}` :
      t.level === 'suspected' ? `疑似落点：${t.candidates.slice(0, 2).map(c => c.tableLabel + (c.objectLevel ? '' : '.' + c.column)).join('、')}` : `未找到落点 · ${t.gapLabel}`,
    confidence: t.confidence, blocking: t.level !== 'matched',
    status: 'pending', decidedBy: null, decidedAt: null, comment: null, version: 1
  });
  for (const a of align.candidates) confirmations.push({
    id: uid('cfm'), category: 'id-alignment', refId: a.id,
    subject: `${a.left.table}.${a.left.column} ↔ ${a.right.table}.${a.right.column}`,
    detail: `综合得分 ${a.score} · 取值重叠 ${a.signals[1].score}`,
    confidence: a.confidence, blocking: true,
    status: 'pending', decidedBy: null, decidedAt: null, comment: null, version: 1
  });
  return {
    version: 1, generatedAt: new Date().toISOString(), mode: 'deterministic',
    terms, statements, idAlignments: align.candidates, establishedMappings: align.established,
    sameNameWarnings: align.sameNameWarnings, businessFlow: flow, confirmations,
    stats: {
      terms: terms.length, matched: terms.filter(t => t.level === 'matched').length,
      suspected: terms.filter(t => t.level === 'suspected').length, missing: terms.filter(t => t.level === 'missing').length,
      gaps: { field: terms.filter(t => t.gap === 'field').length, table: terms.filter(t => t.gap === 'table').length, source: terms.filter(t => t.gap === 'source').length },
      statements: statements.length, established: align.established.length,
      idCandidates: align.candidates.length, sameNameWarnings: align.sameNameWarnings.length,
      flowSteps: flow.steps.length,
      pending: confirmations.filter(c => c.status === 'pending').length,
      blocking: confirmations.filter(c => c.status === 'pending' && c.blocking).length
    },
    note: '词条来自业务描述的「案例对象／案例属性」结构化定义行，判断条件等整句保留为业务规则原文。非精确落点一律标疑似；同名不同义只告警不自动合并；未用常识补全业务概念。'
  };
}

/** 页面勾选：逐条留确认人、时间与意见；驳回与需补材料同样留痕 */
export function applyConfirmations(semantics, decisions = [], by = '工作台业务用户') {
  let changed = 0;
  const now = new Date().toISOString();
  for (const d of decisions) {
    const c = (semantics.confirmations || []).find(x => x.id === d.id || x.refId === d.refId);
    if (!c || !['confirm', 'reject', 'need-material', 'defer'].includes(d.action)) continue;
    c.status = { confirm: 'confirmed', reject: 'rejected', 'need-material': 'need-material', defer: 'pending' }[d.action];
    c.decidedBy = by; c.decidedAt = now; c.comment = d.comment || null;
    c.version = (c.version || 1) + 1;
    if (d.action === 'confirm' && d.choice) c.choice = d.choice;
    changed++;
  }
  semantics.version = (semantics.version || 1) + (changed ? 1 : 0);
  semantics.stats.pending = semantics.confirmations.filter(c => c.status === 'pending').length;
  semantics.stats.blocking = semantics.confirmations.filter(c => c.status === 'pending' && c.blocking).length;
  semantics.stats.confirmed = semantics.confirmations.filter(c => c.status === 'confirmed').length;
  semantics.stats.rejected = semantics.confirmations.filter(c => c.status === 'rejected').length;
  return { changed, stats: semantics.stats };
}

/** 固化：只把已确认的落点与对齐写进规则库，重跑不重算 */
export function confirmedRuleBase(semantics) {
  const byRef = new Map((semantics.confirmations || []).map(c => [c.refId, c]));
  return {
    version: semantics.version,
    termMappings: (semantics.terms || []).filter(t => byRef.get(t.id)?.status === 'confirmed').map(t => ({
      term: t.term, level: t.level, gap: t.gap, target: byRef.get(t.id).choice || t.candidates[0] || null, sources: t.sources
    })),
    idMappings: (semantics.idAlignments || []).filter(a => byRef.get(a.id)?.status === 'confirmed').map(a => ({
      left: a.left, right: a.right, score: a.score, signals: a.signals
    })),
    fingerprint: sha({ version: semantics.version, confirmed: (semantics.confirmations || []).filter(c => c.status === 'confirmed').map(c => c.refId) }).slice(0, 12)
  };
}

export function blockingConfirmations(semantics) {
  return (semantics?.confirmations || []).filter(c => c.status === 'pending' && c.blocking);
}
