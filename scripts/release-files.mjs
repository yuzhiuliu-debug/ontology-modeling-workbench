import { readdir } from 'node:fs/promises';
import path from 'node:path';

// 发布采用白名单；运行目录即使已生成，也不会进入发布 ZIP。
const rootFiles = new Set([
  'package.json', 'server.mjs', 'check.mjs', 'README.md', 'LICENSE', 'SECURITY.md', 'SHA256SUMS',
  'THIRD_PARTY.md', '.gitignore', '.gitattributes',
  '00_先看这里.txt', '01_启动_Windows.bat', '02_启动_Mac.command',
  '03_一键自检_Windows.bat', '04_一键自检_Mac.command'
]);
const rootDirs = new Set(['core', 'public', 'tests', 'scripts', 'docs', '零安装速览', '.github']);

export function isReleasePath(relative) {
  const parts = relative.replaceAll('\\', '/').split('/');
  return parts.length === 1 ? rootFiles.has(parts[0]) : rootDirs.has(parts[0]);
}

export async function releaseFiles(root) {
  const files = [];
  async function walk(directory, prefix = '') {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      const relative = prefix ? prefix + '/' + entry.name : entry.name;
      if (!prefix && !rootFiles.has(entry.name) && !rootDirs.has(entry.name)) continue;
      if (entry.isSymbolicLink()) throw Error('发布目录中不允许符号链接：' + relative);
      if (entry.isDirectory()) await walk(path.join(directory, entry.name), relative);
      else if (entry.isFile()) files.push(relative);
      else throw Error('发布目录中存在特殊文件：' + relative);
    }
  }
  await walk(root);
  return files.sort();
}

