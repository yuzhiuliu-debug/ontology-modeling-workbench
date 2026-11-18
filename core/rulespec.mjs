/* 规则设立：客户文档 + 图谱口径 → 业务审查规则 → 可交给外部规则引擎执行的 SQL。
   纪律：模型只输出「规则语义」（范围、连接、判定条件），SQL 一律由本模块确定性编译；
        本平台不执行规则，只产规则与 SQL；命中语义固定为「待核查线索」，不是违规认定。 */
import { sha } from './store.mjs';

const DIALECTS = ['ansi', 'mysql', 'postgresql'];
const SEVERITY = ['high', 'medium', 'low'];
const OPS = {
  eq: '=', neq: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=', isNull: 'IS NULL', notNull: 'IS NOT NULL'
};

const q = (name, d) => {
  const s = String(name || '').replace(/[^\w\u4e00-\u9fa5]/g, '_');
  return d === 'mysql' ? '`' + s + '`' : '"' + s + '"';
};
const sqlLiteral = v => {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  return "'" + String(v).replace(/'/g, "''") + "'";
};

export const RULE_CONTRACT = {
  rules: [{
    name: '规则名（业务语言，8–16 字，如「付款一致性审查」）',
    intent: '这条规则在查什么（不超过 30 字，不要复述文档原文）',
    severity: 'high|medium|low',
    basis: '文档里的依据定位（不超过 50 字，如「付款管理办法 第 12 条」；推断得出的写「推断」）',
    scope: [{ table: '业务对象对应的源表名（必须来自图谱）', alias: '别名，可自定（如 p / r / i），joins 与 checks 里必须用同一个别名' }],
    joins: [{ from: '别名', to: '别名', type: 'inner|left', on: [{ left: '源表字段', right: '目标表字段' }] }],
    checks: [
      { kind: 'compare', left: { alias: '别名', field: '字段' }, op: 'eq|neq|gt|gte|lt|lte|isNull|notNull', right: { alias: '别名', field: '字段' }, message: '违反时的业务说法（不超过 30 字）' },
      { kind: 'compare', left: { alias: '别名', field: '字段' }, op: 'gt', right: { literal: 0 }, message: '违反时的业务说法' },
      { kind: 'sumCompare', left: { alias: '别名', field: '字段', groupBy: '分组字段' }, op: 'neq', right: { alias: '别名', field: '字段' }, message: '违反时的业务说法' },
      { kind: 'duplicate', alias: '别名', fields: ['字段'], message: '违反时的业务说法' }
    ]
  }]
};

export const RULE_RULES = [
  '只输出规定的 JSON；不得输出 SQL、OWL、Turtle 或任何代码，SQL 由确定性代码编译。',
  'scope.table 只能取「图谱口径」里出现的业务对象源表名，不得编造表或字段。',
  'scope.alias 由你自定，但 joins 与 checks 里的 from / to / alias 必须用同一个别名；两边不要混用表名。',
  '字段必须能落到图谱里已存在的字段；落不到就不要写这条检查，改写入 uncertainties 说明缺什么。',
  '每条规则的 checks 表达「什么情况算违规」：条件成立即命中，由外部规则引擎执行后人工核查。',
  '金额、数量、批次、物料号这类一致性审查优先用 compare / sumCompare；缺少关联记录用 left join + isNull。',
  '规则名与 message 用业务语言（如「发票金额与验收金额不一致」），不要写字段名堆砌。',
  'intent / basis / message 都要短：intent ≤ 30 字、basis ≤ 50 字、message ≤ 30 字，不要复述文档原文，不要解释怎么写 SQL。',
  '不得预置行业结论：材料没写的口径不要自己补，推断出来的必须在 basis 里标明「推断」。',
  '文档里存在相互冲突的口径时，分别出规则并写入 uncertainties 上报，禁止静默择一。'
].join('\n');

/* 把「表.字段」解析成真实列名：模型可能给中文标签，也可能给物理列名 */
function fieldIndex(model) {
  const byTable = new Map();
  for (const c of (model.classes || [])) {
    const cols = new Map();
    for (const p of (model.dataProperties || [])) {
      if (p.sourceTable !== c.sourceTable) continue;
      const col = p.sourceColumn || p.localName;
      cols.set(String(col).toLowerCase(), { name: col, label: p.localName || col });
      cols.set(String(p.localName || '').toLowerCase(), { name: col, label: p.localName || col });
    }
    byTable.set(c.sourceTable, cols);
  }
  return byTable;
}

/** 服务端强校验 + 规范化：越界的表/字段一律丢弃并记警告，SQL 绝不带进模型给的原文。
 *  别名尊重模型自己的写法（p / r / i 都行），只要能在 scope 里唯一落到一张表。 */
export function validateRuleSpecs(raw, model) {
  const warnings = [];
  const idx = fieldIndex(model);
  const tables = new Set((model.classes || []).map(c => c.sourceTable));
  const list = Array.isArray(raw?.rules) ? raw.rules : (Array.isArray(raw) ? raw : []);
  if (/SELECT\s+[\s\S]*\s+FROM\s|@prefix\s+\w+:|<Ontology[\s>]/i.test(JSON.stringify(raw || {}))) {
    throw Error('模型返回里夹带了 SQL / OWL 原文，已拒绝：SQL 只能由确定性代码编译');
  }

  const out = [];
  list.forEach((r, ri) => {
    if (!r || typeof r !== 'object') return;
    const tag = `rules[${ri}]`;

    /* 1. 范围：只认图谱里有的业务对象；别名沿用模型的，冲突才改成 tN */
    const scope = [];
    const used = new Set();
    for (const s of (Array.isArray(r.scope) ? r.scope : [])) {
      const table = String(s?.table || '').trim();
      if (!tables.has(table)) { warnings.push(`${tag} 引用了图谱里没有的业务对象「${table}」，已丢弃该规则`); return; }
      if (scope.some(x => x.table === table)) continue;
      let alias = String(s?.alias || '').trim().replace(/[^\w\u4e00-\u9fa5]/g, '');
      if (!alias || used.has(alias)) alias = 't' + (scope.length + 1);
      while (used.has(alias)) alias += '_';
      used.add(alias);
      scope.push({ table, alias });
    }
    if (!scope.length) { warnings.push(`${tag} 缺少有效范围，已丢弃`); return; }

    const aliasOfTable = new Map(scope.map(s => [s.table, s.alias]));
    const tableOfAlias = new Map(scope.map(s => [s.alias, s.table]));
    const toAlias = v => {
      const t = String(v || '').trim();
      if (tableOfAlias.has(t)) return t;
      if (aliasOfTable.has(t)) return aliasOfTable.get(t);
      return null;
    };
    const col = (aliasRaw, field) => {
      const alias = toAlias(aliasRaw) || scope[0].alias;
      const table = tableOfAlias.get(alias);
      const hit = (idx.get(table) || new Map()).get(String(field || '').toLowerCase());
      if (!hit) { warnings.push(`${tag} 字段「${table}.${field}」在图谱里找不到，已跳过该判定`); return null; }
      return { alias, table, column: hit.name, label: hit.label };
    };

    /* 2. 连接 */
    const joins = [];
    for (const j of (Array.isArray(r.joins) ? r.joins : [])) {
      const from = toAlias(j?.from), to = toAlias(j?.to);
      if (!from || !to || from === to) { warnings.push(`${tag} 的连接「${j?.from} → ${j?.to}」无法落到范围里的表，已忽略`); continue; }
      const on = (Array.isArray(j.on) ? j.on : []).map(c => ({ left: col(from, c?.left), right: col(to, c?.right) }))
        .filter(c => c.left && c.right);
      if (!on.length) { warnings.push(`${tag} 的连接缺少可用关联字段，已忽略`); continue; }
      joins.push({ from, to, type: j.type === 'left' ? 'left' : 'inner', on });
    }

    /* 3. 判定条件 */
    const checks = [];
    for (const c of (Array.isArray(r.checks) ? r.checks : [])) {
      const check = normalizeCheck(c, scope, col, warnings, tag);
      if (check) checks.push(check);
    }
    if (!checks.length) { warnings.push(`${tag}「${String(r.name || '').slice(0, 30)}」没有可判定的检查条件，已丢弃`); return; }

    out.push({
      id: 'rs_' + sha(`${r.name}|${JSON.stringify(scope)}|${JSON.stringify(checks)}`).slice(0, 8),
      name: String(r.name || '未命名审查规则').slice(0, 80),
      intent: String(r.intent || '').slice(0, 300),
      severity: SEVERITY.includes(r.severity) ? r.severity : 'medium',
      basis: String(r.basis || '').slice(0, 400),
      scope, joins, checks,
      note: '条件成立即命中，命中结果为待核查线索，不代表违规认定。'
    });
  });
  if (!out.length) warnings.push('模型没有给出可落地的规则；请补充文档条款，或在文档里写清涉及哪些业务对象与字段');
  return { rules: out, warnings };
}

function normalizeCheck(c, scope, col, warnings, tag) {
  const kind = ['compare', 'sumCompare', 'duplicate'].includes(c?.kind) ? c.kind : 'compare';
  const msg = String(c?.message || '').slice(0, 200);
  /* 口径漂移提示：金额与数量是两种东西，模型混着比必须显式提示，不静默放过 */
  const MONEY = /金额|价|费用|amount|price|money|amt/i;
  const QTY = /数量|件数|个数|体积|qty|quantity|\bnum\b/i;
  const skew = (a, b) => {
    const A = `${a.label || ''} ${a.column || ''}`, B = `${b.label || ''} ${b.column || ''}`;
    return (MONEY.test(A) && QTY.test(B)) || (QTY.test(A) && MONEY.test(B));
  };
  if (kind === 'duplicate') {
    const alias = c?.alias ? (scope.find(x => x.alias === c.alias || x.table === c.alias)?.alias || scope[0].alias) : scope[0].alias;
    const fields = (Array.isArray(c?.fields) ? c.fields : []).map(f => col(alias, f)).filter(Boolean);
    if (!fields.length) return null;
    return { kind, alias, fields, message: msg || `${fields.map(f => f.label).join('、')} 重复` };
  }
  const left = c?.left?.field ? col(c.left.alias, c.left.field) : null;
  if (!left) return null;
  const op = Object.keys(OPS).includes(c?.op) ? c.op : 'neq';
  if (kind === 'sumCompare') {
    const right = c?.right?.field ? col(c.right.alias, c.right.field) : null;
    if (!right) return null;
    if (skew(left, right)) warnings.push(`${tag} 把金额和数量放在一起比：${left.table}.${left.label} ↔ ${right.table}.${right.label}，请确认口径（${msg.slice(0, 40)}）`);
    return {
      kind, op, left, right, message: msg || `${left.label}合计与${right.label}合计不一致`,
      groupByLeft: c?.left?.groupBy ? col(left.alias, c.left.groupBy) : null,
      groupByRight: c?.right?.groupBy ? col(right.alias, c.right.groupBy) : (c?.left?.groupBy ? col(left.alias, c.left.groupBy) : null)
    };
  }
  let right = null;
  if (c?.right?.field) right = col(c.right.alias, c.right.field);
  else if (c?.right?.literal !== undefined) right = { literal: c.right.literal };
  else if (c?.right?.value !== undefined) right = { literal: c.right.value };
  if (!right && op !== 'isNull' && op !== 'notNull') return null;
  if (right && skew(left, right)) warnings.push(`${tag} 把金额和数量放在一起比：${left.table}.${left.label} ↔ ${right.table}.${right.label}，请确认口径（${msg.slice(0, 40)}）`);
  return { kind, op, left, right, message: msg || `${left.label}未通过一致性判定` };
}

/* 把已确认的图谱压成模型能吃的口径：业务对象、字段（物理列名 + 业务名）、业务关系 */
export function graphDigest(model, understanding) {
  const rels = (understanding?.relations || []).filter(r => r.status !== 'rejected');
  return {
    tables: (model.classes || []).map(c => ({
      table: c.sourceTable, label: c.localName, role: c.role || '',
      meaning: c.businessMeaning || c.description || '',
      fields: (model.dataProperties || []).filter(p => p.sourceTable === c.sourceTable)
        .map(p => ({
          column: p.sourceColumn || p.localName,
          label: p.localName || p.sourceColumn,
          type: String(p.range || '').split('#').pop()
        }))
    })),
    relations: rels.map(r => ({ subject: r.subject, predicate: r.predicate, object: r.object, via: r.via || [] }))
  };
}

/* ---------------- 确定性 SQL 编译 ---------------- */

const colOf = (alias, resolved, d) => `${alias}.${q(resolved.column, d)}`;

function whereOf(check, d) {
  if (check.kind === 'compare') {
    const l = colOf(check.left.alias, check.left, d);
    if (check.op === 'isNull') return `${l} IS NULL`;
    if (check.op === 'notNull') return `${l} IS NOT NULL`;
    const r = check.right?.literal !== undefined ? sqlLiteral(check.right.literal) : colOf(check.right.alias, check.right, d);
    return `${l} ${OPS[check.op] || '='} ${r}`;
  }
  return '';
}

export function compileRuleSql(rule, dialect = 'ansi') {
  const d = DIALECTS.includes(dialect) ? dialect : 'ansi';
  const lines = [];
  lines.push('-- 规则：' + rule.name + (rule.severity ? `　严重级：${rule.severity}` : ''));
  if (rule.intent) lines.push('-- 意图：' + rule.intent.replace(/\n/g, ' '));
  if (rule.basis) lines.push('-- 依据：' + rule.basis.replace(/\n/g, ' '));
  lines.push('-- 语义：下列条件成立即命中；命中结果为待核查线索，不代表违规认定');
  lines.push('-- 方言：' + d.toUpperCase());
  lines.push('');

  if (rule.checks.length === 1 && rule.checks[0].kind === 'duplicate') {
    const c = rule.checks[0];
    const s = rule.scope.find(x => x.alias === c.alias) || rule.scope[0];
    lines.push('SELECT');
    c.fields.forEach(f => lines.push(`  ${colOf(s.alias, f, d)},`));
    lines.push('  COUNT(*) AS ' + q('重复条数', d));
    lines.push(`FROM ${q(s.table, d)} ${s.alias}`);
    lines.push('GROUP BY ' + c.fields.map(f => colOf(s.alias, f, d)).join(', '));
    lines.push('HAVING COUNT(*) > 1;');
    lines.push('');
    lines.push('-- 命中说明：' + c.message);
    return lines.join('\n');
  }

  if (rule.checks.length === 1 && rule.checks[0].kind === 'sumCompare') {
    const c = rule.checks[0];
    const leftTable = rule.scope.find(x => x.alias === c.left.alias)?.table || '';
    const rightTable = rule.scope.find(x => x.alias === c.right.alias)?.table || '';
    const keyL = c.groupByLeft?.column || 'AREA_KEY';
    const keyR = c.groupByRight?.column || keyL;
    lines.push(`WITH a AS (SELECT ${q(keyL, d)} AS ${q('比对键', d)}, SUM(${q(c.left.column, d)}) AS ${q('左合计', d)}`);
    lines.push(`           FROM ${q(leftTable, d)} GROUP BY ${q(keyL, d)}),`);
    lines.push(`     b AS (SELECT ${q(keyR, d)} AS ${q('比对键', d)}, SUM(${q(c.right.column, d)}) AS ${q('右合计', d)}`);
    lines.push(`           FROM ${q(rightTable, d)} GROUP BY ${q(keyR, d)}),`);
    lines.push(`     k AS (SELECT ${q('比对键', d)} FROM a UNION SELECT ${q('比对键', d)} FROM b)`);
    lines.push('SELECT');
    lines.push(`  k.${q('比对键', d)} AS ${q('比对键', d)},`);
    lines.push(`  a.${q('左合计', d)} AS ${q(leftTable + '_' + c.left.label, d)},`);
    lines.push(`  b.${q('右合计', d)} AS ${q(rightTable + '_' + c.right.label, d)}`);
    lines.push(`FROM k LEFT JOIN a ON a.${q('比对键', d)} = k.${q('比对键', d)}`);
    lines.push(`       LEFT JOIN b ON b.${q('比对键', d)} = k.${q('比对键', d)}`);
    lines.push(`WHERE COALESCE(a.${q('左合计', d)}, 0) ${OPS[c.op] || '<>'} COALESCE(b.${q('右合计', d)}, 0)`);
    lines.push(';');
    lines.push('-- 命中说明：' + c.message);
    return lines.join('\n');
  }

  /* 多条件 compare：同一组范围与连接，条件按 OR 展开（任一成立即命中） */
  const head = rule.scope[0];
  lines.push('SELECT');
  lines.push('  ' + rule.scope.map(s => s.alias + '.*').join(',\n  '));
  lines.push(`FROM ${q(head.table, d)} ${head.alias}`);
  for (const j of rule.joins) {
    const target = rule.scope.find(s => s.alias === j.to);
    if (!target) continue;
    const on = j.on.map(c => `${j.from}.${q(c.left.column, d)} = ${j.to}.${q(c.right.column, d)}`).join('\n     AND ');
    lines.push(`  ${j.type === 'left' ? 'LEFT JOIN' : 'INNER JOIN'} ${q(target.table, d)} ${j.to} ON ${on}`);
  }
  const conds = rule.checks.filter(c => c.kind === 'compare').map(c => ({ sql: whereOf(c, d), msg: c.message }));
  if (!conds.length) { lines.push('WHERE 1 = 0;'); return lines.join('\n'); }
  lines.push('WHERE (');
  conds.forEach((c, i) => lines.push(`  ${c.sql}${i === conds.length - 1 ? '' : ' OR '}   -- ${c.msg}`));
  lines.push(');');
  lines.push('');
  lines.push('-- 命中说明：' + conds.map(c => c.msg).join('；'));
  return lines.join('\n');
}

export function compileRuleSpecs(rules, dialect = 'ansi') {
  return rules.map(r => ({ ...r, sql: compileRuleSql(r, dialect) }));
}

export function ruleSqlBundle(rules, project) {
  const header = [
    '-- 业务审查规则 SQL 包',
    '-- 项目：' + (project?.name || ''),
    `-- 生成时间：${new Date().toISOString()}`,
    '-- 说明：本文件由本体建模工作台确定性编译，交给外部规则引擎执行；本平台不执行规则。',
    '-- 每条规则的条件成立即命中，命中结果为待核查线索，不代表违规认定。',
    '-- 规则数：' + rules.length,
    ''
  ].join('\n');
  return header + '\n' + rules.map(r => r.sql).join('\n\n');
}
