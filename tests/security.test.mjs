import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const temporary = await mkdtemp(path.join(tmpdir(), 'ontology-security-tests-'));
process.env.STUDIO_DATA_DIR = temporary;
const { getModelStatus, setModelConfig, callModel, callVision } = await import('../core/ai.mjs');
const { CONFIG_FILE } = await import('../core/paths.mjs');
const { DATA_DIR } = await import('../core/store.mjs');
const { scanText, isSensitivePath } = await import('../scripts/release-check.mjs');
const { isReleasePath } = await import('../scripts/release-files.mjs');
after(async () => { await rm(temporary, { recursive: true, force: true }); });

test('空白安装不创建配置、不预置模型、不发起模型请求', async () => {
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => { requests++; throw Error('不应发生外发请求'); };
  try {
    const status = await getModelStatus();
    assert.equal(status.provider, ''); assert.equal(status.baseUrl, ''); assert.equal(status.model, '');
    assert.equal(status.configured, false); assert.equal(status.hasKey, false);
    assert.equal('apiKey' in status, false);
    await assert.rejects(readFile(CONFIG_FILE), { code: 'ENOENT' });
    await assert.rejects(callModel([]), /尚未配置模型密钥/);
    await assert.rejects(callVision([]), /尚未配置模型密钥/);
    assert.equal(requests, 0);
    assert.equal(DATA_DIR, path.join(temporary, 'jobs'));
  } finally { globalThis.fetch = originalFetch; }
});

test('用户配置校验、密钥隐藏、文件权限及清除；图片不暗换模型', async () => {
  await assert.rejects(setModelConfig({ baseUrl: 'http://model.example.org' }), /HTTPS/);
  await assert.rejects(setModelConfig({ baseUrl: 'https://model.example.org' }), /自定义/);
  await assert.rejects(setModelConfig({ baseUrl: 'https://model.example.org?credential=anything', allowCustomEndpoint: true }), /查询参数/);
  const credential = crypto.randomUUID(); // 每次测试生成，不能访问任何真实服务。
  const status = await setModelConfig({
    provider: '自定义兼容接口', baseUrl: 'https://model.example.org', model: 'selected-model',
    apiKey: credential, allowCustomEndpoint: true
  });
  assert.equal(status.configured, true); assert.equal('apiKey' in status, false);
  assert.equal(JSON.stringify(status).includes(credential), false);
  const saved = JSON.parse(await readFile(CONFIG_FILE, 'utf8'));
  assert.equal(saved.apiKey, credential);
  if (process.platform !== 'win32') assert.equal((await stat(CONFIG_FILE)).mode & 0o777, 0o600);
  const originalFetch = globalThis.fetch;
  let selectedModel;
  globalThis.fetch = async (url, options) => {
    assert.equal(url, 'https://model.example.org/v1/chat/completions');
    assert.equal(options.headers.Authorization, 'Bearer ' + credential);
    selectedModel = JSON.parse(options.body).model;
    return { ok: true, json: async () => ({ choices: [{ message: { content: '{}' } }] }) };
  };
  try { await callVision([]); assert.equal(selectedModel, 'selected-model'); }
  finally { globalThis.fetch = originalFetch; }
  const cleared = await setModelConfig({ clearKey: true });
  assert.equal(cleared.hasKey, false); assert.equal(cleared.configured, false);
  assert.equal(JSON.parse(await readFile(CONFIG_FILE, 'utf8')).apiKey, '');
});

test('发布边界排除数据、配置、证书、导出物和隐藏目录', () => {
  for (const file of ['data/projects/project.json', '.env', 'model-config.json', 'exports/model.owl', 'public/private.key', '.aws/credentials']) {
    assert.equal(isSensitivePath(file), true, file);
  }
  assert.equal(isReleasePath('data/projects/project.json'), false);
  assert.equal(isReleasePath('public/app.js'), true);
  assert.equal(isSensitivePath('public/app.js'), false);
});

test('发布检查能定位凭据且不输出匹配内容', () => {
  const credential = ['sk', crypto.randomBytes(18).toString('hex')].join('-');
  const findings = scanText('public/unsafe.js', 'const credential = ' + JSON.stringify(credential));
  assert.ok(findings.some(f => f.reason === '服务密钥或令牌'));
  assert.equal(JSON.stringify(findings).includes(credential), false);
  assert.equal(scanText('core/empty.mjs', "const config = { apiKey: '' };").length, 0);
});
