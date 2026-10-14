import { OAuth2Client } from 'google-auth-library';
import { BetaAnalyticsDataClient } from '@google-analytics/data';
import { AnalyticsAdminServiceClient } from '@google-analytics/admin';
import type { GaConfig } from './config.js';

export function getAuthClient(cfg: GaConfig): OAuth2Client {
  const client = new OAuth2Client(cfg.clientId, cfg.clientSecret);
  client.setCredentials({ refresh_token: cfg.refreshToken });
  return client;
}

export function getDataClient(cfg: GaConfig): BetaAnalyticsDataClient {
  return new BetaAnalyticsDataClient({ authClient: getAuthClient(cfg) as any });
}

export function getAdminClient(cfg: GaConfig): AnalyticsAdminServiceClient {
  return new AnalyticsAdminServiceClient({ authClient: getAuthClient(cfg) as any });
}

export interface PropertySummary {
  property: string;
  displayName: string;
  account: string;
  accountDisplayName: string;
  googleAdsLinks: any[];
}

export interface ReportRequest {
  dimensions: string[];
  metrics: string[];
  startDate: string;
  endDate: string;
  limit: number;
  dimensionFilter?: string;
  orderBys?: unknown[];
  metricFilter?: unknown;
  metricAggregations?: string[];
}

export type RealtimeRequest = Omit<ReportRequest, 'startDate' | 'endDate' | 'dimensionFilter'>;

function normalizePropertyName(property: string): string {
  const trimmed = property.trim();
  return trimmed.startsWith('properties/') ? trimmed : `properties/${trimmed}`;
}

function normalizeLimit(limit: number): string {
  return String(Math.max(1, Math.min(Math.floor(limit), 100000)));
}

function buildFieldList(names: string[]): { name: string }[] {
  return names.map((name) => ({ name }));
}

function buildDateRange(startDate: string, endDate: string) {
  return [{ startDate, endDate }];
}

export function buildDimensionFilter(expression: string | undefined): unknown | undefined {
  if (!expression) return undefined;
  const match = expression.match(/^\s*([A-Za-z0-9_]+)\s*(==|=|contains|CONTAINS)\s*"([^"]+)"\s*$/);
  if (!match) {
    throw new Error('dimension_filter must look like: dimension == "value" or dimension contains "value"');
  }
  const [, fieldName, operator, value] = match;
  const matchType = operator.toLowerCase() === 'contains' ? 'CONTAINS' : 'EXACT';
  return {
    filter: {
      fieldName,
      stringFilter: {
        matchType,
        value,
        caseSensitive: false,
      },
    },
  };
}

async function safeListGoogleAdsLinks(cfg: GaConfig, property: string): Promise<any[]> {
  try {
    return await listGoogleAdsLinks(cfg, property);
  } catch {
    return [];
  }
}

export async function listPropertySummaries(cfg: GaConfig, accountFilter?: string): Promise<PropertySummary[]> {
  const admin = getAdminClient(cfg);
  const [accountSummaries] = await admin.listAccountSummaries();
  const filter = accountFilter?.toLowerCase();
  const properties = accountSummaries.flatMap((accountSummary: any) => {
    const account = accountSummary.account || '';
    const accountDisplayName = accountSummary.displayName || '';
    if (filter && !account.toLowerCase().includes(filter) && !accountDisplayName.toLowerCase().includes(filter)) {
      return [];
    }
    return (accountSummary.propertySummaries || []).map((propertySummary: any) => ({
      property: propertySummary.property || '',
      displayName: propertySummary.displayName || '',
      account,
      accountDisplayName,
      googleAdsLinks: [],
    }));
  });
  return Promise.all(properties.map(async (property) => ({
    ...property,
    googleAdsLinks: await safeListGoogleAdsLinks(cfg, property.property),
  })));
}

export async function getPropertyDetails(cfg: GaConfig, property: string): Promise<{ property: any; dataStreams: any[]; googleAdsLinks: any[] }> {
  const admin = getAdminClient(cfg);
  const name = normalizePropertyName(property);
  const [[details], [dataStreams], googleAdsLinks] = await Promise.all([
    admin.getProperty({ name }),
    admin.listDataStreams({ parent: name }),
    safeListGoogleAdsLinks(cfg, name),
  ]);
  return {
    property: details,
    dataStreams,
    googleAdsLinks,
  };
}

export async function listGoogleAdsLinks(cfg: GaConfig, property: string): Promise<any[]> {
  const admin = getAdminClient(cfg);
  const [links] = await admin.listGoogleAdsLinks({ parent: normalizePropertyName(property) });
  return links;
}

export function buildReportRequest(property: string, request: ReportRequest): Record<string, unknown> {
  const body: Record<string, unknown> = {
    property: normalizePropertyName(property),
    dimensions: buildFieldList(request.dimensions),
    metrics: buildFieldList(request.metrics),
    dateRanges: buildDateRange(request.startDate, request.endDate),
    limit: normalizeLimit(request.limit),
  };
  const dimensionFilter = buildDimensionFilter(request.dimensionFilter);
  if (dimensionFilter) body.dimensionFilter = dimensionFilter;
  if (request.metricFilter) body.metricFilter = request.metricFilter;
  if (request.orderBys?.length) body.orderBys = request.orderBys;
  if (request.metricAggregations?.length) body.metricAggregations = request.metricAggregations;
  return body;
}

export async function runReport(cfg: GaConfig, property: string, request: ReportRequest): Promise<any> {
  const [response] = await getDataClient(cfg).runReport(buildReportRequest(property, request) as any);
  return response;
}

export async function runRealtimeReport(cfg: GaConfig, property: string, request: RealtimeRequest): Promise<any> {
  const body: Record<string, unknown> = {
    property: normalizePropertyName(property),
    dimensions: buildFieldList(request.dimensions),
    metrics: buildFieldList(request.metrics),
    limit: normalizeLimit(request.limit),
  };
  if (request.metricFilter) body.metricFilter = request.metricFilter;
  if (request.orderBys?.length) body.orderBys = request.orderBys;
  if (request.metricAggregations?.length) body.metricAggregations = request.metricAggregations;
  const [response] = await getDataClient(cfg).runRealtimeReport(body as any);
  return response;
}

export async function getCustomDimensionsAndMetrics(cfg: GaConfig, property: string): Promise<{ customDimensions: any[]; customMetrics: any[] }> {
  const admin = getAdminClient(cfg);
  const parent = normalizePropertyName(property);
  const [[customDimensions], [customMetrics]] = await Promise.all([
    admin.listCustomDimensions({ parent }),
    admin.listCustomMetrics({ parent }),
  ]);
  return { customDimensions, customMetrics };
}

export const CHANNEL_DIMENSIONS = ['sessionSourceMedium', 'sessionCampaignName', 'sessionDefaultChannelGroup'];
export const CHANNEL_METRICS = [
  'sessions',
  'engagedSessions',
  'keyEvents',
  'totalRevenue',
  'advertiserAdCost',
  'advertiserAdClicks',
  'advertiserAdCostPerClick',
  'returnOnAdSpend',
];

export interface WebStreamSummary {
  property: string;
  displayName: string;
  defaultUri: string;
}

export async function listWebStreams(cfg: GaConfig): Promise<WebStreamSummary[]> {
  const properties = await listPropertySummariesWithoutLinks(cfg);
  const admin = getAdminClient(cfg);
  const perProperty = await Promise.all(properties.map(async ({ property, displayName }) => {
    try {
      const [streams] = await admin.listDataStreams({ parent: property });
      return streams
        .map((stream: any) => stream.webStreamData?.defaultUri || '')
        .filter((uri: string) => uri)
        .map((defaultUri: string) => ({ property, displayName, defaultUri }));
    } catch {
      return [];
    }
  }));
  return perProperty.flat();
}

async function listPropertySummariesWithoutLinks(cfg: GaConfig): Promise<Array<{ property: string; displayName: string }>> {
  const admin = getAdminClient(cfg);
  const [accountSummaries] = await admin.listAccountSummaries();
  return accountSummaries.flatMap((accountSummary: any) => (accountSummary.propertySummaries || []).map((propertySummary: any) => ({
    property: propertySummary.property || '',
    displayName: propertySummary.displayName || '',
  })));
}
