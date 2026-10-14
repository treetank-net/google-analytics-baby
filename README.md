# google-analytics-baby

Read-only MCP server for Google Analytics 4 and Google Search Console. Member of the Treetank `*-baby` plugin family
(alongside `google-ads-baby` and `meta-ads-baby`).

List your GA4 properties, run reports, and get closed-loop channel performance — including
Google Ads cost, clicks, CPC and ROAS pulled straight from the GA4 Data API for linked Ads
accounts, with no call to the Ads API. Read Google Search Console in the same session: queries,
landing pages, CTR and position, URL indexing and sitemaps — and join them with GA4 on the landing page.

**Read-only by design.** No mutations, no confirmations, no safe words. Reading reports does
not spend budget, so the family's two-phase mutation safety has nothing to protect here.

## Setup

1. Install the plugin from the marketplace.
2. Run `setup_google_auth` — it opens a browser, you sign in with Google and grant
   read-only Analytics and Search Console access (keep both permissions ticked). The refresh
   token is saved automatically.
3. Authorized before Search Console support? Run `setup_google_auth` again — the old token covers
   Analytics only, and Search Console tools will tell you so.

## Tools

- `list_analytics_properties` — map account ↔ property ↔ linked Google Ads accounts. Start here.
- `get_property_details` — config for one property (time zone, currency, data streams, Ads customer ids).
- `run_report` — generic GA4 Data API report (dimensions, metrics, date range, filter), top 100 rows by default.
- `run_realtime_report` — last 30 minutes of activity.
- `get_custom_dimensions_and_metrics` — custom fields defined on a property.
- `get_channel_performance` — closed-loop ROAS per source/medium/campaign.

Search Console:

- `list_search_console_sites` — Search Console properties (Domain vs URL prefix), optionally matched to GA4. Start here.
- `run_search_analytics` — clicks, impressions, CTR, position by query/page/country/device/date.
- `inspect_url` — URL Inspection: index status, canonical, robots, last crawl, rich results.
- `list_sitemaps` — submitted sitemaps with errors and URL counts.

Responses are compact tab-separated tables shaped on the server: short snake_case columns, rates as
`*_pct`, money with 2 decimals in the property currency, constant columns and totals over all matching
rows in `#` header lines. Every table tool takes `fields`, `order_by` (`-sessions` = descending),
`limit`, `summary`, `page` and `page_chars`; `min_cost` / `min_clicks` / `min_impressions` where the
column exists. GA4 reports push the order and limit down to the API.

Tool descriptions are one line each to keep the tool manifest small. The `google-analytics-manual`
skill documents every tool in detail; the `gsc` skill covers Search Console pitfalls (data lag,
anonymized queries, byPage vs byProperty) and analysis recipes.

See `CLAUDE.md` for architecture and `ROADMAP.md` for what's implemented.
