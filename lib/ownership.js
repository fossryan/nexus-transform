'use strict';
// ownership.db — who is buying and selling, from SEC bulk data sets (free, quarterly):
//   insider_trades         open-market purchases (P) and sales (S) by officers, directors and
//                          10% owners, from Forms 4 (Insider Transactions Data Sets)
//   fund_holdings          stock positions of the largest institutional managers (Form 13F)
//   fund_position_changes  per manager and security: new, added, reduced or exited between
//                          the two most recent report periods
// Archives are streamed from disk (lib/zip.js), so memory stays small even for 100 MB files.

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const http = require('./http');
const { entryRows } = require('./zip');

const PREFIXES = ['https://www.sec.gov/files/datastandardsinnovation/data', 'https://www.sec.gov/files/structureddata/data'];
const INSIDER_QUARTERS = 8;
const TOP_MANAGERS = 150;
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

const SCHEMA = `
CREATE TABLE IF NOT EXISTS insider_trades (
  accession TEXT NOT NULL,
  trans_sk TEXT NOT NULL,
  issuer_cik INTEGER,
  ticker TEXT,
  issuer_name TEXT,
  filing_date TEXT,
  trans_date TEXT,
  owner_name TEXT,
  owner_relationship TEXT,
  owner_title TEXT,
  trans_code TEXT,
  acquired_disposed TEXT,
  shares REAL,
  price REAL,
  value_usd REAL,
  shares_owned_after REAL,
  direct_indirect TEXT,
  filing_url TEXT,
  PRIMARY KEY (accession, trans_sk)
);
CREATE INDEX IF NOT EXISTS insider_issuer ON insider_trades(issuer_cik, trans_date);
CREATE INDEX IF NOT EXISTS insider_date ON insider_trades(trans_date, trans_code);
CREATE TABLE IF NOT EXISTS fund_holdings (
  accession TEXT NOT NULL,
  manager_cik INTEGER,
  manager_name TEXT,
  report_period TEXT,
  filing_date TEXT,
  cusip TEXT NOT NULL,
  issuer_name TEXT,
  title_of_class TEXT,
  value_usd REAL,
  shares REAL,
  PRIMARY KEY (accession, cusip)
);
CREATE INDEX IF NOT EXISTS fund_holdings_period ON fund_holdings(report_period, manager_cik);
CREATE INDEX IF NOT EXISTS fund_holdings_cusip ON fund_holdings(cusip, report_period);
CREATE TABLE IF NOT EXISTS ownership_meta (key TEXT PRIMARY KEY, value TEXT);
`;

function isoDate(ddMonYyyy) {
  // "05-JAN-2026" → "2026-01-05"
  const m = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/.exec(String(ddMonYyyy || '').trim());
  if (!m) return null;
  const mon = MONTHS.indexOf(m[2].toLowerCase()) + 1;
  return mon ? `${m[3]}-${String(mon).padStart(2, '0')}-${m[1].padStart(2, '0')}` : null;
}

const num = (v) => (v === null || v === undefined || v === '' ? null : (Number.isFinite(Number(v)) ? Number(v) : null));

function openOwnership(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec(SCHEMA);
  return db;
}
function ensureOwnershipDb(dbPath) { openOwnership(dbPath).close(); }

async function fetchArchive(f, relPath, dest, ua) {
  for (const prefix of PREFIXES) {
    if (await f.download(`${prefix}/${relPath}`, dest, ua)) return `${prefix}/${relPath}`;
  }
  return null;
}

// ---------- insider transactions ----------

function recentQuarters(n, now = new Date()) {
  const out = [];
  let y = now.getUTCFullYear();
  let q = Math.floor(now.getUTCMonth() / 3) + 1;
  for (let i = 0; i < n + 1; i++) { // +1: the current quarter is usually not published yet
    q -= 1; if (q === 0) { q = 4; y -= 1; }
    out.push(`${y}q${q}`);
  }
  return out;
}

async function loadInsiderQuarter(db, file, url, log) {
  const subs = new Map();
  for await (const r of entryRows(file, 'SUBMISSION.tsv')) {
    if (!/^4(\/A)?$/.test(r.DOCUMENT_TYPE || '')) continue;
    subs.set(r.ACCESSION_NUMBER, r);
  }
  const owners = new Map();
  for await (const r of entryRows(file, 'REPORTINGOWNER.tsv')) {
    if (!subs.has(r.ACCESSION_NUMBER) || owners.has(r.ACCESSION_NUMBER)) continue; // first reporting owner
    owners.set(r.ACCESSION_NUMBER, r);
  }
  const ins = db.prepare('INSERT OR IGNORE INTO insider_trades VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
  let n = 0;
  db.exec('BEGIN');
  for await (const t of entryRows(file, 'NONDERIV_TRANS.tsv')) {
    if (t.TRANS_CODE !== 'P' && t.TRANS_CODE !== 'S') continue; // open-market purchases and sales only
    const s = subs.get(t.ACCESSION_NUMBER);
    if (!s) continue;
    const o = owners.get(t.ACCESSION_NUMBER) || {};
    const shares = num(t.TRANS_SHARES);
    const price = num(t.TRANS_PRICEPERSHARE);
    const cik = num(s.ISSUERCIK);
    n += Number(ins.run(
      t.ACCESSION_NUMBER, String(t.NONDERIV_TRANS_SK), cik, (s.ISSUERTRADINGSYMBOL || '').toUpperCase() || null, s.ISSUERNAME,
      isoDate(s.FILING_DATE), isoDate(t.TRANS_DATE), o.RPTOWNERNAME || null, o.RPTOWNER_RELATIONSHIP || null, o.RPTOWNER_TITLE || null,
      t.TRANS_CODE, t.TRANS_ACQUIRED_DISP_CD, shares, price, shares !== null && price !== null ? shares * price : null,
      num(t.SHRS_OWND_FOLWNG_TRANS), t.DIRECT_INDIRECT_OWNERSHIP,
      cik ? `https://www.sec.gov/Archives/edgar/data/${cik}/${String(t.ACCESSION_NUMBER).replace(/-/g, '')}/` : null,
    ).changes);
  }
  db.exec('COMMIT');
  log(`· Insider trades ${path.basename(url)}: ${n} open-market transactions`);
  return n;
}

// ---------- 13F holdings ----------

function lastDayOfMonth(y, m) { return new Date(Date.UTC(y, m + 1, 0)).getUTCDate(); }
// 13F data sets cover three-month filing windows ending Feb, May, Aug, Nov (e.g. 01jun2026-31aug2026).
function recent13fWindows(n, now = new Date()) {
  const out = [];
  let y = now.getUTCFullYear();
  let end = now.getUTCMonth();
  while ((end + 1) % 3 !== 2) { end -= 1; if (end < 0) { end = 11; y -= 1; } } // back to Feb/May/Aug/Nov
  for (let i = 0; i < n; i++) {
    let sm = end - 2; let sy = y;
    if (sm < 0) { sm += 12; sy -= 1; }
    out.push(`01${MONTHS[sm]}${sy}-${lastDayOfMonth(y, end)}${MONTHS[end]}${y}`);
    end -= 3; if (end < 0) { end += 12; y -= 1; }
  }
  return out;
}

async function load13fWindow(db, file, url, log) {
  const subs = new Map();
  for await (const r of entryRows(file, 'SUBMISSION.tsv')) if (r.SUBMISSIONTYPE === '13F-HR') subs.set(r.ACCESSION_NUMBER, r);
  const cover = new Map();
  for await (const r of entryRows(file, 'COVERPAGE.tsv')) {
    if (subs.has(r.ACCESSION_NUMBER) && r.ISAMENDMENT !== 'Y' && (!r.REPORTTYPE || /HOLDINGS REPORT/i.test(r.REPORTTYPE))) cover.set(r.ACCESSION_NUMBER, r);
  }
  // Largest managers by reported portfolio value, latest report period in this window.
  const totals = [];
  for await (const r of entryRows(file, 'SUMMARYPAGE.tsv')) {
    if (cover.has(r.ACCESSION_NUMBER)) totals.push({ acc: r.ACCESSION_NUMBER, total: num(r.TABLEVALUETOTAL) || 0 });
  }
  const periods = [...new Set([...cover.keys()].map((a) => isoDate(subs.get(a).PERIODOFREPORT)).filter(Boolean))].sort();
  const period = periods[periods.length - 1];
  const keep = new Set(totals
    .filter((t) => isoDate(subs.get(t.acc).PERIODOFREPORT) === period)
    .sort((a, b) => b.total - a.total).slice(0, TOP_MANAGERS).map((t) => t.acc));
  const ins = db.prepare(`INSERT INTO fund_holdings VALUES (?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(accession, cusip) DO UPDATE SET value_usd = value_usd + excluded.value_usd, shares = shares + excluded.shares`);
  db.exec('BEGIN');
  db.prepare('DELETE FROM fund_holdings WHERE report_period = ?').run(period);
  let n = 0;
  for await (const r of entryRows(file, 'INFOTABLE.tsv')) {
    if (!keep.has(r.ACCESSION_NUMBER) || r.PUTCALL || (r.SSHPRNAMTTYPE && r.SSHPRNAMTTYPE !== 'SH')) continue; // common stock, no options
    const s = subs.get(r.ACCESSION_NUMBER);
    const c = cover.get(r.ACCESSION_NUMBER);
    ins.run(r.ACCESSION_NUMBER, num(s.CIK), c.FILINGMANAGER_NAME, period, isoDate(s.FILING_DATE),
      String(r.CUSIP || '').toUpperCase(), r.NAMEOFISSUER, r.TITLEOFCLASS, num(r.VALUE) || 0, num(r.SSHPRNAMT) || 0);
    n++;
  }
  db.exec('COMMIT');
  log(`· 13F ${path.basename(url)}: ${keep.size} managers, ${n} positions for period ${period}`);
  return { n, period };
}

function rebuildPositionChanges(db) {
  const periods = db.prepare('SELECT DISTINCT report_period FROM fund_holdings ORDER BY report_period DESC LIMIT 2').all().map((r) => r.report_period);
  db.exec('DROP TABLE IF EXISTS fund_position_changes');
  if (periods.length < 2) {
    db.exec('CREATE TABLE fund_position_changes (manager_cik INTEGER, manager_name TEXT, cusip TEXT, issuer_name TEXT, prior_period TEXT, report_period TEXT, prior_shares REAL, shares REAL, prior_value_usd REAL, value_usd REAL, share_change REAL, change_type TEXT)');
    return;
  }
  const [cur, prev] = periods;
  db.prepare(`
    CREATE TABLE fund_position_changes AS
    WITH c AS (SELECT * FROM fund_holdings WHERE report_period = :cur),
         p AS (SELECT * FROM fund_holdings WHERE report_period = :prev
               AND manager_cik IN (SELECT manager_cik FROM fund_holdings WHERE report_period = :cur)),
         k AS (SELECT manager_cik, cusip FROM c UNION SELECT manager_cik, cusip FROM p)
    SELECT k.manager_cik,
      COALESCE(c.manager_name, p.manager_name) AS manager_name,
      k.cusip,
      COALESCE(c.issuer_name, p.issuer_name) AS issuer_name,
      :prev AS prior_period, :cur AS report_period,
      COALESCE(p.shares, 0) AS prior_shares, COALESCE(c.shares, 0) AS shares,
      COALESCE(p.value_usd, 0) AS prior_value_usd, COALESCE(c.value_usd, 0) AS value_usd,
      COALESCE(c.shares, 0) - COALESCE(p.shares, 0) AS share_change,
      CASE WHEN p.shares IS NULL THEN 'new' WHEN c.shares IS NULL THEN 'exited'
           WHEN c.shares > p.shares THEN 'added' WHEN c.shares < p.shares THEN 'reduced' ELSE 'unchanged' END AS change_type
    FROM k
    LEFT JOIN c ON c.manager_cik = k.manager_cik AND c.cusip = k.cusip
    LEFT JOIN p ON p.manager_cik = k.manager_cik AND p.cusip = k.cusip`).run({ cur, prev });
  db.exec('CREATE INDEX fund_changes_cusip ON fund_position_changes(cusip)');
}

// Loads any published archives not loaded yet. Safe to call often; it only downloads what's new.
async function refreshOwnership({ dbPath, workDir, secUserAgent, log = console.log, fetchers, now = new Date() } = {}) {
  if (!secUserAgent) return { skipped: true };
  const f = fetchers || http;
  const ua = { 'User-Agent': secUserAgent };
  const db = openOwnership(dbPath);
  const meta = db.prepare('INSERT OR REPLACE INTO ownership_meta VALUES (?, ?)');
  const has = (k) => !!db.prepare('SELECT 1 FROM ownership_meta WHERE key = ?').get(k);
  fs.mkdirSync(workDir, { recursive: true });
  const errors = [];
  let loaded = 0;
  try {
    // Insider trades: last 8 published quarters.
    for (const q of recentQuarters(INSIDER_QUARTERS, now)) {
      const name = `${q}_form345.zip`;
      if (has(`loaded:${name}`)) continue;
      const dest = path.join(workDir, name);
      try {
        const url = await fetchArchive(f, `insider-transactions-data-sets/${name}`, dest, ua);
        if (!url) { log(`· Insider ${name}: not published yet`); continue; }
        await loadInsiderQuarter(db, dest, url, log);
        meta.run(`loaded:${name}`, new Date().toISOString());
        loaded++;
      } catch (e) { errors.push(`${name}: ${e.message}`); log(`! ${name}: ${e.message}`); try { db.exec('ROLLBACK'); } catch {} }
      finally { if (fs.existsSync(dest)) fs.rmSync(dest); }
    }
    const cutoff = recentQuarters(INSIDER_QUARTERS, now).at(-1).replace(/q(\d)/, (_, n) => `-${String((Number(n) - 1) * 3 + 1).padStart(2, '0')}-01`);
    db.prepare('DELETE FROM insider_trades WHERE trans_date < ?').run(cutoff);

    // 13F: the two most recent published windows (two report periods for change tracking).
    let windowsLoaded = 0;
    for (const w of recent13fWindows(4, now)) {
      if (windowsLoaded >= 2) break;
      const name = `${w}_form13f.zip`;
      if (has(`loaded:${name}`)) { windowsLoaded++; continue; }
      const dest = path.join(workDir, name);
      try {
        const url = await fetchArchive(f, `form-13f-data-sets/${name}`, dest, ua);
        if (!url) { log(`· 13F ${name}: not published yet`); continue; }
        await load13fWindow(db, dest, url, log);
        meta.run(`loaded:${name}`, new Date().toISOString());
        windowsLoaded++; loaded++;
      } catch (e) { errors.push(`${name}: ${e.message}`); log(`! ${name}: ${e.message}`); try { db.exec('ROLLBACK'); } catch {} }
      finally { if (fs.existsSync(dest)) fs.rmSync(dest); }
    }
    const keepPeriods = db.prepare('SELECT DISTINCT report_period FROM fund_holdings ORDER BY report_period DESC LIMIT 2').all().map((r) => r.report_period);
    if (keepPeriods.length) db.prepare(`DELETE FROM fund_holdings WHERE report_period NOT IN (${keepPeriods.map(() => '?').join(',')})`).run(...keepPeriods);
    rebuildPositionChanges(db);
    meta.run('status', errors.length ? 'partial' : 'ok');
    meta.run('updated_at', new Date().toISOString());
  } finally { db.close(); }
  return { loaded, errors };
}

module.exports = { refreshOwnership, ensureOwnershipDb, isoDate, recentQuarters, recent13fWindows, loadInsiderQuarter, load13fWindow, rebuildPositionChanges };
