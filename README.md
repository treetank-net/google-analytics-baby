# google-analytics-baby

Read-only MCP server for Google Analytics 4. Member of the Treetank `*-baby` plugin family
(alongside `google-ads-baby` and `meta-ads-baby`).

List your GA4 properties, run reports, and get closed-loop channel performance — including
Google Ads cost, clicks, CPC and ROAS pulled straight from the GA4 Data API for linked Ads
accounts, with no call to the Ads API.

**Read-only by design.** No mutations, no confirmations, no safe words. Reading reports does
not spend budget, so the family's two-phase mutation safety has nothing to protect here.

## Setup

1. Install the plugin from the marketplace.
2. Run `setup_google_auth` — it opens a browser, you sign in with Google and grant
   read-only Analytics access. The refresh token is saved automatically.

## Tools

- `list_analytics_properties` — map account ↔ property ↔ linked Google Ads accounts. Start here.
- `get_property_details` — config for one property (time zone, currency, data streams, Ads links).
- `run_report` — generic GA4 Data API report (dimensions, metrics, date range, filter).
- `run_realtime_report` — last 30 minutes of activity.
- `get_custom_dimensions_and_metrics` — custom fields defined on a property.
- `get_channel_performance` — closed-loop ROAS per source/medium/campaign.

See `CLAUDE.md` for architecture and `ROADMAP.md` for what's implemented.
