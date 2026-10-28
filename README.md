# Nexus Transform

Describe a financial data transformation in plain English. Claude drafts the SQL over **live public data** (SEC EDGAR filings, U.S. Treasury exchange rates, FRED rates), attaches every assumption to the SQL line it affects, and a human decides: **accept, edit or reject**. Every step is recorded in an audit log that labels AI actions separately from human ones.

This is the working version of the *AI Transformation Builder* case study on iamryanfoss.com.

## What's real

| Piece | How it works |
|---|---|
| Data | Pulled at first boot from SEC EDGAR (company list + XBRL "frames"), Treasury Fiscal Data (quarterly FX), and FRED (yields, fed funds, CPI, unemployment). Refreshed weekly. Provenance is shown on the Data sources page. |
| SQL generation | Claude via the Messages API, forced to answer through a `propose_transformation` tool: SQL, plain-English summary, confidence, and `{line, note, severity}` assumptions. |
| Self-repair | Every draft is compiled against the live schema. If SQLite rejects it, the error goes back to Claude once and the repair is logged. |
| Confidence | Shown as **model-reported**, next to **system checks** the server computes independently (parses against schema, row count, columns that are mostly null, truncation). |
| Safety | Only single `SELECT`/`WITH` statements; the finance DB is opened read-only in a worker thread that is killed after 4 seconds. |
| Versions & diff | AI drafts, human edits and AI revisions are numbered versions with a line diff between any two. |
| Audit log | Requested, generated, repaired, edited, accepted, rejected, blocked — with actor and status. Exportable as CSV. Scoped to each browser session. |

No dependencies: Node 22's built-in `node:sqlite`, `http`, `fetch` and `worker_threads`.

## Run locally

```bash
# Offline, with placeholder data and a mock AI (for UI work)
npm run dev:mock            # http://localhost:8080

# Real data + real Claude
export ANTHROPIC_API_KEY=sk-ant-...
export SEC_USER_AGENT="Your Name your@email.com"   # SEC requires a contact in the User-Agent
npm run load-data           # ~3–5 min, writes data/finance.db
npm start
```

## Deploy to Fly.io

```bash
fly launch --no-deploy                       # keep the existing fly.toml; pick an app name
fly volumes create nexus_data --size 1 --region bos
fly secrets set ANTHROPIC_API_KEY=sk-ant-... SEC_USER_AGENT="Your Name your@email.com"
fly deploy
```

The first boot builds the dataset in the background (a banner shows progress). Later boots reuse it from the volume.

## Settings (env vars)

| Variable | Default | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | — | Required for generation |
| `ANTHROPIC_MODEL` | `claude-sonnet-5-5` | Model used for SQL generation |
| `SEC_USER_AGENT` | — | Required for EDGAR tables |
| `MAX_GENERATIONS_PER_HOUR` | 25 | Per browser session |
| `MAX_DAILY_GENERATIONS` | 400 | Whole server — caps your API spend |
| `DATA_REFRESH_DAYS` | 7 | Rebuild data when older than this |

## Known limits

- `financials` uses SEC calendar-year frames, not fiscal years. The AI is told this and should flag it.
- Companies that report revenue under a less common XBRL tag will show `NULL` revenue.
- Treasury rates are quarterly, so this is not a daily FX source.

## Tests

```bash
node test/build-fixture-db.js
MOCK_AI=1 SKIP_DATA_LOAD=1 PORT=8099 node --no-warnings server.js &
BASE=http://localhost:8099 npm test
```
