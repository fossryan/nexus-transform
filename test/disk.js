'use strict';
// Disk-space safety: a full /data volume must not crash the app (see lib/disk.js).
// Usage: npm run test:disk
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const disk = require('../lib/disk');
const { createJobs } = require('../lib/jobs');
const { download } = require('../lib/http');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-disk-'));
const diskFull = () => Object.assign(new Error('disk I/O error'), { code: 'ERR_SQLITE_ERROR', errstr: 'disk I/O error' });

(async () => {
  // 1. Leftovers from interrupted jobs are removed; real data is not.
  fs.mkdirSync(path.join(tmp, 'downloads'));
  for (const f of ['finance.db.building', 'finance.db.building-wal', 'x.zip.part', 'downloads/2026q1_form345.zip']) fs.writeFileSync(path.join(tmp, f), Buffer.alloc(1024));
  fs.writeFileSync(path.join(tmp, 'finance.db'), 'keep');
  const freed = disk.cleanLeftovers(tmp);
  assert.equal(freed, 4096);
  assert.deepEqual(fs.readdirSync(tmp).sort(), ['downloads', 'finance.db']);
  assert.deepEqual(fs.readdirSync(path.join(tmp, 'downloads')), []);
  console.log('✓ leftover temp files removed, data kept');

  // 2. Disk-full errors are recognized in all the forms SQLite and Node use.
  assert.ok(disk.isDiskError(diskFull()));
  assert.ok(disk.isDiskError(Object.assign(new Error('x'), { code: 'ENOSPC' })));
  assert.ok(disk.isDiskError(new Error('database or disk is full')));
  assert.ok(!disk.isDiskError(new Error('no such table: foo')));
  console.log('✓ disk-full errors recognized');

  // 3. Startup recovery: retry after freeing space, then fall back instead of crashing.
  let calls = 0;
  let r = disk.openWithRecovery(() => { if (calls++ === 0) throw diskFull(); return 'db'; }, { dataDir: tmp });
  assert.deepEqual(r, { value: 'db', degraded: false });
  r = disk.openWithRecovery(() => { throw diskFull(); }, { dataDir: tmp, fallback: () => 'memory' });
  assert.deepEqual(r, { value: 'memory', degraded: true });
  assert.throws(() => disk.openWithRecovery(() => { throw new Error('syntax error'); }, { dataDir: tmp, fallback: () => 'memory' }), /syntax error/);
  console.log('✓ startup retries, then falls back; other errors still surface');

  // 4. Reserve file is created once and can be released.
  assert.ok(disk.ensureReserve(tmp, 1024 * 1024));
  assert.equal(disk.releaseReserve(tmp), 1024 * 1024);
  console.log('✓ space reserve created and released');

  // 5. Jobs skip (and say why) when there isn't room, instead of filling the disk.
  const logs = [];
  const jobs = createJobs({ dataDir: path.join(tmp, 'jobs'), env: { SEC_USER_AGENT: 'test', MIN_FREE_MB: String(1e9) }, log: (l) => logs.push(l) });
  jobs.tick();
  await jobs.idle();
  assert.ok(logs.some((l) => /^! Skipped core: needs \d+ MB free/.test(l)), logs.join('\n'));
  assert.ok(logs.some((l) => /^! Skipped ownership/.test(l)));
  assert.ok(!fs.existsSync(path.join(tmp, 'jobs', 'finance.db')), 'core must not start');
  assert.ok(jobs.diagnostics().disk.skipped.core);
  console.log('✓ jobs skip with a clear message when space is short');

  // 6. A failed download doesn't leave a half-written .part file behind.
  const dest = path.join(tmp, 'big.zip');
  const realFetch = global.fetch;
  global.fetch = async () => new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(10)); c.error(new Error('connection reset')); } }));
  await assert.rejects(download('https://example.invalid/big.zip', dest));
  global.fetch = realFetch;
  assert.ok(!fs.existsSync(`${dest}.part`) && !fs.existsSync(dest));
  console.log('✓ failed download cleans up its partial file');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('ALL PASSED');
})().catch((e) => { console.error('FAILED', e); fs.rmSync(tmp, { recursive: true, force: true }); process.exitCode = 1; });
