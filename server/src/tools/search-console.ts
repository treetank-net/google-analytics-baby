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
import { pageCharsSchema, pageNote, pageSchema, paginate, tsvDocument } from './format.js';
import {
  inspectionHeader,
  inspectionSections,
  searchAnalyticsHeader,
  searchAnalyticsRows,
  siteRows,
  sitemapRows,
} from './search-console-format.js';

type TextResult = { content: Array<{ type: 'text'; text: string }> };

function text(value: string): TextResult {
  return { content: [{ type: 'text', text: value }] };
}

async function handleSearchConsole(cfg: GaConfig, fn: () => Promise<string>): Promise<TextResult> {
  if (!cfg.refreshToken) return text('Error: Missing Google refresh token. Run setup_google_auth first.');
  try {
    return text(await fn());
  } catch (err) {
    return text(formatError(err));
  }
}

const siteUrlSchema = z.string().min(1)
  .describe('Search Console property exactly as listed by list_search_console_sites: "sc-domain:example.com" (Domain property) or a URL prefix like "https://www.example.com/"');

const filterSchema = z.object({
  dimension: z.enum(GSC_FILTER_DIMENSIONS),
  operator: z.enum(GSC_FILTER_OPERATORS).default('equals'),
  expression: z.string().min(1).max(4096)
    .describe('Value to match. country = ISO 3166-1 alpha-3 (e.g. "pol"); device = DESKTOP | MOBILE | TABLET; regex operators use RE2 syntax'),
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
    'List the Google Search Console properties the authorized user can access, with permission level and property kind (Domain "sc-domain:" vs URL prefix). Start here for any Search Console question — the site_url values are the exact identifiers the other Search Console tools need. Optionally match each property to GA4 properties by web stream domain.',
    {
      match_ga4_properties: z.boolean().default(false)
        .describe('Also list GA4 properties whose web data stream host matches the site (one GA4 Admin call per property — slower on large accounts). The match is a domain hint, not a verified link.'),
      page: pageSchema,
      page_chars: pageCharsSchema,
    },
    async ({ match_ga4_properties, page, page_chars }) => handleSearchConsole(cfg, async () => {
      const [sites, ga4] = await Promise.all([
        listSearchConsoleSites(cfg),
        match_ga4_properties ? safeListWebStreams(cfg) : Promise.resolve({} as { streams?: WebStreamSummary[]; note?: string }),
      ]);
      const rows = siteRows(sites, ga4.streams);
      const slice = paginate(rows, page ?? 1, page_chars);
      const note = pageNote(slice, 'sites');
      const header = [
        '# Search Console properties',
        'permission: siteOwner / siteFullUser / siteRestrictedUser can read data; siteUnverifiedUser cannot.',
        ...(ga4.note ? [ga4.note] : []),
        ...(note ? [note] : []),
      ];
      return tsvDocument([['sites', slice.rows]], header);
    }),
  );

  server.tool(
    'run_search_analytics',
    'Query Google Search Console performance data (clicks, impressions, CTR, average position) for one property, grouped by query/page/country/device/date/searchAppearance. Dates are in Pacific Time and data lags 2-3 days; the API keeps 16 months. Rows with the query dimension omit anonymized queries, so they never add up to the property total. See the gsc skill for aggregation pitfalls and recipes.',
    {
      site_url: siteUrlSchema,
      dimensions: z.array(z.enum(GSC_DIMENSIONS)).default([])
        .describe('Grouping dimensions in order, e.g. ["query"], ["page", "query"], ["date"]. Empty = one total row. "hour" needs data_state hourly_all.'),
      filters: z.array(filterSchema).default([])
        .describe('Filters, all combined with AND (the API has no OR — use a regex operator for alternatives), e.g. [{"dimension":"page","operator":"contains","expression":"/blog/"}]'),
      date_range: z.string().optional().describe('Named range, e.g. "last7days", "last28days", "last90days". If set, overrides start_date/end_date.'),
      start_date: z.string().optional().describe('YYYY-MM-DD, "today", "yesterday" or "NdaysAgo" (Pacific Time). Default 28daysAgo.'),
      end_date: z.string().optional().describe('YYYY-MM-DD, "today", "yesterday" or "NdaysAgo" (Pacific Time). Default today.'),
      type: z.enum(GSC_SEARCH_TYPES).default('web').describe('Search type. One type per query — run separate queries to compare web vs image vs discover.'),
      data_state: z.enum(GSC_DATA_STATES).optional().describe('final (default) = finalized data only; all = include fresh, still-changing data; hourly_all = hourly breakdown (with the hour dimension)'),
      aggregation_type: z.enum(GSC_AGGREGATION_TYPES).optional()
        .describe('auto (default): byProperty unless grouped/filtered by page. byPage counts each URL separately (higher impressions); byProperty counts the site once per search (matches the chart total). byProperty cannot be used with page.'),
      row_limit: z.number().int().min(1).max(GSC_MAX_ROW_LIMIT).default(GSC_DEFAULT_ROW_LIMIT)
        .describe(`Rows fetched from the API (1-${GSC_MAX_ROW_LIMIT}, default ${GSC_DEFAULT_ROW_LIMIT}). Rows come sorted by clicks descending (by date ascending when grouped by date).`),
      start_row: z.number().int().min(0).default(0).describe('Zero-based API offset for fetching the next batch when row_limit was reached'),
      page: pageSchema,
      page_chars: pageCharsSchema,
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
        rowLimit: input.row_limit,
        startRow: input.start_row,
      };
      const problems = searchAnalyticsProblems(request);
      if (problems.length) throw new Error(`invalid Search Analytics request:\n${problems.map((problem) => `  - ${problem}`).join('\n')}`);
      const response = await querySearchAnalytics(cfg, siteUrl, request);
      const rows = searchAnalyticsRows(request.dimensions, response);
      const slice = paginate(rows, input.page ?? 1, input.page_chars);
      const note = pageNote(slice, 'rows');
      const header = searchAnalyticsHeader(siteUrl, request, response);
      if (!rows.length) header.push('No rows. Check the date range (data lags 2-3 days; data_state final hides the freshest days), the type and the filters.');
      return tsvDocument([['rows', slice.rows]], note ? [...header, note] : header);
    }),
  );

  server.tool(
    'inspect_url',
    'Inspect one URL with the Search Console URL Inspection API: index verdict and coverage state, robots.txt and noindex state, page fetch result, last crawl time and crawler, Google-selected vs user-declared canonical, sitemaps listing the URL, referring URLs, rich results, AMP and (deprecated) mobile usability. Reports the indexed version, not a live test. Quota: 2000 inspections per property per day.',
    {
      site_url: siteUrlSchema,
      url: z.string().url().describe('Fully qualified URL to inspect; it must belong to site_url'),
      language_code: z.string().optional().describe('BCP-47 language for issue messages, e.g. "pl" (default en-US)'),
    },
    async ({ site_url, url, language_code }) => handleSearchConsole(cfg, async () => {
      const siteUrl = normalizeSiteUrl(site_url);
      const result = await inspectSearchConsoleUrl(cfg, siteUrl, url, language_code);
      return tsvDocument(inspectionSections(result), inspectionHeader(siteUrl, url, result));
    }),
  );

  server.tool(
    'list_sitemaps',
    'List the sitemaps submitted for a Search Console property: type, index or not, pending, last submitted/downloaded, error and warning counts, and submitted URL counts per content type. Pass sitemap_index to list the children of one sitemap index.',
    {
      site_url: siteUrlSchema,
      sitemap_index: z.string().url().optional().describe('URL of a sitemap index to list its child sitemaps'),
      page: pageSchema,
      page_chars: pageCharsSchema,
    },
    async ({ site_url, sitemap_index, page, page_chars }) => handleSearchConsole(cfg, async () => {
      const siteUrl = normalizeSiteUrl(site_url);
      const rows = sitemapRows(await listSearchConsoleSitemaps(cfg, siteUrl, sitemap_index));
      const slice = paginate(rows, page ?? 1, page_chars);
      const note = pageNote(slice, 'sitemaps');
      const header = [
        `# Sitemaps for ${siteUrl}${sitemap_index ? ` (index ${sitemap_index})` : ''}`,
        'submitted_urls = URLs listed per content type. Google no longer reports indexed counts here — use inspect_url or the Page indexing report.',
        ...(note ? [note] : []),
      ];
      return tsvDocument([['sitemaps', slice.rows]], header);
    }),
  );
}
