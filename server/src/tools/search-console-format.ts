import type { WebStreamSummary } from '../client.js';
import { isoSeconds, roundTo, snakeCase, type Row } from './table.js';
import type {
  GscDimension,
  GscSearchAnalyticsResponse,
  GscSiteEntry,
  GscSitemap,
  SearchAnalyticsRequest,
} from '../search-console.js';

export type SiteKind = 'domain' | 'url-prefix';

export function siteKind(siteUrl: string): SiteKind {
  return siteUrl.startsWith('sc-domain:') ? 'domain' : 'url-prefix';
}

function hostOf(uri: string): string {
  try {
    return new URL(/^https?:\/\//i.test(uri) ? uri : `https://${uri}`).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function withoutWww(host: string): string {
  return host.replace(/^www\./, '');
}

export function siteHost(siteUrl: string): string {
  return siteKind(siteUrl) === 'domain' ? siteUrl.slice('sc-domain:'.length).toLowerCase() : hostOf(siteUrl);
}

export function siteMatchesStream(siteUrl: string, streamUri: string): boolean {
  const streamHost = hostOf(streamUri);
  const host = siteHost(siteUrl);
  if (!streamHost || !host) return false;
  if (siteKind(siteUrl) === 'domain') return streamHost === host || streamHost.endsWith(`.${host}`);
  return withoutWww(streamHost) === withoutWww(host);
}

export function siteRows(sites: GscSiteEntry[], streams?: WebStreamSummary[]): Row[] {
  return [...sites]
    .sort((a, b) => (a.siteUrl || '').localeCompare(b.siteUrl || ''))
    .map((site) => {
      const siteUrl = site.siteUrl || '';
      const row: Row = {
        site_url: siteUrl,
        kind: siteKind(siteUrl),
        permission: site.permissionLevel || undefined,
      };
      if (streams) {
        const matched = streams.filter((stream) => siteMatchesStream(siteUrl, stream.defaultUri));
        row.ga4_properties = [...new Set(matched.map((stream) => `${stream.property.replace(/^properties\//, '')} ${stream.displayName}`.trim()))].join(' ~ ') || undefined;
      }
      return row;
    });
}

export function searchAnalyticsColumn(dimension: GscDimension): string {
  return snakeCase(dimension);
}

export function searchAnalyticsRows(dimensions: GscDimension[], response: GscSearchAnalyticsResponse): Row[] {
  return (response.rows || []).map((row) => {
    const out: Row = {};
    dimensions.forEach((dimension, i) => { out[searchAnalyticsColumn(dimension)] = row.keys?.[i] || undefined; });
    out.clicks = row.clicks ?? 0;
    out.impressions = row.impressions ?? 0;
    out.ctr_pct = roundTo((row.ctr ?? 0) * 100, 2);
    out.position = roundTo(row.position ?? 0, 1);
    return out;
  });
}

export function searchAnalyticsDefaultOrder(dimensions: GscDimension[]): string {
  if (dimensions.includes('date')) return 'date';
  if (dimensions.includes('hour')) return 'hour';
  return '-clicks';
}

export interface SearchAnalyticsView {
  scope: string[];
  notes: string[];
  totalsLabel: string;
}

export function searchAnalyticsView(siteUrl: string, request: SearchAnalyticsRequest, response: GscSearchAnalyticsResponse, fileCap = false): SearchAnalyticsView {
  const fetched = response.rows?.length ?? 0;
  const rowLimit = request.rowLimit ?? 0;
  const startRow = request.startRow ?? 0;
  const scope = [
    siteUrl,
    ...(request.type !== 'web' ? [`type=${request.type}`] : []),
    `${request.startDate}..${request.endDate} PT`,
    ...(request.dataState && request.dataState !== 'final' ? [`data_state=${request.dataState}`] : []),
    ...(request.aggregationType && request.aggregationType !== 'auto' ? [`aggregation=${request.aggregationType}`] : []),
  ];
  const notes: string[] = [];
  if (request.filters.length) {
    notes.push(`where ${request.filters.map((filter) => `${filter.dimension} ${filter.operator} "${filter.expression}"`).join(' and ')}`);
  }
  const incomplete = response.metadata?.first_incomplete_date || response.metadata?.first_incomplete_hour;
  if (incomplete) notes.push(`incomplete from ${incomplete}`);
  if (rowLimit && fetched >= rowLimit) {
    notes.push(fileCap
      ? `capped at ${fetched} rows; more may exist (start_row: ${startRow + fetched})`
      : `row_limit ${rowLimit} reached; more rows may exist (start_row: ${startRow + fetched})`);
  }
  if (!fetched) notes.push('no rows: check the dates (2-3 day lag), type and filters');
  const anonymized = request.dimensions.includes('query') ? '; anonymized queries excluded' : '';
  return { scope, notes, totalsLabel: `all ${fetched} fetched${startRow ? ` from start_row ${startRow}` : ''}${anonymized}` };
}

function count(value: unknown): number | string | undefined {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  return value === undefined || value === null || value === '' ? undefined : String(value);
}

export function sitemapRows(sitemaps: GscSitemap[]): Row[] {
  return sitemaps.map((sitemap) => ({
    path: sitemap.path || undefined,
    type: sitemap.type || undefined,
    is_index: sitemap.isSitemapsIndex ?? false,
    is_pending: sitemap.isPending ?? false,
    last_submitted: isoSeconds(sitemap.lastSubmitted),
    last_downloaded: isoSeconds(sitemap.lastDownloaded),
    errors: count(sitemap.errors ?? 0),
    warnings: count(sitemap.warnings ?? 0),
    submitted_urls: (sitemap.contents || []).map((content) => `${content.type || '?'}:${count(content.submitted ?? 0)}`).join(' ~ ') || undefined,
  }));
}

function keyValueRows(pairs: Array<[string, unknown]>): Row[] {
  return pairs
    .filter(([, value]) => value !== undefined && value !== null && value !== '' && !(Array.isArray(value) && !value.length))
    .map(([field, value]) => ({ field, value: Array.isArray(value) ? value.join(' ~ ') : String(value) }));
}

function canonicalVerdict(googleCanonical?: string, userCanonical?: string): string | undefined {
  if (!googleCanonical || !userCanonical) return undefined;
  return googleCanonical === userCanonical ? 'same' : 'DIFFERENT';
}

export function inspectionSections(result: any): Array<[string, Row[]]> {
  const index = result?.indexStatusResult ?? {};
  const sections: Array<[string, Row[]]> = [[
    'index status',
    keyValueRows([
      ['verdict', index.verdict],
      ['coverage_state', index.coverageState],
      ['indexing_state', index.indexingState],
      ['robots_txt_state', index.robotsTxtState],
      ['page_fetch_state', index.pageFetchState],
      ['last_crawl_time', isoSeconds(index.lastCrawlTime)],
      ['crawled_as', index.crawledAs],
      ['google_canonical', index.googleCanonical],
      ['user_canonical', index.userCanonical],
      ['canonical_match', canonicalVerdict(index.googleCanonical, index.userCanonical)],
      ['sitemaps', index.sitemap],
      ['referring_urls', index.referringUrls],
    ]),
  ]];

  const richItems = (result?.richResultsResult?.detectedItems ?? []).flatMap((detected: any) => {
    const items = detected.items?.length ? detected.items : [{}];
    return items.map((item: any) => ({
      rich_result_type: detected.richResultType || undefined,
      item: item.name || undefined,
      issues: (item.issues || []).map((issue: any) => `${issue.severity || ''} ${issue.issueMessage || ''}`.trim()).join(' ~ ') || undefined,
    }));
  });
  if (result?.richResultsResult) {
    sections.push([`rich results (verdict ${result.richResultsResult.verdict || '?'})`, richItems]);
  }

  if (result?.mobileUsabilityResult) {
    const mobile = result.mobileUsabilityResult;
    sections.push([
      `mobile usability (verdict ${mobile.verdict || '?'})`,
      (mobile.issues || []).map((issue: any) => ({ issue: issue.issueType || undefined, message: issue.message || undefined })),
    ]);
  }

  if (result?.ampResult) {
    const amp = result.ampResult;
    sections.push(['amp', keyValueRows([
      ['verdict', amp.verdict],
      ['amp_url', amp.ampUrl],
      ['indexing_state', amp.indexingState],
      ['page_fetch_state', amp.pageFetchState],
      ['issues', (amp.issues || []).map((issue: any) => `${issue.severity || ''} ${issue.issueMessage || ''}`.trim())],
    ])]);
  }
  return sections;
}

export function inspectionHeader(siteUrl: string, inspectionUrl: string, result: any): string[] {
  const lines = [`URL inspection · ${inspectionUrl} · ${siteUrl} · indexed version`];
  if (!result?.richResultsResult) lines.push('no rich results detected');
  return lines;
}
