'use strict';
// End-to-end API test against a running server (MOCK_AI=1, fixture data).
const assert = require('node:assert/strict');
const BASE = process.env.BASE || 'http://localhost:8099';
let cookie = '';

async function call(method, path, body) {
  const res = await fetch(BASE + path, {
    method, headers: { 'content-type': 'application/json', cookie, 'x-actor': 'r.foss' }, body: body ? JSON.stringify(body) : undefined,
  });
  const sc = res.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('ndjson')) return { status: res.status, events: (await res.text()).trim().split('\n').map((l) => JSON.parse(l)) };
  return { status: res.status, body: ct.includes('json') ? await res.json() : await res.text() };
}

(async () => {
  const s = await call('GET', '/api/status');
  assert.equal(s.body.dataReady, true); assert.equal(s.body.mockAI, true);

  // 1. generate
  const g = await call('POST', '/api/generate', { prompt: 'Top 10 companies by revenue with net margin' });
  const done = g.events.at(-1);
  assert.ok(done.done, JSON.stringify(g.events));
  assert.deepEqual(g.events.map((e) => e.stage).filter(Boolean), ['schema', 'drafting', 'validating', 'running']);
  assert.equal(done.preview.rows.length, 10);
  assert.equal(done.version.author, 'ai');
  assert.ok(done.version.assumptions.length >= 1);
  const tx = done.transformation.id;
  console.log('✓ generate:', done.version.checks.map((c) => `${c.level}:${c.label}`).join(' | '));

  // 2. repair loop
  const r = await call('POST', '/api/generate', { prompt: 'broken query please' });
  const rd = r.events.at(-1);
  assert.ok(r.events.some((e) => e.stage === 'repairing'), 'expected repair stage');
  assert.ok(rd.done && rd.preview.rows.length > 0);
  assert.ok(rd.version.checks.some((c) => c.id === 'repaired'));
  console.log('✓ repair loop:', r.events.find((e) => e.stage === 'repairing').detail);

  // 3. blocked / invalid edits
  let e = await call('POST', `/api/transformations/${tx}/versions`, { sql: 'DELETE FROM companies' });
  assert.equal(e.status, 400); console.log('✓ blocked write:', e.body.error);
  e = await call('POST', `/api/transformations/${tx}/versions`, { sql: "SELECT 1; ATTACH 'x' AS y" });
  assert.equal(e.status, 400); console.log('✓ blocked multi-statement:', e.body.error);
  e = await call('POST', '/api/preview', { sql: "SELECT name FROM companies WHERE name = 'Delete; Corp'" });
  assert.ok(!e.body.preview.error, 'string literal with keyword should be allowed'); console.log('✓ keyword inside string allowed');
  e = await call('POST', '/api/preview', { sql: 'WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n) SELECT count(*) FROM n' });
  assert.match(e.body.preview.error, /stopped after/); console.log('✓ runaway query killed:', e.body.preview.error);
  e = await call('POST', '/api/preview', { sql: "SELECT replace(name, 'Placeholder ', '') AS short FROM companies LIMIT 2" });
  assert.equal(e.body.preview.rows.length, 2); console.log('✓ REPLACE() function allowed');

  // 4. user edit → new version
  const editSql = done.version.sql.replace('LIMIT 10', 'LIMIT 5');
  e = await call('POST', `/api/transformations/${tx}/versions`, { sql: editSql });
  assert.equal(e.status, 200); assert.equal(e.body.version.author, 'user'); assert.equal(e.body.version.number, 2);
  assert.equal(e.body.transformation.versions[0].decision, 'superseded');
  console.log('✓ edit saved as v2');

  // 5. accept, refine, reject
  e = await call('POST', `/api/versions/${e.body.version.id}/accept`, { note: 'checked against 10-K' });
  assert.equal(e.body.status, 'accepted');
  const rv = await call('POST', '/api/generate', { prompt: 'only show the yield spread', transformationId: tx });
  const rvd = rv.events.at(-1); assert.equal(rvd.version.number, 3); assert.equal(rvd.transformation.status, 'in_review');
  e = await call('POST', `/api/versions/${rvd.version.id}/reject`, { note: 'wrong dataset' });
  assert.equal(e.body.status, 'rejected');
  console.log('✓ accept → revise → reject');

  // 6. audit + exports
  const a = await call('GET', '/api/audit');
  console.log('✓ audit events:', a.body.map((x) => `${x.actor}:${x.event}:${x.status}`).reverse().join(', '));
  const csv = await call('GET', `/api/versions/${done.version.id}/export.csv`);
  assert.match(csv.body, /^ticker,name,revenue,net_margin_pct/);
  const acsv = await call('GET', '/api/audit.csv'); assert.match(acsv.body, /^at,actor/);
  const sch = await call('GET', '/api/schema'); assert.ok(sch.body.tables.length >= 6);
  const list = await call('GET', '/api/transformations'); assert.equal(list.body.length, 2);

  // 7. scans, explain, monitors
  let scans = await call('GET', '/api/scans');
  for (let i = 0; i < 50 && (scans.body.refreshing || scans.body.scans.some((x) => x.pending)); i++) {
    await new Promise((r) => setTimeout(r, 200)); scans = await call('GET', '/api/scans');
  }
  assert.ok(scans.body.scans.length >= 10 && scans.body.scans.every((x) => !x.error && !x.pending), JSON.stringify(scans.body.scans.filter((x) => x.error || x.pending)));
  const opened = await call('POST', '/api/scans/red_flag_filings/open');
  assert.equal(opened.body.version.author, 'system'); assert.ok(opened.body.preview.rows.length > 0);
  assert.ok(opened.body.version.assumptions.every((a) => a.line > 1), 'scan notes resolve to real lines');
  const ex = await call('POST', `/api/versions/${opened.body.version.id}/explain`);
  assert.ok(ex.body.headline, JSON.stringify(ex.body));
  const ex2 = await call('POST', `/api/versions/${opened.body.version.id}/explain`);
  assert.equal(ex2.body.created_at, ex.body.created_at, 'explanation is cached');
  let mon = await call('POST', `/api/transformations/${opened.body.transformation.id}/monitor`);
  assert.equal(mon.status, 400, 'monitor requires an accepted version');
  await call('POST', `/api/versions/${opened.body.version.id}/accept`, {});
  mon = await call('POST', `/api/transformations/${opened.body.transformation.id}/monitor`);
  assert.equal(mon.status, 200); assert.ok(mon.body.last_row_count > 0); assert.equal(mon.body.new_rows, 0);
  const mons = await call('GET', '/api/monitors'); assert.equal(mons.body.length, 1);
  const val = await call('POST', '/api/preview', { sql: 'SELECT ticker, market_cap, pe_ratio FROM valuation LIMIT 3' });
  assert.ok(!val.body.preview.error, val.body.preview.error);
  const sc = await call('POST', '/api/preview', { sql: 'SELECT ticker, piotroski_f, altman_zone FROM company_scores LIMIT 3' });
  assert.ok(!sc.body.preview.error, sc.body.preview.error);
  console.log('✓ scans, explain (cached), monitors, valuation and scores');

  // 8. session isolation
  const saved = cookie; cookie = '';
  const other = await call('GET', `/api/transformations/${tx}`); assert.equal(other.status, 404);
  cookie = saved;
  console.log('✓ exports, schema, session isolation\nALL PASSED');
})().catch((err) => { console.error('FAILED', err); process.exit(1); });
