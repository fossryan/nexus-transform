// Builds data/finance.db from public, keyless sources:
//   SEC EDGAR (company list, XBRL "frames" for annual + quarterly financials,
//              and per-company submissions for SIC industry codes)
//   U.S. Treasury Fiscal Data (quarterly exchange rates)
//   FRED (interest rates, inflation, unemployment)
// Every table records where it came from and when, so the app can show provenance.

'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const FIRST_YEAR = 2018;

// Metric → XBRL tags, in priority order (first tag found wins per company/year).
// Balance-sheet items are "instant" values, so they use the year-end frame (CY2024Q4I).
const METRICS = [
  { metric: 'revenue', instant: false, tags: ['RevenueFromContractWithCustomerExcludingAssessedTax', 'Revenues', 'SalesRevenueNet'] },
  { metric: 'net_income', instant: false, tags: ['NetIncomeLoss'] },
  { metric: 'operating_income', instant: false, tags: ['OperatingIncomeLoss'] },
  { metric: 'total_assets', instant: true, tags: ['Assets'] },
  { metric: 'total_liabilities', instant: true, tags: ['Liabilities'] },
  { metric: 'stockholders_equity', instant: true, tags: ['StockholdersEquity'] },
  { metric: 'cash', instant: true, tags: ['CashAndCashEquivalentsAtCarryingValue'] },
];

const FRED_SERIES = [
  { id: 'DGS10', title: '10-Year Treasury Constant Maturity Rate', units: 'percent', frequency: 'daily' },
  { id: 'DGS2', title: '2-Year Treasury Constant Maturity Rate', units: 'percent', frequency: 'daily' },
  { id: 'DGS3MO', title: '3-Month Treasury Constant Maturity Rate', units: 'percent', frequency: 'daily' },
  { id: 'FEDFUNDS', title: 'Effective Federal Funds Rate', units: 'percent', frequency: 'monthly' },
  { id: 'CPIAUCSL', title: 'Consumer Price Index for All Urban Consumers (index 1982-84=100, seasonally adjusted)', units: 'index', frequency: 'monthly' },
  { id: 'UNRATE', title: 'Unemployment Rate', units: 'percent', frequency: 'monthly' },
];

const SCHEMA = `
CREATE TABLE companies (
  cik INTEGER PRIMARY KEY,
  ticker TEXT NOT NULL,
  name TEXT NOT NULL
);
CREATE TABLE financials (
  cik INTEGER NOT NULL,
  calendar_year INTEGER NOT NULL,
  metric TEXT NOT NULL,
  value_usd REAL NOT NULL,
  period_end TEXT,
  source_tag TEXT,
  accession TEXT,
  PRIMARY KEY (cik, calendar_year, metric)
);
CREATE INDEX financials_metric_year ON financials(metric, calendar_year);
CREATE TABLE financials_quarterly (
  cik INTEGER NOT NULL,
  calendar_year INTEGER NOT NULL,
  quarter INTEGER NOT NULL,
  metric TEXT NOT NULL,
  value_usd REAL NOT NULL,
  period_end TEXT,
  source_tag TEXT,
  accession TEXT,
  PRIMARY KEY (cik, calendar_year, quarter, metric)
);
CREATE INDEX financials_q_metric ON financials_quarterly(metric, calendar_year, quarter);
CREATE TABLE company_sectors (
  cik INTEGER PRIMARY KEY,
  sic INTEGER,
  industry TEXT,
  sector TEXT,
  fiscal_year_end TEXT
);
CREATE TABLE fx_rates (
  record_date TEXT NOT NULL,
  country_currency TEXT NOT NULL,
  country TEXT,
  currency TEXT,
  units_per_usd REAL NOT NULL,
  PRIMARY KEY (record_date, country_currency)
);
CREATE TABLE econ_series (
  series_id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  units TEXT NOT NULL,
  frequency TEXT NOT NULL
);
CREATE TABLE econ_observations (
  series_id TEXT NOT NULL,
  obs_date TEXT NOT NULL,
  value REAL NOT NULL,
  PRIMARY KEY (series_id, obs_date)
);
CREATE TABLE data_sources (
  table_name TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  url TEXT NOT NULL,
  retrieved_at TEXT,
  row_count INTEGER,
  status TEXT,
  notes TEXT
);
CREATE VIEW annual_financials AS
SELECT
  f.cik,
  c.ticker,
  c.name,
  s.sector,
  s.industry,
  s.fiscal_year_end,
  f.calendar_year,
  MAX(CASE WHEN f.metric = 'revenue' THEN f.value_usd END) AS revenue,
  MAX(CASE WHEN f.metric = 'operating_income' THEN f.value_usd END) AS operating_income,
  MAX(CASE WHEN f.metric = 'net_income' THEN f.value_usd END) AS net_income,
  MAX(CASE WHEN f.metric = 'total_assets' THEN f.value_usd END) AS total_assets,
  MAX(CASE WHEN f.metric = 'total_liabilities' THEN f.value_usd END) AS total_liabilities,
  MAX(CASE WHEN f.metric = 'stockholders_equity' THEN f.value_usd END) AS stockholders_equity,
  MAX(CASE WHEN f.metric = 'cash' THEN f.value_usd END) AS cash
FROM financials f
LEFT JOIN companies c ON c.cik = f.cik
LEFT JOIN company_sectors s ON s.cik = f.cik
GROUP BY f.cik, f.calendar_year;
CREATE VIEW quarterly_financials AS
SELECT
  f.cik,
  c.ticker,
  c.name,
  s.sector,
  s.industry,
  f.calendar_year,
  f.quarter,
  MAX(CASE WHEN f.metric = 'revenue' THEN f.value_usd END) AS revenue,
  MAX(CASE WHEN f.metric = 'operating_income' THEN f.value_usd END) AS operating_income,
  MAX(CASE WHEN f.metric = 'net_income' THEN f.value_usd END) AS net_income,
  MAX(CASE WHEN f.metric = 'total_assets' THEN f.value_usd END) AS total_assets,
  MAX(CASE WHEN f.metric = 'total_liabilities' THEN f.value_usd END) AS total_liabilities,
  MAX(CASE WHEN f.metric = 'stockholders_equity' THEN f.value_usd END) AS stockholders_equity,
  MAX(CASE WHEN f.metric = 'cash' THEN f.value_usd END) AS cash
FROM financials_quarterly f
LEFT JOIN companies c ON c.cik = f.cik
LEFT JOIN company_sectors s ON s.cik = f.cik
GROUP BY f.cik, f.calendar_year, f.quarter;
`;

// ---------- parsers (pure, unit-tested against fixtures) ----------

function parseCompanyTickers(json) {
  // {"0":{"cik_str":320193,"ticker":"AAPL","title":"Apple Inc."}, ...}
  const seen = new Map();
  for (const row of Object.values(json)) {
    const cik = Number(row.cik_str);
    if (!cik || seen.has(cik)) continue; // first listed ticker per company (usually the primary share class)
    seen.set(cik, { cik, ticker: String(row.ticker).toUpperCase(), name: String(row.title) });
  }
  return [...seen.values()];
}

function parseFrame(json) {
  // {"tag":"Revenues","uom":"USD","ccp":"CY2023","data":[{"accn","cik","entityName","loc","end","val"}]}
  if (!json || !Array.isArray(json.data)) return [];
  return json.data
    .filter((d) => d && Number.isFinite(Number(d.val)) && d.cik)
    .map((d) => ({ cik: Number(d.cik), value: Number(d.val), end: d.end || null, accession: d.accn || null }));
}

// SIC divisions (the SEC's broad industry groups) from a 4-digit SIC code.
function sicSector(sic) {
  const n = Number(sic);
  if (!Number.isFinite(n) || n <= 0) return null;
  const d = Math.floor(n / 100);
  if (d <= 9) return 'Agriculture, Forestry & Fishing';
  if (d <= 14) return 'Mining & Energy Extraction';
  if (d <= 17) return 'Construction';
  if (d <= 39) return 'Manufacturing';
  if (d <= 49) return 'Transportation, Communications & Utilities';
  if (d <= 51) return 'Wholesale Trade';
  if (d <= 59) return 'Retail Trade';
  if (d <= 67) return 'Finance, Insurance & Real Estate';
  if (d <= 89) return 'Services';
  if (d <= 97) return 'Public Administration';
  return 'Nonclassifiable';
}

function parseSubmission(json) {
  // {"cik":"0000320193","sic":"3571","sicDescription":"Electronic Computers","fiscalYearEnd":"0926", ...}
  if (!json) return null;
  const sic = Number(json.sic) || null;
  const fye = /^\d{4}$/.test(json.fiscalYearEnd || '') ? `${json.fiscalYearEnd.slice(0, 2)}-${json.fiscalYearEnd.slice(2)}` : null;
  return { sic, industry: json.sicDescription || null, sector: sicSector(sic), fiscal_year_end: fye };
}

function parseTreasuryRates(json) {
  // {"data":[{"record_date":"2024-12-31","country_currency_desc":"Euro Zone-Euro","exchange_rate":"0.961", "country":"Euro Zone","currency":"Euro"}]}
  if (!json || !Array.isArray(json.data)) return [];
  return json.data
    .map((d) => ({
      record_date: d.record_date,
      country_currency: d.country_currency_desc,
      country: d.country || (d.country_currency_desc || '').split('-')[0] || null,
      currency: d.currency || (d.country_currency_desc || '').split('-').slice(1).join('-') || null,
      units_per_usd: Number(d.exchange_rate),
    }))
    .filter((d) => d.record_date && d.country_currency && Number.isFinite(d.units_per_usd) && d.units_per_usd > 0);
}

function parseFredCsv(text, seriesId) {
  // header is "observation_date,DGS10" (older files used "DATE,DGS10"); missing values are "." or empty
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  const header = lines[0].split(',').map((h) => h.trim().replace(/"/g, ''));
  const dateIdx = header.findIndex((h) => /^(observation_date|date)$/i.test(h));
  const valIdx = header.findIndex((h) => h.toUpperCase() === seriesId.toUpperCase());
  if (dateIdx < 0 || valIdx < 0) throw new Error(`Unexpected FRED CSV header for ${seriesId}: ${lines[0]}`);
  const out = [];
  for (const line of lines.slice(1)) {
    const cols = line.split(',');
    const v = cols[valIdx];
    if (v === undefined || v === '' || v === '.') continue;
    const n = Number(v);
    if (!Number.isFinite(n)) continue;
    out.push({ obs_date: cols[dateIdx], value: n });
  }
  return out;
}

// ---------- fetching ----------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url, headers = {}) {
  const res = await fetch(url, { headers: { Accept: 'application/json', ...headers } });
  if (res.status === 404) return null; // EDGAR returns 404 for frames that don't exist
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} — ${url}`);
  return res.json();
}

async function getText(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} — ${url}`);
  return res.text();
}

async function buildDatabase({ outPath, secUserAgent, log = console.log, fetchers } = {}) {
  const f = fetchers || { getJson, getText };
  const tmp = `${outPath}.building`;
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  if (fs.existsSync(tmp)) fs.rmSync(tmp);
  const db = new DatabaseSync(tmp);
  db.exec(SCHEMA);
  const now = new Date().toISOString();
  const source = db.prepare('INSERT OR REPLACE INTO data_sources VALUES (?,?,?,?,?,?,?)');
  const thisYear = new Date().getUTCFullYear();
  const errors = [];

  // --- SEC EDGAR ---
  if (!secUserAgent) {
    const msg = 'SEC_USER_AGENT is not set; SEC requires a descriptive User-Agent with contact info, so EDGAR tables were skipped.';
    errors.push(msg);
    log(`! ${msg}`);
    source.run('companies', 'SEC EDGAR', 'https://www.sec.gov/files/company_tickers.json', null, 0, 'skipped', msg);
    source.run('financials', 'SEC EDGAR XBRL frames', 'https://data.sec.gov/api/xbrl/frames/', null, 0, 'skipped', msg);
    source.run('financials_quarterly', 'SEC EDGAR XBRL frames', 'https://data.sec.gov/api/xbrl/frames/', null, 0, 'skipped', msg);
  } else {
    const ua = { 'User-Agent': secUserAgent };
    try {
      log('· SEC company list');
      const companies = parseCompanyTickers(await f.getJson('https://www.sec.gov/files/company_tickers.json', ua));
      const ins = db.prepare('INSERT INTO companies VALUES (?,?,?)');
      db.exec('BEGIN');
      for (const c of companies) ins.run(c.cik, c.ticker, c.name);
      db.exec('COMMIT');
      source.run('companies', 'SEC EDGAR', 'https://www.sec.gov/files/company_tickers.json', now, companies.length, 'ok',
        'Public companies with an SEC ticker. One row per CIK; first listed ticker kept when a company has several share classes.');
    } catch (e) {
      errors.push(`companies: ${e.message}`);
      log(`! companies: ${e.message}`);
      source.run('companies', 'SEC EDGAR', 'https://www.sec.gov/files/company_tickers.json', now, 0, 'error', e.message);
    }

    // Fetch every tag for a period in priority order; INSERT OR IGNORE means the first tag found wins.
    async function loadFrames(periods, insert) {
      let total = 0;
      for (const p of periods) {
        for (const m of METRICS) {
          for (const tag of m.tags) {
            const period = m.instant ? p.instant : p.duration;
            const url = `https://data.sec.gov/api/xbrl/frames/us-gaap/${tag}/USD/${period}.json`;
            try {
              const rows = parseFrame(await f.getJson(url, ua));
              db.exec('BEGIN');
              for (const r of rows) total += insert(p, m.metric, r, tag);
              db.exec('COMMIT');
              log(`· ${period} ${tag}: ${rows.length}`);
            } catch (e) {
              try { db.exec('ROLLBACK'); } catch {}
              errors.push(`${tag} ${period}: ${e.message}`);
              log(`! ${tag} ${period}: ${e.message}`);
            }
            await sleep(150); // stay well under SEC's 10 requests/second limit
          }
        }
      }
      return total;
    }

    const insF = db.prepare('INSERT OR IGNORE INTO financials VALUES (?,?,?,?,?,?,?)');
    const annualPeriods = [];
    for (let year = FIRST_YEAR; year < thisYear; year++) annualPeriods.push({ year, duration: `CY${year}`, instant: `CY${year}Q4I` });
    const total = await loadFrames(annualPeriods, (p, metric, r, tag) => Number(insF.run(r.cik, p.year, metric, r.value, r.end, tag, r.accession).changes));
    source.run('financials', 'SEC EDGAR XBRL frames', 'https://data.sec.gov/api/xbrl/frames/', now, total, total ? 'ok' : 'error',
      'Annual values as filed in 10-K/10-Q XBRL. Periods are calendar-aligned frames (CY2024 = the ~365-day period closest to calendar 2024), not fiscal years. Balance-sheet metrics are year-end (Q4 instant) values. Revenue uses ASC 606 revenue when reported, otherwise total Revenues.');

    // Quarters that ended at least ~50 days ago (time for 10-Qs to be filed).
    const insQ = db.prepare('INSERT OR IGNORE INTO financials_quarterly VALUES (?,?,?,?,?,?,?,?)');
    const cutoff = Date.now() - 50 * 86400000;
    const quarterPeriods = [];
    for (let year = FIRST_YEAR; year <= thisYear; year++) {
      for (let q = 1; q <= 4; q++) {
        if (Date.UTC(year, q * 3, 0) > cutoff) continue; // last day of the quarter
        quarterPeriods.push({ year, q, duration: `CY${year}Q${q}`, instant: `CY${year}Q${q}I` });
      }
    }
    const qTotal = await loadFrames(quarterPeriods, (p, metric, r, tag) => Number(insQ.run(r.cik, p.year, p.q, metric, r.value, r.end, tag, r.accession).changes));
    source.run('financials_quarterly', 'SEC EDGAR XBRL frames', 'https://data.sec.gov/api/xbrl/frames/', now, qTotal, qTotal ? 'ok' : 'error',
      'Quarterly values from 10-Q/10-K XBRL, calendar-aligned (CY2024Q1 = the ~91-day period closest to Jan–Mar 2024). Q4 income figures are often missing because many companies only report the full year in the 10-K; Q4 can be derived as annual minus Q1–Q3. Balance-sheet metrics are quarter-end snapshots.');
  }

  // --- Treasury exchange rates ---
  const fxUrl = 'https://api.fiscaldata.treasury.gov/services/api/fiscal_service/v1/accounting/od/rates_of_exchange'
    + `?filter=record_date:gte:${FIRST_YEAR}-01-01&sort=record_date&page[size]=5000`;
  try {
    log('· Treasury exchange rates');
    const rows = [];
    for (let page = 1; page <= 20; page++) {
      const json = await f.getJson(`${fxUrl}&page[number]=${page}`);
      rows.push(...parseTreasuryRates(json));
      const pages = Number(json && json.meta && json.meta['total-pages']) || 1;
      if (page >= pages) break;
      await sleep(200);
    }
    const ins = db.prepare('INSERT OR IGNORE INTO fx_rates VALUES (?,?,?,?,?)');
    db.exec('BEGIN');
    for (const r of rows) ins.run(r.record_date, r.country_currency, r.country, r.currency, r.units_per_usd);
    db.exec('COMMIT');
    source.run('fx_rates', 'U.S. Treasury Fiscal Data — Treasury Reporting Rates of Exchange', fxUrl, now, rows.length, 'ok',
      'Official quarterly rates (units of foreign currency per 1 USD) used by federal agencies. Published quarterly, with amendments between quarters when a rate moves 10%+.');
  } catch (e) {
    errors.push(`fx_rates: ${e.message}`);
    log(`! fx_rates: ${e.message}`);
    source.run('fx_rates', 'U.S. Treasury Fiscal Data', fxUrl, now, 0, 'error', e.message);
  }

  // --- FRED ---
  const insS = db.prepare('INSERT OR REPLACE INTO econ_series VALUES (?,?,?,?)');
  const insO = db.prepare('INSERT OR IGNORE INTO econ_observations VALUES (?,?,?)');
  let obs = 0;
  for (const s of FRED_SERIES) {
    const url = `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${s.id}&cosd=${FIRST_YEAR}-01-01`;
    try {
      const rows = parseFredCsv(await f.getText(url), s.id).filter((r) => r.obs_date >= `${FIRST_YEAR}-01-01`);
      insS.run(s.id, s.title, s.units, s.frequency);
      db.exec('BEGIN');
      for (const r of rows) obs += Number(insO.run(s.id, r.obs_date, r.value).changes);
      db.exec('COMMIT');
      log(`· FRED ${s.id}: ${rows.length}`);
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch {}
      errors.push(`FRED ${s.id}: ${e.message}`);
      log(`! FRED ${s.id}: ${e.message}`);
    }
    await sleep(200);
  }
  source.run('econ_observations', 'Federal Reserve Bank of St. Louis — FRED', 'https://fred.stlouisfed.org/', now, obs, obs ? 'ok' : 'error',
    `Series: ${FRED_SERIES.map((s) => s.id).join(', ')}. Daily Treasury yields skip weekends and market holidays; missing days are absent rather than null.`);

  // Sector codes rarely change and take a while to fetch, so keep the ones we already have.
  carryOverSectors(db, outPath, now);

  db.exec('ANALYZE');
  db.close();
  fs.renameSync(tmp, outPath);
  return { errors };
}

function carryOverSectors(db, oldPath, now) {
  let copied = 0;
  if (fs.existsSync(oldPath)) {
    try {
      db.exec(`ATTACH DATABASE '${oldPath.replace(/'/g, "''")}' AS old`);
      copied = Number(db.prepare('INSERT OR IGNORE INTO company_sectors SELECT cik, sic, industry, sector, fiscal_year_end FROM old.company_sectors').run().changes);
      db.exec('DETACH DATABASE old');
    } catch { try { db.exec('DETACH DATABASE old'); } catch {} }
  }
  db.prepare('INSERT OR REPLACE INTO data_sources VALUES (?,?,?,?,?,?,?)').run(
    'company_sectors', 'SEC EDGAR submissions', 'https://data.sec.gov/submissions/', copied ? now : null, copied, 'filling',
    'SIC industry code, SEC sector division and fiscal year-end for each filer. Filled in the background after the main load, largest companies first.');
}

// Background job: fetch SIC codes for companies that have financials but no sector yet.
// Resumable — only missing companies are fetched, so a restart picks up where it left off.
async function fillSectors({ dbPath, secUserAgent, log = console.log, fetchers, onProgress = () => {}, shouldStop = () => false } = {}) {
  if (!secUserAgent || !fs.existsSync(dbPath)) return { done: 0, remaining: null };
  const f = fetchers || { getJson, getText };
  const db = new DatabaseSync(dbPath);
  const todo = db.prepare(`
    SELECT f.cik FROM financials f
    WHERE f.cik NOT IN (SELECT cik FROM company_sectors)
    GROUP BY f.cik
    ORDER BY MAX(CASE WHEN f.metric = 'revenue' THEN f.value_usd END) DESC NULLS LAST`).all().map((r) => Number(r.cik));
  const ins = db.prepare('INSERT OR REPLACE INTO company_sectors VALUES (?,?,?,?,?)');
  const status = db.prepare("UPDATE data_sources SET status = ?, row_count = (SELECT COUNT(*) FROM company_sectors), retrieved_at = ? WHERE table_name = 'company_sectors'");
  const total = todo.length;
  let done = 0;
  let failures = 0;
  log(`· Sector codes: ${total} companies to fetch`);
  for (const cik of todo) {
    if (shouldStop()) break;
    try {
      const sub = parseSubmission(await f.getJson(`https://data.sec.gov/submissions/CIK${String(cik).padStart(10, '0')}.json`, { 'User-Agent': secUserAgent }));
      // A missing filing record still gets a row (all NULL) so it isn't retried forever.
      ins.run(cik, sub ? sub.sic : null, sub ? sub.industry : null, sub ? sub.sector : null, sub ? sub.fiscal_year_end : null);
      done++;
    } catch (e) {
      failures++;
      if (failures >= 20) { log(`! Sector codes paused after repeated errors: ${e.message}`); break; }
    }
    if (done % 200 === 0) {
      status.run('filling', new Date().toISOString());
      onProgress({ done, total });
      if (done) log(`· Sector codes: ${done}/${total}`);
    }
    await sleep(125); // ~8 requests/second, under SEC's 10/second limit
  }
  const remaining = total - done;
  status.run(remaining === 0 ? 'ok' : 'filling', new Date().toISOString());
  db.close();
  onProgress({ done, total });
  log(`· Sector codes: ${done} fetched, ${remaining} remaining`);
  return { done, remaining };
}

// Tables the current app version expects; an older dataset missing any of them is rebuilt.
const REQUIRED_TABLES = ['companies', 'financials', 'financials_quarterly', 'company_sectors', 'fx_rates', 'econ_series', 'econ_observations', 'data_sources'];

module.exports = { buildDatabase, fillSectors, parseCompanyTickers, parseFrame, parseSubmission, sicSector, parseTreasuryRates, parseFredCsv, SCHEMA, METRICS, FRED_SERIES, REQUIRED_TABLES };

if (require.main === module) {
  const out = process.argv[2] || path.join(process.env.DATA_DIR || path.join(__dirname, '..', 'data'), 'finance.db');
  buildDatabase({ outPath: out, secUserAgent: process.env.SEC_USER_AGENT })
    .then(async ({ errors }) => {
      console.log(`\nWrote ${out}${errors.length ? ` with ${errors.length} warnings` : ''}`);
      if (process.argv.includes('--sectors')) await fillSectors({ dbPath: out, secUserAgent: process.env.SEC_USER_AGENT });
      process.exit(0);
    })
    .catch((e) => { console.error(e); process.exit(1); });
}
