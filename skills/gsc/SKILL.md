---
name: gsc
description: Analysing Google Search Console data with run_search_analytics, inspect_url and list_sitemaps — data lag and Pacific Time dates, anonymized queries, byPage vs byProperty totals, row limits and quotas, joining Search Console with GA4 on the landing page, and ready-made recipes (keyword cannibalization, CTR drops, striking-distance queries on positions 5-20, pages that are not indexed). Use before building any organic search / SEO analysis, or when Search Console numbers do not add up.
---

# Search Console for google-analytics-baby

Search Console answers "how does Google show us": impressions, clicks, CTR and average position per
query, page, country, device and date. GA4 answers "what did those visitors do". Most wrong
conclusions come from treating Search Console numbers like GA4 numbers — they are not.

## Pick the property first

`list_search_console_sites` returns the exact `site_url` the other tools need.

- `sc-domain:example.com` is a **Domain property**: every subdomain and both http/https.
- `https://www.example.com/` is a **URL-prefix property**: only that scheme + host + path.
- They are different properties with different data. If both exist, prefer the Domain property
  for site-wide totals and a URL-prefix property only when the question is about that prefix.
- `siteUnverifiedUser` cannot read data. An access error usually means the wrong variant was passed.
- `match_ga4_properties: true` adds GA4 properties whose web stream host matches — a hint, not a link.

## Dates and freshness

- **Dates are in Pacific Time** (America/Los_Angeles), not the property's or the user's time zone.
  A day in Search Console and a day in GA4 cover different hours.
- **Data lags 2-3 days.** With the default `data_state: final` the last days come back empty or low.
  Do not read a drop in the last 3 days as a trend. For the freshest data pass `data_state: all` and
  note the "incomplete from …" line in the response header.
- **History: 16 months.** Older start dates return nothing, not an error.
- Compare equal-length periods aligned on weekdays (28 days vs the previous 28 days), not calendar months.

## Why the numbers never add up

- **Anonymized queries.** Rows grouped by `query` omit rare / privacy-filtered queries. The sum over
  `query` rows is always lower than the total without dimensions — often 30-60% lower on long-tail
  sites. Get totals from a query with `dimensions: []` (or `["date"]`), never by summing query rows.
- **byProperty vs byPage.** `byProperty` counts the site once per search (matches the Search Console
  chart). `byPage` counts every URL shown, so impressions are higher and CTR lower. `auto` switches to
  byPage as soon as you group or filter by `page`. Never compare a page-level total with a site total.
- **Average position is impression-weighted**, and a page-level average mixes many queries. Do not
  average positions across rows; re-query at the grain you need.
- **CTR comes as `ctr_pct`** (3.1 = 3.1%). Recompute aggregated CTR as clicks / impressions, never by
  averaging row CTRs.
- **row_limit caps rows fetched, not data.** The API returns up to 25 000 rows per call, sorted by
  clicks (default 1 000). Totals in the header cover every fetched row; `limit` (default 100),
  `order_by` and `min_impressions` / `min_clicks` only cut what is shown. When the header says
  row_limit was reached, call again with the suggested `start_row`. Long-tail rows with 0 clicks may
  sit beyond what the API ever returns.

## Filters

- All filters are combined with **AND**; there is no OR. Use `includingRegex` / `excludingRegex`
  (RE2 syntax) for alternatives: `{"dimension":"query","operator":"includingRegex","expression":"buty|sneakers"}`.
- Brand vs non-brand: one query with `excludingRegex` on the brand name variants, one with `includingRegex`.
- `country` takes ISO 3166-1 alpha-3 (`pol`, `deu`, `usa`). `device` takes `DESKTOP`, `MOBILE`, `TABLET`.
- `page` filters need the full URL (or `contains` with a path fragment).

## Quotas

- Search Analytics: short-term load quota per site; when exceeded wait ~15 minutes. Prefer one wide
  query (bigger `row_limit`) over many narrow ones.
- URL Inspection: **2000 inspections per property per day**, 600 per minute. Inspect a sample (top
  pages, suspicious pages), never the whole sitemap.

## Joining with GA4

Key on the landing page.

- Search Console `page` is a full URL: `https://www.example.com/buty/?utm=x`.
- GA4 `landingPage` (or `landingPagePlusQueryString`) is a path: `/buty/`.
- Normalize both: drop scheme and host, drop the query string unless you deliberately keep it, unify
  the trailing slash. Then join.
- In GA4 restrict to organic Google: `sessionSourceMedium == "google / organic"` (run_report
  `dimension_filter`). Search Console clicks ≠ GA4 sessions: consent mode, bots, multiple clicks per
  session and the time zone difference all move the numbers. Compare trends and ratios, not absolutes.
- Typical joined view per landing page: impressions, clicks, CTR, position (GSC) + sessions,
  engagement rate, conversions, revenue (GA4).

## Recipes

**Keyword cannibalization** — several URLs competing for one query.
`dimensions: ["query", "page"]`, `row_limit: 25000`, `min_impressions: 50`, `order_by: "query"`,
a large `limit`, last 28-90 days. Group rows by query; flag
queries where 2+ pages each get a meaningful share of impressions (e.g. ≥ 20%) and positions are
close. Check with `inspect_url` which page Google treats as canonical.

**CTR drops** — ranking holds, clicks fall.
Two queries, `dimensions: ["page"]` (or `["query"]`), current vs previous period of the same length.
Flag rows where position changed little (< 1) but CTR fell noticeably with enough impressions.
Usual causes: a SERP feature took the click (check `searchAppearance`), a worse title/snippet, a
competitor's rich result.

**Striking distance** — queries on positions 5-20.
`dimensions: ["query", "page"]`, last 28 days. Keep rows with position 5-20 and impressions above a
threshold; sort by impressions. These are the cheapest wins: improve the page that already ranks,
do not create a new one (that causes cannibalization).

**Pages that are not indexed.**
`list_sitemaps` → check errors and submitted counts. Then `inspect_url` on a sample of important URLs
(top GA4 landing pages, new pages, pages with zero GSC impressions). Read `coverage_state`,
`robots_txt_state`, `indexing_state` (noindex) and `canonical_match` — "Google chose a different
canonical" is the most common silent reason a page gets no traffic.

**Traffic drop triage.**
1. `dimensions: ["date"]` over 90 days — is the drop real, when did it start, impressions or CTR?
2. Same period by `device` and `country` — is it one segment?
3. By `page` before vs after — which URLs lost the most clicks?
4. `inspect_url` on the top losers — de-indexed? canonical changed?
5. GA4 for the same pages — did conversions drop too, or only search visibility?

## Response shape

Responses are tab-separated tables. The `#` header names the property, the date range (Pacific
Time) and any non-default type, data state or aggregation; a second `#` line holds values shared by
every row (e.g. `page=` when filtered to one page); `# totals (all N fetched)` sums clicks and
impressions over every fetched row. Columns: the dimensions, `clicks`, `impressions`, `ctr_pct`,
`position` (1 decimal). Long results are split into pages by response size; pass `page: N` for the
next slice. `page` paginates the rows already fetched; `start_row` fetches the next batch from the API.
