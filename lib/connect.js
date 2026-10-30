'use strict';
// Opens the read-only query connection: finance.db plus the side databases (attached
// read-only, so unqualified table names just work) and TEMP convenience views that join
// across them. Used by both the query worker and the schema description.
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { pathToFileURL } = require('node:url');
const { isDiskError } = require('./disk');

const SIDE_DBS = [['profiles', 'profiles.db'], ['ownership', 'ownership.db'], ['market', 'market.db']];

const VALUATION_VIEW = `
CREATE TEMP VIEW valuation AS
WITH latest AS (
  SELECT a.* FROM annual_financials a
  WHERE a.calendar_year = (SELECT MAX(b.calendar_year) FROM annual_financials b WHERE b.cik = a.cik AND b.revenue IS NOT NULL)
), v AS (
  SELECT p.*, l.name, l.sector, l.industry, l.calendar_year AS fundamentals_year,
    l.revenue, l.net_income, l.operating_income, l.eps_diluted, l.stockholders_equity,
    l.operating_cash_flow - COALESCE(l.capex, 0) AS free_cash_flow,
    COALESCE(l.dividends_paid, 0) + COALESCE(l.buybacks, 0) AS shareholder_payouts,
    COALESCE(l.long_term_debt, 0) AS debt, COALESCE(l.cash, 0) AS cash,
    p.price * l.shares_diluted AS market_cap
  FROM prices p JOIN latest l ON l.cik = p.cik
)
SELECT
  cik, ticker, name, sector, industry, as_of, price, fundamentals_year,
  market_cap,
  market_cap + debt - cash AS enterprise_value,
  CASE WHEN eps_diluted > 0 THEN ROUND(price / eps_diluted, 2) END AS pe_ratio,
  ROUND(market_cap / NULLIF(revenue, 0), 2) AS price_to_sales,
  CASE WHEN stockholders_equity > 0 THEN ROUND(market_cap / stockholders_equity, 2) END AS price_to_book,
  CASE WHEN operating_income > 0 THEN ROUND((market_cap + debt - cash) / operating_income, 2) END AS ev_to_ebit,
  ROUND(free_cash_flow / NULLIF(market_cap, 0), 4) AS fcf_yield,
  ROUND(net_income / NULLIF(market_cap, 0), 4) AS earnings_yield,
  ROUND(shareholder_payouts / NULLIF(market_cap, 0), 4) AS shareholder_yield,
  return_13w_pct, return_26w_pct, return_52w_pct, week52_high, week52_low,
  ROUND(100.0 * (price / NULLIF(week52_high, 0) - 1), 2) AS pct_from_52w_high,
  beta, dividend_yield_pct
FROM v;`;

// SQLite needs to create a small -shm file even to read a WAL database, which fails on a full
// disk. "Immutable" mode reads without creating any files (it skips changes not yet copied
// from the -wal file into the main file, so data can be slightly stale) — used only as a fallback.
const immutableUri = (file) => { const u = pathToFileURL(file); u.searchParams.set('immutable', '1'); return u; };

function attachAll(db, dir, immutable) {
  const attached = [];
  for (const [alias, file] of SIDE_DBS) {
    const p = path.join(dir, file);
    if (!fs.existsSync(p)) continue;
    const target = immutable ? immutableUri(p).href : p;
    db.exec(`ATTACH DATABASE '${target.replace(/'/g, "''")}' AS ${alias}`);
    attached.push(alias);
  }
  return attached;
}

function openQueryConnection(financeDbPath) {
  const dir = path.dirname(financeDbPath);
  let db; let attached;
  try {
    db = new DatabaseSync(financeDbPath, { readOnly: true });
    attached = attachAll(db, dir, false);
  } catch (e) {
    if (!isDiskError(e)) throw e;
    try { db && db.close(); } catch {}
    db = new DatabaseSync(immutableUri(financeDbPath), { readOnly: true });
    attached = attachAll(db, dir, true);
  }
  const hasTable = (schema, name) => !!db.prepare(`SELECT 1 FROM ${schema}.sqlite_master WHERE type = 'table' AND name = ?`).get(name);
  if (attached.includes('market') && hasTable('market', 'prices') && hasTable('main', 'annual_financials')) db.exec(VALUATION_VIEW);
  return { db, attached };
}

module.exports = { openQueryConnection, SIDE_DBS };
