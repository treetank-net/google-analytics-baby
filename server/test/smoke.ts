import {
  GoogleApiError,
  buildSearchAnalyticsBody,
  classifyGoogleApiError,
  normalizeSiteUrl,
  resolveGscDate,
  searchAnalyticsProblems,
  searchAnalyticsQueryRequest,
  sitemapsListRequest,
  todayInSearchConsoleTimeZone,
  urlInspectionRequest,
  type SearchAnalyticsRequest,
} from '../src/search-console.js';
import { formatError } from '../src/errors.js';
import { flattenRow, paginate, pageNote, toTsv, trimPrecision, tsvDocument } from '../src/tools/format.js';
import {
  searchAnalyticsHeader,
  searchAnalyticsRows,
  siteMatchesStream,
  siteRows,
  sitemapRows,
} from '../src/tools/search-console-format.js';
import { resolveSearchAnalyticsDates } from '../src/tools/search-console.js';
import { GA_SCOPES, GSC_SCOPE } from '../src/constants.js';

let passed = 0;
let failed = 0;

function assert(name: string, condition: boolean, detail = '') {
  if (condition) {
    console.log(`  OK  ${name}`);
    passed++;
  } else {
    console.log(`  FAIL  ${name}${detail ? ': ' + detail : ''}`);
    failed++;
  }
}

function throws(fn: () => unknown): boolean {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
}

function baseRequest(overrides: Partial<SearchAnalyticsRequest> = {}): SearchAnalyticsRequest {
  return {
    startDate: '2026-09-01',
    endDate: '2026-09-28',
    dimensions: ['query'],
    filters: [],
    type: 'web',
    ...overrides,
  };
}

function testScopes() {
  console.log('\n--- Scopes ---');
  assert('GSC scope requested in OAuth flow', GA_SCOPES.includes(GSC_SCOPE));
  assert('analytics scope kept', GA_SCOPES.includes('https://www.googleapis.com/auth/analytics.readonly'));
}

function testErrorClassification() {
  console.log('\n--- Google API error classification ---');

  const scope = classifyGoogleApiError(403, {
    error: {
      code: 403,
      message: 'Request had insufficient authentication scopes.',
      status: 'PERMISSION_DENIED',
      details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'ACCESS_TOKEN_SCOPE_INSUFFICIENT' }],
    },
  });
  assert('insufficient scope (ErrorInfo reason)', scope.problem === 'insufficient_scope', scope.problem);
  assert('reasons collected', scope.reasons.includes('ACCESS_TOKEN_SCOPE_INSUFFICIENT') && scope.reasons.includes('PERMISSION_DENIED'));

  const scopeHeader = classifyGoogleApiError(403, { error: { message: 'Forbidden' } }, 'Bearer realm="https://accounts.google.com/", error="insufficient_scope"');
  assert('insufficient scope (WWW-Authenticate)', scopeHeader.problem === 'insufficient_scope', scopeHeader.problem);

  const disabled = classifyGoogleApiError(403, {
    error: {
      message: 'Google Search Console API has not been used in project 1087611320734 before or it is disabled.',
      status: 'PERMISSION_DENIED',
      details: [{
        reason: 'SERVICE_DISABLED',
        metadata: { activationUrl: 'https://console.developers.google.com/apis/api/searchconsole.googleapis.com/overview?project=1087611320734' },
      }],
    },
  });
  assert('api disabled', disabled.problem === 'api_disabled', disabled.problem);
  assert('activation url extracted', disabled.activationUrl?.includes('searchconsole.googleapis.com') === true);

  const site = classifyGoogleApiError(403, {
    error: { message: "User does not have sufficient permission for site 'https://example.com/'.", errors: [{ reason: 'forbidden' }] },
  });
  assert('site permission', site.problem === 'site_permission', site.problem);

  const revoked = classifyGoogleApiError(401, { error: { message: 'Invalid Credentials', status: 'UNAUTHENTICATED' } });
  assert('auth revoked', revoked.problem === 'auth_revoked', revoked.problem);

  const quota = classifyGoogleApiError(429, { error: { message: 'Quota exceeded', status: 'RESOURCE_EXHAUSTED' } });
  assert('quota', quota.problem === 'quota', quota.problem);

  const raw = classifyGoogleApiError(500, 'Internal error\n<html>');
  assert('non-JSON body → other with text message', raw.problem === 'other' && raw.message.startsWith('Internal error'));

  const empty = classifyGoogleApiError(502, undefined);
  assert('empty body → HTTP status message', empty.message === 'HTTP 502');

  assert('formatError: scope → re-run setup_google_auth', formatError(scope).includes('setup_google_auth'));
  assert('formatError: api disabled → activation url', formatError(disabled).includes('searchconsole.googleapis.com'));
  assert('formatError: site permission → list_search_console_sites hint', formatError(site).includes('list_search_console_sites'));
  assert('formatError: other → status', formatError(new GoogleApiError('boom', 500, 'other')).includes('500'));
}

function testSiteUrls() {
  console.log('\n--- Site URLs ---');
  assert('domain property lowercased', normalizeSiteUrl(' sc-domain:Example.COM ') === 'sc-domain:example.com');
  assert('url prefix gets trailing slash', normalizeSiteUrl('https://www.example.com') === 'https://www.example.com/');
  assert('url prefix with path untouched', normalizeSiteUrl('https://example.com/blog') === 'https://example.com/blog');
  assert('bare host rejected', throws(() => normalizeSiteUrl('example.com')));

  const sitemaps = sitemapsListRequest('sc-domain:example.com', 'https://example.com/sitemap_index.xml');
  assert('sitemaps url encodes site', sitemaps.url.includes('/sites/sc-domain%3Aexample.com/sitemaps?sitemapIndex=https%3A%2F%2Fexample.com%2Fsitemap_index.xml'), sitemaps.url);

  const inspection = urlInspectionRequest('https://example.com', ' https://example.com/a ', 'pl');
  const body = inspection.body as Record<string, unknown>;
  assert('inspection body', body.siteUrl === 'https://example.com/' && body.inspectionUrl === 'https://example.com/a' && body.languageCode === 'pl');
  assert('inspection without language omits field', !('languageCode' in (urlInspectionRequest('sc-domain:example.com', 'https://example.com/').body as object)));
}

function testSearchAnalyticsBody() {
  console.log('\n--- searchAnalytics.query body ---');

  const minimal = buildSearchAnalyticsBody(baseRequest({ dimensions: [] }));
  assert('defaults rowLimit/startRow', minimal.rowLimit === 1000 && minimal.startRow === 0);
  assert('no dimensions → field omitted', !('dimensions' in minimal));
  assert('no filters → field omitted', !('dimensionFilterGroups' in minimal));
  assert('optional fields omitted', !('dataState' in minimal) && !('aggregationType' in minimal));

  const full = buildSearchAnalyticsBody(baseRequest({
    dimensions: ['page', 'query'],
    filters: [
      { dimension: 'country', operator: 'equals', expression: ' POL ' },
      { dimension: 'device', operator: 'equals', expression: 'mobile' },
      { dimension: 'query', operator: 'includingRegex', expression: 'Buty|Sneakers' },
    ],
    dataState: 'all',
    aggregationType: 'byPage',
    rowLimit: 25000,
    startRow: 25000,
  }));
  const groups = full.dimensionFilterGroups as Array<{ groupType: string; filters: Array<{ expression: string }> }>;
  assert('dimensions passed in order', JSON.stringify(full.dimensions) === '["page","query"]');
  assert('one AND group', groups.length === 1 && groups[0].groupType === 'and' && groups[0].filters.length === 3);
  assert('country normalized lowercase', groups[0].filters[0].expression === 'pol');
  assert('device normalized uppercase', groups[0].filters[1].expression === 'MOBILE');
  assert('query expression untouched', groups[0].filters[2].expression === 'Buty|Sneakers');
  assert('dataState/aggregation/paging passed', full.dataState === 'all' && full.aggregationType === 'byPage' && full.rowLimit === 25000 && full.startRow === 25000);

  const request = searchAnalyticsQueryRequest('https://example.com', baseRequest());
  assert('query endpoint POST', request.method === 'POST' && request.url.endsWith('/sites/https%3A%2F%2Fexample.com%2F/searchAnalytics/query'), request.url);
}

function testSearchAnalyticsValidation() {
  console.log('\n--- searchAnalytics validation ---');
  assert('valid request has no problems', searchAnalyticsProblems(baseRequest()).length === 0);
  assert('bad date format', searchAnalyticsProblems(baseRequest({ startDate: '2026/09/01' })).length === 1);
  assert('end before start', searchAnalyticsProblems(baseRequest({ startDate: '2026-09-10', endDate: '2026-09-01' })).some((p) => p.includes('before')));
  assert('repeated dimension', searchAnalyticsProblems(baseRequest({ dimensions: ['query', 'query'] })).some((p) => p.includes('repeated')));
  assert('byProperty + page dimension', searchAnalyticsProblems(baseRequest({ dimensions: ['page'], aggregationType: 'byProperty' })).length === 1);
  assert('byProperty + page filter', searchAnalyticsProblems(baseRequest({
    aggregationType: 'byProperty',
    filters: [{ dimension: 'page', operator: 'contains', expression: '/blog/' }],
  })).length === 1);
  assert('byProperty + discover', searchAnalyticsProblems(baseRequest({ type: 'discover', aggregationType: 'byProperty' })).length === 1);
  assert('hour without hourly_all', searchAnalyticsProblems(baseRequest({ dimensions: ['hour'] })).length === 1);
  assert('hour with hourly_all', searchAnalyticsProblems(baseRequest({ dimensions: ['hour'], dataState: 'hourly_all' })).length === 0);
  assert('byNewsShowcasePanel needs news type + filter', searchAnalyticsProblems(baseRequest({ aggregationType: 'byNewsShowcasePanel' })).length === 1);
  assert('byNewsShowcasePanel valid', searchAnalyticsProblems(baseRequest({
    type: 'discover',
    dimensions: [],
    aggregationType: 'byNewsShowcasePanel',
    filters: [{ dimension: 'searchAppearance', operator: 'equals', expression: 'NEWS_SHOWCASE' }],
  })).length === 0);
}

function testDates() {
  console.log('\n--- Dates ---');
  assert('today in Pacific Time', todayInSearchConsoleTimeZone(new Date('2026-10-14T05:00:00Z')) === '2026-10-13');
  assert('ISO date passes through', resolveGscDate('2026-01-31', '2026-10-14') === '2026-01-31');
  assert('yesterday', resolveGscDate('Yesterday', '2026-03-01') === '2026-02-28');
  assert('NdaysAgo crosses year', resolveGscDate('14daysAgo', '2026-01-05') === '2025-12-22');
  assert('garbage rejected', throws(() => resolveGscDate('last week', '2026-10-14')));

  const named = resolveSearchAnalyticsDates({ date_range: 'last28days', start_date: '2020-01-01' }, '2026-10-14');
  assert('date_range overrides explicit dates', named.startDate === '2026-09-16' && named.endDate === '2026-10-14');
  const defaults = resolveSearchAnalyticsDates({}, '2026-10-14');
  assert('default range 28daysAgo..today', defaults.startDate === '2026-09-16' && defaults.endDate === '2026-10-14');
  assert('bad date_range rejected', throws(() => resolveSearchAnalyticsDates({ date_range: 'thisMonth' }, '2026-10-14')));
}

function testFormat() {
  console.log('\n--- TSV format ---');
  assert('flattenRow nests with dots', JSON.stringify(flattenRow({ a: { b: 1 }, c: [1, 2] })) === '{"a.b":1,"c":"1 ~ 2"}');
  assert('flattenRow object arrays as JSON', flattenRow({ x: [{ y: 1 }] }).x === '[{"y":1}]');
  assert('trimPrecision', trimPrecision(0.123456789) === 0.123457 && trimPrecision(5) === 5);

  const tsv = toTsv([{ a: 1, b: 'x\ty' }, { a: 2, c: null }]);
  assert('columns are union in first-seen order', tsv.split('\n')[0] === 'a\tb\tc', tsv);
  assert('tabs in cells replaced', tsv.split('\n')[1] === '1\tx y\t');
  assert('null renders empty', tsv.split('\n')[2] === '2\t\t');
  assert('empty rows → empty string', toTsv([]) === '');

  const doc = tsvDocument([['rows', []]], ['# head']);
  assert('tsvDocument header + empty section', doc.startsWith('# head\n\n## rows (0)'));

  const rows = Array.from({ length: 500 }, (_, i) => ({ query: `query number ${i} with some padding`, clicks: i }));
  const first = paginate(rows, 1, 4000);
  assert('paginate splits by size', first.pages > 1 && first.rows.length < 500);
  assert('paginate page fits budget', toTsv(first.rows).length <= 4000, String(toTsv(first.rows).length));
  const last = paginate(rows, 999, 4000);
  assert('paginate clamps to last page', last.page === last.pages && last.to === 500);
  assert('pageNote points to next page', pageNote(first, 'rows')?.includes('page: 2') === true);
  assert('pageNote silent for one page', pageNote(paginate(rows.slice(0, 2), 1), 'rows') === undefined);
}

function testSearchConsoleFormat() {
  console.log('\n--- Search Console formatting ---');
  const response = { rows: [{ keys: ['buty', 'https://example.com/buty'], clicks: 10, impressions: 300, ctr: 0.0333333, position: 4.56789 }] };
  const [row] = searchAnalyticsRows(['query', 'page'], response);
  assert('rows keyed by dimension', row.query === 'buty' && row.page === 'https://example.com/buty');
  assert('ctr/position rounded', row.ctr === 0.0333 && row.position === 4.57);

  const header = searchAnalyticsHeader('sc-domain:example.com', baseRequest({ rowLimit: 1, startRow: 0 }), response).join('\n');
  assert('header warns about row_limit reached', header.includes('start_row: 1'));
  assert('header warns about anonymized queries', header.includes('anonymized'));

  assert('domain site matches subdomain stream', siteMatchesStream('sc-domain:example.com', 'https://shop.example.com'));
  assert('url prefix matches www-less stream', siteMatchesStream('https://www.example.com/', 'https://example.com'));
  assert('different domain does not match', !siteMatchesStream('sc-domain:example.com', 'https://notexample.com'));

  const sites = siteRows(
    [{ siteUrl: 'sc-domain:b.com', permissionLevel: 'siteOwner' }, { siteUrl: 'https://a.com/', permissionLevel: 'siteFullUser' }],
    [{ property: 'properties/1', displayName: 'A', defaultUri: 'https://www.a.com' }],
  );
  assert('sites sorted and kinded', sites[0].site_url === 'https://a.com/' && sites[0].kind === 'url-prefix' && sites[1].kind === 'domain');
  assert('ga4 match column', sites[0].ga4_properties === 'properties/1 A' && sites[1].ga4_properties === '');
  assert('no streams → no ga4 column', !('ga4_properties' in siteRows([{ siteUrl: 'sc-domain:b.com' }])[0]));

  const [sitemap] = sitemapRows([{ path: 'https://a.com/sitemap.xml', errors: '2', contents: [{ type: 'web', submitted: '120' }] }]);
  assert('sitemap counts parsed', sitemap.errors === 2 && sitemap.warnings === 0 && sitemap.submitted_urls === 'web:120');
}

function main() {
  testScopes();
  testErrorClassification();
  testSiteUrls();
  testSearchAnalyticsBody();
  testSearchAnalyticsValidation();
  testDates();
  testFormat();
  testSearchConsoleFormat();

  console.log(`\n--- Results: ${passed} passed, ${failed} failed ---`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
