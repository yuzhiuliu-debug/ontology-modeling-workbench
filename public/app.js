/* 本体建模工作台 · 页面逻辑与交互式活图谱
   原则：AI 只做语义提案；OWL/XML、Turtle、图谱数据由确定性代码编译；
        图谱是页面里可点、可拖、可改的真实对象，不是静态图片。 */
(function () {
  'use strict';

  const $ = id => document.getElementById(id);
  const $$ = sel => Array.from(document.querySelectorAll(sel));
  const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const short = s => String(s || '').split('#').pop().split('/').pop();
  /* 从 CSV/Excel 派生出来的表名是一串内部编号（t2_c0416d），不必摊给业务用户看 */
  const looksGenerated = s => /^t\d+_[0-9a-f]{6,}$/i.test(String(s || '').trim());

  /* 内部列标识 → 业务字段名。理解稿里的字段依据长这样：
     「t5_05236a.t5_05236a_f2 → t1_c218d8.t1_c218d8_f0」，业务用户看不出是「合同编号」。
     映射优先取规范模型的 columnLabels（服务端回传），没有就退回 OWL 里的数据属性 localName。 */
  let _fieldIdx = null;
  function fieldIndex() {
    if (_fieldIdx && _fieldIdx.stamp === (S.summary?.updatedAt || '') + '|' + (S.summary?.id || '')) return _fieldIdx;
    const colLabel = new Map(), tblLabel = new Map();
    for (const [table, cols] of Object.entries(S.summary?.canonical?.columnLabels || {})) {
      for (const [col, label] of Object.entries(cols)) colLabel.set(table + '.' + col, label);
    }
    for (const c of (S.summary?.canonical?.classes || [])) {
      if (c.sourceTable) tblLabel.set(c.sourceTable, c.localName || c.sourceTable);
    }
    /* OWL 的数据属性 id 是「表id__列id」，从它反推列归属，给只导入 OWL 的项目兜底 */
    for (const dp of (S.owlJson?.dataProperties || [])) {
      const [t, c] = String(dp.id || '').split('__');
      if (t && c && !colLabel.has(t + '.' + c)) colLabel.set(t + '.' + c, dp.localName || c);
    }
    for (const c of (S.owlJson?.classes || [])) {
      if (c.id && !tblLabel.has(c.id)) tblLabel.set(c.id, c.localName || c.id);
    }
    _fieldIdx = { colLabel, tblLabel, stamp: (S.summary?.updatedAt || '') + '|' + (S.summary?.id || '') };
    return _fieldIdx;
  }

  /** 把一段文字里的「表.列」换成「业务表名.业务字段名」；认不出来的原样留着，不硬猜 */
  function prettyFieldRef(text) {
    const { colLabel, tblLabel } = fieldIndex();
    return String(text ?? '').replace(/([A-Za-z0-9_\u4e00-\u9fa5]+)[.．]([A-Za-z0-9_\u4e00-\u9fa5]+)/g, (whole, t, c) => {
      const label = colLabel.get(t + '.' + c);
      if (!label) return whole;
      return `${tblLabel.get(t) || t}.${label}`;
    });
  }

  /** 字段依据可能写成一条（A.b ↔ C.d）也可能拆成两条（[A.b, C.d]），统一成可读形式 */
  function prettyVia(via, sep = ' ↔ ') {
    const list = (Array.isArray(via) ? via : (via ? [via] : [])).map(v => prettyFieldRef(v)).filter(Boolean);
    return list.join(sep);
  }

  /** 表名也换成业务名：t1_c218d8 → 合同表 */
  function prettyTable(t) {
    const { tblLabel } = fieldIndex();
    return tblLabel.get(String(t ?? '')) || String(t ?? '');
  }

  const S = {
    projectId: null, files: [], instFiles: [], summary: null, owlJson: null, preferDraft: false,
    layer: 'schema', graph: { nodes: [], edges: [] }, positions: {},
    selection: null, showLabels: null, view: { tx: 0, ty: 0, k: 1 }, dirty: false,
    workstationList: [],
    /* 图谱确认阶段的暂存编辑：图上改名 / 删除 / 新增关系都先记在这里，
       与右侧「图谱确认」列表共用同一份状态，确认时一次性作为批注提交。 */
    relEdits: {}, relAdds: []
  };

  /* ---------------- 基础交互 ---------------- */

  let toastTimer = null;
  function toast(msg, kind, ms) {
    const el = $('toast');
    el.textContent = msg;
    el.className = 'toast' + (kind ? ' ' + kind : '');
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, ms || (kind === 'error' ? 7000 : 3800));
  }
  function status(msg) { $('status-text').textContent = msg; }
  function busy(on, msg) {
    document.body.style.cursor = on ? 'progress' : '';
    if (msg) status(msg);
  }
  async function api(path, options = {}) {
    const res = await fetch(path, {
      method: options.method || 'GET',
      headers: options.body ? { 'Content-Type': 'application/json' } : {},
      body: options.body || undefined
    });
    let data;
    try { data = await res.json(); } catch { throw Error('服务端返回不是 JSON（HTTP ' + res.status + '）'); }
    if (!res.ok) {
      if (data.conflicts) renderConflicts(data.conflicts, true);
      /* 闸门只剩「理解稿定稿」这一道：旧台账闸门已并入图谱确认，不再阻断编译，
         所以这里只保留理解稿分支，避免把用户送到已经空掉的旧面板。 */
      if (/业务理解稿/.test(data.error || '')) { switchTab('understanding'); toast('请先完成业务理解稿的一次确认并定稿', 'error'); }
      else if (data.blocked?.length) toast(`闸门未通过：${data.blocked.slice(0, 3).map(x => x.kind + '·' + x.subject).join('、')}`, 'error');
      throw Error(data.error || '请求失败（HTTP ' + res.status + '）');
    }
    return data;
  }
  function setStep(n) {
    $$('.step').forEach(el => {
      const k = Number(el.dataset.step);
      el.classList.toggle('active', k === n);
      el.classList.toggle('done', k < n);
    });
  }
  const TABS = ['detail', 'owl', 'understanding', 'ledger', 'rules', 'instance'];
  /* 画布两个 tab：逻辑图谱（类与关系）/ 实例图谱（真实单据）。位置按图层分开存，
     切来切去不会互相打乱已经摆好的位置。 */
  function posMap() {
    if (!S.positions[S.layer]) S.positions[S.layer] = {};
    return S.positions[S.layer];
  }
  function switchLayer(name, opts = {}) {
    S.layer = name;
    ['schema', 'instance'].forEach(t => {
      const b = $('layer-' + t);
      b.classList.toggle('active', t === name);
      b.setAttribute('aria-selected', t === name ? 'true' : 'false');
    });
    S.selection = null;
    const moved = buildGraph(true);
    renderGraph();
    if (opts.fit !== false) fitView();
    renderDetail();
    return moved;
  }
  function switchTab(name) {
    TABS.forEach(t => {
      $('tab-' + t).classList.toggle('active', t === name);
      $('panel-' + t).hidden = t !== name;
    });
    /* 面板隐藏时量不到 scrollHeight，切过来再量一次，业务含义才不会被切一半 */
    if (name === 'ledger') autosizeMeanings();
  }

  /* ---------------- 材料上传 ---------------- */

  function fileRole(name, content) {
    const n = name.toLowerCase(), t = String(content || '').trim().slice(0, 400);
    if (/\.(xlsx|xlsm)$/.test(n)) return 'Excel 工作簿';
    if (/\.xls$/i.test(n)) return '旧版 Excel（请另存 xlsx）';
    if (/\.json$/i.test(n) && t.startsWith('{') && !/"tables"\s*:/.test(t.slice(0, 1200)) && /"classes"\s*:/.test(t.slice(0, 1200))) return '已有 OWL';
    if (/\.(owl|ttl|nt|rdf|xml)$/.test(n) || /^<Ontology[\s>]|^<rdf:RDF|^@prefix\s+\w+:/i.test(t)) return '已有 OWL';
    if (/\.(csv|tsv)$/.test(n)) return '表头/数据行';
    if (/\.sql$/.test(n)) return 'SQL DDL';
    if (/\.(txt|md)$/.test(n)) return '业务描述';
    if (/\.(png|jpe?g|webp|bmp|gif)$/.test(n)) return '图片（读图识别）';
    if (/\.json$/.test(n)) return '字段字典/测试用例';
    return '其他材料';
  }
  function renderFiles() {
    const box = $('file-list');
    if (!S.files.length) { box.innerHTML = '<div class="empty-hint">请上传你自己业务的表结构</div>'; return; }
    box.innerHTML = S.files.map((f, i) =>
      `<div class="file-item"><span class="frole">${esc(fileRole(f.name, f.content))}</span>` +
      `<span class="fname" title="${esc(f.name)}">${esc(f.name)}</span>` +
      `<span class="muted" style="font-size:10px">${(f.content.length / 1024).toFixed(1)}KB</span>` +
      `<button class="fremove" data-i="${i}" title="移除">×</button></div>`).join('');
    box.querySelectorAll('.fremove').forEach(b => b.onclick = () => { S.files.splice(Number(b.dataset.i), 1); renderFiles(); });
  }
  function toBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }
  async function addFiles(fileList) {
    const list = Array.from(fileList || []);
    let added = 0;
    for (const f of list) {
      if (f.size > 20 * 1024 * 1024) { toast('文件过大已跳过：' + f.name, 'error'); continue; }
      let content, encoding;
      if (/\.(xlsx|xlsm)$/i.test(f.name) || /\.(png|jpe?g|webp|bmp|gif)$/i.test(f.name)) {
        content = toBase64(await f.arrayBuffer());
        encoding = 'base64';
      } else if (/\.xls$/i.test(f.name)) {
        toast('旧版 .xls 不支持，请另存为 .xlsx：' + f.name, 'error'); continue;
      } else if (/\.pdf$/i.test(f.name)) {
        toast('PDF 暂不支持，请先截成图片（PNG/JPG）再传：' + f.name, 'error'); continue;
      } else content = await f.text();
      S.files = S.files.filter(x => x.name !== f.name);
      S.files.push({ name: f.name, content, encoding, type: undefined });
      added++;
    }
    renderFiles();
    if (added) { toast(`已加入 ${added} 份材料，点击左侧「解析材料」继续`, 'ok'); status(`已就绪 ${S.files.length} 份材料`); }
  }
  async function parseMaterials() {
    if (!S.files.length) { toast('请先上传你自己业务的表结构材料', 'error'); return; }
    busy(true, '正在解析材料并建立规范模型…');
    try {
      const res = await api('/api/projects', {
        method: 'POST',
        body: JSON.stringify({
          name: $('project-name').value.trim() || '未命名本体项目',
          namespace: $('namespace').value.trim(),
          description: $('business-desc').value,
          files: S.files
        })
      });
      S.projectId = res.id;
      applySummary(res, { resetPositions: true });
      setStep(res.graph ? 3 : 2);
      switchTab(res.graph ? 'detail' : 'understanding');
      if ((res.imageNotes || []).length) toast('图片识别：' + res.imageNotes.join('；'), 'ok');
      toast(res.graph
        ? '已从 OWL 文件解析出活图谱，可直接点击、拖拽、编辑'
        : `解析完成：${res.canonical?.stats.classes || 0} 张表，下一步确认业务理解稿`, 'ok');
      status(`项目 ${res.id} 已建立`);
    } catch (e) { toast(e.message, 'error'); status('解析失败：' + e.message); }
    finally { busy(false); }
  }
  /* ---------------- 最近项目：服务重启后还能回到原来的活儿 ---------------- */

  const STAGE_TEXT = ['未开始', '材料已录入', '理解稿阶段', '已出草稿图谱', '已编译 OWL', '规则已设立', '实例已装载'];

  async function openRecent() {
    $('recent-modal').hidden = false;
    const box = $('recent-list');
    box.innerHTML = '<div class="empty-hint">读取中…</div>';
    try {
      const { projects } = await api('/api/projects');
      if (!projects.length) { box.innerHTML = '<div class="empty-hint">还没有项目。上传材料会新建一个。</div>'; return; }
      box.innerHTML = projects.map(p => {
        const when = String(p.updatedAt || '').replace('T', ' ').slice(0, 16);
        return `<div class="ledger-item recent-row" data-pid="${esc(p.id)}" role="button" tabindex="0">` +
          `<div class="li-head"><span class="li-term">${esc(p.name)}</span>` +
          `<span class="chip muted">${esc(STAGE_TEXT[p.stage] || ('阶段 ' + p.stage))}</span></div>` +
          `<div class="li-body muted">${esc(p.id)} · ${p.classes} 个对象 / ${p.relations} 条关系 · ${esc(when)}</div></div>`;
      }).join('');
      box.querySelectorAll('.recent-row').forEach(row => {
        const go = async () => {
          busy(true, '正在打开项目…');
          try {
            const res = await api('/api/projects/' + row.dataset.pid);
            applySummary(res, { resetPositions: true, keepSelection: false });
            setStep(Math.max(1, Math.min(6, res.stage || 1)));
            $('recent-modal').hidden = true;
            toast('已打开：' + res.name, 'ok');
            status(`项目 ${res.id} · ${res.canonical ? '已有规范模型' : '尚无规范模型'}`);
          } catch (e) { toast(e.message, 'error'); }
          finally { busy(false); }
        };
        row.onclick = go;
        row.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } };
      });
    } catch (e) {
      box.innerHTML = `<div class="empty-hint">读取失败：${esc(e.message)}</div>`;
    }
  }

  function newProject() {
    S.projectId = null; S.files = []; S.summary = null; S.owlJson = null;
    S.graph = { nodes: [], edges: [] }; S.positions = {}; S.selection = null;
    S.showLabels = null; S.view = { tx: 0, ty: 0, k: 1 };
    S.relEdits = {}; S.relAdds = [];
    $('project-id').textContent = '尚未创建';
    $('project-name').value = '未命名本体项目';
    $('business-desc').value = '';
    renderFiles(); renderAll(); renderGraph();
    activeHit = null;
    $('manual-stages').value = '';
    $('understanding-annotations').innerHTML = '';
    setStep(1); switchTab('understanding');
    toast('已清空当前工作区，可重新上传材料', 'ok'); status('就绪');
  }

  /* ---------------- 语义提案 / 冲突 ---------------- */


  function renderConflicts(conflicts, forceShow) {
    const panel = $('conflict-panel'), box = $('conflict-list');
    const open = (conflicts || []).filter(c => c.status === 'open');
    panel.hidden = !open.length && !forceShow;
    if (!open.length) { box.innerHTML = '<div class="empty-hint">当前没有未裁决的口径冲突。</div>'; return; }
    box.innerHTML = open.map(c => {
      const isBlocker = c.severity === 'blocker';
      const acts = isBlocker
        ? `<button class="btn btn-sm c-act" data-id="${esc(c.id)}" data-a="accept_a">以口径 A 为准</button>
           <button class="btn btn-sm c-act" data-id="${esc(c.id)}" data-a="accept_b">以口径 B 为准</button>
           <button class="btn btn-sm c-act" data-id="${esc(c.id)}" data-a="reject">记录并驳回</button>`
        : `<button class="btn btn-sm c-act" data-id="${esc(c.id)}" data-a="ignore">知悉，记录不阻断</button>`;
      return `<div class="conflict"><div class="ctitle">${esc(c.subject)}<span class="sev ${isBlocker ? 'blocker' : 'warning'}">${isBlocker ? '阻断级' : '提醒'}</span></div>` +
        (c.claims || []).map(x => `<div class="cclaim">${esc(x.source)}：${esc(String(x.value).slice(0, 220))}</div>`).join('') +
        `<div class="cactions">${acts}</div></div>`;
    }).join('');
    box.querySelectorAll('.c-act').forEach(b => b.onclick = async () => {
      const labels = { accept_a: '以口径 A 为准', accept_b: '以口径 B 为准', reject: '人工驳回并留痕', ignore: '知悉，记录但不阻断' };
      try {
        const res = await api(`/api/projects/${S.projectId}/conflicts`, {
          method: 'POST', body: JSON.stringify({ decisions: [{ id: b.dataset.id, action: b.dataset.a, value: labels[b.dataset.a], by: '工作台人工裁决' }] })
        });
        applySummary(res);
        toast('已记录人工裁决：' + labels[b.dataset.a], 'ok');
      } catch (e) { toast(e.message, 'error'); }
    });
  }

  /* ---------------- 编译 / 反解析 / 导出 ---------------- */

  async function compile() {
    if (!S.projectId) { toast('请先解析材料', 'error'); return; }
    busy(true, '正在编译 OWL、生成图谱并校验…');
    try {
      const res = await api(`/api/projects/${S.projectId}/compile`, { method: 'POST', body: JSON.stringify({}) });
      applySummary(res, { resetPositions: true });
      setStep(3); switchTab('owl');
      const v = res.validation?.summary;
      toast(v ? `OWL 已生成，校验 ${v.passed}/${v.total} 通过。图谱是活对象，可点击 / 拖拽 / 编辑` : 'OWL 已生成', v?.failed ? 'error' : 'ok');
      status(`编译完成 · 校验 ${v ? v.passed + '/' + v.total : '—'} · ${(res.owlXmlBytes / 1024).toFixed(0)}KB OWL/XML`);
    } catch (e) { toast(e.message, 'error'); status('编译被阻断：' + e.message); }
    finally { busy(false); }
  }
  async function commitEdit(note) {
    if (!S.projectId || !S.owlJson) { toast('当前没有可回写的本体', 'error'); return; }
    busy(true, '正在把图谱编辑回写 OWL 并重新校验…');
    try {
      const res = await api(`/api/projects/${S.projectId}/compile`, {
        method: 'POST', body: JSON.stringify({ owlJson: S.owlJson, note })
      });
      applySummary(res, { keepSelection: true });
      S.dirty = false;
      const v = res.validation?.summary;
      toast(v?.failed ? `已回写，但校验有 ${v.failed} 项未通过，请在「OWL 与校验」查看` : '已回写 OWL，并重新解析出图谱', v?.failed ? 'error' : 'ok');
      status(`图谱编辑已回写 · 校验 ${v ? v.passed + '/' + v.total : '—'}`);
    } catch (e) { toast(e.message, 'error'); }
    finally { busy(false); }
  }
  async function parseOwl(text, filename) {
    if (!S.projectId) {
      try {
        const created = await api('/api/projects', { method: 'POST', body: JSON.stringify({ name: $('project-name').value || '从 OWL 导入', namespace: $('namespace').value, files: [] }) });
        S.projectId = created.id;
      } catch (e) { toast(e.message, 'error'); return; }
    }
    busy(true, '正在解析 OWL 并重建活图谱…');
    try {
      const res = await api(`/api/projects/${S.projectId}/parse-owl`, { method: 'POST', body: JSON.stringify({ text, filename }) });
      applySummary(res, { resetPositions: true });
      setStep(5); switchTab('detail');
      toast(`已从 ${filename} 解析：${res.parsedStats.classes} 类 / ${res.parsedStats.objectProperties} 关系 / ${res.parsedStats.individuals} 实例`, 'ok');
      status('OWL 反解析完成 · 格式 ' + res.parsedFormat);
    } catch (e) { toast(e.message, 'error'); status('解析失败：' + e.message); }
    finally { busy(false); }
  }
  async function exportFile(format) {
    if (!S.projectId) { toast('请先建立项目', 'error'); return; }
    try {
      const res = await fetch(`/api/projects/${S.projectId}/export?format=${encodeURIComponent(format)}`);
      if (!res.ok) { const d = await res.json(); throw Error(d.error || '导出失败'); }
      const blob = await res.blob();
      const names = { owl: 'ontology.owl', ttl: 'ontology.ttl', json: 'owl-ontology.json', graph: 'graph.json', shacl: 'shapes.ttl', nt: 'triples.nt', model: 'canonical-model.json', rulesql: 'business-rule-review.sql', rulespec: 'business-rules.json', understanding: 'business-understanding.json', abox: 'instance-abox.owl' };
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob); a.download = names[format] || 'export.txt';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 3000);
      toast('已导出 ' + a.download, 'ok');
    } catch (e) { toast(e.message, 'error'); }
  }

  /* ---------------- 汇总渲染 ---------------- */

  function applySummary(res, opts = {}) {
    S.summary = res;
    S.projectId = res.id;
    S.owlJson = res.owlJson ? JSON.parse(JSON.stringify(res.owlJson)) : null;
    $('project-id').textContent = res.id;
    $('project-name').value = res.name;
    if (opts.resetPositions) S.positions = {};
    if (opts.resetPositions && !opts.keepSelection) S.selection = null;
    /* 打开/切换项目时把搜索框清空：残留的搜索词会把整张图压暗、把标签全藏起来 */
    if (opts.resetPositions && $('graph-search')) $('graph-search').value = '';
    renderMaterialStats();
    renderConflicts(res.canonical?.conflicts || []);
    renderValidation();
    renderHistory();
    renderGateStrip();
    renderUnderstanding();
    renderLedger();
    renderRules();
    renderInstance();
    const didLayout = buildGraph(!!opts.resetPositions);
    renderGraph();
    renderDetail();
    /* 只要这次是「真的重新排了」（首次出图也算），就把视图对准，别让用户自己找 */
    if (didLayout && S.graph.nodes.length) requestAnimationFrame(() => fitView());
  }

  function renderAll() {
    const res = S.summary;
    if (!res) {
      $('material-stats').innerHTML = '';
      $('conflict-panel').hidden = true;
      $('validation-summary').textContent = '尚未编译';
      $('validation-summary').className = 'validation-summary';
      $('validation-list').innerHTML = '';
      $('owl-preview').textContent = '尚未生成';
      $('history-list').innerHTML = '<div class="empty-hint">暂无操作记录</div>';
      $('gate-strip').textContent = '理解稿未定稿 · 业务关系待命名 0 条 · 规则未设立';
      $('gate-strip').classList.remove('clear');
      $('understanding-status').textContent = '尚未生成业务理解稿';
      $('manual-tables').innerHTML = '<div class="empty-hint">上传材料后显示待填表清单</div>';
      ['understanding-stages', 'understanding-deps', 'understanding-tables', 'understanding-gaps', 'understanding-annotations'].forEach(id => $(id).innerHTML = '');
      $('understanding-diff').hidden = true;
      $('btn-understanding-reopen').hidden = true;
      $('ledger-status').textContent = '尚未生成台账';
      ['ledger-stats', 'ledger-flow',
        'rules-list', 'rules-context'].forEach(id => $(id).innerHTML = '');
      $('rules-status').textContent = '尚未生成审查规则';
      $('rule-file-name').textContent = '';
      $('rule-text').value = '';
      $('graph-empty').hidden = false;
      $('graph-stats').textContent = '0 节点 / 0 边';
      renderInstance();
      renderInstFiles();
      renderDetail();
    }
  }

  function renderMaterialStats() {
    const r = S.summary; if (!r) return;
    const parts = [];
    (r.materials || []).forEach(m => parts.push(`<span class="stat"><b>${esc(m.name.split('.').pop())}</b>${esc(m.role || m.type)}</span>`));
    if (r.canonical) {
      const s = r.canonical.stats;
      parts.push(`<span class="stat"><b>${s.classes}</b>类</span>`, `<span class="stat"><b>${s.dataProperties}</b>字段</span>`,
        `<span class="stat"><b>${s.objectProperties}</b>关系</span>`, `<span class="stat"><b>${s.processSegments}</b>流程片段</span>`,
        `<span class="stat"><b>${s.sampleRows}</b>样例行</span>`);
    }
    $('material-stats').innerHTML = parts.join('');
  }


  function renderValidation() {
    const r = S.summary; if (!r) return;
    const v = r.validation;
    const box = $('validation-summary');
    if (!v) { box.textContent = '尚未编译'; box.className = 'validation-summary'; $('validation-list').innerHTML = ''; }
    else {
      box.textContent = `校验 ${v.summary.passed}/${v.summary.total} 通过 · 指纹 ${v.fingerprint}` + (v.passed ? ' · 可发布' : ` · ${v.summary.failed} 项未通过`);
      box.className = 'validation-summary ' + (v.passed ? 'pass' : 'fail');
      $('validation-list').innerHTML = (v.checks || []).map(c =>
        `<div class="vcheck ${c.status === 'pass' ? 'ok' : 'bad'}"><span class="vmark">${c.status === 'pass' ? '✓' : '✕'}</span><span>${esc(c.name)} <small>${esc(c.detail)}</small></span></div>`).join('');
    }
    $('owl-preview').textContent = r.owlXmlPreview || '尚未生成';
  }

  function renderHistory() {
    const r = S.summary;
    $('history-list').innerHTML = r?.history?.length
      ? r.history.slice().reverse().map(h => `<div class="hist"><time>${esc(h.at.slice(11, 19))}</time><div><b>${esc(h.action)}</b><span> ${esc(h.detail)}</span></div></div>`).join('')
      : '<div class="empty-hint">暂无操作记录</div>';
  }

  /* ---------------- 第一批：业务语义台账 / 流程基线 / 规则与证据链 ---------------- */

  let activeHit = null;

  async function postStep(path, payload, okMsg, tab) {
    if (!S.projectId) { toast('请先解析材料', 'error'); return; }
    busy(true, '正在提交…');
    try {
      const res = await api(`/api/projects/${S.projectId}/${path}`, { method: 'POST', body: JSON.stringify(payload || {}) });
      if (path === 'understanding-generate') { S.relEdits = {}; S.relAdds = []; S.selection = null; }
      applySummary(res, { keepSelection: true });
      if (path === 'understanding-generate') setStep(2);
      if (path === 'understanding-finalize') setStep(2);
      if (okMsg) toast(okMsg, 'ok');
      if (tab) switchTab(tab);
    } catch (e) { toast(e.message, 'error'); }
    finally { busy(false); }
  }

  function renderGateStrip() {
    const r = S.summary, el = $('gate-strip');
    if (!r) return;
    const u = r.gates?.understandingFinalized;
    const pending = r.relationStats?.pending ?? 0;
    const confirmed = r.relationStats?.confirmed ?? 0;
    const rules = r.ruleSpecs?.rules?.length || 0;
    el.textContent = `理解稿${u ? '已定稿' : '未定稿'} · 业务关系进本体 ${confirmed} 条`
      + (pending ? ` · 待命名 ${pending} 条` : '')
      + ` · 规则${rules ? '已设立 ' + rules + ' 条' : '未设立'}`;
    el.classList.toggle('clear', !!u && pending === 0 && rules > 0);
  }

  /* ---------------- B 批：业务理解稿 / 手工建模 / 一次确认 + 局部批注 ---------------- */

  const ROLE_LABEL = { master: '主数据', event: '业务事件', bridge: '关联桥', evidence: '证据/附件', result: '结果记录', snapshot: '快照/配置', unspecified: '未指定' };
  let annotSeq = 0;

  function renderManualForm() {
    const r = S.summary;
    if (!r?.canonical?.classes) return;
    const roles = r.roles || Object.keys(ROLE_LABEL).map(id => ({ id, label: ROLE_LABEL[id] }));
    const u = r.understandingFinal || r.understanding;
    const byTable = new Map((u?.tables || []).map(t => [t.table, t]));
    $('manual-tables').innerHTML = r.canonical.classes.map(c => {
      const t = byTable.get(c.id) || {};
      const opts = roles.map(x => `<option value="${esc(x.id)}"${(t.role || 'unspecified') === x.id ? ' selected' : ''}>${esc(x.label)}</option>`).join('');
      return `<div class="manual-row" data-mtable="${esc(c.id)}">
        <div class="mr-head">${esc(c.localName)} <span class="muted" style="font-weight:400">${esc(c.id)}</span></div>
        <div class="mr-grid">
          <input data-mf="meaning" placeholder="业务含义" value="${esc(t.meaning || '')}">
          <select data-mf="role">${opts}</select>
          <input data-mf="stage" placeholder="链路阶段" value="${esc(t.stage || '')}">
          <input data-mf="logic" placeholder="背后的业务逻辑" value="${esc(t.logic || '')}">
        </div></div>`;
    }).join('');
    if (u?.stages?.length && !$('manual-stages').value) $('manual-stages').value = u.stages.map(s => s.name).join('\n');
  }

  function collectManual() {
    const tables = $$('#manual-tables .manual-row').map(row => {
      const g = k => row.querySelector(`[data-mf="${k}"]`)?.value?.trim() || '';
      return { table: row.dataset.mtable, meaning: g('meaning'), role: g('role'), stage: g('stage'), logic: g('logic') };
    });
    const stages = $('manual-stages').value.split('\n').map(x => x.trim()).filter(Boolean)
      /* 阶段名对上每张表填的「链路阶段」，把业务对象对到阶段上——
         以前这里固定传空数组，导致阶段下面永远没有对象，业务链路是空的 */
      .map((name, i) => ({ order: i + 1, name, tableRefs: tables.filter(t => t.stage === name).map(t => t.table) }));
    return { tables, stages };
  }

  function addAnnotationRow(preset = {}) {
    const r = S.summary;
    const targets = [
      ...(r?.canonical?.classes || []).map(c => `<option value="${esc(c.id)}"${preset.targetId === c.id ? ' selected' : ''}>表：${esc(c.localName)}</option>`),
      ...((r?.understandingFinal || r?.understanding)?.stages || []).map(s => `<option value="${esc(s.name)}"${preset.targetId === s.name ? ' selected' : ''}>阶段：${esc(s.name)}</option>`)
    ].join('');
    const kinds = [
      ['changeMeaning', '改业务含义'], ['changeRole', '改角色'], ['changeStage', '改阶段'],
      ['changeLogic', '改业务逻辑'], ['renameStage', '改阶段名'], ['addStage', '补充阶段'],
      ['removeStage', '删除阶段'], ['addGap', '登记缺口'], ['query', '标记存疑']
    ].map(([v, l]) => `<option value="${v}"${preset.kind === v ? ' selected' : ''}>${l}</option>`).join('');
    const div = document.createElement('div');
    div.className = 'annot-row';
    div.dataset.annot = String(++annotSeq);
    div.innerHTML = `<select data-a="target" title="批注对象">${targets || '<option value="">（无对象）</option>'}</select>` +
      `<select data-a="kind" title="批注类型">${kinds}</select>` +
      `<input data-a="value" placeholder="改成什么 / 补充什么" value="${esc(preset.value || '')}">` +
      `<button title="删除这条批注">×</button>`;
    div.querySelector('button').onclick = () => div.remove();
    $('understanding-annotations').appendChild(div);
  }

  function collectAnnotations() {
    return $$('#understanding-annotations .annot-row').map(row => {
      const g = k => row.querySelector(`[data-a="${k}"]`)?.value?.trim() || '';
      const a = { targetId: g('target'), kind: g('kind'), value: g('value'), comment: '' };
      const byLabel = { '主数据': 'master', '业务事件': 'event', '关联桥': 'bridge', '证据/附件': 'evidence', '结果记录': 'result', '快照/配置': 'snapshot', '未指定': 'unspecified' };
      if (a.kind === 'changeRole') a.value = byLabel[a.value] || a.value || 'unspecified';
      return a;
    }).filter(a => a.targetId || a.value);
  }

  function renderUnderstanding() {
    const r = S.summary;
    if (!r) return;
    const u = r.understandingFinal || r.understanding;
    const finalized = !!r.understandingFinal;
    const st = $('understanding-status');
    st.textContent = !u
      ? '尚未生成理解稿：可调用模型出稿，或用「手工建模」逐表填写业务含义与链路阶段'
      : finalized
        ? `理解稿已定稿 v${u.version} · 共 ${r.understandingHistory?.length || 0} 个版本 · 指纹 ${u.fingerprint || '—'} · 业务含义已回写规范模型`
        : `理解稿草稿 v${u.version}（${u.origin === 'manual' ? '手工填写' : '模型生成'}）· 请核对整张稿子，局部写批注后做一次确认`;
    st.className = !u || !finalized ? 'warning-box' : 'mode-line';
    const warns = r.understandingWarnings || [];
    const wbox = $('understanding-warnings');
    wbox.hidden = !warns.length;
    if (warns.length) wbox.innerHTML = '<b>模型提案校验警告</b><br>' + warns.map(x => '· ' + esc(x)).join('<br>');

    renderManualForm();
    $('manual-block').hidden = finalized;

    if (!u) {
      $('understanding-stages').textContent = '尚未生成理解稿';
      $('understanding-tables').innerHTML = '<div class="empty-hint">尚未生成理解稿</div>';
      $('understanding-deps').innerHTML = '';
      $('understanding-gaps').innerHTML = '';
      $('understanding-diff').hidden = true;
      $('btn-understanding-reopen').hidden = true;
      return;
    }
    $('understanding-stages').innerHTML = '<b>链路阶段</b><br>' + (u.stages.length
      ? `<div class="stage-chain">${u.stages.map(s => `<span class="stage-box">${esc(s.order)}. ${esc(s.name)} <span class="muted">${s.tableRefs.length} 表</span></span>`).join('<span class="stage-arrow">→</span>')}</div>`
      : '<span class="muted">未划分阶段，可在批注里补充</span>');
    $('understanding-deps').innerHTML = (u.idDependencies || []).length
      ? u.idDependencies.map(d => `<div class="ledger-item"><div class="li-head"><span class="tag suspected">链路依赖</span><span class="li-term">${esc(prettyTable(d.from))} → ${esc(prettyTable(d.to))}</span></div><div class="li-body">关联字段：${esc(prettyVia(d.fields, '、') || '待补')}</div></div>`).join('')
      : '<div class="empty-hint">未声明链路依赖</div>';
    $('understanding-tables').innerHTML = u.tables.map(t => {
      const c = (r.canonical?.classes || []).find(x => x.id === t.table);
      return `<div class="ledger-item u-item"><div class="li-head"><span class="li-term">${esc(c?.localName || t.table)}</span><span class="u-role">${esc(ROLE_LABEL[t.role] || t.role)}</span><span class="tag ${t.confidence || 'medium'}">${t.confidence || 'medium'}</span></div>
        <div class="li-body">${esc(t.meaning || '（未填写业务含义）')}${t.logic ? '<br><span class="muted">' + esc(t.logic) + '</span>' : ''}</div>
        <div class="li-src">链路阶段：${esc(t.stage || '未指定')} · 表标识 ${esc(t.table)}</div></div>`;
    }).join('');
    const gaps = [...(u.gaps || []).map(g => `[${g.kind || '缺口'}] ${g.subject}：${g.note}`), ...(u.uncertainties || []).map(x => `[待补] ${x.subject}：${x.text}`)];
    $('understanding-gaps').innerHTML = gaps.length
      ? gaps.map(g => `<div class="ledger-item"><div class="li-body">${esc(g)}</div></div>`).join('')
      : '<div class="empty-hint">未发现缺口或待补项</div>';

    const diff = $('understanding-diff');
    if (finalized && r.understandingHistory?.length) {
      const last = r.understandingHistory[r.understandingHistory.length - 1];
      diff.hidden = false;
      diff.innerHTML = '<b>本次依据批注改了什么</b><br>' + ((last.diffSummary || []).length
        ? last.diffSummary.map(d => `· ${esc(d.targetId)} / ${esc(d.kind)}：${esc(d.result)}`).join('<br>')
        : '· 整稿确认，无局部批注') + `<br><span class="muted">确认人 ${esc(last.by || '')} · ${esc((last.at || '').slice(0, 19))}</span>`;
    } else diff.hidden = true;
    $('btn-understanding-reopen').hidden = !finalized;
    $('btn-understanding-finalize').disabled = finalized;
  }


  /* 关系状态一句话：列表输入时只刷新这句话，不重绘列表，避免打断输入 */
  function relStatusText(rels, finalized) {
    const confirmed = rels.filter(x => x.status === 'confirmed').length;
    const rejected = rels.filter(x => x.status === 'rejected').length;
    const pending = rels.filter(x => x.status === 'candidate').length;
    return finalized
      ? `已定稿：${confirmed} 条关系进本体${rejected ? `，${rejected} 条已删除` : ''}${pending ? `，${pending} 条未命名未进本体` : ''}`
      : `草稿态：共 ${rels.length} 条，${pending} 条待命名——不改名不会进本体`;
  }
  function refreshRelStatus() {
    const st = $('ledger-status');
    if (!st) return;
    const rels = relList();
    const finalized = !!S.summary?.understandingFinal;
    st.textContent = relStatusText(rels, finalized);
    st.className = (!finalized && rels.some(x => x.status === 'candidate')) ? 'warning-box' : 'mode-line';
  }

  /** 多行输入框按内容自适应高度：rows=1 会把两行字切一半，看着像坏了 */
  function autoGrow(el) {
    if (!el || el.tagName !== 'TEXTAREA') return;
    el.style.height = 'auto';
    const h = el.scrollHeight;
    /* 面板还藏着时量出来是 0，这时候别动样式，等切过来再量一次 */
    if (!h) { el.style.height = ''; el.style.overflowY = ''; return; }
    el.style.height = Math.min(h + 2, 180) + 'px';
    el.style.overflowY = h > 178 ? 'auto' : 'hidden';
  }
  function autosizeMeanings() {
    $$('#relation-list .rel-meaning').forEach(autoGrow);
  }

  /* 图谱确认：草稿图谱上的每条边在这里逐条命名 / 删除；没命名的不会进本体 */
  function renderLedger() {
    const r = S.summary, s = r?.semantics;
    const u = r?.understandingFinal || r?.understanding;
    const rels = relList();
    const finalized = !!r?.understandingFinal;
    const labelOf = new Map((u?.tables || []).map(x => [x.table, x.tableLabel || x.table]));
    const name = t => labelOf.get(t) || t;
    const st = $('ledger-status');
    if (!u) {
      st.textContent = '尚未生成理解稿';
      st.className = 'mode-line';
      $('ledger-stats').innerHTML = '';
      $('relation-list').innerHTML = '<div class="empty-hint">先在「业务理解稿」出稿，草稿图谱会同时出现</div>';
    } else {
      const confirmed = rels.filter(x => x.status === 'confirmed').length;
      const rejected = rels.filter(x => x.status === 'rejected').length;
      const pending = rels.filter(x => x.status === 'candidate').length;
      st.textContent = relStatusText(rels, finalized);
      st.className = (!finalized && pending) ? 'warning-box' : 'mode-line';
      const noMeaning = rels.filter(x => x.status !== 'rejected' && x.noMeaning).length;
      $('ledger-stats').innerHTML = [
        `<span class="stat"><b>${rels.length}</b>关系</span>`,
        `<span class="stat"><b>${confirmed}</b>已保留</span>`,
        `<span class="stat"><b>${pending}</b>待命名</span>`,
        `<span class="stat"><b>${rejected}</b>已删除</span>`,
        noMeaning ? `<span class="stat"><b>${noMeaning}</b>缺业务含义</span>` : ''
      ].join('');
      $('relation-list').innerHTML = rels.map(x => {
        const dropped = x.status === 'rejected';
        const tags = [
          x.vague ? '<span class="tag suspected">含义偏泛</span>' : '',
          x.noMeaning ? '<span class="tag missing">缺业务含义</span>' : ''
        ].join('');
        return `<div class="rel-row${dropped ? ' dropped' : ''}${x.added ? ' added' : ''}" data-rel="${esc(x.id)}">
          <div class="rel-head">
            <span class="rel-node">${esc(name(x.subject))}</span>
            <input class="input input-sm" data-rel-name value="${esc(x.predicate === '待确认关系' ? '' : x.predicate)}" placeholder="业务动作（如 按订单收货）" data-suggest="${x.origin === 'structure' ? '关联' : ''}"${finalized ? ' disabled' : ''}>
            <span class="rel-node">${esc(name(x.object))}</span>
            <label class="rel-drop"><input type="checkbox" data-rel-drop ${dropped ? 'checked' : ''}${finalized ? ' disabled' : ''}> 删除</label>
          </div>
          <textarea class="textarea rel-meaning" data-rel-meaning rows="1" placeholder="业务含义：这条边在业务上做了什么、约束了什么"${finalized ? ' readonly' : ''}>${esc(x.meaning || '')}</textarea>
          <div class="rel-src">${tags}${tags ? ' ' : ''}${x.added ? '<b>人工补充</b>' : ''}${x.added && (x.basis || x.via?.length) ? ' · ' : ''}${x.basis ? esc(prettyFieldRef(x.basis)) : ''}${x.via?.length ? ' · 字段：' + esc(prettyVia(x.via)) : ''}</div>
        </div>`;
      }).join('') || '<div class="empty-hint">理解稿里没有识别出业务关系</div>';
      /* 列表与画布共用一份暂存：输入即同步到图上，图上改名也回到这里 */
      $$('#relation-list .rel-row').forEach(row => {
        const id = row.dataset.rel;
        const input = row.querySelector('[data-rel-name]');
        const meaning = row.querySelector('[data-rel-meaning]');
        const drop = row.querySelector('[data-rel-drop]');
        /* 业务含义常常两三行，默认 rows=1 会把字切一半，看着像乱码 */
        if (meaning) autoGrow(meaning);
        if (input) input.oninput = () => { relEdit(id, { predicate: input.value.trim() }); buildGraph(false); renderGraph(); refreshRelStatus(); };
        if (meaning) meaning.oninput = () => { relEdit(id, { meaning: meaning.value.trim() }); autoGrow(meaning); refreshRelStatus(); };
        if (drop) drop.onchange = () => { relEdit(id, { rejected: drop.checked }); refreshDraft(); };
      });
    }
    renderFlow();
  }

  /** 业务链路：按理解稿给出的阶段顺序串业务对象。
      以前这里是「从某个起点按跳数可达」的 BFS：读不出业务上谁先谁后，
      而且它读的是解析材料那一刻的模型快照（那时还没有任何业务关系），
      所以永远只剩「第 0 跳：起点」。业务时序本来就在理解稿的 stages 里。 */
  const ROLE_ORDER = [
    ['master', '主数据'], ['event', '业务事件'], ['bridge', '关联桥'], ['result', '结果记录'],
    ['evidence', '证据/附件'], ['snapshot', '快照/配置'], ['unspecified', '未指定角色']
  ];
  function renderFlow() {
    const r = S.summary;
    const u = r?.understandingFinal || r?.understanding;
    const labelOf = new Map((u?.tables || []).map(x => [x.table, x.tableLabel || x.table]));
    const name = t => labelOf.get(t) || t;
    const box = $('ledger-flow');
    if (!box) return;
    const stages = [...(u?.stages || [])].sort((a, b) => (a.order || 0) - (b.order || 0));
    let groups = stages.map(sg => ({ name: sg.name || '未命名阶段', tables: sg.tableRefs || [] }));
    let note = '';
    if (!groups.length) {
      /* 手工建模常常没填阶段。这时先按对象角色排一版——角色也是理解稿给的，不是凭空编的 */
      const by = new Map();
      (u?.tables || []).forEach(t => { const k = t.role || 'unspecified'; if (!by.has(k)) by.set(k, []); by.get(k).push(t.table); });
      groups = ROLE_ORDER.filter(([k]) => by.has(k)).map(([k, label]) => ({ name: label, tables: by.get(k) }));
      /* 角色也全是「未指定」时，没有依据排先后——不硬编一条假链路，直接说清楚并给入口 */
      if (groups.length === 1 && by.has('unspecified') && by.get('unspecified').length === (u?.tables || []).length) {
        box.innerHTML = '<div class="empty-hint">理解稿里既没填业务阶段，也没确认对象角色，这里排不出业务先后。</div>'
          + '<button class="btn btn-sm" id="flow-go-understanding">去「业务理解稿」补阶段</button>';
        $('flow-go-understanding').onclick = () => switchTab('understanding');
        return;
      }
      if (groups.length) note = '<div class="flow-note">理解稿没填业务阶段，先按业务对象角色排列；补上阶段后这里会按时序显示。</div>';
    }
    if (!groups.length) {
      box.innerHTML = '<div class="empty-hint">还没有业务对象，先出理解稿</div>';
      return;
    }
    box.innerHTML = note + groups.map((g, i) => {
      const objs = g.tables.map(t => {
        const lb = name(t);
        return `<button class="flow-step flow-link" data-flow-table="${esc(t)}" data-flow-label="${esc(lb)}" title="在画布上定位「${esc(lb)}」">${esc(lb)}</button>`;
      }).join('');
      return `<div class="flow-row"><span class="flow-idx">${i + 1}</span>`
        + `<span class="flow-name">${esc(g.name)}</span>`
        + `<span class="flow-objs">${objs || '<span class="muted">未指明业务对象</span>'}</span></div>`;
    }).join('');
    $$('#ledger-flow .flow-link').forEach(btn => { btn.onclick = () => focusTable(btn.dataset.flowTable, btn.dataset.flowLabel); });
  }

  /** 业务链路里点一下业务对象，就在画布上选中它并把详情面板切过去 */
  function focusTable(table, label) {
    const node = S.graph.nodes.find(n => n.table === table || n.sub === table || n.label === label || n.id === table);
    if (!node) { toast('画布上找不到这张表对应的节点', 'error'); return; }
    S.selection = { kind: 'node', id: node.id };
    switchTab('detail');
    renderGraph();
    renderDetail();
  }




  /* 规则设立：文档 + 图谱口径 → 业务审查规则 → SQL。本平台只产规则，不执行规则。 */
  function renderRules() {
    const r = S.summary;
    if (!r) return;
    const spec = r.ruleSpecs;
    const st = $('rules-status');
    if (!r.understandingFinal) {
      st.textContent = '先把业务理解稿定稿：规则要落在已确认的业务对象与业务关系上';
      st.className = 'warning-box';
    } else if (!spec) {
      st.textContent = '图谱口径已就绪，粘贴审查条款后点「解析文档并生成规则」';
      st.className = 'mode-line';
    } else {
      const rounds = Number(spec.rounds || 1);
      st.textContent = `已生成 ${spec.rules.length} 条规则 · ${String(spec.dialect || 'ansi').toUpperCase()} 方言 · 依据 ${spec.source?.chars || 0} 字文档`
        + (rounds > 1 ? ` · 分 ${rounds} 轮生成` : '')
        + (spec.truncated ? ' · 可能未覆盖全部审查点' : '');
      st.className = (spec.warnings?.length || spec.truncated) ? 'warning-box' : 'mode-line';
    }
    $('rules-context').innerHTML = spec
      ? [`<span class="stat"><b>${spec.graph.classes}</b>业务对象</span>`,
         `<span class="stat"><b>${spec.graph.relations}</b>业务关系</span>`,
         `<span class="stat"><b>${spec.rules.length}</b>条规则</span>`,
         `<span class="stat"><b>${spec.rules.reduce((n, x) => n + x.checks.length, 0)}</b>个判定条件</span>`].join('')
      : '';
    if (spec && $('rule-dialect')) $('rule-dialect').value = spec.dialect || 'ansi';

    const list = spec?.rules || [];
    const sevLabel = { high: '高', medium: '中', low: '低' };
    const sevTag = { high: 'missing', medium: 'suspected', low: 'matched' };
    $('rules-list').innerHTML = list.length
      ? list.map(x => `
      <div class="rule-card">
        <div class="li-head">
          <span class="tag ${sevTag[x.severity] || 'suspected'}">${sevLabel[x.severity] || '中'}风险</span>
          <span class="li-term">${esc(x.name)}</span>
          <button class="btn btn-sm" data-rule-copy="${esc(x.id)}">复制 SQL</button>
          <button class="btn btn-sm" data-rule-del="${esc(x.id)}">删除</button>
        </div>
        ${x.intent ? `<div class="li-body">${esc(x.intent)}</div>` : ''}
        ${x.basis ? `<div class="li-src">依据：${esc(x.basis)}</div>` : ''}
        <div class="li-src">命中条件：${x.checks.map(c => esc(c.message)).join('；')}</div>
        <pre class="code-preview rule-sql">${esc(x.sql)}</pre>
      </div>`).join('') + (spec?.warnings?.length ? `<div class="warning-box">${spec.warnings.map(w => esc(w)).join('<br>')}</div>` : '')
      : '<div class="empty-hint">还没有规则。规则来自你提供的审查条款，不是平台预置的。</div>';

    $$('[data-rule-del]').forEach(b => b.onclick = async () => {
      if (!confirm('从规则清单里删掉这条规则？')) return;
      busy(true, '正在删除规则…');
      try {
        const res = await api(`/api/projects/${S.projectId}/rule-spec-remove`, { method: 'POST', body: JSON.stringify({ ruleId: b.dataset.ruleDel }) });
        applySummary(res, { keepSelection: true });
        toast('已删除该规则', 'ok');
      } catch (e) { toast(e.message, 'error'); } finally { busy(false); }
    });
    $$('[data-rule-copy]').forEach(b => b.onclick = async () => {
      const sql = (S.summary.ruleSpecs?.rules || []).find(x => x.id === b.dataset.ruleCopy)?.sql || '';
      try { await navigator.clipboard.writeText(sql); toast('SQL 已复制', 'ok'); }
      catch { toast('浏览器不允许写剪贴板，请在下方 SQL 里手动选中复制', 'error'); }
    });
  }


  /* ---------------- 图谱构建（草稿图谱 / OWL 图谱） ---------------- */

  /* 关系清单 = 理解稿里的关系 + 图上改过的暂存 + 人工补的边。
     「命名即确认」：有业务名的边进本体，仍叫「待确认关系」的不进。 */
  /* 关系名是不是只有通用动词（「关联/依据/包含」），读不出业务动作。
     服务端也算过一份，这里跟着暂存编辑重算，改名后提示能立刻消失。 */
  const GENERIC_VERBS = ['属于', '包含', '关联', '依据', '对应', '产生', '引用', '指向', '使用', '拥有', '涉及', '归属', '继承', '衍生'];
  const ACTION_WORDS = /(收货|入库|出库|开票|结算|付款|验收|核销|领用|退回|冲销|结转|锁定|变更|终止|生效|审批|签约|履约|对账|计提|报废|盘点|调拨|预提|预付|计税|扣款)/;
  /* ---------------- 第 6 步：真实单据数据 → 实例图谱 ---------------- */

  const IG_KIND = {
    'no-primary-key': '没有主键', 'duplicate-key': '主键重复', 'dangling-fk': '外键悬空',
    'empty-fk': '外键为空', 'no-children': '父单无子行', 'cardinality-1n': '基数不符',
    'relation-unresolved': '关系没落地'
  };
  const IG_LEVEL = { error: '错误', warn: '提醒', info: '提示' };

  /** 边上这条关系到底是不是用户认过的：确认过的才进本体，候选的编不了 OWL */
  const edgeStatusText = s => s === 'confirmed' ? '已确认（已进本体）'
    : s === 'candidate' ? '候选（未确认，没进本体）'
    : s === 'dangling' ? '端点悬空（找不到对应类）' : '未标注';

  /** 基数符号按箭头方向读（来源:目标），翻成业务话：哪一端有多条 */
  function readCardinality(card, from, to) {
    if (card === 'N:1') return `多张${from}同属一份${to}（一份${to}有多条${from}）`;
    if (card === '1:N') return `一份${from}对应多份${to}（一份${from}下有多条${to}）`;
    if (card === 'N:M') return `多份${from}与多份${to}互相引用，没有单一归属`;
    if (card === '1:1') return `一份${from}只对应一份${to}`;
    return '装的数据里没算出基数';
  }

  function renderInstFiles() {
    const box = $('inst-file-list');
    if (!box) return;
    $('btn-instance-load').disabled = !S.instFiles.length;
    if (!S.instFiles.length) { box.innerHTML = '<div class="empty-hint">还没有选择单据文件</div>'; return; }
    box.innerHTML = S.instFiles.map((f, i) =>
      `<div class="file-item"><span class="frole">单据</span>` +
      `<span class="fname" title="${esc(f.name)}">${esc(f.name)}</span>` +
      `<span class="muted" style="font-size:10px">${(String(f.content || '').length / 1024).toFixed(1)}KB</span>` +
      `<button class="fremove" data-ii="${i}" title="移除">×</button></div>`).join('');
    box.querySelectorAll('.fremove').forEach(b => b.onclick = () => { S.instFiles.splice(Number(b.dataset.ii), 1); renderInstFiles(); });
  }

  function renderInstance() {
    const r = S.summary, d = r?.instanceData;
    const st = $('instance-status'), stats = $('instance-stats');
    if (!st) return;
    if (!d) {
      st.textContent = '尚未装载单据数据';
      st.className = 'mode-line';
      stats.innerHTML = '';
      $('integrity-summary').textContent = '尚未装载数据';
      $('integrity-summary').className = 'validation-summary';
      $('integrity-list').innerHTML = '';
      if ($('instance-relations')) {
        $('instance-relations').textContent = '尚未装载数据';
        $('instance-relations').className = 'validation-summary';
        $('instance-rel-list').innerHTML = '';
      }
      $('instance-unmatched').innerHTML = '<div class="empty-hint">无</div>';
      return;
    }
    const fromMaterials = d.origin === 'materials';
    st.textContent = fromMaterials
      ? `已按第 1 步上传的材料自动出图 · ${d.loadedAt.replace('T', ' ').slice(0, 16)} · ${d.stats.rows} 行数据`
      : `已于 ${d.loadedAt.replace('T', ' ').slice(0, 16)} 装载 · ${d.by || ''}`.trim();
    st.className = 'mode-line';
    const s = d.stats;
    stats.innerHTML = [
      `<span class="stat"><b>${s.files}</b>${fromMaterials ? '份材料' : '个文件'}</span>`,
      `<span class="stat"><b>${s.tables}</b>张表</span>`,
      `<span class="stat"><b>${s.rows}</b>行数据</span>`,
      `<span class="stat"><b>${s.individuals}</b>个实例</span>`,
      `<span class="stat"><b>${s.assertions}</b>条断言</span>`
    ].join('');

    const ig = d.integrity || { issues: [], stats: {} };
    const sum = $('integrity-summary');
    const box = ig.stats;
    if (!ig.issues.length) {
      const checked = box.checkedRelations;
      sum.textContent = checked
        ? `四类检查全部通过：主键唯一、外键能对上、单据衔接完整（沿 ${checked} 条关系查过）`
        : '四类检查全部通过：主键唯一、外键能对上、单据衔接完整';
      sum.className = 'validation-summary pass';
    } else {
      sum.textContent = `${box.errors || 0} 处错误 · ${box.warns || 0} 处提醒 · ${box.infos || 0} 处提示（只报不改，图上照样出）`
        + (box.checkedRelations ? ` · 沿 ${box.checkedRelations}/${box.relations || box.checkedRelations} 条关系查过` : '');
      sum.className = 'validation-summary ' + ((box.errors || 0) ? 'fail' : '');
    }
    $('integrity-list').innerHTML = ig.issues.map(i => {
      const head = i.link || i.tableLabel || i.table || '实例';
      const samples = (i.samples || []).length ? `<div class="ig-samples">${i.samples.map(esc).join('；')}</div>` : '';
      return `<div class="ig-item ${esc(i.level)}">` +
        `<div class="ig-head"><span class="ig-badge">${esc(IG_LEVEL[i.level] || i.level)}</span>` +
        `<span>${esc(IG_KIND[i.kind] || i.kind)}</span><span>${esc(head)}</span>` +
        `<span class="ig-badge">${i.count || 0} 处</span></div>` +
        `<div class="ig-detail">${esc(i.detail || '')}</div>${samples}</div>`;
    }).join('');

    /* 关系落地：业务关系到底落到哪两列上，是哪来的，覆盖多少。
       这一步不写清楚，用户会以为「关系解析出来了但图上没看到」是画的问题。 */
    const relBox = $('instance-relations'), relList = $('instance-rel-list');
    if (relBox) {
      const rel = d.relations;
      if (!rel || !rel.joins?.length) {
        relBox.textContent = '没有已确认的业务关系可落地';
        relBox.className = 'validation-summary';
        relList.innerHTML = '';
      } else {
        const rs = rel.stats;
        relBox.textContent = `${rs.total} 条业务关系，${rs.resolved} 条落到字段上`
          + (rs.declared ? `（${rs.declared} 条按理解稿/表结构声明` + (rs.inferred ? `，${rs.inferred} 条推断` : '') + '）' : '')
          + (rs.unresolved ? `，${rs.unresolved} 条没落地` : '')
          + (rs.oneToMany ? ` · ${rs.oneToMany} 条是一对多` : '');
        relBox.className = 'validation-summary ' + (rs.unresolved ? 'fail' : 'pass');
        relList.innerHTML = rel.joins.map(j => {
          const ok = j.origin !== 'unresolved';
          const cardTxt = j.actualCardinality || j.cardinality || '';
          const card = cardTxt ? `<span class="ig-badge">${esc(cardTxt)}</span>` : '';
          const cols = ok ? `${esc(j.sourceColumnLabel)} → ${esc(j.refColumnLabel)}` : '未落地';
          return `<div class="ig-item ${ok ? 'info' : 'warn'}">` +
            `<div class="ig-head"><span class="ig-badge">${ok ? (j.origin === 'declared' ? '声明' : '推断') : '未落地'}</span>` +
            `<span>${esc(j.relation)}</span><span>${esc(j.sourceLabel)} → ${esc(j.refLabel)}</span>${card}</div>` +
            `<div class="ig-detail">关联字段：${cols}` +
            (ok ? ` · 覆盖 ${Math.round((j.coverage || 0) * 100)}% · 共 ${j.pairs || 0} 对单据关联` : '') +
            (ok && j.maxChildren > 1 ? ` · 一份${esc(j.refLabel)}最多对应 ${j.maxChildren} 张${esc(j.sourceLabel)}` : '') +
            `</div></div>`;
        }).join('');
      }
    }

    $('instance-unmatched').innerHTML = (d.unmatched || []).length
      ? d.unmatched.map(u => `<div class="ledger-item"><div class="li-head"><span class="li-term">${esc(u.file)}${u.table ? ' / ' + esc(u.table) : ''}</span></div>` +
        `<div class="li-body">${esc(u.reason)}</div></div>`).join('')
      : '<div class="empty-hint">所有文件都对上了表</div>';
  }

  async function addInstFiles(fileList) {
    const list = Array.from(fileList || []);
    let added = 0;
    for (const f of list) {
      if (f.size > 20 * 1024 * 1024) { toast('文件过大已跳过：' + f.name, 'error'); continue; }
      if (/\.xls$/i.test(f.name)) { toast('旧版 .xls 不支持，请另存为 .xlsx：' + f.name, 'error'); continue; }
      let content, encoding;
      if (/\.(xlsx|xlsm)$/i.test(f.name) || /\.(png|jpe?g|webp|bmp|gif)$/i.test(f.name)) {
        content = toBase64(await f.arrayBuffer()); encoding = 'base64';
      }
      else content = await f.text();
      S.instFiles = S.instFiles.filter(x => x.name !== f.name);
      S.instFiles.push({ name: f.name, content, encoding });
      added++;
    }
    renderInstFiles();
    if (added) { toast(`已加入 ${added} 份单据文件，点「装载并生成实例图谱」继续`, 'ok'); status(`已就绪 ${S.instFiles.length} 份单据文件`); }
  }

  async function loadInstance() {
    if (!S.projectId) { toast('请先上传材料、完成图谱确认并生成 OWL', 'error'); return; }
    if (!S.summary?.understandingFinal) { toast('请先在「图谱确认」里确认业务关系并生成 OWL', 'error'); return; }
    if (!S.instFiles.length) { toast('请先选择单据文件（CSV / xlsx）', 'error'); return; }
    busy(true, '正在装载单据数据、生成实例与完整性报告…');
    try {
      const res = await api(`/api/projects/${S.projectId}/instance-load`, {
        method: 'POST',
        body: JSON.stringify({ files: S.instFiles, by: $('project-name').value + ' · 业务用户' })
      });
      S.instFiles = [];
      renderInstFiles();
      applySummary(res, { keepSelection: false });
      setStep(6); switchTab('instance');
      switchLayer('instance', { fit: true });
      const s = res.instanceData?.stats || {};
      const ig = res.instanceData?.integrity?.stats || {};
      const notes = res.instanceData?.imageNotes || [];
      const head = `已生成 ${s.individuals || 0} 个实例；完整性 ${ig.errors || 0} 处错误、${ig.warns || 0} 处提醒`;
      toast(notes.length ? `${head}｜照片：${notes.join('；')}` : head, ig.errors ? 'error' : 'ok', notes.length ? 10000 : 0);
      status(`实例装载完成 · ${s.rows || 0} 行 → ${s.individuals || 0} 个实例`);
    } catch (e) { toast(e.message, 'error'); }
    finally { busy(false); }
  }

  function vaguePredicate(p) {
    const s = String(p || '').trim();
    if (!s || s === '待确认关系') return false;
    const hit = GENERIC_VERBS.find(v => s.startsWith(v));
    if (!hit) return false;
    const rest = s.slice(hit.length);
    return !rest || !ACTION_WORDS.test(rest);
  }

  function relList() {
    const u = S.summary?.understandingFinal || S.summary?.understanding;
    const shape = (base, id, fallbackPredicate) => {
      const e = S.relEdits[id] || {};
      const predicate = e.predicate !== undefined ? e.predicate : fallbackPredicate;
      const meaning = e.meaning !== undefined ? e.meaning : (base.meaning || '');
      const rejected = e.rejected !== undefined ? !!e.rejected : base.status === 'rejected';
      const named = !!predicate && predicate !== '待确认关系';
      const reversed = !!e.reversed;
      return {
        ...base, predicate, meaning, rejected, named, reversed,
        vague: named && vaguePredicate(predicate),
        noMeaning: named && !String(meaning || '').trim(),
        subject: reversed ? base.object : base.subject,
        object: reversed ? base.subject : base.object,
        status: rejected ? 'rejected' : (named ? 'confirmed' : 'candidate')
      };
    };
    const base = (u?.relations || []).map(r => shape(r, r.id, r.predicate));
    const adds = S.relAdds.map(a => shape({ ...a, added: true }, a.id, a.predicate));
    return base.concat(adds);
  }
  function relEdit(id, patch) { S.relEdits[id] = { ...(S.relEdits[id] || {}), ...patch }; }

  /* 把暂存编辑翻译成理解稿批注：改名 / 删除 / 反转 / 新增，一次提交 */
  function buildRelationAnnotations() {
    const u = S.summary?.understandingFinal || S.summary?.understanding;
    const out = [];
    for (const r of (u?.relations || [])) {
      const e = S.relEdits[r.id];
      if (!e) continue;
      if (e.rejected) { out.push({ targetId: r.id, kind: 'rejectRelation' }); continue; }
      if (e.predicate !== undefined && e.predicate && e.predicate !== r.predicate) {
        out.push({ targetId: r.id, kind: 'renameRelation', value: e.predicate });
      }
      if (e.meaning !== undefined && e.meaning !== (r.meaning || '')) {
        out.push({ targetId: r.id, kind: 'describeRelation', value: e.meaning });
      }
      if (e.reversed) out.push({ targetId: r.id, kind: 'reverseRelation' });
    }
    for (const a of S.relAdds) {
      const e = S.relEdits[a.id] || {};
      if (e.rejected) continue;
      const predicate = e.predicate !== undefined ? e.predicate : a.predicate;
      const subject = e.reversed ? a.object : a.subject;
      const object = e.reversed ? a.subject : a.object;
      const meaning = (e.meaning !== undefined ? e.meaning : (a.meaning || '')).trim();
      if (predicate && subject && object) {
        out.push({ kind: 'addRelation', value: `${subject}|${predicate}|${object}${meaning ? '|' + meaning : ''}` });
      }
    }
    return out;
  }

  /* 草稿图谱：理解稿一出稿就画出来，不经过 OWL；确认并编译后才切到 OWL 图谱 */
  function isDraftGraph() {
    const r = S.summary;
    if (!r || S.layer !== 'schema') return false;
    if (!(r.understandingFinal || r.understanding)) return false;
    /* 台账里改名/删关系时先看草稿（编辑效果要立刻可见）；定稿并编译之后以 OWL 为准 */
    if (S.preferDraft) return true;
    if (!r.understandingFinal) return true;
    return !S.owlJson;
  }
  function refreshDraft() {
    S.preferDraft = true;
    buildGraph(false); renderGraph(); renderLedger(); renderDetail();
    S.preferDraft = false;
  }

  function buildGraph(reset) {
    const r = S.summary, owl = S.owlJson;
    if (!r) { S.graph = { nodes: [], edges: [] }; return; }

    if (isDraftGraph()) {
      const dg = r.draftGraph || { elements: [] };
      const nodes = dg.elements.filter(e => !e.data.source).map(e => ({
        id: e.data.id, label: e.data.label,
        /* 表格是 CSV 派生的表名会是一串内部编号（t2_c0416d），对业务用户没意义，不如不显示 */
        sub: looksGenerated(e.data.table) ? '' : (e.data.table || ''),
        table: e.data.table || '',
        kind: 'class', draft: true,
        role: e.data.role || '', meaning: e.data.meaning || '',
        w: Math.min(176, Math.max(94, String(e.data.label || '').length * 13 + 34)), h: 44
      }));
      /* 草稿边的端点靠「表名」对上节点。这里踩过一个坑：原先只拿节点副标题 sub 建索引，
         而 CSV 派生的表名是 t2_c0416d 这种编号、sub 会被置空，于是索引全空、8 条关系全被丢掉，
         界面显示「0 条业务关系」——用户看到的就是「点了理解稿没有任何关系」。
         节点 id 本身就是表名（graphs.mjs 里 draftGraph 用的同一套），三套键都登记一遍。 */
      const byKey = new Map();
      nodes.forEach(n => {
        [n.id, n.table, n.sub, n.label].filter(Boolean).forEach(k => byKey.set(k, n.id));
      });
      const edges = relList().filter(x => !x.rejected).map(x => {
        const from = byKey.get(x.subject), to = byKey.get(x.object);
        if (!from || !to) return null;
        return {
          id: 'rel:' + x.id, relationId: x.id, source: from, target: to,
          label: x.predicate, status: x.status, via: x.via || [], basis: x.basis || '',
          meaning: x.meaning || '',
          added: !!x.added, kind: 'draftRel', valid: true
        };
      }).filter(Boolean);
      S.graph = { nodes, edges, mode: 'draft' };
      if (S.showLabels === null) S.showLabels = true;
      updateLabelButton();
      return reset ? layoutGraph() : preservePositions();
    }

    if (!owl || !r.graph) { S.graph = { nodes: [], edges: [] }; return; }
    if (S.layer === 'schema') {
      /* 节点副标题放字段数，不放内部标识（t1_c218d8 这种编号对业务用户没有信息量） */
      const fieldCount = new Map();
      (owl.dataProperties || []).forEach(p => { const d = p.domains?.[0]; if (d) fieldCount.set(d, (fieldCount.get(d) || 0) + 1); });
      const nodes = (owl.classes || []).map(c => ({
        id: c.iri, iri: c.iri, label: c.localName || short(c.iri),
        sub: `${fieldCount.get(c.iri) || 0} 个字段`, table: c.sourceTable || '',
        kind: 'class', w: Math.min(176, Math.max(94, String(c.localName || '').length * 13 + 34)), h: 44
      }));
      const known = new Set(nodes.map(n => n.id));
      /* 边按状态着色：确认过的实线高亮、候选的橙色虚线、端点悬空的灰色虚线。
         编译后的 OWL 里没有 status 字段，状态从规范模型按 id 取——两边 id 是同一套。 */
      const canon = new Map((r.canonical?.objectProperties || []).map(p => [p.id, p]));
      /* 实例数据在的时候，把「N」换成真实数字：N:1 → 9:1（每份合同最多 9 张订单） */
      const joinByProp = new Map((r.instanceData?.relations?.joins || [])
        .filter(j => j.origin !== 'unresolved').map(j => [j.id, j]));
      const edges = [];
      (owl.objectProperties || []).forEach((p, i) => {
        const src = p.domains?.[0], tgt = p.ranges?.[0];
        if (!src || !tgt) return;
        /* 本体态的边也带业务含义：优先取 omw:businessMeaning，退到 rdfs:comment */
        const ann = p.annotations || [];
        const meaning = (ann.find(a => /businessMeaning$/.test(a.property || '')) || {}).value
          || (ann.find(a => a.property === 'rdfs:comment') || {}).value || '';
        const c = canon.get(p.id);
        const j = joinByProp.get(p.id);
        const ok = known.has(src) && known.has(tgt);
        edges.push({
          id: 'rel:' + (p.iri || 'r' + i), source: src, target: tgt, label: p.localName || short(p.iri),
          meaning, iri: p.iri, kind: 'objectProperty', propId: p.id, valid: ok,
          status: !ok ? 'dangling' : (c?.status === 'candidate' ? 'candidate' : 'confirmed'),
          cardinality: c?.cardinality || '',
          actualCardinality: j?.actualCardinality || '', actualText: j?.actualText || '',
          maxChildren: j?.maxChildren || 0, pairs: j?.pairs || 0
        });
      });
      (owl.classes || []).forEach(c => (c.superClassExpressions || []).forEach((e, i) => {
        if (e.classIRI && known.has(e.classIRI)) edges.push({ id: 'parent:' + c.iri + ':' + i, source: c.iri, target: e.classIRI, label: '继承', kind: 'parent', valid: true, ownerIri: c.iri, index: i });
      }));
      S.graph = { nodes, edges };
    } else {
      /* 实例图谱只认「第 6 步装载出来的那张图」。唯一的例外是直接导入的 OWL 文件：
         那种项目没有表结构流程，个体本来就写在文件里，展示出来才不丢东西。 */
      const imported = !r.canonical && (r.owlInputs || []).length > 0;
      const real = r.instanceData?.graph?.elements || [];
      const sample = imported ? (r.graph.instance?.elements || []) : [];
      const src = real.length ? real : sample;
      const cap = 300;
      const nodeEls = src.filter(e => !e.data.source).slice(0, cap);
      const known = new Set(nodeEls.map(e => e.data.id));
      const nodes = nodeEls.map(e => {
        const sub = e.data.sub || e.data.type || '实例';
        const summary = e.data.summary || '';
        /* 单据上多一行关键信息（供应商 / 物料 / 金额），节点得相应加高加宽 */
        return {
          id: e.data.id, iri: e.data.id, label: e.data.label || short(e.data.id), sub, summary,
          fanin: e.data.fanin || 0,
          kind: 'instance', orphan: !!e.data.orphan, table: e.data.table || '',
          w: Math.min(230, Math.max(118, String(e.data.label || '').length * 12 + 24, sub.length * 7 + 30, summary.length * 6.1 + 26)),
          h: summary ? 52 : 34
        };
      });
      const edges = src.filter(e => e.data.source && known.has(e.data.source) && known.has(e.data.target)).slice(0, 600).map((e, i) => ({
        id: e.data.id || 'ie' + i, source: e.data.source, target: e.data.target, label: e.data.label || '关联',
        kind: 'instanceRel', valid: true,
        /* 这条边靠哪两列连的；类型级基数（N:1）留给详情面板解释，别贴在每一条线上 */
        cardinality: e.data.cardinality || '', cardinalityText: e.data.cardinalityText || '',
        maxChildren: e.data.maxChildren || 0, pairs: e.data.pairs || 0,
        sourceColumnLabel: e.data.sourceColumnLabel || '', refColumnLabel: e.data.refColumnLabel || ''
      }));
      S.graph = {
        nodes, edges, mode: real.length ? 'instance' : (src.length ? 'sample' : 'none'),
        source: real.length ? 'real' : (src.length ? 'sample' : 'none'),
        truncated: src.filter(e => !e.data.source).length > cap, limit: cap
      };
    }
    if (!S.graph.mode) S.graph.mode = 'owl';
    if (S.showLabels === null) S.showLabels = S.graph.edges.length <= 35;
    updateLabelButton();
    return reset ? layoutGraph() : preservePositions();
  }

  function updateLabelButton() {
    $('btn-toggle-labels').textContent = '关系名：' + (S.showLabels ? '显示' : '隐藏');
    $('btn-toggle-labels').classList.toggle('btn-primary', !!S.showLabels);
  }

  function preservePositions() {
    const P = posMap();
    const nodes = S.graph.nodes;
    const missing = nodes.filter(nd => !P[nd.id]);
    const placed = nodes.filter(nd => P[nd.id]);
    /* 整张图都是新节点（首次出图）：走完整布局。
       旧版这里给每个新节点随机撒在 400±60 / 300±60 的小方块里，
       节点一多必然叠成一团——「第一次生成的图谱挤在一起」就是这么来的。 */
    if (!placed.length) { layoutGraph(); return true; }
    placed.forEach(nd => { const p = P[nd.id]; nd.x = p.x; nd.y = p.y; nd.pinned = p.pinned; });
    if (missing.length) {
      /* 只补新节点：摆在已有布局的外圈，不去动用户已经摆好的位置 */
      const cx = placed.reduce((a, nd) => a + nd.x, 0) / placed.length;
      const cy = placed.reduce((a, nd) => a + nd.y, 0) / placed.length;
      const spread = Math.max(0, ...placed.map(nd => Math.hypot(nd.x - cx, nd.y - cy)));
      const r = spread + 180;
      missing.forEach((nd, i) => {
        const a = 2 * Math.PI * i / Math.max(1, missing.length) - Math.PI / 2;
        nd.x = cx + r * Math.cos(a); nd.y = cy + r * Math.sin(a) * 0.8; nd.pinned = false;
      });
      separateBoxes(nodes, new Set(missing.map(nd => nd.id)));
    }
    nodes.forEach(nd => { P[nd.id] = { x: nd.x, y: nd.y, pinned: !!nd.pinned }; });
    return false;
  }

  function canvasSize() {
    const el = $('canvas-wrap');
    return { W: Math.max(600, el.clientWidth), H: Math.max(420, el.clientHeight) };
  }

  /** 力导向布局：只在「重新布局 / 首次成图」时跑，拖拽后的位置会被保留。
      关键点：节点是有宽高的方框，不是质点。排斥与去重叠都按包围盒算，
      否则一圈节点会挤在一起（旧版就是按质点算的，11 个节点必然叠）。 */
  const NODE_PAD_X = 46, NODE_PAD_Y = 36;

  /* 分层布局：按关系把节点排成从左到右的列。
     单据流（合同 → 订单 → 入库 → 开票 → 结算 …）本来就是一条条往右走的链，
     力导向在窄画布上会把几十个实例推成一竖列，看着像「摆放出了问题」。
     只有存在关系时才用；返回 false 表示这次不适用，交回力导向。 */
  function layeredLayout(nodes, edges) {
    const n = nodes.length;
    if (n < 8 || !edges.length) return false;
    const byId = new Map(nodes.map(x => [x.id, x]));
    const links = edges.filter(e => byId.has(e.source) && byId.has(e.target) && e.source !== e.target);
    if (!links.length) return false;

    /* 最长路径分层：level[v] = max(level[u] + 1)。有环时用轮数兜底，最多跑 n 轮。 */
    const level = new Map(nodes.map(x => [x.id, 0]));
    for (let pass = 0; pass < n; pass++) {
      let changed = false;
      for (const e of links) {
        const want = (level.get(e.source) || 0) + 1;
        if ((level.get(e.target) || 0) < want) { level.set(e.target, want); changed = true; }
      }
      if (!changed) break;
    }
    const cols = new Map();
    nodes.forEach(nd => {
      const l = level.get(nd.id) || 0;
      (cols.get(l) || cols.set(l, []).get(l)).push(nd);
    });
    const levels = [...cols.keys()].sort((a, b) => a - b);

    /* 列内排序：按上游节点的平均顺序（重心法），让连线尽量少交叉；没有上游就按原顺序。 */
    const order = new Map(nodes.map((nd, i) => [nd.id, i]));
    for (const l of levels) {
      const list = cols.get(l);
      list.sort((a, b) => {
        const bary = nd => {
          const ups = links.filter(e => e.target === nd.id).map(e => order.get(e.source) ?? 0);
          return ups.length ? ups.reduce((s, v) => s + v, 0) / ups.length : (order.get(nd.id) ?? 0);
        };
        return bary(a) - bary(b);
      });
      list.forEach((nd, i) => order.set(nd.id, i));
    }

    /* 位置：列宽按该列最宽的节点算，列内按最高节点定行距，整体垂直居中。 */
    const gapX = 92, gapY = 26;
    const colW = levels.map(l => Math.max(...cols.get(l).map(nd => nd.w)));
    const totalW = colW.reduce((a, w) => a + w, 0) + gapX * (levels.length - 1);
    let x = (canvasSize().W - totalW) / 2;
    levels.forEach((l, ci) => {
      const list = cols.get(l);
      const colH = list.reduce((a, nd) => a + nd.h, 0) + gapY * (list.length - 1);
      let y = (canvasSize().H - colH) / 2 + list[0].h / 2;
      list.forEach(nd => {
        nd.x = x + colW[ci] / 2;
        nd.y = y;
        y += nd.h + gapY;
        nd.vx = 0; nd.vy = 0; nd.pinned = false;
      });
      x += colW[ci] + gapX;
    });
    separateBoxes(nodes, null);
    return true;
  }

  function layoutGraph() {
    const { W, H } = canvasSize();
    const nodes = S.graph.nodes, edges = S.graph.edges;
    const n = nodes.length;
    if (!n) return false;
    /* 有关系的图先试分层（单据流左→右）；撑不住再退回力导向 */
    if (layeredLayout(nodes, edges)) {
      S.positions[S.layer] = Object.fromEntries(nodes.map(x => [x.id, { x: x.x, y: x.y, pinned: false }]));
      return true;
    }
    const avgW = nodes.reduce((a, nd) => a + nd.w, 0) / n;

    /* 初始位：环形，但半径按「所有节点宽度之和」算，保证第一帧就不重叠 */
    const sumW = nodes.reduce((a, nd) => a + nd.w + NODE_PAD_X, 0);
    const ringR = Math.min(
      Math.max(sumW / (2 * Math.PI) * 0.62, avgW * 1.35),
      Math.min(W, H) * 0.44
    );
    nodes.forEach((nd, i) => {
      const a = 2 * Math.PI * i / n - Math.PI / 2;
      nd.x = W / 2 + ringR * Math.cos(a);
      nd.y = H / 2 + ringR * Math.sin(a) * 0.8;
      nd.vx = 0; nd.vy = 0; nd.pinned = false;
    });

    const byId = new Map(nodes.map(x => [x.id, x]));
    const links = edges.filter(e => byId.has(e.source) && byId.has(e.target)).map(e => [byId.get(e.source), byId.get(e.target)]);
    const idealX = Math.max(170, avgW + NODE_PAD_X + 12);
    const iterations = n > 60 ? 140 : 260;

    for (let it = 0; it < iterations; it++) {
      /* 1) 包围盒排斥：只有真的挤到才推，推的方向是穿透更浅的那一维 */
      for (let i = 0; i < n; i++) {
        const a = nodes[i];
        for (let j = i + 1; j < n; j++) {
          const b = nodes[j];
          const dx = b.x - a.x, dy = b.y - a.y;
          const needX = (a.w + b.w) / 2 + NODE_PAD_X;
          const needY = (a.h + b.h) / 2 + NODE_PAD_Y;
          const ox = needX - Math.abs(dx), oy = needY - Math.abs(dy);
          if (ox <= 0 || oy <= 0) continue;
          if (ox < oy) {
            const s = dx >= 0 ? 1 : -1, f = Math.min(18, ox * 0.28 + 0.6);
            a.vx -= s * f; b.vx += s * f;
          } else {
            const s = dy >= 0 ? 1 : -1, f = Math.min(18, oy * 0.34 + 0.6);
            a.vy -= s * f; b.vy += s * f;
          }
        }
      }
      /* 2) 有关系的互相靠近，让链路读起来是链而不是散点 */
      for (const [a, b] of links) {
        const dx = b.x - a.x, dy = b.y - a.y, d = Math.max(1, Math.hypot(dx, dy));
        const f = (d - idealX) * 0.02 / d;
        a.vx += dx * f; a.vy += dy * f; b.vx -= dx * f; b.vy -= dy * f;
      }
      /* 3) 向画布中心轻微收拢 + 阻尼 */
      for (const a of nodes) {
        a.vx += (W / 2 - a.x) * 0.004; a.vy += (H / 2 - a.y) * 0.004;
        a.vx *= 0.72; a.vy *= 0.72;
        const v = Math.hypot(a.vx, a.vy), max = 26;
        if (v > max) { a.vx *= max / v; a.vy *= max / v; }
        a.x += a.vx; a.y += a.vy;
      }
    }

    /* 4) 收尾去重叠：力导向收敛后仍可能有零星重叠，这里逐对推开到彻底分开。 */
    separateBoxes(nodes, null);
    S.positions[S.layer] = Object.fromEntries(nodes.map(x => [x.id, { x: x.x, y: x.y, pinned: false }]));
    return true;
  }

  /** 把互相压住的方框推开。movable 为 null 表示都能动；
      给了名单就只动名单里的（新增节点不许挪动用户已经摆好的位置）。
      纯确定性：不用随机，同样输入每次得到同样结果，方便复现问题。 */
  function separateBoxes(nodes, movable) {
    const n = nodes.length;
    for (let pass = 0; pass < 200; pass++) {
      let moved = false;
      for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
          const a = nodes[i], b = nodes[j];
          const dx = b.x - a.x, dy = b.y - a.y;
          const ox = (a.w + b.w) / 2 + NODE_PAD_X - Math.abs(dx);
          const oy = (a.h + b.h) / 2 + NODE_PAD_Y - Math.abs(dy);
          if (ox <= 0 || oy <= 0) continue;
          const ma = !movable || movable.has(a.id), mb = !movable || movable.has(b.id);
          if (!ma && !mb) continue;
          moved = true;
          const share = ma && mb ? 0.5 : 1;   /* 只有一边能动时，让能动的全让 */
          if (ox < oy) {
            const s = dx >= 0 ? 1 : -1;
            if (ma) a.x -= s * ox * share;
            if (mb) b.x += s * ox * share;
          } else {
            const s = dy >= 0 ? 1 : -1;
            if (ma) a.y -= s * oy * share;
            if (mb) b.y += s * oy * share;
          }
        }
      }
      if (!moved) break;
    }
  }

  /* ---------------- SVG 活图谱渲染 ---------------- */

  let rafPending = false;
  function requestRender() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => { rafPending = false; renderGraph(); });
  }

  function edgeGeometry(e, byId) {
    const a = byId.get(e.source), b = byId.get(e.target);
    if (!a || !b) return null;
    if (a === b) {
      const x = a.x, y = a.y - a.h / 2;
      return { path: `M ${x - 12} ${y} C ${x - 62} ${y - 62}, ${x + 62} ${y - 62}, ${x + 12} ${y}`, lx: x, ly: y - 44, ok: true };
    }
    let dx = b.x - a.x, dy = b.y - a.y, d = Math.max(1, Math.hypot(dx, dy));
    const ux = dx / d, uy = dy / d;
    const ta = Math.min((a.w / 2 + 6) / Math.max(Math.abs(ux), 0.001), (a.h / 2 + 6) / Math.max(Math.abs(uy), 0.001));
    const tb = Math.min((b.w / 2 + 9) / Math.max(Math.abs(ux), 0.001), (b.h / 2 + 9) / Math.max(Math.abs(uy), 0.001));
    const x1 = a.x + ux * ta, y1 = a.y + uy * ta, x2 = b.x - ux * tb, y2 = b.y - uy * tb;
    const off = e.bend || 0;
    const cx = (x1 + x2) / 2 - uy * off, cy = (y1 + y2) / 2 + ux * off;
    /* q 是弧线的三个控制点：标签避让要沿弧线换位置，只有中点不够用 */
    return { path: `M ${x1.toFixed(1)} ${y1.toFixed(1)} Q ${cx.toFixed(1)} ${cy.toFixed(1)} ${x2.toFixed(1)} ${y2.toFixed(1)}`, lx: (x1 + 2 * cx + x2) / 4, ly: (y1 + 2 * cy + y2) / 4, q: { x1, y1, cx, cy, x2, y2 }, ok: true };
  }

  /** 空画布也要说清楚「下一步做什么」，两个 tab 的原因不一样 */
  function renderEmptyState() {
    const title = $('graph-empty-title'), hint = $('graph-empty-hint'), action = $('graph-empty-action');
    if (S.layer === 'instance') {
      const real = S.summary?.instanceData;
      if (real) {
        title.textContent = '实例图谱为空';
        hint.textContent = '装载的数据里没有任何可成图的实例；检查完整性报告，或换一批单据文件再来一次。';
        action.hidden = true;
        return;
      }
      title.textContent = '还没有装载实例数据';
      hint.textContent = '逻辑图谱与实例图谱分开：这里展示客户真实单据数据生成的知识图谱。先到右侧「实例数据」上载 CSV / xlsx（文件名或 sheet 名与表名一致）。';
      action.textContent = '去装载实例数据';
      action.hidden = false;
      action.onclick = () => switchTab('instance');
      return;
    }
    const r = S.summary;
    title.textContent = r?.canonical ? '逻辑图谱尚未生成' : '图谱尚未生成';
    hint.textContent = r?.canonical
      ? '先出一份业务理解稿（或手工建模），草稿图谱会立刻画出来。'
      : '在左侧上载表结构与业务描述，解析材料后建立规范模型。';
    action.textContent = r?.canonical ? '去出业务理解稿' : '去上载材料';
    action.hidden = false;
    action.onclick = () => {
      if (r?.canonical) switchTab('understanding');
      else $('dropzone').scrollIntoView({ behavior: 'smooth', block: 'center' });
    };
  }

  /* 关系清单：图上每条边都写「谁 — 什么关系 — 谁」，一条一行，不用悬停也能读全。
     图上标签要避让、要截断，关系一多就只剩名字；这一条是给"看不懂图"兜底的文字版。 */
  function renderRelStrip(edges, nodes, selId) {
    const el = $('graph-relstrip');
    if (!el) return;
    if (!edges.length) { el.hidden = true; el.innerHTML = ''; return; }
    const nm = new Map(nodes.map(n => [n.id, n.label || n.id]));
    const shown = edges.slice(0, 80);
    const chips = shown.map(e => {
      const a = nm.get(e.source) || '—', b = nm.get(e.target) || '—';
      const p = e.label || '关联';
      /* 清单和图上标签写同一个值：以前清单把 1:1 省掉不显示，
         同一张图里标签写着 1:1、清单光秃秃，看着像两套数据。 */
      const cardText = e.kind === 'instanceRel' ? '' : (e.actualCardinality || e.cardinality || '');
      const card = cardText ? `<span class="rel-card">${esc(cardText)}</span>` : '';
      const pend = e.status === 'candidate' || e.status === 'dangling' ? ' pending' : '';
      const tip = [a, p, b, e.meaning, e.actualText, e.sourceColumnLabel && e.refColumnLabel ? `字段：${e.sourceColumnLabel} → ${e.refColumnLabel}` : '']
        .filter(Boolean).join(' · ');
      return `<span class="rel-chip${pend}${selId === e.id ? ' on' : ''}" data-edge-id="${esc(e.id)}" title="${esc(tip)}">`
        + `<span class="rel-a">${esc(a)}</span><span class="rel-p">${esc(p)}</span><span class="rel-arrow">→</span><span class="rel-b">${esc(b)}</span>${card}</span>`;
    }).join('');
    const lead = `<span class="rel-strip-lead">${edges.length} 条关系${edges.length > shown.length ? `（列出前 ${shown.length} 条）` : ''}</span>`;
    el.innerHTML = lead + chips;
    el.hidden = false;
  }

  function renderGraph() {
    const svg = $('graph-svg'), vp = $('viewport');
    const { W, H } = canvasSize();
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    vp.setAttribute('transform', `translate(${S.view.tx},${S.view.ty}) scale(${S.view.k})`);
    $('zoom-label').textContent = Math.round(S.view.k * 100) + '%';

    const nodes = S.graph.nodes, edges = S.graph.edges;
    $('graph-empty').hidden = nodes.length > 0;
    if (!nodes.length) {
      renderEmptyState();
      $('edge-layer').innerHTML = ''; $('node-layer').innerHTML = '';
      $('graph-stats').textContent = '0 节点 / 0 边';
      $('selection-badge').hidden = true;
      renderRelStrip([], [], null);
      return;
    }
    const byId = new Map(nodes.map(x => [x.id, x]));
    const pair = {};
    edges.forEach(e => { const k = [e.source, e.target].sort().join('||'); (pair[k] ||= []).push(e); });
    Object.values(pair).forEach(list => list.forEach((e, i) => { e.bend = (i - (list.length - 1) / 2) * (S.layer === 'schema' ? 30 : 18); }));

    const selId = S.selection?.id;
    const search = ($('graph-search').value || '').trim().toLowerCase();
    const hits = new Set(search ? nodes.filter(n => (n.label + ' ' + n.sub).toLowerCase().includes(search)).map(n => n.id) : []);

    /* 标签避让：边密集时关键词会糊成一团，压到节点上更糟（节点盖住文字）。
       一条边有多个候选位置——先沿弧线换点，再沿法线让开，由近及远；
       第一个既不与已摆标签相交、也不压在任何节点方框上的位置胜出。
       一个都不合适就不画（悬停 title 里仍有关系名），选中的那条永远画。
       纯几何判断，不依赖浏览器度量，布局结果稳定可复现。 */
    const labelBoxes = [];
    const labelOk = new Map();
    const boxOf = (lx, ly, text) => {
      const w = text.length * 9.8 + 6;
      return { x: lx - w / 2, y: ly - 11, w, h: 13 };
    };
    const hitBox = (a, b) => Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) > 0
      && Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) > 0;
    /* 节点方框四周多留 3~5px：文字实际宽度比按字数估的略宽，
       不留余量时标签会擦着节点边框压上去。 */
    const nodeBoxes = nodes.map(nd => ({ x: nd.x - nd.w / 2 - 4, y: nd.y - nd.h / 2 - 6, w: nd.w + 8, h: nd.h + 12 }));
    const SPOTS = [[.5, 0], [.5, -26], [.5, 26], [.42, -18], [.58, 18], [.42, 18], [.58, -18], [.34, 0], [.66, 0], [.5, -44], [.5, 44]];
    const spotOf = (g, t, n) => {
      if (!g.q) return { x: g.lx, y: g.ly + n };   /* 自环：只有中点可用 */
      const { x1, y1, cx, cy, x2, y2 } = g.q;
      const mt = 1 - t;
      const x = mt * mt * x1 + 2 * mt * t * cx + t * t * x2;
      const y = mt * mt * y1 + 2 * mt * t * cy + t * t * y2;
      const dx = 2 * mt * (cx - x1) + 2 * t * (x2 - cx);
      const dy = 2 * mt * (cy - y1) + 2 * t * (y2 - cy);
      const len = Math.hypot(dx, dy) || 1;
      return { x: x + (dy / len) * n, y: y - (dx / len) * n };
    };
    /* 边的状态类：确认过的实线高亮、候选橙色虚线、端点悬空的灰色虚线。
       以前只有草稿图带状态，编成 OWL 之后全是同一种灰线——用户看不出哪条是自己认过的。 */
    const stateCls = e => {
      if (e.kind === 'draftRel') return ' draft' + (e.status === 'candidate' ? ' pending' : '');
      if (e.kind !== 'objectProperty') return '';
      if (e.status === 'confirmed') return ' confirmed';
      if (e.status === 'candidate') return ' pending';
      if (e.status === 'dangling') return ' dangling';
      return '';
    };
    /* 边名后面带上基数：一对一和一对多在图上是同一条线，不写基数根本分不出来。
       有实例数据时写实测值（9:1），没有就写语义值（N:1）。
       实例图上的边是一单对一单，贴 N:1 只会误导，名字后面不加基数。 */
    const labelText = e => {
      const base = String(e.label || '');
      if (e.kind === 'instanceRel') return base;
      const card = String(e.actualCardinality || e.cardinality || '');
      return card ? (base ? base + ' ' + card : card) : base;
    };
    const labelLimit = S.layer === 'instance' ? 20 : 14;

    const placeLabel = (e, force) => {
      const g = edgeGeometry(e, byId); if (!g) return;
      const text = labelText(e);
      if (!text) return;
      const shown = text.length > labelLimit ? text.slice(0, labelLimit - 1) + '…' : text;
      for (const [t, n] of SPOTS) {
        const p = spotOf(g, t, n);
        const box = boxOf(p.x, p.y - 3, shown);
        if (labelBoxes.some(b => hitBox(b, box))) continue;
        if (nodeBoxes.some(b => hitBox(b, box))) continue;
        labelBoxes.push(box);
        labelOk.set(e.id, { text: shown, x: p.x, y: p.y - 3 });
        return;
      }
      /* 11 个固定位都不行时，沿弧线扫更细的位置，按「挤占面积」挑一处最空的：
         压节点代价远高于标签互压（盖住对象名比两个名字挨着更难读）。
         以前取的是第一个不压节点的位置，经常正好落在两条边的标签中间，
         读出来像「按入库批次领用消耗:1:1算 6:1」两串字糊在一起。 */
      const overlapArea = (a, b) => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x))
        * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
      let best = null;
      for (const n of [0, -14, 14, -30, 30, -48, 48, -66, 66]) {
        for (let t = 0.2; t <= 0.81; t += 0.1) {
          const p = spotOf(g, t, n);
          const box = boxOf(p.x, p.y - 3, shown);
          const nodeCost = nodeBoxes.reduce((sum, b) => sum + overlapArea(b, box), 0);
          const labelCost = labelBoxes.reduce((sum, b) => sum + overlapArea(b, box), 0);
          const cost = nodeCost * 40 + labelCost;
          if (!best || cost < best.cost) best = { cost, box, x: p.x, y: p.y, nodeCost };
        }
      }
      if (best && best.nodeCost === 0) {
        labelOk.set(e.id, { text: shown, x: best.x, y: best.y - 3, tight: best.cost > 0 });
        labelBoxes.push(best.box);
        return;
      }
      labelOk.set(e.id, force ? { text: shown, x: g.lx, y: g.ly - 3, tight: true } : null);
      if (force) labelBoxes.push(boxOf(g.lx, g.ly - 3, shown));
    };
    /* 选中的边先挑位置，剩下的按原顺序摆 */
    edges.filter(e => selId === e.id).forEach(e => placeLabel(e, true));
    edges.filter(e => selId !== e.id).forEach(e => placeLabel(e, false));

    const edgeHtml = edges.map(e => {
      const g = edgeGeometry(e, byId); if (!g) return '';
      const cls = 'edge ' + (e.kind === 'parent' ? 'parent' : e.kind === 'instanceRel' ? 'instance' : '') + stateCls(e) + (selId === e.id ? ' active' : '');
      const dim = search && !(hits.has(e.source) || hits.has(e.target));
      const label = labelText(e);
      /* 悬停能看到业务含义：图上只放得下关系名，一句话的含义放在 title 里 */
      const tip = [label, e.meaning].filter(Boolean).join(' — ');
      /* 搜索只压暗不消失：以前搜索框里留着字，边全降到 18%、标签整片不画，
         看上去就像「关系没了、整张图灰蒙蒙」。 */
      const shown = labelOk.get(e.id);
      return `<path class="${cls}" d="${g.path}" opacity="${dim ? .32 : 1}"></path>` +
        `<path class="edge-hit" data-edge-id="${esc(e.id)}" d="${g.path}">${tip ? `<title>${esc(tip)}</title>` : ''}</path>` +
        ((!S.showLabels && selId !== e.id) || !shown ? ''
          : `<text class="edge-label${shown.tight ? ' tight' : ''}${dim ? ' dim' : ''}${selId === e.id ? ' active' : ''}${e.status === 'candidate' ? ' pending' : ''}" x="${shown.x.toFixed(1)}" y="${shown.y.toFixed(1)}" text-anchor="middle">${esc(shown.text)}</text>`);
    }).join('');

    const fill = { class: '#dbeafe', instance: '#dcfce7' };
    const stroke = { class: '#3b82f6', instance: '#16a34a' };
    const nodeHtml = nodes.map(n => {
      const active = selId === n.id;
      const dim = search && !hits.has(n.id);
      const label = String(n.label || '');
      const shown = label.length > 12 ? label.slice(0, 11) + '…' : label;
      const sub = String(n.sub || '').slice(0, 26);
      /* 单据上的关键信息（供应商 / 物料 / 金额）单独一行，节点加高，不用点开详情才看得到 */
      const summaryFull = String(n.summary || '');
      const summary = summaryFull.length > Math.floor(n.w / 5.6) ? summaryFull.slice(0, Math.floor(n.w / 5.6) - 1) + '…' : summaryFull;
      /* 连不上任何上下游的实例用虚线灰框标出来，一眼能看出哪些单据是孤岛 */
      const ghost = !!n.orphan;
      const tip = [label, n.sub, summaryFull, n.table ? '表：' + n.table : ''].filter(Boolean).join(' · ');
      const textLines = summary
        ? `<text y="-13">${esc(shown)}</text><text class="node-sub" y="3">${esc(sub)}</text><text class="node-sub node-fields" y="18">${esc(summary)}</text>`
        : `<text y="-4">${esc(shown)}</text><text class="node-sub" y="12">${esc(sub)}</text>`;
      return `<g class="node${active ? ' active' : ''}${dim ? ' dim' : ''}${ghost ? ' orphan' : ''}" data-node-id="${esc(n.id)}" transform="translate(${n.x.toFixed(1)},${n.y.toFixed(1)})">` +
        `<rect x="${-n.w / 2}" y="${-n.h / 2}" width="${n.w}" height="${n.h}" rx="6" fill="${ghost ? '#f8fafc' : (fill[n.kind] || '#eef2ff')}" stroke="${active ? '#1d4ed8' : (ghost ? '#94a3b8' : (stroke[n.kind] || '#94a3b8'))}"${ghost ? ' stroke-dasharray="4 3"' : ''}></rect>` +
        `<rect class="node-hit" x="${-n.w / 2}" y="${-n.h / 2}" width="${n.w}" height="${n.h}" rx="6"><title>${esc(tip)}</title></rect>` +
        `${textLines}</g>`;
    }).join('');
    $('edge-layer').innerHTML = edgeHtml;
    $('node-layer').innerHTML = nodeHtml;
    renderRelStrip(edges, nodes, selId);
    if (S.graph.mode === 'draft') {
      const pending = edges.filter(e => e.status === 'candidate').length;
      $('graph-stats').textContent = `草稿图谱 · ${nodes.length} 个业务对象 / ${edges.length} 条业务关系`
        + (pending ? ` · ${pending} 条待确认` : (edges.length ? ' · 全部已命名' : ' · 还没连上的关系在台账里看'));
    } else if (S.graph.mode === 'instance' || S.graph.mode === 'sample') {
      const total = S.summary?.instanceData?.stats?.individuals;
      const src = S.graph.mode === 'instance' ? '真实单据' : 'OWL 自带个体';
      const rel = S.summary?.instanceData?.relations?.stats;
      const holders = nodes.filter(n => (n.fanin || 0) > 1).length;
      $('graph-stats').textContent = `${src} · ${nodes.length} 个实例 / ${edges.length} 条关联`
        + (rel ? ` · 关系落地 ${rel.resolved}/${rel.total}` : '')
        + (holders ? ` · ${holders} 张主单下有多条明细` : '')
        + (S.graph.mode === 'instance' && total && total > nodes.length ? `（共 ${total} 个，图上最多 ${S.graph.limit} 个）` : '')
        + (S.graph.truncated ? ' · 已截断' : '');
    } else {
      const ok = edges.filter(e => e.status === 'confirmed').length;
      const pend = edges.filter(e => e.status === 'candidate' || e.status === 'dangling').length;
      $('graph-stats').textContent = `${nodes.length} 个对象 / ${edges.length} 条关系`
        + (ok ? ` · ${ok} 条已确认` : '') + (pend ? ` · ${pend} 条待定` : '');
    }
    const badge = $('selection-badge');
    if (S.selection && S.selection.kind !== 'addRel') {
      const item = S.selection.kind === 'node' ? nodes.find(x => x.id === S.selection.id) : edges.find(x => x.id === S.selection.id);
      badge.hidden = false;
      badge.textContent = (S.selection.kind === 'node' ? '已选中节点：' : '已选中关系：') + (item ? item.label : S.selection.id);
    } else badge.hidden = true;
  }

  /** 适配画布：按节点真实包围盒（含宽高）算，别按中心点算，否则边上的节点会被裁掉 */
  function fitView() {
    const nodes = S.graph.nodes;
    if (!nodes.length) return;
    const { W, H } = canvasSize();
    const left = Math.min(...nodes.map(n => n.x - n.w / 2));
    const right = Math.max(...nodes.map(n => n.x + n.w / 2));
    const top = Math.min(...nodes.map(n => n.y - n.h / 2));
    const bottom = Math.max(...nodes.map(n => n.y + n.h / 2));
    const padX = 46, padY = 40;
    /* 底部有「关系清单」时，可视区高度要减掉它，否则最下面一排节点被清单压住 */
    const strip = $('graph-relstrip');
    const stripH = strip && !strip.hidden ? (strip.offsetHeight || 0) : 0;
    const minX = left - padX, maxX = right + padX;
    const minY = top - padY, maxY = bottom + padY;
    /* 上限 1.15：节点少时别把图放到文字发虚；下限 0.2：多了就整体缩小，保证看得全 */
    const k = Math.min(1.15, Math.max(0.2, Math.min(W / (maxX - minX), (H - stripH) / (maxY - minY))));
    S.view.k = k;
    S.view.tx = W / 2 - ((minX + maxX) / 2) * k;
    S.view.ty = (H - stripH) / 2 - ((minY + maxY) / 2) * k;
    renderGraph();
  }
  function zoomAt(factor, px, py) {
    const { W, H } = canvasSize();
    px = px ?? W / 2; py = py ?? H / 2;
    const nk = Math.min(3.2, Math.max(0.1, S.view.k * factor));
    S.view.tx = px - (px - S.view.tx) * (nk / S.view.k);
    S.view.ty = py - (py - S.view.ty) * (nk / S.view.k);
    S.view.k = nk;
    renderGraph();
  }

  /* ---------------- 图谱交互：点击 / 拖拽 / 缩放 ---------------- */

  function screenPoint(e) {
    const r = $('graph-svg').getBoundingClientRect();
    return { px: e.clientX - r.left, py: e.clientY - r.top };
  }
  function graphPoint(e) {
    const { px, py } = screenPoint(e);
    return { x: (px - S.view.tx) / S.view.k, y: (py - S.view.ty) / S.view.k };
  }
  let drag = null;
  function bindGraphEvents() {
    const svg = $('graph-svg');
    svg.addEventListener('pointerdown', e => {
      const nodeEl = e.target.closest('.node');
      const edgeEl = e.target.closest('.edge, .edge-hit');
      const { px, py } = screenPoint(e);
      if (nodeEl) {
        const id = nodeEl.dataset.nodeId;
        const nd = S.graph.nodes.find(n => n.id === id);
        if (!nd) return;
        const g = graphPoint(e);
        drag = { type: 'node', id, sx: px, sy: py, ox: g.x - nd.x, oy: g.y - nd.y, moved: false };
      } else if (edgeEl) {
        drag = { type: 'edge', id: edgeEl.dataset.edgeId, sx: px, sy: py, moved: false };
      } else {
        drag = { type: 'pan', sx: px, sy: py, tx: S.view.tx, ty: S.view.ty, moved: false };
        svg.classList.add('panning');
      }
      try { svg.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
      e.preventDefault();
    });
    svg.addEventListener('pointermove', e => {
      if (!drag) return;
      const { px, py } = screenPoint(e);
      const dist = Math.hypot(px - drag.sx, py - drag.sy);
      if (dist > 3) drag.moved = true;
      if (drag.type === 'node' && drag.moved) {
        const g = graphPoint(e), nd = S.graph.nodes.find(n => n.id === drag.id);
        if (nd) { nd.x = g.x - drag.ox; nd.y = g.y - drag.oy; posMap()[nd.id] = { x: nd.x, y: nd.y, pinned: true }; requestRender(); }
      } else if (drag.type === 'pan' && drag.moved) {
        S.view.tx = drag.tx + (px - drag.sx); S.view.ty = drag.ty + (py - drag.sy); requestRender();
      }
    });
    svg.addEventListener('pointerup', e => {
      svg.classList.remove('panning');
      if (!drag) return;
      if (drag.type === 'node') { S.selection = { kind: 'node', id: drag.id }; switchTab('detail'); renderDetail(); }
      else if (drag.type === 'edge' && !drag.moved) { S.selection = { kind: 'edge', id: drag.id }; switchTab('detail'); renderDetail(); }
      drag = null;
      renderGraph();
    });
    svg.addEventListener('pointercancel', () => { drag = null; svg.classList.remove('panning'); });
    svg.addEventListener('wheel', e => {
      e.preventDefault();
      const { px, py } = screenPoint(e);
      zoomAt(e.deltaY < 0 ? 1.12 : 1 / 1.12, px, py);
    }, { passive: false });
  }

  /* ---------------- 详情编辑面板 ---------------- */

  function annotationsOf(entity) { return Array.isArray(entity?.annotations) ? entity.annotations : (entity.annotations = []); }
  function setAnnotation(entity, prop, value) {
    const list = annotationsOf(entity);
    let a = list.find(x => String(x.property).endsWith(prop));
    if (!a) { a = { id: (entity.iri || 'x') + '-' + prop, property: prop === 'label' ? 'rdfs:label' : 'rdfs:comment' }; list.push(a); }
    a.value = value; a.language = 'zh';
  }
  function getAnnotation(entity, prop) {
    return (entity?.annotations || []).find(x => String(x.property).endsWith(prop))?.value || '';
  }

  /* 草稿图谱的详情：业务对象只读看，业务关系可就地改名 / 反转 / 删除 */
  function renderDraftDetail() {
    const empty = $('detail-empty'), form = $('detail-form');
    const head = $('detail-head'), body = $('detail-body'), extra = $('detail-extra');
    if (S.selection.kind === 'addRel') return renderAddRelForm();
    const isNode = S.selection.kind === 'node';
    const item = isNode ? S.graph.nodes.find(n => n.id === S.selection.id) : S.graph.edges.find(e => e.id === S.selection.id);
    if (!item) { empty.hidden = false; form.hidden = true; return; }
    empty.hidden = true; form.hidden = false;
    const u = S.summary.understandingFinal || S.summary.understanding;
    const labelOf = t => (u?.tables || []).find(x => x.table === t)?.tableLabel || t;

    if (isNode) {
      const roleLabel = (S.summary.roles || []).find(r => r.id === item.role)?.label || '未指定';
      const related = S.graph.edges.filter(e => e.source === item.id || e.target === item.id);
      head.innerHTML = `<div class="dh-kind">草稿图谱 · 业务对象</div><div class="dh-title">${esc(item.label)}</div><div class="dh-iri">源表 ${esc(item.sub || '—')}</div>`;
      body.innerHTML =
        `<div class="form-row"><label>业务角色</label><input class="input readonly" value="${esc(roleLabel)}" readonly></div>` +
        `<div class="form-row"><label>业务含义</label><textarea class="textarea readonly" rows="3" readonly>${esc(item.meaning || '（未填写）')}</textarea></div>` +
        `<div class="form-row"><label>相连的业务关系（${related.length}）</label><div class="rel-mini">${related.map(e => {
          const other = e.source === item.id ? e.target : e.source;
          const name = S.graph.nodes.find(n => n.id === other)?.label || other;
          return `<button class="rel-chip${e.status === 'candidate' ? ' pending' : ''}" data-goto="${esc(e.id)}">${e.source === item.id ? '→' : '←'} ${esc(name)} · ${esc(e.label)}</button>`;
        }).join('') || '（这个对象还没有任何关系）'}</div></div>`;
      extra.innerHTML = `<div class="kv"><span>出边</span><b>${S.graph.edges.filter(e => e.source === item.id).length}</b></div>` +
        `<div class="kv"><span>入边</span><b>${S.graph.edges.filter(e => e.target === item.id).length}</b></div>`;
      $('btn-save-edit').disabled = true;
      $('btn-delete-edit').disabled = true;
      $('btn-add-rel-from').hidden = false;
      $('btn-add-rel-from').onclick = () => openAddRelForm(item.sub);
      body.querySelectorAll('[data-goto]').forEach(b => b.onclick = () => {
        S.selection = { kind: 'edge', id: b.dataset.goto }; renderDetail(); renderGraph();
      });
      return;
    }

    const rel = relList().find(x => x.id === item.relationId) || {};
    head.innerHTML = `<div class="dh-kind">草稿图谱 · 业务关系</div><div class="dh-title">${esc(item.label)}</div>` +
      `<div class="dh-iri">${esc(labelOf(rel.subject))} → ${esc(labelOf(rel.object))}</div>`;
    body.innerHTML =
      `<div class="form-row"><label>业务关系名（动作短语）</label><input class="input" id="ed-rel-name" value="${esc(rel.predicate === '待确认关系' ? '' : rel.predicate)}" placeholder="如：按订单收货 / 按发票结算 / 由供应商履约"></div>` +
      `<div class="form-row"><label>业务含义（这条边在业务上到底在做什么事）</label>` +
      `<textarea class="textarea" id="ed-rel-meaning" rows="3" placeholder="一句话写清动作、条件与约束，如：入库按采购订单的到货批次逐批验收，累计入库量不得超过订单未入库量">${esc(rel.meaning || '')}</textarea></div>` +
      (rel.vague ? `<div class="warning-box">这个关系名只有通用动词，读不出具体业务动作。建议改成「按订单收货」这类写法，或把动作写进业务含义。</div>` : '') +
      `<div class="form-row"><label>方向</label><div class="row-btns"><span class="muted">${esc(labelOf(rel.subject))} → ${esc(labelOf(rel.object))}</span><button class="btn btn-sm" id="ed-rel-reverse">反转方向</button></div></div>` +
      ((rel.via || []).length ? `<div class="form-row"><label>字段依据</label><div class="rel-src">${esc(prettyVia(rel.via))}</div></div>` : '') +
      `<div class="form-row"><label>材料依据</label><textarea class="textarea readonly" rows="2" readonly>${esc(rel.basis || '（无）')}</textarea></div>`;
    extra.innerHTML = `<div class="kv"><span>当前状态</span><b>${rel.status === 'candidate' ? '待命名 · 不进本体' : '已命名 · 确认后进本体'}</b></div>` +
      `<div class="kv"><span>业务含义</span><b>${rel.meaning ? '已写' : '未写'}</b></div>` +
      (rel.added ? `<div class="kv"><span>来源</span><b>人工补充</b></div>` : '');
    $('btn-save-edit').textContent = '保存这条关系';
    $('btn-delete-edit').textContent = '删除这条关系';
    $('btn-save-edit').onclick = () => {
      const name = $('ed-rel-name').value.trim();
      const meaning = $('ed-rel-meaning').value.trim();
      if (!name) { toast('请填写业务关系名；不改名这条关系不会进本体', 'error'); return; }
      relEdit(rel.id, { predicate: name, meaning, rejected: false });
      S.selection = null; refreshDraft();
      toast(meaning ? '已保存关系名与业务含义' : '已保存关系名；业务含义仍为空', 'ok');
    };
    $('btn-delete-edit').onclick = () => {
      relEdit(rel.id, { rejected: true });
      S.selection = null; refreshDraft(); toast('已标记删除，确认后不进本体', 'ok');
    };
    $('ed-rel-reverse').onclick = () => {
      relEdit(rel.id, { reversed: !rel.reversed });
      refreshDraft(); toast('已反转方向', 'ok');
    };
  }

  function openAddRelForm(fromTable) {
    S.selection = { kind: 'addRel', from: fromTable || '' };
    switchTab('detail'); renderDetail();
  }
  function renderAddRelForm() {
    const empty = $('detail-empty'), form = $('detail-form');
    const head = $('detail-head'), body = $('detail-body'), extra = $('detail-extra');
    const nodes = S.graph.nodes;
    if (!nodes.length) { empty.hidden = false; form.hidden = true; return; }
    empty.hidden = true; form.hidden = false;
    const opts = sel => nodes.map(n => `<option value="${esc(n.sub)}"${sel === n.sub ? ' selected' : ''}>${esc(n.label)}</option>`).join('');
    const from = S.selection.from || nodes[0].sub;
    head.innerHTML = `<div class="dh-kind">草稿图谱 · 新增业务关系</div><div class="dh-title">补一条业务上真实存在的关系</div><div class="dh-iri">只补边，不改表结构</div>`;
    body.innerHTML =
      `<div class="form-row"><label>源业务对象</label><select class="input" id="na-from">${opts(from)}</select></div>` +
      `<div class="form-row"><label>业务关系名（动作短语）</label><input class="input" id="na-name" placeholder="如：按订单收货 / 按发票结算 / 由供应商履约"></div>` +
      `<div class="form-row"><label>目标业务对象</label><select class="input" id="na-to">${opts(nodes.find(n => n.sub !== from)?.sub || '')}</select></div>` +
      `<div class="form-row"><label>业务含义（选填，但建议写）</label><textarea class="textarea" id="na-meaning" rows="2" placeholder="一句话写清这条边在业务上做了什么，如：入库按订单到货批次逐批验收"></textarea></div>`;
    extra.innerHTML = '<div class="kv"><span>说明</span><b>人工补充的边在确认后直接进本体</b></div>';
    $('btn-save-edit').textContent = '添加到图谱';
    $('btn-save-edit').disabled = false;
    $('btn-delete-edit').disabled = true;
    $('btn-save-edit').onclick = () => {
      const f = $('na-from').value, t = $('na-to').value;
      const name = $('na-name').value.trim();
      const meaning = $('na-meaning').value.trim();
      if (!name) { toast('请填写业务关系名', 'error'); return; }
      if (!f || !t || f === t) { toast('源对象与目标对象不能相同', 'error'); return; }
      S.relAdds.push({
        id: 'add' + (S.relAdds.length + 1) + '_' + Date.now().toString(36).slice(-4),
        subject: f, object: t, predicate: name, meaning, via: [], basis: '人工在图谱上补充', origin: 'human'
      });
      S.selection = null; refreshDraft(); toast('已补充关系：' + name, 'ok');
    };
  }

  /* 第 5 步：点实体看详情时，标出它涉及哪些审查规则（规则清单按 scope 里的表匹配） */
  const SEV_LABEL = { high: '高', medium: '中', low: '低' };
  function rulesForTables(tables) {
    const rs = S.summary?.ruleSpecs?.rules || [];
    const want = new Set((tables || []).filter(Boolean));
    if (!want.size) return null;
    return rs.filter(r => (r.scope || []).some(sc => want.has(sc.table)));
  }
  function ruleBlockHtml(tables) {
    const list = rulesForTables(tables);
    if (list === null) return '';
    if (!S.summary?.ruleSpecs) return '<div class="rule-block"><div class="rb-title">关联审查规则</div><div class="empty-hint">尚未设立规则（第 4 步）</div></div>';
    if (!list.length) return '<div class="rule-block"><div class="rb-title">关联审查规则</div><div class="empty-hint">这份规则清单里没有引用该业务对象的规则</div></div>';
    return '<div class="rule-block"><div class="rb-title">关联审查规则 · ' + list.length + ' 条</div>' + list.map(r =>
      `<div class="rule-item"><div class="ri-head"><span class="tag ${r.severity === 'high' ? 'missing' : r.severity === 'medium' ? 'suspected' : ''}">${esc(SEV_LABEL[r.severity] || r.severity || '—')}风险</span><b>${esc(r.name || '未命名规则')}</b></div>`
      + (r.intent ? `<div class="ri-body">${esc(r.intent)}</div>` : '')
      + (r.basis ? `<div class="ri-src">依据：${esc(r.basis)}</div>` : '') + '</div>').join('') + '</div>';
  }

  function renderDetail() {
    const empty = $('detail-empty'), form = $('detail-form');
    $('btn-save-edit').disabled = false;
    $('btn-delete-edit').disabled = false;
    $('btn-save-edit').hidden = false;
    $('btn-delete-edit').hidden = false;
    $('btn-save-edit').textContent = '应用修改';
    $('btn-delete-edit').textContent = '删除该对象';
    $('btn-add-rel-from').hidden = true;
    if (S.graph.mode === 'draft' && S.selection) { renderDraftDetail(); return; }
    if (!S.selection || !S.owlJson) { empty.hidden = false; form.hidden = true; return; }
    const nodes = S.graph.nodes, edges = S.graph.edges;
    const isNode = S.selection.kind === 'node';
    const item = isNode ? nodes.find(n => n.id === S.selection.id) : edges.find(e => e.id === S.selection.id);
    if (!item) { empty.hidden = false; form.hidden = true; return; }
    empty.hidden = true; form.hidden = false;
    const head = $('detail-head'), body = $('detail-body'), extra = $('detail-extra');
    const owl = S.owlJson;

    if (isNode && item.kind === 'class') {
      const c = owl.classes.find(x => x.iri === item.id);
      if (!c) { empty.hidden = false; form.hidden = true; return; }
      const opts = ['<option value="">（无父类）</option>'].concat(owl.classes.filter(x => x.iri !== c.iri).map(x =>
        `<option value="${esc(x.iri)}"${(c.superClassExpressions?.[0]?.classIRI === x.iri) ? ' selected' : ''}>${esc(x.localName)}</option>`)).join('');
      head.innerHTML = `<div class="dh-kind">本体层 · 类 / 业务对象</div><div class="dh-title">${esc(c.localName)}</div><div class="dh-iri">${esc(c.iri)}</div>`;
      body.innerHTML =
        `<div class="form-row"><label>业务对象名称（rdfs:label）</label><input class="input" id="ed-label" value="${esc(c.localName)}"></div>` +
        `<div class="form-row"><label>业务定义（rdfs:comment）</label><textarea class="textarea" id="ed-desc" rows="3">${esc(getAnnotation(c, 'comment') || c.description || '')}</textarea></div>` +
        `<div class="form-row"><label>父类（SubClassOf）</label><select class="input" id="ed-parent">${opts}</select></div>` +
        `<div class="form-row"><label>IRI（只读）</label><input class="input readonly" value="${esc(c.iri)}" readonly></div>`;
      const fields = owl.dataProperties.filter(p => (p.domains || []).includes(c.iri));
      const rels = owl.objectProperties.filter(p => (p.domains || []).includes(c.iri) || (p.ranges || []).includes(c.iri));
      extra.innerHTML = `<div class="kv"><span>数据属性</span><b>${fields.length}</b></div>` +
        `<div class="kv"><span>相关关系</span><b>${rels.length ? rels.map(p => esc(p.localName)).join('、') : '—'}</b></div>` +
        `<div class="kv"><span>字段示例</span><b>${esc(fields.slice(0, 3).map(p => p.localName).join('、') || '—')}</b></div>` +
        ruleBlockHtml([c.sourceTable || c.id]);
      $('btn-save-edit').onclick = () => {
        c.localName = $('ed-label').value.trim() || c.localName;
        setAnnotation(c, 'label', c.localName);
        setAnnotation(c, 'comment', $('ed-desc').value.trim());
        const p = $('ed-parent').value;
        c.superClassExpressions = p ? [{ id: c.id + '-sup', type: 'namedClass', classIRI: p }] : [];
        commitEdit('编辑类 ' + c.localName);
      };
      $('btn-delete-edit').onclick = () => {
        if (!confirm(`确认删除类「${c.localName}」？\n关联到它的关系会保留，校验会提示悬空引用，可在「OWL 与校验」中查看。`)) return;
        owl.classes = owl.classes.filter(x => x.iri !== c.iri);
        S.selection = null; commitEdit('删除类 ' + c.localName);
      };
      return;
    }

    if (!isNode && item.kind === 'objectProperty') {
      const p = owl.objectProperties.find(x => x.iri === item.iri);
      if (!p) { empty.hidden = false; form.hidden = true; return; }
      const select = (id, cur) => ['<option value="">（未指定）</option>'].concat(owl.classes.map(x =>
        `<option value="${esc(x.iri)}"${cur === x.iri ? ' selected' : ''}>${esc(x.localName)}</option>`)).join('');
      head.innerHTML = `<div class="dh-kind">本体层 · 对象属性 / 关系</div><div class="dh-title">${esc(p.localName)}</div><div class="dh-iri">${esc(p.iri)}</div>`;
      body.innerHTML =
        `<div class="form-row"><label>关系名称（rdfs:label）</label><input class="input" id="ed-label" value="${esc(p.localName)}"></div>` +
        `<div class="form-row"><label>定义域 · 源类（domain）</label><select class="input" id="ed-domain">${select('d', p.domains?.[0])}</select></div>` +
        `<div class="form-row"><label>值域 · 目标类（range）</label><select class="input" id="ed-range">${select('r', p.ranges?.[0])}</select></div>` +
        `<div class="form-row"><label>关系说明</label><textarea class="textarea" id="ed-desc" rows="3">${esc(getAnnotation(p, 'comment'))}</textarea></div>`;
      const domClass = owl.classes.find(x => x.iri === p.domains?.[0]);
      const ranClass = owl.classes.find(x => x.iri === p.ranges?.[0]);
      extra.innerHTML = `<div class="kv"><span>端点可解析</span><b>${item.valid ? '是' : '否（存在悬空引用）'}</b></div>` +
        `<div class="kv"><span>确认状态</span><b>${edgeStatusText(item.status)}</b></div>` +
        `<div class="kv"><span>基数</span><b>${item.cardinality ? esc(item.cardinality) : '未声明'}${item.cardinality && domClass && ranClass ? ' · ' + esc(readCardinality(item.cardinality, domClass.localName, ranClass.localName)) : ''}</b></div>` +
        `<div class="kv"><span>属性特征</span><b>${esc((p.characteristics || []).join('、') || '—')}</b></div>` +
        `<div class="kv"><span>关系说明</span><b>${esc(getAnnotation(p, 'comment') || '（未填）')}</b></div>` +
        ruleBlockHtml([domClass?.sourceTable || domClass?.id, ranClass?.sourceTable || ranClass?.id]);
      $('btn-save-edit').onclick = () => {
        p.localName = $('ed-label').value.trim() || p.localName;
        setAnnotation(p, 'label', p.localName);
        setAnnotation(p, 'comment', $('ed-desc').value.trim());
        const d = $('ed-domain').value, r = $('ed-range').value;
        p.domains = d ? [d] : []; p.ranges = r ? [r] : [];
        commitEdit('编辑关系 ' + p.localName);
      };
      $('btn-delete-edit').onclick = () => {
        if (!confirm(`确认删除关系「${p.localName}」？`)) return;
        owl.objectProperties = owl.objectProperties.filter(x => x.iri !== p.iri);
        S.selection = null; commitEdit('删除关系 ' + p.localName);
      };
      return;
    }

    if (!isNode && item.kind === 'parent') {
      const child = owl.classes.find(x => x.iri === item.ownerIri);
      head.innerHTML = `<div class="dh-kind">本体层 · 类层级</div><div class="dh-title">继承关系</div><div class="dh-iri">${esc(item.source)} → ${esc(item.target)}</div>`;
      body.innerHTML = `<div class="form-row"><label>子类</label><input class="input readonly" value="${esc(child?.localName || short(item.source))}" readonly></div>` +
        `<div class="form-row"><label>父类</label><input class="input readonly" value="${esc(short(item.target))}" readonly></div>`;
      $('btn-save-edit').onclick = () => { switchTab('detail'); S.selection = { kind: 'node', id: item.source }; renderDetail(); renderGraph(); };
      $('btn-save-edit').textContent = '编辑子类';
      $('btn-delete-edit').onclick = () => {
        if (child) child.superClassExpressions = (child.superClassExpressions || []).filter((_, i) => i !== item.index);
        S.selection = null; commitEdit('删除类层级');
      };
      return;
    }

    // 实例之间的连边：只读，说明这条单据引用了哪条单据、靠哪两列连的、几对几
    if (!isNode && item.kind === 'instanceRel') {
      const from = nodes.find(n => n.id === item.source), to = nodes.find(n => n.id === item.target);
      const card = item.cardinality || '';
      const cardText = item.cardinalityText || '';
      head.innerHTML = `<div class="dh-kind">实例层 · 单据关联（只读）</div><div class="dh-title">${esc(item.label)}</div>` +
        `<div class="dh-iri">${esc(item.source)} → ${esc(item.target)}</div>`;
      body.innerHTML = `<div class="form-row"><label>来源单据</label><input class="input readonly" value="${esc(from?.label || '')}（${esc(from?.sub || '')}）" readonly></div>` +
        `<div class="form-row"><label>目标单据</label><input class="input readonly" value="${esc(to?.label || '')}（${esc(to?.sub || '')}）" readonly></div>`;
      const mapCols = item.sourceColumnLabel && item.refColumnLabel
        ? `${esc(item.sourceColumnLabel)} → ${esc(item.refColumnLabel)}` : '未落地到字段';
      const actual = item.maxChildren ? `每份${to?.label || '目标单据'}这类单据，实测最多 ${item.maxChildren} 张${from?.label || '来源单据'}；这对单据共 ${item.pairs || 0} 对关联` : '';
      extra.innerHTML = `<div class="kv"><span>关系名</span><b>${esc(item.label)}</b></div>` +
        `<div class="kv"><span>关联字段</span><b>${mapCols}</b></div>` +
        `<div class="kv"><span>这条边</span><b>${esc(from?.label || '')} 这一张 → ${esc(to?.label || '')} 那一张（1:1）</b></div>` +
        `<div class="kv"><span>整体基数</span><b>${card ? `${esc(card)}${cardText ? '（' + esc(cardText) + '）' : ''}` : '—'}${actual ? ' · ' + esc(actual) : ''}</b></div>` +
        `<div class="kv"><span>基数怎么读</span><b>${card && from && to ? esc(readCardinality(card, from.sub.split(' · ')[0], to.sub.split(' · ')[0])) : '装载数据里没算出基数'}</b></div>` +
        `<div class="kv"><span>来源</span><b>按本体里已确认的对象属性生成</b></div>`;
      $('btn-save-edit').hidden = true;
      $('btn-delete-edit').hidden = true;
      return;
    }

    // 实例节点：只读（T-Box / A-Box 分离）
    const real = S.summary?.instanceData;
    const ind = real?.individuals?.find(x => x.iri === item.id) || owl.individuals?.find(x => x.iri === item.id);
    const isReal = !!(real && real.individuals?.some(x => x.iri === item.id));
    const cls = owl.classes.find(x => x.iri === (ind?.types || [])[0]);
    head.innerHTML = `<div class="dh-kind">实例层 · ${isReal ? '客户真实单据' : 'OWL 自带个体'}（只读）</div>` +
      `<div class="dh-title">${esc(item.label)}</div><div class="dh-iri">${esc(item.id)}</div>`;
    /* 字段名用业务名（数据属性 localName），别把内部列标识直接摊给业务用户看 */
    const dpName = new Map((owl.dataProperties || []).map(p => [p.iri, p.localName]));
    const asserts = (ind?.dataPropertyAssertions || []).slice(0, 14);
    const upDown = S.graph.edges.filter(e => e.source === item.id || e.target === item.id).length;
    body.innerHTML = `<div class="form-row"><label>所属类型</label><input class="input readonly" value="${esc(cls?.localName || item.sub)}" readonly></div>` +
      /* 来源表只在是客户自己的表名时显示；CSV 派生的内部编号（t1_c218d8）对业务用户没意义 */
      (isReal && !looksGenerated(cls?.sourceTable || item.table) ? `<div class="form-row"><label>来源表</label><input class="input readonly" value="${esc(cls?.sourceTable || item.table || '')}" readonly></div>` : '') +
      `<div class="form-row"><label>字段值</label><textarea class="textarea mono readonly" rows="7" readonly>${esc(asserts.map(a => (dpName.get(a.propertyIRI) || short(a.propertyIRI)) + ' = ' + a.value).join('\n') || '（无数据属性断言）')}</textarea></div>`;
    extra.innerHTML = `<div class="kv"><span>数据属性断言</span><b>${ind?.dataPropertyAssertions?.length || 0}</b></div>` +
      `<div class="kv"><span>对象属性断言</span><b>${ind?.objectPropertyAssertions?.length || 0}</b></div>` +
      (isReal ? `<div class="kv"><span>在图上的连边</span><b>${upDown ? upDown + ' 条' : '没有（孤立单据）'}</b></div>` : '');
    $('btn-save-edit').hidden = true;
    $('btn-delete-edit').hidden = true;
  }

  function addClass() {
    if (isDraftGraph()) { toast('草稿图谱里的业务对象来自你上传的表；这一步只调整业务关系', 'error'); return; }
    if (!S.owlJson) { toast('请先生成 OWL 或直接导入一个 OWL 文件', 'error'); return; }
    const owl = S.owlJson;
    const ns = owl.iri.endsWith('#') ? owl.iri : owl.iri + '#';
    const n = owl.classes.filter(c => String(c.id).startsWith('new_class')).length + 1;
    const id = 'new_class_' + Date.now().toString(36);
    const iri = ns + id;
    owl.classes.push({ id, iri, localName: '新建业务对象 ' + n, annotations: [], superClassExpressions: [], equivalentClassExpressions: [], disjointWith: [] });
    S.selection = { kind: 'node', id: iri };
    switchTab('detail');
    commitEdit('新增类').then(() => { S.selection = { kind: 'node', id: iri }; renderDetail(); renderGraph(); });
  }
  function addRelation() {
    if (isDraftGraph()) {
      if (!S.graph.nodes.length) { toast('草稿图谱还没有业务对象，请先生成理解稿', 'error'); return; }
      openAddRelForm(S.selection?.kind === 'node' ? (S.graph.nodes.find(n => n.id === S.selection.id)?.sub || '') : '');
      return;
    }
    if (!S.owlJson) { toast('请先生成 OWL 或直接导入一个 OWL 文件', 'error'); return; }
    const owl = S.owlJson;
    if (owl.classes.length < 2) { toast('至少需要两个类才能建立关系', 'error'); return; }
    const ns = owl.iri.endsWith('#') ? owl.iri : owl.iri + '#';
    const id = 'new_rel_' + Date.now().toString(36), iri = ns + id;
    const from = owl.classes[0].iri, to = owl.classes[1].iri;
    owl.objectProperties.push({ id, iri, localName: '新建业务关系', annotations: [], domains: [from], ranges: [to], characteristics: [], inverseOf: null });
    S.selection = { kind: 'edge', id: 'rel:' + iri };
    switchTab('detail');
    commitEdit('新增关系').then(() => { S.selection = { kind: 'edge', id: 'rel:' + iri }; renderDetail(); renderGraph(); });
  }

  /* ---------------- 配置 / 帮助 ---------------- */

  async function loadConfigStatus() {
    try {
      const c = await api('/api/model-config');
      $('cfg-base').value = c.baseUrl || ''; $('cfg-model').value = c.model || '';
      $('cfg-maxtokens').value = c.maxTokens || 8192;
      $('cfg-provider').value = c.provider; $('cfg-custom').checked = !!c.allowCustomEndpoint;
      $('config-status').textContent = c.configured
        ? `已配置密钥 · ${c.provider} · ${c.model} · ${c.baseUrl} · 输出上限 ${c.maxTokens || 8192} tokens`
        : '尚未配置密钥。可直接使用「确定性草案」，或填入密钥后调用模型。';
    } catch (e) { $('config-status').textContent = e.message; }
  }
  async function saveConfig(clearKey) {
    try {
      const c = await api('/api/model-config', {
        method: 'POST', body: JSON.stringify({
          provider: $('cfg-provider').value, baseUrl: $('cfg-base').value.trim(),
          model: $('cfg-model').value.trim(), apiKey: $('cfg-key').value.trim(),
          maxTokens: Number($('cfg-maxtokens').value) || 8192,
          allowCustomEndpoint: $('cfg-custom').checked, clearKey: !!clearKey
        })
      });
      $('cfg-key').value = '';
      $('config-status').textContent = c.configured
        ? `已保存 · ${c.provider} · ${c.model} · 密钥已写入本机配置（不回传前端）`
        : '已保存 · 当前未配置可用模型，可使用手工建模';
      toast('模型配置已保存', 'ok');
    } catch (e) { $('config-status').textContent = e.message; toast(e.message, 'error'); }
  }

  const HELP = `
    <h4>这个工作台在做什么</h4>
    <p>上传你自己业务链路相关的<strong>表结构</strong>，系统先还原「这批表在讲什么业务、链路分几个阶段、靠哪些字段串起来、还缺什么」，由你对整张理解稿做一次确认；确认后的业务语义回写规范模型，再由确定性代码编译成 OWL/XML 与 Turtle，最后生成页面里可点击、可拖拽、可编辑的<strong>活图谱</strong>。</p>
    <h4>主链路六步</h4>
    <ul>
      <li><b>1 上传材料</b>：Excel 工作簿（多 sheet / 隐藏表 / 多层表头）、JSON 字段字典、SQL DDL、CSV/TSV、业务描述。<strong>多张表可以拆成多个文件一次传</strong>，系统全部合并成一个规范模型；同一张表被两份材料声明过且字段不一致时才报冲突。系统只按形态解析，不认识任何业务表名。</li>
      <li><b>2 业务理解稿</b>：模型出稿，或用「手工建模」逐表填写业务含义、角色、链路阶段——手工建模是一等公民路径，不是降级兜底。无模型时不生成伪理解稿。</li>
      <li><b>3 图谱确认</b>：理解稿一出稿，画布上同时出现<strong>草稿图谱</strong>——节点是业务对象，边是候选关系。点边可以就地改名、反转方向、删除，也可以在画布上补一条人工关系。这里每一层要填两样东西：<b>关系名</b>写成能读出业务动作的短语（<em>按订单收货 / 按发票结算 / 由供应商履约</em>），别停在「属于 / 包含 / 关联 / 依据」这种泛词；<b>业务含义</b>写一句话说清这条边在做什么事、约束了什么。字段对应写在「字段依据」里，不占关系名。含义会跟着关系一起进本体的 <code>rdfs:comment</code> 与 <code>omw:businessMeaning</code>。</li>
      <li><b>4 生成 OWL</b>：点「确认并生成 OWL」即一次确认：有业务名的关系进本体，仍叫「待确认关系」的不进——宁可少写，也不把技术噪音塞进本体。随后由确定性代码编译 OWL/XML、Turtle、SHACL、N-Triples 并做 12 项校验。</li>
      <li><b>5 规则设立</b>：粘贴或上载客户的制度条款，模型结合图谱里的对象、关系与字段，把条款解析成可判定的审查规则，再由代码编译成 SQL（标准 SQL / MySQL / PostgreSQL）。<strong>本平台只产规则，不执行规则</strong>，SQL 交给客户侧规则引擎跑；条件成立即命中，命中结果是待核查线索，不是违规认定。</li>
      <li><b>6 实例图谱</b>：<strong>不需要再传一遍数据</strong>——第 1 步上传的表格里带的行，编译完 OWL 就直接变成实例、按已确认关系连成单据流。要换成更完整的单据时，再到「实例数据」里补传（CSV / xlsx，文件名或 sheet 名与表名一致），会覆盖这批实例。系统对实例做四类完整性检查：主键唯一、外键不悬空、外键不为空、一对多衔接不断（父单无子行、声明 1:1 实际 1:N）。<strong>不完整只标出来，不替你改数据</strong>——问题标红，实例照样出图；实例层单独导出 ABox，不重复类与属性定义。</li>
    </ul>
    <h4>关系怎么落到真实字段上</h4>
    <p>理解稿里确认的关系只说「订单 按合同下达 合同」，没说用哪一列连。装载时按三层落地：<b>先看理解稿/表结构里写过的字段对</b>（拿真实取值复核），<b>再看列名像不像 + 取值重合度</b>（金额、名称这种凑巧重合的不认），<b>都不行就明写「没落地」</b>——宁可不画这条边，也不画假边。落地结果、靠哪两列连、覆盖多少，都在「实例数据 · 关系落地」里逐条列出来。</p>
    <p>连上之后按真实数据算基数：每份目标单据被多少条来源单据引用，得出 N:1 / 1:N / 1:1 / N:M，写在边的名字后面；被多条明细指过来的主单（比如一份合同下三张订单）连出的边会明显多几条。这样一对多不用去翻明细，图上直接看得出来。关系没落地时完整性检查会点名，不会出现「一项没查却显示全部通过」的假绿。</p>
    <h4>活图谱</h4>
    <p>画布上有两个 tab：<b>逻辑图谱</b>（类与关系，可编辑）与<b>实例图谱</b>（真实单据，只读）。逻辑图谱里点节点/关系看详情、拖节点改位置、改名称与父类与关系端点、增删类与关系，每次改动都会重新编译 OWL；实例图谱只认第 6 步装载出来的真实数据，没装载时会告诉你下一步做什么，不会拿类图冒充。连不上任何上下游的实例用虚线框标出来。</p>
    <p>线的样子就是关系的状态：<b>已确认</b>是蓝色实线，<b>候选</b>是橙色虚线，<b>端点悬空</b>是灰色细虚线。边名后面带基数：装载过实例数据时写<b>实测值</b>（4:1＝每份合同最多 4 张订单），没装载时写语义值（N:1）。实例图上的边不贴类型级基数——那一条边就是「这张单引用那张单」，多寡看节点连出几条边；节点上另外带一行供应商 / 物料这类关键字段，不用点开详情也能认单。</p>
    <p>画布底部有一条<b>关系清单</b>，把图上每条关系写成一行「谁 — 什么关系 → 谁（基数）」。图上标签要避让、要截断，关系一多就只剩名字；这一条是文字版，点一行就等于选中那条边，右侧详情跟着打开，业务含义和字段依据都在那儿。</p>
    <h4>项目存在哪、怎么找回来</h4>
    <p>项目存在服务端的 <code>data/projects/</code> 下，关掉页面、重启服务都不会丢。顶栏「最近项目」列出磁盘上所有项目（按更新时间倒序），点一条就回到那个项目，图谱、理解稿、实例数据都跟着回来。</p>
    <h4>一次确认长什么样</h4>
    <p>对整张稿子做<strong>一次确认</strong>：理解稿里的局部批注（改业务含义 / 改角色 / 改阶段 / 补充阶段 / 登记缺口 / 标记存疑）与图谱确认里的关系批注（改名 / 反转 / 删除 / 新增）一起提交，系统一次性生成定稿版并列出「本次改了什么」，只保留 v1 与定稿版两个版本；如需重做可「重新开启理解稿」，上一版定稿快照会保留。没有在图上命名的边视为未确认，不写进本体。</p>
    <h4>画布操作</h4>
    <p>滚轮缩放；空白处拖动平移；拖动节点调整位置（位置在重新编译后保留）；点击节点或关系在右侧编辑；「重新布局」重算力导向；「适配画布」自动缩放；搜索框高亮匹配节点；「关系名」按钮可切换线上的文字显隐（关系密集时默认收起，选中某条关系时仍会显示它的名字）。逻辑图谱可编辑，实例图谱只读（真实单据属于 A-Box，与类、属性定义分通道管理）。</p>
    <h4>也可以跳过建模，直接从 OWL 出图</h4>
    <p>上传或粘贴 OWL/XML、Turtle、N-Triples、RDF/XML、元枢兼容的 OwlOntology JSON，页面会反向解析成图谱，之后一样可以编辑、回写、导出。</p>
    <h4>口径纪律与能力边界</h4>
    <ul>
      <li>不同材料说法不一致会进「口径漂移警告」，阻断级冲突未人工裁决前不允许编译，系统不会静默择一。</li>
      <li>系统不预置任何业务样例或示例规则；所有表结构、业务描述、审查条款都由你上传或填写。规则里的「金额和数量放在一起比」这类口径漂移会显式提示，不静默放过。</li>
      <li>规则 SQL 使用图谱里的真实列名，业务名只出现在注释里；规则不执行、不落库，导出后由客户侧规则引擎负责跑。</li>
      <li>关系名只有通用动词（属于/包含/关联/依据）时，列表会标「含义偏泛」、画布上仍可确认，但读的人看不出业务动作；没写业务含义的边会标「缺业务含义」，确认前会提醒一次。</li>
      <li>AI 负责语义理解与规则解析，人负责裁决，代码负责格式与校验。描述逻辑一致性推理（HermiT/Pellet）、平台侧 SHACL 执行、真实图数据库导入、规则执行引擎、多租户与权限审计尚未接入，需要对接目标平台后补齐。</li>
      <li>发布版未预置模型配置。你填写的密钥保存在本机 <code>data/model-config.json</code>，配置接口不回传密钥；调用 AI 时，密钥用于鉴权，相关材料会发送至所配置的服务商。上传图片也会调用模型识别，请先确认材料可以发送。自定义服务需显式开启，模型能力及费用由服务商决定。</li>
    </ul>`;

  /* ---------------- 事件绑定 ---------------- */

  function bind() {
    $('btn-pick').onclick = () => $('file-input').click();
    $('file-input').onchange = e => { addFiles(e.target.files); e.target.value = ''; };
    const dz = $('dropzone');
    ['dragenter', 'dragover'].forEach(t => dz.addEventListener(t, e => { e.preventDefault(); dz.classList.add('drag'); }));
    ['dragleave', 'drop'].forEach(t => dz.addEventListener(t, e => { e.preventDefault(); dz.classList.remove('drag'); }));
    dz.addEventListener('drop', e => addFiles(e.dataTransfer.files));
    $('btn-new').onclick = newProject;
    $('btn-recent').onclick = openRecent;
    $('btn-close-recent').onclick = () => { $('recent-modal').hidden = true; };
    $('btn-parse').onclick = parseMaterials;
    $('btn-compile').onclick = compile;
    $('btn-recompile').onclick = () => commitEdit('页面手动回写');
    $('btn-reparse-paste').onclick = () => {
      const t = $('owl-paste').value.trim();
      if (!t) { toast('请先粘贴 OWL 内容或选择文件', 'error'); return; }
      parseOwl(t, 'pasted-ontology.owl');
    };
    $('btn-pick-owl').onclick = () => $('owl-file-input').click();
    $('owl-file-input').onchange = async e => {
      const f = e.target.files[0]; if (!f) return;
      parseOwl(await f.text(), f.name); e.target.value = '';
    };
    $$('.export-btn').forEach(b => b.onclick = () => exportFile(b.dataset.format));
    TABS.forEach(t => $('tab-' + t).onclick = () => switchTab(t));
    $('btn-understanding-ai').onclick = () => postStep('understanding-generate', { mode: 'ai', by: $('project-name').value + ' · 业务用户' }, '模型已生成业务理解稿 v1，草稿图谱已同时画出', 'ledger');
    $('btn-understanding-manual').onclick = () => { $('manual-block').scrollIntoView({ behavior: 'smooth', block: 'center' }); toast('请在下表逐表填写业务含义、角色与链路阶段；也可点「用表原名预填」', 'ok'); };
    $('btn-understanding-prefill').onclick = () => {
      $$('#manual-tables .manual-row').forEach(row => {
        const m = row.querySelector('[data-mf="meaning"]');
        if (!m.value.trim()) m.value = row.querySelector('.mr-head')?.textContent.trim().split(' ')[0] || '';
      });
      toast('已用材料里的表原名预填业务含义，请逐条核对修改', 'ok');
    };
    $('btn-understanding-generate').onclick = () => postStep('understanding-generate',
      { mode: 'manual', manual: collectManual(), by: $('project-name').value + ' · 业务用户' },
      '手工建模已生成业务理解稿 v1，草稿图谱已同时画出', 'ledger');
    $('btn-understanding-annot').onclick = () => addAnnotationRow();
    /* 一次确认发生在「图谱确认」：理解稿的局部批注与关系批注一起提交，不产生中间版本 */
    $('btn-understanding-finalize').onclick = () => {
      const n = collectAnnotations().length;
      setStep(2); switchTab('ledger');
      toast(n ? `已带 ${n} 条局部批注，请在草稿图谱上确认业务关系后一次提交` : '请在草稿图谱上逐条确认业务关系，再点「确认并生成 OWL」', 'ok');
    };
    $('btn-understanding-reopen').onclick = () => postStep('understanding-reopen', {}, '已重新开启理解稿，上一版定稿快照已保留', 'understanding');
    /* 图谱确认：图上或列表里逐条命名 / 删除，然后一次确认直接出 OWL */
    $('btn-rel-all-name').onclick = () => {
      relList().forEach(x => {
        if (x.status !== 'rejected' && !x.named) relEdit(x.id, { predicate: '关联' });
      });
      refreshDraft();
      toast('待命名的边已全部填为「关联」，请逐条改成真实业务动词', 'ok');
    };
    $('btn-rel-all-drop').onclick = () => {
      relList().forEach(x => relEdit(x.id, { rejected: true }));
      S.selection = null; refreshDraft();
      toast('已全部标记为删除；确认后不进本体', 'ok');
    };
    $('btn-rel-submit').onclick = async () => {
      if (S.summary?.understandingFinal) { toast('理解稿已定稿，如需调整请先「重新开启理解稿」', 'error'); return; }
      if (!S.projectId) { toast('请先上传材料并生成理解稿', 'error'); return; }
      const annotations = [...collectAnnotations(), ...buildRelationAnnotations()];
      /* 一次确认只说一遍：把「没名字」和「没写含义」合成一条提示，别让人连点两个弹窗 */
      const all = relList().filter(x => x.status !== 'rejected');
      const pend = all.filter(x => x.status === 'candidate').length;
      const bare = all.filter(x => x.named && x.noMeaning).length;
      const lines = [];
      if (pend) lines.push(`· ${pend} 条关系还没有业务名，它们不会进本体`);
      if (bare) lines.push(`· ${bare} 条关系有名字但没写业务含义，本体里只有名字，读的人看不出这条边在做什么`);
      if (lines.length && !confirm(`${lines.join('\n')}\n\n继续确认并生成 OWL？（点「取消」回去补，点「确定」照样生成）`)) return;
      busy(true, '确认关系并编译 OWL…');
      try {
        await api(`/api/projects/${S.projectId}/understanding-finalize`, {
          method: 'POST', body: JSON.stringify({ annotations, approval: { confirmed: true }, by: $('project-name').value + ' · 业务用户' })
        });
        const res = await api(`/api/projects/${S.projectId}/compile`, { method: 'POST', body: JSON.stringify({}) });
        S.relEdits = {}; S.relAdds = []; S.selection = null;
        applySummary(res, { resetPositions: true, keepSelection: false });
        setStep(3); switchTab('owl');
        const st = S.summary?.relationStats || {};
        toast(`已确认并生成 OWL：${st.confirmed || 0} 条业务关系进本体，${st.rejected || 0} 条已删除`, 'ok');
      } catch (e) { toast(e.message, 'error'); }
      finally { busy(false); }
    };
    /* 规则设立：文档 + 图谱口径 → 规则 → SQL（本平台只产规则，不执行） */
    $('btn-rule-parse').onclick = async () => {
      if (!S.projectId) { toast('请先上传材料并完成图谱确认', 'error'); return; }
      if (!S.summary?.understandingFinal) { toast('请先在「图谱确认」里确认业务关系并生成 OWL', 'error'); return; }
      const document = $('rule-text').value.trim();
      if (!document) { toast('请粘贴审查条款，或上载一份文档', 'error'); return; }
      busy(true, '正在解析文档并生成业务审查规则…');
      try {
        const res = await api(`/api/projects/${S.projectId}/rule-specs`, {
          method: 'POST',
          body: JSON.stringify({ document, dialect: $('rule-dialect').value, by: $('project-name').value + ' · 业务用户' })
        });
        applySummary(res, { keepSelection: true });
        setStep(4); switchTab('rules');
        const n = res.ruleSpecs?.rules?.length || 0;
        toast(`已生成 ${n} 条业务审查规则与对应 SQL`, n ? 'ok' : 'error');
      } catch (e) { toast(e.message, 'error'); } finally { busy(false); }
    };
    $('btn-rule-pick').onclick = () => $('rule-file-input').click();
    $('rule-file-input').onchange = async e => {
      const f = e.target.files[0]; if (!f) return;
      const text = await f.text();
      $('rule-text').value = text;
      $('rule-file-name').textContent = `已载入：${f.name}（${text.length} 字）`;
      e.target.value = '';
      toast('文档已载入，点「解析文档并生成规则」继续', 'ok');
    };
    $('btn-rule-clear').onclick = () => { $('rule-text').value = ''; $('rule-file-name').textContent = ''; };
    $('rule-dialect').onchange = async () => {
      if (!S.summary?.ruleSpecs?.rules?.length) return;
      busy(true, '正在换方言重新编译 SQL…');
      try {
        const res = await api(`/api/projects/${S.projectId}/rule-specs-dialect`, {
          method: 'POST', body: JSON.stringify({ dialect: $('rule-dialect').value })
        });
        applySummary(res, { keepSelection: true });
        toast('SQL 已按 ' + $('rule-dialect').value.toUpperCase() + ' 方言重新编译', 'ok');
      } catch (e) { toast(e.message, 'error'); } finally { busy(false); }
    };
    $('btn-rule-export').onclick = () => {
      if (!S.summary?.ruleSpecs?.rules?.length) { toast('还没有可导出的规则', 'error'); return; }
      exportFile('rulesql');
    };
    $('btn-cancel-edit').onclick = () => { S.selection = null; renderDetail(); renderGraph(); };

    $('layer-schema').onclick = () => switchLayer('schema');
    $('layer-instance').onclick = () => switchLayer('instance');
    /* 实例装载：单独一套上传区，不动第 1 步的材料清单 */
    $('btn-inst-pick').onclick = () => $('inst-file-input').click();
    $('inst-file-input').onchange = e => { addInstFiles(e.target.files); e.target.value = ''; };
    const idz = $('inst-dropzone');
    ['dragenter', 'dragover'].forEach(t => idz.addEventListener(t, e => { e.preventDefault(); idz.classList.add('drag'); }));
    ['dragleave', 'drop'].forEach(t => idz.addEventListener(t, e => { e.preventDefault(); idz.classList.remove('drag'); }));
    idz.addEventListener('drop', e => addInstFiles(e.dataTransfer.files));
    $('btn-instance-load').onclick = loadInstance;
    $('btn-relayout').onclick = () => { layoutGraph(); fitView(); toast('已重新布局', 'ok'); };
    $('btn-fit').onclick = fitView;
    $('btn-toggle-labels').onclick = () => { S.showLabels = !S.showLabels; updateLabelButton(); renderGraph(); };
    $('zoom-in').onclick = () => zoomAt(1.2);
    $('zoom-out').onclick = () => zoomAt(1 / 1.2);
    $('graph-search').oninput = () => renderGraph();
    /* 搜索框里留着上次的字，会让整张图看起来「灰蒙蒙、关系全没了」——Esc 一键清掉 */
    $('graph-search').addEventListener('keydown', e => {
      if (e.key !== 'Escape') return;
      $('graph-search').value = ''; renderGraph(); $('graph-search').blur();
    });
    /* 关系清单点一行 = 选中那条边，右侧详情跟着走 */
    $('graph-relstrip').addEventListener('click', e => {
      const chip = e.target.closest('.rel-chip');
      if (!chip) return;
      S.selection = { kind: 'edge', id: chip.dataset.edgeId };
      renderGraph(); renderDetail(); switchTab('detail');
    });
    $('btn-add-class').onclick = addClass;
    $('btn-add-relation').onclick = addRelation;

    $('btn-config').onclick = () => { $('config-modal').hidden = false; loadConfigStatus(); };
    $('btn-close-config').onclick = () => { $('config-modal').hidden = true; };
    $('btn-save-config').onclick = () => saveConfig(false);
    $('btn-clear-key').onclick = () => saveConfig(true);
    $('btn-help').onclick = () => { $('help-body').innerHTML = HELP; $('help-modal').hidden = false; };
    $('btn-close-help').onclick = () => { $('help-modal').hidden = true; };
    $$('.modal').forEach(m => m.addEventListener('click', e => { if (e.target === m) m.hidden = true; }));
    document.addEventListener('keydown', e => { if (e.key === 'Escape') $$('.modal').forEach(m => m.hidden = true); });

    $$('.step').forEach(el => el.onclick = () => {
      const k = Number(el.dataset.step);
      if (k === 1) $('dropzone').scrollIntoView({ behavior: 'smooth', block: 'center' });
      else if (k === 2) switchTab('understanding');
      else if (k === 3) switchTab('ledger');
      else if (k === 4) switchTab('owl');
      else if (k === 5) switchTab('rules');
      else if (k === 6) { switchTab('instance'); switchLayer('instance'); }
    });

    window.addEventListener('resize', () => renderGraph());
    bindGraphEvents();
  }

  bind();
  loadConfigStatus();
  renderAll();
  renderGraph();
  setStep(1);
  api('/api/health').then(h => { status(`服务就绪 · ${h.service} v${h.version} · 端口 ${h.port}`); }).catch(() => status('服务连接异常'));
})();
