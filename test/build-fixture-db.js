'use strict';
// Builds every database (finance, profiles, ownership, market) from placeholder fixtures by
// running the real background jobs with zero delays. Usage: node test/build-fixture-db.js [dataDir]
const path = require('node:path');
const fs = require('node:fs');
const { createJobs } = require('../lib/jobs');
const { createFetchers } = require('./fixtures');

const dataDir = process.argv[2] || path.join(__dirname, '..', 'data');
fs.rmSync(dataDir, { recursive: true, force: true });
const fetchers = createFetchers();
const logs = [];
const jobs = createJobs({
  dataDir,
  env: { SEC_USER_AGENT: 'test fixture', FINNHUB_API_KEY: 'test', FINNHUB_MAX_COMPANIES: '50' },
  log: (l) => logs.push(l), fetchers, delays: { sec: 0, finnhub: 0 },
});

(async () => {
  jobs.tick();
  await jobs.idle();
  while (jobs.state.prices.running || jobs.state.derive.running) await new Promise((r) => setTimeout(r, 50));
  const problems = logs.filter((l) => l.startsWith('!'));
  console.log(`fixture data → ${dataDir}`);
  console.log(logs.filter((l) => /Dataset ready|Derived tables refreshed|Company profiles:|Insider|13F|Prices:/.test(l)).join('\n'));
  if (problems.length) { console.log('PROBLEMS:\n' + problems.join('\n')); process.exitCode = 1; }
})();
