/* 零依赖 XLSX 读取器：只用 Node 内置 zlib，不装第三方包、不调系统命令。
   读取 zip 容器 → workbook.xml / rels / sharedStrings / worksheets，
   输出含隐藏 sheet、合并单元格、公式单元格信息的行列矩阵。 */
import { inflateRawSync } from 'node:zlib';

const U16 = (b, o) => b.readUInt16LE(o);
const U32 = (b, o) => b.readUInt32LE(o);

/** 解析 zip central directory，返回 name → Buffer */
export function readZip(buf) {
  if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf);
  let eocd = -1;
  const min = Math.max(0, buf.length - 65557);
  for (let i = buf.length - 22; i >= min; i--) {
    if (U32(buf, i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw Error('不是有效的 xlsx/zip 文件：未找到目录结束标记');
  const count = U16(buf, eocd + 10);
  let cursor = U32(buf, eocd + 16);
  const out = new Map();
  for (let n = 0; n < count; n++) {
    if (U32(buf, cursor) !== 0x02014b50) break;
    const method = U16(buf, cursor + 10);
    const csize = U32(buf, cursor + 20);
    const nameLen = U16(buf, cursor + 28);
    const extraLen = U16(buf, cursor + 30);
    const commentLen = U16(buf, cursor + 32);
    const local = U32(buf, cursor + 42);
    const name = buf.toString('utf8', cursor + 46, cursor + 46 + nameLen);
    if (U32(buf, local) === 0x04034b50) {
      const lNameLen = U16(buf, local + 26);
      const lExtraLen = U16(buf, local + 28);
      const start = local + 30 + lNameLen + lExtraLen;
      const raw = buf.subarray(start, start + csize);
      if (!name.endsWith('/')) {
        out.set(name, method === 8 ? inflateRawSync(raw) : method === 0 ? Buffer.from(raw) : null);
      }
    }
    cursor += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/* 轻量 XML 树：够用即可，支持中文标签名、自闭合、注释、CDATA */
function xmlTree(xml) {
  const root = { name: '#root', attrs: {}, children: [], text: '' }, stack = [root];
  const re = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[[\s\S]*?\]\]>|<\/([^\s<>]+)\s*>|<([^\s<>\/]+)((?:\s+[^\s=<>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
  let m;
  while ((m = re.exec(xml))) {
    const raw = m[0];
    if (raw.startsWith('<!--') || raw.startsWith('<?') || raw.startsWith('<!')) {
      if (raw.startsWith('<![CDATA[')) stack[stack.length - 1].text += raw.slice(9, -3);
      continue;
    }
    if (m[1]) { if (stack.length > 1) stack.pop(); continue; }
    if (m[2]) {
      const attrs = {}, ar = /([^\s=<>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
      let a;
      while ((a = ar.exec(m[3] || ''))) attrs[a[1]] = dec(a[2] !== undefined ? a[2] : a[3] || '');
      const node = { name: m[2], attrs, children: [], text: '' };
      stack[stack.length - 1].children.push(node);
      if (!m[4]) stack.push(node);
      continue;
    }
    if (m[5]) stack[stack.length - 1].text += dec(m[5]);
  }
  return root;
}
const dec = s => String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).replace(/&amp;/g, '&');
const local = n => String(n).split(':').pop();
function findAll(node, name) {
  const out = [];
  (function walk(n) { for (const c of n.children) { if (local(c.name) === name) out.push(c); walk(c); } })(node);
  return out;
}
const textOf = node => (node?.text || '') + (node?.children || []).map(textOf).join('');
const colIndex = ref => {
  const m = String(ref || '').match(/^([A-Z]+)/i);
  if (!m) return 0;
  let n = 0;
  for (const ch of m[1].toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
};

/** 主入口：Buffer/ArrayBuffer → sheet 矩阵 */
export function readWorkbook(input) {
  const zip = readZip(input);
  const str = name => {
    const b = zip.get(name);
    return b ? b.toString('utf8') : '';
  };
  const shared = [];
  const sstRaw = str('xl/sharedStrings.xml');
  if (sstRaw) {
    const sst = xmlTree(sstRaw);
    for (const si of findAll(sst, 'si')) shared.push(textOf(si));
  }
  const rels = new Map();
  const relRaw = str('xl/_rels/workbook.xml.rels');
  if (relRaw) {
    const tree = xmlTree(relRaw);
    for (const r of findAll(tree, 'Relationship')) {
      const target = r.attrs.Target || '';
      rels.set(r.attrs.Id, target.startsWith('/') ? target.slice(1) : 'xl/' + target.replace(/^\.\//, ''));
    }
  }
  const wb = xmlTree(str('xl/workbook.xml'));
  const sheets = [];
  for (const s of findAll(wb, 'sheet')) {
    const rid = s.attrs['r:id'] || s.attrs.id || '';
    const target = rels.get(rid) || 'xl/worksheets/sheet' + (sheets.length + 1) + '.xml';
    sheets.push({ name: s.attrs.name || ('Sheet' + (sheets.length + 1)), hidden: /hidden|veryHidden/i.test(s.attrs.state || ''), sheetId: s.attrs.sheetId, target });
  }
  for (const sheet of sheets) {
    const xml = str(sheet.target);
    if (!xml) { sheet.rows = []; sheet.merges = []; sheet.formulaCells = []; continue; }
    const tree = xmlTree(xml);
    const merges = findAll(tree, 'mergeCell').map(m => m.attrs.ref).filter(Boolean);
    const formulaCells = [];
    const rows = [];
    for (const row of findAll(tree, 'row')) {
      const r = Number(row.attrs.r || rows.length + 1);
      const cells = rows[r - 1] || (rows[r - 1] = []);
      for (const c of row.children.filter(x => local(x.name) === 'c')) {
        const ci = colIndex(c.attrs.r);
        const t = c.attrs.t || '';
        const vNode = c.children.find(x => local(x.name) === 'v');
        const fNode = c.children.find(x => local(x.name) === 'f');
        const isNode = c.children.find(x => local(x.name) === 'is');
        let value = '';
        if (t === 's') value = shared[Number(vNode?.text || -1)] ?? '';
        else if (t === 'inlineStr') value = textOf(isNode);
        else if (t === 'b') value = (vNode?.text === '1') ? 'TRUE' : 'FALSE';
        else value = vNode?.text ?? textOf(isNode);
        value = dec(String(value));
        // 伪公式：错误单元格（#NAME? 等）、以 = 开头的说明文字、或公式求值为空
        const isError = t === 'e' || /^#[A-Z!?]+$/.test(value);
        if (isError) {
          const desc = fNode ? textOf(fNode) : value.replace(/^=/, '');
          formulaCells.push({ ref: c.attrs.r, formula: desc, value: '', pseudo: true });
          value = '';
        } else if (fNode) {
          formulaCells.push({ ref: c.attrs.r, formula: textOf(fNode), value });
          if (!value) formulaCells[formulaCells.length - 1].pseudo = true;
        } else if (/^=/.test(value)) {
          formulaCells.push({ ref: c.attrs.r, formula: value.slice(1), value: '', pseudo: true });
          value = '';
        }
        cells[ci] = value;
      }
    }
    sheet.rows = rows;
    sheet.merges = merges;
    sheet.formulaCells = formulaCells;
    sheet.maxRow = rows.length;
    sheet.maxCol = rows.reduce((n, r) => Math.max(n, (r || []).length), 0);
  }
  return { sheets, sharedStringCount: shared.length };
}
