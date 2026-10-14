---
name: google-analytics-manual
description: Reference manual for the google-analytics-baby MCP tools - which tool fits a question, what each GA4 and Search Console tool returns and its limits, closed-loop Google Ads cost in GA4, Meta spend joins, filter syntax, quotas and setup. Use when a tool's one-line description is not enough or when choosing between tools.
---

# google-analytics-baby tool manual

Tool descriptions are intentionally one line long. This page holds the rest. Search Console
analysis pitfalls (data lag, anonymized queries, byPage vs byProperty) live in the `gsc` skill.

## Which tool

| Question | Tool |
|---|---|
| Which properties exist, which Ads accounts are linked | `list_analytics_properties` |
| Time zone, currency, streams of one property | `get_property_details` |
| Spend, clicks, CPC, ROAS of Google Ads traffic next to sessions and revenue | `get_channel_performance` |
| Anything else in GA4 | `run_report` (check `get_custom_dimensions_and_metrics` first if the property has custom fields) |
| What is happening right now | `run_realtime_report` (last 30 minutes) |
| Search Console properties | `list_search_console_sites` |
| Organic queries, pages, CTR, position | `run_search_analytics` |
| Is a URL indexed, which canonical did Google pick | `inspect_url` |
| Sitemap status | `list_sitemaps` |

## Reading table output

Every list-shaped tool returns the same TSV layout:

```
# GA4 report · property 123 · last 30d · currency=PLN · showing top 100 of 812 by -sessions
# date=2026-10-01                                   <- columns constant across all rows
# totals (all 812): sessions=18230 purchase_revenue=51234.99 cost=9876.54
source_medium	sessions	total_users	engagement_rate_pct	purchase_revenue	cost
```

- **Column names** are GA4 API names in snake_case (`sessionSourceMedium` would be
  `session_source_medium`), with family aliases: `source_medium` (sessionSourceMedium), `campaign`
  (sessionCampaignName), `channel_group` (sessionDefaultChannelGroup), `views` (screenPageViews),
  and the linked Google Ads metrics `cost` (advertiserAdCost), `clicks` (advertiserAdClicks),
  `impressions` (advertiserAdImpressions), `cpc` (advertiserAdCostPerClick), `roas`
  (returnOnAdSpend). `fields` and `order_by` accept either the column or the API name.
- **Values**: GA4 returns rates as fractions; they come back as percent with a `_pct` suffix
  (`engagement_rate_pct`, `bounce_rate_pct`, also `dau_per_mau_pct`). Money (`TYPE_CURRENCY`
  metrics) has 2 decimals in the property currency from the header. Durations are seconds. Other
  floats: 2 decimals when ≥ 1, else 3 significant digits. Dates are ISO (`date` 20261001 →
  2026-10-01, `yearMonth` → 2026-10).
- **Empty columns are dropped; constant columns move to the second `#` line.**
- **Totals** cover all matching rows, not just the shown ones, and only additive metrics: sessions,
  engaged sessions, views, event count, key events, revenue, cost, clicks, impressions,
  transactions. Users and rates are never summed (re-query without the dimension for a true total).
  GA4 computes them, so they stay correct even where sessions repeat across rows (e.g. by `pagePath`).
- **Header notes** appear only when they apply: `thresholded` (GA4 withheld rows with few users),
  `sampled`, `(other) row` (high-cardinality values grouped), `capped at N` (see min_* below).

### Shaping parameters

| Param | Meaning |
|---|---|
| `fields` | Columns to return (default: all requested) |
| `order_by` | Column, `-column` for descending. Default: the time dimension ascending if there is one, else `-<first metric>`; `get_channel_performance` `-sessions`; `run_search_analytics` `-clicks` (`date` when grouped by date) |
| `limit` | Top-N rows. Default 100 (`get_channel_performance` 50). For GA4 the limit and order go to the API, so only N rows are fetched; the header still says "of M" |
| `summary` | Header and totals only, no rows (GA4 fetches a single row) |
| `min_cost`, `min_clicks`, `min_impressions` | Drop rows below the threshold. GA4: they need the advertiser metric (`advertiserAdCost`, `advertiserAdClicks`, `advertiserAdImpressions`), are sent as a metric filter, and up to 10 000 rows are fetched so totals can be summed over the filtered rows (`capped at` if more match). Search Console: `min_impressions`, `min_clicks` |
| `page`, `page_chars` | Pages of the shaped table, by size (default 12 000 chars, 2 000-100 000) |

## GA4

- **property_id** accepts `123456789` or `properties/123456789`.
- **Dates** accept `YYYY-MM-DD`, `today`, `yesterday`, `NdaysAgo`; `date_range: "last30days"` overrides
  both. GA4 dates are in the property's time zone (see `get_property_details`).
- **run_report** takes GA4 API names (`sessionSourceMedium`, `landingPage`, `sessions`, `keyEvents`,
  `totalRevenue`, `customEvent:<param>` for custom dimensions). `dimension_filter` supports one
  condition: `dim == "value"` (exact) or `dim contains "value"`, both case-insensitive.
- **run_realtime_report** only accepts realtime-compatible dimensions and metrics
  (`unifiedScreenName`, `country`, `deviceCategory`, `activeUsers`, `eventCount`, ...).
- **run_report** always sends an explicit `limit` to the API (it used to fall back to the API's
  10 000-row default). Ask for the answer (`order_by`, `limit`, `summary`) instead of paging.
- **get_channel_performance** groups by `sessionSourceMedium`, `sessionCampaignName` and
  `sessionDefaultChannelGroup`. For traffic from a **linked** Google Ads account GA4 also carries
  `advertiserAdCost`, `advertiserAdClicks`, `advertiserAdCostPerClick` and `returnOnAdSpend`, so
  closed-loop ROAS needs no call to the Google Ads API. Rows from other sources leave those empty.
  Columns: `source_medium`, `campaign`, `channel_group`, `sessions`, `engaged_sessions`, `key_events`,
  `total_revenue`, `cost`, `clicks`, `cpc`, `roas`. `min_cost: 1` keeps only paid Google Ads rows.
- **Meta** does not link cost into GA4: GA4 only has outcomes attributed by source/medium
  (`facebook / cpc`). Take spend from `meta-ads-baby` and join on source/medium.
- **get_property_details** and **get_custom_dimensions_and_metrics** return `#` header lines plus
  TSV sections (data streams; custom dimensions and metrics with the `api_name` to use in run_report,
  e.g. `customEvent:plan_type`, `customUser:tier`).
- **list_analytics_properties** calls the Admin API once per property to read Google Ads links; on
  large accounts narrow it with `account_filter`.

## Search Console

- **site_url** must be exact: `sc-domain:example.com` (Domain property) and
  `https://www.example.com/` (URL prefix) are different properties with different data.
- **list_search_console_sites** with `match_ga4_properties: true` adds GA4 properties whose web
  stream host matches the site. It is a domain hint, not a verified link, and costs one Admin call
  per GA4 property.
- **run_search_analytics**: dates are Pacific Time; the API keeps 16 months. One search `type`
  per query; run separate queries to compare web, image and discover. The API returns at most
  25 000 rows per call, sorted by clicks (by date ascending when grouped by date); `start_row`
  fetches the next batch. `hour` needs `data_state: hourly_all`.
- **inspect_url** reports the indexed version, not a live test. Quota: 2 000 inspections per
  property per day. Mobile usability is deprecated by Google and usually empty.
- **list_sitemaps** shows URLs submitted per content type; Google no longer reports indexed counts
  there, so use `inspect_url` for indexing.

## Setup and updates

- `setup_google_auth` opens a browser for one consent covering Analytics and Search Console. A
  token saved before Search Console support covers Analytics only: Search Console tools then say
  access was not granted, and the fix is to run `setup_google_auth` again.
- `update_plugin` downloads the new bundle and skills. A running server cannot swap its own bundle,
  so the new version activates after a session restart; the tool reports the installed and the
  running version separately.
