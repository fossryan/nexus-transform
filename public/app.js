'use strict';
/* Nexus Transform front end — no framework, no build step. */

const $ = (s, el = document) => el.querySelector(s);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const view = $('#view');

const EXAMPLES = [
  'Which large companies kept operating margins steady through the 2022–23 rate hikes? Compare 2021 vs 2023 margins, revenue over $1B',
  'Real revenue growth 2021→2024: adjust revenue for CPI inflation and rank the top 20 real growers with revenue over $1B',
  'Estimate 2023 interest income on cash: cash × that year\'s average fed funds rate, top 15 companies',
  'Median net margin and revenue growth by sector, 2024 vs 2023',
  'Quarterly revenue since 2023 for the 10 largest software companies',
  'How long was the 10-year/2-year Treasury yield curve inverted, and how deep did it get?',
];

const state = {
  status: null,
  actor: (() => { try { return localStorage.getItem('nx_actor') || 'analyst'; } catch { return 'analyst'; } })(),
  tx: null,
  versionId: null,
  preview: null,
  previewFor: null,
  tab: 'sql',
  editing: false,
  editSql: '',
  editCheck: null,
  showNotes: true,
  compact: false,
  generating: false,
  stages: [],
  draftPrompt: '',
  diffFrom: null,
  diffTo: null,
  auditFilter: 'all',
};

// ---------- api ----------
async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: { 'content-type': 'application/json', 'x-actor': encodeURIComponent(state.actor) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || res.statusText), { data, status: res.status });
  return data;
}

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => t.classList.remove('show'), 2600);
}

// ---------- formatting ----------
const fmtTime = (iso) => {
  const d = new Date(iso);
  const today = new Date().toDateString() === d.toDateString();
  return today ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    : d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
};
const ago = (iso) => {
  const s = (Date.now() - new Date(iso)) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(iso).toLocaleDateString();
};

function colKinds(columns, rows) {
  return columns.map((name, i) => {
    const vals = rows.map((r) => r[i]).filter((v) => v !== null && v !== undefined);
    const numeric = vals.length > 0 && vals.every((v) => typeof v === 'number');
    const yearish = numeric && /year|^yr|_yr/i.test(name) && vals.every((v) => Number.isInteger(v) && v > 1900 && v < 2200);
    const id = numeric && /(^|_)(cik|id)$/i.test(name);
    return { numeric, plain: yearish || id };
  });
}
function fmtNum(v, kind) {
  if (kind.plain) return String(v);
  const abs = Math.abs(v);
  if (state.compact && abs >= 1e6) {
    const units = [[1e12, 'T'], [1e9, 'B'], [1e6, 'M']];
    const [div, u] = units.find(([d]) => abs >= d);
    return `${(v / div).toFixed(2)}${u}`;
  }
  if (Number.isInteger(v)) return v.toLocaleString('en-US');
  const digits = abs >= 100 ? 2 : abs >= 1 ? 3 : 4;
  return v.toLocaleString('en-US', { maximumFractionDigits: digits });
}

// ---------- SQL highlighting ----------
const KW = new Set('select from where and or not join left right inner outer full cross on as group by order having limit offset with recursive union all distinct case when then else end in is null like between asc desc over partition rows range preceding following current row exists cast filter window except intersect natural using glob escape collate'.split(' '));
function highlight(line) {
  let out = '';
  const re = /(--.*$)|('(?:[^']|'')*'?)|("(?:[^"]|"")*"?)|(\b\d+(?:\.\d+)?\b)|([A-Za-z_][A-Za-z0-9_]*)(\s*\()?|([^A-Za-z0-9_'"-]+|-)/g;
  let m;
  while ((m = re.exec(line))) {
    if (m[1]) out += `<span class="cm">${esc(m[1])}</span>`;
    else if (m[2]) out += `<span class="str">${esc(m[2])}</span>`;
    else if (m[3]) out += esc(m[3]);
    else if (m[4]) out += `<span class="nm">${esc(m[4])}</span>`;
    else if (m[5]) {
      const w = m[5];
      if (m[6] && !KW.has(w.toLowerCase())) out += `<span class="fn">${esc(w)}</span>${esc(m[6])}`;
      else out += (KW.has(w.toLowerCase()) ? `<span class="kw">${esc(w)}</span>` : esc(w)) + esc(m[6] || '');
    } else out += esc(m[7]);
    if (m.index === re.lastIndex) re.lastIndex++;
  }
  return out;
}

// ---------- line diff (LCS) ----------
function diffLines(a, b) {
  const A = a.split('\n'); const B = b.split('\n');
  const n = A.length; const m = B.length;
  const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out = []; let i = 0; let j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) { out.push({ t: 'same', a: i + 1, b: j + 1, s: A[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ t: 'del', a: i + 1, s: A[i] }); i++; }
    else { out.push({ t: 'add', b: j + 1, s: B[j] }); j++; }
  }
  while (i < n) { out.push({ t: 'del', a: i + 1, s: A[i] }); i++; }
  while (j < m) { out.push({ t: 'add', b: j + 1, s: B[j] }); j++; }
  return out;
}

// ---------- status & banners ----------
async function loadStatus() {
  try { state.status = await api('GET', '/api/status'); } catch { return; }
  const s = state.status;
  const b = [];
  if (s.mockAI) b.push(['warn', '<b>Mock AI mode.</b> Responses are canned test fixtures, not Claude. Set ANTHROPIC_API_KEY and remove MOCK_AI to go live.']);
  else if (!s.aiConfigured) b.push(['err', '<b>AI generation is off.</b> This server has no ANTHROPIC_API_KEY. You can still browse data and run your own SQL.']);
  if (s.dataReady && !s.dataLoading && s.sectors && s.sectors.running && s.sectors.total) {
    b.push(['info', `Adding SEC sector codes in the background: ${s.sectors.done.toLocaleString()} of ${s.sectors.total.toLocaleString()} companies, largest first. Sector questions work for the companies done so far.`]);
  }
  if (!s.dataReady) b.push(['info', '<b>Loading the latest SEC, Treasury and FRED data…</b> The first start takes a few minutes. This page will update by itself.']);
  else if (s.dataLoading) b.push(['info', 'Refreshing the dataset in the background. Queries keep working on the current copy.']);
  $('#banners').innerHTML = b.map(([k, h]) => `<div class="banner ${k}">${h}</div>`).join('');
  $('#modelLine').textContent = s.mockAI ? 'AI · mock fixtures' : s.aiConfigured ? `AI · ${s.model}` : 'AI · not configured';
  $('#dataLine').textContent = s.dataReady ? 'Data · SEC · Treasury · FRED' : 'Data · loading…';
  if (!s.dataReady || s.dataLoading) setTimeout(loadStatus, 5000);
  else if (s.sectors && s.sectors.running) setTimeout(loadStatus, 30000);
}

async function refreshCounts() {
  try {
    const [list, audit] = await Promise.all([api('GET', '/api/transformations'), api('GET', '/api/audit')]);
    $('#navTxCount').textContent = list.length || '';
    const review = audit.filter((a) => a.status === 'ai_action').length;
    $('#navAuditCount').textContent = audit.length || '';
    return { list, audit, review };
  } catch { return null; }
}

// ---------- router ----------
async function route() {
  const [, page = 'builder', arg] = location.hash.split('/');
  document.querySelectorAll('[data-nav]').forEach((a) => a.classList.toggle('active', a.dataset.nav === page));
  if (page === 'builder') {
    if (arg && (!state.tx || state.tx.id !== arg)) {
      try { await openTransformation(arg); } catch { state.tx = null; location.hash = '#/builder'; return; }
    } else if (!arg && state.tx && !state.generating) {
      resetBuilder();
    }
    renderBuilder();
  } else if (page === 'transformations') renderList();
  else if (page === 'audit') renderAudit();
  else if (page === 'data') renderData();
  else renderBuilder();
  window.scrollTo({ top: 0 });
}

function resetBuilder() {
  Object.assign(state, { tx: null, versionId: null, preview: null, previewFor: null, tab: 'sql', editing: false, editCheck: null, stages: [], diffFrom: null, diffTo: null });
}

async function openTransformation(id) {
  state.tx = await api('GET', `/api/transformations/${id}`);
  const latest = state.tx.versions.at(-1);
  state.versionId = latest.id;
  state.tab = 'sql';
  state.editing = false;
  state.preview = null;
  loadPreview();
}

const currentVersion = () => state.tx && state.tx.versions.find((v) => v.id === state.versionId);
const latestVersion = () => state.tx && state.tx.versions.at(-1);

async function loadPreview() {
  const v = currentVersion();
  if (!v) return;
  state.previewFor = v.id;
  state.preview = { loading: true };
  try {
    const r = await api('POST', '/api/preview', { sql: v.sql });
    if (state.previewFor === v.id) state.preview = r.preview;
  } catch (e) { state.preview = { error: e.message }; }
  if (location.hash.startsWith('#/builder')) renderReviewOnly();
}

// ---------- builder ----------
function promptPanel() {
  const revising = !!state.tx;
  const disabled = state.generating || (state.status && (!state.status.aiConfigured || !state.status.dataReady));
  return `
    <div class="panel prompt">
      <label class="label" for="promptInput">▸ ${revising ? 'REVISE WITH AI' : 'DESCRIBE THE TRANSFORMATION'}</label>
      <div class="prompt-row">
        <textarea id="promptInput" rows="1" maxlength="600" placeholder="${revising ? 'e.g. Use fiscal-year-end values instead, and add operating margin' : 'e.g. Top 15 companies by 2024 revenue with net margin'}">${esc(state.draftPrompt)}</textarea>
        <button class="btn primary" id="genBtn" ${disabled ? 'disabled' : ''}>${state.generating ? 'Working…' : revising ? 'Revise ↑' : 'Generate ↑'}</button>
      </div>
      ${revising ? '' : `<div class="examples">${EXAMPLES.map((e) => `<button data-example="${esc(e)}">${esc(e)}</button>`).join('')}</div>`}
    </div>`;
}

function progressPanel() {
  if (!state.stages.length) return '';
  return `<div class="panel progress" aria-live="polite">${state.stages.map((s) => `
    <div>
      <div class="step ${s.state}"><span class="dot"></span>${esc(s.label)}</div>
      ${s.detail ? `<div class="step-detail detail">${esc(s.detail)}</div>` : ''}
    </div>`).join('')}</div>`;
}

function renderBuilder() {
  const tx = state.tx;
  const head = tx
    ? `<div class="page-head">
        <div>
          <div class="crumb"><a href="#/transformations">Transformations</a> / ${esc(tx.id)}</div>
          <h1>${esc(tx.title)}</h1>
        </div>
        <div class="filters">
          <span class="chip ${tx.status}">${tx.status.replace('_', ' ')}</span>
          <a class="btn sm ghost" href="#/builder" id="newBtn">+ New transformation</a>
        </div>
      </div>`
    : `<div class="page-head"><div><div class="crumb">Builder</div><h1>Plain English in. <em>SQL you can audit</em> out.</h1></div></div>
       <p class="intro">Describe the data you need. The AI drafts SQL over <b>live SEC filings (annual and quarterly, by sector), Treasury exchange rates and FRED rates</b>, then marks every assumption on the line it affects. Nothing runs in production until you <b>accept</b> it, and every step lands in the audit log.</p>`;
  view.innerHTML = `${head}${promptPanel()}${progressPanel()}<div id="reviewMount"></div>${tx ? '' : legend()}`;
  bindPrompt();
  renderReviewOnly();
}

function legend() {
  return `<div class="legend">
    <span><i class="marker info"></i>AI note</span>
    <span><i class="marker verify"></i>Verify — could change the answer</span>
    <span><i class="marker risk"></i>Risk — likely to mislead if wrong</span>
  </div>`;
}

function bindPrompt() {
  const ta = $('#promptInput');
  const grow = () => { ta.style.height = 'auto'; ta.style.height = `${Math.min(ta.scrollHeight, 160)}px`; };
  ta.addEventListener('input', () => { state.draftPrompt = ta.value; grow(); });
  ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); generate(); } });
  grow();
  $('#genBtn').addEventListener('click', generate);
  view.querySelectorAll('[data-example]').forEach((b) => b.addEventListener('click', () => {
    state.draftPrompt = b.dataset.example; ta.value = state.draftPrompt; grow(); ta.focus();
  }));
}

async function generate() {
  const prompt = state.draftPrompt.trim();
  if (state.generating || prompt.length < 4) return;
  state.generating = true;
  state.editing = false;
  state.stages = [];
  renderBuilder();
  const setStage = (ev) => {
    state.stages.forEach((s) => { if (s.state === 'active') s.state = 'done'; });
    state.stages.push({ label: ev.label, state: ev.stage === 'repairing' ? 'warn' : 'active', detail: ev.detail });
    view.querySelector('.progress')?.remove();
    $('#reviewMount').insertAdjacentHTML('beforebegin', progressPanel());
  };
  try {
    const res = await fetch('/api/generate', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-actor': encodeURIComponent(state.actor) },
      body: JSON.stringify({ prompt, transformationId: state.tx ? state.tx.id : undefined }),
    });
    if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error || res.statusText); }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = ''; let final = null;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        const ev = JSON.parse(line);
        if (ev.error) throw new Error(ev.error);
        if (ev.done) final = ev; else setStage(ev);
      }
    }
    if (!final) throw new Error('The response ended early.');
    state.tx = final.transformation;
    state.versionId = final.version.id;
    state.preview = final.preview;
    state.previewFor = final.version.id;
    state.tab = 'sql';
    state.draftPrompt = '';
    state.stages = [];
    state.generating = false;
    history.replaceState(null, '', `#/builder/${state.tx.id}`);
    renderBuilder();
    refreshCounts();
  } catch (e) {
    state.generating = false;
    state.stages = [];
    renderBuilder();
    toast(e.message);
  }
}

function renderReviewOnly() {
  const mount = $('#reviewMount');
  if (!mount) return;
  const v = currentVersion();
  if (!v) { mount.innerHTML = ''; return; }
  mount.innerHTML = `<div class="review">${workPanel(v)}${rail(v)}</div>`;
  bindReview(v);
}

function workPanel(v) {
  const t = state.tx;
  const p = state.preview;
  const rowsLabel = p && p.rows ? (p.truncated ? '500+' : p.rows.length) : '';
  const tabs = [['sql', 'SQL', ''], ['results', 'Results', rowsLabel], ['history', 'Versions', t.versions.length], ['diff', 'Diff', '']];
  let body = '';
  if (state.editing) body = editorView();
  else if (state.tab === 'sql') body = sqlView(v);
  else if (state.tab === 'results') body = resultsView();
  else if (state.tab === 'history') body = historyView();
  else if (state.tab === 'diff') body = diffView();
  const right = state.tab === 'sql' && !state.editing && v.assumptions.length
    ? `<div class="tabbar-right"><div class="seg"><button data-notes="1" class="${state.showNotes ? 'on' : ''}">Notes on</button><button data-notes="0" class="${state.showNotes ? '' : 'on'}">Off</button></div></div>`
    : state.tab === 'results' && !state.editing
      ? `<div class="tabbar-right"><div class="seg"><button data-compact="0" class="${state.compact ? '' : 'on'}">1,234,567</button><button data-compact="1" class="${state.compact ? 'on' : ''}">1.23M</button></div></div>`
      : '';
  return `<div class="panel work">
    <div class="tabs" role="tablist">
      ${state.editing ? `<button class="active">Editing v${t.versions.length + 1}</button>` : tabs.map(([k, l, c]) => `<button role="tab" data-tab="${k}" class="${state.tab === k ? 'active' : ''}">${l}${c !== '' ? `<span class="count">${c}</span>` : ''}</button>`).join('')}
      ${right}
    </div>
    ${body}
  </div>`;
}

function sqlView(v) {
  const lines = v.sql.split('\n');
  const byLine = {};
  v.assumptions.forEach((a, i) => { (byLine[a.line] ||= []).push({ ...a, i }); });
  const sevRank = { risk: 3, verify: 2, info: 1 };
  const html = lines.map((ln, idx) => {
    const n = idx + 1;
    const notes = byLine[n] || [];
    const top = notes.slice().sort((a, b) => sevRank[b.severity] - sevRank[a.severity])[0];
    return `<div class="ln ${top ? `flag-${top.severity}` : ''}" id="L${n}">
        <span class="g">${top ? `<button class="marker ${top.severity}" data-jump="${n}" title="${esc(top.note)}" aria-label="Note on line ${n}"></button>` : ''}</span>
        <span class="n">${n}</span><span class="t">${highlight(ln) || ' '}</span>
      </div>${notes.map((a) => `<div class="note ${a.severity}"><span class="who-tag">${a.severity === 'info' ? 'AI note' : a.severity}</span><span>${esc(a.note)}</span></div>`).join('')}`;
  }).join('');
  const header = v.author === 'ai'
    ? `<span class="chip ai">AI-generated</span><span class="micro">v${v.number} · ${esc(v.actor)} · ${ago(v.created_at)}</span>`
    : `<span class="chip user">Edited by ${esc(v.actor)}</span><span class="micro">v${v.number} · ${ago(v.created_at)} · not AI-reviewed</span>`;
  return `<div class="panel-h" style="justify-content:flex-start;gap:10px;border-bottom:0;padding-bottom:0">${header}</div>
    <div class="code ${state.showNotes ? '' : 'notes-hidden'}">${html}</div>`;
}

function resultsView() {
  const p = state.preview;
  const v = currentVersion();
  if (!p || p.loading) return '<div class="empty">Running preview…</div>';
  if (p.error) return `<div class="empty"><h3>This version doesn't run</h3><p>${esc(p.error)}</p></div>`;
  if (!p.rows.length) return '<div class="empty"><h3>No rows</h3><p>The query runs but returns nothing. Check filters, years and exact labels.</p></div>';
  const kinds = colKinds(p.columns, p.rows);
  const head = p.columns.map((c, i) => `<th class="${kinds[i].numeric ? 'n' : ''}">${esc(c)}</th>`).join('');
  const body = p.rows.map((r) => `<tr>${r.map((val, i) => {
    if (val === null) return '<td class="null">null</td>';
    if (kinds[i].numeric && typeof val === 'number') return `<td class="n ${val < 0 ? 'neg' : ''}" title="${esc(val)}">${esc(fmtNum(val, kinds[i]))}</td>`;
    return `<td>${esc(val)}</td>`;
  }).join('')}</tr>`).join('');
  return `<div class="tablewrap"><table class="data"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>
    <div class="table-foot"><span>${p.truncated ? 'First 500 rows' : `${p.rows.length.toLocaleString()} rows`} · ${p.ms} ms · values in source units (USD for financials)</span>
    <a class="btn sm" href="/api/versions/${v.id}/export.csv" download>Download CSV</a></div>`;
}

function historyView() {
  const items = state.tx.versions.slice().reverse().map((v) => {
    const dec = v.decision || (v.id === latestVersion().id ? 'in_review' : 'superseded');
    return `<li data-version="${v.id}" class="${v.id === state.versionId ? 'current' : ''}">
      <span class="vnum">v${v.number}</span>
      <div class="vmeta">
        <div>${v.author === 'ai' ? `<span class="chip ai">AI</span> ${esc(v.actor)}` : `<span class="chip user">Human</span> ${esc(v.actor)}`} · ${fmtTime(v.created_at)}</div>
        <div class="p">${esc(v.author === 'ai' ? `“${v.prompt}”` : 'Manual SQL edit')}${v.decision_note ? ` — ${esc(v.decision_note)}` : ''}</div>
      </div>
      <div class="vright">${v.confidence !== null ? `<span class="mono muted">${v.confidence}%</span>` : ''}<span class="chip ${dec}">${dec.replace('_', ' ')}</span></div>
    </li>`;
  }).join('');
  return `<ul class="vlist">${items}</ul>`;
}

function diffView() {
  const vs = state.tx.versions;
  if (vs.length < 2) return '<div class="empty"><h3>Only one version so far</h3><p>Edit the SQL or ask for a revision, then compare versions here.</p></div>';
  const to = vs.find((v) => v.id === state.diffTo) || vs.at(-1);
  const from = vs.find((v) => v.id === state.diffFrom) || vs[vs.indexOf(to) - 1] || vs[0];
  const opt = (sel) => vs.map((v) => `<option value="${v.id}" ${v.id === sel.id ? 'selected' : ''}>v${v.number} · ${v.author === 'ai' ? 'AI' : esc(v.actor)}</option>`).join('');
  const d = diffLines(from.sql, to.sql);
  const added = d.filter((x) => x.t === 'add').length; const removed = d.filter((x) => x.t === 'del').length;
  const rows = d.map((x) => `<div class="ln ${x.t === 'same' ? '' : x.t}"><span class="g">${x.t === 'add' ? '+' : x.t === 'del' ? '−' : ''}</span><span class="n">${x.a || ''}</span><span class="n">${x.b || ''}</span><span class="t">${highlight(x.s) || ' '}</span></div>`).join('');
  return `<div class="diff-bar"><select id="diffFrom">${opt(from)}</select> → <select id="diffTo">${opt(to)}</select>
      <span class="mono" style="margin-left:auto"><span style="color:var(--green)">+${added}</span> <span style="color:var(--red)">−${removed}</span></span></div>
    <div class="code diff">${rows}</div>`;
}

function editorView() {
  const c = state.editCheck;
  return `<div class="editor">
    <textarea id="editSql" spellcheck="false" aria-label="Edit SQL">${esc(state.editSql)}</textarea>
    ${c ? `<ul class="checks" style="margin-top:10px">${c.map(checkLi).join('')}</ul>` : ''}
    <div class="editor-actions">
      <button class="btn" id="runEdit">Run preview</button>
      <button class="btn primary" id="saveEdit">Save as v${state.tx.versions.length + 1}</button>
      <button class="btn ghost" id="cancelEdit">Cancel</button>
      <span class="micro" style="margin-left:auto">Saved as a human edit · AI assumptions don't carry over</span>
    </div>
  </div>`;
}

const checkLi = (c) => `<li class="${c.level}"><span class="ci">${{ ok: '✓', warn: '!', fail: '✕', info: '·' }[c.level]}</span><span>${esc(c.label)}</span></li>`;

function rail(v) {
  const isLatest = v.id === latestVersion().id;
  const order = { risk: 0, verify: 1, info: 2 };
  const first = v.assumptions.filter((a) => a.severity !== 'info').sort((a, b) => order[a.severity] - order[b.severity])[0];
  const counts = v.assumptions.reduce((m, a) => (m[a.severity] = (m[a.severity] || 0) + 1, m), {});
  const conf = v.confidence;
  const confPanel = conf === null
    ? `<div class="panel"><h4>Confidence</h4><p class="conf-reason">Human-edited SQL has no AI confidence score. The system checks below still apply.</p></div>`
    : `<div class="panel">
        <div class="conf-top"><h4 style="margin:0">Confidence</h4><span class="conf-src">model-reported</span></div>
        <div class="conf-top" style="margin-top:6px"><span class="conf-num num">${conf}<small style="font-size:16px">%</small></span>
          <span class="mono muted" style="font-size:11.5px">${counts.risk ? `<span style="color:var(--red)">${counts.risk} risk</span> · ` : ''}${counts.verify ? `<span style="color:var(--amber)">${counts.verify} verify</span> · ` : ''}${counts.info || 0} note${counts.info === 1 ? '' : 's'}</span></div>
        <div class="bar"><i style="width:${conf}%;background-size:${conf ? (100 / conf) * 100 : 100}% 100%"></i></div>
        <p class="conf-reason">${esc(v.confidence_reason || '')}</p>
        ${first ? `<button class="verify-first ${first.severity}" data-jump="${first.line}"><b>Check first · line ${first.line}</b>${esc(first.note)}</button>` : ''}
      </div>`;
  let decide;
  if (!isLatest) {
    decide = `<div class="panel"><h4>Older version</h4><p class="decision-note">You're viewing v${v.number}${v.decision ? ` (${v.decision})` : ''}. Decisions apply to the latest version.</p>
      <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap"><button class="btn sm" data-version="${latestVersion().id}">Go to latest</button><button class="btn sm edit" id="restoreBtn">Restore as v${state.tx.versions.length + 1}</button></div></div>`;
  } else if (v.decision === 'accepted') {
    decide = `<div class="panel"><h4>Decision</h4><span class="chip accepted">✓ Accepted</span><p class="decision-note">v${v.number} is the approved version${v.decision_note ? ` — “${esc(v.decision_note)}”` : ''}. Revise or edit to create a new version for review.</p>
      <div style="margin-top:10px"><button class="btn sm edit" id="editBtn">✎ Edit SQL</button></div></div>`;
  } else if (v.decision === 'rejected') {
    decide = `<div class="panel"><h4>Decision</h4><span class="chip rejected">✕ Rejected</span><p class="decision-note">${v.decision_note ? `“${esc(v.decision_note)}”` : 'No reason given.'} Ask the AI for a revision above, or fix it by hand.</p>
      <div style="margin-top:10px"><button class="btn sm edit" id="editBtn">✎ Edit SQL</button></div></div>`;
  } else {
    const runs = !(state.preview && state.preview.error);
    decide = `<div class="panel"><h4>Your decision</h4>
      <div class="decide">
        <button class="btn accept" id="acceptBtn" ${runs ? '' : 'disabled title="This version does not run"'}>✓ Accept</button>
        <button class="btn edit" id="editBtn">✎ Edit</button>
        <button class="btn danger" id="rejectBtn">✕ Reject</button>
      </div>
      <p class="decision-note muted" style="font-size:12px">Accepting records you as the approver of v${v.number} in the audit log.</p></div>`;
  }
  return `<aside class="rail">
    ${v.summary ? `<div class="panel"><h4>What this does</h4><p class="summary">${esc(v.summary)}</p></div>` : ''}
    ${v.clarifying_question ? `<div class="question"><b>The AI has a question:</b><br>${esc(v.clarifying_question)}<br><button class="btn sm" id="answerQ">Answer in a revision</button></div>` : ''}
    ${confPanel}
    <div class="panel"><h4>System checks</h4><ul class="checks">${v.checks.map(checkLi).join('')}</ul></div>
    ${decide}
  </aside>`;
}

function bindReview(v) {
  const m = $('#reviewMount');
  m.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => { state.tab = b.dataset.tab; renderReviewOnly(); }));
  m.querySelectorAll('[data-notes]').forEach((b) => b.addEventListener('click', () => { state.showNotes = b.dataset.notes === '1'; renderReviewOnly(); }));
  m.querySelectorAll('[data-compact]').forEach((b) => b.addEventListener('click', () => { state.compact = b.dataset.compact === '1'; renderReviewOnly(); }));
  m.querySelectorAll('[data-jump]').forEach((b) => b.addEventListener('click', () => {
    if (state.tab !== 'sql' || state.editing) { state.tab = 'sql'; state.editing = false; state.showNotes = true; renderReviewOnly(); }
    const el = document.getElementById(`L${b.dataset.jump}`);
    if (el) { el.scrollIntoView({ block: 'center', behavior: 'smooth' }); el.animate([{ background: 'rgba(57,197,207,.25)' }, { background: 'transparent' }], { duration: 1200 }); }
  }));
  m.querySelectorAll('[data-version]').forEach((li) => li.addEventListener('click', () => {
    state.versionId = li.dataset.version; state.tab = 'sql'; state.editing = false; loadPreview(); renderReviewOnly();
  }));
  $('#diffFrom')?.addEventListener('change', (e) => { state.diffFrom = e.target.value; renderReviewOnly(); });
  $('#diffTo')?.addEventListener('change', (e) => { state.diffTo = e.target.value; renderReviewOnly(); });
  $('#acceptBtn')?.addEventListener('click', () => decide(v, 'accept'));
  $('#rejectBtn')?.addEventListener('click', () => openReject(v));
  $('#editBtn')?.addEventListener('click', () => startEdit(v.sql));
  $('#restoreBtn')?.addEventListener('click', () => startEdit(v.sql));
  $('#answerQ')?.addEventListener('click', () => { const ta = $('#promptInput'); ta.focus(); ta.scrollIntoView({ block: 'center' }); });
  if (state.editing) {
    const ta = $('#editSql');
    ta.addEventListener('input', () => { state.editSql = ta.value; });
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Tab') { e.preventDefault(); ta.setRangeText('  ', ta.selectionStart, ta.selectionEnd, 'end'); state.editSql = ta.value; }
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); runEdit(); }
    });
    ta.focus();
    $('#runEdit').addEventListener('click', runEdit);
    $('#saveEdit').addEventListener('click', saveEdit);
    $('#cancelEdit').addEventListener('click', () => { state.editing = false; state.editCheck = null; loadPreview(); renderReviewOnly(); });
  }
}

function startEdit(sql) {
  state.editing = true; state.editSql = sql; state.editCheck = null; renderReviewOnly();
}

async function runEdit() {
  try {
    const r = await api('POST', '/api/preview', { sql: state.editSql });
    state.editCheck = r.checks;
    if (!r.preview.error) { state.preview = r.preview; state.previewFor = 'edit'; }
  } catch (e) { state.editCheck = [{ level: 'fail', label: e.message }]; }
  renderReviewOnly();
}

async function saveEdit() {
  try {
    const r = await api('POST', `/api/transformations/${state.tx.id}/versions`, { sql: state.editSql });
    state.tx = r.transformation; state.versionId = r.version.id; state.preview = r.preview; state.previewFor = r.version.id;
    state.editing = false; state.editCheck = null; state.tab = 'sql';
    renderBuilder(); toast(`Saved v${r.version.number} as a human edit`); refreshCounts();
  } catch (e) {
    state.editCheck = e.data && e.data.checks ? e.data.checks : [{ level: 'fail', label: e.message }];
    renderReviewOnly();
  }
}

async function decide(v, action, note) {
  try {
    state.tx = await api('POST', `/api/versions/${v.id}/${action}`, { note });
    renderBuilder();
    toast(action === 'accept' ? `v${v.number} accepted and logged` : `v${v.number} rejected and logged`);
    refreshCounts();
  } catch (e) { toast(e.message); }
}

function openReject(v) {
  const d = $('#rejectDialog');
  $('#rejectNote').value = '';
  d.onclose = () => { if (d.returnValue === 'confirm') decide(v, 'reject', $('#rejectNote').value.trim()); };
  d.showModal();
}

// ---------- transformations list ----------
async function renderList() {
  view.innerHTML = '<div class="page-head"><div><div class="crumb">Workspace</div><h1>Transformations</h1></div><a class="btn primary" href="#/builder">+ New</a></div><div class="panel" id="listMount"><div class="empty">Loading…</div></div>';
  const list = await api('GET', '/api/transformations').catch(() => []);
  const mount = $('#listMount');
  if (!list.length) { mount.innerHTML = '<div class="empty"><h3>Nothing here yet</h3><p>Transformations you generate in this browser appear here.</p><a class="btn primary" href="#/builder">Open the builder</a></div>'; return; }
  mount.innerHTML = `<div class="tablewrap" style="max-height:none"><table class="data"><thead><tr><th>Transformation</th><th>Status</th><th class="n">Versions</th><th class="n">Latest AI conf.</th><th>Updated</th></tr></thead><tbody>
    ${list.map((t) => `<tr><td class="click" data-open="${t.id}"><a href="#/builder/${t.id}">${esc(t.title)}</a><div class="muted" style="font-size:12px;max-width:420px;overflow:hidden;text-overflow:ellipsis">${esc(t.prompt)}</div></td>
      <td><span class="chip ${t.status}">${t.status.replace('_', ' ')}</span></td><td class="n">${t.version_count}</td>
      <td class="n">${t.latest_confidence === null ? '—' : `${t.latest_confidence}%`}</td><td class="mono" style="font-size:12px">${ago(t.updated_at)}</td></tr>`).join('')}
  </tbody></table></div>`;
}

// ---------- audit log ----------
const EVENT_LABEL = {
  requested: 'Requested transformation', requested_revision: 'Requested revision', generated: 'Generated SQL', repaired: 'Self-corrected SQL',
  edited: 'Edited SQL by hand', accepted: 'Accepted', rejected: 'Rejected', run_failed: 'Edit failed to run', blocked: 'Blocked unsafe SQL',
  generation_failed: 'Generation failed',
};
async function renderAudit() {
  view.innerHTML = `<div class="page-head"><div><div class="crumb">Governance</div><h1>Audit <em>log</em></h1></div>
    <div class="filters">
      <div class="seg" id="auditSeg">${[['all', 'All'], ['ai', 'AI'], ['user', 'Human'], ['system', 'System']].map(([k, l]) => `<button data-f="${k}" class="${state.auditFilter === k ? 'on' : ''}">${l}</button>`).join('')}</div>
      <a class="btn sm" href="/api/audit.csv" download>Export CSV</a>
    </div></div>
    <p class="intro" style="font-size:13.5px">Every AI action is labeled separately from human and system actions, so you can always answer <b>“what did the AI touch, and who approved it?”</b> This log covers transformations made in this browser.</p>
    <div class="panel" id="auditMount"><div class="empty">Loading…</div></div>`;
  $('#auditSeg').querySelectorAll('button').forEach((b) => b.addEventListener('click', () => { state.auditFilter = b.dataset.f; renderAudit(); }));
  const rows = (await api('GET', '/api/audit').catch(() => [])).filter((r) => state.auditFilter === 'all' || r.actor_type === state.auditFilter);
  const mount = $('#auditMount');
  if (!rows.length) { mount.innerHTML = '<div class="empty"><h3>No events</h3><p>Generate, edit, accept or reject a transformation and it will be recorded here.</p></div>'; return; }
  mount.innerHTML = `<div class="tablewrap" style="max-height:none"><table class="data"><thead><tr><th>Time</th><th>Event</th><th>Actor</th><th>Status</th><th>Transformation</th><th>Detail</th></tr></thead><tbody>
    ${rows.map((r) => `<tr>
      <td class="mono" style="font-size:12px">${fmtTime(r.at)}</td>
      <td>${esc(EVENT_LABEL[r.event] || r.event)}</td>
      <td><span class="chip ${r.actor_type === 'ai' ? 'ai' : r.actor_type === 'system' ? 'system' : 'user'}">${esc(r.actor)}</span></td>
      <td><span class="chip ${r.status}">${esc(r.status.replace('_', ' '))}</span></td>
      <td>${r.transformation_id ? `<a href="#/builder/${r.transformation_id}">${esc(r.transformation_title || r.transformation_id)}</a>${r.version_number ? ` <span class="mono muted">v${r.version_number}</span>` : ''}` : '<span class="muted">—</span>'}</td>
      <td class="audit-detail">${esc(r.detail || '')}</td></tr>`).join('')}
  </tbody></table></div>`;
}

// ---------- data sources ----------
async function renderData() {
  view.innerHTML = `<div class="page-head"><div><div class="crumb">Catalog</div><h1>Data <em>sources</em></h1></div></div>
    <p class="intro" style="font-size:13.5px">Everything the AI can query, with where it came from and when it was pulled. The AI sees these same column notes, which is why it can flag caveats like <b>calendar vs fiscal year</b> on the line where they matter.</p>
    <div id="dataMount" class="sources"><div class="empty">Loading…</div></div>`;
  let d;
  try { d = await api('GET', '/api/schema'); } catch (e) { $('#dataMount').innerHTML = `<div class="panel empty">${esc(e.message)}</div>`; return; }
  $('#dataMount').innerHTML = d.tables.filter((t) => t.name !== 'data_sources').map((t) => `
    <div class="panel src">
      <div style="display:flex;justify-content:space-between;gap:8px;align-items:center"><h3>${esc(t.name)}</h3><span class="chip ${t.kind === 'view' ? 'ai' : 'info'}">${t.kind}</span></div>
      ${t.description ? `<p>${esc(t.description)}</p>` : ''}
      <div class="meta"><span>${t.rowCount.toLocaleString()} rows</span>
        ${t.source ? `<span>${t.source.url ? `<a href="${esc(t.source.url.split('?')[0])}" target="_blank" rel="noopener">${esc(t.source.source)}</a>` : esc(t.source.source)}</span>
        <span>${t.source.retrieved_at ? `pulled ${ago(t.source.retrieved_at)}` : t.source.status}</span>` : ''}</div>
      ${t.source && t.source.notes && t.source.status !== 'ok' ? `<div class="banner warn" style="margin:0">${esc(t.source.notes)}</div>` : ''}
      <details><summary>${t.columns.length} columns</summary><ul class="cols">${t.columns.map((c) => `<li><code>${esc(c.name)}</code> <span>${esc(c.type)}${c.note ? ` — ${esc(c.note)}` : ''}</span></li>`).join('')}</ul></details>
    </div>`).join('');
}

// ---------- boot ----------
const actorInput = $('#actorInput');
actorInput.value = state.actor;
actorInput.addEventListener('change', () => {
  state.actor = actorInput.value.trim().slice(0, 24) || 'analyst';
  actorInput.value = state.actor;
  try { localStorage.setItem('nx_actor', state.actor); } catch {}
  toast(`Audit entries will show “${state.actor}”`);
});
window.addEventListener('hashchange', route);
loadStatus().then(() => { route(); refreshCounts(); });
