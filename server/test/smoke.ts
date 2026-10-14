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
import {
  DEFAULT_TABLE_PAGE_CHARS,
  ShapeError,
  layoutFor,
  sectionsDocument,
  shapeRows,
  snakeCase,
  tableDocument,
  type Row,
} from '../src/tools/table.js';
import {
  customDimensionRows,
  customMetricRows,
  planReport,
  propertyDetailsDocument,
  propertyRows,
  reportColumns,
  reportDocument,
} from '../src/tools/ga-format.js';
import { CHANNEL_DIMENSIONS, CHANNEL_METRICS, buildReportRequest } from '../src/client.js';
import { windowLabel } from '../src/tools/read.js';
import {
  inspectionSections,
  searchAnalyticsDefaultOrder,
  searchAnalyticsRows,
  searchAnalyticsView,
  siteMatchesStream,
  siteRows,
  sitemapRows,
} from '../src/tools/search-console-format.js';
import { resolveSearchAnalyticsDates } from '../src/tools/search-console.js';
import { GA_SCOPES, GSC_SCOPE } from '../src/constants.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerAuthTools } from '../src/tools/auth.js';
import { registerReadTools } from '../src/tools/read.js';
import { registerSearchConsoleTools } from '../src/tools/search-console.js';
import { compactSchema, compactToolListing } from '../src/tools/compact-listing.js';
import { SERVER_INSTRUCTIONS } from '../src/instructions.js';

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

function gaValue(value: string) {
  return { value, oneValue: 'value' };
}

function gaReportResponse(): any {
  const rows: Array<[string, string, string[]]> = [
    ['google / cpc', '20261001', ['1520', '1210', '0.6123456', '4520.5', '187.3333', '1234.567', '812']],
    ['google / organic', '20261001', ['3410', '2988', '0.7012', '9120', '201.5', '0', '0']],
    ['(direct) / (none)', '20261001', ['980', '911', '0.55', '1500.123', '95.01', '0', '0']],
  ];
  return {
    dimensionHeaders: [{ name: 'sessionSourceMedium' }, { name: 'date' }],
    metricHeaders: [
      { name: 'sessions', type: 'TYPE_INTEGER' },
      { name: 'totalUsers', type: 'TYPE_INTEGER' },
      { name: 'engagementRate', type: 'TYPE_FLOAT' },
      { name: 'purchaseRevenue', type: 'TYPE_CURRENCY' },
      { name: 'averageSessionDuration', type: 'TYPE_SECONDS' },
      { name: 'advertiserAdCost', type: 'TYPE_CURRENCY' },
      { name: 'advertiserAdClicks', type: 'TYPE_INTEGER' },
    ],
    rows: rows.map(([source, date, metrics]) => ({
      dimensionValues: [gaValue(source), gaValue(date)],
      metricValues: metrics.map(gaValue),
    })),
    totals: [{
      dimensionValues: [gaValue('RESERVED_TOTAL'), gaValue('RESERVED_TOTAL')],
      metricValues: ['18230', '15011', '0.64', '51234.987', '180.2', '9876.5432', '6021'].map(gaValue),
    }],
    maximums: [],
    minimums: [],
    rowCount: 812,
    metadata: {
      dataLossFromOtherRow: false,
      schemaRestrictionResponse: null,
      currencyCode: 'PLN',
      timeZone: 'Europe/Warsaw',
      emptyReason: '',
      subjectToThresholding: false,
      samplingMetadatas: [],
    },
    propertyQuota: null,
    kind: 'analyticsData#runReport',
  };
}

const REPORT_DIMENSIONS = ['sessionSourceMedium', 'date'];
const REPORT_METRICS = ['sessions', 'totalUsers', 'engagementRate', 'purchaseRevenue', 'averageSessionDuration', 'advertiserAdCost', 'advertiserAdClicks'];

function testTable() {
  console.log('\n--- Table shaping ---');
  assert('snakeCase', snakeCase('sessionSourceMedium') === 'session_source_medium' && snakeCase('customEvent:plan_type') === 'custom_event_plan_type');

  const rows: Row[] = [
    { campaign: 'A', cost: 10, clicks: 5, note: '' },
    { campaign: 'B', cost: 30, clicks: 1, note: '' },
    { campaign: 'C', cost: 20, clicks: 0, note: '' },
  ];
  const shaped = shapeRows(rows, { order_by: '-cost', limit: 2, min_clicks: 1 });
  assert('threshold then order then limit', shaped.rows.map((r) => r.campaign).join() === 'B,A' && shaped.matched === 2, JSON.stringify(shaped.rows));
  assert('totals cover all matching rows, before limit', shaped.totals.cost === 40 && shaped.totals.clicks === 6);
  assert('fields project and order columns', JSON.stringify(shapeRows(rows, { fields: ['cost', 'campaign'] }).columns) === '["cost","campaign"]');
  assert('unknown column is a ShapeError listing columns', (() => {
    try { shapeRows(rows, { order_by: 'spend' }); return false; } catch (err) { return err instanceof ShapeError && err.message.includes('campaign'); }
  })());

  const layout = layoutFor([{ a: 1, b: 'x', c: '' }, { a: 2, b: 'x', c: '' }], ['a', 'b', 'c']);
  assert('empty columns dropped, constant columns hoisted', JSON.stringify(layout.columns) === '["a"]' && layout.constants.b === 'x');

  const doc = tableDocument({ title: 'things', rows, shape: { order_by: '-cost', limit: 1 } });
  const lines = doc.split('\n');
  assert('header declares truncation', lines[0] === '# things · showing top 1 of 3 by -cost', lines[0]);
  assert('totals line labelled with all matching rows', lines[1] === '# totals (all 3): cost=60 clicks=6', lines[1]);
  assert('summary has no table body', !tableDocument({ title: 't', rows, shape: { summary: true } }).includes('\t'));
  assert('summary counts all rows', tableDocument({ title: 't', rows, shape: { summary: true } }).startsWith('# t · rows=3'));

  const many: Row[] = Array.from({ length: 2000 }, (_, i) => ({ query: `query number ${i} with some padding`, clicks: 2000 - i }));
  const page1 = tableDocument({ title: 'q', rows: many });
  assert('default page fits 12k chars', page1.length <= DEFAULT_TABLE_PAGE_CHARS + 300, String(page1.length));
  const note = page1.split('\n').pop() || '';
  assert('page note points to the next page and is short', note.includes('page: 2') && note.length <= 120, note);
  const small = tableDocument({ title: 'q', rows: many, shape: { page: 2, page_chars: 2000 } });
  assert('page_chars and page select a slice', small.includes('# page 2/') && small.length < 2600, String(small.length));

  const sections = sectionsDocument(['head'], [['empty', []], ['full', [{ a: 1 }]]]);
  assert('sections render header, empty and filled sections', sections === '# head\n## empty (0)\n## full (1)\na\n1', sections);
}

function testReportPlan() {
  console.log('\n--- GA4 report plan ---');
  const columns = reportColumns(REPORT_DIMENSIONS, REPORT_METRICS);
  assert('column names are short snake_case with _pct for fractions',
    columns.map((c) => c.column).join() === 'source_medium,date,sessions,total_users,engagement_rate_pct,purchase_revenue,average_session_duration,cost,clicks',
    columns.map((c) => c.column).join());

  const plan = planReport(columns, { order_by: '-sessions' });
  assert('default limit 100 pushed to the API', plan.fetchLimit === 100 && plan.limit === 100);
  assert('order_by pushed down as a metric orderBy', JSON.stringify(plan.orderBys) === '[{"metric":{"metricName":"sessions"},"desc":true}]');
  assert('totals requested from the API', JSON.stringify(plan.metricAggregations) === '["TOTAL"]');

  const byTime = planReport(columns, {});
  assert('time dimension sorts ascending by default', byTime.order === 'date' && JSON.stringify(byTime.orderBys) === '[{"dimension":{"dimensionName":"date"},"desc":false}]');
  assert('API names resolve to columns', planReport(columns, { order_by: '-advertiserAdCost' }).shape.order_by === '-cost');
  assert('summary fetches one row', planReport(columns, { summary: true }).fetchLimit === 1);

  const thresholds = planReport(columns, { min_cost: 5, min_clicks: 2 });
  const filter = thresholds.metricFilter as any;
  assert('min_* pushed down as metricFilter on advertiser metrics',
    filter.andGroup.expressions[0].filter.fieldName === 'advertiserAdCost' && filter.andGroup.expressions[1].filter.numericFilter.value.doubleValue === 2);
  assert('min_* fetches up to the cap and sums totals locally', thresholds.fetchLimit === 10_000 && thresholds.metricAggregations === undefined);
  assert('min_cost without a cost metric is rejected', (() => {
    try { planReport(reportColumns(['date'], ['sessions']), { min_cost: 1 }); return false; } catch (err) { return err instanceof ShapeError; }
  })());

  const request = buildReportRequest('123', { dimensions: ['date'], metrics: ['sessions'], startDate: '7daysAgo', endDate: 'today', limit: 100, orderBys: plan.orderBys, metricAggregations: ['TOTAL'], dimensionFilter: 'sessionSourceMedium == "google / cpc"' }) as any;
  assert('request carries explicit limit, orderBys and aggregations', request.limit === '100' && request.property === 'properties/123' && request.orderBys.length === 1 && request.metricAggregations[0] === 'TOTAL');
  assert('dimension filter translated', request.dimensionFilter.filter.stringFilter.matchType === 'EXACT');
  assert('no metricFilter key when unused', !('metricFilter' in request));
  assert('window label', windowLabel('30daysAgo', 'today') === 'last 30d' && windowLabel('2026-09-01', '2026-09-30') === '2026-09-01..2026-09-30');
}

function testReportDocument() {
  console.log('\n--- GA4 report document ---');
  const columns = reportColumns(REPORT_DIMENSIONS, REPORT_METRICS);
  const plan = planReport(columns, { order_by: '-sessions' });
  const doc = reportDocument({ title: 'GA4 report', scope: ['property 123', 'last 30d'], columns, plan, response: gaReportResponse() });
  const lines = doc.split('\n');
  assert('header: scope, currency, truncation', lines[0] === '# GA4 report · property 123 · last 30d · currency=PLN · showing top 3 of 812 by -sessions', lines[0]);
  assert('constant date hoisted as ISO', lines[1] === '# date=2026-10-01', lines[1]);
  assert('totals from the API, summable metrics only', lines[2] === '# totals (all 812): sessions=18230 purchase_revenue=51234.99 cost=9876.54 clicks=6021', lines[2]);
  assert('columns by name, no repeated keys', lines[3] === 'source_medium\tsessions\ttotal_users\tengagement_rate_pct\tpurchase_revenue\taverage_session_duration\tcost\tclicks', lines[3]);
  assert('first row sorted by -sessions', lines[4].startsWith('google / organic\t3410\t2988\t70.12\t9120\t201.5\t0\t0'), lines[4]);
  assert('rates as pct, money 2 decimals, floats rounded', lines[5] === 'google / cpc\t1520\t1210\t61.23\t4520.5\t187.33\t1234.57\t812', lines[5]);
  assert('no raw API metadata or headers', !/dimensionHeaders|metricHeaders|RESERVED_TOTAL|maximums|kind|oneValue/.test(doc));

  const response = gaReportResponse();
  response.rowCount = 3;
  response.totals = [];
  const thresholdPlan = planReport(columns, { min_cost: 1 });
  const local = reportDocument({ title: 'GA4 report', scope: [], columns, plan: thresholdPlan, response });
  assert('threshold path sums totals locally and declares the filter', local.includes('min_cost=1') && local.includes('sessions=5910'), local.split('\n').slice(0, 3).join(' | '));

  response.rowCount = 20_000;
  const capped = reportDocument({ title: 'GA4 report', scope: [], columns, plan: thresholdPlan, response });
  assert('fetch cap is declared', capped.includes('capped at 3 of 20000') && capped.includes('totals (first 3 fetched)'), capped.split('\n').slice(0, 4).join(' | '));

  const flagged = gaReportResponse();
  flagged.metadata.subjectToThresholding = true;
  flagged.metadata.samplingMetadatas = [{ samplesReadCount: '250000', samplingSpaceSize: '1000000' }];
  const flaggedDoc = reportDocument({ title: 'r', scope: [], columns, plan, response: flagged });
  assert('thresholding and sampling surfaced', flaggedDoc.includes('# thresholded') && flaggedDoc.includes('based on 25% of events'));

  const collided = reportColumns(['sessionSourceMedium', 'sourceMedium'], ['sessions']).map((c) => c.column).join();
  assert('alias yields to the plain name on collision', collided === 'session_source_medium,source_medium,sessions', collided);
  const channelColumns = reportColumns(CHANNEL_DIMENSIONS, CHANNEL_METRICS);
  assert('channel columns use family names', channelColumns.map((c) => c.column).join() === 'source_medium,campaign,channel_group,sessions,engaged_sessions,key_events,total_revenue,cost,clicks,cpc,roas');
}

function testGaConfigFormatting() {
  console.log('\n--- GA4 configuration formatting ---');
  const ts = { seconds: '1614556800', nanos: 0 };
  const [property] = propertyRows([{
    property: 'properties/123', displayName: 'Shop', account: 'accounts/9', accountDisplayName: 'Acme',
    googleAdsLinks: [{ name: 'properties/123/googleAdsLinks/1', customerId: '1234567890', canManageClients: false, adsPersonalizationEnabled: { value: true }, createTime: ts, updateTime: ts, creatorEmailAddress: 'a@b.c' }],
  }]);
  assert('property row with bare ids and Ads customer ids only', JSON.stringify(property) === '{"property_id":"123","property":"Shop","account_id":"9","account":"Acme","ads_customer_ids":"1234567890"}', JSON.stringify(property));

  const details = propertyDetailsDocument(
    { name: 'properties/123', propertyType: 'PROPERTY_TYPE_ORDINARY', createTime: ts, updateTime: ts, parent: 'accounts/9', displayName: 'Shop', industryCategory: 'SHOPPING', timeZone: 'Europe/Warsaw', currencyCode: 'PLN', serviceLevel: 'GOOGLE_ANALYTICS_STANDARD', deleteTime: null, expireTime: null, account: 'accounts/9' },
    [{ name: 'properties/123/dataStreams/55', type: 'WEB_DATA_STREAM', displayName: 'Web', webStreamData: { measurementId: 'G-ABC', firebaseAppId: '', defaultUri: 'https://shop.pl' }, androidAppStreamData: null, iosAppStreamData: null, createTime: ts, updateTime: ts, streamData: 'webStreamData' }],
    [{ customerId: '1234567890' }, { customerId: '1234567890' }],
  );
  const text = sectionsDocument(details.header, [['data streams', details.streams]]);
  assert('property details compact', text.split('\n')[1] === '# time_zone=Europe/Warsaw currency=PLN industry=SHOPPING service_level=STANDARD created=2021-03-01 ads_customer_ids=1234567890', text.split('\n')[1]);
  assert('no {seconds,nanos}, nulls or defaults', !/seconds|nanos|null|ORDINARY|streamData|updateTime/.test(text), text);
  assert('stream row', text.includes('stream_id\ttype\tname\tdefault_uri\tmeasurement_id\tcreated') && text.includes('55\tWEB\tWeb\thttps://shop.pl\tG-ABC\t2021-03-01'), text);

  const dims = customDimensionRows([{ name: 'properties/1/customDimensions/2', parameterName: 'plan', displayName: 'Plan', description: '', scope: 'USER', disallowAdsPersonalization: false }]);
  assert('custom dimension api name by scope', dims[0].api_name === 'customUser:plan' && !('description' in dims[0] && dims[0].description));
  const metrics = customMetricRows([{ parameterName: 'score', displayName: 'Score', scope: 'EVENT', measurementUnit: 'STANDARD', restrictedMetricType: [], description: '' }]);
  assert('custom metric api name, empty restrictions dropped', metrics[0].api_name === 'customEvent:score' && metrics[0].restricted === undefined);
}

function testSearchConsoleFormat() {
  console.log('\n--- Search Console formatting ---');
  const response = {
    rows: [
      { keys: ['buty', 'https://example.com/buty'], clicks: 10, impressions: 300, ctr: 0.0333333, position: 4.56789 },
      { keys: ['sneakers', 'https://example.com/buty'], clicks: 25, impressions: 1200, ctr: 0.0208333, position: 7.04 },
      { keys: ['buty damskie', 'https://example.com/buty'], clicks: 0, impressions: 40, ctr: 0, position: 18.2 },
    ],
    responseAggregationType: 'byPage',
  };
  const rows = searchAnalyticsRows(['query', 'page'], response);
  assert('rows keyed by dimension', rows[0].query === 'buty' && rows[0].page === 'https://example.com/buty');
  assert('ctr as pct, position 1 decimal', rows[0].ctr_pct === 3.33 && rows[0].position === 4.6, JSON.stringify(rows[0]));
  assert('date grouping sorts by date', searchAnalyticsDefaultOrder(['date', 'query']) === 'date' && searchAnalyticsDefaultOrder(['query']) === '-clicks');

  const request = baseRequest({ dimensions: ['query', 'page'], rowLimit: 3, startRow: 0, filters: [{ dimension: 'country', operator: 'equals', expression: 'pol' }] });
  const view = searchAnalyticsView('sc-domain:example.com', request, response);
  assert('row_limit reached points to start_row', view.notes.some((n) => n.includes('start_row: 3')));
  assert('filters in a header note', view.notes[0] === 'where country equals "pol"');
  assert('totals label mentions anonymized queries', view.totalsLabel.includes('anonymized'));

  const doc = tableDocument({ title: 'search analytics', scope: view.scope, rows, shape: { limit: 2, min_impressions: 50 }, defaultOrder: '-clicks', totalsLabel: view.totalsLabel, notes: view.notes });
  const lines = doc.split('\n');
  assert('GSC header', lines[0] === '# search analytics · sc-domain:example.com · 2026-09-01..2026-09-28 PT · min_impressions=50 · rows=2 · by -clicks', lines[0]);
  assert('constant page hoisted', lines[1] === '# page=https://example.com/buty', lines[1]);
  assert('GSC totals summable only', lines[2].startsWith('# totals (all 3 fetched; anonymized queries excluded): clicks=35 impressions=1500'), lines[2]);
  assert('GSC table', lines.includes('query\tclicks\timpressions\tctr_pct\tposition') && lines.includes('sneakers\t25\t1200\t2.08\t7'), doc);

  assert('domain site matches subdomain stream', siteMatchesStream('sc-domain:example.com', 'https://shop.example.com'));
  assert('url prefix matches www-less stream', siteMatchesStream('https://www.example.com/', 'https://example.com'));
  assert('different domain does not match', !siteMatchesStream('sc-domain:example.com', 'https://notexample.com'));

  const sites = siteRows(
    [{ siteUrl: 'sc-domain:b.com', permissionLevel: 'siteOwner' }, { siteUrl: 'https://a.com/', permissionLevel: 'siteFullUser' }],
    [{ property: 'properties/1', displayName: 'A', defaultUri: 'https://www.a.com' }],
  );
  assert('sites sorted and kinded', sites[0].site_url === 'https://a.com/' && sites[0].kind === 'url-prefix' && sites[1].kind === 'domain');
  assert('ga4 match column with bare property id', sites[0].ga4_properties === '1 A' && sites[1].ga4_properties === undefined);
  assert('no streams → no ga4 column', !('ga4_properties' in siteRows([{ siteUrl: 'sc-domain:b.com' }])[0]));

  const [sitemap] = sitemapRows([{ path: 'https://a.com/sitemap.xml', errors: '2', lastSubmitted: '2026-10-01T12:34:56.789Z', contents: [{ type: 'web', submitted: '120' }] }]);
  assert('sitemap counts parsed, timestamps to the second', sitemap.errors === 2 && sitemap.warnings === 0 && sitemap.submitted_urls === 'web:120' && sitemap.last_submitted === '2026-10-01T12:34:56Z', JSON.stringify(sitemap));

  const inspection = inspectionSections({ indexStatusResult: { verdict: 'PASS', coverageState: 'Submitted and indexed', referringUrls: [], googleCanonical: 'https://a.com/x', userCanonical: 'https://a.com/x', lastCrawlTime: '2026-10-01T03:04:05Z' } });
  assert('inspection drops empty arrays, compares canonicals', !inspection[0][1].some((r) => r.field === 'referring_urls') && inspection[0][1].some((r) => r.field === 'canonical_match' && r.value === 'same'));
}

const LISTING_BUDGET_CHARS = 15_000;
const LISTING_PIN_CHARS = 7_500;
const INSTRUCTIONS_BUDGET_CHARS = 2_500;
const TOOL_DESCRIPTION_BUDGET = 200;
const PARAM_DESCRIPTION_BUDGET = 100;

async function listedTools(): Promise<any[]> {
  const server = new McpServer({ name: 'smoke', version: '0.0.0' });
  const cfg = { clientId: '', clientSecret: '', refreshToken: '' };
  registerAuthTools(server, cfg);
  registerReadTools(server, cfg);
  registerSearchConsoleTools(server, cfg);
  compactToolListing(server);
  const handler = (server.server as any)._requestHandlers.get('tools/list');
  const listing = await handler({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }, {});
  return listing.tools;
}

function paramDescriptions(schema: unknown, path: string, out: Array<[string, string]>): void {
  if (Array.isArray(schema)) return schema.forEach((item) => paramDescriptions(item, path, out));
  if (!schema || typeof schema !== 'object') return;
  for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
    if (key === 'description' && typeof value === 'string') out.push([path, value]);
    else paramDescriptions(value, key === 'properties' || key === 'items' ? path : `${path}.${key}`, out);
  }
}

async function testToolListingBudget() {
  console.log('\n--- Tool listing budget ---');
  const compacted = compactSchema({ type: 'object', $schema: 'x', additionalProperties: false, properties: { pattern: { type: 'string', minLength: 1, maxLength: 30 } } }) as any;
  assert('compaction drops validation-only keys', !('$schema' in compacted) && !('additionalProperties' in compacted));
  assert('compaction keeps a property named like a dropped key', compacted.properties.pattern.maxLength === 30 && !('minLength' in compacted.properties.pattern));

  const tools = await listedTools();
  const size = JSON.stringify(tools).length;
  assert(`tools/list within the contract budget ${LISTING_BUDGET_CHARS}`, size <= LISTING_BUDGET_CHARS, `${size} chars`);
  assert(`tools/list pinned at ${LISTING_PIN_CHARS} chars`, size <= LISTING_PIN_CHARS, `${size} chars — trim descriptions or raise the pin deliberately`);
  assert('tools/list carries no taskSupport boilerplate', !tools.some((tool) => tool.execution));
  assert(`server instructions within ${INSTRUCTIONS_BUDGET_CHARS}`, SERVER_INSTRUCTIONS.length <= INSTRUCTIONS_BUDGET_CHARS, String(SERVER_INSTRUCTIONS.length));

  const longTools = tools.filter((tool) => (tool.description ?? '').length > TOOL_DESCRIPTION_BUDGET).map((tool) => `${tool.name} (${tool.description.length})`);
  assert(`every tool description is at most ${TOOL_DESCRIPTION_BUDGET} chars`, longTools.length === 0, longTools.join(', '));
  const params: Array<[string, string]> = [];
  for (const tool of tools) paramDescriptions(tool.inputSchema, tool.name, params);
  const longParams = params.filter(([, text]) => text.length > PARAM_DESCRIPTION_BUDGET).map(([path, text]) => `${path} (${text.length})`);
  assert(`every parameter description is at most ${PARAM_DESCRIPTION_BUDGET} chars`, longParams.length === 0, longParams.join(', '));
}

async function main() {
  testScopes();
  testErrorClassification();
  testSiteUrls();
  testSearchAnalyticsBody();
  testSearchAnalyticsValidation();
  testDates();
  testTable();
  testReportPlan();
  testReportDocument();
  testGaConfigFormatting();
  testSearchConsoleFormat();
  await testToolListingBudget();

  console.log(`\n--- Results: ${passed} passed, ${failed} failed ---`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
