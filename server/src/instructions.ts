export const SERVER_INSTRUCTIONS = [
  'Read-only Google Analytics 4 and Search Console: no mutations, no confirmations.',
  'property_id is the GA4 property id from list_analytics_properties (start there: it maps accounts, properties and linked Google Ads ids).',
  'site_url is the exact Search Console property from list_search_console_sites; sc-domain:x.com and https://www.x.com/ are different properties.',
  'Dates: YYYY-MM-DD, today, yesterday or NdaysAgo; date_range (last7days, last28days) overrides start_date/end_date.',
  'Google Ads spend and ROAS for linked accounts come from get_channel_performance; no Ads API needed.',
  'Search Console data is in Pacific Time and lags 2-3 days; join it with GA4 landingPage on the URL path.',
  'If a Search Console tool says access was not granted, run setup_google_auth again.',
  'List tools return paginated TSV: page: N gets the next slice, page_chars changes the page size.',
  'Load the google-analytics-manual skill for tool details and the gsc skill before a Search Console analysis.',
].join(' ');
