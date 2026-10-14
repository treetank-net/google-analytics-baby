import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { GaConfig } from '../config.js';
import { formatError } from '../errors.js';
import {
  getChannelPerformance,
  getCustomDimensionsAndMetrics,
  getPropertyDetails,
  listPropertySummaries,
  runRealtimeReport,
  runReport,
} from '../client.js';

function missingAuth(cfg: GaConfig): string | null {
  return cfg.refreshToken ? null : 'Error: Missing Google Analytics refresh token. Run setup_google_auth first.';
}

function textResponse(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

function dateRangeFromInput(input: { date_range?: string; start_date?: string; end_date?: string }) {
  if (input.date_range) {
    const normalized = input.date_range.toLowerCase();
    const match = normalized.match(/^last(\d+)days$/);
    if (!match) {
      throw new Error('date_range must look like last7days or last30days');
    }
    return { startDate: `${match[1]}daysAgo`, endDate: 'today' };
  }
  return {
    startDate: input.start_date || '30daysAgo',
    endDate: input.end_date || 'today',
  };
}

async function handleRead(cfg: GaConfig, fn: () => Promise<unknown>) {
  const authError = missingAuth(cfg);
  if (authError) return { content: [{ type: 'text' as const, text: authError }] };
  try {
    return textResponse(await fn());
  } catch (err) {
    return { content: [{ type: 'text' as const, text: formatError(err) }] };
  }
}

export function registerReadTools(server: McpServer, cfg: GaConfig) {
  server.tool(
    'list_analytics_properties',
    'GA4 properties the user can access, with their account and linked Google Ads customer ids; start here.',
    {
      account_filter: z.string().optional().describe('Account id or name substring'),
    },
    async ({ account_filter }) => handleRead(cfg, () => listPropertySummaries(cfg, account_filter)),
  );

  server.tool(
    'get_property_details',
    'One GA4 property\'s configuration: time zone, currency, industry, data streams and linked Google Ads ids.',
    {
      property_id: z.string(),
    },
    async ({ property_id }) => handleRead(cfg, () => getPropertyDetails(cfg, property_id)),
  );

  server.tool(
    'run_report',
    'Custom GA4 report: any dimensions and metrics over a date range, as a table.',
    {
      property_id: z.string(),
      dimensions: z.array(z.string()).default([]).describe('GA4 API names, e.g. ["sessionSourceMedium","date"]'),
      metrics: z.array(z.string()).min(1).describe('GA4 API names, e.g. ["sessions","keyEvents","totalRevenue"]'),
      date_range: z.string().optional(),
      start_date: z.string().optional(),
      end_date: z.string().optional(),
      limit: z.number().int().positive().optional(),
      dimension_filter: z.string().optional().describe('dim == "value" or dim contains "value"'),
    },
    async (input) => handleRead(cfg, () => {
      const { startDate, endDate } = dateRangeFromInput(input);
      return runReport(cfg, input.property_id, {
        dimensions: input.dimensions,
        metrics: input.metrics,
        startDate,
        endDate,
        limit: input.limit,
        dimensionFilter: input.dimension_filter,
      });
    }),
  );

  server.tool(
    'run_realtime_report',
    'GA4 realtime report: activity in the last 30 minutes by realtime dimensions and metrics.',
    {
      property_id: z.string(),
      dimensions: z.array(z.string()).default([]).describe('e.g. ["unifiedScreenName"]'),
      metrics: z.array(z.string()).min(1).describe('e.g. ["activeUsers"]'),
      limit: z.number().int().positive().optional(),
    },
    async (input) => handleRead(cfg, () => runRealtimeReport(cfg, input.property_id, {
      dimensions: input.dimensions,
      metrics: input.metrics,
      limit: input.limit,
    })),
  );

  server.tool(
    'get_custom_dimensions_and_metrics',
    'Custom dimensions and metrics defined on a GA4 property, with the API names run_report accepts.',
    {
      property_id: z.string(),
    },
    async ({ property_id }) => handleRead(cfg, () => getCustomDimensionsAndMetrics(cfg, property_id)),
  );

  server.tool(
    'get_channel_performance',
    'Sessions, conversions, revenue and Google Ads cost/clicks/ROAS per source/medium/campaign for a lookback window.',
    {
      property_id: z.string(),
      days: z.number().int().positive().default(30),
    },
    async ({ property_id, days }) => handleRead(cfg, () => getChannelPerformance(cfg, property_id, days)),
  );
}
