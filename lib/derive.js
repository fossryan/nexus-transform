'use strict';
// Derived tables, rebuilt after every data load and when sector codes change:
//   annual_financials     one row per company-year, every metric, sector, link to the filing
//   quarterly_financials  one row per company-quarter, core metrics
//   company_ratios        margins, growth, cash flow, leverage, returns + peer percentiles
//   company_scores        Piotroski F-score, Altman Z''-score, Beneish M-score
// Everything is plain SQL over finance.db (+ profiles.db for sectors), so each number can be
// traced back to the filing it came from.

const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');
const { METRIC_NAMES, QUARTERLY_METRICS } = require('./loader');

const RANKED = ['operating_margin', 'net_margin', 'revenue_growth', 'fcf_margin', 'roe', 'debt_to_equity'];

const pivot = (metrics) => metrics.map((m) => `  MAX(CASE WHEN f.metric = '${m}' THEN f.value END) AS ${m}`).join(',\n');

function sql() {
  const pct = (m, grp, label) => `  CASE WHEN ${m} IS NOT NULL AND COUNT(${m}) OVER (PARTITION BY ${grp}, calendar_year) >= 5
    THEN ROUND(PERCENT_RANK() OVER (PARTITION BY ${grp}, calendar_year, ${m} IS NULL ORDER BY ${m}), 3) END AS ${m}_pctile_${label}`;
  return `
DROP TABLE IF EXISTS annual_financials;
CREATE TABLE annual_financials AS
SELECT
  f.cik, c.ticker, c.name, p.sector, p.industry, p.sic, p.fiscal_year_end,
  f.calendar_year,
${pivot(METRIC_NAMES)},
  MAX(CASE WHEN f.metric = 'revenue' THEN f.period_end END) AS period_end,
  COALESCE(MAX(CASE WHEN f.metric = 'revenue' THEN f.accession END),
           MAX(CASE WHEN f.metric = 'net_income' THEN f.accession END),
           MAX(CASE WHEN f.metric = 'total_assets' THEN f.accession END)) AS accession,
  CAST(NULL AS TEXT) AS filing_url
FROM financials f
LEFT JOIN companies c ON c.cik = f.cik
LEFT JOIN prof.company_profiles p ON p.cik = f.cik
GROUP BY f.cik, f.calendar_year;
UPDATE annual_financials SET total_liabilities = liabilities_and_equity - stockholders_equity
  WHERE total_liabilities IS NULL AND liabilities_and_equity IS NOT NULL AND stockholders_equity IS NOT NULL;
UPDATE annual_financials SET filing_url = 'https://www.sec.gov/Archives/edgar/data/' || cik || '/' || REPLACE(accession, '-', '') || '/'
  WHERE accession IS NOT NULL;
CREATE UNIQUE INDEX annual_financials_pk ON annual_financials(cik, calendar_year);
CREATE INDEX annual_financials_year ON annual_financials(calendar_year, sector);

DROP TABLE IF EXISTS quarterly_financials;
CREATE TABLE quarterly_financials AS
SELECT
  f.cik, c.ticker, c.name, p.sector, p.industry, p.sic,
  f.calendar_year, f.quarter,
${pivot(QUARTERLY_METRICS)},
  MAX(f.period_end) AS period_end
FROM financials_quarterly f
LEFT JOIN companies c ON c.cik = f.cik
LEFT JOIN prof.company_profiles p ON p.cik = f.cik
GROUP BY f.cik, f.calendar_year, f.quarter;
CREATE UNIQUE INDEX quarterly_financials_pk ON quarterly_financials(cik, calendar_year, quarter);

DROP TABLE IF EXISTS temp.ratios_base;
CREATE TEMP TABLE ratios_base AS
SELECT
  a.cik, a.ticker, a.name, a.sector, a.industry, a.sic, a.calendar_year,
  a.revenue,
  ROUND(COALESCE(a.gross_profit, a.revenue - a.cost_of_revenue) / NULLIF(a.revenue, 0), 4) AS gross_margin,
  ROUND(a.operating_income / NULLIF(a.revenue, 0), 4) AS operating_margin,
  ROUND(a.net_income / NULLIF(a.revenue, 0), 4) AS net_margin,
  CASE WHEN p.revenue > 0 THEN ROUND(a.revenue / p.revenue - 1, 4) END AS revenue_growth,
  CASE WHEN p.net_income > 0 AND a.net_income IS NOT NULL THEN ROUND(a.net_income / p.net_income - 1, 4) END AS net_income_growth,
  a.operating_cash_flow - COALESCE(a.capex, 0) AS free_cash_flow,
  ROUND((a.operating_cash_flow - COALESCE(a.capex, 0)) / NULLIF(a.revenue, 0), 4) AS fcf_margin,
  ROUND(a.operating_income / NULLIF(a.interest_expense, 0), 2) AS interest_coverage,
  ROUND(a.current_assets / NULLIF(a.current_liabilities, 0), 3) AS current_ratio,
  CASE WHEN a.stockholders_equity > 0 THEN ROUND(COALESCE(a.long_term_debt, 0) / a.stockholders_equity, 3) END AS debt_to_equity,
  ROUND(a.total_liabilities / NULLIF(a.total_assets, 0), 4) AS liabilities_to_assets,
  ROUND(a.net_income / NULLIF(a.total_assets, 0), 4) AS roa,
  CASE WHEN a.stockholders_equity > 0 THEN ROUND(a.net_income / a.stockholders_equity, 4) END AS roe,
  ROUND(a.rd_expense / NULLIF(a.revenue, 0), 4) AS rd_intensity,
  ROUND(a.capex / NULLIF(a.revenue, 0), 4) AS capex_intensity,
  ROUND(a.cash / NULLIF(a.total_assets, 0), 4) AS cash_to_assets,
  ROUND(a.revenue / NULLIF(a.total_assets, 0), 4) AS asset_turnover,
  CASE WHEN a.net_income > 0 THEN ROUND((COALESCE(a.buybacks, 0) + COALESCE(a.dividends_paid, 0)) / a.net_income, 4) END AS payout_ratio,
  CASE WHEN p.shares_diluted > 0 THEN ROUND(a.shares_diluted / p.shares_diluted - 1, 4) END AS share_count_change,
  CASE WHEN a.operating_cash_flow - COALESCE(a.capex, 0) < 0 AND a.cash > 0
    THEN ROUND(a.cash / -(a.operating_cash_flow - COALESCE(a.capex, 0)), 2) END AS cash_runway_years,
  a.filing_url
FROM annual_financials a
LEFT JOIN annual_financials p ON p.cik = a.cik AND p.calendar_year = a.calendar_year - 1;

DROP TABLE IF EXISTS company_ratios;
CREATE TABLE company_ratios AS
SELECT
  r.*,
  COUNT(*) OVER (PARTITION BY sic, calendar_year) AS industry_peer_count,
  COUNT(*) OVER (PARTITION BY sector, calendar_year) AS sector_peer_count,
${RANKED.map((m) => pct(m, 'sic', 'industry')).join(',\n')},
${RANKED.map((m) => pct(m, 'sector', 'sector')).join(',\n')}
FROM temp.ratios_base r;
CREATE UNIQUE INDEX company_ratios_pk ON company_ratios(cik, calendar_year);
DROP TABLE temp.ratios_base;

DROP TABLE IF EXISTS company_scores;
CREATE TABLE company_scores AS
WITH x AS (
  SELECT
    a.cik, a.ticker, a.name, a.sector, a.industry, a.sic, a.calendar_year, a.filing_url,
    COALESCE(a.sic BETWEEN 6000 AND 6799, 0) AS is_financial,
    -- Piotroski components (1/0, NULL when inputs are missing)
    CASE WHEN a.net_income IS NULL OR a.total_assets IS NULL THEN NULL WHEN a.net_income / a.total_assets > 0 THEN 1 ELSE 0 END AS f_positive_roa,
    CASE WHEN a.operating_cash_flow IS NULL THEN NULL WHEN a.operating_cash_flow > 0 THEN 1 ELSE 0 END AS f_positive_cfo,
    CASE WHEN a.net_income IS NULL OR a.total_assets IS NULL OR p.net_income IS NULL OR p.total_assets IS NULL THEN NULL
         WHEN a.net_income / a.total_assets > p.net_income / p.total_assets THEN 1 ELSE 0 END AS f_improving_roa,
    CASE WHEN a.operating_cash_flow IS NULL OR a.net_income IS NULL THEN NULL WHEN a.operating_cash_flow > a.net_income THEN 1 ELSE 0 END AS f_cash_beats_earnings,
    CASE WHEN a.total_assets IS NULL OR p.total_assets IS NULL THEN NULL
         WHEN COALESCE(a.long_term_debt, 0) / a.total_assets < COALESCE(p.long_term_debt, 0) / p.total_assets
           OR (COALESCE(a.long_term_debt, 0) = 0 AND COALESCE(p.long_term_debt, 0) = 0) THEN 1 ELSE 0 END AS f_lower_leverage,
    CASE WHEN a.current_assets IS NULL OR a.current_liabilities IS NULL OR p.current_assets IS NULL OR p.current_liabilities IS NULL
           OR a.current_liabilities = 0 OR p.current_liabilities = 0 THEN NULL
         WHEN a.current_assets / a.current_liabilities > p.current_assets / p.current_liabilities THEN 1 ELSE 0 END AS f_better_liquidity,
    CASE WHEN a.shares_diluted IS NULL OR p.shares_diluted IS NULL THEN NULL WHEN a.shares_diluted <= p.shares_diluted THEN 1 ELSE 0 END AS f_no_dilution,
    CASE WHEN COALESCE(a.gross_profit, a.revenue - a.cost_of_revenue) IS NULL OR COALESCE(p.gross_profit, p.revenue - p.cost_of_revenue) IS NULL
           OR COALESCE(a.revenue, 0) <= 0 OR COALESCE(p.revenue, 0) <= 0 THEN NULL
         WHEN COALESCE(a.gross_profit, a.revenue - a.cost_of_revenue) / a.revenue > COALESCE(p.gross_profit, p.revenue - p.cost_of_revenue) / p.revenue THEN 1 ELSE 0 END AS f_better_gross_margin,
    CASE WHEN a.revenue IS NULL OR p.revenue IS NULL OR COALESCE(a.total_assets, 0) <= 0 OR COALESCE(p.total_assets, 0) <= 0 THEN NULL
         WHEN a.revenue / a.total_assets > p.revenue / p.total_assets THEN 1 ELSE 0 END AS f_better_asset_turnover,
    -- Altman Z'' inputs
    (a.current_assets - a.current_liabilities) / NULLIF(a.total_assets, 0) AS z_x1,
    a.retained_earnings / NULLIF(a.total_assets, 0) AS z_x2,
    a.operating_income / NULLIF(a.total_assets, 0) AS z_x3,
    a.stockholders_equity / NULLIF(a.total_liabilities, 0) AS z_x4,
    -- Beneish components (raw; NULL when inputs are missing)
    (a.receivables / NULLIF(a.revenue, 0)) / NULLIF(p.receivables / NULLIF(p.revenue, 0), 0) AS dsri,
    (COALESCE(p.gross_profit, p.revenue - p.cost_of_revenue) / NULLIF(p.revenue, 0))
      / NULLIF(COALESCE(a.gross_profit, a.revenue - a.cost_of_revenue) / NULLIF(a.revenue, 0), 0) AS gmi,
    (1 - (a.current_assets + a.ppe_net) / NULLIF(a.total_assets, 0)) / NULLIF(1 - (p.current_assets + p.ppe_net) / NULLIF(p.total_assets, 0), 0) AS aqi,
    a.revenue / NULLIF(p.revenue, 0) AS sgi,
    (p.depreciation_amortization / NULLIF(p.depreciation_amortization + p.ppe_net, 0))
      / NULLIF(a.depreciation_amortization / NULLIF(a.depreciation_amortization + a.ppe_net, 0), 0) AS depi,
    (a.sga_expense / NULLIF(a.revenue, 0)) / NULLIF(p.sga_expense / NULLIF(p.revenue, 0), 0) AS sgai,
    ((a.current_liabilities + COALESCE(a.long_term_debt, 0)) / NULLIF(a.total_assets, 0))
      / NULLIF((p.current_liabilities + COALESCE(p.long_term_debt, 0)) / NULLIF(p.total_assets, 0), 0) AS lvgi,
    (a.net_income - a.operating_cash_flow) / NULLIF(a.total_assets, 0) AS tata,
    COALESCE(a.revenue > 0 AND p.revenue > 0 AND a.total_assets > 0 AND p.total_assets > 0 AND a.net_income IS NOT NULL AND a.operating_cash_flow IS NOT NULL, 0) AS beneish_ok
  FROM annual_financials a
  LEFT JOIN annual_financials p ON p.cik = a.cik AND p.calendar_year = a.calendar_year - 1
), s AS (
  SELECT x.*,
    (f_positive_roa IS NOT NULL) + (f_positive_cfo IS NOT NULL) + (f_improving_roa IS NOT NULL) + (f_cash_beats_earnings IS NOT NULL)
      + (f_lower_leverage IS NOT NULL) + (f_better_liquidity IS NOT NULL) + (f_no_dilution IS NOT NULL)
      + (f_better_gross_margin IS NOT NULL) + (f_better_asset_turnover IS NOT NULL) AS piotroski_available,
    COALESCE(f_positive_roa, 0) + COALESCE(f_positive_cfo, 0) + COALESCE(f_improving_roa, 0) + COALESCE(f_cash_beats_earnings, 0)
      + COALESCE(f_lower_leverage, 0) + COALESCE(f_better_liquidity, 0) + COALESCE(f_no_dilution, 0)
      + COALESCE(f_better_gross_margin, 0) + COALESCE(f_better_asset_turnover, 0) AS piotroski_points,
    CASE WHEN is_financial OR z_x1 IS NULL OR z_x2 IS NULL OR z_x3 IS NULL OR z_x4 IS NULL THEN NULL
         ELSE 6.56 * z_x1 + 3.26 * z_x2 + 6.72 * z_x3 + 1.05 * z_x4 END AS altman_z,
    CASE WHEN is_financial OR NOT beneish_ok THEN NULL ELSE
      -4.84 + 0.920 * COALESCE(dsri, 1) + 0.528 * COALESCE(gmi, 1) + 0.404 * COALESCE(aqi, 1) + 0.892 * sgi
      + 0.115 * COALESCE(depi, 1) - 0.172 * COALESCE(sgai, 1) + 4.679 * tata - 0.327 * COALESCE(lvgi, 1) END AS beneish_m,
    (dsri IS NULL) + (gmi IS NULL) + (aqi IS NULL) + (depi IS NULL) + (sgai IS NULL) + (lvgi IS NULL) AS beneish_imputed
  FROM x
)
SELECT
  cik, ticker, name, sector, industry, sic, calendar_year,
  CASE WHEN piotroski_available >= 8 THEN piotroski_points END AS piotroski_f,
  piotroski_available,
  f_positive_roa, f_positive_cfo, f_improving_roa, f_cash_beats_earnings, f_lower_leverage,
  f_better_liquidity, f_no_dilution, f_better_gross_margin, f_better_asset_turnover,
  ROUND(altman_z, 2) AS altman_z,
  CASE WHEN altman_z IS NULL THEN NULL WHEN altman_z > 2.6 THEN 'safe' WHEN altman_z >= 1.1 THEN 'grey' ELSE 'distress' END AS altman_zone,
  ROUND(beneish_m, 2) AS beneish_m,
  CASE WHEN beneish_m IS NULL THEN NULL WHEN beneish_m > -1.78 THEN 1 ELSE 0 END AS beneish_flag,
  CASE WHEN beneish_m IS NULL THEN NULL ELSE beneish_imputed END AS beneish_imputed,
  ROUND(dsri, 3) AS beneish_dsri, ROUND(gmi, 3) AS beneish_gmi, ROUND(aqi, 3) AS beneish_aqi, ROUND(sgi, 3) AS beneish_sgi,
  ROUND(depi, 3) AS beneish_depi, ROUND(sgai, 3) AS beneish_sgai, ROUND(lvgi, 3) AS beneish_lvgi, ROUND(tata, 4) AS beneish_tata,
  filing_url
FROM s;
CREATE UNIQUE INDEX company_scores_pk ON company_scores(cik, calendar_year);
`;
}

function materialize({ financeDbPath, profilesDbPath, log = console.log }) {
  if (!fs.existsSync(financeDbPath)) return false;
  const started = Date.now();
  const db = new DatabaseSync(financeDbPath);
  try {
    db.exec('PRAGMA journal_mode = WAL');
    db.exec(`ATTACH DATABASE '${profilesDbPath.replace(/'/g, "''")}' AS prof`);
    db.exec('CREATE TABLE IF NOT EXISTS prof.company_profiles (cik INTEGER PRIMARY KEY, sic INTEGER, industry TEXT, sector TEXT, fiscal_year_end TEXT, state_of_incorporation TEXT, fetched_at TEXT)');
    db.exec('BEGIN');
    db.exec(sql());
    db.exec('COMMIT');
    db.exec('DETACH DATABASE prof');
    db.exec('ANALYZE');
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    log(`· Derived tables rebuilt in ${((Date.now() - started) / 1000).toFixed(1)}s`);
    return true;
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch {}
    log(`! Derived tables failed: ${e.message}`);
    throw e;
  } finally { db.close(); }
}

module.exports = { materialize, sql, RANKED };
