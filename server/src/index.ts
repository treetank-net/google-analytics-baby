import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { configFromEnv } from './config.js';
import { PLUGIN_VERSION } from './constants.js';
import { registerAuthTools } from './tools/auth.js';
import { registerReadTools } from './tools/read.js';
import { registerSearchConsoleTools } from './tools/search-console.js';

async function main() {
  const server = new McpServer({
    name: 'google-analytics-baby',
    version: PLUGIN_VERSION,
  }, {
    instructions: [
      'This server is read-only: it reads Google Analytics 4 reports and configuration, and Google Search Console search performance, URL indexing and sitemaps. There are no mutations, no confirmations, no safe words.',
      'Start every investigation with list_analytics_properties to map account ↔ property ↔ linked Google Ads accounts, then pick the right property_id.',
      'For closed-loop ROAS (spend, clicks, CPC, return on ad spend for Google Ads traffic), use get_channel_performance — GA4 carries advertiser cost metrics for linked Ads accounts, so you do not need the Google Ads API.',
      'For anything custom, use run_report with explicit dimensions and metrics; use get_custom_dimensions_and_metrics first if the property defines custom fields.',
      'For organic search (queries, landing pages, CTR, position, indexing), start with list_search_console_sites and pass its exact site_url (sc-domain:example.com and https://www.example.com/ are different properties) to run_search_analytics, inspect_url or list_sitemaps. Load the gsc skill before building a Search Console analysis: data lags 2-3 days, query rows omit anonymized queries, and byPage vs byProperty aggregation changes the totals.',
      'To join Search Console with GA4, key on the landing page: GSC page is a full URL, GA4 landingPage is a path — strip the scheme and host before matching.',
      'If a Search Console tool says access was not granted, the saved authorization predates Search Console support: ask the user to run setup_google_auth again.',
    ].join(' '),
  });

  const cfg = await configFromEnv();

  registerAuthTools(server, cfg);
  registerReadTools(server, cfg);
  registerSearchConsoleTools(server, cfg);

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main();
