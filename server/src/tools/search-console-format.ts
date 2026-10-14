import type { WebStreamSummary } from '../client.js';
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

export function siteRows(sites: GscSiteEntry[], streams?: WebStreamSummary[]): Record<string, unknown>[] {
  return [...sites]
    .sort((a, b) => (a.siteUrl || '').localeCompare(b.siteUrl || ''))
    .map((site) => {
      const siteUrl = site.siteUrl || '';
      const row: Record<string, unknown> = {
        site_url: siteUrl,
        kind: siteKind(siteUrl),
        permission: site.permissionLevel || '',
      };
      if (streams) {
        const matched = streams.filter((stream) => siteMatchesStream(siteUrl, stream.defaultUri));
        row.ga4_properties = [...new Set(matched.map((stream) => `${stream.property} ${stream.displayName}`.trim()))].join(' ~ ');
      }
      return row;
    });
}

function round(value: unknown, digits: number): unknown {
  return typeof value === 'number' && Number.isFinite(value) ? Number(value.toFixed(digits)) : value;
}

export function searchAnalyticsRows(dimensions: GscDimension[], response: GscSearchAnalyticsResponse): Record<string, unknown>[] {
  return (response.rows || []).map((row) => {
    const out: Record<string, unknown> = {};
    dimensions.forEach((dimension, i) => { out[dimension] = row.keys?.[i] ?? ''; });
    out.clicks = row.clicks ?? 0;
    out.impressions = row.impressions ?? 0;
    out.ctr = round(row.ctr ?? 0, 4);
    out.position = round(row.position ?? 0, 2);
    return out;
  });
}

export function searchAnalyticsHeader(siteUrl: string, request: SearchAnalyticsRequest, response: GscSearchAnalyticsResponse): string[] {
  const fetched = response.rows?.length ?? 0;
  const rowLimit = request.rowLimit ?? 0;
  const startRow = request.startRow ?? 0;
  const lines = [
    `# Search Console ${request.type} for ${siteUrl}, ${request.startDate}..${request.endDate} (Pacific Time)`,
    `dimensions: ${request.dimensions.length ? request.dimensions.join(', ') : '(none — one total row)'}; aggregation: ${response.responseAggregationType || request.aggregationType || 'auto'}; data_state: ${request.dataState || 'final'}; rows fetched: ${fetched} from start_row ${startRow}.`,
    'ctr is a fraction (0.0312 = 3.12%); position is the average position (1 = top).',
  ];
  if (request.filters.length) {
    lines.push(`filters (AND): ${request.filters.map((filter) => `${filter.dimension} ${filter.operator} "${filter.expression}"`).join('; ')}`);
  }
  if (response.metadata?.first_incomplete_date) lines.push(`Data from ${response.metadata.first_incomplete_date} onward is incomplete and may still change.`);
  if (response.metadata?.first_incomplete_hour) lines.push(`Data from ${response.metadata.first_incomplete_hour} onward is incomplete and may still change.`);
  if (rowLimit && fetched >= rowLimit) {
    lines.push(`row_limit ${rowLimit} reached — more rows may exist in the API. Call again with start_row: ${startRow + fetched} to fetch the next batch.`);
  }
  if (request.dimensions.includes('query')) {
    lines.push('Rows with the query dimension omit anonymized queries, so they add up to less than the property total.');
  }
  return lines;
}

function count(value: unknown): unknown {
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  return value ?? '';
}

export function sitemapRows(sitemaps: GscSitemap[]): Record<string, unknown>[] {
  return sitemaps.map((sitemap) => ({
    path: sitemap.path || '',
    type: sitemap.type || '',
    is_index: sitemap.isSitemapsIndex ?? false,
    is_pending: sitemap.isPending ?? false,
    last_submitted: sitemap.lastSubmitted || '',
    last_downloaded: sitemap.lastDownloaded || '',
    errors: count(sitemap.errors ?? 0),
    warnings: count(sitemap.warnings ?? 0),
    submitted_urls: (sitemap.contents || []).map((content) => `${content.type || '?'}:${count(content.submitted ?? 0)}`).join(' ~ '),
  }));
}

function keyValueRows(pairs: Array<[string, unknown]>): Record<string, unknown>[] {
  return pairs
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([field, value]) => ({ field, value: Array.isArray(value) ? value.join(' ~ ') : value }));
}

function canonicalVerdict(googleCanonical?: string, userCanonical?: string): string | undefined {
  if (!googleCanonical || !userCanonical) return undefined;
  return googleCanonical === userCanonical ? 'same' : 'DIFFERENT — Google chose another canonical than the page declares';
}

export function inspectionSections(result: any): Array<[string, unknown[]]> {
  const index = result?.indexStatusResult ?? {};
  const sections: Array<[string, unknown[]]> = [[
    'index status',
    keyValueRows([
      ['verdict', index.verdict],
      ['coverage_state', index.coverageState],
      ['indexing_state', index.indexingState],
      ['robots_txt_state', index.robotsTxtState],
      ['page_fetch_state', index.pageFetchState],
      ['last_crawl_time', index.lastCrawlTime],
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
      rich_result_type: detected.richResultType || '',
      item: item.name || '',
      issues: (item.issues || []).map((issue: any) => `${issue.severity || ''} ${issue.issueMessage || ''}`.trim()).join(' ~ '),
    }));
  });
  if (result?.richResultsResult) {
    sections.push([`rich results (verdict ${result.richResultsResult.verdict || '?'})`, richItems]);
  }

  if (result?.mobileUsabilityResult) {
    const mobile = result.mobileUsabilityResult;
    sections.push([
      `mobile usability (verdict ${mobile.verdict || '?'}; deprecated by Google, may be empty)`,
      (mobile.issues || []).map((issue: any) => ({ issue: issue.issueType || '', message: issue.message || '' })),
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
  const lines = [`# URL Inspection: ${inspectionUrl} (property ${siteUrl})`];
  if (!result?.richResultsResult) lines.push('No rich results detected on this URL.');
  if (result?.inspectionResultLink) lines.push(`Open in Search Console: ${result.inspectionResultLink}`);
  lines.push('This is the indexed (Google) version, not a live test. Quota: 2000 inspections per site per day.');
  return lines;
}
