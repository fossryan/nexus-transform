'use strict';
// profiles.db — per-company data from SEC "submissions" records, fetched one company at a time:
//   company_profiles  SIC industry, sector division, fiscal year-end, state of incorporation
//   filing_events     8-K events (one row per item) such as restatements, auditor changes,
//                     impairments, executive departures and bankruptcy
// Resumable and incremental: missing companies first (largest revenue first), then stale ones.

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const http = require('./http');

const PROFILE_TTL_DAYS = 7;
const FIRST_DATE = '2018-01-01';

const ITEM_DESCRIPTIONS = {
  '1.01': 'Entered a material agreement',
  '1.02': 'Terminated a material agreement',
  '1.03': 'Bankruptcy or receivership',
  '1.04': 'Mine safety violation',
  '1.05': 'Material cybersecurity incident',
  '2.01': 'Completed an acquisition or disposition',
  '2.02': 'Results of operations (earnings release)',
  '2.03': 'New direct financial obligation (debt)',
  '2.04': 'Event accelerating a financial obligation',
  '2.05': 'Exit or restructuring costs',
  '2.06': 'Material impairment',
  '3.01': 'Delisting notice or listing-rule failure',
  '3.02': 'Unregistered sale of equity',
  '3.03': 'Changed rights of security holders',
  '4.01': 'Changed auditor',
  '4.02': 'Prior financial statements can no longer be relied on (restatement)',
  '5.01': 'Change in control',
  '5.02': 'Director or officer departure/appointment',
  '5.03': 'Amended articles/bylaws or changed fiscal year',
  '5.07': 'Shareholder vote results',
  '7.01': 'Regulation FD disclosure',
  '8.01': 'Other events',
  '9.01': 'Financial statements and exhibits',
};
const RED_FLAG_ITEMS = new Set(['1.03', '1.05', '2.04', '2.06', '3.01', '4.01', '4.02']);

const SCHEMA = `
CREATE TABLE IF NOT EXISTS company_profiles (
  cik INTEGER PRIMARY KEY,
  sic INTEGER,
  industry TEXT,
  sector TEXT,
  fiscal_year_end TEXT,
  state_of_incorporation TEXT,
  fetched_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS filing_events (
  cik INTEGER NOT NULL,
  filing_date TEXT NOT NULL,
  form TEXT NOT NULL,
  item TEXT NOT NULL,
  item_description TEXT,
  red_flag INTEGER NOT NULL,
  accession TEXT NOT NULL,
  filing_url TEXT,
  PRIMARY KEY (accession, item)
);
CREATE INDEX IF NOT EXISTS filing_events_item ON filing_events(item, filing_date);
CREATE INDEX IF NOT EXISTS filing_events_cik ON filing_events(cik, filing_date);
CREATE TABLE IF NOT EXISTS profiles_meta (key TEXT PRIMARY KEY, value TEXT);
`;

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

function filingUrl(cik, accession, doc) {
  const acc = String(accession).replace(/-/g, '');
  return `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${acc}/${doc || ''}`;
}

function parseSubmission(json, cik) {
  // {"sic":"3571","sicDescription":"Electronic Computers","fiscalYearEnd":"0926","stateOfIncorporation":"CA",
  //  "filings":{"recent":{"accessionNumber":[...],"filingDate":[...],"form":[...],"items":[...],"primaryDocument":[...]}}}
  if (!json) return null;
  const sic = Number(json.sic) || null;
  const fye = /^\d{4}$/.test(json.fiscalYearEnd || '') ? `${json.fiscalYearEnd.slice(0, 2)}-${json.fiscalYearEnd.slice(2)}` : null;
  const profile = { sic, industry: json.sicDescription || null, sector: sicSector(sic), fiscal_year_end: fye, state_of_incorporation: json.stateOfIncorporation || null };
  const r = (json.filings && json.filings.recent) || {};
  const events = [];
  const n = Array.isArray(r.form) ? r.form.length : 0;
  for (let i = 0; i < n; i++) {
    const form = r.form[i];
    if (form !== '8-K' && form !== '8-K/A') continue;
    const date = r.filingDate && r.filingDate[i];
    if (!date || date < FIRST_DATE) continue;
    const items = String((r.items && r.items[i]) || '').split(',').map((s) => s.trim()).filter(Boolean);
    for (const item of items) {
      events.push({
        filing_date: date, form, item,
        item_description: ITEM_DESCRIPTIONS[item] || null,
        red_flag: RED_FLAG_ITEMS.has(item) ? 1 : 0,
        accession: r.accessionNumber[i],
        filing_url: filingUrl(cik, r.accessionNumber[i], r.primaryDocument && r.primaryDocument[i]),
      });
    }
  }
  return { profile, events };
}

function openProfiles(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec(SCHEMA);
  return db;
}

function ensureProfilesDb(dbPath) { openProfiles(dbPath).close(); }

// Fetch submissions for companies that are missing or stale. financeDbPath supplies the
// company list (companies with financials, largest revenue first).
async function fillProfiles({ dbPath, financeDbPath, secUserAgent, log = console.log, fetchers, onProgress = () => {}, shouldStop = () => false, delayMs = 125 } = {}) {
  if (!secUserAgent || !fs.existsSync(financeDbPath)) return { done: 0, remaining: null };
  const f = fetchers || http;
  const db = openProfiles(dbPath);
  db.exec(`ATTACH DATABASE '${financeDbPath.replace(/'/g, "''")}' AS fin`);
  const stale = new Date(Date.now() - PROFILE_TTL_DAYS * 86400000).toISOString();
  const todo = db.prepare(`
    SELECT f.cik,
      MAX(CASE WHEN f.metric = 'revenue' THEN f.value END) AS rev,
      (SELECT fetched_at FROM company_profiles p WHERE p.cik = f.cik) AS fetched_at
    FROM fin.financials f
    GROUP BY f.cik
    HAVING fetched_at IS NULL OR fetched_at < ?
    ORDER BY (fetched_at IS NOT NULL), rev DESC NULLS LAST`).all(stale).map((r) => Number(r.cik));
  db.exec('DETACH DATABASE fin');
  const upP = db.prepare('INSERT OR REPLACE INTO company_profiles VALUES (?,?,?,?,?,?,?)');
  const insE = db.prepare('INSERT OR IGNORE INTO filing_events VALUES (?,?,?,?,?,?,?,?)');
  const meta = db.prepare('INSERT OR REPLACE INTO profiles_meta VALUES (?, ?)');
  const total = todo.length;
  let done = 0;
  let failures = 0;
  meta.run('status', total ? 'filling' : 'ok');
  log(`· Company profiles: ${total} to fetch`);
  for (const cik of todo) {
    if (shouldStop()) break;
    try {
      const parsed = parseSubmission(await f.getJson(`https://data.sec.gov/submissions/CIK${String(cik).padStart(10, '0')}.json`, { 'User-Agent': secUserAgent }), cik);
      const p = parsed ? parsed.profile : {};
      db.exec('BEGIN');
      // A missing record still gets a row (all NULL) so it isn't retried until it goes stale.
      upP.run(cik, p.sic ?? null, p.industry ?? null, p.sector ?? null, p.fiscal_year_end ?? null, p.state_of_incorporation ?? null, new Date().toISOString());
      if (parsed) for (const e of parsed.events) insE.run(cik, e.filing_date, e.form, e.item, e.item_description, e.red_flag, e.accession, e.filing_url);
      db.exec('COMMIT');
      done++;
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch {}
      failures++;
      if (failures >= 20) { log(`! Company profiles paused after repeated errors: ${e.message}`); break; }
    }
    if (done % 250 === 0) { onProgress({ done, total }); if (done) log(`· Company profiles: ${done}/${total}`); }
    if (delayMs) await http.sleep(delayMs); // ~8 requests/second, under SEC's 10/second limit
  }
  const remaining = total - done;
  meta.run('status', remaining === 0 ? 'ok' : 'filling');
  meta.run('updated_at', new Date().toISOString());
  db.close();
  onProgress({ done, total });
  log(`· Company profiles: ${done} fetched, ${remaining} remaining`);
  return { done, remaining };
}

module.exports = { fillProfiles, ensureProfilesDb, parseSubmission, sicSector, ITEM_DESCRIPTIONS, RED_FLAG_ITEMS, filingUrl };
