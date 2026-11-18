/* 图片材料识别：表结构截图、制度/流程截图、单据照片都交给能看图的模型读一遍，
   再落成和文本材料一样的形状（表结构 → 字典 JSON，其余 → 流程描述文本），
   这样后面解析、建模、出图的链路一行不用改。

   图片统一经 callVision 发送给用户配置的模型；模型需支持图片输入。 */

import { callVision } from './ai.mjs';

const IMAGE_EXT = /\.(png|jpe?g|webp|bmp|gif)$/i;
const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', bmp: 'image/bmp', gif: 'image/gif' };

export const isImageName = name => IMAGE_EXT.test(String(name || ''));
export function imageMime(name) {
  const ext = String(name || '').toLowerCase().match(/\.(\w+)$/)?.[1];
  return MIME[ext] || 'image/png';
}

const SYSTEM = [
  '你是数据建模助手。用户给你一张图片，可能是数据表结构截图、制度或业务流程截图、或者一张业务单据照片。',
  '只看图里出现的东西，不要补常识、不要编字段、不要编金额和日期。\n',
  '严格输出 JSON，结构如下：',
  '{',
  '  "kind": "table | process | document | unknown",',
  '  "note": "一句话说明你从图里看到了什么",',
  '  "tables": [',
  '    { "name": "表名（图里有英文表名就用英文，没有就用中文名）",',
  '      "label": "中文名",',
  '      "description": "这张表管什么，一句话",',
  '      "fields": [ { "name": "字段名，照抄图里的表头", "type": "string|integer|decimal|date|dateTime|boolean", "key": false, "description": "字段含义，图里有备注就照抄" } ],',
  '      "primaryKey": ["能唯一标识一行的字段名"] }',
  '  ],',
  '  "text": "kind 不是 table 时填：把图里的文字按原结构整理成纯文本，保留条款编号、阶段名、部门名"',
  '}\n',
  '判别规则：',
  '1. 有表头 + 多行多列 → kind=table，每个可视的表各出一条 tables；字段名照抄表头，不要翻译成英文。',
  '2. 大段文字、条款、流程步骤、组织职责 → kind=process，text 里分条整理。',
  '3. 只有一张单据（合同/订单/入库单/发票）→ kind=document，text 里写清单号、日期、对方单位、金额、物料等出现的字段。',
  '4. 看不清或与数据建模无关 → kind=unknown，note 说明原因。',
  '5. type 猜不出来就给 string；明显是编号给 string，日期给 date，金额数量给 decimal。'
].join('\n');

/** 读一张图，返回 { kind, tables, text, note } */
export async function readImage({ name, binary }) {
  if (!binary || !binary.length) throw Error('图片内容为空');
  const dataUrl = `data:${imageMime(name)};base64,${binary.toString('base64')}`;
  const messages = [
    { role: 'system', content: SYSTEM },
    {
      role: 'user',
      content: [
        { type: 'text', text: '这张图片的文件名是 ' + name + '。按约定输出 JSON。' },
        { type: 'image_url', image_url: { url: dataUrl } }
      ]
    }
  ];
  const out = await callVision(messages, { maxTokens: 8192 });
  const kind = ['table', 'process', 'document', 'unknown'].includes(out?.kind) ? out.kind : 'unknown';
  const tables = Array.isArray(out?.tables) ? out.tables.filter(t => t && t.name && Array.isArray(t.fields) && t.fields.length) : [];
  return { kind, tables, text: String(out?.text || '').trim(), note: String(out?.note || '').trim() };
}

/* ---------------- 单据照片 → 实例数据行 ----------------

   客户手里往往是拍照的单据（入库单、发票、合同页），没有 CSV。
   这里让看图模型把单据读成「按已知表结构填的行」，再拼成 CSV 交给实例装载器，
   后面的关系落地、完整性检查一行不用改。

   两条纪律：
   1. 表名和字段名只能用清单里给的，模型不能自造；
   2. 图里看不见的格子留空，不猜金额和日期——空着会被完整性检查标出来，猜了反而害人。 */

const ROW_RULES = [
  '你在把一张业务单据的图片读成表数据行。下面给你可用的表和字段清单，只能从清单里选，不许自造表名或字段名。',
  '',
  '表清单（table 是内部表名，label 是业务名，fields 是可选字段）：',
  '__TABLES__',
  '',
  '规则：',
  '1. 一张单据可能同时对应主单和明细：主单一行，明细每个物料/服务一行，能拆就拆成多条。',
  '2. 字段名一律填清单里的 name；清单里没有的字段直接丢掉，不要自己加。',
  '3. 图里看不见的值留空字符串，不要按常识补金额、日期、单位。',
  '4. 金额只写数字（去掉千分位、货币符号），日期写成 2026-03-15 这种格式。',
  '5. 值是原文照抄，照抄不了的整条不要编。',
  '',
  '严格输出 JSON：',
  '{',
  '  "note": "一句话说明读到了几张单据、哪张表",',
  '  "rows": [ { "table": "清单里的 table 值", "values": { "字段name": "值" } } ]',
  '}'
].join('\n');

const csvCell = v => {
  const s = String(v ?? '');
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};

/** 读一张单据图片，按已知表结构输出 CSV 文件（交给实例装载器，和手工传的 CSV 同一条路）。
    tables: [{ table, label, fields: [{ key, name }] }] */
export async function readDocumentRows({ name, binary, tables = [] }) {
  if (!binary || !binary.length) throw Error('图片内容为空');
  const usable = (tables || []).filter(t => t && t.table && Array.isArray(t.fields) && t.fields.length);
  if (!usable.length) throw Error('还没有可用的表结构，无法把单据照片读成数据行');
  const spec = usable.map(t => ({
    table: t.table, label: t.label || t.table,
    fields: t.fields.map(f => ({ name: f.name || f.key, hint: f.key !== f.name ? f.key : undefined }))
  }));
  const system = ROW_RULES.replace('__TABLES__', JSON.stringify(spec, null, 1));
  const dataUrl = `data:${imageMime(name)};base64,${binary.toString('base64')}`;
  const out = await callVision([
    { role: 'system', content: system },
    {
      role: 'user',
      content: [
        { type: 'text', text: '这是单据图片，文件名 ' + name + '。按约定输出 JSON。' },
        { type: 'image_url', image_url: { url: dataUrl } }
      ]
    }
  ], { maxTokens: 8192 });

  const allowTable = new Map(usable.map(t => [t.table, t]));
  const allowField = new Map(usable.map(t => [t.table, new Set(t.fields.map(f => f.name || f.key))]));
  const byTable = new Map();
  let dropped = 0;
  for (const r of Array.isArray(out?.rows) ? out.rows : []) {
    const t = allowTable.get(String(r?.table || '').trim());
    if (!t) { dropped++; continue; }
    const ok = allowField.get(t.table);
    const values = {};
    for (const [k, v] of Object.entries(r.values || {})) {
      if (ok.has(k) && v !== null && v !== undefined && String(v).trim() !== '') values[k] = String(v).trim();
    }
    if (!Object.keys(values).length) { dropped++; continue; }
    if (!byTable.has(t.table)) byTable.set(t.table, []);
    byTable.get(t.table).push(values);
  }
  const files = [];
  let rowCount = 0;
  for (const [table, rows] of byTable) {
    const t = allowTable.get(table);
    const headers = t.fields.map(f => f.name || f.key).filter(h => rows.some(r => h in r));
    if (!headers.length) continue;
    const csv = [headers.map(csvCell).join(',')]
      .concat(rows.map(r => headers.map(h => csvCell(r[h])).join(',')))
      .join('\n');
    files.push({ name: table + '.csv', content: csv, type: 'csv' });
    rowCount += rows.length;
  }
  return {
    note: String(out?.note || '').trim() || `读出 ${rowCount} 行`,
    files, rowCount, dropped,
    tables: [...byTable.keys()]
  };
}

/** 把识别结果落成能进解析链路的材料：
    表 → 字典 JSON（现有 dictionary 解析器直接吃），其余 → 流程描述文本。 */
export function visionToMaterial(imageName, result) {
  const stem = String(imageName).replace(/\.[^.]+$/, '');
  if (result.kind === 'table' && result.tables.length) {
    const tables = result.tables.map(t => ({
      name: String(t.name).trim(),
      label: String(t.label || t.name).trim(),
      description: String(t.description || '').trim(),
      fields: t.fields.map(f => ({
        name: String(f.name).trim(),
        label: String(f.name).trim(),
        type: f.type || 'string',
        key: !!f.key,
        description: String(f.description || '').trim()
      })),
      primaryKey: Array.isArray(t.primaryKey) ? t.primaryKey.filter(Boolean) : [],
      foreignKeys: [],
      rows: []
    }));
    return {
      file: { name: stem + '.json', content: JSON.stringify({ tables }, null, 2), type: 'dictionary' },
      note: `识别为 ${tables.length} 张表：${tables.map(t => t.name).join('、')}`
    };
  }
  const text = [
    `【图片材料：${imageName}】`,
    result.note ? `识别说明：${result.note}` : '',
    result.text
  ].filter(Boolean).join('\n');
  return {
    file: { name: stem + '.txt', content: text, type: 'process' },
    note: result.kind === 'unknown' ? '没从图里认出可用内容，已按文字材料收录' : '识别为文字材料'
  };
}
