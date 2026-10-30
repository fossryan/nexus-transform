# Nexus Transform

Describe a financial question in plain English. Claude drafts the SQL over **live public data**, attaches every assumption to the SQL line it affects, and a human decides: **accept, edit or reject**. Every step is recorded in an audit log that labels AI actions separately from human ones.

This is the working version of the *AI Transformation Builder* case study on iamryanfoss.com.

## What's in the data

| Area | Tables | Source | Refresh |
|---|---|---|---|
| Fundamentals | `annual_financials` (27 metrics: income, cash flow, balance sheet, shares, EPS), `quarterly_financials` | SEC EDGAR XBRL frames | Weekly |
| Ratios & peer ranks | `company_ratios` — margins, growth, FCF, coverage, leverage, ROE, dilution, cash runway, percentile vs industry and sector | Derived | After each load |
| Scores | `company_scores` — Piotroski F, Altman Z″, Beneish M with every component | Derived | After each load |
| Sectors | `company_profiles` — SIC industry, sector, fiscal year-end | SEC submissions | Background fill, then weekly |
| Red-flag events | `filing_events` — 8-K items (restatements, auditor changes, impairments, bankruptcy…) | SEC submissions | With profiles |
| Insider trading | `insider_trades` — open-market buys/sells, last 8 quarters | SEC Insider Transactions Data Sets (Form 4) | Daily check for new quarters |
| Fund holdings | `fund_holdings`, `fund_position_changes` — top ~150 managers, last 2 periods | SEC Form 13F Data Sets | Daily check |
| Prices & valuation | `prices`, `price_history`, `valuation` (market cap, P/E, EV/EBIT, FCF yield, returns) | Finnhub (your key) | Daily, largest ~1,000 companies |
| Macro | `econ_observations` — yields, fed funds, CPI, unemployment, credit spreads, breakevens, VIX, oil, dollar, GDP, mortgages | FRED | Weekly |
| FX | `fx_rates` | U.S. Treasury | Weekly |

Every company-level row carries a `filing_url` back to its SEC filing. If a refresh comes back much smaller than the data it would replace (a source was down), the previous data is kept.

## Features

- **Builder** — plain English → SQL with line-level assumptions, model-reported confidence next to independent system checks, self-repair, versions, diff, accept/edit/reject.
- **Charts** — line charts for time series, bar charts for rankings; the AI suggests one, with a fallback that picks from the columns.
- **Explain results** — an AI read of what stands out in the rows, with caveats. Cached per version so re-opening is free.
- **Insights** — 11 predefined scans (margin collapse, cash runway, debt surge, Beneish flags, Altman distress, Piotroski 8–9, insider cluster buying, red-flag 8-Ks, dilution, new fund positions, quality at a reasonable price). Plain SQL, no AI cost; open any as a reviewable transformation.
- **Monitors** — watch an accepted transformation; it re-runs when data refreshes and flags new rows.
- **Audit log** — requested, generated, repaired, edited, accepted, rejected, explained, scans opened, monitors created. CSV export.

No dependencies: Node 22's built-in `node:sqlite`, `http`, `fetch`, `zlib` and `worker_threads`.

## Deploy (Fly.io)

```bash
fly volumes list -a nexus-transform                                 # note the volume id
fly volumes extend <volume-id> --size 3 -a nexus-transform          # full dataset needs ~1–1.5 GB plus room to rebuild
fly secrets set ANTHROPIC_API_KEY=sk-ant-... SEC_USER_AGENT="Your Name your@email.com" FINNHUB_API_KEY=... -a nexus-transform
fly deploy -a nexus-transform
```

First boot: core data ~10–15 min, then sectors/8-K events (~15 min), insider + 13F files, and prices (~35 min) fill in the background. Banners show progress; everything already loaded is usable meanwhile.

### Disk space

A full volume no longer takes the app down (`lib/disk.js`, tested by `npm run test:disk`):

- **Startup** removes temp files from interrupted jobs, keeps a 64 MB `.space-reserve` file it can release in an emergency, and if `app.db` still can't open, runs on temporary in-memory storage (work saved then is lost on restart). Finance data is read in SQLite's immutable mode when the disk is too full to read normally.
- **Background jobs** check free space before they start and skip the run (retrying every 6 hours) instead of filling the disk. A rebuild needs about 1.3× `finance.db`; SEC ownership files need ~400 MB; plus `MIN_FREE_MB` always kept free.
- **Data → Background data jobs** shows a *Storage* line with free space and any paused jobs. If it's red, run `fly volumes extend`, then restart the machine.

## Settings (env vars)

| Variable | Default | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | — | Required for generation and explanations |
| `ANTHROPIC_MODEL` | `claude-sonnet-5-5` | Model used |
| `SEC_USER_AGENT` | — | Required for all SEC data (SEC asks for a name and contact email) |
| `FINNHUB_API_KEY` | — | Enables prices and the `valuation` view. Check Finnhub's terms for public display |
| `FINNHUB_MAX_COMPANIES` | 1000 | How many of the largest companies get prices |
| `MAX_GENERATIONS_PER_HOUR` | 25 | Per browser session (generations + explanations) |
| `MAX_DAILY_GENERATIONS` | 400 | Whole server — caps API spend |
| `DATA_REFRESH_DAYS` | 7 | Rebuild core data when older than this |
| `MIN_FREE_MB` | 250 | Free space (MB) background jobs always leave on the volume |
| `QUERY_TIMEOUT_MS` | 8000 | Per-query time limit |

## Known limits

- Fundamentals use SEC calendar-year frames, not fiscal years (`fiscal_year_end` lets you check).
- Companies that use uncommon XBRL tags show `NULL` for that metric.
- Q4 income figures are often missing in quarterly data; derive as annual minus Q1–Q3.
- Sectors use SEC SIC codes (older and coarser than GICS).
- 13F lists issuer names and CUSIPs, not tickers; matching to companies is by name.
- Altman and Beneish don't apply to banks and insurers and are left `NULL` for SIC 6000–6799.
- Price history starts the day prices are enabled and grows daily.

## Tests

```bash
npm run fixtures                                   # builds every database from placeholder fixtures
MOCK_AI=1 SKIP_DATA_LOAD=1 PORT=8099 npm start &
BASE=http://localhost:8099 npm test                # end-to-end API test

node test/fake-anthropic.js 8111 &                 # stand-in API enforcing Sonnet 5.5 rules
ANTHROPIC_API_KEY=test ANTHROPIC_BASE_URL=http://localhost:8111 SKIP_DATA_LOAD=1 PORT=8098 npm start &
BASE=http://localhost:8098 FAKE=http://localhost:8111 npm run test:api
```
