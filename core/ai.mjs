import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { CONFIG_FILE } from './paths.mjs';
import { PROMPTS, buildMessages, buildUnderstandingMessages, buildUnderstandingTablesMessages, buildUnderstandingGraphMessages, buildRuleMessages } from './prompts.mjs';
import { UNDERSTANDING_CONTRACT, validateUnderstanding } from './understanding.mjs';
import { RULE_CONTRACT, RULE_RULES } from './rulespec.mjs';

const DEFAULT_CONFIG = {
  provider: '',
  baseUrl: '',
  model: '',
  apiKey: '',
  allowCustomEndpoint: false,
  maxTokens: 8192
};

/* 这是应用的输出预算；实际支持的上限由用户所选模型决定。 */
const DEFAULT_MAX_TOKENS = 8192;
const HARD_MAX_TOKENS = 262144;

/** 模型输出被截断：JSON 没写完，不能当成「格式错误」糊弄过去 */
export class ModelTruncatedError extends Error {
  constructor(message, partial) {
    super(message);
    this.name = 'ModelTruncatedError';
    this.truncated = true;
    this.partial = partial || '';
  }
}

/** 把写了一半的 JSON 尽量救回来：补齐未闭合的括号，并丢掉「正在写、还没写完」的那一个元素。
    只用于「截断」这一种情况，补救结果仍要过 validateUnderstanding。
    原则：宁可少一条，也不留半条（半条表名+空含义比没有更误导人）。 */
export function salvageJson(text) {
  const src = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try { return JSON.parse(src); } catch { /* 继续尝试修复 */ }

  /* 扫描一遍，记下每个仍打开的容器，以及它「当前元素的起点」 */
  const stack = [];
  let inString = false, escaped = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') { inString = true; continue; }
    if (c === '{' || c === '[') { stack.push({ ch: c, elemStart: i + 1 }); continue; }
    if (c === '}' || c === ']') { stack.pop(); continue; }
    if (c === ',' && stack.length) stack[stack.length - 1].elemStart = i + 1;
  }

  const closeAll = s => {
    const closers = [];
    let str = false, esc = false;
    for (const c of s) {
      if (str) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') str = false; continue; }
      if (c === '"') str = true;
      else if (c === '{' || c === '[') closers.push(c === '{' ? '}' : ']');
      else if (c === '}' || c === ']') closers.pop();
    }
    let body = s;
    if (str) body = body.replace(/,?\s*"[^"]*$/, '');   // 尾巴上还没写完的键名/字符串整段丢掉
    return body.replace(/,\s*$/, '') + closers.reverse().join('');
  };

  if (!stack.length) {
    const r = closeAll(src);
    try { return JSON.parse(r); } catch { return null; }
  }

  const inner = stack[stack.length - 1];
  const parent = stack[stack.length - 2];
  let cutAt;
  if (inner.ch === '[') cutAt = inner.elemStart;                       // 正在写数组元素
  else if (parent && parent.ch === '[') cutAt = parent.elemStart;      // 正在写数组里的对象：整条丢掉
  else cutAt = inner.elemStart;                                       // 正在写对象字段：丢掉这个字段
  const repaired = closeAll(src.slice(0, cutAt));
  try { return JSON.parse(repaired); } catch { return null; }
}

async function readConfig() {
  try { return { ...DEFAULT_CONFIG, ...JSON.parse(await readFile(CONFIG_FILE, 'utf8')) }; }
  catch { return { ...DEFAULT_CONFIG }; }
}
async function writeConfig(cfg) {
  await mkdir(path.dirname(CONFIG_FILE), { recursive: true, mode: 0o700 });
  await writeFile(CONFIG_FILE, JSON.stringify(cfg, null, 2), { encoding: 'utf8', mode: 0o600 });
}

/** 对外状态：密钥永不回传 */
export async function getModelStatus() {
  const c = await readConfig();
  return {
    provider: c.provider, baseUrl: c.baseUrl, model: c.model,
    hasKey: !!c.apiKey, configured: !!(c.apiKey && c.baseUrl && c.model),
    maxTokens: Number(c.maxTokens || DEFAULT_MAX_TOKENS),
    allowCustomEndpoint: !!c.allowCustomEndpoint,
    endpointNote: '未预置服务商、地址、模型或密钥。仅允许 HTTPS；自定义兼容接口需显式开启。',
    workstations: PROMPTS.workstations,
    commonRules: PROMPTS.commonRules,
    timingRules: PROMPTS.timingRules,
    understandingRules: PROMPTS.understandingRules
  };
}

export async function setModelConfig(input = {}) {
  const cur = await readConfig();
  const next = {
    ...cur,
    provider: String(input.provider ?? cur.provider).trim().slice(0, 60),
    baseUrl: String(input.baseUrl ?? cur.baseUrl).trim(),
    model: String(input.model ?? cur.model).trim(),
    maxTokens: (() => {
      const n = Number(input.maxTokens);
      if (!Number.isFinite(n) || n <= 0) return Number(cur.maxTokens) || DEFAULT_MAX_TOKENS;
      return Math.min(Math.max(Math.round(n), 512), HARD_MAX_TOKENS);
    })(),
    allowCustomEndpoint: input.allowCustomEndpoint === undefined ? cur.allowCustomEndpoint : !!input.allowCustomEndpoint
  };
  if (input.apiKey !== undefined && String(input.apiKey).trim()) next.apiKey = String(input.apiKey).trim();
  if (input.clearKey) next.apiKey = '';
  if (next.apiKey && (!next.baseUrl || !next.model || !next.provider))
    throw Error('请填写服务商、服务地址和模型名后再保存密钥');
  if (next.baseUrl) {
    let u;
    try { u = new URL(next.baseUrl); } catch { throw Error('模型服务地址不是合法 URL'); }
    if (u.protocol !== 'https:') throw Error('模型服务地址必须使用 HTTPS');
    if (u.username || u.password || u.search || u.hash) throw Error('模型服务地址不能包含账号、密码、查询参数或片段');
    if (u.origin !== 'https://api.deepseek.com' && !next.allowCustomEndpoint)
      throw Error('使用自定义兼容接口请勾选「允许自定义 HTTPS 地址」。');
  }
  await writeConfig(next);
  return getModelStatus();
}

function chatEndpoint(baseUrl) {
  const u = new URL(baseUrl);
  let p = u.pathname.replace(/\/+$/, '');
  if (p.endsWith('/chat/completions')) return u.origin + p;
  if (!p || p === '/') p = '/v1';
  if (!p.endsWith('/v1')) p += '/v1';
  return u.origin + p + '/chat/completions';
}

/** 发一次 chat/completions，返回解析好的 JSON。文本和图片共用这一段。 */
async function postChat(cfg, body, cap) {
  const url = chatEndpoint(cfg.baseUrl);
  let res;
  try {
    res = await fetch(url, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(180000),
      headers: { Authorization: 'Bearer ' + cfg.apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
  } catch (e) { throw Error('暂时无法连接模型服务，请检查网络与地址：' + (e?.message || e)); }
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 300);
    throw Error(`模型服务返回 ${res.status}：${detail || '无返回内容'}`);
  }
  const payload = await res.json();
  const choice = payload?.choices?.[0] || {};
  const raw = choice?.message?.content;
  if (typeof raw !== 'string' || !raw.trim()) throw Error('模型返回内容为空，请重试。');
  const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const usage = payload?.usage || {};
  try { return JSON.parse(cleaned); }
  catch {
    /* 关键区分：是「写不下被截断」还是「模型没按 JSON 说」。两者的处置完全不同，
       以前都报「不是合法 JSON」，于是被误当成密钥问题。 */
    if (choice.finish_reason === 'length' || usage.completion_tokens >= cap) {
      throw new ModelTruncatedError(
        `模型输出达到 ${cap} tokens 上限被截断，JSON 没写完（已写 ${raw.length} 字）。`, raw);
    }
    const head = cleaned.slice(0, 80).replace(/\s+/g, ' ');
    throw Error(`模型返回不是合法 JSON（开头：「${head}…」）。`);
  }
}

/** 只让模型返回结构化语义提案；格式生成完全由确定性代码负责 */
export async function callModel(messages, { maxTokens } = {}) {
  const cfg = await readConfig();
  if (!cfg.apiKey) throw Error('尚未配置模型密钥。可先使用「确定性草案」，或在「模型配置」中填入密钥。');
  if (!cfg.baseUrl || !cfg.model) throw Error('尚未配置模型服务地址或模型名');
  const cap = Math.min(
    Math.max(Number(maxTokens || cfg.maxTokens || process.env.STUDIO_MAX_TOKENS || DEFAULT_MAX_TOKENS), 512),
    HARD_MAX_TOKENS
  );
  const body = {
    model: cfg.model, messages, stream: false, temperature: 0.2, max_tokens: cap,
    response_format: { type: 'json_object' }
  };
  if (cfg.provider === 'DeepSeek') body.thinking = { type: 'disabled' };
  return postChat(cfg, body, cap);
}

/** 图片使用用户明确配置的模型；用户需自行确认模型支持图片输入。 */
export async function callVision(messages, { maxTokens, model } = {}) {
  const cfg = await readConfig();
  if (!cfg.apiKey) throw Error('尚未配置模型密钥。图片识别需要配置支持图片输入的模型。');
  if (!cfg.baseUrl || !cfg.model) throw Error('尚未配置模型服务地址或模型名');
  const visionModel = model || cfg.model;
  const cap = Math.min(Math.max(Number(maxTokens || 8192), 1024), HARD_MAX_TOKENS);
  const body = {
    model: visionModel, messages, stream: false, temperature: 0.1, max_tokens: cap,
    response_format: { type: 'json_object' }
  };
  if (cfg.provider === 'DeepSeek') body.thinking = { type: 'disabled' };
  return postChat(cfg, body, cap);
}

const isOwlText = s => /<Ontology[\s>]|@prefix\s+\w+:|owl:Class|rdf:type|<\?xml/i.test(String(s || ''));

/** 服务端强校验：模型提案不得越界，不得夹带格式产物，端点必须能落回已上传的表 */
export function validateProposal(proposal, model) {
  const warnings = [];
  if (!proposal || typeof proposal !== 'object' || Array.isArray(proposal)) throw Error('提案不是 JSON 对象');
  const keys = ['classes', 'relations', 'constraints', 'glossary', 'conflicts'];
  for (const k of keys) if (proposal[k] !== undefined && !Array.isArray(proposal[k])) throw Error(`提案字段 ${k} 必须是数组`);
  const flat = JSON.stringify(proposal);
  if (isOwlText(flat)) throw Error('提案中夹带 OWL/XML、Turtle 或 RDF 文本，已拒绝：格式生成只能由确定性代码完成。');

  const tableNames = new Set(model.classes.map(c => c.sourceTable));
  const resolve = key => model.classes.find(c => c.id === key || c.sourceTable === key || c.localName === key || c.iri === key);
  const segIds = new Set(model.processSegments.map(s => s.id));
  const checkRefs = (label, refs) => {
    if (!Array.isArray(refs)) return;
    for (const r of refs) {
      const sid = typeof r === 'string' ? r : r?.segmentId;
      if (sid && !segIds.has(sid)) warnings.push(`${label} 引用了无法定位的流程片段 ${sid}`);
    }
  };

  const classes = (proposal.classes || []).filter((c, i) => {
    if (!c || typeof c !== 'object') return false;
    if (c.table && !tableNames.has(c.table)) { warnings.push(`classes[${i}].table「${c.table}」不在已上传表清单中，已丢弃`); return false; }
    checkRefs(`classes[${i}]`, c.sourceRefs);
    return true;
  }).slice(0, 300);
  const relations = (proposal.relations || []).filter((r, i) => {
    if (!r || typeof r !== 'object') return false;
    if (!resolve(r.from) || !resolve(r.to)) { warnings.push(`relations[${i}] 端点「${r.from} → ${r.to}」无法对应到已录入的表/对象，已丢弃`); return false; }
    checkRefs(`relations[${i}]`, r.sourceRefs);
    return true;
  }).slice(0, 400);
  const constraints = (proposal.constraints || []).slice(0, 120).filter(c => c && typeof c === 'object' && !isOwlText(c.text));
  const glossary = (proposal.glossary || []).slice(0, 120).filter(g => g && typeof g === 'object');
  const conflicts = (proposal.conflicts || []).slice(0, 60).filter(c => c && typeof c === 'object');
  for (const c of conflicts) checkRefs('conflicts', c.sourceRefs);
  return {
    proposal: { classes, relations, constraints, glossary, conflicts },
    warnings,
    stats: { classes: classes.length, relations: relations.length, constraints: constraints.length, glossary: glossary.length, conflicts: conflicts.length }
  };
}

/** 无密钥时的确定性草案：只做表结构归纳与流程原文规则抽取，不冒充 AI 语义推断 */
export function draftProposal(model) {
  const segs = model.processSegments || [];
  const ruleRe = /(必须|不得|应当|应|禁止|不允许|一致|早于|晚于|不得晚于|不得早于|需要经过|需经)/;
  const constraints = [];
  for (const s of segs) {
    const sentences = String(s.text || '').split(/[\n。；;]/).map(x => x.trim()).filter(x => x.length >= 8 && x.length <= 160 && ruleRe.test(x));
    for (const text of sentences.slice(0, 2)) {
      if (constraints.some(c => c.text === text)) continue;
      constraints.push({ kind: 'businessRule', target: '', text, sourceRefs: [s.id], confidence: 'medium' });
    }
    if (constraints.length >= 14) break;
  }
  const relations = [];
  for (const p of model.objectProperties) {
    if (!p.sourceTable || !p.refTable || relations.length >= 8) continue;
    const from = model.classes.find(c => c.sourceTable === p.sourceTable);
    const to = model.classes.find(c => c.sourceTable === p.refTable);
    if (!from || !to) continue;
    const hit = segs.find(s => {
      const t = (s.heading || '') + (s.text || '');
      return t.includes(from.localName) && t.includes(to.localName) && t.length < 2200;
    });
    if (!hit) continue;
    const key = p.sourceTable + '|' + p.refTable;
    if (relations.some(r => r._key === key)) continue;
    relations.push({
      _key: key, from: p.sourceTable, to: p.refTable,
      label: `${from.localName}→${to.localName}（流程口径）`,
      description: `依据流程片段「${hit.heading}」与外键 ${p.sourceTable} → ${p.refTable} 共同推定，需人工确认。`,
      sourceRefs: [hit.id], confidence: 'low'
    });
  }
  for (const r of relations) delete r._key;
  const glossary = [];
  const classes = model.classes.slice(0, 60).map(c => ({
    table: c.sourceTable, label: c.localName,
    description: c.description || `来自表 ${c.sourceTable} 的业务对象`,
    sourceRefs: [], confidence: 'high', notes: '确定性草案：名称直接取自表结构注释'
  }));
  return {
    classes, relations, constraints, glossary, conflicts: [],
    _mode: 'draft',
    _note: '确定性草案：仅归纳表结构、抽取流程原文中的规则句，并对流程与外键共同指向的关联给出低置信度候选。业务语义关系与类层级需接入模型或人工补全。'
  };
}

/** 统一提案入口：mode=ai 走模型，mode=draft 走本地草案；AI 失败不静默降级 */
/** 大模型位置一：业务理解稿。无密钥直接抛错，由上层引导到手工建模，绝不生成伪稿 */
export async function proposeUnderstanding(model, { description = '' } = {}) {
  const rowsBy = model.rowsByTable || {};
  const samples = {};
  const tableInput = (model.classes || []).map(c => ({
    name: c.sourceTable, label: c.localName, description: c.description || '',
    fields: (model.dataProperties || []).filter(p => p.sourceTable === c.sourceTable).map(p => ({
      name: p.sourceColumn || p.localName, label: p.localName, type: String(p.range || '').split('#').pop(),
      required: !!p.required, description: p.description || ''
    })),
    primaryKey: c.primaryKey || [],
    foreignKeys: (model.objectProperties || []).filter(p => p.sourceTable === c.sourceTable)
      .map(p => ({ fields: p.sourceColumns || [], refTable: p.refTable || '', refFields: p.refColumns || [] }))
  }));
  for (const t of tableInput) {
    samples[t.name] = (rowsBy[t.sourceTable] || []).slice(0, 5)
      .map(r => Object.fromEntries(Object.entries(r).slice(0, 8)));
  }
  const segments = (model.processSegments || []).slice(0, 30);
  const warnings = [];
  let splitNote = '';

  const full = buildUnderstandingMessages({ description, tables: tableInput, samples, segments, contract: UNDERSTANDING_CONTRACT });
  let raw;
  try {
    raw = await callModel(full);
  } catch (e) {
    if (!e?.truncated) throw e;
    /* 表多、字段多的时候一次性写完会超出输出上限。不能直接失败，也不能只留半截：
       1) 先把已经写出来的表理解救回来（不浪费）；
       2) 剩下的表按小批补写；
       3) 关系与链路单独用「表摘要」再问一次，输出体积小一个量级。 */
    const partial = salvageJson(e.partial) || {};
    const got = Array.isArray(partial.tables) ? partial.tables.filter(t => t && (t.table || t.name)) : [];
    const covered = new Set(got.map(t => String(t.table || t.name).trim()));
    const missing = tableInput.filter(t => !covered.has(t.name));
    const CHUNK = 5;
    const batches = [];
    for (let i = 0; i < missing.length; i += CHUNK) batches.push(missing.slice(i, i + CHUNK));

    const extraTables = [];
    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i];
      const subSamples = Object.fromEntries(batch.map(t => [t.name, samples[t.name] || []]));
      const res = await callModel(
        buildUnderstandingTablesMessages({
          description, tables: batch, samples: subSamples, segments, part: i + 1, total: batches.length
        }),
        { maxTokens: 8192 }
      );
      for (const t of (Array.isArray(res?.tables) ? res.tables : [])) extraTables.push(t);
    }

    let graph = {};
    try {
      graph = await callModel(buildUnderstandingGraphMessages({
        description,
        tables: tableInput.map(t => {
          const hit = [...got, ...extraTables].find(x => String(x.table || x.name).trim() === t.name) || {};
          return { ...t, meaning: hit.meaning || '', stage: hit.stage || '' };
        }),
        segments
      })) || {};
    } catch (e2) {
      if (!e2?.truncated) throw e2;
      const saved = salvageJson(e2.partial) || {};
      graph = saved;
      warnings.push('链路与业务关系这一段输出仍被截断，已保留写出的部分；未覆盖的关系请在草稿图谱上补。');
    }

    raw = {
      tables: got.concat(extraTables),
      stages: graph.stages || partial.stages || [],
      relations: graph.relations || [],
      idDependencies: graph.idDependencies || partial.idDependencies || [],
      gaps: (graph.gaps || []).concat(partial.gaps || []),
      uncertainties: (graph.uncertainties || []).concat(partial.uncertainties || [])
    };
    splitNote = `输入较大（${tableInput.length} 张表），一次性生成会超出模型输出上限，已自动分批生成`
      + (batches.length ? `（续写 ${batches.length} 批）` : '') + '；请逐表核对覆盖是否完整。';
    warnings.push(splitNote);
  }

  const checked = validateUnderstanding(raw, model);
  const out = checked.understanding;

  /* 覆盖兜底：模型漏掉的表也要出现在稿子里（明确标「未指定」），
     否则用户在列表和草稿图谱里根本看不到它，会以为这表没被解析。 */
  const seen = new Set(out.tables.map(t => t.table));
  const missingTables = (model.classes || []).map(c => c.sourceTable).filter(n => !seen.has(n));
  if (missingTables.length) {
    for (const name of missingTables) {
      out.tables.push({
        table: name,
        tableLabel: (model.classes.find(c => c.sourceTable === name) || {}).localName || '',
        role: 'unspecified', meaning: '', logic: '', stage: '',
        sourceRefs: [], confidence: 'low'
      });
    }
    warnings.push(`模型没有覆盖这 ${missingTables.length} 张表，已标为「未指定」：${missingTables.slice(0, 6).join('、')}${missingTables.length > 6 ? ' 等' : ''}。请在稿子上补含义或重试。`);
  }

  return { understanding: checked.understanding, warnings: warnings.concat(checked.warnings), mode: 'ai', split: !!splitNote, at: new Date().toISOString() };
}

export async function propose(model, { mode = 'draft', description = '' } = {}) {
  if (mode === 'draft') {
    const p = draftProposal(model);
    const checked = validateProposal(p, model);
    return { ...checked, mode: 'draft', note: p._note, at: new Date().toISOString() };
  }
  const messages = buildMessages({
    description,
    tables: model.classes.map(c => ({
      name: c.sourceTable, label: c.localName,
      fields: model.dataProperties.filter(p => p.domain === c.iri).map(p => ({ name: p.sourceColumn || p.localName })),
      primaryKey: c.primaryKey || [],
      foreignKeys: model.objectProperties.filter(p => p.sourceTable === c.sourceTable && p.refTable)
        .map(p => ({ columns: p.sourceColumns || [], refTable: p.refTable, refColumns: p.refColumns || [] }))
    })),
    segments: model.processSegments.map(s => ({ id: s.id, heading: s.heading, text: s.text })),
    contract: PROMPTS.contract
  });
  const raw = await callModel(messages);
  const checked = validateProposal(raw, model);
  return { ...checked, mode: 'ai', note: '模型仅返回语义提案；OWL/XML、Turtle 与图谱均由确定性代码编译。', at: new Date().toISOString() };
}

/** 大模型位置三：规则设立。只解析文档语义，产出规则语义；SQL 由 rulespec.mjs 确定性编译。
    exclude 用于输出被截断后的续写：把已经产出的审查点带回去，只补没写到的。 */
export async function proposeRuleSpecs(graph, document, { exclude = [] } = {}) {
  const messages = buildRuleMessages({ document, graph, contract: RULE_CONTRACT, rules: RULE_RULES, exclude });
  return callModel(messages);
}
