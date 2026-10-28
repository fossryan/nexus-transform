'use strict';
// Access to the read-only finance database: query execution and schema description.
const path = require('node:path');
const fs = require('node:fs');
const { Worker } = require('node:worker_threads');
const { DatabaseSync } = require('node:sqlite');
const { checkSql } = require('./sqlguard');

const WORKER = path.join(__dirname, 'query-worker.js');

// Plain-language notes the model and the Data Sources page both use.
const COLUMN_NOTES = {
  companies: {
    _: 'SEC-registered public companies with a ticker.',
    cik: 'SEC Central Index Key; joins to financials.cik',
    ticker: 'Primary ticker symbol, uppercase',
    name: 'Company name as registered with the SEC',
  },
  financials: {
    _: 'Long format: one row per company, calendar year and metric. Values in USD as reported in XBRL filings.',
    cik: 'Joins to companies.cik',
    calendar_year: 'Calendar-aligned period (CY frame), NOT fiscal year. A company with a June fiscal year-end is mapped to the calendar year its 12-month period overlaps most.',
    metric: "One of: revenue, operating_income, net_income, total_assets, total_liabilities, stockholders_equity, cash",
    value_usd: 'Reported value in US dollars (not thousands). Income items cover the year; balance-sheet items are year-end snapshots.',
    period_end: 'Period end date from the filing (YYYY-MM-DD)',
    source_tag: 'us-gaap XBRL tag the value came from',
    accession: 'SEC filing accession number',
  },
  annual_financials: {
    _: 'View: financials pivoted wide, one row per company and calendar year, with ticker and name joined in. Prefer this for most questions. Metrics a company did not report are NULL.',
  },
  fx_rates: {
    _: 'Treasury Reporting Rates of Exchange — official quarterly rates. Usually one row per currency per quarter-end, plus occasional mid-quarter amendments.',
    record_date: 'Date the rate applies from (YYYY-MM-DD), usually a quarter-end',
    country_currency: "Treasury label, e.g. 'Euro Zone-Euro', 'Japan-Yen', 'United Kingdom-Pound', 'Canada-Dollar'",
    country: 'Country or zone',
    currency: 'Currency name',
    units_per_usd: 'Units of foreign currency per 1 USD (to convert foreign → USD, divide by this)',
  },
  econ_series: {
    _: 'Catalog of FRED series available in econ_observations.',
  },
  econ_observations: {
    _: 'FRED observations, long format. Daily series skip weekends and market holidays (no rows on those days).',
    series_id: 'DGS10, DGS2, DGS3MO (Treasury yields, percent, daily); FEDFUNDS (percent, monthly); CPIAUCSL (index, monthly); UNRATE (percent, monthly)',
    obs_date: 'Observation date (YYYY-MM-DD); monthly series use the first of the month',
    value: 'Observation value in the series units',
  },
  data_sources: { _: 'Provenance for each table: source, URL, retrieval time, row count.' },
};

function createFinance(dbPath) {
  let schemaCache = null;

  function exists() { return fs.existsSync(dbPath); }

  function runInWorker(sql, { maxRows = 500, validateOnly = false, timeoutMs = 4000 } = {}) {
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

  function describe() {
    if (schemaCache) return schemaCache;
    if (!exists()) return null;
    const db = new DatabaseSync(dbPath, { readOnly: true });
    const objects = db.prepare("SELECT name, type, sql FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY type, name").all();
    const sources = Object.fromEntries(db.prepare('SELECT * FROM data_sources').all().map((s) => [s.table_name, s]));
    const tables = objects.map((o) => {
      const cols = db.prepare(`PRAGMA table_info("${o.name}")`).all().map((c) => ({
        name: c.name, type: c.type || 'ANY', note: (COLUMN_NOTES[o.name] || {})[c.name] || null,
      }));
      const count = Number(db.prepare(`SELECT COUNT(*) AS n FROM "${o.name}"`).get().n);
      const sample = db.prepare(`SELECT * FROM "${o.name}" LIMIT 3`).all();
      const src = sources[o.name] || (o.name === 'annual_financials' ? sources.financials : o.name === 'econ_series' ? sources.econ_observations : null);
      return { name: o.name, kind: o.type, ddl: o.sql, description: (COLUMN_NOTES[o.name] || {})._ || null, columns: cols, rowCount: count, sample, source: src || null };
    });
    // Helpful ranges the model would otherwise guess at.
    const facts = {};
    try {
      const fy = db.prepare('SELECT MIN(calendar_year) lo, MAX(calendar_year) hi FROM financials').get();
      facts.financials_years = `${fy.lo}–${fy.hi}`;
      const fx = db.prepare('SELECT MIN(record_date) lo, MAX(record_date) hi FROM fx_rates').get();
      facts.fx_dates = `${fx.lo} to ${fx.hi}`;
      facts.econ_ranges = db.prepare('SELECT series_id, MIN(obs_date) lo, MAX(obs_date) hi FROM econ_observations GROUP BY series_id').all()
        .map((r) => `${r.series_id}: ${r.lo} to ${r.hi}`).join('; ');
      facts.major_currencies = db.prepare("SELECT DISTINCT country_currency FROM fx_rates WHERE country_currency IN ('Euro Zone-Euro','Japan-Yen','United Kingdom-Pound','Canada-Dollar','Switzerland-Franc','China-Renminbi','India-Rupee','Mexico-Peso','Australia-Dollar') ORDER BY 1").all().map((r) => r.country_currency).join(', ');
    } catch {}
    db.close();
    schemaCache = { tables, facts };
    return schemaCache;
  }

  // Compact text version for the model prompt.
  function promptSchema() {
    const d = describe();
    if (!d) return '';
    const parts = d.tables.filter((t) => t.name !== 'data_sources').map((t) => {
      const head = `${t.kind.toUpperCase()} ${t.name}  -- ${t.rowCount.toLocaleString('en-US')} rows${t.description ? `. ${t.description}` : ''}`;
      const cols = t.columns.map((c) => `  ${c.name} ${c.type}${c.note ? `  -- ${c.note}` : ''}`).join('\n');
      const sample = t.sample.length ? `  sample: ${JSON.stringify(t.sample[0])}` : '';
      return `${head}\n${cols}\n${sample}`;
    });
    const f = d.facts;
    parts.push(`DATA RANGES: financials calendar_year ${f.financials_years || 'n/a'}; fx_rates ${f.fx_dates || 'n/a'}; ${f.econ_ranges || ''}`);
    if (f.major_currencies) parts.push(`EXACT fx_rates.country_currency labels for major currencies: ${f.major_currencies}`);
    return parts.join('\n\n');
  }

  function invalidate() { schemaCache = null; }

  return { run, describe, promptSchema, exists, invalidate, dbPath };
}

module.exports = { createFinance, COLUMN_NOTES };
