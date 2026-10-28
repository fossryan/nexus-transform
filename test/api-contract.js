'use strict';
// Runs the real AI client (not the mock) against test/fake-anthropic.js.
const assert = require('node:assert/strict');
const BASE = process.env.BASE || 'http://localhost:8096';
const FAKE = process.env.FAKE || 'http://localhost:8111';
let cookie = '';

async function gen(prompt) {
  const res = await fetch(`${BASE}/api/generate`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ prompt }) });
  const sc = res.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
  const text = await res.text();
  return text.trim().split('\n').map((l) => JSON.parse(l));
}

(async () => {
  let ev = await gen('Top 5 companies by 2024 revenue');
  let done = ev.at(-1);
  assert.ok(done.done, JSON.stringify(ev));
  assert.equal(done.preview.rows.length, 5);
  console.log('✓ plain generation works with tool_choice auto');

  ev = await gen('give me prose please');
  assert.ok(ev.at(-1).done, JSON.stringify(ev.at(-1)));
  console.log('✓ prose answer → re-asked → tool call');

  ev = await gen('broken query');
  done = ev.at(-1);
  assert.ok(ev.some((e) => e.stage === 'repairing'));
  assert.ok(done.done, JSON.stringify(done));
  console.log('✓ repair loop replays thinking block and succeeds');

  const exRes = await fetch(`${BASE}/api/versions/${done.version.id}/explain`, { method: 'POST', headers: { 'content-type': 'application/json', cookie } });
  const exBody = await exRes.json();
  assert.equal(exBody.headline, 'Fake headline', JSON.stringify(exBody));
  console.log('✓ explain uses its own tool and a cached system prompt');

  const log = await (await fetch(`${FAKE}/__log`, { method: 'POST', body: '{}' })).json();
  assert.ok(log.every((l) => l.tool_choice.type === 'auto'));
  console.log(`✓ ${log.length} API calls, all tool_choice auto\nALL PASSED`);
})().catch((e) => { console.error('FAILED', e); process.exit(1); });
