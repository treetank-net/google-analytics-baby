# Changelog

## v0.4.0

- **Token diet** (see marketing-context-mcp `docs/response-format-contract.md`): one-line tool descriptions, compact `tools/list`, new `google-analytics-manual` skill.
- GA4 and Search Console responses are TSV with short column names, `*_pct` ratios, header line for constant columns and totals. `run_report` on 500 rows: ~171k → ~5k chars.
- `order_by` and `limit` are sent to the GA4 API (default 100 rows); no request goes out without a limit. Totals use GA's own TOTAL aggregation, additive metrics only.
- Shaping parameters `fields`, `order_by`, `limit`, `summary`, `min_cost`/`min_clicks`/`min_impressions` (Google Ads metrics), `page`/`page_chars`.
- `get_channel_performance` asks for `keyEvents` instead of the renamed `conversions`.

## v0.3.0
- Google Search Console support (read-only, scope `webmasters.readonly`), in the same plugin and OAuth flow as GA4:
  - `list_search_console_sites` — properties with permission level and kind (Domain vs URL prefix); optional matching to GA4 properties by web stream domain.
  - `run_search_analytics` — clicks, impressions, CTR and position by query/page/country/device/date/searchAppearance/hour, with AND filters (regex for alternatives), search type, data state, aggregation type and API paging.
  - `inspect_url` — URL Inspection: index verdict, coverage, robots/noindex, last crawl, Google vs declared canonical, rich results.
  - `list_sitemaps` — submitted sitemaps with errors, warnings and submitted URL counts.
- New `gsc` skill: data lag and Pacific Time dates, anonymized queries, byPage vs byProperty, quotas, joining with GA4 on the landing page, and recipes (cannibalization, CTR drops, striking distance, non-indexed pages, traffic drop triage).
- **Re-consent required for Search Console:** authorizations made before this version cover Analytics only. Search Console tools then say so explicitly; run `setup_google_auth` again. GA4 tools keep working meanwhile.
- Clear errors for a disabled Search Console API (with the activation link), missing site permission, revoked tokens and quota.
- `update_plugin` also downloads `skills/gsc/SKILL.md` and creates missing directories.

## v0.2.1
- `scripts/start-mcp.js` no longer updates the plugin on every start. Updates happen only through `update_plugin`; the wrapper downloads the bundle exactly once, when there is none on disk. A stale `raw.githubusercontent.com` cache used to let a start-up fetch overwrite a freshly installed newer copy with older files.
- `update_plugin` compares versions with semver ordering instead of string inequality, so a copy newer than the update server is left untouched with an explicit message instead of being silently downgraded.
- Downloads are atomic: each file lands in `<name>.download` and is renamed into place, so an interrupted update leaves the previous working file instead of a truncated one.
- `update_plugin` reports the version installed on disk separately from the version the process is actually running. `PLUGIN_VERSION` is compiled into the bundle, so a download that has not been activated yet says so instead of reading as done — a running MCP server cannot swap its own bundle.

## v0.2.0
- Rename the built-in updater tool from `check_update` to `update_plugin` and update docs/bundle references.
- Align release metadata across package manifests, lockfile, and MCP server version.

## v0.1.1
- Fix: bundle built without the built-in OAuth app credentials, so the auth flow demanded a custom Client ID/Secret. Restored the shared desktop-app credentials and rebuilt the bundle.

## v0.1.0
Initial skeleton: read-only GA4 MCP server.
- OAuth flow scoped to `analytics.readonly` (separate consent from google-ads-baby).
- Tools (stubs): `list_analytics_properties`, `get_property_details`, `run_report`, `run_realtime_report`, `get_custom_dimensions_and_metrics`, `get_channel_performance`.
- `get_channel_performance` designed for closed-loop ROAS — pulls Google Ads cost/clicks/CPC/ROAS straight from the GA4 Data API for linked Ads accounts.
- Auth tools: `setup_google_auth`, `check_update`.
- No safety layer (read-only): no hooks, no prepare/confirm, no safe word, no mutation audit log.
