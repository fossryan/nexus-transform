'use strict';
// PLACEHOLDER data shaped like the real SEC, Treasury, FRED and Finnhub responses.
// Used only for offline tests. Company names are deliberately fake ("Placeholder …").
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { writeZip } = require('./zipwriter');
const { recentQuarters, recent13fWindows } = require('../lib/ownership');

const names = ['Placeholder Alpha Corp', 'Placeholder Beta Inc', 'Placeholder Gamma Holdings', 'Placeholder Delta Systems', 'Placeholder Epsilon Bank',
  'Placeholder Zeta Energy', 'Placeholder Eta Health', 'Placeholder Theta Retail', 'Placeholder Iota Software', 'Placeholder Kappa Motors', 'Placeholder Lambda Foods', 'Placeholder Mu Media'];
const SICS = [7372, 6021, 2834, 3571, 6021, 1311, 4911, 5331, 7372, 3711, 2000, 4841];
const companies = {};
names.forEach((n, i) => { companies[i] = { cik_str: 1000 + i, ticker: `PH${String.fromCharCode(65 + i)}`, title: n }; });
companies[99] = { cik_str: 1000, ticker: 'PHA-B', title: 'Placeholder Alpha Corp' }; // duplicate share class

// First tag of each metric carries data (except revenue, which mixes tags); share of revenue per tag.
const SHARE = {
  RevenueFromContractWithCustomerExcludingAssessedTax: 1, CostOfRevenue: 0.6, GrossProfit: 0.4, OperatingIncomeLoss: 0.15, NetIncomeLoss: 0.1,
  ResearchAndDevelopmentExpense: 0.05, SellingGeneralAndAdministrativeExpense: 0.15, InterestExpense: 0.012, DepreciationDepletionAndAmortization: 0.04,
  NetCashProvidedByUsedInOperatingActivities: 0.13, PaymentsToAcquirePropertyPlantAndEquipment: 0.05, PaymentsForRepurchaseOfCommonStock: 0.03,
  PaymentsOfDividendsCommonStock: 0.02, Assets: 1.2, AssetsCurrent: 0.5, Liabilities: 0.6, LiabilitiesAndStockholdersEquity: 1.2, LiabilitiesCurrent: 0.3,
  LongTermDebtNoncurrent: 0.3, StockholdersEquity: 0.6, RetainedEarningsAccumulatedDeficit: 0.3, CashAndCashEquivalentsAtCarryingValue: 0.1,
  AccountsReceivableNetCurrent: 0.12, InventoryNet: 0.1, PropertyPlantAndEquipmentNet: 0.3,
};
const hash = (s) => { let h = 7; for (const c of s) h = (h * 31 + c.charCodeAt(0)) % 1000003; return h / 1000003; };

function frame(tag, unit, year, qtr) {
  const isQuarterDuration = qtr && !qtr.endsWith('I');
  if (qtr === 'Q4' && isQuarterDuration) return null; // Q4 income usually only in the 10-K
  const data = names.map((n, i) => {
    if (tag === 'Liabilities' && i === 3) return null; // forces the liabilities_and_equity fallback
    if (tag === 'Revenues') return i === 7 ? { i, val: (i + 1) * 1e9 } : null; // one company reports plain "Revenues"
    if (tag === 'RevenueFromContractWithCustomerExcludingAssessedTax' && i === 7) return null;
    const growth = 1 + (year - 2018) * (0.04 + 0.02 * (i % 3)) - (i === 5 && year >= 2023 ? 0.25 : 0);
    const rev = (i + 1) * 1e9 * growth * (isQuarterDuration ? 0.25 : 1);
    const jitter = 0.85 + 0.3 * hash(`${tag}${year}${qtr}${i}`);
    if (unit === 'shares') return { i, val: Math.round((i + 1) * 1e8 * (1 + (i === 2 ? (year - 2018) * 0.08 : -(year - 2018) * 0.01))) };
    if (unit === 'USD-per-shares') return { i, val: Math.round(((0.1 * rev) / ((i + 1) * 1e8)) * 100) / 100 };
    const share = SHARE[tag];
    if (share === undefined) return null;
    let val = rev * share * jitter;
    if (i === 10 && /NetIncome|OperatingIncome/.test(tag)) val = -val;           // a money-loser
    if (i === 10 && tag === 'NetCashProvidedByUsedInOperatingActivities') val = -val; // burning cash
    if (i === 6 && tag === 'AccountsReceivableNetCurrent' && year >= 2024) val *= 2.5; // receivables blow-out → Beneish
    return { i, val: Math.round(val) };
  }).filter(Boolean).map(({ i, val }) => ({ accn: `0000${1000 + i}-${String(year).slice(2)}-0000${i}`, cik: 1000 + i, entityName: names[i], loc: 'US-XX', end: `${year}-12-31`, val }));
  return { taxonomy: 'us-gaap', tag, uom: unit, ccp: `CY${year}${qtr || ''}`, pts: data.length, data };
}

function submission(cik) {
  const i = cik - 1000;
  if (i === 11) return null; // filer with no submissions record
  const forms = []; const dates = []; const items = []; const accs = []; const docs = [];
  const add = (form, date, item) => { forms.push(form); dates.push(date); items.push(item); accs.push(`0000${cik}-25-0${forms.length}`); docs.push('doc.htm'); };
  add('8-K', '2025-02-10', '2.02,9.01');
  add('4', '2025-03-01', '');
  if (i === 6) add('8-K', '2025-06-15', '4.02,9.01');
  if (i === 10) add('8-K', '2025-08-01', '4.01');
  if (i === 3) add('8-K', '2024-11-20', '5.02');
  add('8-K', '2017-05-01', '8.01'); // before 2018: ignored
  return { cik: String(cik).padStart(10, '0'), sic: String(SICS[i]), sicDescription: `Placeholder industry ${SICS[i]}`, fiscalYearEnd: i % 3 ? '1231' : '0930', stateOfIncorporation: 'DE',
    filings: { recent: { accessionNumber: accs, filingDate: dates, form: forms, items, primaryDocument: docs } } };
}

function treasury(url) {
  const page = Number((url.match(/page\[number\]=(\d+)/) || [])[1] || 1);
  const rows = [];
  if (page === 1) {
    for (let y = 2018; y <= 2026; y++) for (const q of ['03-31', '06-30', '09-30', '12-31']) {
      rows.push({ record_date: `${y}-${q}`, country_currency_desc: 'Euro Zone-Euro', country: 'Euro Zone', currency: 'Euro', exchange_rate: (0.85 + hash(`e${y}${q}`) * 0.1).toFixed(3) });
      rows.push({ record_date: `${y}-${q}`, country_currency_desc: 'Japan-Yen', country: 'Japan', currency: 'Yen', exchange_rate: (105 + hash(`j${y}${q}`) * 50).toFixed(2) });
    }
  } else rows.push({ record_date: '2026-06-30', country_currency_desc: 'Canada-Dollar', country: 'Canada', currency: 'Dollar', exchange_rate: '1.371' });
  return { data: rows, meta: { 'total-pages': 2 } };
}

function fred(url) {
  const id = url.match(/id=(\w+)/)[1];
  const lines = [`observation_date,${id}`];
  const start = Date.UTC(2018, 0, 1);
  const step = /^(DGS|BAA|T10Y|VIX|DCOIL|DTWEX)/.test(id) ? 1 : id === 'GDPC1' ? 91 : id === 'MORTGAGE30US' ? 7 : 30;
  for (let d = 0; d < 365 * 8; d += step) {
    const dt = new Date(start + d * 86400000);
    if (step === 1 && (dt.getUTCDay() === 0 || dt.getUTCDay() === 6)) continue;
    const base = { DGS10: 2.5, DGS2: 2 + Math.sin(d / 400) * 2.2, DGS3MO: 2, CPIAUCSL: 250 + d / 30, FEDFUNDS: d > 1500 ? 5 : 0.5, VIXCLS: 18, DCOILWTICO: 70, GDPC1: 20000 + d }[id] ?? 4;
    lines.push(`${dt.toISOString().slice(0, 10)},${d % 97 === 0 ? '.' : (base + hash(`${id}${d}`) * 0.3).toFixed(2)}`);
  }
  return lines.join('\n');
}

const tsv = (rows) => rows.map((r) => r.join('\t')).join('\n') + '\n';

function insiderZip(file, quarter) {
  const [y] = quarter.split('q');
  const sub = [['ACCESSION_NUMBER', 'FILING_DATE', 'PERIOD_OF_REPORT', 'DOCUMENT_TYPE', 'ISSUERCIK', 'ISSUERNAME', 'ISSUERTRADINGSYMBOL']];
  const own = [['ACCESSION_NUMBER', 'RPTOWNERCIK', 'RPTOWNERNAME', 'RPTOWNER_RELATIONSHIP', 'RPTOWNER_TITLE']];
  const tr = [['ACCESSION_NUMBER', 'NONDERIV_TRANS_SK', 'TRANS_DATE', 'TRANS_CODE', 'TRANS_SHARES', 'TRANS_PRICEPERSHARE', 'TRANS_ACQUIRED_DISP_CD', 'SHRS_OWND_FOLWNG_TRANS', 'DIRECT_INDIRECT_OWNERSHIP']];
  for (let i = 0; i < 6; i++) {
    for (let k = 0; k < 3; k++) {
      const acc = `${quarter}-${i}-${k}`;
      sub.push([acc, `1${k}-MAR-${y}`, `0${k + 1}-MAR-${y}`, '4', 1000 + i, names[i], `PH${String.fromCharCode(65 + i)}`]);
      own.push([acc, 9000 + k, `Placeholder Insider ${i}-${k}`, k === 0 ? 'Officer' : 'Director', k === 0 ? 'CFO' : '']);
      const code = i === 1 ? 'P' : k === 2 ? 'S' : 'P'; // company 1: cluster buying
      tr.push([acc, '1', `0${k + 1}-MAR-${y}`, code, 1000 * (k + 1), 25.5, code === 'P' ? 'A' : 'D', 50000, 'D']);
      tr.push([acc, '2', `0${k + 1}-MAR-${y}`, 'A', 500, 0, 'A', 50500, 'D']); // grant: filtered out
    }
  }
  sub.push(['x-3', `10-MAR-${y}`, `01-MAR-${y}`, '3', 1000, names[0], 'PHA']); // Form 3: filtered out
  writeZip(file, { 'SUBMISSION.tsv': tsv(sub), 'REPORTINGOWNER.tsv': tsv(own), 'NONDERIV_TRANS.tsv': tsv(tr) });
}

function f13Zip(file, period, variant) {
  const sub = [['ACCESSION_NUMBER', 'FILING_DATE', 'SUBMISSIONTYPE', 'CIK', 'PERIODOFREPORT']];
  const cover = [['ACCESSION_NUMBER', 'ISAMENDMENT', 'FILINGMANAGER_NAME', 'REPORTTYPE']];
  const summ = [['ACCESSION_NUMBER', 'TABLEVALUETOTAL']];
  const info = [['ACCESSION_NUMBER', 'INFOTABLE_SK', 'NAMEOFISSUER', 'TITLEOFCLASS', 'CUSIP', 'VALUE', 'SSHPRNAMT', 'SSHPRNAMTTYPE', 'PUTCALL']];
  for (let m = 0; m < 3; m++) {
    const acc = `13f-${period}-${m}`;
    sub.push([acc, `14-${['FEB', 'MAY', 'AUG', 'NOV'][m]}-2026`, '13F-HR', 7000 + m, period]);
    cover.push([acc, 'N', `Placeholder Capital ${m}`, '13F HOLDINGS REPORT']);
    summ.push([acc, 1e9 * (m + 1)]);
    for (let i = 0; i < 5; i++) {
      if (variant === 'old' && i === 4) continue;           // new position next period
      if (variant === 'new' && i === 0 && m === 0) continue; // exited
      const shares = 10000 * (i + 1) * (variant === 'new' && i === 2 ? 2 : 1);
      info.push([acc, `${i}a`, names[i].toUpperCase(), 'COM', `CUSIP000${i}`, shares * 30, shares / 2, 'SH', '']);
      info.push([acc, `${i}b`, names[i].toUpperCase(), 'COM', `CUSIP000${i}`, shares * 30, shares / 2, 'SH', '']); // second line, same security
    }
    info.push([acc, 'opt', names[0].toUpperCase(), 'CALL', 'CUSIP0000', 5000, 100, 'SH', 'Call']); // option: filtered out
  }
  writeZip(file, { 'SUBMISSION.tsv': tsv(sub), 'COVERPAGE.tsv': tsv(cover), 'SUMMARYPAGE.tsv': tsv(summ), 'INFOTABLE.tsv': tsv(info) });
}

function createFetchers({ now = new Date() } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nx-fix-'));
  const quarters = recentQuarters(8, now).slice(1, 3); // pretend only two quarters are published
  const windows = recent13fWindows(4, now).slice(1, 3);
  const calls = { finnhub: 0 };
  return {
    calls,
    async getJson(url) {
      if (url.includes('company_tickers')) return companies;
      let m = url.match(/submissions\/CIK(\d{10})\.json/);
      if (m) return submission(Number(m[1]));
      m = url.match(/frames\/us-gaap\/(\w+)\/([\w-]+)\/CY(\d{4})(Q\d)?(I)?\.json/);
      if (m) return frame(m[1], m[2], Number(m[3]), m[4] ? m[4] + (m[5] || '') : (m[5] || ''));
      if (url.includes('rates_of_exchange')) return treasury(url);
      if (url.includes('finnhub.io')) {
        calls.finnhub++;
        const sym = decodeURIComponent(url.match(/symbol=([^&]+)/)[1]);
        const i = sym.charCodeAt(2) - 65;
        if (sym === 'PHL') return { c: 0 }; // not covered
        if (url.includes('/quote')) return { c: 20 + i * 3, pc: 19.5 + i * 3, dp: 1.2, t: Math.floor(now.getTime() / 1000) };
        return { metric: { '52WeekHigh': 40 + i, '52WeekLow': 10, '52WeekPriceReturnDaily': 12.5 - i * 3, '13WeekPriceReturnDaily': 2, '26WeekPriceReturnDaily': 5, beta: 1.1, dividendYieldIndicatedAnnual: 1.5, marketCapitalization: 5000 + i * 100 } };
      }
      throw new Error(`fixture: unexpected url ${url}`);
    },
    async getText(url) { return fred(url); },
    async download(url, dest) {
      const qm = url.match(/(\d{4}q\d)_form345\.zip$/);
      if (qm) { if (!quarters.includes(qm[1]) || !url.includes('structureddata')) return false; insiderZip(dest, qm[1]); return true; }
      const wm = url.match(/([0-9a-z-]+)_form13f\.zip$/);
      if (wm) {
        if (!url.includes('structureddata')) return false;
        const idx = windows.indexOf(wm[1]);
        if (idx < 0) return false;
        f13Zip(dest, idx === 0 ? '30-JUN-2026' : '31-MAR-2026', idx === 0 ? 'new' : 'old');
        return true;
      }
      throw new Error(`fixture: unexpected download ${url}`);
    },
    cleanup() { fs.rmSync(tmp, { recursive: true, force: true }); },
  };
}

module.exports = { createFetchers, names };
