import { OAuth2Client } from 'google-auth-library';
import { BetaAnalyticsDataClient } from '@google-analytics/data';
import { AnalyticsAdminServiceClient } from '@google-analytics/admin';
import type { GaConfig } from './config.js';

function getAuthClient(cfg: GaConfig): OAuth2Client {
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
  googleAdsLinks: unknown[];
}

export interface ReportRequest {
  dimensions: string[];
  metrics: string[];
  startDate: string;
  endDate: string;
  limit?: number;
  dimensionFilter?: string;
}

function normalizePropertyName(property: string): string {
  const trimmed = property.trim();
  return trimmed.startsWith('properties/') ? trimmed : `properties/${trimmed}`;
}

function normalizeLimit(limit: number | undefined): string | undefined {
  return limit ? String(Math.min(limit, 100000)) : undefined;
}

function buildFieldList(names: string[]): { name: string }[] {
  return names.map((name) => ({ name }));
}

function buildDateRange(startDate: string, endDate: string) {
  return [{ startDate, endDate }];
}

function buildDimensionFilter(expression: string | undefined): unknown | undefined {
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

function getResponseRows(response: any) {
  const dimensionHeaders = response.dimensionHeaders || [];
  const metricHeaders = response.metricHeaders || [];
  return (response.rows || []).map((row: any) => {
    const dimensions = Object.fromEntries(
      dimensionHeaders.map((header: any, i: number) => [header.name, row.dimensionValues?.[i]?.value || '']),
    );
    const metrics = Object.fromEntries(
      metricHeaders.map((header: any, i: number) => [header.name, row.metricValues?.[i]?.value || '']),
    );
    return { dimensions, metrics };
  });
}

function formatReportResponse(response: any) {
  return {
    rowCount: response.rowCount || 0,
    dimensionHeaders: (response.dimensionHeaders || []).map((h: any) => h.name),
    metricHeaders: (response.metricHeaders || []).map((h: any) => h.name),
    rows: getResponseRows(response),
    totals: getResponseRows({ ...response, rows: response.totals || [] }),
    maximums: getResponseRows({ ...response, rows: response.maximums || [] }),
    minimums: getResponseRows({ ...response, rows: response.minimums || [] }),
    metadata: response.metadata || undefined,
  };
}

async function safeListGoogleAdsLinks(cfg: GaConfig, property: string): Promise<unknown[]> {
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

export async function getPropertyDetails(cfg: GaConfig, property: string): Promise<unknown> {
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

export async function listGoogleAdsLinks(cfg: GaConfig, property: string): Promise<unknown[]> {
  const admin = getAdminClient(cfg);
  const [links] = await admin.listGoogleAdsLinks({ parent: normalizePropertyName(property) });
  return links;
}

export async function runReport(cfg: GaConfig, property: string, request: ReportRequest): Promise<unknown> {
  const data = getDataClient(cfg);
  const [response] = await data.runReport({
    property: normalizePropertyName(property),
    dimensions: buildFieldList(request.dimensions),
    metrics: buildFieldList(request.metrics),
    dateRanges: buildDateRange(request.startDate, request.endDate),
    limit: normalizeLimit(request.limit),
    dimensionFilter: buildDimensionFilter(request.dimensionFilter) as any,
  });
  return formatReportResponse(response);
}

export async function runRealtimeReport(
  cfg: GaConfig,
  property: string,
  request: Pick<ReportRequest, 'dimensions' | 'metrics' | 'limit'>,
): Promise<unknown> {
  const data = getDataClient(cfg);
  const [response] = await data.runRealtimeReport({
    property: normalizePropertyName(property),
    dimensions: buildFieldList(request.dimensions),
    metrics: buildFieldList(request.metrics),
    limit: normalizeLimit(request.limit),
  });
  return formatReportResponse(response);
}

export async function getCustomDimensionsAndMetrics(cfg: GaConfig, property: string): Promise<unknown> {
  const admin = getAdminClient(cfg);
  const parent = normalizePropertyName(property);
  const [[customDimensions], [customMetrics]] = await Promise.all([
    admin.listCustomDimensions({ parent }),
    admin.listCustomMetrics({ parent }),
  ]);
  return { customDimensions, customMetrics };
}

export async function getChannelPerformance(cfg: GaConfig, property: string, days: number): Promise<unknown> {
  return runReport(cfg, property, {
    dimensions: ['sessionSourceMedium', 'sessionCampaignName', 'sessionDefaultChannelGroup'],
    metrics: [
      'sessions',
      'engagedSessions',
      'conversions',
      'totalRevenue',
      'advertiserAdCost',
      'advertiserAdClicks',
      'advertiserAdCostPerClick',
      'returnOnAdSpend',
    ],
    startDate: `${days}daysAgo`,
    endDate: 'today',
    limit: 1000,
  });
}
