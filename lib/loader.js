// Builds data/finance.db — the core dataset, rebuilt weekly from keyless public sources:
//   SEC EDGAR   company list + XBRL "frames" (annual for every metric, quarterly for core metrics)
//   Treasury    quarterly exchange rates (Fiscal Data API)
//   FRED        rates, spreads, inflation, growth, markets
// Derived tables (wide financials, ratios, scores, peer ranks) are added by lib/derive.js.
// Sector codes, 8-K events, insider trades, fund holdings and prices live in their own
// databases (profiles.db, ownership.db, market.db) because they refresh on different schedules.

'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const http = require('./http');

const FIRST_YEAR = 2018;

// metric → XBRL tags in priority order (first tag found wins per company and period).
// instant = balance-sheet snapshot (uses the "I" frame); q = also loaded quarterly.
const METRICS = [
  { metric: 'revenue', tags: ['RevenueFromContractWithCustomerExcludingAssessedTax', 'Revenues', 'SalesRevenueNet'], q: true },
  { metric: 'cost_of_revenue', tags: ['CostOfRevenue', 'CostOfGoodsAndServicesSold'] },
  { metric: 'gross_profit', tags: ['GrossProfit'], q: true },
  { metric: 'operating_income', tags: ['OperatingIncomeLoss'], q: true },
  { metric: 'net_income', tags: ['NetIncomeLoss'], q: true },
  { metric: 'rd_expense', tags: ['ResearchAndDevelopmentExpense'] },
  { metric: 'sga_expense', tags: ['SellingGeneralAndAdministrativeExpense'] },
  { metric: 'interest_expense', tags: ['InterestExpense', 'InterestExpenseNonoperating', 'InterestExpenseDebt'] },
  { metric: 'depreciation_amortization', tags: ['DepreciationDepletionAndAmortization', 'DepreciationAndAmortization', 'DepreciationAmortizationAndAccretionNet'] },
  { metric: 'operating_cash_flow', tags: ['NetCashProvidedByUsedInOperatingActivities'], q: true },
  { metric: 'capex', tags: ['PaymentsToAcquirePropertyPlantAndEquipment'], q: true },
  { metric: 'buybacks', tags: ['PaymentsForRepurchaseOfCommonStock'] },
  { metric: 'dividends_paid', tags: ['PaymentsOfDividendsCommonStock', 'PaymentsOfDividends'] },
  { metric: 'shares_diluted', tags: ['WeightedAverageNumberOfDilutedSharesOutstanding'], unit: 'shares', q: true },
  { metric: 'eps_diluted', tags: ['EarningsPerShareDiluted'], unit: 'USD-per-shares', q: true },
  { metric: 'total_assets', tags: ['Assets'], instant: true, q: true },
  { metric: 'current_assets', tags: ['AssetsCurrent'], instant: true },
  { metric: 'total_liabilities', tags: ['Liabilities'], instant: true, q: true },
  { metric: 'liabilities_and_equity', tags: ['LiabilitiesAndStockholdersEquity'], instant: true },
  { metric: 'current_liabilities', tags: ['LiabilitiesCurrent'], instant: true },
  { metric: 'long_term_debt', tags: ['LongTermDebtNoncurrent', 'LongTermDebt'], instant: true, q: true },
  { metric: 'stockholders_equity', tags: ['StockholdersEquity', 'StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest'], instant: true, q: true },
  { metric: 'retained_earnings', tags: ['RetainedEarningsAccumulatedDeficit'], instant: true },
  { metric: 'cash', tags: ['CashAndCashEquivalentsAtCarryingValue'], instant: true, q: true },
  { metric: 'receivables', tags: ['AccountsReceivableNetCurrent'], instant: true },
  { metric: 'inventory', tags: ['InventoryNet'], instant: true },
  { metric: 'ppe_net', tags: ['PropertyPlantAndEquipmentNet'], instant: true },
];
const METRIC_NAMES = METRICS.map((m) => m.metric);
const QUARTERLY_METRICS = METRICS.filter((m) => m.q).map((m) => m.metric);

const FRED_SERIES = [
  { id: 'DGS10', title: '10-Year Treasury Constant Maturity Rate', units: 'percent', frequency: 'daily' },
  { id: 'DGS2', title: '2-Year Treasury Constant Maturity Rate', units: 'percent', frequency: 'daily' },
  { id: 'DGS3MO', title: '3-Month Treasury Constant Maturity Rate', units: 'percent', frequency: 'daily' },
  { id: 'FEDFUNDS', title: 'Effective Federal Funds Rate', units: 'percent', frequency: 'monthly' },
  { id: 'CPIAUCSL', title: 'Consumer Price Index for All Urban Consumers (index 1982-84=100, seasonally adjusted)', units: 'index', frequency: 'monthly' },
  { id: 'UNRATE', title: 'Unemployment Rate', units: 'percent', frequency: 'monthly' },
  { id: 'BAA10Y', title: "Moody's Baa corporate bond yield minus 10-year Treasury (credit spread)", units: 'percent', frequency: 'daily' },
  { id: 'T10YIE', title: '10-Year breakeven inflation rate (market-implied inflation expectation)', units: 'percent', frequency: 'daily' },
  { id: 'VIXCLS', title: 'CBOE Volatility Index (VIX), close', units: 'index', frequency: 'daily' },
  { id: 'DCOILWTICO', title: 'Crude oil price, West Texas Intermediate', units: 'USD per barrel', frequency: 'daily' },
  { id: 'DTWEXBGS', title: 'Nominal broad U.S. dollar index', units: 'index Jan 2006=100', frequency: 'daily' },
  { id: 'GDPC1', title: 'Real gross domestic product (chained 2017 dollars, seasonally adjusted annual rate)', units: 'billions of chained 2017 USD', frequency: 'quarterly' },
  { id: 'MORTGAGE30US', title: '30-year fixed mortgage average rate', units: 'percent', frequency: 'weekly' },
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
  value REAL NOT NULL,
  unit TEXT NOT NULL,
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
  value REAL NOT NULL,
  period_end TEXT,
  PRIMARY KEY (cik, calendar_year, quarter, metric)
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
`;

// ---------- parsers (pure, tested against fixtures) ----------

function parseCompanyTickers(json) {
  // {"0":{"cik_str":320193,"ticker":"AAPL","title":"Apple Inc."}, ...}
  const seen = new Map();
  for (const row of Object.values(json || {})) {
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
    if (Number.isFinite(n)) out.push({ obs_date: cols[dateIdx], value: n });
  }
  return out;
}

// ---------- build ----------

async function buildDatabase({ outPath, secUserAgent, log = console.log, fetchers, delayMs = 150 } = {}) {
  const f = fetchers || http;
  const tmp = `${outPath}.building`;
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  for (const sfx of ['', '-wal', '-shm']) if (fs.existsSync(tmp + sfx)) fs.rmSync(tmp + sfx);
  const db = new DatabaseSync(tmp);
  db.exec(SCHEMA);
  const now = new Date().toISOString();
  const source = db.prepare('INSERT OR REPLACE INTO data_sources VALUES (?,?,?,?,?,?,?)');
  const thisYear = new Date().getUTCFullYear();
  const errors = [];
  const pause = () => (delayMs ? http.sleep(delayMs) : null);

  // --- SEC EDGAR ---
  if (!secUserAgent) {
    const msg = 'SEC_USER_AGENT is not set; SEC requires a descriptive User-Agent with contact info, so EDGAR tables were skipped.';
    errors.push(msg);
    log(`! ${msg}`);
    for (const t of ['companies', 'financials', 'financials_quarterly']) source.run(t, 'SEC EDGAR', 'https://www.sec.gov/', null, 0, 'skipped', msg);
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
    async function loadFrames(periods, metrics, insert) {
      let total = 0;
      for (const p of periods) {
        for (const m of metrics) {
          for (const tag of m.tags) {
            const period = m.instant ? p.instant : p.duration;
            const url = `https://data.sec.gov/api/xbrl/frames/us-gaap/${tag}/${m.unit || 'USD'}/${period}.json`;
            try {
              const rows = parseFrame(await f.getJson(url, ua));
              db.exec('BEGIN');
              for (const r of rows) total += insert(p, m, r, tag);
              db.exec('COMMIT');
              if (rows.length) log(`· ${period} ${tag}: ${rows.length}`);
            } catch (e) {
              try { db.exec('ROLLBACK'); } catch {}
              errors.push(`${tag} ${period}: ${e.message}`);
              log(`! ${tag} ${period}: ${e.message}`);
            }
            await pause(); // stay well under SEC's 10 requests/second limit
          }
        }
      }
      return total;
    }

    const insF = db.prepare('INSERT OR IGNORE INTO financials VALUES (?,?,?,?,?,?,?,?)');
    const annualPeriods = [];
    for (let year = FIRST_YEAR; year < thisYear; year++) annualPeriods.push({ year, duration: `CY${year}`, instant: `CY${year}Q4I` });
    const total = await loadFrames(annualPeriods, METRICS,
      (p, m, r, tag) => Number(insF.run(r.cik, p.year, m.metric, r.value, m.unit || 'USD', r.end, tag, r.accession).changes));
    source.run('financials', 'SEC EDGAR XBRL frames', 'https://data.sec.gov/api/xbrl/frames/', now, total, total ? 'ok' : 'error',
      'Annual values as filed in 10-K/10-Q XBRL. Periods are calendar-aligned frames (CY2024 = the ~365-day period closest to calendar 2024), not fiscal years. Balance-sheet metrics are year-end (Q4 instant) values. Where a company uses several tags for one concept, the most specific standard tag wins.');

    // Quarters that ended at least ~50 days ago (time for 10-Qs to be filed).
    const insQ = db.prepare('INSERT OR IGNORE INTO financials_quarterly VALUES (?,?,?,?,?,?)');
    const cutoff = Date.now() - 50 * 86400000;
    const quarterPeriods = [];
    for (let year = FIRST_YEAR; year <= thisYear; year++) {
      for (let q = 1; q <= 4; q++) {
        if (Date.UTC(year, q * 3, 0) > cutoff) continue; // last day of the quarter
        quarterPeriods.push({ year, q, duration: `CY${year}Q${q}`, instant: `CY${year}Q${q}I` });
      }
    }
    const qTotal = await loadFrames(quarterPeriods, METRICS.filter((m) => m.q),
      (p, m, r) => Number(insQ.run(r.cik, p.year, p.q, m.metric, r.value, r.end).changes));
    source.run('financials_quarterly', 'SEC EDGAR XBRL frames', 'https://data.sec.gov/api/xbrl/frames/', now, qTotal, qTotal ? 'ok' : 'error',
      'Quarterly values for core metrics, calendar-aligned (CY2024Q1 = the ~91-day period closest to Jan–Mar 2024). Q4 income and cash-flow figures are often missing because many companies only report the full year in the 10-K; Q4 can be derived as annual minus Q1–Q3. Balance-sheet metrics are quarter-end snapshots.');
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
      await pause();
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
    await pause();
  }
  source.run('econ_observations', 'Federal Reserve Bank of St. Louis — FRED', 'https://fred.stlouisfed.org/', now, obs, obs ? 'ok' : 'error',
    `Series: ${FRED_SERIES.map((s) => s.id).join(', ')}. Daily series skip weekends and market holidays; missing days are absent rather than null.`);

  // Never swap a good dataset for a worse one (e.g. SEC or FRED was down during a refresh).
  const shrunk = compareWithPrevious(db, outPath);
  if (shrunk.length) {
    db.close();
    for (const sfx of ['', '-wal', '-shm']) if (fs.existsSync(tmp + sfx)) fs.rmSync(tmp + sfx);
    const msg = `Kept the previous dataset: the new build was incomplete (${shrunk.join(', ')}).`;
    log(`! ${msg}`);
    return { errors: [...errors, msg], kept: true };
  }

  db.exec('PRAGMA journal_mode = WAL');
  db.close();
  for (const sfx of ['-wal', '-shm']) if (fs.existsSync(outPath + sfx)) fs.rmSync(outPath + sfx);
  fs.renameSync(tmp, outPath);
  for (const sfx of ['-wal', '-shm']) if (fs.existsSync(tmp + sfx)) fs.rmSync(tmp + sfx);
  return { errors };
}

// Tables whose row count fell below half of the previous build's.
function compareWithPrevious(db, oldPath) {
  if (!fs.existsSync(oldPath)) return [];
  const shrunk = [];
  try {
    db.exec(`ATTACH DATABASE '${oldPath.replace(/'/g, "''")}' AS prev`);
    for (const t of ['companies', 'financials', 'financials_quarterly', 'fx_rates', 'econ_observations']) {
      const had = db.prepare("SELECT 1 FROM prev.sqlite_master WHERE type = 'table' AND name = ?").get(t);
      if (!had) continue;
      const before = Number(db.prepare(`SELECT COUNT(*) n FROM prev.${t}`).get().n);
      const after = Number(db.prepare(`SELECT COUNT(*) n FROM main.${t}`).get().n);
      if (before > 0 && after < before * 0.5) shrunk.push(`${t}: ${after.toLocaleString('en-US')} rows vs ${before.toLocaleString('en-US')} before`);
    }
    db.exec('DETACH DATABASE prev');
  } catch { try { db.exec('DETACH DATABASE prev'); } catch {} }
  return shrunk;
}

// Tables the current app version expects in finance.db; an older dataset missing any is rebuilt.
const REQUIRED_TABLES = ['companies', 'financials', 'financials_quarterly', 'fx_rates', 'econ_series', 'econ_observations', 'data_sources'];

module.exports = {
  buildDatabase, parseCompanyTickers, parseFrame, parseTreasuryRates, parseFredCsv,
  SCHEMA, METRICS, METRIC_NAMES, QUARTERLY_METRICS, FRED_SERIES, REQUIRED_TABLES, FIRST_YEAR,
};
