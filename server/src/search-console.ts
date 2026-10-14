import type { OAuth2Client } from 'google-auth-library';
import type { GaConfig } from './config.js';
import { getAuthClient } from './client.js';

const WEBMASTERS_BASE = 'https://www.googleapis.com/webmasters/v3';
const URL_INSPECTION_ENDPOINT = 'https://searchconsole.googleapis.com/v1/urlInspection/index:inspect';
const REQUEST_TIMEOUT_MS = 60_000;

export const GSC_DIMENSIONS = ['query', 'page', 'country', 'device', 'date', 'searchAppearance', 'hour'] as const;
export const GSC_FILTER_DIMENSIONS = ['query', 'page', 'country', 'device', 'searchAppearance'] as const;
export const GSC_FILTER_OPERATORS = ['equals', 'notEquals', 'contains', 'notContains', 'includingRegex', 'excludingRegex'] as const;
export const GSC_SEARCH_TYPES = ['web', 'image', 'video', 'news', 'discover', 'googleNews'] as const;
export const GSC_DATA_STATES = ['final', 'all', 'hourly_all'] as const;
export const GSC_AGGREGATION_TYPES = ['auto', 'byPage', 'byProperty', 'byNewsShowcasePanel'] as const;
export const GSC_MAX_ROW_LIMIT = 25_000;
export const GSC_DEFAULT_ROW_LIMIT = 1_000;
export const GSC_TIME_ZONE = 'America/Los_Angeles';

export type GscDimension = typeof GSC_DIMENSIONS[number];
export type GscFilterDimension = typeof GSC_FILTER_DIMENSIONS[number];
export type GscFilterOperator = typeof GSC_FILTER_OPERATORS[number];
export type GscSearchType = typeof GSC_SEARCH_TYPES[number];
export type GscDataState = typeof GSC_DATA_STATES[number];
export type GscAggregationType = typeof GSC_AGGREGATION_TYPES[number];

export interface GscFilter {
  dimension: GscFilterDimension;
  operator: GscFilterOperator;
  expression: string;
}

export interface SearchAnalyticsRequest {
  startDate: string;
  endDate: string;
  dimensions: GscDimension[];
  filters: GscFilter[];
  type: GscSearchType;
  dataState?: GscDataState;
  aggregationType?: GscAggregationType;
  rowLimit?: number;
  startRow?: number;
}

export interface GscSearchAnalyticsRow {
  keys?: string[];
  clicks?: number;
  impressions?: number;
  ctr?: number;
  position?: number;
}

export interface GscSearchAnalyticsResponse {
  rows?: GscSearchAnalyticsRow[];
  responseAggregationType?: string;
  metadata?: { first_incomplete_date?: string; first_incomplete_hour?: string };
}

export interface GscSiteEntry {
  siteUrl?: string;
  permissionLevel?: string;
}

export interface GscSitemap {
  path?: string;
  lastSubmitted?: string;
  isPending?: boolean;
  isSitemapsIndex?: boolean;
  type?: string;
  lastDownloaded?: string;
  warnings?: string | number;
  errors?: string | number;
  contents?: Array<{ type?: string; submitted?: string | number }>;
}

export type GoogleApiProblem = 'insufficient_scope' | 'api_disabled' | 'site_permission' | 'auth_revoked' | 'quota' | 'other';

export class GoogleApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly problem: GoogleApiProblem,
    readonly reasons: string[] = [],
    readonly activationUrl?: string,
  ) {
    super(message);
    this.name = 'GoogleApiError';
  }
}

export interface GoogleApiRequest {
  method: 'GET' | 'POST';
  url: string;
  body?: unknown;
}

function collectReasons(error: any): string[] {
  const reasons: string[] = [];
  for (const item of Array.isArray(error?.errors) ? error.errors : []) {
    if (typeof item?.reason === 'string') reasons.push(item.reason);
  }
  for (const item of Array.isArray(error?.details) ? error.details : []) {
    if (typeof item?.reason === 'string') reasons.push(item.reason);
  }
  if (typeof error?.status === 'string') reasons.push(error.status);
  return reasons;
}

function findActivationUrl(error: any): string | undefined {
  for (const item of Array.isArray(error?.details) ? error.details : []) {
    const url = item?.metadata?.activationUrl;
    if (typeof url === 'string') return url;
  }
  return undefined;
}

function classifyProblem(status: number, message: string, reasons: string[], wwwAuthenticate: string): GoogleApiProblem {
  const has = (...names: string[]) => names.some((name) => reasons.includes(name));
  if (/does not have sufficient permission for site/i.test(message)) return 'site_permission';
  if (
    has('ACCESS_TOKEN_SCOPE_INSUFFICIENT', 'insufficientPermissions')
    || /insufficient authentication scopes/i.test(message)
    || /insufficient_scope/i.test(wwwAuthenticate)
  ) return 'insufficient_scope';
  if (has('SERVICE_DISABLED', 'accessNotConfigured') || /has not been used in project|is disabled/i.test(message)) return 'api_disabled';
  if (status === 401 || has('invalid_grant', 'UNAUTHENTICATED')) return 'auth_revoked';
  if (status === 429 || has('RESOURCE_EXHAUSTED', 'rateLimitExceeded', 'quotaExceeded', 'userRateLimitExceeded')) return 'quota';
  if (status === 403 && has('forbidden')) return 'site_permission';
  return 'other';
}

export function classifyGoogleApiError(status: number, body: unknown, wwwAuthenticate = ''): GoogleApiError {
  const error = (body && typeof body === 'object' ? (body as any).error : undefined) ?? undefined;
  const message = typeof error?.message === 'string'
    ? error.message
    : typeof body === 'string' && body.trim() ? body.trim().slice(0, 500) : `HTTP ${status}`;
  const reasons = collectReasons(error);
  const problem = classifyProblem(status, message, reasons, wwwAuthenticate);
  return new GoogleApiError(message, status, problem, reasons, findActivationUrl(error));
}

function parseJson(text: string): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export async function callGoogleApi(accessToken: string, request: GoogleApiRequest): Promise<any> {
  const res = await fetch(request.url, {
    method: request.method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
      ...(request.body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: request.body === undefined ? undefined : JSON.stringify(request.body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const text = await res.text();
  const parsed = parseJson(text);
  if (!res.ok) throw classifyGoogleApiError(res.status, parsed ?? text, res.headers.get('www-authenticate') ?? '');
  return parsed ?? {};
}

let cachedAuth: { key: string; client: OAuth2Client } | null = null;

function isInvalidGrant(err: unknown): boolean {
  const data = (err as any)?.response?.data;
  return data?.error === 'invalid_grant' || /invalid_grant/.test(String((err as any)?.message ?? ''));
}

async function accessTokenFor(cfg: GaConfig): Promise<string> {
  const key = `${cfg.clientId}\n${cfg.refreshToken}`;
  if (cachedAuth?.key !== key) cachedAuth = { key, client: getAuthClient(cfg) };
  try {
    const { token } = await cachedAuth.client.getAccessToken();
    if (!token) throw new GoogleApiError('Google returned no access token for the saved refresh token.', 401, 'auth_revoked');
    return token;
  } catch (err) {
    if (err instanceof GoogleApiError) throw err;
    if (isInvalidGrant(err)) {
      throw new GoogleApiError('The saved refresh token was rejected (invalid_grant).', 401, 'auth_revoked', ['invalid_grant']);
    }
    throw err;
  }
}

async function gsc(cfg: GaConfig, request: GoogleApiRequest): Promise<any> {
  return callGoogleApi(await accessTokenFor(cfg), request);
}

export function normalizeSiteUrl(siteUrl: string): string {
  const trimmed = siteUrl.trim();
  if (/^sc-domain:/i.test(trimmed)) return `sc-domain:${trimmed.slice('sc-domain:'.length).trim().toLowerCase()}`;
  if (!/^https?:\/\//i.test(trimmed)) {
    throw new Error(`site_url "${trimmed}" is not a Search Console property. Use "sc-domain:example.com" for a Domain property or the exact URL prefix, e.g. "https://www.example.com/". list_search_console_sites shows the exact values.`);
  }
  const url = new URL(trimmed);
  return url.pathname === '/' && !trimmed.endsWith('/') ? `${trimmed}/` : trimmed;
}

function siteResource(siteUrl: string): string {
  return `${WEBMASTERS_BASE}/sites/${encodeURIComponent(normalizeSiteUrl(siteUrl))}`;
}

export function sitesListRequest(): GoogleApiRequest {
  return { method: 'GET', url: `${WEBMASTERS_BASE}/sites` };
}

export function sitemapsListRequest(siteUrl: string, sitemapIndex?: string): GoogleApiRequest {
  const query = sitemapIndex ? `?sitemapIndex=${encodeURIComponent(sitemapIndex)}` : '';
  return { method: 'GET', url: `${siteResource(siteUrl)}/sitemaps${query}` };
}

export function searchAnalyticsQueryRequest(siteUrl: string, request: SearchAnalyticsRequest): GoogleApiRequest {
  return { method: 'POST', url: `${siteResource(siteUrl)}/searchAnalytics/query`, body: buildSearchAnalyticsBody(request) };
}

export function urlInspectionRequest(siteUrl: string, inspectionUrl: string, languageCode?: string): GoogleApiRequest {
  return {
    method: 'POST',
    url: URL_INSPECTION_ENDPOINT,
    body: {
      inspectionUrl: inspectionUrl.trim(),
      siteUrl: normalizeSiteUrl(siteUrl),
      ...(languageCode ? { languageCode } : {}),
    },
  };
}

function normalizeFilterExpression(filter: GscFilter): string {
  if (filter.dimension === 'country') return filter.expression.trim().toLowerCase();
  if (filter.dimension === 'device') return filter.expression.trim().toUpperCase();
  return filter.expression;
}

export function buildSearchAnalyticsBody(request: SearchAnalyticsRequest): Record<string, unknown> {
  const body: Record<string, unknown> = {
    startDate: request.startDate,
    endDate: request.endDate,
    type: request.type,
    rowLimit: request.rowLimit ?? GSC_DEFAULT_ROW_LIMIT,
    startRow: request.startRow ?? 0,
  };
  if (request.dimensions.length) body.dimensions = request.dimensions;
  if (request.filters.length) {
    body.dimensionFilterGroups = [{
      groupType: 'and',
      filters: request.filters.map((filter) => ({
        dimension: filter.dimension,
        operator: filter.operator,
        expression: normalizeFilterExpression(filter),
      })),
    }];
  }
  if (request.dataState) body.dataState = request.dataState;
  if (request.aggregationType) body.aggregationType = request.aggregationType;
  return body;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function searchAnalyticsProblems(request: SearchAnalyticsRequest): string[] {
  const problems: string[] = [];
  if (!ISO_DATE.test(request.startDate)) problems.push(`start_date "${request.startDate}" must be YYYY-MM-DD`);
  if (!ISO_DATE.test(request.endDate)) problems.push(`end_date "${request.endDate}" must be YYYY-MM-DD`);
  if (ISO_DATE.test(request.startDate) && ISO_DATE.test(request.endDate) && request.endDate < request.startDate) {
    problems.push(`end_date ${request.endDate} is before start_date ${request.startDate}`);
  }
  const duplicates = request.dimensions.filter((dimension, i) => request.dimensions.indexOf(dimension) !== i);
  if (duplicates.length) problems.push(`dimension repeated: ${[...new Set(duplicates)].join(', ')}`);
  const touchesPage = request.dimensions.includes('page') || request.filters.some((filter) => filter.dimension === 'page');
  if (request.aggregationType === 'byProperty' && touchesPage) {
    problems.push('aggregation_type byProperty cannot be combined with the page dimension or a page filter — use byPage or auto');
  }
  if (request.aggregationType === 'byProperty' && (request.type === 'discover' || request.type === 'googleNews')) {
    problems.push(`aggregation_type byProperty is not supported for type ${request.type}`);
  }
  if (request.aggregationType === 'byNewsShowcasePanel') {
    const newsType = request.type === 'discover' || request.type === 'googleNews';
    const showcaseFilter = request.filters.some((filter) => filter.dimension === 'searchAppearance'
      && filter.operator === 'equals' && filter.expression === 'NEWS_SHOWCASE');
    if (!newsType || !showcaseFilter) {
      problems.push('aggregation_type byNewsShowcasePanel needs type discover or googleNews and a searchAppearance equals NEWS_SHOWCASE filter');
    }
  }
  if (request.dimensions.includes('hour') && request.dataState !== 'hourly_all') {
    problems.push('the hour dimension needs data_state hourly_all');
  }
  return problems;
}

export function todayInSearchConsoleTimeZone(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: GSC_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

function shiftIsoDate(isoDate: string, days: number): string {
  const [y, m, d] = isoDate.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d - days)).toISOString().slice(0, 10);
}

export function resolveGscDate(value: string, today: string): string {
  const normalized = value.trim();
  if (ISO_DATE.test(normalized)) return normalized;
  const lower = normalized.toLowerCase();
  if (lower === 'today') return today;
  if (lower === 'yesterday') return shiftIsoDate(today, 1);
  const relative = lower.match(/^(\d+)daysago$/);
  if (relative) return shiftIsoDate(today, Number(relative[1]));
  throw new Error(`date "${value}" must be YYYY-MM-DD, "today", "yesterday" or "NdaysAgo"`);
}

export async function listSearchConsoleSites(cfg: GaConfig): Promise<GscSiteEntry[]> {
  const response = await gsc(cfg, sitesListRequest());
  return Array.isArray(response?.siteEntry) ? response.siteEntry : [];
}

export async function querySearchAnalytics(cfg: GaConfig, siteUrl: string, request: SearchAnalyticsRequest): Promise<GscSearchAnalyticsResponse> {
  return gsc(cfg, searchAnalyticsQueryRequest(siteUrl, request));
}

export async function inspectSearchConsoleUrl(cfg: GaConfig, siteUrl: string, inspectionUrl: string, languageCode?: string): Promise<any> {
  const response = await gsc(cfg, urlInspectionRequest(siteUrl, inspectionUrl, languageCode));
  return response?.inspectionResult ?? {};
}

export async function listSearchConsoleSitemaps(cfg: GaConfig, siteUrl: string, sitemapIndex?: string): Promise<GscSitemap[]> {
  const response = await gsc(cfg, sitemapsListRequest(siteUrl, sitemapIndex));
  return Array.isArray(response?.sitemap) ? response.sitemap : [];
}
