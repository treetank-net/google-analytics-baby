import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { GaConfig } from '../config.js';
import { formatError } from '../errors.js';
import { listWebStreams, type WebStreamSummary } from '../client.js';
import {
  GSC_AGGREGATION_TYPES,
  GSC_DATA_STATES,
  GSC_DEFAULT_ROW_LIMIT,
  GSC_DIMENSIONS,
  GSC_FILTER_DIMENSIONS,
  GSC_FILTER_OPERATORS,
  GSC_MAX_ROW_LIMIT,
  GSC_SEARCH_TYPES,
  inspectSearchConsoleUrl,
  listSearchConsoleSitemaps,
  listSearchConsoleSites,
  normalizeSiteUrl,
  querySearchAnalytics,
  resolveGscDate,
  searchAnalyticsProblems,
  todayInSearchConsoleTimeZone,
  type SearchAnalyticsRequest,
} from '../search-console.js';
import { pagingSchemas, sectionsDocument, shapeSchemas, tableDocument, tableError, thresholdSchemas } from './table.js';
import {
  inspectionHeader,
  inspectionSections,
  searchAnalyticsDefaultOrder,
  searchAnalyticsRows,
  searchAnalyticsView,
  siteRows,
  sitemapRows,
} from './search-console-format.js';

const SEARCH_ANALYTICS_DEFAULT_LIMIT = 100;

type TextResult = { content: Array<{ type: 'text'; text: string }> };

function text(value: string): TextResult {
  return { content: [{ type: 'text', text: value }] };
}

async function handleSearchConsole(cfg: GaConfig, fn: () => Promise<string>): Promise<TextResult> {
  if (!cfg.refreshToken) return text('Error: Missing Google refresh token. Run setup_google_auth first.');
  try {
    return text(await fn());
  } catch (err) {
    return text(tableError(err) ?? formatError(err));
  }
}

const siteUrlSchema = z.string().min(1);

const filterSchema = z.object({
  dimension: z.enum(GSC_FILTER_DIMENSIONS),
  operator: z.enum(GSC_FILTER_OPERATORS).default('equals'),
  expression: z.string().min(1).max(4096)
    .describe('country: ISO alpha-3 (pol); device: DESKTOP|MOBILE|TABLET; regex: RE2'),
});

export function resolveSearchAnalyticsDates(
  input: { date_range?: string; start_date?: string; end_date?: string },
  today = todayInSearchConsoleTimeZone(),
): { startDate: string; endDate: string } {
  if (input.date_range) {
    const match = input.date_range.toLowerCase().match(/^last(\d+)days$/);
    if (!match) throw new Error('date_range must look like last7days or last28days');
    return { startDate: resolveGscDate(`${match[1]}daysAgo`, today), endDate: today };
  }
  return {
    startDate: resolveGscDate(input.start_date || '28daysAgo', today),
    endDate: resolveGscDate(input.end_date || 'today', today),
  };
}

async function safeListWebStreams(cfg: GaConfig): Promise<{ streams?: WebStreamSummary[]; note?: string }> {
  try {
    return { streams: await listWebStreams(cfg) };
  } catch (err) {
    return { note: `GA4 matching skipped: ${formatError(err).replace(/^Error: /, '')}` };
  }
}

export function registerSearchConsoleTools(server: McpServer, cfg: GaConfig) {
  server.tool(
    'list_search_console_sites',
    'Search Console properties the user can access (Domain or URL prefix) with permission level; start here.',
    {
      match_ga4_properties: z.boolean().default(false)
        .describe('Add GA4 properties whose web stream host matches (a hint; slower on many properties)'),
      ...pagingSchemas,
    },
    async ({ match_ga4_properties, page, page_chars }) => handleSearchConsole(cfg, async () => {
      const [sites, ga4] = await Promise.all([
        listSearchConsoleSites(cfg),
        match_ga4_properties ? safeListWebStreams(cfg) : Promise.resolve({} as { streams?: WebStreamSummary[]; note?: string }),
      ]);
      return tableDocument({
        title: 'Search Console properties',
        rows: siteRows(sites, ga4.streams),
        shape: { page, page_chars },
        notes: ga4.note ? [ga4.note] : [],
      });
    }),
  );

  server.tool(
    'run_search_analytics',
    'Search Console clicks, impressions, CTR and average position for one property, grouped by query, page, country, device, date or appearance.',
    {
      site_url: siteUrlSchema,
      dimensions: z.array(z.enum(GSC_DIMENSIONS)).default([])
        .describe('Group-by order, e.g. ["page","query"]; [] = one total row'),
      filters: z.array(filterSchema).default([])
        .describe('Combined with AND; use a regex operator for OR'),
      date_range: z.string().optional(),
      start_date: z.string().optional().describe('Default 28daysAgo'),
      end_date: z.string().optional(),
      type: z.enum(GSC_SEARCH_TYPES).default('web'),
      data_state: z.enum(GSC_DATA_STATES).optional().describe('final (default); all adds fresh data; hourly_all is required by hour'),
      aggregation_type: z.enum(GSC_AGGREGATION_TYPES).optional()
        .describe('auto (default); byProperty = chart totals, not with page; byPage counts each URL'),
      row_limit: z.number().int().min(1).max(GSC_MAX_ROW_LIMIT).default(GSC_DEFAULT_ROW_LIMIT)
        .describe('Rows fetched from the API, sorted by clicks'),
      start_row: z.number().int().min(0).default(0).describe('API offset for the next batch'),
      ...shapeSchemas(),
      min_impressions: thresholdSchemas.min_impressions,
      min_clicks: thresholdSchemas.min_clicks,
    },
    async (input) => handleSearchConsole(cfg, async () => {
      const siteUrl = normalizeSiteUrl(input.site_url);
      const { startDate, endDate } = resolveSearchAnalyticsDates(input);
      const request: SearchAnalyticsRequest = {
        startDate,
        endDate,
        dimensions: input.dimensions,
        filters: input.filters,
        type: input.type,
        dataState: input.data_state,
        aggregationType: input.aggregation_type,
        rowLimit: Math.min(GSC_MAX_ROW_LIMIT, Math.max(input.row_limit, input.limit ?? 0)),
        startRow: input.start_row,
      };
      const problems = searchAnalyticsProblems(request);
      if (problems.length) throw new Error(`invalid Search Analytics request:\n${problems.map((problem) => `  - ${problem}`).join('\n')}`);
      const response = await querySearchAnalytics(cfg, siteUrl, request);
      const view = searchAnalyticsView(siteUrl, request, response);
      const { fields, order_by, limit, summary, page, page_chars, min_impressions, min_clicks } = input;
      return tableDocument({
        title: 'search analytics',
        scope: view.scope,
        rows: searchAnalyticsRows(request.dimensions, response),
        shape: { fields, order_by, limit: limit ?? SEARCH_ANALYTICS_DEFAULT_LIMIT, summary, page, page_chars, min_impressions, min_clicks },
        defaultOrder: searchAnalyticsDefaultOrder(request.dimensions),
        totalsLabel: view.totalsLabel,
        notes: view.notes,
      });
    }),
  );

  server.tool(
    'inspect_url',
    'URL Inspection of one URL as Google indexed it: verdict, coverage, robots, canonical, last crawl, sitemaps and rich results.',
    {
      site_url: siteUrlSchema,
      url: z.string().url().describe('Must belong to site_url'),
      language_code: z.string().optional().describe('BCP-47 for issue messages, e.g. pl'),
    },
    async ({ site_url, url, language_code }) => handleSearchConsole(cfg, async () => {
      const siteUrl = normalizeSiteUrl(site_url);
      const result = await inspectSearchConsoleUrl(cfg, siteUrl, url, language_code);
      return sectionsDocument(inspectionHeader(siteUrl, url, result), inspectionSections(result));
    }),
  );

  server.tool(
    'list_sitemaps',
    'Sitemaps submitted for a Search Console property with status, errors, warnings and submitted URL counts.',
    {
      site_url: siteUrlSchema,
      sitemap_index: z.string().url().optional().describe('List the children of this sitemap index'),
      ...pagingSchemas,
    },
    async ({ site_url, sitemap_index, page, page_chars }) => handleSearchConsole(cfg, async () => {
      const siteUrl = normalizeSiteUrl(site_url);
      return tableDocument({
        title: 'sitemaps',
        scope: [siteUrl, ...(sitemap_index ? [`index ${sitemap_index}`] : [])],
        rows: sitemapRows(await listSearchConsoleSitemaps(cfg, siteUrl, sitemap_index)),
        shape: { page, page_chars },
      });
    }),
  );
}
