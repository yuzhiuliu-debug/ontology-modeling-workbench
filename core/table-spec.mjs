/* 通用表结构探测：把「多 sheet / 多层表头 / 说明行 / 必填标记 / 全文本单元格 /
   伪公式 / 隐藏表 / 空白网格」归一成领域无关的 TableSpec。
   纪律：不认识任何业务表名或字段名，只按形态判断；输出稳定 ASCII id + 原始中文 label。 */
import { sha, uid } from './store.mjs';

const trim = v => String(v ?? '').trim();
const HINT_WORDS = /(如[:：]|例如|YYYY|必填|关联|应\s*[=＝]|≤|≥|系统回写|导入留空|元[,，]|位小数|JSON[:：]|唯一主键|不超过|不得)/;
const REQUIRED_MARK = /[*＊]\s*$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}(?:[T\s].*)?$/;
const NUM_RE = /^-?\d+(?:\.\d+)?$/;
const IDENT_RE = /^[A-Za-z]{1,6}[-_]?\d{2,}(?:-\d+)*$/;

export const xsdTypeOf = (values, hint = '') => {
  const vs = values.map(trim).filter(Boolean);
  if (!vs.length) return /日期|时间/.test(hint) ? 'dateTime' : 'string';
  if (vs.every(v => /^(是|否|TRUE|FALSE|true|false|Y|N)$/.test(v))) return 'boolean';
  if (vs.every(v => DATE_RE.test(v))) return /[T\s]\d{2}:\d{2}/.test(vs[0]) ? 'dateTime' : 'date';
  if (vs.every(v => NUM_RE.test(v))) return vs.every(v => /^\d+$/.test(v)) ? 'integer' : 'decimal';
  if (vs.every(v => /^[\[{]/.test(v))) return 'string';
  if (vs.length >= 3) {
    const uniq = new Set(vs);
    if (uniq.size <= Math.max(2, Math.ceil(vs.length / 2)) && vs.every(v => v.length <= 12)) return 'string';
  }
  return 'string';
};

function scoreHeaderRow(row, following) {
  const cells = row.map(trim);
  const nonempty = cells.filter(Boolean);
  if (nonempty.length < 2) return -99;
  let score = 0;
  const avg = nonempty.reduce((n, v) => n + v.length, 0) / nonempty.length;
  if (avg <= 20) score += 2;
  if (avg > 40) score -= 3;
  if (nonempty.some(v => REQUIRED_MARK.test(v))) score += 2;
  if (nonempty.some(v => HINT_WORDS.test(v))) score -= 3;
  if (nonempty.some(v => /[，。；]/.test(v) && v.length > 12)) score -= 2;
  if (nonempty.some(v => NUM_RE.test(v) || DATE_RE.test(v))) score -= 2;
  let first = -1, last = -1;
  cells.forEach((v, i) => { if (v) { if (first < 0) first = i; last = i; } });
  if (last - first + 1 === nonempty.length) score += 1;
  if (following.some(r => r && r.some(v => trim(v) !== ''))) score += 2;
  return score;
}

function detectHeader(rows) {
  const limit = Math.min(rows.length, 20);
  let best = { index: -1, score: -99 };
  for (let i = 0; i < limit; i++) {
    const s = scoreHeaderRow(rows[i] || [], rows.slice(i + 1, i + 4));
    if (s > best.score) best = { index: i, score: s };
  }
  return best.score >= 2 ? best.index : 0;
}

function pseudoFormulaHints(sheet) {
  const map = new Map();
  for (const f of sheet.formulaCells || []) {
    if (!f.pseudo) continue;
    const ci = colOf(f.ref);
    map.set(ci, { text: '=' + f.formula, ref: f.ref });
  }
  return map;
}
function colOf(ref) {
  const m = String(ref || '').match(/^([A-Z]+)/i);
  if (!m) return 0;
  let n = 0;
  for (const ch of m[1].toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** 从 workbook（readWorkbook 的输出）生成 TableSpec 列表 */
export function tablesFromWorkbook(workbook, source = {}) {
  const tables = [], statements = [], diagnostics = { hiddenIncluded: 0, headerRows: {}, pseudoFormulas: 0, mergedTitles: 0 };
  const allColumns = new Map();
  let tableNo = 0;

  for (const sheet of workbook.sheets) {
    if (sheet.hidden) diagnostics.hiddenIncluded++;
    if ((sheet.merges || []).length) diagnostics.mergedTitles += sheet.merges.length;
    const rows = sheet.rows || [];
    const headerIdx = detectHeader(rows);
    diagnostics.headerRows[sheet.name] = headerIdx + 1;
    const headerRow = rows[headerIdx] || [];
    const pseudo = pseudoFormulaHints(sheet);
    diagnostics.pseudoFormulas += pseudo.size;

    // 字段名行之前的非空行：按列对齐抽为「字段说明」元数据，不当列名也不当数据
    const hints = new Array(headerRow.length).fill('');
    const preRows = [];
    for (let i = 0; i < headerIdx; i++) {
      const r = rows[i] || [];
      if (!r.some(v => trim(v))) continue;
      preRows.push({ row: i + 1, cells: r });
      r.forEach((v, ci) => { if (trim(v) && ci < hints.length && !hints[ci]) hints[ci] = trim(v); });
    }
    // 标题行/说明行同时登记为可引用的材料片段
    preRows.forEach(pr => {
      const text = pr.cells.map(trim).filter(Boolean).join(' | ');
      if (text) statements.push({
        id: uid('seg'), kind: /关联|应\s*[=＝]|≤|≥|累计|一致|不得超过/.test(text) ? '业务规则线索' : '填写说明',
        heading: `${sheet.name} · 第 ${pr.row} 行`, text: text.slice(0, 500),
        locator: `${source.name || '工作簿'} / ${sheet.name} / 第 ${pr.row} 行`,
        sourceName: source.name || '工作簿', sourceId: source.id || '', table: sheet.name
      });
    });

    const tableId = 't' + (++tableNo) + '_' + sha(sheet.name).slice(0, 6);
    const fields = [];
    const usedCols = [];
    headerRow.forEach((raw, ci) => {
      const label0 = trim(raw);
      if (!label0) return;
      const hint = hints[ci] || '';
      const pseudoHint = pseudo.get(ci);
      if (pseudoHint) statements.push({
        id: uid('seg'), kind: '伪公式降级', heading: `${sheet.name} · ${pseudoHint.ref}`,
        text: `单元格 ${pseudoHint.ref} 的「${pseudoHint.text}」不是合法公式，已按说明文字处理`,
        locator: `${source.name || '工作簿'} / ${sheet.name} / ${pseudoHint.ref}`,
        sourceName: source.name || '工作簿', sourceId: source.id || '', table: sheet.name
      });
      const label = label0.replace(REQUIRED_MARK, '').trim();
      const field = {
        name: `${tableId}_f${ci}`, label,
        description: [hint, pseudoHint ? pseudoHint.text : ''].filter(Boolean).join(' · ').slice(0, 200),
        required: REQUIRED_MARK.test(label0), key: '',
        type: 'string', sourceColumnLabel: label, colIndex: ci
      };
      fields.push(field);
      usedCols.push(ci);
    });
    if (!fields.length) continue;

    // 数据行：字段名行之后、至少一个单元格有值；跳过伪公式单元格值
    const dataRows = [];
    for (let i = headerIdx + 1; i < rows.length; i++) {
      const r = rows[i] || [];
      if (!r.some(v => trim(v))) continue;
      const row = {};
      fields.forEach(f => {
        const v = pseudo.has(f.colIndex) ? '' : trim(r[f.colIndex]);
        if (v !== '') row[f.name] = v;
      });
      if (Object.keys(row).length) dataRows.push(row);
    }
    fields.forEach(f => {
      const vals = dataRows.map(r => r[f.name]).filter(Boolean);
      f.type = xsdTypeOf(vals, f.description);
      // 主键优先采信说明行里写明「唯一主键」，不靠编码形态猜（避免把外键误判成主键）
      if (/唯一主键|(^|[|,，])主键([|,，]|$)/.test(f.description)) f.key = 'PK';
    });
    let pk = fields.filter(f => f.key === 'PK').map(f => f.name);
    if (!pk.length && fields.length) {
      // 没有明确主键声明时，用第一个字段作为实例标识候选并标低置信度
      fields[0].key = 'PK?';
      pk = [fields[0].name];
    }

    tables.push({
      name: tableId, label: sheet.name, description: `来自 ${source.name || '工作簿'} 的 ${sheet.name}`,
      fields, primaryKey: pk, foreignKeys: [], rows: dataRows,
      source: { materialId: source.id || '', locator: `${source.name || '工作簿'} / ${sheet.name}`, hidden: !!sheet.hidden, headerRow: headerIdx + 1 }
    });
    fields.forEach(f => {
      const key = f.label;
      if (!allColumns.has(key)) allColumns.set(key, []);
      allColumns.get(key).push({ table: tableId, tableLabel: sheet.name, field: f.name, values: new Set(dataRows.map(r => r[f.name]).filter(Boolean)) });
    });
  }

  // 跨表同名键：只给候选，不自动认定；同名但取值完全不重叠的单独告警
  const idCandidates = [], sameNameWarnings = [];
  for (const [column, entries] of allColumns) {
    if (entries.length < 2) continue;
    for (let i = 0; i < entries.length; i++) for (let j = i + 1; j < entries.length; j++) {
      const a = entries[i], b = entries[j];
      if (a.table === b.table) continue;
      let inter = 0;
      for (const v of a.values) if (b.values.has(v)) inter++;
      const overlap = inter / Math.max(1, Math.min(a.values.size, b.values.size));
      const sampleSize = Math.min(a.values.size, b.values.size);
      const item = {
        id: uid('idc'), column, left: { table: a.table, tableLabel: a.tableLabel, field: a.field },
        right: { table: b.table, tableLabel: b.tableLabel, field: b.field },
        overlap: Math.round(overlap * 100) / 100, sampleSize, status: 'candidate',
        confidence: sampleSize < 3 ? 'low' : overlap >= 0.8 ? 'high' : 'medium',
        note: sampleSize < 3
          ? '同名字段跨表出现；样例行不足 3 行，重叠度仅供参考，必须业务用户确认后才能当关联键。'
          : '同名字段跨表出现，仅作关联候选；同名不等于同义，需业务用户确认。'
      };
      if (overlap === 0 && a.values.size >= 2 && b.values.size >= 2) {
        sameNameWarnings.push({ ...item, reason: '命名相同但取值域完全不重叠，疑似同名不同义，禁止自动合并' });
      } else if (overlap > 0) idCandidates.push(item);
    }
  }
  idCandidates.sort((x, y) => y.overlap - x.overlap);
  return { tables, statements, idCandidates, sameNameWarnings, diagnostics };
}

/** CSV/TSV 也走同一套归一（首行即字段名，但仍走类型推断与必填标记清洗） */
export function tablesFromDelimited(text, separator, source = {}) {
  const lines = String(text).replace(/^\uFEFF/, '').split(/\r?\n/).filter(l => l.trim());
  if (!lines.length) return { tables: [], statements: [], idCandidates: [], sameNameWarnings: [], diagnostics: {} };
  const split = line => {
    const out = []; let buf = '', quoted = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') { if (quoted && line[i + 1] === '"') { buf += '"'; i++; } else quoted = !quoted; continue; }
      if (ch === separator && !quoted) { out.push(buf.trim()); buf = ''; continue; }
      buf += ch;
    }
    out.push(buf.trim()); return out;
  };
  const header = split(lines[0]);
  const body = lines.slice(1).map(split);
  const tableId = 't1_' + sha(source.name || 'csv').slice(0, 6);
  const fields = header.map((h, ci) => {
    const label = trim(h).replace(REQUIRED_MARK, '').trim();
    return { name: `${tableId}_f${ci}`, label, description: '', required: REQUIRED_MARK.test(trim(h)), key: '', type: 'string', colIndex: ci };
  });
  const rows = body.map(cells => Object.fromEntries(fields.map(f => [f.name, trim(cells[f.colIndex])]).filter(([, v]) => v !== '')));
  fields.forEach(f => { f.type = xsdTypeOf(rows.map(r => r[f.name]).filter(Boolean), ''); });
  return {
    tables: [{ name: tableId, label: (source.name || 'uploaded').replace(/\.[^.]+$/, ''), description: '', fields, primaryKey: [], foreignKeys: [], rows,
      source: { materialId: source.id || '', locator: source.name || 'CSV', hidden: false, headerRow: 1 } }],
    statements: [], idCandidates: [], sameNameWarnings: [], diagnostics: {}
  };
}
