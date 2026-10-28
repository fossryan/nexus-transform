'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createFinance } = require('./lib/finance');
const { createStore } = require('./lib/store');
const { createAI } = require('./lib/ai');
const { buildDatabase } = require('./lib/loader');

const PORT = Number(process.env.PORT || 8080);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const FINANCE_DB = path.join(DATA_DIR, 'finance.db');
const MOCK_AI = process.env.MOCK_AI === '1';
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5';
const MAX_PER_HOUR = Number(process.env.MAX_GENERATIONS_PER_HOUR || 25);
const MAX_PER_DAY = Number(process.env.MAX_DAILY_GENERATIONS || 400);
const REFRESH_DAYS = Number(process.env.DATA_REFRESH_DAYS || 7);
const PREVIEW_ROWS = 500;

fs.mkdirSync(DATA_DIR, { recursive: true });
const finance = createFinance(FINANCE_DB);
const store = createStore(path.join(DATA_DIR, 'app.db'));
const ai = createAI({ apiKey: process.env.ANTHROPIC_API_KEY, model: MODEL, mock: MOCK_AI });
const aiConfigured = MOCK_AI || !!process.env.ANTHROPIC_API_KEY;

// ---------- dataset loading ----------
const loadState = { loading: false, errors: [], lastBuilt: null };
function refreshData(reason) {
  if (loadState.loading) return;
  loadState.loading = true;
  console.log(`Building finance dataset (${reason})…`);
  buildDatabase({ outPath: FINANCE_DB, secUserAgent: process.env.SEC_USER_AGENT, log: (l) => console.log(l) })
    .then(({ errors }) => { loadState.errors = errors; loadState.lastBuilt = new Date().toISOString(); finance.invalidate(); console.log(`Dataset ready (${errors.length} warnings).`); })
    .catch((e) => { loadState.errors = [String(e.message || e)]; console.error('Dataset build failed:', e); })
    .finally(() => { loadState.loading = false; });
}
function dataAgeDays() {
  try { return (Date.now() - fs.statSync(FINANCE_DB).mtimeMs) / 86400000; } catch { return Infinity; }
}
if (process.env.SKIP_DATA_LOAD !== '1') {
  if (!finance.exists()) refreshData('first run');
  else if (dataAgeDays() > REFRESH_DAYS) refreshData('scheduled refresh');
  setInterval(() => { if (dataAgeDays() > REFRESH_DAYS) refreshData('scheduled refresh'); }, 6 * 3600 * 1000).unref();
}

// ---------- helpers ----------
const json = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
};

function readBody(req, limit = 32 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(Object.assign(new Error('Request too large'), { status: 413 })); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch { reject(Object.assign(new Error('Invalid JSON'), { status: 400 })); } });
    req.on('error', reject);
  });
}

function session(req, res) {
  const m = /(?:^|;\s*)nx_sid=([a-f0-9]{32})/.exec(req.headers.cookie || '');
  if (m) return m[1];
  const sid = crypto.randomBytes(16).toString('hex');
  const secure = (req.headers['x-forwarded-proto'] || '') === 'https' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `nx_sid=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000${secure}`);
  return sid;
}

function actorName(req) {
  const raw = decodeURIComponent(String(req.headers['x-actor'] || '')).replace(/[^\p{L}\p{N} ._'-]/gu, '').trim().slice(0, 24);
  return raw || 'analyst';
}

const hourly = new Map(); // sid -> [timestamps]
function rateCheck(sid) {
  const now = Date.now();
  const recent = (hourly.get(sid) || []).filter((t) => now - t < 3600000);
  if (recent.length >= MAX_PER_HOUR) return `Limit reached: ${MAX_PER_HOUR} generations per hour on this public demo. Editing and running SQL still works.`;
  if (store.dailyUsage() >= MAX_PER_DAY) return 'The demo has reached its daily generation budget. Editing and running SQL still works; generation resets at midnight UTC.';
  recent.push(now); hourly.set(sid, recent);
  return null;
}

// System checks are computed here, independently of what the model says about itself.
function buildChecks(result, { repairedError } = {}) {
  const checks = [{ id: 'readonly', level: 'ok', label: 'Read-only SELECT — cannot modify data' }];
  if (repairedError) checks.push({ id: 'repaired', level: 'warn', label: `First draft failed (${repairedError.slice(0, 120)}); AI repaired it once` });
  if (!result.ok) {
    checks.push({ id: 'schema', level: 'fail', label: `Does not run: ${result.error}` });
    return checks;
  }
  checks.push({ id: 'schema', level: 'ok', label: 'Every table and column exists in the live schema' });
  const n = result.rows.length;
  checks.push(n === 0
    ? { id: 'rows', level: 'warn', label: 'Runs, but returns 0 rows — check filters and labels' }
    : { id: 'rows', level: 'ok', label: `${result.truncated ? `${PREVIEW_ROWS}+` : n.toLocaleString('en-US')} rows in ${result.ms} ms` });
  if (n >= 5) {
    result.columns.forEach((c, i) => {
      const nulls = result.rows.filter((r) => r[i] === null).length;
      if (nulls / n >= 0.3) checks.push({ id: `nulls_${c.name}`, level: 'warn', label: `"${c.name}" is empty in ${Math.round((100 * nulls) / n)}% of rows — some companies may not report it` });
    });
  }
  if (result.truncated) checks.push({ id: 'truncated', level: 'info', label: `Preview shows the first ${PREVIEW_ROWS} rows` });
  return checks;
}

function preview(result) {
  return result.ok ? { columns: result.columns.map((c) => c.name), rows: result.rows, truncated: result.truncated, ms: result.ms } : { error: result.error };
}

const csvCell = (v) => (v === null || v === undefined ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
const toCsv = (cols, rows) => [cols.map(csvCell).join(','), ...rows.map((r) => r.map(csvCell).join(','))].join('\n');

// ---------- generation (streams NDJSON progress) ----------
async function handleGenerate(req, res, sid) {
  const body = await readBody(req);
  const prompt = String(body.prompt || '').trim();
  if (prompt.length < 4) return json(res, 400, { error: 'Describe the transformation you want.' });
  if (prompt.length > 600) return json(res, 400, { error: 'Keep the request under 600 characters.' });
  if (!aiConfigured) return json(res, 503, { error: 'AI generation is not configured on this server (missing ANTHROPIC_API_KEY).' });
  if (!finance.exists()) return json(res, 503, { error: 'The finance dataset is still loading — try again in a minute.' });

  let base = null;
  if (body.transformationId) {
    const t = store.getTransformation(sid, body.transformationId);
    if (!t) return json(res, 404, { error: 'Transformation not found.' });
    const latest = t.versions[t.versions.length - 1];
    base = { tx: t, sql: latest.sql, prompt: t.prompt, versionId: latest.id };
  }
  const limited = rateCheck(sid);
  if (limited) return json(res, 429, { error: limited });

  res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
  const send = (o) => res.write(`${JSON.stringify(o)}\n`);
  const actor = actorName(req);
  try {
    send({ stage: 'schema', label: 'Reading the live schema' });
    const schemaText = finance.promptSchema();
    store.bumpDailyUsage();

    send({ stage: 'drafting', label: base ? 'Revising the SQL' : 'Drafting SQL' });
    const first = await ai.propose({ schemaText, prompt, base });
    let proposal = first.proposal;

    send({ stage: 'validating', label: 'Validating against the schema' });
    let result = await finance.run(proposal.sql, { maxRows: PREVIEW_ROWS });
    let repairedError = null;
    if (!result.ok && !result.timeout) {
      repairedError = result.error;
      send({ stage: 'repairing', label: 'First draft failed — asking the AI to fix it', detail: result.error });
      const fixed = await ai.repair({ schemaText, messages: first.messages, toolUseId: first.toolUseId, rawInput: first.rawInput, error: result.error });
      proposal = fixed.proposal;
      send({ stage: 'validating', label: 'Re-validating' });
      result = await finance.run(proposal.sql, { maxRows: PREVIEW_ROWS });
    }

    send({ stage: 'running', label: 'Running preview' });
    const checks = buildChecks(result, { repairedError });
    const tx = base ? base.tx : store.createTransformation(sid, { title: proposal.title, prompt });
    const version = store.addVersion(tx.id, {
      author: 'ai', actor: ai.model, prompt, sql: proposal.sql, summary: proposal.summary, title: base ? null : proposal.title,
      confidence: proposal.confidence, confidenceReason: proposal.confidenceReason, assumptions: proposal.assumptions,
      clarifyingQuestion: proposal.clarifyingQuestion, checks,
      rowCount: result.ok ? result.rows.length : null, truncated: result.ok && result.truncated, runMs: result.ok ? result.ms : null,
      parentVersionId: base ? base.versionId : null,
    });
    store.audit(sid, { actor: actor, actorType: 'user', event: base ? 'requested_revision' : 'requested', transformationId: tx.id, versionId: version.id, detail: prompt, status: 'info' });
    if (repairedError) store.audit(sid, { actor: 'ai-agent', actorType: 'ai', event: 'repaired', transformationId: tx.id, versionId: version.id, detail: `Self-corrected after: ${repairedError}`, status: 'ai_action' });
    store.audit(sid, {
      actor: 'ai-agent', actorType: 'ai', event: 'generated', transformationId: tx.id, versionId: version.id,
      detail: `v${version.number} · ${proposal.confidence}% model-reported · ${proposal.assumptions.length} assumptions${result.ok ? ` · ${result.rows.length}${result.truncated ? '+' : ''} rows` : ' · does not run'}`,
      status: result.ok ? 'ai_action' : 'error',
    });
    send({ done: true, transformation: store.getTransformation(sid, tx.id), version, preview: preview(result) });
  } catch (e) {
    console.error('generate failed:', e);
    store.audit(sid, { actor: 'system', actorType: 'system', event: 'generation_failed', detail: String(e.message).slice(0, 300), status: 'error' });
    send({ error: e.status === 429 ? 'The AI service is busy — try again in a moment.' : `Generation failed: ${e.message}` });
  }
  res.end();
}

// ---------- routes ----------
const PUBLIC = path.join(__dirname, 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' };

function serveStatic(req, res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : decodeURIComponent(urlPath).replace(/^\/+/, '');
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, buf) => {
    if (err) { // single-page app: unknown non-API paths get the shell
      return fs.readFile(path.join(PUBLIC, 'index.html'), (e2, html) => { res.writeHead(e2 ? 404 : 200, { 'Content-Type': TYPES['.html'] }); res.end(html || 'Not found'); });
    }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': rel === 'index.html' ? 'no-cache' : 'public, max-age=300' });
    res.end(buf);
  });
}

const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self' https://fonts.googleapis.com 'unsafe-inline'; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'self' https://iamryanfoss.com");
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  if (!p.startsWith('/api/')) return serveStatic(req, res, p);
  const sid = session(req, res);
  try {
    let m;
    if (req.method === 'GET' && p === '/api/status') {
      return json(res, 200, {
        dataReady: finance.exists(), dataLoading: loadState.loading, dataWarnings: loadState.errors.length,
        aiConfigured, mockAI: MOCK_AI, model: ai.model,
        limits: { perHour: MAX_PER_HOUR, perDay: MAX_PER_DAY, usedToday: store.dailyUsage() },
      });
    }
    if (req.method === 'GET' && p === '/api/schema') {
      const d = finance.describe();
      return d ? json(res, 200, d) : json(res, 503, { error: 'Dataset is still loading.' });
    }
    if (req.method === 'GET' && p === '/api/transformations') return json(res, 200, store.listTransformations(sid));
    if (req.method === 'GET' && (m = p.match(/^\/api\/transformations\/(tx_[a-f0-9]+)$/))) {
      const t = store.getTransformation(sid, m[1]);
      return t ? json(res, 200, t) : json(res, 404, { error: 'Not found' });
    }
    if (req.method === 'POST' && p === '/api/generate') return handleGenerate(req, res, sid);
    if (req.method === 'POST' && p === '/api/preview') {
      const body = await readBody(req);
      const result = await finance.run(String(body.sql || ''), { maxRows: PREVIEW_ROWS });
      return json(res, 200, { preview: preview(result), checks: buildChecks(result) });
    }
    if (req.method === 'POST' && (m = p.match(/^\/api\/transformations\/(tx_[a-f0-9]+)\/versions$/))) {
      const t = store.getTransformation(sid, m[1]);
      if (!t) return json(res, 404, { error: 'Not found' });
      const body = await readBody(req);
      const sql = String(body.sql || '').replace(/\r\n/g, '\n').trim();
      const result = await finance.run(sql, { maxRows: PREVIEW_ROWS });
      if (!result.ok) {
        store.audit(sid, { actor: actorName(req), actorType: 'user', event: result.blocked ? 'blocked' : 'run_failed', transformationId: t.id, detail: result.error, status: 'error' });
        return json(res, 400, { error: result.error, checks: buildChecks(result) });
      }
      const latest = t.versions[t.versions.length - 1];
      const actor = actorName(req);
      const version = store.addVersion(t.id, {
        author: 'user', actor, sql, summary: latest ? latest.summary : null, assumptions: [], checks: buildChecks(result),
        rowCount: result.rows.length, truncated: result.truncated, runMs: result.ms, parentVersionId: latest ? latest.id : null,
        confidence: null,
      });
      store.audit(sid, { actor, actorType: 'user', event: 'edited', transformationId: t.id, versionId: version.id, detail: `v${version.number} edited from v${latest ? latest.number : '?'} before acceptance`, status: 'modified' });
      return json(res, 200, { transformation: store.getTransformation(sid, t.id), version, preview: preview(result) });
    }
    if (req.method === 'POST' && (m = p.match(/^\/api\/versions\/(v_[a-f0-9]+)\/(accept|reject)$/))) {
      const body = await readBody(req);
      const decision = m[2] === 'accept' ? 'accepted' : 'rejected';
      const v = store.getVersion(sid, m[1]);
      if (!v) return json(res, 404, { error: 'Not found' });
      if (decision === 'accepted') {
        const check = await finance.run(v.sql, { maxRows: 1 });
        if (!check.ok) return json(res, 400, { error: `Can't accept a transformation that doesn't run: ${check.error}` });
      }
      const note = String(body.note || '').slice(0, 300);
      store.decide(sid, v.id, decision, note);
      const actor = actorName(req);
      store.audit(sid, {
        actor, actorType: 'user', event: decision, transformationId: v.transformation_id, versionId: v.id,
        detail: decision === 'accepted'
          ? `v${v.number} (${v.author === 'ai' ? `AI-generated, ${v.confidence}% model-reported` : 'human-edited'}) approved for use${note ? ` — ${note}` : ''}`
          : `v${v.number} rejected${note ? ` — ${note}` : ''}`,
        status: decision === 'accepted' ? (v.author === 'ai' ? 'verified' : 'modified') : 'rejected',
      });
      return json(res, 200, store.getTransformation(sid, v.transformation_id));
    }
    if (req.method === 'GET' && (m = p.match(/^\/api\/versions\/(v_[a-f0-9]+)\/export\.csv$/))) {
      const v = store.getVersion(sid, m[1]);
      if (!v) return json(res, 404, { error: 'Not found' });
      const result = await finance.run(v.sql, { maxRows: 10000, timeoutMs: 8000 });
      if (!result.ok) return json(res, 400, { error: result.error });
      res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="transformation-v${v.number}.csv"` });
      return res.end(toCsv(result.columns.map((c) => c.name), result.rows));
    }
    if (req.method === 'GET' && p === '/api/audit') return json(res, 200, store.listAudit(sid));
    if (req.method === 'GET' && p === '/api/audit.csv') {
      const rows = store.listAudit(sid, 5000);
      const cols = ['at', 'actor', 'actor_type', 'event', 'status', 'transformation_title', 'version_number', 'detail'];
      res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="audit-log.csv"' });
      return res.end(toCsv(cols, rows.map((r) => cols.map((c) => r[c]))));
    }
    return json(res, 404, { error: 'Not found' });
  } catch (e) {
    console.error(e);
    return json(res, e.status || 500, { error: e.status ? e.message : 'Something went wrong.' });
  }
});

server.listen(PORT, () => console.log(`Nexus Transform listening on :${PORT}${MOCK_AI ? ' (MOCK AI — not calling Claude)' : ''}`));
module.exports = server;
