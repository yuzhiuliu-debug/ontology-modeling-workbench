/* 第 6 步：真实单据数据 → 实例（ABox）。
   输入是客户手工上传的 CSV / xlsx（一表一文件，多 sheet 也行，文件名或 sheet 名对上表名）。
   产出：关系落地（业务关系 → 真实字段连接）、个体与断言、四类完整性检查、独立的 ABox OWL 文件。

   纪律：
   - 只把数据如实变成实例，问题只报不修（不静默去重、不自动补父子关系）；
   - 平台的职责到「出实例与报告」为止，规则判定交给外部规则引擎；
   - 关联字段：先按理解稿里声明过的列，没声明就用「列名 + 实际取值重合度」推断，
     推不出来就明写「没落地」，绝不硬连一条假边。 */
import path from 'node:path';
import { uid } from './store.mjs';
import { prepareSources, guessType, parseMaterial } from './ingest.mjs';
import { buildIndividuals } from './owl.mjs';

const norm = s => String(s ?? '').trim().toLowerCase().replace(/[\s_\-（）()]/g, '');

/** 表名对不上就换几个说法再试：解析出来的表名可能是生成的编号，label 是文件名或 sheet 名；
    中文业务名也认（客户常按业务名给文件命名，单据照片转出来的 CSV 也用业务名）。 */
function matchTable(model, parsedTable, stem) {
  const known = new Map();
  for (const c of model.classes || []) {
    if (!known.has(norm(c.sourceTable))) known.set(norm(c.sourceTable), c);
    if (c.localName && !known.has(norm(c.localName))) known.set(norm(c.localName), c);
  }
  for (const cand of [parsedTable.name, parsedTable.label, stem]) {
    const c = known.get(norm(cand));
    if (c) return c;
  }
  return null;
}

/** 列名解析：CSV / Excel 解析出来的字段名是生成的编号，表里写的列名在 label 上；
    规范模型里的字段名在 sourceColumn，业务名在 localName。两套都要认。 */
function resolveColumns(model, table, parsedTable) {
  const fields = (model.dataProperties || []).filter(p => p.sourceTable === table);
  const bySource = new Map(fields.map(p => [norm(p.sourceColumn), p]));
  const byName = new Map();
  for (const p of fields) {
    if (p.localName) byName.set(norm(p.localName), p);
    if (p.description) byName.set(norm(p.description), p);
  }
  const map = [];
  for (const pf of parsedTable.fields || []) {
    const cands = [pf.name, pf.label].filter(Boolean);
    let hit = cands.map(norm).map(c => bySource.get(c)).find(Boolean);
    if (!hit) hit = cands.map(norm).map(c => byName.get(c)).find(Boolean);
    if (hit) map.push({ from: pf.name, to: hit.sourceColumn, label: pf.label || pf.name });
    else map.push({ from: pf.name, to: null, label: pf.label || pf.name });
  }
  return map;
}

/** 把上传文件解析成 { 表名: 行[] }；对不上规范模型的表名单独列出来，不硬塞 */
export async function loadInstanceFiles({ files = [], model, sampleDir }) {
  const specs = (files || []).map(f => ({
    name: f.name, content: String(f.content ?? ''), encoding: f.encoding,
    type: f.type || guessType(f.name)
  }));
  const sources = await prepareSources(specs, sampleDir);
  const rowsByTable = {};
  const files2 = [];
  const unmatched = [];
  for (const src of sources) {
    let parsed;
    try { parsed = parseMaterial(src); }
    catch (e) { unmatched.push({ file: src.name, table: '', reason: e.message }); files2.push({ name: src.name, tables: [], rows: 0 }); continue; }
    const stem = src.name.replace(/\.[^.]+$/, '');
    const hit = [];
    for (const t of parsed.tables || []) {
      const cls = matchTable(model, t, stem);
      if (!cls) { unmatched.push({ file: src.name, table: t.label || t.name, reason: '规范模型里没有这张表' }); continue; }
      const cols = resolveColumns(model, cls.sourceTable, t);
      const mapped = cols.filter(c => c.to);
      if (!mapped.length) {
        unmatched.push({ file: src.name, table: cls.sourceTable, reason: '表对上了，但没有一列能对上字段名' });
        continue;
      }
      const rows = (t.rows || []).map(row => {
        const out = {};
        for (const c of mapped) if (row[c.from] !== undefined) out[c.to] = row[c.from];
        return out;
      });
      rowsByTable[cls.sourceTable] = (rowsByTable[cls.sourceTable] || []).concat(rows);
      hit.push({
        table: cls.sourceTable, label: cls.localName, rows: rows.length,
        extraColumns: cols.filter(c => !c.to).map(c => c.label)
      });
    }
    files2.push({ name: src.name, type: src.type, bytes: src.bytes, tables: hit.map(h => h.table), rows: hit.reduce((n, h) => n + h.rows, 0) });
  }
  const total = Object.values(rowsByTable).reduce((n, rows) => n + rows.length, 0);
  return { rowsByTable, files: files2, unmatched, stats: { tables: Object.keys(rowsByTable).length, rows: total, files: files2.length } };
}

const keyOf = (row, keys) => (keys || []).map(k => String(row?.[k] ?? '')).join('|');
const cell = v => (v == null ? '' : String(v).trim());

/* ---------------- 关系落地：业务关系 → 真实字段连接 ----------------
   理解稿里确认的关系只说了「订单 按合同下达 合同」，没说用哪个字段连。
   这里按三层把它落到字段上：
     ① 理解稿 / 表结构里已经写明的字段对（relationVia、sourceColumns），拿数据复核覆盖度；
     ② 没写明就逐列对比：列名像不像（合同号 ≈ 合同编号）+ 实际取值重合度；
     ③ 都不行就明写「没落地」，绝不硬连一条假边。
   只认「值是同一批」的列对，名称对不上时要求值几乎全命中，避免把金额、名称连起来。 */
const KEY_SUFFIX = /(编号|号码|代码|编码|单号|号|码|id|no|code|key)$/i;
const KEYISH = /(号|编号|代码|编码|id|no|code|key|标识)/i;
const baseName = s => String(s ?? '').trim().toLowerCase()
  .replace(/[\s_\-·.、/\\()（）【】\[\]]/g, '').replace(KEY_SUFFIX, '');
const val = v => String(v ?? '').trim();

/** 每张表每一列出现过哪些值（空值不算），用于算重合度 */
function profileColumns(rows) {
  const sets = new Map();
  for (const r of rows) {
    for (const [k, v] of Object.entries(r)) {
      const s = val(v);
      if (!s) continue;
      if (!sets.has(k)) sets.set(k, new Set());
      sets.get(k).add(s);
    }
  }
  return sets;
}

/** 表的列清单：把内部列名换成业务名，业务用户才看得懂 */
function columnsOf(model, table, rows) {
  const label = new Map();
  for (const p of model.dataProperties || []) {
    if (p.sourceTable === table) label.set(p.sourceColumn, p.localName || p.sourceColumn);
  }
  const seen = new Set();
  for (const r of rows.slice(0, 200)) for (const k of Object.keys(r)) seen.add(k);
  return [...seen].map(col => ({ col, label: label.get(col) || col }));
}

/** 关系依据里的字段映射写过好几种说法：`订单.合同编号`、`表A.列 ↔ 表B.列`、`t2.f1 → t1.f0`。
    统一抽成 {表, 列} 对，后面按表名归到源端还是目标端。 */
function parseViaHints(via) {
  const out = [];
  for (const item of Array.isArray(via) ? via : []) {
    const s = String(item ?? '');
    const re = /([^\s,，;；、↔→]+)[.．]([^\s,，;；、↔→]+)/g;
    let m;
    while ((m = re.exec(s))) out.push({ table: m[1].trim(), column: m[2].trim() });
  }
  return out;
}

/** 列名可能写成内部标识、业务名或简称，三种都认 */
function matchColumn(list, name) {
  const n = norm(name);
  if (!n) return null;
  const hit = (list || []).find(c => norm(c.col) === n) || (list || []).find(c => norm(c.label) === n);
  return hit ? hit.col : null;
}

export function resolveRelations(model, rowsByTable) {
  const prof = {}, cols = {};
  for (const [t, rows] of Object.entries(rowsByTable || {})) { prof[t] = profileColumns(rows); cols[t] = columnsOf(model, t, rows); }
  const clsByTable = new Map((model.classes || []).map(c => [c.sourceTable, c]));
  const pkOf = t => (clsByTable.get(t)?.primaryKey || []);
  const labelOf = t => clsByTable.get(t)?.localName || t;
  const tableByName = new Map();
  for (const [t, c] of clsByTable) { tableByName.set(norm(t), t); if (c.localName) tableByName.set(norm(c.localName), t); }

  /** 一列在另一张表里的取值覆盖度：source 侧有多少值能在 ref 侧找到 */
  const cover = (ta, ca, tb, cb) => {
    const av = prof[ta]?.get(ca), bv = prof[tb]?.get(cb);
    if (!av?.size || !bv?.size) return null;
    let hit = 0;
    for (const v of av) if (bv.has(v)) hit++;
    return { av, bv, coverage: hit / av.size, hit };
  };
  const labelIn = (t, col) => (cols[t] || []).find(c => c.col === col)?.label || col;

  const CARDS = { 'N:1': '多对一', '1:N': '一对多', '1:1': '一对一', 'N:M': '多对多' };
  const out = [];
  for (const p of model.objectProperties || []) {
    if (p.status === 'candidate' || p.status === 'rejected') continue;
    if (!p.sourceTable || !p.refTable) continue;
    const base = {
      id: p.id, iri: p.iri, relation: p.localName,
      sourceTable: p.sourceTable, refTable: p.refTable,
      sourceLabel: labelOf(p.sourceTable), refLabel: labelOf(p.refTable)
    };
    const sRows = rowsByTable[p.sourceTable] || [], rRows = rowsByTable[p.refTable] || [];
    if (!sRows.length || !rRows.length) {
      out.push({ ...base, origin: 'unresolved', reason: '有一端的表没装载到数据，这条关系在实例层连不起来' });
      continue;
    }

    const tried = [];
    let picked = null;

    /* ① 理解稿里写过的字段映射（AI 或解析器给的列对） */
    const pairs = [];
    for (const h of parseViaHints(p.relationVia)) {
      const t = tableByName.get(norm(h.table));
      if (t !== p.sourceTable && t !== p.refTable) continue;
      const col = matchColumn(cols[t], h.column);
      if (!col) continue;
      pairs.push({ side: t === p.sourceTable ? 'source' : 'ref', col });
    }
    const a0 = pairs.find(x => x.side === 'source')?.col;
    const b0 = pairs.find(x => x.side === 'ref')?.col;
    if (a0 && b0) {
      const m = cover(p.sourceTable, a0, p.refTable, b0);
      /* 声明过的列对门槛放低到「至少有一条对上」：连法是人/AI 明说的，
         对不上的行是数据问题，交给完整性检查去报（悬空 / 空外键），不能反过来否定这条关系。 */
      if (m && m.coverage > 0) {
        picked = { a: { col: a0, label: labelIn(p.sourceTable, a0) }, b: { col: b0, label: labelIn(p.refTable, b0) },
          ...m, nameScore: 1, origin: 'declared', declaredBy: '理解稿字段映射' };
      } else {
        tried.push(`理解稿里写的 ${a0} → ${b0} 在数据上一条都对不上`);
      }
    }

    /* ② 表结构里的外键（DDL 直接声明过的） */
    if (!picked && p.sourceColumns?.length && p.refColumns?.length) {
      const a1 = p.sourceColumns[0], b1 = p.refColumns[0];
      const m = cover(p.sourceTable, a1, p.refTable, b1);
      if (m && m.coverage > 0) {
        picked = { a: { col: a1, label: labelIn(p.sourceTable, a1) }, b: { col: b1, label: labelIn(p.refTable, b1) },
          ...m, nameScore: 1, origin: 'declared', declaredBy: '表结构外键' };
      } else if (m) {
        tried.push(`表结构声明的主外键与数据一条都对不上`);
      }
    }

    /* ③ 按列名 + 取值重合度推断 */
    if (!picked) {
      let best = null;
      for (const a of cols[p.sourceTable] || []) {
        const av = prof[p.sourceTable]?.get(a.col);
        if (!av?.size) continue;
        for (const b of cols[p.refTable] || []) {
          const bv = prof[p.refTable]?.get(b.col);
          if (!bv?.size) continue;
          let hit = 0; for (const v of av) if (bv.has(v)) hit++;
          const coverage = hit / av.size;
          if (coverage < 0.6) continue;
          const nameScore = baseName(a.label) === baseName(b.label) ? 1
            : (KEYISH.test(a.label) && pkOf(p.refTable).includes(b.col)) ? 0.6 : 0;
          /* 名称完全不像时，只认值几乎全对上的列对，避免金额/名称凑巧重合 */
          if (!nameScore && coverage < 0.95) continue;
          const score = coverage * 0.6 + nameScore * 0.4;
          if (!best || score > best.score) best = { a, b, av, bv, coverage, hit, nameScore, score, origin: 'inferred' };
        }
      }
      picked = best;
      if (!picked) tried.push('逐列比对下来，没有哪一列的值能和另一端的列对上');
    }

    if (!picked) {
      out.push({ ...base, origin: 'unresolved', reason: tried.join('；') + '。需要人工指定关联字段' });
      continue;
    }

    /* 基数：算每份目标单据被多少条来源单据引用，直接看出是一对一还是一对多 */
    const refHits = new Map();
    let pairCount = 0;
    for (const row of sRows) {
      const v = val(row[picked.a.col]);
      if (!v || !picked.bv.has(v)) continue;
      refHits.set(v, (refHits.get(v) || 0) + 1); pairCount++;
    }
    const refColCount = new Map();
    for (const row of rRows) { const v = val(row[picked.b.col]); if (v) refColCount.set(v, (refColCount.get(v) || 0) + 1); }
    const maxChildren = refHits.size ? Math.max(...refHits.values()) : 0;
    const maxParents = [...refHits.keys()].reduce((m, v) => Math.max(m, refColCount.get(v) || 1), 0);
    const cardinality = maxChildren > 1 ? (maxParents > 1 ? 'N:M' : 'N:1') : (maxParents > 1 ? '1:N' : '1:1');

    out.push({
      ...base,
      origin: picked.origin,
      declaredBy: picked.declaredBy || '',
      sourceColumns: [picked.a.col], refColumns: [picked.b.col],
      sourceColumnLabel: picked.a.label, refColumnLabel: picked.b.label,
      coverage: Math.round(picked.coverage * 1000) / 1000,
      nameScore: picked.nameScore,
      pairs: pairCount, sourceRows: sRows.length, refRows: rRows.length,
      maxChildren, maxParents, cardinality, cardinalityText: CARDS[cardinality],
      /* 实测基数：N 不是个字母，是「每份合同最多 9 张订单」里的 9 */
      actualCardinality: maxChildren > 1 ? `${maxChildren}:1` : (maxParents > 1 ? `1:${maxParents}` : '1:1'),
      actualText: maxChildren > 1
        ? `实测：每份${base.refLabel}最多 ${maxChildren} 张${base.sourceLabel}，共 ${pairCount} 对单据关联`
        : `实测：每份${base.refLabel}最多 1 张${base.sourceLabel}，共 ${pairCount} 对单据关联`,
      reason: picked.origin === 'declared'
        ? `${picked.declaredBy}声明：${picked.a.label} → ${picked.b.label}，数据复核覆盖 ${Math.round(picked.coverage * 100)}%`
        : `按列名与取值重合度推断：${picked.a.label} → ${picked.b.label}（覆盖 ${Math.round(picked.coverage * 100)}%）`
    });
  }
  return {
    joins: out,
    stats: {
      total: out.length,
      resolved: out.filter(j => j.origin !== 'unresolved').length,
      declared: out.filter(j => j.origin === 'declared').length,
      inferred: out.filter(j => j.origin === 'inferred').length,
      unresolved: out.filter(j => j.origin === 'unresolved').length,
      oneToMany: out.filter(j => j.maxChildren > 1).length
    }
  };
}

/** 把落地结果写回模型副本：个体断言与完整性检查都走这一份，口径一致。
    没落地的关系把列清空——否则会拿一个「声明了但对不上」的旧映射继续查，
    报出来的悬空/空外键其实是在说另一件事，跟「关系没落地」重复又矛盾。 */
function withJoins(model, joins) {
  const ok = new Map(joins.filter(j => j.origin !== 'unresolved').map(j => [j.id, j]));
  const bad = new Set(joins.filter(j => j.origin === 'unresolved').map(j => j.id));
  return {
    ...model,
    objectProperties: (model.objectProperties || []).map(p => {
      const j = ok.get(p.id);
      if (j) return { ...p, sourceColumns: j.sourceColumns, refColumns: j.refColumns, resolvedBy: j.origin };
      if (bad.has(p.id)) return { ...p, sourceColumns: [], refColumns: [] };
      return p;
    })
  };
}


/** 四查：主键重复 / 外键悬空 / 空外键 / 一对多衔接异常（含父单无子行）。只报不改。
    resolution 传进来时，把「没落到字段上的关系」也报出来——否则这些关系一项都没查，
    界面却显示「全部通过」，那是假绿。 */
export function checkIntegrity(model, rowsByTable, resolution = null) {
  const issues = [];
  const classes = model.classes || [];
  const byTable = new Map(classes.map(c => [c.sourceTable, c]));
  const rowsOf = t => rowsByTable[t] || [];
  /* 报错也要说人话：t1_3d5436_f0 这种列标识在页面上没人看得懂，
     统一换成数据属性里的业务名（供应商编号 / 合同金额）。 */
  const colLabel = (table, col) =>
    (model.dataProperties || []).find(d => d.sourceTable === table && d.sourceColumn === col)?.localName || col;
  const colsLabel = (table, cols) => (cols || []).map(c => colLabel(table, c)).join('+');

  /* 1) 主键唯一 */
  for (const cls of classes) {
    const rows = rowsOf(cls.sourceTable);
    if (!rows.length) continue;
    if (!cls.primaryKey?.length) {
      issues.push({ kind: 'no-primary-key', level: 'warn', table: cls.sourceTable, tableLabel: cls.localName, count: rows.length, detail: '这张表没有主键，实例只能按行号区分，无法校验唯一性', samples: [] });
      continue;
    }
    const seen = new Map();
    for (const row of rows) {
      const k = keyOf(row, cls.primaryKey);
      seen.set(k, (seen.get(k) || 0) + 1);
    }
    const dup = [...seen].filter(([, n]) => n > 1);
    if (dup.length) {
      issues.push({
        kind: 'duplicate-key', level: 'error', table: cls.sourceTable, tableLabel: cls.localName,
        count: dup.length, detail: `主键 ${colsLabel(cls.sourceTable, cls.primaryKey)} 有 ${dup.length} 个重复值，共涉及 ${dup.reduce((n, [, c]) => n + c, 0)} 行`,
        samples: dup.slice(0, 8).map(([k, n]) => `${k || '(空)'} × ${n}`)
      });
    }
  }

  /* 2/3/4) 沿着「已进本体的关系」查外键 */
  const props = (model.objectProperties || []).filter(p => p.status !== 'candidate' && p.status !== 'rejected'
    && p.sourceTable && p.refTable && p.sourceColumns?.length && p.refColumns?.length);
  for (const p of props) {
    const src = rowsOf(p.sourceTable), ref = rowsOf(p.refTable);
    if (!src.length || !ref.length) continue;
    const refSet = new Set(ref.map(r => keyOf(r, p.refColumns)));
    let dangling = 0, emptyFk = 0;
    const dSample = [], eSample = [];
    for (const row of src) {
      const k = keyOf(row, p.sourceColumns);
      if (!cell(k).replace(/\|/g, '')) { emptyFk++; if (eSample.length < 5) eSample.push(`空外键：${colsLabel(p.sourceTable, p.sourceColumns)} 为空`); continue; }
      if (!refSet.has(k)) { dangling++; if (dSample.length < 5) dSample.push(`${k} 在${byTable.get(p.refTable)?.localName || p.refTable}里找不到`); }
    }
    const label = `${byTable.get(p.sourceTable)?.localName || p.sourceTable} → ${byTable.get(p.refTable)?.localName || p.refTable}`;
    if (dangling) {
      issues.push({ kind: 'dangling-fk', level: 'error', relation: p.localName, link: label, count: dangling, detail: `${dangling} 行引用了不存在的${byTable.get(p.refTable)?.localName || p.refTable}（孤儿单据）`, samples: dSample });
    }
    if (emptyFk) {
      issues.push({ kind: 'empty-fk', level: 'warn', relation: p.localName, link: label, count: emptyFk, detail: `${emptyFk} 行外键为空，单据连不上上下游（桥表半开）`, samples: eSample });
    }

    /* 父单无子行：一对多里「1 端有、N 端没有」——只有关系声明了必须有多条时才记问题 */
    const used = new Set(src.map(r => keyOf(r, p.sourceColumns)));
    const orphans = ref.filter(r => !used.has(keyOf(r, p.refColumns)));
    const card = String(p.cardinality || '');
    const mustHaveChildren = /^(1\.\.\*|1\.\.N|1:\*|1:N|1\.\.n|1\+)$/i.test(card.trim());
    if (orphans.length) {
      issues.push({
        kind: 'no-children', level: mustHaveChildren ? 'error' : 'info', relation: p.localName, link: label,
        count: orphans.length,
        detail: `${orphans.length} 条${byTable.get(p.refTable)?.localName || p.refTable}没有任何${byTable.get(p.sourceTable)?.localName || p.sourceTable}` + (mustHaveChildren ? '（关系声明要求至少 1 条，属于基数违规）' : '（未声明必须有多条，仅提示）'),
        samples: orphans.slice(0, 5).map(r => keyOf(r, p.refColumns))
      });
    }
    /* 声明 1:1 却被多行引用，实际是 1:N */
    const mustBeOne = /^(1\.\.1|1:1|0\.\.1)$/i.test(card.trim());
    if (mustBeOne) {
      const cnt = new Map();
      for (const row of src) { const k = keyOf(row, p.sourceColumns); cnt.set(k, (cnt.get(k) || 0) + 1); }
      const multi = [...cnt].filter(([, n]) => n > 1);
      if (multi.length) {
        issues.push({
          kind: 'cardinality-1n', level: 'error', relation: p.localName, link: label, count: multi.length,
          detail: `${multi.length} 个${byTable.get(p.refTable)?.localName || p.refTable}被多条${byTable.get(p.sourceTable)?.localName || p.sourceTable}引用（关系声明是 1:1）`,
          samples: multi.slice(0, 5).map(([k, n]) => `${k} × ${n}`)
        });
      }
    }
  }

  /* 5) 没落地到字段的关系：这条关系一项都没查，必须明说，不然就是「0 问题」的假绿 */
  for (const j of (resolution?.joins || [])) {
    if (j.origin !== 'unresolved') continue;
    issues.push({
      kind: 'relation-unresolved', level: 'warn', relation: j.relation,
      link: `${j.sourceLabel} → ${j.refLabel}`, count: 1,
      detail: `「${j.relation}」没能落到具体字段：${j.reason}。实例图上这条关系连不起来，外键与基数也就查不了`,
      samples: []
    });
  }

  const order = { error: 0, warn: 1, info: 2 };
  issues.sort((a, b) => (order[a.level] - order[b.level]) || (b.count - a.count));
  return {
    issues,
    stats: {
      errors: issues.filter(i => i.level === 'error').length,
      warns: issues.filter(i => i.level === 'warn').length,
      infos: issues.filter(i => i.level === 'info').length,
      /* 查过多少条关系：界面要能说清「N 条关系查了几条」，不是一律「全部通过」 */
      relations: (model.objectProperties || []).filter(p => p.status !== 'candidate' && p.status !== 'rejected').length,
      checkedRelations: props.length
    }
  };
}

/** 从真实数据生成个体（复用 TBox 那套断言构造，口径一致）。
    主键重复的行会指向同一个实例 IRI，这里只留第一个——重复本身由完整性检查报出来，
    不能让它变成图谱里两个同 id 的节点。 */
export function buildInstanceIndividuals(model, rowsByTable) {
  const all = buildIndividuals({ ...model, rowsByTable });
  const seen = new Set();
  const out = [];
  for (const i of all) { if (seen.has(i.iri)) continue; seen.add(i.iri); out.push(i); }
  return out;
}

/** 实例图：只保留有连边或重点标记的连通片，避免几万节点铺满画布。
    joins 传进来时，边上带出「靠哪两列连的 + 基数」，让一对多在主单节点上直接看得见。 */
export function instanceFlowGraph(model, individuals, { limit = 300, joins = [] } = {}) {
  const joinByProp = new Map((joins || []).filter(j => j.origin !== 'unresolved').map(j => [j.id, j]));
  const propByIri = new Map((model.objectProperties || []).map(p => [p.iri, p]));
  const byIri = new Map(individuals.map(i => [i.iri, i]));
  const classByIri = new Map((model.classes || []).map(c => [c.iri, c]));
  const typeOf = i => classByIri.get(i.types?.[0])?.localName || '单据';
  /* 谁被指过来：一笔合同被 3 张订单指过来，它就是主单。这个计数只用来判「有没有下游」，
     不再写到节点上——节点里塞一串「几条：哪类几条」既占地方又不好读，
     有几条往下走看连线就行。 */
  const degree = new Map(), fanin = new Map();
  for (const i of individuals) {
    for (const a of i.objectPropertyAssertions || []) {
      if (!byIri.has(a.targetIndividualIRI)) continue;
      degree.set(i.iri, (degree.get(i.iri) || 0) + 1);
      degree.set(a.targetIndividualIRI, (degree.get(a.targetIndividualIRI) || 0) + 1);
      fanin.set(a.targetIndividualIRI, (fanin.get(a.targetIndividualIRI) || 0) + 1);
    }
  }
  /* 单据上值得一眼看到的信息：单据号已经是节点标题，这里补物料/供应商/金额这类 */
  const FIELD_HINT = /供应商|客户|物料|产品|品名|规格|型号|金额|数量|状态|日期|部门|项目|名称/;
  const propLabel = new Map((model.dataProperties || []).map(d => [d.iri, d.localName]));
  const briefOf = i => {
    const picks = [];
    for (const a of i.dataPropertyAssertions || []) {
      const label = propLabel.get(a.propertyIRI) || '';
      const value = String(a.value ?? '').trim();
      if (!label || !value || value === String(i.localName)) continue;
      if (!FIELD_HINT.test(label)) continue;
      picks.push({ label, value, rank: /供应商|客户/.test(label) ? 0 : /物料|产品|品名/.test(label) ? 1 : 2 });
    }
    picks.sort((a, b) => a.rank - b.rank);
    return picks.slice(0, 2).map(p => `${p.label} ${p.value.length > 12 ? p.value.slice(0, 11) + '…' : p.value}`).join(' · ');
  };
  /* 先留有关联的，再按行序补齐，保证「单据流」里的主单和明细优先出现 */
  const picked = individuals.filter(i => (degree.get(i.iri) || 0) > 0).slice(0, limit);
  if (picked.length < limit) {
    const have = new Set(picked.map(i => i.iri));
    for (const i of individuals) { if (picked.length >= limit) break; if (!have.has(i.iri)) { picked.push(i); have.add(i.iri); } }
  }
  const keep = new Set(picked.map(i => i.iri));
  const nodes = picked.map(i => {
    const type = typeOf(i);
    return {
      data: {
        id: i.iri, label: i.localName || i.id, kind: 'instance',
        type, fanin: fanin.get(i.iri) || 0,
        sub: type,
        summary: briefOf(i),
        fields: (i.dataPropertyAssertions || []).length,
        table: i.table, orphan: (degree.get(i.iri) || 0) === 0
      }
    };
  });
  const edges = [];
  for (const i of picked) {
    for (const a of i.objectPropertyAssertions || []) {
      if (!keep.has(a.targetIndividualIRI)) continue;
      const prop = propByIri.get(a.propertyIRI);
      const j = joinByProp.get(prop?.id);
      edges.push({
        data: {
          id: 'edge:' + a.id, source: i.iri, target: a.targetIndividualIRI,
          label: prop?.localName || '关联', propertyId: prop?.id || '',
          cardinality: j?.cardinality || '', cardinalityText: j?.cardinalityText || '',
          /* 类型级基数（N:1）是关系本身的说法；这条边是「这一张单据指向那一张」，
             真实的多寡在节点上（合同被 9 张订单引用），这里只留实测数供详情面板引用 */
          maxChildren: j?.maxChildren || 0, pairs: j?.pairs || 0,
          sourceColumnLabel: j?.sourceColumnLabel || '', refColumnLabel: j?.refColumnLabel || ''
        }
      });
    }
  }
  return {
    elements: [...nodes.map(n => ({ ...n, classes: 'instance-node' })), ...edges.map(e => ({ ...e, classes: 'instance-edge' }))],
    stats: {
      nodes: nodes.length, edges: edges.length, totalIndividuals: individuals.length,
      truncated: individuals.length > picked.length,
      relations: (joins || []).length,
      oneToMany: nodes.filter(n => n.data.fanin > 1).length
    }
  };
}

const xmlEsc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** 独立的 ABox 文件：只含个体与断言，不重复 TBox，方便和已有本体分开管理 */
export function toAboxXml(model, individuals) {
  const ns = model.namespace;
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<rdf:RDF xmlns="${ns}"`,
    '         xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"',
    '         xmlns:rdfs="http://www.w3.org/2000/01/rdf-schema#"',
    '         xmlns:owl="http://www.w3.org/2002/07/owl#"',
    `         xml:base="${ns}">`,
    `  <!-- 由本体建模工作台从客户真实单据数据生成的实例层（ABox） · 个体 ${individuals.length} 个 -->`,
    `  <owl:Ontology rdf:about="${ns}">`,
    `    <rdfs:comment>实例层：只含个体与断言，类与属性定义见 TBox 文件</rdfs:comment>`,
    '  </owl:Ontology>'
  ];
  for (const i of individuals) {
    lines.push(`  <owl:NamedIndividual rdf:about="${xmlEsc(i.iri)}">`);
    for (const t of i.types || []) lines.push(`    <rdf:type rdf:resource="${xmlEsc(t)}"/>`);
    lines.push(`    <rdfs:label xml:lang="zh">${xmlEsc(i.localName)}</rdfs:label>`);
    for (const a of i.dataPropertyAssertions || []) {
      lines.push(`    <${a.propertyIRI.split('#').pop()} rdf:datatype="http://www.w3.org/2001/XMLSchema#string">${xmlEsc(a.value)}</${a.propertyIRI.split('#').pop()}>`);
    }
    for (const a of i.objectPropertyAssertions || []) {
      const prop = a.propertyIRI.split('#').pop();
      lines.push(`    <${prop} rdf:resource="${xmlEsc(a.targetIndividualIRI)}"/>`);
    }
    lines.push('  </owl:NamedIndividual>');
  }
  lines.push('</rdf:RDF>', '');
  return lines.join('\n');
}

/** 装载入口：解析 → 关系落地 → 个体 → 四查 → 实例图，一次算完存进项目 */
export async function instantiateProject({ project, files = [], sampleDir, by = '工作台业务用户' }) {
  const model = project.canonical;
  if (!model) throw Error('当前项目还没有规范模型，请先完成第 1—3 步');
  const loaded = await loadInstanceFiles({ files, model, sampleDir });
  if (!loaded.stats.rows) {
    const why = loaded.unmatched.slice(0, 3).map(u => `${u.file}${u.table ? ' / ' + u.table : ''}：${u.reason}`).join('；');
    throw Error('没有可装载的数据行' + (why ? `（${why}）` : '') + '。请确认文件名或 sheet 名与表名一致');
  }
  return buildInstanceData({
    project, rowsByTable: loaded.rowsByTable, files: loaded.files,
    unmatched: loaded.unmatched, stats: loaded.stats, by, origin: 'files'
  });
}

/** 一次上传两用：第 1 步上传的表结构里本来就带着数据行，
    直接拿这批行出实例图谱，不必让客户为了看实例再传一遍同样的表。 */
export function instantiateFromMaterials({ project, by = '第 1 步上传的材料' }) {
  const model = project.canonical;
  if (!model) throw Error('当前项目还没有规范模型');
  const rowsByTable = {};
  for (const [table, rows] of Object.entries(model.rowsByTable || {})) {
    if (Array.isArray(rows) && rows.length) rowsByTable[table] = rows;
  }
  const tables = Object.keys(rowsByTable);
  if (!tables.length) return null;
  const rows = Object.values(rowsByTable).reduce((n, r) => n + r.length, 0);
  /* 材料清单里带表结构的文件就是数据来源，按它们的名字列出来，让用户知道这批实例是从哪来的 */
  const sources = (project.materials || []).filter(m => m.role !== '业务描述');
  const files = (sources.length ? sources : [{ name: '第 1 步上传的材料' }]).map(m => ({
    name: m.name, type: m.type || '', bytes: m.bytes || 0, tables: [], rows: 0
  }));
  return buildInstanceData({
    project, rowsByTable, files, unmatched: [],
    stats: { tables: tables.length, rows, files: files.length },
    by, origin: 'materials', tables
  });
}

function buildInstanceData({ project, rowsByTable, files = [], unmatched = [], stats = {}, by, origin = 'files' }) {
  const model = project.canonical;
  /* 先落地，再出个体：不先把「订单用哪一列指向合同」定下来，
     buildIndividuals 会直接跳过这条关系，实例图一条边都没有，完整性检查也一项都不查。 */
  const resolution = resolveRelations(model, rowsByTable);
  const effective = withJoins(model, resolution.joins);
  const individuals = buildInstanceIndividuals(effective, rowsByTable);
  const integrity = checkIntegrity(effective, rowsByTable, resolution);
  const graph = instanceFlowGraph(effective, individuals, { joins: resolution.joins });
  const data = {
    id: uid('inst'),
    loadedAt: new Date().toISOString(),
    by,
    origin,
    files,
    unmatched,
    stats: {
      ...stats,
      individuals: individuals.length,
      assertions: individuals.reduce((n, i) => n + (i.dataPropertyAssertions || []).length + (i.objectPropertyAssertions || []).length, 0),
      edges: graph.stats.edges,
      relations: resolution.stats.total,
      resolvedRelations: resolution.stats.resolved
    },
    relations: resolution,
    integrity,
    individuals,
    graph
  };
  return data;
}
