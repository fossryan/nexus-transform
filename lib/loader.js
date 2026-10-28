// Builds data/finance.db from public, keyless sources:
//   SEC EDGAR (company list + XBRL "frames" for annual financials)
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
GROUP BY f.cik, f.calendar_year;
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

    const insF = db.prepare('INSERT OR IGNORE INTO financials VALUES (?,?,?,?,?,?,?)');
    let total = 0;
    for (let year = FIRST_YEAR; year < thisYear; year++) {
      for (const m of METRICS) {
        for (const tag of m.tags) { // priority order + INSERT OR IGNORE = first tag wins
          const period = m.instant ? `CY${year}Q4I` : `CY${year}`;
          const url = `https://data.sec.gov/api/xbrl/frames/us-gaap/${tag}/USD/${period}.json`;
          try {
            const rows = parseFrame(await f.getJson(url, ua));
            db.exec('BEGIN');
            for (const r of rows) total += Number(insF.run(r.cik, year, m.metric, r.value, r.end, tag, r.accession).changes);
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
    source.run('financials', 'SEC EDGAR XBRL frames', 'https://data.sec.gov/api/xbrl/frames/', now, total, total ? 'ok' : 'error',
      'Annual values as filed in 10-K/10-Q XBRL. Periods are calendar-aligned frames (CY2024 = the ~365-day period closest to calendar 2024), not fiscal years. Balance-sheet metrics are year-end (Q4 instant) values. Revenue uses ASC 606 revenue when reported, otherwise total Revenues.');
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

  db.exec('ANALYZE');
  db.close();
  fs.renameSync(tmp, outPath);
  return { errors };
}

module.exports = { buildDatabase, parseCompanyTickers, parseFrame, parseTreasuryRates, parseFredCsv, SCHEMA, METRICS, FRED_SERIES };

if (require.main === module) {
  const out = process.argv[2] || path.join(process.env.DATA_DIR || path.join(__dirname, '..', 'data'), 'finance.db');
  buildDatabase({ outPath: out, secUserAgent: process.env.SEC_USER_AGENT })
    .then(({ errors }) => {
      console.log(`\nWrote ${out}${errors.length ? ` with ${errors.length} warnings` : ''}`);
      process.exit(0);
    })
    .catch((e) => { console.error(e); process.exit(1); });
}
