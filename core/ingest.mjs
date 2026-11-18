import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { sha, uid } from './store.mjs';
import { readWorkbook } from './xlsx.mjs';
import { tablesFromWorkbook, tablesFromDelimited } from './table-spec.mjs';

const RANGE = {
  TEXT: 'string', VARCHAR: 'string', CHAR: 'string', JSON: 'string', CLOB: 'string',
  INTEGER: 'integer', INT: 'integer', BIGINT: 'integer',
  DECIMAL: 'decimal', NUMERIC: 'decimal', REAL: 'decimal', FLOAT: 'decimal', DOUBLE: 'decimal',
  DATE: 'date', DATETIME: 'dateTime', TIMESTAMP: 'dateTime', BOOLEAN: 'boolean', BOOL: 'boolean'
};
export const xsdType = t => {
  const key = String(t || '').toUpperCase().replace(/\(.*\)/, '').trim();
  if (RANGE[key]) return RANGE[key];
  if (/文本|字符|字符串/.test(t)) return 'string';
  if (/整数/.test(t)) return 'integer';
  if (/数值|金额|小数/.test(t)) return 'decimal';
  if (/日期/.test(t)) return 'date';
  if (/时间/.test(t)) return 'dateTime';
  if (/布尔/.test(t)) return 'boolean';
  return 'string';
};

export async function prepareSources(specs, sampleDir) {
  const out = [];
  for (const spec of specs) {
    let text = '', binary = null;
    if (typeof spec.content === 'string') {
      if (spec.encoding === 'base64') binary = Buffer.from(spec.content, 'base64');
      else text = spec.content;
    } else {
      const p = path.isAbsolute(spec.path) ? spec.path : path.join(sampleDir, spec.path || spec.name);
      const buf = await readFile(p);
      if (/\.(xlsx|xlsm)$/i.test(p)) binary = buf;
      else text = buf.toString('utf8');
    }
    const name = spec.name || path.basename(spec.path || 'inline');
    const type = spec.type || guessType(name);
    const payload = binary || text;
    out.push({ id: uid('src'), name, type, text, binary, sha256: sha(payload), bytes: binary ? binary.length : Buffer.byteLength(text) });
  }
  return out;
}
export function guessType(name) {
  const n = name.toLowerCase();
  if (/\.(xlsx|xlsm)$/.test(n)) return 'workbook';
  if (/\.xls$/i.test(n)) return 'legacy-xls';
  if (n.endsWith('.sql')) return 'ddl';
  if (n.endsWith('.json')) return 'dictionary';
  if (n.endsWith('.csv') || n.endsWith('.tsv')) return 'csv';
  return 'process';
}
function emptyTable(name) {
  return { name, label: '', description: '', fields: [], primaryKey: [], foreignKeys: [], rows: [] };
}
function normalForeign(fk) {
  if (Array.isArray(fk)) return {
    fields: Array.isArray(fk[0]) ? fk[0] : (fk[0] ? [fk[0]] : []),
    refTable: fk[1] || '',
    refFields: Array.isArray(fk[2]) ? fk[2] : (fk[2] ? [fk[2]] : [])
  };
  if (typeof fk === 'string') {
    const m = fk.match(/FOREIGN\s+KEY\s*\(([^)]+)\)\s*REFERENCES\s+["`]?([\w]+)["`]?\s*\(([^)]+)\)/i);
    if (!m) return null;
    return { fields: cols(m[1]), refTable: m[2], refFields: cols(m[3]) };
  }
  return {
    fields: fk.fields || fk.columns || fk.from || [],
    refTable: fk.refTable || fk.ref_table || fk.references || fk.to_table || '',
    refFields: fk.refFields || fk.ref_fields || fk.to || []
  };
}
const cols = s => [...s.matchAll(/["`[]?([\w]+)["`\]]?/g)].map(m => m[1]);

export function parseDictionary(text) {
  const data = JSON.parse(text);
  const tables = (data.tables || []).map(t => ({
    name: t.name, label: t.label || t.name, description: t.description || '',
    fields: (t.fields || []).map(f => ({
      name: f.name, type: xsdType(f.type || f.dataType), required: !!f.required,
      key: f.key || '', description: f.description || ''
    })),
    primaryKey: t.primary_key || t.primaryKey || [],
    foreignKeys: (t.foreign_keys || t.foreignKeys || []).map(normalForeign).filter(Boolean),
    rows: t.rows || []
  }));
  return { tables, segments: [], extras: { purpose: data.purpose, snapshot: data.dataset_snapshot_id, expected: data.expected_results, reference: data.reference_results } };
}

export function parseDDL(text) {
  const lines = text.split(/\r?\n/);
  const tables = [];
  let current = null, comment = '';
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('--')) { comment = trimmed.replace(/^--\s*/, ''); continue; }
    const start = trimmed.match(/^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["`[]?([\w]+)["`\]]?\s*\(/i);
    if (start) {
      current = emptyTable(start[1]);
      const dm = comment.match(/^([\w]+)\s+(.*)$/);
      current.label = dm && dm[1] === start[1] ? dm[1] : start[1];
      current.description = comment;
      tables.push(current);
      comment = '';
      continue;
    }
    if (!current) continue;
    if (/^\);?/.test(trimmed)) { current = null; continue; }
    const pk = trimmed.match(/^PRIMARY\s+KEY\s*\(([^)]+)\)/i);
    if (pk) { current.primaryKey = cols(pk[1]); continue; }
    const fk = trimmed.match(/^FOREIGN\s+KEY\s*\(([^)]+)\)\s*REFERENCES\s+["`]?([\w]+)["`]?\s*\(([^)]+)\)/i);
    if (fk) { current.foreignKeys.push({ fields: cols(fk[1]), refTable: fk[2], refFields: cols(fk[3]) }); continue; }
    const col = trimmed.match(/^["`[]?([\w]+)["`\]]?\s+([\w]+(?:\([^)]*\))?)\s*(.*)$/i);
    if (col) {
      const tail = col[3].replace(/,?\s*$/, '');
      current.fields.push({
        name: col[1], type: xsdType(col[2]), required: /NOT\s+NULL/i.test(tail),
        key: /PRIMARY\s+KEY/i.test(tail) ? 'PK' : '', description: ''
      });
    }
  }
  return { tables, segments: [], extras: {} };
}

export function parseDelimited(text, separator, source = {}) {
  const result = tablesFromDelimited(text, separator, source);
  return {
    tables: result.tables.map(t => ({
      name: t.name, label: t.label, description: t.description,
      fields: t.fields.map(f => ({ name: f.name, label: f.label, type: f.type, required: f.required, key: f.key, description: f.description })),
      primaryKey: t.primaryKey, foreignKeys: [], rows: t.rows
    })),
    segments: result.statements,
    extras: { tableSpec: { diagnostics: result.diagnostics, idCandidates: result.idCandidates } }
  };
}

export function parseProcess(text) {
  const segments = [];
  let heading = '概述', buffer = [], lineNo = 0;
  const flush = () => {
    const body = buffer.join('\n').trim();
    if (body) segments.push({ id: uid('seg'), heading, locator: heading, text: body.slice(0, 2000) });
    buffer = [];
  };
  for (const raw of text.split(/\r?\n/)) {
    lineNo++;
    const line = raw.trimEnd();
    if (/^#{1,4}\s/.test(line)) { flush(); heading = line.replace(/^#{1,4}\s+/, '') + ' (行' + lineNo + ')'; continue; }
    if (/^(步骤[一二三四五六七八九十]+|\d+[\.、)])\s*/.test(line) && buffer.length > 3) { flush(); heading = line.slice(0, 40) + ' (行' + lineNo + ')'; continue; }
    if (line.trim()) buffer.push(line);
  }
  flush();
  return { tables: [], segments, extras: {} };
}

export function parseMaterial(src) {
  const sep = /\.tsv$/i.test(src.name) ? '\t' : ',';
  let result;
  switch (src.type) {
    case 'workbook': {
      if (!src.binary) throw Error('工作簿内容为空或编码不正确');
      const wb = readWorkbook(src.binary);
      const spec = tablesFromWorkbook(wb, { name: src.name, id: src.id });
      result = {
        tables: spec.tables.map(t => ({
          name: t.name, label: t.label, description: t.description,
          fields: t.fields.map(f => ({ name: f.name, label: f.label, type: f.type, required: f.required, key: f.key, description: f.description })),
          primaryKey: t.primaryKey, foreignKeys: [], rows: t.rows, source: t.source
        })),
        segments: spec.statements,
        extras: { tableSpec: { diagnostics: spec.diagnostics, idCandidates: spec.idCandidates, sameNameWarnings: spec.sameNameWarnings } }
      };
      break;
    }
    case 'legacy-xls': throw Error('旧版 .xls 不支持，请另存为 .xlsx 后再上传');
    case 'dictionary': result = parseDictionary(src.text); break;
    case 'ddl': result = parseDDL(src.text); break;
    case 'csv': result = parseDelimited(src.text, sep, { name: src.name, id: src.id }); break;
    default: result = parseProcess(src.text);
  }
  return { sourceId: src.id, sourceName: src.name, sourceType: src.type, sha256: src.sha256, ...result };
}
