'use strict';
// Background data jobs and their schedule. SEC jobs run one at a time (SEC asks for ≤10
// requests/second per client); Finnhub prices run alongside them.
//
//   core       finance.db from SEC frames + Treasury + FRED     weekly, or when tables are missing
//   derive     ratios, scores, peer ranks                        after core, and as sectors fill in
//   profiles   sectors + 8-K events                              continuously until done, then weekly
//   ownership  insider trades + 13F holdings                     daily check for new quarterly files
//   prices     Finnhub quotes for the largest companies          daily (needs FINNHUB_API_KEY)

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { Worker } = require('node:worker_threads');
const { buildDatabase, REQUIRED_TABLES } = require('./loader');
const { fillProfiles, ensureProfilesDb } = require('./profiles');
const { refreshOwnership, ensureOwnershipDb } = require('./ownership');
const { refreshPrices, ensureMarketDb, lastRun: pricesLastRun } = require('./market');

const DERIVED_TABLES = ['latest_complete_year', 'annual_financials', 'quarterly_financials', 'company_ratios', 'company_scores'];

function createJobs({ dataDir, env = process.env, log: rawLog = console.log, onDataChanged = () => {}, fetchers, delays = {} }) {
  // Keep recent problems and the latest step so the app can show what's happening.
  const problems = [];
  let lastStep = null;
  const log = (line) => {
    rawLog(line);
    const at = new Date().toISOString();
    if (String(line).startsWith('!')) { problems.push({ at, message: String(line).slice(2, 400) }); if (problems.length > 25) problems.shift(); }
    else lastStep = { at, message: String(line).replace(/^· /, '').slice(0, 200) };
  };
  const paths = {
    finance: path.join(dataDir, 'finance.db'),
    profiles: path.join(dataDir, 'profiles.db'),
    ownership: path.join(dataDir, 'ownership.db'),
    market: path.join(dataDir, 'market.db'),
    work: path.join(dataDir, 'downloads'),
  };
  ensureProfilesDb(paths.profiles);
  ensureOwnershipDb(paths.ownership);
  ensureMarketDb(paths.market);

  const refreshDays = Number(env.DATA_REFRESH_DAYS || 7);
  const state = {
    core: { running: false, lastBuilt: null, warnings: 0 },
    derive: { running: false, lastRun: null, error: null },
    profiles: { running: false, done: 0, total: 0 },
    ownership: { running: false, lastRun: null, errors: 0 },
    prices: { running: false, done: 0, total: 0, configured: !!env.FINNHUB_API_KEY },
  };
  let secQueue = Promise.resolve();
  const queued = new Set();

  // Serialize SEC-bound jobs; drop duplicates already waiting.
  function enqueueSec(name, fn) {
    if (queued.has(name)) return;
    queued.add(name);
    secQueue = secQueue.then(async () => {
      queued.delete(name);
      try { await fn(); } catch (e) { log(`! ${name} failed: ${e.message}`); }
    });
  }

  const tablesIn = (file) => {
    try {
      const db = new DatabaseSync(file, { readOnly: true });
      const t = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name));
      db.close();
      return t;
    } catch { return new Set(); }
  };

  function coreRebuildReasons() {
    if (!fs.existsSync(paths.finance)) return ['first run'];
    const have = tablesIn(paths.finance);
    const reasons = REQUIRED_TABLES.filter((t) => !have.has(t)).map((t) => `new table ${t}`);
    try {
      const db = new DatabaseSync(paths.finance, { readOnly: true });
      const metricCols = db.prepare("SELECT name FROM pragma_table_info('financials')").all().map((r) => r.name);
      if (!metricCols.includes('unit')) reasons.push('expanded metrics');
      for (const r of db.prepare("SELECT table_name, status FROM data_sources WHERE status IN ('skipped','error')").all()) {
        reasons.push(`${r.table_name} (${r.status})`);
      }
      db.close();
    } catch {}
    const ageDays = (Date.now() - fs.statSync(paths.finance).mtimeMs) / 86400000;
    if (!reasons.length && ageDays > refreshDays) reasons.push('scheduled refresh');
    return reasons;
  }

  // Derived tables rebuild in a worker thread; requests that arrive meanwhile coalesce into one rerun.
  let deriveAgain = null;
  function runDerive(reason) {
    if (!fs.existsSync(paths.finance) || state.core.running) return Promise.resolve();
    if (state.derive.running) { deriveAgain = reason; return Promise.resolve(); }
    state.derive.running = true;
    return new Promise((resolve) => {
      const w = new Worker(path.join(__dirname, 'derive-worker.js'), { workerData: { financeDbPath: paths.finance, profilesDbPath: paths.profiles } });
      w.once('message', (m) => {
        (m.logs || []).forEach((l) => log(l));
        if (m.ok) { state.derive.lastRun = new Date().toISOString(); state.derive.error = null; log(`· Derived tables refreshed (${reason})`); }
        else { state.derive.error = m.error; log(`! Derived tables failed: ${m.error}`); }
      });
      w.once('error', (e) => { state.derive.error = e.message; log(`! Derived tables failed: ${e.message}`); });
      w.once('exit', () => {
        state.derive.running = false;
        onDataChanged();
        const again = deriveAgain; deriveAgain = null;
        resolve(again ? runDerive(again) : undefined);
      });
    });
  }

  async function runCore(reason) {
    state.core.running = true;
    log(`Building finance dataset (${reason})…`);
    try {
      const { errors, kept } = await buildDatabase({ outPath: paths.finance, secUserAgent: env.SEC_USER_AGENT, log, fetchers, delayMs: delays.sec });
      state.core.warnings = errors.length;
      if (kept) { state.core.lastFailed = new Date().toISOString(); log('Dataset refresh incomplete; keeping the previous data and retrying in 6 hours.'); return; }
      state.core.lastBuilt = new Date().toISOString();
      log(`Dataset ready (${errors.length} warnings).`);
    } finally { state.core.running = false; }
    await runDerive('new dataset');
  }

  async function runProfiles() {
    if (!env.SEC_USER_AGENT) return;
    state.profiles.running = true;
    let sinceDerive = 0;
    let lastDeriveAt = Date.now();
    try {
      await fillProfiles({
        dbPath: paths.profiles, financeDbPath: paths.finance, secUserAgent: env.SEC_USER_AGENT, log, fetchers, delayMs: delays.sec,
        shouldStop: () => state.core.running,
        onProgress: ({ done, total }) => {
          state.profiles.done = done; state.profiles.total = total;
          // Re-rank peers as sectors arrive so sector questions improve during the fill.
          // (At most every 4,000 companies and 15 minutes — each rebuild is CPU-heavy.)
          if (done - sinceDerive >= 4000 && Date.now() - lastDeriveAt > 15 * 60 * 1000) { sinceDerive = done; lastDeriveAt = Date.now(); runDerive('sector codes added'); }
        },
      });
    } finally { state.profiles.running = false; }
    await runDerive('company profiles updated');
  }

  async function runOwnership() {
    if (!env.SEC_USER_AGENT) return;
    state.ownership.running = true;
    try {
      const r = await refreshOwnership({ dbPath: paths.ownership, workDir: paths.work, secUserAgent: env.SEC_USER_AGENT, log, fetchers });
      state.ownership.lastRun = new Date().toISOString();
      state.ownership.errors = (r.errors || []).length;
    } finally { state.ownership.running = false; onDataChanged(); }
  }

  function startPrices() {
    if (!env.FINNHUB_API_KEY || state.prices.running || !fs.existsSync(paths.finance)) return;
    const last = pricesLastRun(paths.market);
    if (last && Date.now() - Date.parse(last) < 20 * 3600 * 1000) return;
    state.prices.running = true;
    refreshPrices({
      dbPath: paths.market, financeDbPath: paths.finance, apiKey: env.FINNHUB_API_KEY,
      maxCompanies: Number(env.FINNHUB_MAX_COMPANIES || 1000), log, fetchers, delayMs: delays.finnhub,
      onProgress: ({ done, total }) => { state.prices.done = done; state.prices.total = total; },
    })
      .catch((e) => log(`! prices failed: ${e.message}`))
      .finally(() => { state.prices.running = false; onDataChanged(); });
  }

  function tick() {
    const reasons = coreRebuildReasons();
    if (reasons.length) enqueueSec('core', () => runCore(reasons.join(', ')));
    else {
      const have = tablesIn(paths.finance);
      if (DERIVED_TABLES.some((t) => !have.has(t))) runDerive('derived tables missing');
    }
    enqueueSec('profiles', runProfiles);
    const lastOwn = state.ownership.lastRun ? Date.parse(state.ownership.lastRun) : 0;
    if (Date.now() - lastOwn > 20 * 3600 * 1000) enqueueSec('ownership', runOwnership);
    secQueue.then(startPrices);
  }

  function start() {
    tick();
    const t = setInterval(tick, 6 * 3600 * 1000);
    t.unref();
  }

  const busy = () => state.core.running || state.derive.running;
  const diagnostics = () => ({ problems: problems.slice(-15).reverse(), lastStep });
  return { start, tick, state, paths, busy, idle: () => secQueue, runDerive, diagnostics };
}

module.exports = { createJobs, DERIVED_TABLES };
