import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { GaConfig } from '../config.js';
import { formatError } from '../errors.js';
import {
  CHANNEL_DIMENSIONS,
  CHANNEL_METRICS,
  getCustomDimensionsAndMetrics,
  getPropertyDetails,
  listPropertySummaries,
  runRealtimeReport,
  runReport,
} from '../client.js';
import {
  customDimensionRows,
  customMetricRows,
  planReport,
  propertyDetailsDocument,
  propertyRows,
  reportColumns,
  reportDocument,
} from './ga-format.js';
import { pagingSchemas, sectionsDocument, shapeSchemas, tableDocument, tableError, thresholdSchemas, type Shape } from './table.js';

const CHANNEL_DEFAULT_LIMIT = 50;

function text(value: string) {
  return { content: [{ type: 'text' as const, text: value }] };
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

export function windowLabel(startDate: string, endDate: string): string {
  const relative = startDate.match(/^(\d+)daysAgo$/);
  return relative && endDate === 'today' ? `last ${relative[1]}d` : `${startDate}..${endDate}`;
}

function bareProperty(property: string): string {
  return property.trim().replace(/^properties\//, '');
}

function shapeOf(input: Shape): Shape {
  const { fields, order_by, limit, min_cost, min_impressions, min_clicks, summary, page, page_chars } = input;
  return { fields, order_by, limit, min_cost, min_impressions, min_clicks, summary, page, page_chars };
}

async function handleRead(cfg: GaConfig, fn: () => Promise<string>) {
  if (!cfg.refreshToken) return text('Error: Missing Google Analytics refresh token. Run setup_google_auth first.');
  try {
    return text(await fn());
  } catch (err) {
    return text(tableError(err) ?? formatError(err));
  }
}

export function registerReadTools(server: McpServer, cfg: GaConfig) {
  server.tool(
    'list_analytics_properties',
    'GA4 properties the user can access, with their account and linked Google Ads customer ids; start here.',
    {
      account_filter: z.string().optional().describe('Account id or name substring'),
      ...pagingSchemas,
    },
    async ({ account_filter, page, page_chars }) => handleRead(cfg, async () => tableDocument({
      title: 'GA4 properties',
      scope: account_filter ? [`account~${account_filter}`] : [],
      rows: propertyRows(await listPropertySummaries(cfg, account_filter)),
      shape: { page, page_chars },
    })),
  );

  server.tool(
    'get_property_details',
    'One GA4 property\'s configuration: time zone, currency, industry, data streams and linked Google Ads ids.',
    {
      property_id: z.string(),
    },
    async ({ property_id }) => handleRead(cfg, async () => {
      const details = await getPropertyDetails(cfg, property_id);
      const doc = propertyDetailsDocument(details.property, details.dataStreams, details.googleAdsLinks);
      return sectionsDocument(doc.header, [['data streams', doc.streams]]);
    }),
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
      dimension_filter: z.string().optional().describe('dim == "value" or dim contains "value"'),
      ...shapeSchemas(),
      ...thresholdSchemas,
    },
    async (input) => handleRead(cfg, async () => {
      const { startDate, endDate } = dateRangeFromInput(input);
      const columns = reportColumns(input.dimensions, input.metrics);
      const plan = planReport(columns, shapeOf(input));
      const response = await runReport(cfg, input.property_id, {
        dimensions: input.dimensions,
        metrics: input.metrics,
        startDate,
        endDate,
        limit: plan.fetchLimit,
        dimensionFilter: input.dimension_filter,
        orderBys: plan.orderBys,
        metricFilter: plan.metricFilter,
        metricAggregations: plan.metricAggregations,
      });
      return reportDocument({
        title: 'GA4 report',
        scope: [
          `property ${bareProperty(input.property_id)}`,
          windowLabel(startDate, endDate),
          ...(input.dimension_filter ? [`where ${input.dimension_filter}`] : []),
        ],
        columns,
        plan,
        response,
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
      ...shapeSchemas(),
    },
    async (input) => handleRead(cfg, async () => {
      const columns = reportColumns(input.dimensions, input.metrics);
      const plan = planReport(columns, shapeOf(input));
      const response = await runRealtimeReport(cfg, input.property_id, {
        dimensions: input.dimensions,
        metrics: input.metrics,
        limit: plan.fetchLimit,
        orderBys: plan.orderBys,
        metricAggregations: plan.metricAggregations,
      });
      return reportDocument({
        title: 'GA4 realtime',
        scope: [`property ${bareProperty(input.property_id)}`, 'last 30 min'],
        columns,
        plan,
        response,
      });
    }),
  );

  server.tool(
    'get_custom_dimensions_and_metrics',
    'Custom dimensions and metrics defined on a GA4 property, with the API names run_report accepts.',
    {
      property_id: z.string(),
    },
    async ({ property_id }) => handleRead(cfg, async () => {
      const { customDimensions, customMetrics } = await getCustomDimensionsAndMetrics(cfg, property_id);
      return sectionsDocument(
        [`custom definitions · property ${bareProperty(property_id)} · dimensions=${customDimensions.length} metrics=${customMetrics.length}`],
        [['custom dimensions', customDimensionRows(customDimensions)], ['custom metrics', customMetricRows(customMetrics)]],
      );
    }),
  );

  server.tool(
    'get_channel_performance',
    'Sessions, key events, revenue and Google Ads cost/clicks/ROAS per source/medium/campaign for a lookback window.',
    {
      property_id: z.string(),
      days: z.number().int().positive().default(30),
      ...shapeSchemas(),
      min_cost: thresholdSchemas.min_cost,
      min_clicks: thresholdSchemas.min_clicks,
    },
    async (input) => handleRead(cfg, async () => {
      const columns = reportColumns(CHANNEL_DIMENSIONS, CHANNEL_METRICS);
      const plan = planReport(columns, shapeOf(input), CHANNEL_DEFAULT_LIMIT, '-sessions');
      const startDate = `${input.days}daysAgo`;
      const response = await runReport(cfg, input.property_id, {
        dimensions: CHANNEL_DIMENSIONS,
        metrics: CHANNEL_METRICS,
        startDate,
        endDate: 'today',
        limit: plan.fetchLimit,
        orderBys: plan.orderBys,
        metricFilter: plan.metricFilter,
        metricAggregations: plan.metricAggregations,
      });
      return reportDocument({
        title: 'channel performance',
        scope: [`property ${bareProperty(input.property_id)}`, windowLabel(startDate, 'today')],
        columns,
        plan,
        response,
      });
    }),
  );
}
