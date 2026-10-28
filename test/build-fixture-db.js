'use strict';
// Builds a finance.db from PLACEHOLDER data shaped exactly like the real API responses.
// Used only for offline tests. Company names are deliberately fake ("Placeholder …").
const path = require('node:path');
const { buildDatabase, fillSectors } = require('../lib/loader');

const companies = {};
const names = ['Placeholder Alpha Corp', 'Placeholder Beta Inc', 'Placeholder Gamma Holdings', 'Placeholder Delta Systems', 'Placeholder Epsilon Bank',
  'Placeholder Zeta Energy', 'Placeholder Eta Health', 'Placeholder Theta Retail', 'Placeholder Iota Software', 'Placeholder Kappa Motors', 'Placeholder Lambda Foods', 'Placeholder Mu Media'];
names.forEach((n, i) => { companies[i] = { cik_str: 1000 + i, ticker: `PH${String.fromCharCode(65 + i)}`, title: n }; });
companies[99] = { cik_str: 1000, ticker: 'PHA.B', title: 'Placeholder Alpha Corp' }; // duplicate share class

let seed = 7;
const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);

async function getJson(url) {
  if (url.includes('company_tickers')) return companies;
  const sub = url.match(/submissions\/CIK(\d{10})\.json/);
  if (sub) {
    const i = Number(sub[1]) - 1000;
    if (i === 11) return null; // simulate a filer with no submissions record
    const sics = [7372, 6021, 2834, 3571, 5331, 1311, 4911, 7372, 3711, 2000, 4841, 6211];
    return { cik: sub[1], sic: String(sics[i]), sicDescription: `Placeholder industry ${sics[i]}`, fiscalYearEnd: i % 3 ? '1231' : '0930' };
  }
  const m = url.match(/frames\/us-gaap\/(\w+)\/USD\/CY(\d{4})(Q\d)?(I)?\.json/);
  if (m) {
    const [, tag, year, qtr] = m;
    const qScale = qtr && !m[4] ? 0.25 : 1;
    if (tag === 'SalesRevenueNet' || (tag === 'Revenues' && year < 2020)) return null; // simulate 404s
    if (qtr === 'Q4' && !m[4]) return null; // Q4 income usually only in the 10-K
    const data = names.map((n, i) => {
      if (tag === 'OperatingIncomeLoss' && i % 5 === 4) return null; // some companies don't report a metric
      const scale = (i + 1) * 1e9 * (1 + (year - 2018) * 0.06) * qScale;
      const val = tag.includes('Income') ? Math.round(scale * (0.05 + rand() * 0.2) * (i === 10 ? -1 : 1)) : Math.round(scale * (0.5 + rand()));
      return { accn: `0000000000-${year}-${i}`, cik: 1000 + i, entityName: n, loc: 'US-XX', end: `${year}-12-31`, val };
    }).filter(Boolean);
    return { taxonomy: 'us-gaap', tag, ccp: `CY${year}`, uom: 'USD', label: tag, pts: data.length, data };
  }
  if (url.includes('rates_of_exchange')) {
    const page = Number((url.match(/page\[number\]=(\d+)/) || [])[1] || 1);
    const rows = [];
    if (page === 1) {
      for (let y = 2018; y <= 2026; y++) for (const q of ['03-31', '06-30', '09-30', '12-31']) {
        rows.push({ record_date: `${y}-${q}`, country_currency_desc: 'Euro Zone-Euro', country: 'Euro Zone', currency: 'Euro', exchange_rate: (0.85 + rand() * 0.1).toFixed(3) });
        rows.push({ record_date: `${y}-${q}`, country_currency_desc: 'Japan-Yen', country: 'Japan', currency: 'Yen', exchange_rate: (105 + rand() * 50).toFixed(2) });
      }
    } else {
      rows.push({ record_date: '2026-09-30', country_currency_desc: 'Canada-Dollar', country: 'Canada', currency: 'Dollar', exchange_rate: '1.371' });
    }
    return { data: rows, meta: { 'total-pages': 2 } };
  }
  throw new Error(`unexpected url ${url}`);
}

async function getText(url) {
  const id = url.match(/id=(\w+)/)[1];
  const lines = ['observation_date,' + id];
  const start = new Date('2018-01-01');
  for (let d = 0; d < 365 * 8; d += id.startsWith('DGS') ? 1 : 30) {
    const dt = new Date(start.getTime() + d * 86400000);
    if (id.startsWith('DGS') && (dt.getUTCDay() === 0 || dt.getUTCDay() === 6)) continue;
    const base = id === 'DGS10' ? 2.5 : id === 'DGS2' ? 2 + Math.sin(d / 400) * 2.2 : id === 'DGS3MO' ? 2 : id === 'CPIAUCSL' ? 250 + d / 30 : 4;
    lines.push(`${dt.toISOString().slice(0, 10)},${d % 97 === 0 ? '.' : (base + rand() * 0.3).toFixed(2)}`);
  }
  return lines.join('\n');
}

const out = process.argv[2] || path.join(__dirname, '..', 'data', 'finance.db');
buildDatabase({ outPath: out, secUserAgent: 'test fixture', fetchers: { getJson, getText }, log: () => {} })
  .then(async ({ errors }) => {
    console.log(`fixture db → ${out}; warnings: ${errors.length}`); errors.forEach((e) => console.log('  ', e));
    if (!process.argv.includes('--no-sectors')) {
      const r = await fillSectors({ dbPath: out, secUserAgent: 'test fixture', fetchers: { getJson, getText }, log: () => {} });
      console.log(`sectors filled: ${r.done}, remaining: ${r.remaining}`);
    }
  });
