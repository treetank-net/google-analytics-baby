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
    'List all Google Analytics 4 properties the authorized user can access, grouped by account, including linked Google Ads accounts. Start here to map account ↔ property ↔ Ads links before any report.',
    {
      account_filter: z.string().optional().describe('Optional account resource name or display name substring to filter by'),
    },
    async ({ account_filter }) => handleRead(cfg, () => listPropertySummaries(cfg, account_filter)),
  );

  server.tool(
    'get_property_details',
    'Get configuration details for a single GA4 property: time zone, currency, industry, data streams, and linked Google Ads accounts.',
    {
      property_id: z.string().describe('GA4 property ID (numeric, e.g. "123456789") or resource name (e.g. "properties/123456789")'),
    },
    async ({ property_id }) => handleRead(cfg, () => getPropertyDetails(cfg, property_id)),
  );

  server.tool(
    'run_report',
    'Run a generic GA4 Data API report. Specify dimensions, metrics and a date range. Returns dimension/metric rows.',
    {
      property_id: z.string().describe('GA4 property ID or resource name'),
      dimensions: z.array(z.string()).default([]).describe('GA4 dimension API names, e.g. ["sessionSourceMedium", "date"]'),
      metrics: z.array(z.string()).min(1).describe('GA4 metric API names, e.g. ["sessions", "conversions", "totalRevenue"]'),
      date_range: z.string().optional().describe('Named range, e.g. "last7days", "last30days". If set, overrides start_date/end_date.'),
      start_date: z.string().optional().describe('ISO date (YYYY-MM-DD) or relative like "7daysAgo"'),
      end_date: z.string().optional().describe('ISO date (YYYY-MM-DD) or "today"'),
      limit: z.number().int().positive().optional().describe('Max rows to return'),
      dimension_filter: z.string().optional().describe('Optional filter expression on a dimension, e.g. sessionSourceMedium == "google / cpc"'),
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
    'Run a GA4 realtime report (last 30 minutes of activity). Specify realtime dimensions and metrics.',
    {
      property_id: z.string().describe('GA4 property ID or resource name'),
      dimensions: z.array(z.string()).default([]).describe('Realtime dimension API names, e.g. ["unifiedScreenName"]'),
      metrics: z.array(z.string()).min(1).describe('Realtime metric API names, e.g. ["activeUsers"]'),
      limit: z.number().int().positive().optional().describe('Max rows to return'),
    },
    async (input) => handleRead(cfg, () => runRealtimeReport(cfg, input.property_id, {
      dimensions: input.dimensions,
      metrics: input.metrics,
      limit: input.limit,
    })),
  );

  server.tool(
    'get_custom_dimensions_and_metrics',
    'List the custom dimensions and custom metrics configured on a GA4 property so they can be used in run_report.',
    {
      property_id: z.string().describe('GA4 property ID or resource name'),
    },
    async ({ property_id }) => handleRead(cfg, () => getCustomDimensionsAndMetrics(cfg, property_id)),
  );

  server.tool(
    'get_channel_performance',
    'Closed-loop channel performance. Returns per source/medium/campaign: sessions, conversions, revenue and engagement. For traffic from a LINKED Google Ads account it additionally returns advertiserAdCost, advertiserAdClicks, advertiserAdCostPerClick and returnOnAdSpend — a complete ROAS picture straight from the GA4 Data API, with no call to the Ads API. Note: for Meta, GA4 only has outcomes attributed by source/medium (e.g. "facebook / cpc"); spend must be joined from meta-ads-baby and correlated on source/medium.',
    {
      property_id: z.string().describe('GA4 property ID or resource name'),
      days: z.number().int().positive().default(30).describe('Lookback window in days'),
    },
    async ({ property_id, days }) => handleRead(cfg, () => getChannelPerformance(cfg, property_id, days)),
  );
}
