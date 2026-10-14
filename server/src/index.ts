import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { configFromEnv } from './config.js';
import { PLUGIN_VERSION } from './constants.js';
import { registerAuthTools } from './tools/auth.js';
import { registerReadTools } from './tools/read.js';
import { registerSearchConsoleTools } from './tools/search-console.js';
import { compactToolListing } from './tools/compact-listing.js';
import { SERVER_INSTRUCTIONS } from './instructions.js';

async function main() {
  const server = new McpServer({
    name: 'google-analytics-baby',
    version: PLUGIN_VERSION,
  }, {
    instructions: SERVER_INSTRUCTIONS,
  });

  const cfg = await configFromEnv();

  registerAuthTools(server, cfg);
  registerReadTools(server, cfg);
  registerSearchConsoleTools(server, cfg);
  compactToolListing(server);

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main();
