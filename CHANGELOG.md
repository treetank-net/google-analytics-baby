# Changelog

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
