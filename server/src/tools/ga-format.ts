import {
  SUMMABLE_COLUMNS,
  THRESHOLDS,
  parseOrder,
  roundTo,
  significant,
  snakeCase,
  sumColumns,
  timestampDate,
  tableDocument,
  validateShape,
  type Cell,
  type Row,
  type Shape,
} from './table.js';

export const REPORT_DEFAULT_LIMIT = 100;
export const REPORT_FETCH_CAP = 10_000;

const COLUMN_ALIASES: Record<string, string> = {
  sessionSourceMedium: 'source_medium',
  sessionCampaignName: 'campaign',
  sessionDefaultChannelGroup: 'channel_group',
  advertiserAdCost: 'cost',
  advertiserAdClicks: 'clicks',
  advertiserAdImpressions: 'impressions',
  advertiserAdCostPerClick: 'cpc',
  returnOnAdSpend: 'roas',
  screenPageViews: 'views',
};

const TIME_DIMENSIONS = new Set(['date', 'dateHour', 'dateHourMinute', 'yearMonth', 'yearWeek', 'isoYearIsoWeek', 'year', 'month', 'week', 'day', 'hour', 'nthDay', 'nthWeek', 'nthMonth']);
const FRACTION_METRICS = /Rate$|^(dau|wau)Per(Mau|Wau)$/;

export function isFractionMetric(apiName: string): boolean {
  return FRACTION_METRICS.test(apiName.replace(/^custom\w*:/, ''));
}

export function reportColumnName(apiName: string, kind: 'dimension' | 'metric'): string {
  const alias = COLUMN_ALIASES[apiName];
  if (alias) return alias;
  const name = snakeCase(apiName);
  return kind === 'metric' && isFractionMetric(apiName) ? `${name}_pct` : name;
}

export interface ReportColumn {
  api: string;
  column: string;
  kind: 'dimension' | 'metric';
}

export function reportColumns(dimensions: string[], metrics: string[]): ReportColumn[] {
  const requested = [
    ...dimensions.map((api) => ({ api, kind: 'dimension' as const })),
    ...metrics.map((api) => ({ api, kind: 'metric' as const })),
  ];
  const preferred = requested.map(({ api, kind }) => reportColumnName(api, kind));
  const taken = new Set<string>();
  return requested.map(({ api, kind }, i) => {
    let column = preferred[i];
    if (preferred.indexOf(column) !== preferred.lastIndexOf(column) && COLUMN_ALIASES[api]) {
      column = `${snakeCase(api)}${kind === 'metric' && isFractionMetric(api) ? '_pct' : ''}`;
    }
    while (taken.has(column)) column = `${column}_${kind}`;
    taken.add(column);
    return { api, column, kind };
  });
}

export function columnAliases(columns: ReportColumn[]): Record<string, string> {
  return Object.fromEntries(columns.map(({ api, column }) => [api, column]));
}

export function defaultReportOrder(columns: ReportColumn[]): string | undefined {
  const time = columns.find((c) => c.kind === 'dimension' && TIME_DIMENSIONS.has(c.api));
  if (time) return time.column;
  const metric = columns.find((c) => c.kind === 'metric');
  return metric ? `-${metric.column}` : undefined;
}

export interface ReportPlan {
  shape: Shape;
  order?: string;
  limit: number;
  fetchLimit: number;
  hasThresholds: boolean;
  orderBys?: unknown[];
  metricFilter?: unknown;
  metricAggregations?: string[];
}

export function planReport(columns: ReportColumn[], shape: Shape, defaultLimit = REPORT_DEFAULT_LIMIT, defaultOrder = defaultReportOrder(columns)): ReportPlan {
  const available = columns.map((c) => c.column);
  const resolved = validateShape(shape, available, columnAliases(columns));
  const order = resolved.order_by ?? defaultOrder;
  const limit = Math.min(resolved.limit ?? defaultLimit, REPORT_FETCH_CAP);
  const hasThresholds = THRESHOLDS.some(([param]) => resolved[param] !== undefined);
  const byColumn = new Map(columns.map((c) => [c.column, c]));

  let orderBys: unknown[] | undefined;
  if (order) {
    const { column, descending } = parseOrder(order);
    const target = byColumn.get(column);
    if (target) {
      orderBys = [target.kind === 'metric'
        ? { metric: { metricName: target.api }, desc: descending }
        : { dimension: { dimensionName: target.api }, desc: descending }];
    }
  }

  const expressions = THRESHOLDS
    .filter(([param]) => resolved[param] !== undefined)
    .map(([param, column]) => ({
      filter: {
        fieldName: byColumn.get(column)!.api,
        numericFilter: { operation: 'GREATER_THAN_OR_EQUAL', value: { doubleValue: resolved[param] as number } },
      },
    }));
  const metricFilter = expressions.length ? (expressions.length === 1 ? expressions[0] : { andGroup: { expressions } }) : undefined;

  const fetchLimit = hasThresholds ? REPORT_FETCH_CAP : resolved.summary ? 1 : limit;
  return {
    shape: resolved,
    order,
    limit,
    fetchLimit,
    hasThresholds,
    orderBys,
    metricFilter,
    metricAggregations: hasThresholds ? undefined : ['TOTAL'],
  };
}

function metricTypeName(type: unknown): string {
  if (typeof type === 'string') return type;
  return ({ 1: 'TYPE_INTEGER', 2: 'TYPE_FLOAT', 4: 'TYPE_SECONDS', 9: 'TYPE_CURRENCY' } as Record<number, string>)[type as number] ?? 'TYPE_FLOAT';
}

export function formatDimensionValue(api: string, value: unknown): Cell {
  if (value === undefined || value === null || value === '') return undefined;
  const text = String(value);
  if ((api === 'date' || api === 'firstSessionDate') && /^\d{8}$/.test(text)) return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`;
  if (api === 'dateHour' && /^\d{10}$/.test(text)) return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)} ${text.slice(8, 10)}`;
  if (api === 'dateHourMinute' && /^\d{12}$/.test(text)) return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)} ${text.slice(8, 10)}:${text.slice(10, 12)}`;
  if (api === 'yearMonth' && /^\d{6}$/.test(text)) return `${text.slice(0, 4)}-${text.slice(4, 6)}`;
  return text;
}

export function formatMetricValue(api: string, type: unknown, value: unknown): Cell {
  if (value === undefined || value === null || value === '') return undefined;
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value);
  const typeName = metricTypeName(type);
  if (isFractionMetric(api)) return roundTo(n * 100, 2);
  if (typeName === 'TYPE_CURRENCY') return roundTo(n, 2);
  if (typeName === 'TYPE_INTEGER') return Math.round(n);
  return significant(n);
}

export interface ShapedReport {
  rows: Row[];
  totals: Row;
  matched: number;
  currency?: string;
  money: Set<string>;
  notes: string[];
  totalsLabel?: string;
}

function metricRow(columns: ReportColumn[], response: any, raw: any): Row {
  const row: Row = {};
  const metricHeaders = response.metricHeaders || [];
  columns.filter((c) => c.kind === 'metric').forEach((c, i) => {
    row[c.column] = formatMetricValue(c.api, metricHeaders[i]?.type, raw?.metricValues?.[i]?.value);
  });
  return row;
}

export function reportRows(columns: ReportColumn[], response: any): Row[] {
  const dimensions = columns.filter((c) => c.kind === 'dimension');
  return (response.rows || []).map((raw: any) => {
    const row: Row = {};
    dimensions.forEach((c, i) => { row[c.column] = formatDimensionValue(c.api, raw?.dimensionValues?.[i]?.value); });
    return { ...row, ...metricRow(columns, response, raw) };
  });
}

function reportNotes(response: any): string[] {
  const metadata = response.metadata || {};
  const notes: string[] = [];
  if (metadata.subjectToThresholding) notes.push('thresholded: GA4 withheld rows with few users (Google signals)');
  for (const sampling of metadata.samplingMetadatas || []) {
    if (sampling?.samplesReadCount && sampling?.samplingSpaceSize) {
      const pct = roundTo((Number(sampling.samplesReadCount) / Number(sampling.samplingSpaceSize)) * 100, 1);
      notes.push(`sampled: based on ${pct}% of events`);
    }
  }
  if (metadata.dataLossFromOtherRow) notes.push('(other) row: low-volume values were grouped by GA4');
  if (metadata.emptyReason) notes.push(`empty: ${metadata.emptyReason}`);
  return notes;
}

export function shapeReportResponse(columns: ReportColumn[], plan: ReportPlan, response: any): ShapedReport {
  const rows = reportRows(columns, response);
  const metricHeaders = response.metricHeaders || [];
  const money = new Set(columns.filter((c) => c.kind === 'metric')
    .filter((_, i) => metricTypeName(metricHeaders[i]?.type) === 'TYPE_CURRENCY')
    .map((c) => c.column));
  const rowCount = Number(response.rowCount ?? rows.length) || 0;
  const notes = reportNotes(response);
  let totals: Row;
  let totalsLabel: string | undefined;
  if (plan.hasThresholds) {
    totals = sumColumns(rows, columns.map((c) => c.column), money);
    if (rowCount > rows.length) {
      notes.push(`capped at ${rows.length} of ${rowCount} matching rows`);
      totalsLabel = `first ${rows.length} fetched`;
    }
  } else {
    const apiTotals = response.totals?.[0] ? metricRow(columns, response, response.totals[0]) : {};
    totals = Object.fromEntries(Object.entries(apiTotals).filter(([column, value]) => SUMMABLE_COLUMNS.has(column) && value !== undefined));
  }
  return {
    rows,
    totals,
    matched: plan.hasThresholds ? Math.min(rowCount, rows.length) : rowCount,
    currency: money.size ? response.metadata?.currencyCode || undefined : undefined,
    money,
    notes,
    totalsLabel,
  };
}

function bareId(name: unknown): string {
  return typeof name === 'string' ? name.split('/').pop() || '' : '';
}

export function adsCustomerIds(links: any[]): string {
  return [...new Set((links || []).map((link) => link?.customerId).filter(Boolean))].join(' ~ ');
}

export function propertyRows(properties: Array<{ property: string; displayName: string; account: string; accountDisplayName: string; googleAdsLinks: any[] }>): Row[] {
  return properties.map((p) => ({
    property_id: bareId(p.property),
    property: p.displayName || undefined,
    account_id: bareId(p.account),
    account: p.accountDisplayName || undefined,
    ads_customer_ids: adsCustomerIds(p.googleAdsLinks) || undefined,
  }));
}

function enumTail(value: unknown, prefix: string): string | undefined {
  if (typeof value !== 'string' || !value || /_UNSPECIFIED$/.test(value)) return undefined;
  return value.startsWith(prefix) ? value.slice(prefix.length) : value;
}

export function streamRows(streams: any[]): Row[] {
  return (streams || []).map((stream) => {
    const web = stream?.webStreamData || {};
    const android = stream?.androidAppStreamData || {};
    const ios = stream?.iosAppStreamData || {};
    return {
      stream_id: bareId(stream?.name),
      type: enumTail(stream?.type, '')?.replace(/_DATA_STREAM$/, ''),
      name: stream?.displayName || undefined,
      default_uri: web.defaultUri || undefined,
      measurement_id: web.measurementId || undefined,
      app_id: android.packageName || ios.bundleId || undefined,
      firebase_app_id: web.firebaseAppId || android.firebaseAppId || ios.firebaseAppId || undefined,
      created: timestampDate(stream?.createTime),
    };
  });
}

export function propertyDetailsDocument(details: any, streams: any[], links: any[]): { header: string[]; streams: Row[] } {
  const header = [
    `property ${bareId(details?.name)} · ${details?.displayName || ''} · account ${bareId(details?.account || details?.parent)}`,
  ];
  const pairs: Array<[string, unknown]> = [
    ['time_zone', details?.timeZone],
    ['currency', details?.currencyCode],
    ['industry', enumTail(details?.industryCategory, '')],
    ['service_level', enumTail(details?.serviceLevel, 'GOOGLE_ANALYTICS_')],
    ['type', enumTail(details?.propertyType, 'PROPERTY_TYPE_') === 'ORDINARY' ? undefined : enumTail(details?.propertyType, 'PROPERTY_TYPE_')],
    ['created', timestampDate(details?.createTime)],
    ['deleted', timestampDate(details?.deleteTime)],
    ['ads_customer_ids', adsCustomerIds(links)],
  ];
  const line = pairs.filter(([, value]) => value !== undefined && value !== null && value !== '').map(([key, value]) => `${key}=${value}`).join(' ');
  if (line) header.push(line);
  return { header, streams: streamRows(streams) };
}

const DIMENSION_SCOPE_PREFIX: Record<string, string> = { EVENT: 'customEvent', USER: 'customUser', ITEM: 'customItem' };

export function customDimensionRows(dimensions: any[]): Row[] {
  return (dimensions || []).map((d) => {
    const scope = enumTail(d?.scope, '');
    return {
      api_name: `${DIMENSION_SCOPE_PREFIX[scope || 'EVENT'] || 'customEvent'}:${d?.parameterName || ''}`,
      display_name: d?.displayName || undefined,
      scope,
      description: d?.description || undefined,
      no_ads_personalization: d?.disallowAdsPersonalization ? true : undefined,
    };
  });
}

export function customMetricRows(metrics: any[]): Row[] {
  return (metrics || []).map((m) => ({
    api_name: `customEvent:${m?.parameterName || ''}`,
    display_name: m?.displayName || undefined,
    scope: enumTail(m?.scope, ''),
    unit: enumTail(m?.measurementUnit, ''),
    restricted: (m?.restrictedMetricType || []).map((t: unknown) => enumTail(t, '')).filter(Boolean).join(' ~ ') || undefined,
    description: m?.description || undefined,
  }));
}

export interface ReportView {
  title: string;
  scope: string[];
  columns: ReportColumn[];
  plan: ReportPlan;
  response: any;
}

export function reportDocument(view: ReportView): string {
  const shaped = shapeReportResponse(view.columns, view.plan, view.response);
  return tableDocument({
    title: view.title,
    scope: view.scope,
    currency: shaped.currency,
    rows: shaped.rows,
    shape: { ...view.plan.shape, limit: view.plan.limit },
    defaultOrder: view.plan.order,
    money: shaped.money,
    matched: shaped.matched,
    totals: shaped.totals,
    totalsLabel: shaped.totalsLabel,
    notes: shaped.notes,
  });
}
