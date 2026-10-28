'use strict';
// market.db — prices from Finnhub for the largest companies (by revenue):
//   prices         latest quote + Finnhub "basic financials" (52-week range, returns, beta)
//   price_history  one close per company per day, appended on every refresh, so return
//                  history builds up over time even on Finnhub's free plan
// Finnhub's free plan allows about 60 requests per minute, so a full refresh of 1,000
// companies takes ~35 minutes and runs in the background once a day.

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const http = require('./http');

const BASE = 'https://finnhub.io/api/v1';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS prices (
  cik INTEGER PRIMARY KEY,
  ticker TEXT NOT NULL,
  as_of TEXT NOT NULL,
  price REAL,
  prev_close REAL,
  change_pct REAL,
  week52_high REAL,
  week52_low REAL,
  return_13w_pct REAL,
  return_26w_pct REAL,
  return_52w_pct REAL,
  beta REAL,
  dividend_yield_pct REAL,
  market_cap_finnhub REAL
);
CREATE TABLE IF NOT EXISTS price_history (
  cik INTEGER NOT NULL,
  date TEXT NOT NULL,
  close REAL NOT NULL,
  PRIMARY KEY (cik, date)
);
CREATE TABLE IF NOT EXISTS market_meta (key TEXT PRIMARY KEY, value TEXT);
`;

function openMarket(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec(SCHEMA);
  return db;
}
function ensureMarketDb(dbPath) { openMarket(dbPath).close(); }

// SEC writes share classes with a dash (BRK-B); Finnhub uses a dot (BRK.B).
const finnhubSymbol = (ticker) => String(ticker).toUpperCase().replace(/-/g, '.');

function lastRun(dbPath) {
  if (!fs.existsSync(dbPath)) return null;
  const db = openMarket(dbPath);
  const r = db.prepare("SELECT value FROM market_meta WHERE key = 'completed_at'").get();
  db.close();
  return r ? r.value : null;
}

async function refreshPrices({ dbPath, financeDbPath, apiKey, maxCompanies = 1000, log = console.log, fetchers, onProgress = () => {}, shouldStop = () => false, delayMs = 1100 } = {}) {
  if (!apiKey || !fs.existsSync(financeDbPath)) return { skipped: true };
  const f = fetchers || http;
  const db = openMarket(dbPath);
  db.exec(`ATTACH DATABASE '${financeDbPath.replace(/'/g, "''")}' AS fin`);
  const universe = db.prepare(`
    SELECT c.cik, c.ticker FROM fin.companies c
    JOIN (SELECT cik, MAX(CASE WHEN metric = 'revenue' THEN value END) AS rev
          FROM fin.financials WHERE calendar_year = (SELECT MAX(calendar_year) FROM fin.financials) GROUP BY cik) r ON r.cik = c.cik
    WHERE r.rev IS NOT NULL ORDER BY r.rev DESC LIMIT ?`).all(maxCompanies);
  db.exec('DETACH DATABASE fin');
  const meta = db.prepare('INSERT OR REPLACE INTO market_meta VALUES (?, ?)');
  const up = db.prepare(`INSERT OR REPLACE INTO prices VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const hist = db.prepare('INSERT OR REPLACE INTO price_history VALUES (?,?,?)');
  const q = (p) => `${BASE}${p}${p.includes('?') ? '&' : '?'}token=${encodeURIComponent(apiKey)}`;
  let metricsAllowed = true;
  let done = 0; let failures = 0; let unknown = 0;
  meta.run('status', 'refreshing');
  log(`· Prices: ${universe.length} companies (Finnhub, ~${Math.round((universe.length * 2 * delayMs) / 60000)} min)`);
  for (const { cik, ticker } of universe) {
    if (shouldStop()) break;
    const sym = finnhubSymbol(ticker);
    try {
      const quote = await f.getJson(q(`/quote?symbol=${encodeURIComponent(sym)}`));
      if (delayMs) await http.sleep(delayMs);
      if (!quote || !quote.c) { unknown++; continue; } // Finnhub returns c=0 for symbols it doesn't cover
      let m = {};
      if (metricsAllowed) {
        try {
          const res = await f.getJson(q(`/stock/metric?symbol=${encodeURIComponent(sym)}&metric=all`));
          m = (res && res.metric) || {};
        } catch (e) {
          if (e.status === 401 || e.status === 403) { metricsAllowed = false; log('· Prices: Finnhub plan does not include basic financials; storing quotes only'); }
          else throw e;
        }
        if (delayMs) await http.sleep(delayMs);
      }
      const asOf = quote.t ? new Date(quote.t * 1000).toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10);
      const val = (k) => (Number.isFinite(Number(m[k])) ? Number(m[k]) : null);
      db.exec('BEGIN');
      up.run(cik, ticker, asOf, quote.c, quote.pc ?? null, quote.dp ?? null,
        val('52WeekHigh'), val('52WeekLow'), val('13WeekPriceReturnDaily'), val('26WeekPriceReturnDaily'), val('52WeekPriceReturnDaily'),
        val('beta'), val('dividendYieldIndicatedAnnual'), val('marketCapitalization') !== null ? val('marketCapitalization') * 1e6 : null);
      hist.run(cik, asOf, quote.c);
      db.exec('COMMIT');
      done++;
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch {}
      failures++;
      if (e.status === 401 || e.status === 403) { log(`! Prices: Finnhub rejected the API key (${e.status})`); break; }
      if (failures >= 25) { log(`! Prices paused after repeated errors: ${e.message}`); break; }
    }
    if ((done + unknown) % 100 === 0) onProgress({ done, total: universe.length });
  }
  const complete = done + unknown + failures >= universe.length;
  meta.run('status', complete ? 'ok' : 'partial');
  if (complete) meta.run('completed_at', new Date().toISOString());
  meta.run('metrics_available', metricsAllowed ? '1' : '0');
  db.close();
  onProgress({ done, total: universe.length });
  log(`· Prices: ${done} updated, ${unknown} not covered by Finnhub, ${failures} errors`);
  return { done, unknown, failures };
}

module.exports = { refreshPrices, ensureMarketDb, finnhubSymbol, lastRun };
