/* 领域无关的规则层：不认识任何业务表名、字段名或案例结论。
   规则由用户在图谱上定义（路径 DAG + 条件树），本模块只负责编译与解释执行。
   纪律：不预置任何规则；结论固定「待核查线索」，不代表违规认定；
        每条命中带可回溯证据链与三层版本号；SQL 由中间算子按方言渲染。 */
import { sha, uid } from './store.mjs';

const OUTCOME_LABEL = {
  NO_HIT: '未命中', HIT: '待核查线索', VALID_EXCEPTION: '有效例外', INSUFFICIENT: '资料不足'
};
const OPS = {
  eq: (a, b) => a === b, neq: (a, b) => a !== b,
  lt: (a, b) => a < b, lte: (a, b) => a <= b, gt: (a, b) => a > b, gte: (a, b) => a >= b,
  in: (a, b) => (Array.isArray(b) ? b : [b]).includes(a),
  contains: (a, b) => String(a).includes(String(b))
};
const DIALECTS = ['ansi', 'mysql', 'postgresql'];

/* ---------- 编译：条件树 → 可读表达式 / 结构约束草图 / 图查询 / 多方言 SQL ---------- */

function quoteId(name, dialect) {
  const s = String(name || '').replace(/[^\w\u4e00-\u9fa5]/g, '_');
  return dialect === 'mysql' ? '`' + s + '`' : '"' + s + '"';
}
function sqlLiteral(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  return "'" + String(v).replace(/'/g, "''") + "'";
}
function condWhere(c, dialect) {
  const l = c.left?.table ? `${quoteId(c.left.table, dialect)}.${quoteId(c.left.field, dialect)}` : quoteId(c.left?.field, dialect);
  const r = c.right?.literal !== undefined ? sqlLiteral(c.right.literal)
    : c.right?.table ? `${quoteId(c.right.table, dialect)}.${quoteId(c.right.field, dialect)}` : sqlLiteral(c.right?.value);
  const map = { eq: '=', neq: '<>', lt: '<', lte: '<=', gt: '>', gte: '>=', in: 'IN', contains: 'LIKE' };
  const op = map[c.operator] || '=';
  if (op === 'LIKE') return `${l} LIKE '%' || ${r} || '%'`;
  if (op === 'IN') return `${l} IN (${Array.isArray(c.right?.literal) ? c.right.literal.map(sqlLiteral).join(', ') : r})`;
  return `${l} ${op} ${r}`;
}

export function compileSql(rule, dialect = 'ansi') {
  const d = DIALECTS.includes(dialect) ? dialect : 'ansi';
  const nodes = rule.path?.nodes || [];
  const edges = rule.path?.edges || [];
  const conds = rule.conditions || [];
  const lines = ['-- ' + String(rule.name || rule.id || '规则') + ' · ' + d.toUpperCase()];
  const tables = nodes.length ? nodes.map(n => quoteId(n.table || n.id, d)) : [];
  lines.push('SELECT ' + (tables[0] ? tables[0] + '.*' : '1') + (tables.length ? '\nFROM ' + tables.join('\n  JOIN ') : ''));
  const joins = edges.filter(e => e.viaFields?.length).map(e => {
    const from = quoteId(e.from, d), to = quoteId(e.to, d);
    return e.viaFields.map(f => `${from}.${quoteId(f, d)} = ${to}.${quoteId(f, d)}`).join(' AND ');
  });
  if (joins.length) lines.push('  ON ' + joins.join('\n  AND '));
  const aggregates = (rule.path?.aggregates || []).map(a => `${String(a.op || 'SUM').toUpperCase()}(${quoteId(a.field, d)})`);
  if (aggregates.length) lines.push('-- 聚合：' + aggregates.join(', ') + (rule.path.aggregates[0].groupBy?.length ? ' GROUP BY ' + rule.path.aggregates[0].groupBy.map(x => quoteId(x, d)).join(', ') : ''));
  if (conds.length) lines.push('WHERE ' + conds.map(c => condWhere(c, d)).join('\n  AND '));
  lines.push('-- 输出语义：命中表示待核查线索，不代表违规认定');
  return lines.join('\n');
}

export function compileRule(rule) {
  const conds = rule.conditions || [];
  const dsl = conds.length
    ? conds.map((c, i) => `${i + 1}. ${c.left?.table || ''}.${c.left?.field || ''} ${c.operator || 'eq'} ${c.right?.literal !== undefined ? c.right.literal : (c.right?.table || '') + '.' + (c.right?.field || '')}${c.note ? '（' + c.note + '）' : ''}`).join('\n')
    : '（尚未定义条件）';
  const pathText = (rule.path?.nodes || []).map(n => n.table || n.id).join(' → ') || '（尚未定义路径）';
  const shacl = [
    '@prefix sh: <http://www.w3.org/ns/shacl#> .',
    '# 结构约束草图：只覆盖必填与类型，跨对象判断见 SQL / 表达式树',
    `omw:Shape_${String(rule.id || 'rule').replace(/[^\w]/g, '_')} a sh:NodeShape ;`,
    ...conds.filter(c => c.left?.field).map(c => `  sh:property [ sh:path omw:${c.left.field} ; sh:minCount 1 ; sh:message "${c.left.field}不可缺失"@zh ] ;`),
    '  .'
  ].join('\n');
  const sparql = [
    '# 图查询草图（平台无关）',
    'SELECT ?anchor WHERE {',
    ...(rule.path?.edges || []).map((e, i) => `  ?n${i} omw:${(e.viaFields || ['link'])[0]} ?n${i + 1} .`),
    ...conds.map(c => `  FILTER(?${c.operator || 'eq'}Fn(${c.left?.field || 'a'}, ${c.right?.literal !== undefined ? sqlLiteral(c.right.literal) : c.right?.field || 'b'}))`),
    '}'
  ].join('\n');
  const sql = Object.fromEntries(DIALECTS.map(d => [d, compileSql(rule, d)]));
  return {
    dsl, shacl, sparql, sql, pathText,
    disclaimer: '平台无关编译草图；本工作台只做导出前自检，真实执行在外部规则引擎。'
  };
}

/* ---------- 通用解释器：按路径连接 + 条件判定，产出证据链 ---------- */

const cell = (table, rowId, field, value) => ({ table, rowId, field, value: value === undefined || value === null ? null : String(value) });
const ev = (step, node, left, right, operator, result, locator) => ({ step, node, left, right, operator, result, locator: locator || {} });
const T = s => {
  const v = String(s ?? '');
  const t = Date.parse(v.length === 10 ? v + 'T00:00:00+08:00' : v);
  return Number.isNaN(t) ? null : t;
};

function resolvePairs(model, path) {
  const rows = model.rowsByTable || {};
  const nodes = path?.nodes || [];
  const edges = path?.edges || [];
  if (!nodes.length) return [];
  const anchor = nodes[0];
  let pairs = (rows[anchor.table] || []).map(r => ({ [anchor.alias || anchor.id || anchor.table]: r }));
  for (const e of edges) {
    const fromAlias = e.from, toNode = nodes.find(n => (n.alias || n.id || n.table) === e.to || n.table === e.to);
    if (!toNode) continue;
    const key = (e.viaFields || [])[0];
    const next = [];
    for (const p of pairs) {
      const leftRow = p[fromAlias];
      if (!leftRow) continue;
      const wanted = key ? String(leftRow[key] ?? '') : '';
      const matches = (rows[toNode.table] || []).filter(r => !key || String(r[key] ?? '') === wanted);
      for (const r of (matches.length ? matches : [null])) next.push({ ...p, [toNode.alias || toNode.id || toNode.table]: r });
    }
    pairs = next;
  }
  return pairs;
}

function evaluateCondition(c, pair, nodes) {
  const pick = side => {
    if (!side) return { table: '', rowId: '', field: '', value: null };
    if (side.literal !== undefined) return { table: '字面量', rowId: '', field: 'literal', value: side.literal };
    const alias = side.table;
    const node = (nodes || []).find(n => n.table === alias || n.alias === alias || n.id === alias);
    const key = node ? (node.alias || node.id || node.table) : alias;
    const row = pair[key] || pair[alias] || null;
    const field = side.field || '';
    return { table: alias || '', rowId: row ? String(row[Object.keys(row)[0]] ?? '') : '', field, value: row ? row[field] ?? null : null };
  };
  const l = pick(c.left), r = pick(c.right);
  if (l.value === null || r.value === null) return { l, r, result: 'INSUFFICIENT', detail: '必要字段缺失或关联不唯一，列为资料不足' };
  const numeric = /^(lt|lte|gt|gte)$/.test(c.operator);
  const a = numeric ? (T(l.value) ?? Number(l.value)) : String(l.value);
  const b = numeric ? (T(r.value) ?? Number(r.value)) : String(r.value);
  const fn = OPS[c.operator] || OPS.eq;
  let ok;
  try { ok = !!fn(a, b); } catch { return { l, r, result: 'INSUFFICIENT', detail: '运算不适用（类型或精度不匹配）' }; }
  return { l, r, result: ok ? 'PASS' : 'FAIL', detail: `${String(l.value)} ${c.operator} ${String(r.value)} → ${ok ? '成立' : '不成立'}` };
}

export function runRules(model, rules, { versions = {}, snapshotId = null, expected = [] } = {}) {
  const v = {
    ontology: versions.ontology || '未编译', ledger: versions.ledger || '未确认',
    baseline: versions.baseline || '草案', rules: versions.rules || 'v1'
  };
  const sid = snapshotId || (model.rowsByTable ? Object.values(model.rowsByTable)[0]?.[0]?.dataset_snapshot_id : null) || 'SNAPSHOT-UNKNOWN';
  const hits = [];
  for (const rule of (rules || []).filter(r => r.enabled !== false && r.status === 'published')) {
    const pairs = resolvePairs(model, rule.path || { nodes: [], edges: [] });
    for (const pair of pairs) {
      const chain = [];
      let outcome = 'HIT', reason = '';
      for (const [i, c] of (rule.conditions || []).entries()) {
        const res = evaluateCondition(c, pair, rule.path?.nodes || []);
        chain.push(ev(i + 1, c.kind || c.operator || 'condition',
          cell(res.l.table, res.l.rowId, res.l.field, res.l.value),
          cell(res.r.table, res.r.rowId, res.r.field, res.r.value), c.operator || 'eq', res.detail,
          { material: c.source?.materialId || '用户上传材料', table: res.l.table, rowId: res.l.rowId, source: c.source?.rawText || '' }));
        if (res.result === 'INSUFFICIENT') { outcome = 'INSUFFICIENT'; reason = res.detail; break; }
        if (res.result === 'PASS') { outcome = 'NO_HIT'; reason = '条件未触发'; break; }
      }
      hits.push({
        id: uid('hit'), ruleId: rule.id, ruleVersion: rule.version, at: new Date().toISOString(),
        snapshotId: sid, versions: v,
        anchor: { table: (rule.path?.nodes || [])[0]?.table || '', rowId: String(Object.values(pair)[0]?.[Object.keys(Object.values(pair)[0] || {})[0]] ?? '') },
        outcome, outcomeLabel: OUTCOME_LABEL[outcome] || outcome, reasonCode: outcome, reason,
        evidenceChain: chain,
        conclusionNote: '命中表示待核查线索，不代表违规认定',
        humanReview: { status: 'pending', reviewer: null, comment: null, at: null }
      });
    }
  }
  const comparison = (expected || []).map(e => {
    const h = hits.find(x => String(x.anchor.rowId) === String(e.anchor || e.id || e.key));
    return { key: String(e.anchor || e.id || e.key), expected: e.outcome || e.status, actual: h?.outcome || null, match: !!h && h.outcome === (e.outcome || e.status) };
  });
  return {
    runId: uid('run'), at: new Date().toISOString(), snapshotId: sid, versions: v, hits,
    summary: {
      total: hits.length, HIT: hits.filter(h => h.outcome === 'HIT').length,
      NO_HIT: hits.filter(h => h.outcome === 'NO_HIT').length,
      VALID_EXCEPTION: hits.filter(h => h.outcome === 'VALID_EXCEPTION').length,
      INSUFFICIENT: hits.filter(h => h.outcome === 'INSUFFICIENT').length,
      evidenceSteps: hits.reduce((n, h) => n + h.evidenceChain.length, 0)
    },
    expectedComparison: {
      total: comparison.length, matched: comparison.filter(x => x.match).length, rows: comparison,
      note: comparison.length ? '与用户上传的测试用例逐笔比对；未提供用例时不比对。' : '本次未提供预期结果，不比对。'
    },
    note: '结论固定为「待核查线索」，不代表违规认定；真实业务数据在外部规则引擎执行。'
  };
}

export function publishRules(rules, blocked) {
  if (blocked?.length) throw new RulesBlocked(blocked);
  for (const r of rules) { r.status = 'published'; r.publishedAt = new Date().toISOString(); }
  return { published: rules.length, at: new Date().toISOString() };
}
export class RulesBlocked extends Error {
  constructor(blocked) { super('存在未裁决的台账确认项或流程差异，规则不得发布'); this.blocked = blocked; this.code = 409; }
}

/* 第 7 点决策：推送接口契约（本批只定义，不实现具体引擎对接） */
export const RulePackageSink = {
  name: 'RulePackageSink',
  capabilities: { auth: true, idempotency: true, versionCheck: true, receipt: true },
  defaultImplementation: 'FileSystemSink',
  push: async () => { throw Error('未配置目标规则引擎；当前仅提供文件导出'); },
  idempotencyKey: pkg => sha({ fingerprint: pkg?.manifest?.fingerprint, target: pkg?.target }).slice(0, 16)
};
export function buildRulePackage(project, rules) {
  const manifest = {
    format: 'omw.rule-package/1.0', at: new Date().toISOString(),
    sqlDialect: 'ansi', availableDialects: DIALECTS,
    versions: {
      understanding: project.processState?.version || 0,
      ledger: project.semantics?.version || 0,
      ontology: project.owlJson?.versionIRI || null
    },
    materials: (project.materials || []).map(m => ({ name: m.name, sha256: m.sha256 })),
    conclusionPolicy: '命中表示待核查线索，不代表违规认定'
  };
  return {
    'rule.json': JSON.stringify(rules, null, 2),
    ...Object.fromEntries(DIALECTS.map(d => [`rule.${d}.sql`, rules.map(r => compileSql(r, d)).join('\n\n')])),
    'manifest.json': JSON.stringify(manifest, null, 2),
    'test-cases.json': JSON.stringify(project.referenceResults || [], null, 2)
  };
}
