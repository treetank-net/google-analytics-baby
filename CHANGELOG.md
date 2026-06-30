# Changelog

## v0.1.1
- Fix: bundle built without the built-in OAuth app credentials, so the auth flow demanded a custom Client ID/Secret. Restored the shared desktop-app credentials and rebuilt the bundle.

## v0.1.0
Initial skeleton: read-only GA4 MCP server.
- OAuth flow scoped to `analytics.readonly` (separate consent from google-ads-baby).
- Tools (stubs): `list_analytics_properties`, `get_property_details`, `run_report`, `run_realtime_report`, `get_custom_dimensions_and_metrics`, `get_channel_performance`.
- `get_channel_performance` designed for closed-loop ROAS — pulls Google Ads cost/clicks/CPC/ROAS straight from the GA4 Data API for linked Ads accounts.
- Auth tools: `setup_google_auth`, `check_update`.
- No safety layer (read-only): no hooks, no prepare/confirm, no safe word, no mutation audit log.
