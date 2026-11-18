import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT } from '../core/paths.mjs';
import { releaseFiles, isReleasePath } from './release-files.mjs';

const forbiddenPart = /^(?:data|uploads?|exports?|outputs?|samples?|fixtures?|node_modules|dist|coverage|\.git|\.aws|\.ssh|\.codex|\.agents|__MACOSX)$/i;
const forbiddenFile = /(?:^\.env(?:\.|$)|^model-config\.json$|^\.DS_Store$|\.local\.|\.(?:pem|key|p12|pfx|keystore|db|sqlite\w*|log|zip|gz|tar|json|jsonl|ndjson|csv|tsv|xlsx?|xlsm|owl|ttl|nt|rdf|rdfxml|pdf|docx|pptx)$)/i;
export const isSensitivePath = relative => relative !== 'package.json' && relative.split(/[\\/]/).some(part => forbiddenPart.test(part) || forbiddenFile.test(part));

const patterns = [
  ['私钥', /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/],
  ['服务密钥或令牌', /\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16}|AIza[A-Za-z0-9_-]{30,})\b/],
  ['带凭据的 URL', /\b[a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:[^\s/@]+@/i],
  ['本机个人目录', /(?:\/Users\/|\/home\/|[A-Z]:\\Users\\)[\p{L}\p{N}_.-]+/u],
  ['内网 IP', /\b(?:10\.\d+|192\.168|172\.(?:1[6-9]|2\d|3[01]))\.\d+\.\d+\b/],
  ['邮箱地址（需人工复核）', /\b[A-Za-z0-9._%+-]+@(?!example\.(?:com|org|net)\b)[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/],
  ['疑似硬编码凭据', /\b(?:api[_-]?key|access[_-]?token|client[_-]?secret|password|passwd)\b["']?\s*[:=]\s*["'](?!["']|\$\{|process\.)[^"'\r\n]+["']/i]
];

export function scanText(relative, text) {
  const findings = [];
  text.split(/\r?\n/).forEach((line, index) => {
    for (const [reason, pattern] of patterns) {
      if (pattern.test(line)) findings.push({ file: relative, line: index + 1, reason });
    }
  });
  return findings;
}

export async function checkRelease(root = ROOT) {
  const files = await releaseFiles(root);
  const issues = [];
  for (const required of ['LICENSE', 'README.md', '.gitignore', 'SECURITY.md', 'package.json']) {
    if (!files.includes(required)) issues.push({ file: required, reason: '缺少发布必需文件' });
  }
  for (const relative of files) {
    if (isSensitivePath(relative)) issues.push({ file: relative, reason: '禁止发布的数据或配置路径' });
    const bytes = await readFile(path.join(root, relative));
    if (bytes.includes(0)) issues.push({ file: relative, reason: '二进制文件须单独审查后才能发布' });
    else issues.push(...scanText(relative, bytes.toString('utf8')));
  }
  // .gitignore 不会保护已跟踪文件，也不会阻止 git add -f。
  const tracked = spawnSync('git', ['ls-files', '-z', '--cached', '--', '.'], { cwd: root, encoding: 'utf8' });
  if (tracked.status === 0) {
    for (const relative of tracked.stdout.split('\0').filter(Boolean)) {
      if (!isReleasePath(relative) || isSensitivePath(relative)) issues.push({ file: relative, reason: 'Git 已跟踪发布白名单以外或敏感的文件' });
    }
  } else {
    const gitContext = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: root, encoding: 'utf8' });
    if (gitContext.status === 0) issues.push({ file: '.git', reason: '无法读取 Git 跟踪列表，需人工检查' });
  }
  if (issues.length) {
    // 仅打印定位和类别；不把可能的密钥再次复制进日志。
    for (const item of issues) console.error(`${item.file}${item.line ? ':' + item.line : ''} · ${item.reason}`);
    throw Error(`发布检查未通过：${issues.length} 项待处理`);
  }
  console.log(`发布检查通过：${files.length} 个白名单文件。未扫描历史提交；规则扫描不能证明所有内容均可公开。`);
  return files;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { await checkRelease(); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}

