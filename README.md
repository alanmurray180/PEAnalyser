# PE Analyser

Dashboard of trailing and forward PE for a basket of stocks and ETFs, at:

- **now** (live prices)
- the **52-week high** and **52-week low**
- user-defined **reference dates** (e.g. COVID low, 2022 peak, tariff low)

Earnings are stored and refreshed on a schedule. Prices are fetched live on each page load and every 60 seconds.

```
GitHub Pages (site/)  ──HTTPS + token──▶  Cloudflare Worker (worker/)  ──▶  Alpha Vantage (primary)
static HTML/JS                            secrets, cron, KV store          FMP (fallback)
```

The API keys stay in Cloudflare. The Pages site holds no secrets.

## How the numbers are built

| Measure | Definition |
|---|---|
| Trailing EPS at date D | Sum of the last four quarterly EPS **reported on or before D**. This is point-in-time: no look-ahead. |
| Forward EPS at date D | Time-weighted EPS for the 12 months after D, built quarter by quarter. Today it uses consensus: explicit quarterly estimates where available, otherwise the fiscal-year estimate less quarters already reported, spread evenly. For historical dates it uses actuals reported since, which is hindsight. Neither provider sells historical consensus snapshots. The tooltip shows what share of the window came from estimates. |
| 52W high/low | Intraday extremes over the trailing 365 days, split-adjusted. If today's live range breaks through one, it moves to today. |
| Reference dates | Close on or before the date. |
| ETF PE | Look-through aggregate earnings of the top `ETF_TOP_N` holdings. Units per ETF share are fixed at the weekly holdings snapshot, and the total is scaled up for the weight covered. This equals a harmonic-mean PE: loss-makers reduce earnings rather than being dropped. It gets less accurate for dates far back, because holdings change. |
| n/m | EPS is zero or negative. |

Toggles on the dashboard:
- **Trailing / Forward / Both**
- **Multiples vs "Now vs point"**: shows how much dearer or cheaper today's multiple is than at each date.
- **Point-in-time EPS vs Current EPS**: "Current EPS" applies today's EPS to each historical price, so it answers "what multiple would a return to that price imply?"

Click a row to see the weekly PE history chart, the quarterly EPS used (actual or consensus) and, for ETFs, the holdings.

## Setup

### 1. Cloudflare Worker

```bash
cd worker
npm install
npx wrangler login
npx wrangler kv namespace create PE_KV        # paste the id into wrangler.toml
npx wrangler secret put AV_API_KEY
npx wrangler secret put FMP_API_KEY
npx wrangler secret put DASHBOARD_TOKEN       # any long random string; you type it into the dashboard once
npx wrangler deploy
```

Then in `wrangler.toml` check these settings:
- `ALLOWED_ORIGINS`: your Pages origin.
- `AV_CALLS_PER_MIN`: your Alpha Vantage per-minute limit, minus a margin.
- `AV_ENTITLEMENT`: `realtime` only if your AV plan includes real-time US data. Otherwise use `delayed` or leave it blank.

**Use the Workers Paid plan ($5/month).** The free plan's 10 ms CPU limit, 50 subrequests and 1,000 KV writes a day are too tight for the scheduled refresh.

Optional: connect the repo in Cloudflare (Workers → Settings → Builds, root directory `worker`) so each push redeploys the Worker. No Cloudflare credentials go into GitHub.

### 2. GitHub Pages

1. Set `apiBase` in `site/config.js` to the Worker URL.
2. Repo → Settings → Pages → Source: **GitHub Actions**.
3. Push to `main`. `.github/workflows/pages.yml` publishes `site/`.
4. Open the page, click **Settings** and enter the `DASHBOARD_TOKEN`. It is stored in that browser only.

### 3. First load

The cron runs every 15 minutes and works through missing data first, within `AV_CALLS_PER_RUN`. The default basket needs about 100 symbols' earnings (ETF holdings included), roughly 200 AV calls. That takes 3–4 cycles (about an hour). **Refresh** queues an extra cycle immediately.

## Data sources and fallbacks

| Data | Primary (Alpha Vantage) | Fallback (FMP `/stable`) |
|---|---|---|
| Quarterly EPS | `EARNINGS` reported EPS (Street basis) | `income-statement` quarterly diluted EPS (GAAP); filing date stands in for the report date |
| Estimates | `EARNINGS_ESTIMATES` (quarter and fiscal year) | `analyst-estimates` annual |
| Daily prices | `TIME_SERIES_DAILY_ADJUSTED`, split-adjusted from raw close × split coefficient (not dividend-adjusted) | `historical-price-eod/full` (split-adjusted) |
| ETF holdings | `ETF_PROFILE` | `etf/holdings` |
| Live quotes | `REALTIME_BULK_QUOTES` (100 per call) | `batch-quote`, then per-symbol `quote` / `GLOBAL_QUOTE` |
| Name/type | | `profile`, then AV `OVERVIEW` / `ETF_PROFILE` |

If actuals and estimates end up coming from different providers, the row is flagged, because GAAP and adjusted bases differ.

## API (all routes need `Authorization: Bearer <DASHBOARD_TOKEN>` if set)

| Method | Path | |
|---|---|---|
| GET | `/api/dashboard` | Snapshot merged with live quotes |
| GET | `/api/symbol/:sym` | PE history, quarters, holdings |
| GET | `/api/config` / `/api/status` | Basket, events / fetch state and last run log |
| POST | `/api/basket` `{symbol, type?}` | Add a symbol (`type`: `stock` or `etf`; auto-detected if omitted) |
| DELETE | `/api/basket/:sym` | Remove a symbol |
| POST | `/api/events` `{date, label}` | Add a reference date |
| DELETE | `/api/events/:date` | Remove a reference date |
| POST | `/api/refresh` `{symbol?}` | Queue a fetch cycle (forces a refresh of `symbol` if given) |

## Development

```bash
cd worker && npm test        # unit tests (maths) + end-to-end test with mocked providers
npx wrangler dev             # local worker; put keys in worker/.dev.vars
```

## Known limitations

- Historical forward PE uses realised earnings (hindsight), as described above.
- Tickers are canonicalised to `BRK-B` style. Non-US listings depend on Alpha Vantage coverage of `EARNINGS` and `EARNINGS_ESTIMATES` for that exchange.
- ETF look-through covers only the top holdings. Coverage is shown, and rows are flagged below 50%. Broad small-cap funds (e.g. IWM) will have low coverage.
- The GitHub Pages site is public. The token keeps the data and your API quota private, but anyone can load the page shell. To restrict the page itself, use a private repo with Pages access control or Cloudflare Access.
