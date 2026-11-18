/* 领域无关的流程基线：只按字段形态发现事件与时间锚点，只按材料原文抽时序约束。
   不认识任何业务表名、字段名或行业流程；不按常识补「标准流程」。
   差异只上报不自行择一；理解建议标低置信度并注明「系统理解，不是事实认定」。 */
import { uid } from './store.mjs';

const TIME_HINT = /(time|date|_at|_from|_to|日期|时间|时点)/i;
const STATE_HINT = /(status|state|result|outcome|状态|结果)/i;
const PRECISION_HINT = /(precision|precision_|精度|粒度)/i;
const ORDER_HINT = /(早于|晚于|先于|之后|之前|不得超过|不晚于|不早于|≥|≤|>|<)/;

function discoverEvents(model) {
  const byTable = new Map(model.classes.map(c => [c.sourceTable, c]));
  const fields = model.dataProperties || [];
  const events = [];
  for (const [table, cls] of byTable) {
    const own = fields.filter(p => p.sourceTable === table);
    const time = own.find(p => TIME_HINT.test(p.sourceColumn || '') || /^(date|dateTime|time)$/i.test(p.range?.split('#').pop() || ''));
    const precision = own.find(p => PRECISION_HINT.test(p.sourceColumn || '') || PRECISION_HINT.test(p.localName || ''));
    const state = own.find(p => STATE_HINT.test(p.sourceColumn || '') || STATE_HINT.test(p.localName || ''));
    if (!time) continue;
    events.push({
      id: uid('evt'), name: cls.localName, table, tableLabel: cls.localName,
      timeField: time.sourceColumn || time.localName,
      precisionField: precision ? (precision.sourceColumn || precision.localName) : null,
      statusField: state ? (state.sourceColumn || state.localName) : null,
      origin: '按字段形态自动发现的时间锚点'
    });
  }
  return events;
}

function extractOrderStatements(statements) {
  return (statements || []).filter(s => ORDER_HINT.test(String(s.text || ''))).map(s => ({
    id: uid('bc'), text: String(s.text).slice(0, 300), kind: s.kind || '业务规则线索',
    source: { locator: s.locator || '', sourceName: s.sourceName || '用户材料', segmentId: s.segmentId || '', text: String(s.text).slice(0, 220) },
    status: 'draft', confidence: 'medium', origin: '材料原文'
  }));
}

/** 只有当用户确认了「哪两个事件的哪个时间字段要比较」时才观测差异；不猜、不预置 */
function observeDifferences(model, orderRules) {
  const rows = model.rowsByTable || {};
  const out = [];
  for (const rule of orderRules) {
    if (!rule.left || !rule.right || !rule.operator) continue;
    const leftRows = rows[rule.left.table] || [], rightRows = rows[rule.right.table] || [];
    const join = rule.joinFields || [];
    for (const l of leftRows) {
      const candidates = rightRows.filter(r => join.every(f => String(l[f] ?? '') === String(r[f] ?? '')));
      if (candidates.length !== 1) continue;
      const r = candidates[0];
      const lv = l[rule.left.field], rv = r[rule.right.field];
      const lt = Date.parse(String(lv ?? '')), rt = Date.parse(String(rv ?? ''));
      const precisionField = rule.precisionField;
      const coarse = precisionField && /^(DATE|DAY|日)$/i.test(String(l[precisionField] ?? ''));
      const undetermined = coarse || Number.isNaN(lt) || Number.isNaN(rt) || String(lv).length <= 10 || String(rv).length <= 10;
      const expectedOrder = /早于|先于|不晚于|之前|<|≤/.test(rule.operator + ' ' + rule.text) ? '前者早于后者' : '前者晚于后者';
      const violated = !undetermined && (expectedOrder === '前者早于后者' ? lt > rt : lt < rt);
      if (!undetermined && !violated) continue;
      const evidence = [
        { table: rule.left.table, rowId: String(Object.values(l)[0] ?? ''), field: rule.left.field, value: lv },
        { table: rule.right.table, rowId: String(Object.values(r)[0] ?? ''), field: rule.right.field, value: rv }
      ];
      const basis = [
        `${rule.left.table}.${rule.left.field} = ${lv}`,
        `${rule.right.table}.${rule.right.field} = ${rv}`,
        `原文：${rule.source.text.slice(0, 110)}`
      ];
      const understanding = undetermined
        ? '时间精度不足或无法解析，先后不可判定；按材料口径应列为资料不足，不落入相等/不等的二值结论。这是系统理解，不是事实认定。'
        : '观测到的时间顺序与基线要求不一致。系统理解为疑似补录、追认或口径差异，须由业务负责人确认；这是系统理解，不是事实认定。';
      out.push({
        id: uid('diff'), subject: String(Object.values(l)[0] ?? ''), kind: undetermined ? 'undetermined' : 'reversed',
        observed: { left: lv, right: rv }, expected: expectedOrder,
        evidence, basis, understanding, understandingConfidence: 'low',
        disclaimer: '系统理解，不是事实认定；请业务负责人选择处置方式',
        options: [
          { id: 'adopt', label: '采纳观测顺序', desc: '以材料观测到的顺序为准，生成流程基线新版本' },
          { id: 'keep', label: '维持基线', desc: '基线不变，该笔标记为异常线索' },
          { id: 'exception', label: '登记例外', desc: '允许该情形，但需填写适用条件、有效期与审批人' }
        ],
        blocking: true, status: 'pending', decision: null, decidedBy: null, decidedAt: null, comment: null
      });
    }
  }
  return out;
}

export function buildProcessState(model, statements = [], confirmedRules = []) {
  const events = discoverEvents(model);
  const raw = extractOrderStatements(statements);
  const constraints = [
    ...raw.map(r => ({ ...r, meaning: '按材料原文的时序或阈值口径执行' })),
    ...confirmedRules.map(r => ({ ...r, status: 'confirmed', confidence: 'high', origin: '用户确认' }))
  ];
  const differences = observeDifferences(model, confirmedRules);
  return {
    version: 1, status: confirmedRules.length ? 'confirmed' : 'draft', generatedAt: new Date().toISOString(),
    events, constraints, rawStatements: raw, differences,
    stats: {
      events: events.length, constraints: constraints.length, rawStatements: raw.length,
      differences: differences.length, pending: differences.filter(d => d.status === 'pending').length
    },
    note: '事件与时间锚点按字段形态自动发现；时序约束只来自材料原文或用户确认，不按常识补标准流程；未确认前不观测差异。'
  };
}

/** 用户在页面上确认一条时序约束后调用：补齐左右事件与字段，立即重算观测差异 */
export function addConfirmedOrder(state, model, rule) {
  const byTable = new Map(model.classes.map(c => [c.sourceTable, c]));
  const findField = (table, field) => (model.dataProperties || []).find(p => p.sourceTable === table && (p.sourceColumn === field || p.localName === field));
  if (!byTable.has(rule.left?.table) || !byTable.has(rule.right?.table) || !findField(rule.left.table, rule.left.field) || !findField(rule.right.table, rule.right.field))
    throw Error('时序约束的端点表或字段不在已上传材料中');
  const enriched = {
    id: uid('bc'), left: { table: rule.left.table, field: rule.left.field },
    right: { table: rule.right.table, field: rule.right.field },
    operator: rule.operator || '早于', joinFields: rule.joinFields || [],
    precisionField: rule.precisionField || null,
    text: String(rule.text || '用户确认的时序约束').slice(0, 300),
    source: { locator: rule.locator || '用户确认', sourceName: '用户', text: String(rule.text || '') },
    status: 'confirmed', confidence: 'high', origin: '用户确认'
  };
  state.confirmedRules = [...(state.confirmedRules || []), enriched];
  state.constraints = [...(state.constraints || []), enriched];
  state.differences = observeDifferences(model, state.confirmedRules);
  state.status = 'confirmed'; state.version += 1;
  state.stats.pending = pendingDifferences(state).length;
  state.stats.differences = state.differences.length;
  return state;
}

export function applyDifferenceDecisions(state, decisions = [], by = '工作台业务用户') {
  let changed = 0, baselineChanged = false;
  const now = new Date().toISOString();
  for (const d of decisions) {
    const item = (state.differences || []).find(x => x.id === d.id || x.subject === d.subject);
    if (!item || !['adopt', 'keep', 'exception'].includes(d.action)) continue;
    if (d.action === 'exception' && !(d.condition && d.validUntil && d.approver))
      throw Error(`差异 ${item.subject} 登记例外时必须填写适用条件、有效期与审批人`);
    item.decision = { action: d.action, condition: d.condition || null, validUntil: d.validUntil || null, approver: d.approver || null };
    item.status = 'resolved'; item.decidedBy = by; item.decidedAt = now; item.comment = d.comment || null;
    if (d.action === 'adopt') baselineChanged = true;
    changed++;
  }
  if (baselineChanged) state.version += 1;
  state.status = pendingDifferences(state).length ? 'draft' : 'confirmed';
  state.stats.pending = pendingDifferences(state).length;
  state.stats.resolved = (state.differences || []).filter(d => d.status === 'resolved').length;
  return { changed, baselineChanged, version: state.version, status: state.status };
}

export function pendingDifferences(state) {
  return (state?.differences || []).filter(d => d.status === 'pending' && d.blocking);
}
