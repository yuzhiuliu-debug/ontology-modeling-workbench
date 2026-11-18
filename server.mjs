import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { exec } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getModelStatus, setModelConfig } from './core/ai.mjs';
import {
  createProject, getProject, listProjects, summarize, applyProposal, resolveConflicts,
  compileProject, parseOwlInto, exportFile, ConflictBlock, LedgerBlock,
  confirmLedger, decideProcess, publishProjectRules, runProjectRules, reviewHit, saveProjectRules,
  generateUnderstandingProject, finalizeUnderstandingProject, reopenUnderstandingProject, UnderstandingBlock,
  generateRuleSpecs, setRuleDialect, removeRuleSpec, loadInstanceData
} from './core/studio.mjs';
import { RulesBlocked } from './core/rules.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
const PUBLIC = path.join(ROOT, 'public');
const BASE_PORT = Number(process.env.PORT || 4188);
const HOST = process.env.STUDIO_HOST || '127.0.0.1';
let ACTIVE_PORT = BASE_PORT;
const MAX_BODY = 25 * 1024 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.png': 'image/png', '.map': 'application/json'
};

function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store' });
  res.end(body);
}
function text(res, status, body, type, filename) {
  const headers = { 'Content-Type': type + '; charset=utf-8', 'Cache-Control': 'no-store' };
  if (filename) headers['Content-Disposition'] = `attachment; filename="${filename}"`;
  res.writeHead(status, headers);
  res.end(body);
}
async function body(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY) throw Error('上传内容超过 25MB 限制，请拆分后再试');
    chunks.push(c);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw.trim()) return {};
  try { return JSON.parse(raw); }
  catch { throw Error('请求体不是合法 JSON'); }
}
async function serveStatic(res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const file = path.resolve(PUBLIC, rel);
  if (!file.startsWith(PUBLIC + path.sep) && file !== path.join(PUBLIC, 'index.html')) { text(res, 403, '禁止访问', 'text/plain'); return; }
  try {
    const buf = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(buf);
  } catch { text(res, 404, '页面文件不存在：' + rel, 'text/plain'); }
}

const server = http.createServer(async (req, res) => {
  const requestHost = req.headers.host || '';
  const configuredHost = HOST.includes(':') ? `[${HOST}]` : HOST;
  const allowedHosts = new Set([`${configuredHost}:${ACTIVE_PORT}`, `127.0.0.1:${ACTIVE_PORT}`, `localhost:${ACTIVE_PORT}`, `[::1]:${ACTIVE_PORT}`]);
  if (!allowedHosts.has(requestHost)) return json(res, 403, { error: '拒绝未知 Host' });
  if ((req.headers.origin && req.headers.origin !== `http://${requestHost}`) || req.headers['sec-fetch-site'] === 'cross-site')
    return json(res, 403, { error: '拒绝跨站请求' });
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) && req.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json')
    return json(res, 415, { error: '写入接口只接受 application/json' });
  let pathname;
  try { pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); }
  catch { return json(res, 400, { error: 'URL 无法解析' }); }
  const method = req.method || 'GET';
  try {
    if (pathname === '/api/health') return json(res, 200, { ok: true, service: 'ontology-modeling-workbench', version: '0.1.0', port: ACTIVE_PORT, at: new Date().toISOString() });
    if (pathname === '/api/model-config' && method === 'GET') return json(res, 200, await getModelStatus());
    if (pathname === '/api/model-config' && method === 'POST') return json(res, 200, await setModelConfig(await body(req)));
    if (pathname === '/api/projects' && method === 'GET') return json(res, 200, { projects: await listProjects() });
    if (pathname === '/api/projects' && method === 'POST') return json(res, 201, await createProject(await body(req)));

    const m = pathname.match(/^\/api\/projects\/(prj-[0-9a-f]{8})(\/[\w-]+)?$/);
    if (m) {
      const id = m[1], action = m[2] || '';
      if (!action && method === 'GET') return json(res, 200, summarize(await getProject(id)));
      if (action === '/proposal' && method === 'POST') return json(res, 200, await applyProposal(id, await body(req)));
      if (action === '/conflicts' && method === 'POST') return json(res, 200, await resolveConflicts(id, (await body(req)).decisions || []));
      if (action === '/understanding-generate' && method === 'POST') return json(res, 200, await generateUnderstandingProject(id, await body(req)));
      if (action === '/understanding-finalize' && method === 'POST') return json(res, 200, await finalizeUnderstandingProject(id, await body(req)));
      if (action === '/understanding-reopen' && method === 'POST') return json(res, 200, await reopenUnderstandingProject(id, await body(req)));
      if (action === '/confirm' && method === 'POST') return json(res, 200, await confirmLedger(id, await body(req)));
      if (action === '/process-decision' && method === 'POST') return json(res, 200, await decideProcess(id, await body(req)));
      if (action === '/rule-specs' && method === 'POST') return json(res, 200, await generateRuleSpecs(id, await body(req)));
      if (action === '/rule-specs-dialect' && method === 'POST') return json(res, 200, await setRuleDialect(id, await body(req)));
      if (action === '/rule-spec-remove' && method === 'POST') return json(res, 200, await removeRuleSpec(id, await body(req)));
      if (action === '/rules-save' && method === 'POST') return json(res, 200, await saveProjectRules(id, await body(req)));
      if (action === '/rules-publish' && method === 'POST') return json(res, 200, await publishProjectRules(id));
      if (action === '/rules-run' && method === 'POST') return json(res, 200, await runProjectRules(id));
      if (action === '/hit-review' && method === 'POST') return json(res, 200, await reviewHit(id, await body(req)));
      if (action === '/compile' && method === 'POST') return json(res, 200, await compileProject(id, await body(req)));
      if (action === '/instance-load' && method === 'POST') return json(res, 200, await loadInstanceData(id, await body(req)));
      if (action === '/parse-owl' && method === 'POST') return json(res, 200, await parseOwlInto(id, await body(req)));
      if (action === '/export' && method === 'GET') {
        const p = await getProject(id);
        const format = new URL(req.url, 'http://localhost').searchParams.get('format') || 'owl';
        const f = exportFile(p, format);
        return text(res, 200, f.body, f.type, f.name);
      }
      return json(res, 404, { error: '接口不存在：' + pathname });
    }
    if (pathname.startsWith('/api/')) return json(res, 404, { error: '接口不存在：' + pathname });
    if (method !== 'GET' && method !== 'HEAD') return json(res, 405, { error: '仅支持 GET' });
    return await serveStatic(res, pathname);
  } catch (e) {
    const status = (e instanceof ConflictBlock || e instanceof LedgerBlock || e instanceof RulesBlocked || e instanceof UnderstandingBlock) ? 409
      : (/不存在|无效|过短|不是合法|无法|拒绝|必须|只允许|不支持|尚未|缺少|超过|填写|请先|请选择|没有可/.test(e.message) ? 400 : 500);
    if (status === 500) console.error('[studio]', e);
    return json(res, status, {
      error: e.message || '服务端异常',
      ...(e.conflicts ? { conflicts: e.conflicts } : {}),
      ...(e.items ? { items: e.items } : {}),
      ...(e.blocked ? { blocked: e.blocked } : {})
    });
  }
});

/** 端口被占用时自动顺延，避免同事机器上打不开；启动脚本可据此自动打开正确地址 */
server.on('error', err => {
  if (err.code !== 'EADDRINUSE') console.error('  [studio] 服务异常：' + err.message);
});

function listen(port, attempt = 0) {
  const onListening = () => {
    server.removeListener('error', onError);
    ACTIVE_PORT = port;
    const url = `http://${HOST}:${port}/`;
    console.log(`\n  ============================================\n  本体建模工作台已启动\n  请在浏览器打开： ${url}\n  健康检查：      ${url}api/health\n  关闭服务：      在本窗口按 Ctrl + C\n  ============================================\n`);
    if (process.env.STUDIO_OPEN === '1') {
      const cmd = process.platform === 'win32' ? `start "" "${url}"`
        : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
      exec(cmd, () => {});
    }
  };
  const onError = err => {
    // 关键：移除上一次 listen 留下的 listening 回调，否则重试成功时会重复打印旧端口
    server.removeListener('listening', onListening);
    if (err.code === 'EADDRINUSE' && attempt < 12) {
      console.log(`  端口 ${port} 已被占用，尝试 ${port + 1} …`);
      listen(port + 1, attempt + 1);
    } else {
      console.error('  启动失败：' + err.message);
      process.exit(1);
    }
  };
  server.once('listening', onListening);
  server.once('error', onError);
  server.listen(port, HOST);
}
listen(BASE_PORT);
