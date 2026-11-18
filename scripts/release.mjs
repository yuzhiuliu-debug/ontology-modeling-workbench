import { mkdir, readFile, writeFile } from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';
import { ROOT } from '../core/paths.mjs';
import { checkRelease } from './release-check.mjs';

// 使用 ZIP 的存储模式，无压缩依赖；保留 Mac 启动脚本的可执行权限。
const crcTable = Array.from({ length: 256 }, (_, n) => {
  for (let k = 0; k < 8; k++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n >>> 0;
});
const crc32 = bytes => {
  let n = 0xffffffff;
  for (const byte of bytes) n = crcTable[(n ^ byte) & 255] ^ (n >>> 8);
  return (n ^ 0xffffffff) >>> 0;
};

const files = await checkRelease();
const entries = [];
const manifest = [];
for (const file of files) {
  if (file === 'SHA256SUMS') continue; // 从解压后的源码再次打包时重新生成，不重复收录旧清单。
  const data = await readFile(path.join(ROOT, file));
  entries.push({ file, data });
  manifest.push(crypto.createHash('sha256').update(data).digest('hex') + '  ' + file);
}
entries.push({ file: 'SHA256SUMS', data: Buffer.from(manifest.join('\n') + '\n') });

const locals = [], central = [];
let offset = 0;
for (const { file, data } of entries) {
  const name = Buffer.from('ontology-modeling-workbench/' + file);
  const crc = crc32(data);
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4); header.writeUInt16LE(0x800, 6);
  header.writeUInt16LE(33, 12); // 1980-01-01，保证相同源码可复现相同 ZIP
  header.writeUInt32LE(crc, 14); header.writeUInt32LE(data.length, 18); header.writeUInt32LE(data.length, 22);
  header.writeUInt16LE(name.length, 26);
  const record = Buffer.alloc(46);
  record.writeUInt32LE(0x02014b50, 0);
  record.writeUInt16LE(0x0314, 4); record.writeUInt16LE(20, 6); record.writeUInt16LE(0x800, 8);
  record.writeUInt16LE(33, 14);
  record.writeUInt32LE(crc, 16); record.writeUInt32LE(data.length, 20); record.writeUInt32LE(data.length, 24);
  record.writeUInt16LE(name.length, 28);
  record.writeUInt32LE(((file.endsWith('.command') ? 0o100755 : 0o100644) * 65536) >>> 0, 38);
  record.writeUInt32LE(offset, 42);
  locals.push(header, name, data); central.push(record, name);
  offset += header.length + name.length + data.length;
}
const centralData = Buffer.concat(central);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
end.writeUInt32LE(centralData.length, 12); end.writeUInt32LE(offset, 16);
const output = path.join(ROOT, 'dist', 'ontology-modeling-workbench-source.zip');
await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, Buffer.concat([...locals, centralData, end]));
console.log('已生成源码发布包：' + path.relative(ROOT, output));

