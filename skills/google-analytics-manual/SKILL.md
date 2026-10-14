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

## GA4

- **property_id** accepts `123456789` or `properties/123456789`.
- **Dates** accept `YYYY-MM-DD`, `today`, `yesterday`, `NdaysAgo`; `date_range: "last30days"` overrides
  both. GA4 dates are in the property's time zone (see `get_property_details`).
- **run_report** takes GA4 API names (`sessionSourceMedium`, `landingPage`, `sessions`, `keyEvents`,
  `totalRevenue`, `customEvent:<param>` for custom dimensions). `dimension_filter` supports one
  condition: `dim == "value"` (exact) or `dim contains "value"`, both case-insensitive.
- **run_realtime_report** only accepts realtime-compatible dimensions and metrics
  (`unifiedScreenName`, `country`, `deviceCategory`, `activeUsers`, `eventCount`, ...).
- **get_channel_performance** groups by `sessionSourceMedium`, `sessionCampaignName` and
  `sessionDefaultChannelGroup`. For traffic from a **linked** Google Ads account GA4 also carries
  `advertiserAdCost`, `advertiserAdClicks`, `advertiserAdCostPerClick` and `returnOnAdSpend`, so
  closed-loop ROAS needs no call to the Google Ads API. Rows from other sources leave those empty.
- **Meta** does not link cost into GA4: GA4 only has outcomes attributed by source/medium
  (`facebook / cpc`). Take spend from `meta-ads-baby` and join on source/medium.
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
