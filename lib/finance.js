'use strict';
// Access to the read-only finance data: query execution and schema description.
const path = require('node:path');
const fs = require('node:fs');
const { Worker } = require('node:worker_threads');
const { checkSql } = require('./sqlguard');
const { openQueryConnection } = require('./connect');

const WORKER = path.join(__dirname, 'query-worker.js');
const QUERY_TIMEOUT_MS = Number(process.env.QUERY_TIMEOUT_MS || 8000);

const RATIO_NOTE = 'Fraction, not percent (0.15 = 15%).';
const PCT_NOTE = 'Percentile rank among peers in the same year, 0 = lowest, 1 = highest. NULL when fewer than 5 peers report the metric.';

// Plain-language notes the model and the Data Sources page both use.
// Tables marked hidden: true are internal and not described to the model.
const COLUMN_NOTES = {
  annual_financials: {
    _: 'START HERE for company fundamentals. One row per company and calendar year with every metric, sector, industry and a link to the filing. Values in USD as reported (not thousands) unless noted. NULL = not reported. Balance-sheet items are year-end snapshots; income and cash-flow items cover the year.',
    calendar_year: 'Calendar-aligned period (SEC CY frame), NOT fiscal year. Compare with fiscal_year_end to flag mismatches.',
    sector: 'Broad SEC SIC division, e.g. Manufacturing; Services; Finance, Insurance & Real Estate. NULL until the company profile has loaded.',
    industry: "SEC SIC description, e.g. 'Services-Prepackaged Software', 'National Commercial Banks', 'Pharmaceutical Preparations'",
    sic: '4-digit SIC code (6000–6799 = financial companies)',
    fiscal_year_end: "Fiscal year-end as MM-DD, e.g. '09-30'",
    shares_diluted: 'Weighted-average diluted shares (count, not USD)',
    eps_diluted: 'Diluted earnings per share (USD per share)',
    capex: 'Cash paid for property and equipment (positive number = spending)',
    buybacks: 'Cash paid to repurchase common stock (positive number)',
    dividends_paid: 'Cash dividends paid (positive number)',
    total_liabilities: 'Reported total liabilities; where not reported, liabilities_and_equity minus stockholders_equity',
    accession: 'SEC accession number of the filing the revenue figure came from',
    filing_url: 'Link to that filing on sec.gov — include it in company-level results so readers can check the source',
  },
  quarterly_financials: {
    _: 'One row per company and calendar quarter with core metrics. Q4 income and cash-flow values are often NULL because companies report only the full year in the 10-K; derive Q4 as annual minus Q1–Q3 (say so as an assumption).',
    quarter: '1–4 (Q1 = Jan–Mar), calendar-aligned',
  },
  company_ratios: {
    _: 'Derived ratios per company and calendar year, plus percentile ranks against industry (same SIC) and sector peers. Ratios are fractions (0.15 = 15%).',
    gross_margin: RATIO_NOTE, operating_margin: RATIO_NOTE, net_margin: RATIO_NOTE,
    revenue_growth: `Year-over-year revenue growth. ${RATIO_NOTE}`,
    net_income_growth: `Year-over-year net income growth, only when prior-year net income was positive. ${RATIO_NOTE}`,
    free_cash_flow: 'Operating cash flow minus capex, USD',
    fcf_margin: `Free cash flow ÷ revenue. ${RATIO_NOTE}`,
    interest_coverage: 'Operating income ÷ interest expense (times). Below ~2 is thin.',
    current_ratio: 'Current assets ÷ current liabilities',
    debt_to_equity: 'Long-term debt ÷ equity; NULL when equity ≤ 0',
    liabilities_to_assets: RATIO_NOTE,
    roa: `Net income ÷ year-end total assets. ${RATIO_NOTE}`,
    roe: `Net income ÷ year-end equity; NULL when equity ≤ 0. ${RATIO_NOTE}`,
    rd_intensity: `R&D ÷ revenue. ${RATIO_NOTE}`, capex_intensity: `Capex ÷ revenue. ${RATIO_NOTE}`,
    cash_to_assets: RATIO_NOTE, asset_turnover: 'Revenue ÷ total assets (times)',
    payout_ratio: `(Dividends + buybacks) ÷ net income, when net income > 0. ${RATIO_NOTE}`,
    share_count_change: `Year-over-year change in diluted shares; positive = dilution. ${RATIO_NOTE}`,
    cash_runway_years: 'Only for companies with negative free cash flow: cash ÷ annual cash burn (years)',
    industry_peer_count: 'Companies in the same SIC industry that year', sector_peer_count: 'Companies in the same sector that year',
  },
  company_scores: {
    _: 'Well-known quality and risk scores per company and calendar year, computed from annual_financials (current vs prior year). Altman and Beneish are NULL for financial companies (SIC 6000–6799), where they do not apply.',
    piotroski_f: 'Piotroski F-score 0–9 (higher = stronger fundamentals; 8–9 strong, 0–2 weak). Uses year-end assets. NULL when fewer than 8 of 9 tests have data.',
    piotroski_available: 'How many of the 9 Piotroski tests had data',
    altman_z: "Altman Z''-score (1995 four-variable version for non-manufacturers; uses book equity, so no market price needed)",
    altman_zone: "'safe' (> 2.6), 'grey' (1.1–2.6) or 'distress' (< 1.1)",
    beneish_m: 'Beneish M-score (8-variable). Above -1.78 suggests elevated risk of earnings manipulation — a screen, not proof.',
    beneish_flag: '1 when beneish_m > -1.78',
    beneish_imputed: 'How many of the 6 optional Beneish ratios were missing and set to the neutral value 1 (more = less reliable)',
  },
  company_profiles: {
    _: 'SEC company profile (from submissions). Filled in the background; LEFT JOIN and expect NULLs for companies not loaded yet.',
    state_of_incorporation: 'Two-letter state or country code',
    fetched_at: 'When this profile was fetched',
  },
  filing_events: {
    _: '8-K current reports since 2018, one row per item. Use red_flag = 1 to find restatements, auditor changes, impairments, bankruptcy, delisting notices, cybersecurity incidents and accelerated debt. Covers the most recent ~1,000 filings per company.',
    item: "8-K item number, e.g. '4.02' (non-reliance/restatement), '4.01' (auditor change), '5.02' (officer/director change), '2.06' (impairment), '1.03' (bankruptcy), '2.02' (earnings release)",
    red_flag: '1 for items analysts treat as warning signs (1.03, 1.05, 2.04, 2.06, 3.01, 4.01, 4.02)',
    filing_url: 'Link to the filing document on sec.gov',
  },
  insider_trades: {
    _: 'Open-market insider purchases (trans_code P) and sales (S) from SEC Form 4, last ~8 published quarters. Grants, option exercises and gifts are excluded. Several insiders buying around the same time ("cluster buying") is the classic signal.',
    issuer_cik: 'Joins to annual_financials.cik', ticker: 'Ticker as reported on the Form 4',
    owner_relationship: "e.g. 'Director', 'Officer', 'TenPercentOwner' (may list several)",
    trans_code: "'P' = open-market purchase, 'S' = open-market sale",
    acquired_disposed: "'A' acquired, 'D' disposed",
    value_usd: 'shares × price', shares_owned_after: 'Shares held after the transaction',
  },
  fund_holdings: {
    _: "Common-stock positions of the ~150 largest institutional managers (SEC Form 13F), two most recent report periods. 13F has no CIK or ticker for the security: match to companies by issuer_name (e.g. UPPER(issuer_name) LIKE UPPER(name) || '%') and say so as an assumption.",
    report_period: 'Quarter-end the holdings are as of (YYYY-MM-DD)', value_usd: 'Market value in USD at the report date',
    cusip: '9-character security identifier',
  },
  fund_position_changes: {
    _: 'Change in each manager\'s position between the two most recent 13F report periods.',
    change_type: "'new', 'added', 'reduced', 'exited' or 'unchanged'",
  },
  prices: {
    _: 'Latest stock quote from Finnhub for the largest ~1,000 companies by revenue, refreshed daily. Returns and 52-week fields come from Finnhub and may be NULL depending on plan.',
    return_52w_pct: 'Percent, not fraction (12.5 = 12.5%)', return_13w_pct: 'Percent', return_26w_pct: 'Percent',
    dividend_yield_pct: 'Percent', market_cap_finnhub: 'Finnhub market cap in USD',
  },
  price_history: { _: 'Daily close per company, appended on every refresh since prices were enabled — history grows over time.' },
  valuation: {
    _: 'Live view: latest price joined with each company\'s latest annual fundamentals. market_cap = price × diluted shares; ratios are NULL when the denominator is ≤ 0. Yields are fractions (0.05 = 5%); return fields are percents.',
    fundamentals_year: 'Calendar year of the fundamentals used',
  },
  companies: { _: 'SEC-registered public companies with a ticker. Prefer annual_financials, which already includes ticker and name.' },
  financials: { _: 'Long-format source for annual_financials (one row per company, year and metric). Prefer annual_financials.' },
  financials_quarterly: { _: 'Long-format source for quarterly_financials. Prefer quarterly_financials.' },
  fx_rates: {
    _: 'Treasury Reporting Rates of Exchange — official quarterly rates. Usually one row per currency per quarter-end, plus occasional mid-quarter amendments.',
    record_date: 'Date the rate applies from (YYYY-MM-DD), usually a quarter-end',
    country_currency: "Treasury label, e.g. 'Euro Zone-Euro', 'Japan-Yen', 'United Kingdom-Pound', 'Canada-Dollar'",
    units_per_usd: 'Units of foreign currency per 1 USD (to convert foreign → USD, divide by this)',
  },
  econ_series: { _: 'Catalog of FRED series in econ_observations, with titles and units.' },
  econ_observations: {
    _: 'FRED observations, long format. Daily series skip weekends and holidays (no rows on those days).',
    series_id: 'DGS10, DGS2, DGS3MO (Treasury yields %); FEDFUNDS (%); CPIAUCSL (CPI index); UNRATE (%); BAA10Y (Baa credit spread over 10y Treasury, %); T10YIE (10y breakeven inflation, %); VIXCLS (VIX); DCOILWTICO (WTI oil $/bbl); DTWEXBGS (broad dollar index); GDPC1 (real GDP, quarterly, $bn); MORTGAGE30US (30y mortgage rate %, weekly)',
    obs_date: 'Observation date (YYYY-MM-DD); monthly series use the first of the month',
  },
  data_sources: { hidden: true }, profiles_meta: { hidden: true }, ownership_meta: { hidden: true }, market_meta: { hidden: true },
};
for (const t of ['company_ratios', 'company_scores']) COLUMN_NOTES[t].filing_url = 'Link to the source filing on sec.gov';
for (const m of ['operating_margin', 'net_margin', 'revenue_growth', 'fcf_margin', 'roe', 'debt_to_equity']) {
  COLUMN_NOTES.company_ratios[`${m}_pctile_industry`] = PCT_NOTE;
  COLUMN_NOTES.company_ratios[`${m}_pctile_sector`] = PCT_NOTE;
}

// Order tables are presented in (most useful first).
const ORDER = ['annual_financials', 'company_ratios', 'company_scores', 'valuation', 'quarterly_financials', 'filing_events', 'insider_trades',
  'fund_position_changes', 'fund_holdings', 'prices', 'price_history', 'econ_observations', 'econ_series', 'fx_rates', 'company_profiles',
  'companies', 'financials', 'financials_quarterly'];

function createFinance(dbPath) {
  let schemaCache = null;

  function exists() { return fs.existsSync(dbPath); }

  function runInWorker(sql, { maxRows = 500, validateOnly = false, timeoutMs = QUERY_TIMEOUT_MS } = {}) {
    return new Promise((resolve) => {
      const w = new Worker(WORKER, { workerData: { dbPath, sql, maxRows, validateOnly } });
      const timer = setTimeout(() => {
        w.terminate();
        resolve({ ok: false, error: `Query stopped after ${timeoutMs / 1000}s. Try narrowing it with filters or a smaller date range.`, timeout: true });
      }, timeoutMs);
      w.once('message', (m) => { clearTimeout(timer); w.terminate(); resolve(m); });
      w.once('error', (e) => { clearTimeout(timer); resolve({ ok: false, error: String(e.message || e) }); });
    });
  }

  async function run(sql, opts) {
    const guard = checkSql(sql);
    if (!guard.ok) return { ok: false, error: guard.reason, blocked: true };
    if (!exists()) return { ok: false, error: 'The finance dataset is still loading.' };
    return runInWorker(guard.sql, opts);
  }

  function readMeta(db, schema, table) {
    try { return Object.fromEntries(db.prepare(`SELECT key, value FROM ${schema}.${table}`).all().map((r) => [r.key, r.value])); } catch { return {}; }
  }

  function describe() {
    if (schemaCache) return schemaCache;
    if (!exists()) return null;
    const { db, attached } = openQueryConnection(dbPath);
    try {
      const schemas = ['main', ...attached, 'temp'];
      const objects = [];
      for (const s of schemas) {
        const master = s === 'temp' ? 'sqlite_temp_master' : `${s}.sqlite_master`;
        for (const o of db.prepare(`SELECT name, type FROM ${master} WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%'`).all()) {
          if ((COLUMN_NOTES[o.name] || {}).hidden) continue;
          objects.push({ ...o, schema: s });
        }
      }
      objects.sort((a, b) => ((ORDER.indexOf(a.name) + 1 || 99) - (ORDER.indexOf(b.name) + 1 || 99)));
      const sources = Object.fromEntries(db.prepare('SELECT * FROM main.data_sources').all().map((s) => [s.table_name, s]));
      const prof = readMeta(db, 'profiles', 'profiles_meta');
      const own = readMeta(db, 'ownership', 'ownership_meta');
      const mkt = readMeta(db, 'market', 'market_meta');
      const derivedSrc = { source: 'Derived by Nexus from SEC data', url: '', status: 'ok', notes: 'Rebuilt after every data load. See column notes for formulas.' };
      const sideSrc = {
        company_profiles: { source: 'SEC EDGAR submissions', url: 'https://data.sec.gov/submissions/', status: prof.status || 'filling', retrieved_at: prof.updated_at },
        filing_events: { source: 'SEC EDGAR submissions (8-K items)', url: 'https://data.sec.gov/submissions/', status: prof.status || 'filling', retrieved_at: prof.updated_at },
        insider_trades: { source: 'SEC Insider Transactions Data Sets (Form 4)', url: 'https://www.sec.gov/dera/data/form-345', status: own.status || 'pending', retrieved_at: own.updated_at },
        fund_holdings: { source: 'SEC Form 13F Data Sets', url: 'https://www.sec.gov/dera/data/form-13f', status: own.status || 'pending', retrieved_at: own.updated_at },
        fund_position_changes: { source: 'Derived from SEC Form 13F Data Sets', url: 'https://www.sec.gov/dera/data/form-13f', status: own.status || 'pending', retrieved_at: own.updated_at },
        prices: { source: 'Finnhub', url: 'https://finnhub.io/', status: mkt.status || 'pending', retrieved_at: mkt.completed_at },
        price_history: { source: 'Finnhub (daily snapshots)', url: 'https://finnhub.io/', status: mkt.status || 'pending', retrieved_at: mkt.completed_at },
        valuation: { source: 'Finnhub prices + SEC fundamentals', url: '', status: mkt.status || 'pending', retrieved_at: mkt.completed_at },
      };
      const tables = objects.map((o) => {
        const notes = COLUMN_NOTES[o.name] || {};
        const q = o.schema === 'main' ? `"${o.name}"` : `${o.schema}."${o.name}"`;
        const cols = db.prepare(`SELECT name, type FROM pragma_table_info(?, ?)`).all(o.name, o.schema).map((c) => ({ name: c.name, type: c.type || 'ANY', note: notes[c.name] || null }));
        let count = 0;
        try { count = Number(db.prepare(`SELECT COUNT(*) AS n FROM ${q}`).get().n); } catch {}
        let sample = [];
        try { sample = db.prepare(`SELECT * FROM ${q} LIMIT 1`).all(); } catch {}
        const src = sources[o.name] || sideSrc[o.name]
          || ({ econ_series: sources.econ_observations })[o.name]
          || (['annual_financials', 'quarterly_financials', 'company_ratios', 'company_scores'].includes(o.name) ? { ...derivedSrc, retrieved_at: (sources.financials || {}).retrieved_at } : null);
        return { name: o.name, kind: o.type, description: notes._ || null, columns: cols, rowCount: count, sample, source: src };
      });
      const facts = {};
      const tryGet = (fn) => { try { return fn(); } catch { return null; } };
      const fy = tryGet(() => db.prepare('SELECT MIN(calendar_year) lo, MAX(calendar_year) hi FROM annual_financials WHERE revenue IS NOT NULL').get());
      if (fy && fy.lo) facts.financials_years = `${fy.lo}–${fy.hi}`;
      const fq = tryGet(() => db.prepare('SELECT MIN(calendar_year * 10 + quarter) lo, MAX(calendar_year * 10 + quarter) hi FROM quarterly_financials').get());
      if (fq && fq.lo) facts.quarter_range = `${Math.floor(fq.lo / 10)}Q${fq.lo % 10} to ${Math.floor(fq.hi / 10)}Q${fq.hi % 10}`;
      const fx = tryGet(() => db.prepare('SELECT MIN(record_date) lo, MAX(record_date) hi FROM fx_rates').get());
      if (fx && fx.lo) facts.fx_dates = `${fx.lo} to ${fx.hi}`;
      facts.econ_ranges = (tryGet(() => db.prepare('SELECT series_id, MIN(obs_date) lo, MAX(obs_date) hi FROM econ_observations GROUP BY series_id').all()) || [])
        .map((r) => `${r.series_id}: ${r.lo} to ${r.hi}`).join('; ');
      const sec = tryGet(() => db.prepare('SELECT sector, COUNT(*) n FROM company_profiles WHERE sector IS NOT NULL GROUP BY sector ORDER BY n DESC').all()) || [];
      if (sec.length) facts.sectors = sec.map((r) => `${r.sector} (${r.n})`).join('; ');
      const ins = tryGet(() => db.prepare('SELECT MIN(trans_date) lo, MAX(trans_date) hi FROM insider_trades').get());
      if (ins && ins.lo) facts.insider_range = `${ins.lo} to ${ins.hi}`;
      const per = tryGet(() => db.prepare('SELECT GROUP_CONCAT(report_period) p FROM (SELECT DISTINCT report_period FROM fund_holdings ORDER BY 1)').get());
      if (per && per.p) facts.fund_periods = per.p;
      const px = tryGet(() => db.prepare('SELECT MAX(as_of) d, COUNT(*) n FROM prices').get());
      if (px && px.n) facts.prices = `${px.n} companies, as of ${px.d}`;
      facts.major_currencies = (tryGet(() => db.prepare("SELECT DISTINCT country_currency FROM fx_rates WHERE country_currency IN ('Euro Zone-Euro','Japan-Yen','United Kingdom-Pound','Canada-Dollar','Switzerland-Franc','China-Renminbi','India-Rupee','Mexico-Peso','Australia-Dollar') ORDER BY 1").all()) || []).map((r) => r.country_currency).join(', ');
      schemaCache = { tables, facts };
      return schemaCache;
    } finally { db.close(); }
  }

  // Compact text version for the model prompt. Wide tables skip the sample row to save tokens.
  function promptSchema() {
    const d = describe();
    if (!d) return '';
    const parts = d.tables.map((t) => {
      const head = `${t.kind.toUpperCase()} ${t.name}  -- ${t.rowCount.toLocaleString('en-US')} rows${t.description ? `. ${t.description}` : ''}`;
      const cols = t.columns.map((c) => `  ${c.name} ${c.type}${c.note ? `  -- ${c.note}` : ''}`).join('\n');
      const sample = t.sample.length && t.columns.length <= 14 ? `\n  sample: ${JSON.stringify(t.sample[0])}` : '';
      return `${head}\n${cols}${sample}`;
    });
    const f = d.facts;
    parts.push(`DATA RANGES: annual ${f.financials_years || 'n/a'}; quarterly ${f.quarter_range || 'n/a'}; fx_rates ${f.fx_dates || 'n/a'}; insider_trades ${f.insider_range || 'not loaded yet'}; fund_holdings periods ${f.fund_periods || 'not loaded yet'}; prices ${f.prices || 'not loaded (FINNHUB_API_KEY not set or still loading)'}; ${f.econ_ranges || ''}`);
    parts.push(f.sectors ? `EXACT sector values (companies classified so far): ${f.sectors}` : 'Sectors are not loaded yet — if a request needs sectors, say so as a "risk" assumption.');
    if (f.major_currencies) parts.push(`EXACT fx_rates.country_currency labels for major currencies: ${f.major_currencies}`);
    return parts.join('\n\n');
  }

  function invalidate() { schemaCache = null; }

  return { run, describe, promptSchema, exists, invalidate, dbPath };
}

module.exports = { createFinance, COLUMN_NOTES };
