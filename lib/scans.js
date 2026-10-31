'use strict';
// Predefined insight scans. Plain SQL over the derived tables — no AI call, so they are
// free to run. Each can be opened in the builder as a normal, auditable transformation.

// Latest calendar year with reasonably complete annual filings (at least 60% as many
// companies reporting revenue as the best-covered year).
const LATEST_YEAR = 'latest AS (SELECT y FROM latest_complete_year)';

const SCANS = [
  {
    id: 'margin_collapse',
    title: 'Operating margin collapse',
    question: 'Which companies saw operating margin fall by more than 10 points in a year?',
    why: 'A sudden margin drop often comes before guidance cuts, writedowns or restructuring.',
    category: 'risk',
    sql: `WITH ${LATEST_YEAR}
SELECT
  r.ticker,
  r.name,
  r.industry,
  ROUND(100 * p.operating_margin, 1) AS prior_operating_margin_pct,
  ROUND(100 * r.operating_margin, 1) AS operating_margin_pct,
  ROUND(100 * (r.operating_margin - p.operating_margin), 1) AS change_pts,
  r.revenue,
  r.filing_url
FROM company_ratios r
JOIN company_ratios p ON p.cik = r.cik AND p.calendar_year = r.calendar_year - 1
WHERE r.calendar_year = (SELECT y FROM latest)
  AND r.revenue > 100000000
  AND r.operating_margin - p.operating_margin < -0.10
ORDER BY change_pts
LIMIT 50`,
    notes: [
      { match: 'calendar_year = (SELECT y', note: 'Latest calendar year with mostly complete filings.', severity: 'info' },
      { match: 'revenue > 100000000', note: 'Excludes companies under $100M revenue, where margins swing wildly.', severity: 'info' },
      { match: '< -0.10', note: 'Threshold: a drop of more than 10 percentage points.', severity: 'verify' },
    ],
    chart: { type: 'bar', x: 'ticker', y: ['change_pts'] },
  },
  {
    id: 'cash_burn',
    title: 'Short cash runway',
    question: 'Which companies are burning cash with less than two years of runway?',
    why: 'Negative free cash flow plus little cash usually means dilution, new debt or a going-concern risk.',
    category: 'risk',
    sql: `WITH ${LATEST_YEAR}
SELECT
  r.ticker,
  r.name,
  r.industry,
  r.free_cash_flow,
  a.cash,
  r.cash_runway_years,
  r.revenue,
  r.filing_url
FROM company_ratios r
JOIN annual_financials a ON a.cik = r.cik AND a.calendar_year = r.calendar_year
WHERE r.calendar_year = (SELECT y FROM latest)
  AND r.cash_runway_years < 2
  AND r.revenue > 10000000
ORDER BY r.cash_runway_years
LIMIT 50`,
    notes: [
      { match: 'cash_runway_years < 2', note: 'Runway = cash ÷ annual free-cash-flow burn; ignores undrawn credit lines.', severity: 'verify' },
      { match: 'revenue > 10000000', note: 'Excludes pre-revenue shells under $10M revenue.', severity: 'info' },
    ],
    chart: { type: 'bar', x: 'ticker', y: ['cash_runway_years'] },
  },
  {
    id: 'debt_surge',
    title: 'Debt surge',
    question: 'Which companies increased long-term debt by more than 50% (and $500M) in a year?',
    why: 'Fast debt growth raises refinancing and interest-rate risk, especially when coverage is thin.',
    category: 'risk',
    sql: `WITH ${LATEST_YEAR}
SELECT
  a.ticker,
  a.name,
  a.industry,
  p.long_term_debt AS prior_long_term_debt,
  a.long_term_debt,
  ROUND(100.0 * (a.long_term_debt / p.long_term_debt - 1), 1) AS debt_growth_pct,
  r.interest_coverage,
  a.filing_url
FROM annual_financials a
JOIN annual_financials p ON p.cik = a.cik AND p.calendar_year = a.calendar_year - 1
JOIN company_ratios r ON r.cik = a.cik AND r.calendar_year = a.calendar_year
WHERE a.calendar_year = (SELECT y FROM latest)
  AND p.long_term_debt > 0
  AND a.long_term_debt > 1.5 * p.long_term_debt
  AND a.long_term_debt - p.long_term_debt > 500000000
ORDER BY a.long_term_debt - p.long_term_debt DESC
LIMIT 50`,
    notes: [
      { match: 'a.long_term_debt > 1.5', note: 'Long-term debt only; short-term borrowings are not included.', severity: 'verify' },
      { match: '> 500000000', note: 'At least $500M of new debt, to focus on material changes.', severity: 'info' },
    ],
    chart: { type: 'bar', x: 'ticker', y: ['debt_growth_pct'] },
  },
  {
    id: 'beneish_flags',
    title: 'Earnings-quality red flags (Beneish)',
    question: 'Which companies score above the Beneish M-score threshold?',
    why: 'The M-score flags patterns seen in past earnings manipulation — receivables outgrowing sales, falling margins, rising accruals. A screen, not proof.',
    category: 'risk',
    sql: `WITH ${LATEST_YEAR}
SELECT
  s.ticker,
  s.name,
  s.industry,
  s.beneish_m,
  s.beneish_dsri AS receivables_index,
  s.beneish_tata AS accruals_to_assets,
  s.beneish_imputed,
  s.filing_url
FROM company_scores s
JOIN annual_financials a ON a.cik = s.cik AND a.calendar_year = s.calendar_year
WHERE s.calendar_year = (SELECT y FROM latest)
  AND s.beneish_flag = 1
  AND s.beneish_imputed <= 1
  AND a.revenue > 100000000
ORDER BY s.beneish_m DESC
LIMIT 50`,
    notes: [
      { match: 'beneish_flag = 1', note: 'M-score above -1.78. Fast-growing companies trip this often; read the filing before concluding anything.', severity: 'risk' },
      { match: 'beneish_imputed <= 1', note: 'Keeps scores where at most one input was missing and set to neutral.', severity: 'info' },
    ],
  },
  {
    id: 'altman_distress',
    title: 'Financial distress (Altman Z″)',
    question: 'Which non-financial companies are in the Altman distress zone?',
    why: 'Low Z-scores combine weak liquidity, thin retained earnings, low operating returns and high leverage — historically linked to bankruptcy risk.',
    category: 'risk',
    sql: `WITH ${LATEST_YEAR}
SELECT
  s.ticker,
  s.name,
  s.industry,
  s.altman_z,
  r.interest_coverage,
  r.current_ratio,
  a.revenue,
  s.filing_url
FROM company_scores s
JOIN annual_financials a ON a.cik = s.cik AND a.calendar_year = s.calendar_year
JOIN company_ratios r ON r.cik = s.cik AND r.calendar_year = s.calendar_year
WHERE s.calendar_year = (SELECT y FROM latest)
  AND s.altman_zone = 'distress'
  AND a.revenue > 100000000
ORDER BY s.altman_z
LIMIT 50`,
    notes: [
      { match: "altman_zone = 'distress'", note: "Z″ below 1.1 (four-variable version for non-manufacturers; book equity, not market cap).", severity: 'verify' },
    ],
    chart: { type: 'bar', x: 'ticker', y: ['altman_z'] },
  },
  {
    id: 'piotroski_strong',
    title: 'Improving fundamentals (Piotroski 8–9)',
    question: 'Which sizable companies score 8 or 9 on the Piotroski F-score?',
    why: 'High F-scores mean profitability, cash flow, leverage, liquidity and efficiency all improved — a classic quality screen.',
    category: 'opportunity',
    sql: `WITH ${LATEST_YEAR}
SELECT
  s.ticker,
  s.name,
  s.industry,
  s.piotroski_f,
  ROUND(100 * r.operating_margin, 1) AS operating_margin_pct,
  ROUND(100 * r.revenue_growth, 1) AS revenue_growth_pct,
  ROUND(100 * r.fcf_margin, 1) AS fcf_margin_pct,
  s.filing_url
FROM company_scores s
JOIN company_ratios r ON r.cik = s.cik AND r.calendar_year = s.calendar_year
WHERE s.calendar_year = (SELECT y FROM latest)
  AND s.piotroski_f >= 8
  AND r.revenue > 1000000000
ORDER BY s.piotroski_f DESC, r.revenue_growth DESC
LIMIT 50`,
    notes: [
      { match: 'piotroski_f >= 8', note: 'Uses year-end assets; requires at least 8 of 9 tests to have data.', severity: 'info' },
      { match: 'revenue > 1000000000', note: 'Limited to companies with over $1B revenue.', severity: 'info' },
    ],
  },
  {
    id: 'insider_cluster_buying',
    title: 'Insider cluster buying',
    question: 'Where have three or more insiders bought shares on the open market in the last 90 days?',
    why: 'Insiders sell for many reasons but buy for one. Several buying at once is one of the better-studied signals in public data.',
    category: 'opportunity',
    sql: `WITH window_start AS (
  SELECT DATE(MAX(trans_date), '-90 days') AS d FROM insider_trades
)
SELECT
  t.ticker,
  MAX(t.issuer_name) AS name,
  COUNT(DISTINCT t.owner_name) AS insiders_buying,
  ROUND(SUM(t.value_usd)) AS total_bought_usd,
  MIN(t.trans_date) AS first_buy,
  MAX(t.trans_date) AS last_buy,
  MAX(t.filing_url) AS filing_url
FROM insider_trades t
WHERE t.trans_code = 'P'
  AND t.trans_date >= (SELECT d FROM window_start)
GROUP BY t.issuer_cik, t.ticker
HAVING COUNT(DISTINCT t.owner_name) >= 3
ORDER BY insiders_buying DESC, total_bought_usd DESC
LIMIT 50`,
    notes: [
      { match: "DATE(MAX(trans_date), '-90 days')", note: 'Last 90 days of the loaded Form 4 data, not of today.', severity: 'verify' },
      { match: "trans_code = 'P'", note: 'Open-market purchases only; grants and option exercises are excluded.', severity: 'info' },
    ],
    chart: { type: 'bar', x: 'ticker', y: ['insiders_buying'] },
  },
  {
    id: 'red_flag_filings',
    title: 'Red-flag 8-K filings',
    question: 'Which companies filed restatements, auditor changes, impairments or other red-flag 8-Ks in the last year?',
    why: 'Items like 4.02 (prior statements unreliable) and 4.01 (auditor change) are rare and often precede bad news.',
    category: 'risk',
    sql: `WITH window_start AS (
  SELECT DATE(MAX(filing_date), '-365 days') AS d FROM filing_events
)
SELECT
  e.filing_date,
  a.ticker,
  a.name,
  e.item,
  e.item_description,
  e.filing_url
FROM filing_events e
LEFT JOIN (SELECT cik, ticker, name FROM annual_financials GROUP BY cik) a ON a.cik = e.cik
WHERE e.red_flag = 1
  AND e.filing_date >= (SELECT d FROM window_start)
ORDER BY CASE e.item WHEN '4.02' THEN 0 WHEN '1.03' THEN 1 WHEN '4.01' THEN 2 ELSE 3 END, e.filing_date DESC
LIMIT 100`,
    notes: [
      { match: 'e.red_flag = 1', note: 'Items 1.03, 1.05, 2.04, 2.06, 3.01, 4.01 and 4.02.', severity: 'info' },
      { match: "'-365 days'", note: 'Last 12 months of loaded filings.', severity: 'info' },
    ],
  },
  {
    id: 'heavy_dilution',
    title: 'Heavy dilution',
    question: 'Which companies grew their diluted share count by more than 10% in a year?',
    why: 'Dilution shrinks each shareholder\'s slice; persistent dilution can hide weak per-share economics.',
    category: 'risk',
    sql: `WITH ${LATEST_YEAR}
SELECT
  r.ticker,
  r.name,
  r.industry,
  ROUND(100 * r.share_count_change, 1) AS share_growth_pct,
  ROUND(100 * r.revenue_growth, 1) AS revenue_growth_pct,
  r.revenue,
  r.filing_url
FROM company_ratios r
WHERE r.calendar_year = (SELECT y FROM latest)
  AND r.share_count_change > 0.10
  AND r.revenue > 100000000
ORDER BY r.share_count_change DESC
LIMIT 50`,
    notes: [{ match: 'share_count_change > 0.10', note: 'Weighted-average diluted shares; acquisitions paid in stock also show up here.', severity: 'verify' }],
    chart: { type: 'bar', x: 'ticker', y: ['share_growth_pct'] },
  },
  {
    id: 'fund_new_positions',
    title: 'Where big funds opened new positions',
    question: 'Which stocks did the most large managers buy as new positions last quarter?',
    why: 'Shows where institutional money is rotating. 13F data is filed up to 45 days after quarter-end, so it is a lagging view.',
    category: 'opportunity',
    sql: `SELECT
  c.issuer_name,
  c.cusip,
  COUNT(*) AS managers_opening,
  ROUND(SUM(c.value_usd)) AS new_value_usd,
  MAX(c.report_period) AS report_period
FROM fund_position_changes c
WHERE c.change_type = 'new'
GROUP BY c.cusip, c.issuer_name
ORDER BY managers_opening DESC, new_value_usd DESC
LIMIT 50`,
    notes: [
      { match: "change_type = 'new'", note: 'New = held this period, not held last period, among the ~150 largest managers.', severity: 'info' },
      { match: 'c.issuer_name', note: '13F lists issuer names, not tickers.', severity: 'info' },
    ],
    chart: { type: 'bar', x: 'issuer_name', y: ['managers_opening'] },
  },
  {
    id: 'quality_value',
    title: 'Quality at a reasonable price',
    question: 'Which companies combine strong fundamentals with a high free-cash-flow yield?',
    why: 'Piotroski ≥ 7 plus FCF yield above 6% and P/E under 20 looks for healthy businesses the market prices cheaply.',
    category: 'opportunity',
    sql: `SELECT
  v.ticker,
  v.name,
  v.industry,
  s.piotroski_f,
  ROUND(100 * v.fcf_yield, 1) AS fcf_yield_pct,
  v.pe_ratio,
  v.market_cap,
  v.return_52w_pct
FROM valuation v
JOIN company_scores s ON s.cik = v.cik AND s.calendar_year = v.fundamentals_year
WHERE s.piotroski_f >= 7
  AND v.fcf_yield > 0.06
  AND v.pe_ratio < 20
ORDER BY v.fcf_yield DESC
LIMIT 50`,
    notes: [
      { match: 'v.fcf_yield > 0.06', note: 'FCF yield = latest annual free cash flow ÷ current market cap.', severity: 'verify' },
      { match: 'v.pe_ratio < 20', note: 'P/E uses the latest annual diluted EPS, not trailing-twelve-months.', severity: 'verify' },
    ],
    chart: { type: 'bar', x: 'ticker', y: ['fcf_yield_pct'] },
  },
];

function lineOf(sql, match) {
  const i = sql.split('\n').findIndex((l) => l.includes(match));
  return i < 0 ? 1 : i + 1;
}

function scanNotes(scan) {
  return (scan.notes || []).map((n) => ({ line: lineOf(scan.sql, n.match), note: n.note, severity: n.severity }));
}

module.exports = { SCANS, scanNotes };
