import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { configFromEnv } from './config.js';
import { registerAuthTools } from './tools/auth.js';
import { registerReadTools } from './tools/read.js';

async function main() {
  const server = new McpServer({
    name: 'google-analytics-baby',
    version: '0.1.0',
  }, {
    instructions: [
      'This server is read-only: it reads Google Analytics 4 reports and configuration. There are no mutations, no confirmations, no safe words.',
      'Start every investigation with list_analytics_properties to map account ↔ property ↔ linked Google Ads accounts, then pick the right property_id.',
      'For closed-loop ROAS (spend, clicks, CPC, return on ad spend for Google Ads traffic), use get_channel_performance — GA4 carries advertiser cost metrics for linked Ads accounts, so you do not need the Google Ads API.',
      'For anything custom, use run_report with explicit dimensions and metrics; use get_custom_dimensions_and_metrics first if the property defines custom fields.',
    ].join(' '),
  });

  const cfg = await configFromEnv();

  registerAuthTools(server, cfg);
  registerReadTools(server, cfg);

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main();
