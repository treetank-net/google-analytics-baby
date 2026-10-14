import { z } from 'zod';

export type Cell = string | number | boolean | null | undefined;
export type Row = Record<string, Cell>;

export const DEFAULT_TABLE_PAGE_CHARS = 12_000;
export const MIN_TABLE_PAGE_CHARS = 2_000;
export const MAX_TABLE_PAGE_CHARS = 100_000;

export const SUMMABLE_COLUMNS = new Set([
  'sessions', 'engaged_sessions', 'views', 'event_count', 'key_events', 'conversions',
  'purchase_revenue', 'gross_purchase_revenue', 'total_revenue', 'total_ad_revenue', 'refund_amount',
  'cost', 'clicks', 'impressions', 'transactions', 'ecommerce_purchases', 'add_to_carts', 'checkouts',
  'items_purchased', 'user_engagement_duration',
]);

export function snakeCase(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
}

export function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

export function significant(value: number): number {
  if (Number.isInteger(value) || !Number.isFinite(value)) return value;
  return Math.abs(value) >= 1 ? roundTo(value, 2) : Number(value.toPrecision(3));
}

export function isoSeconds(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value) return undefined;
  const match = value.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})/);
  return match ? `${match[1]}T${match[2]}${/Z$|[+-]\d{2}:?\d{2}$/.test(value) ? 'Z' : ''}` : value;
}

export function timestampDate(value: unknown): string | undefined {
  const seconds = (value as { seconds?: unknown } | null | undefined)?.seconds;
  const n = typeof seconds === 'string' ? Number(seconds) : typeof seconds === 'number' ? seconds : NaN;
  return Number.isFinite(n) && n > 0 ? new Date(n * 1000).toISOString().slice(0, 10) : undefined;
}

export function shapeSchemas() {
  return {
    fields: z.array(z.string()).optional(),
    order_by: z.string().optional(),
    limit: z.number().int().positive().optional(),
    summary: z.boolean().optional(),
    page: pagingSchemas.page,
    page_chars: pagingSchemas.page_chars,
  };
}

export const thresholdSchemas = {
  min_cost: z.number().optional(),
  min_impressions: z.number().optional(),
  min_clicks: z.number().optional(),
};

export const pagingSchemas = {
  page: z.number().int().positive().optional(),
  page_chars: z.number().int().min(MIN_TABLE_PAGE_CHARS).max(MAX_TABLE_PAGE_CHARS).optional(),
};

export interface Shape {
  fields?: string[];
  order_by?: string;
  limit?: number;
  min_cost?: number;
  min_impressions?: number;
  min_clicks?: number;
  summary?: boolean;
  page?: number;
  page_chars?: number;
}

export const THRESHOLDS: Array<[keyof Shape, string]> = [
  ['min_cost', 'cost'],
  ['min_impressions', 'impressions'],
  ['min_clicks', 'clicks'],
];

export class ShapeError extends Error {}

export function columnsOf(rows: Row[]): string[] {
  const columns: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!seen.has(key)) {
        seen.add(key);
        columns.push(key);
      }
    }
  }
  return columns;
}

export function resolveColumn(name: string, available: string[], param: string, aliases: Record<string, string> = {}): string {
  const candidates = [name, aliases[name], snakeCase(name)];
  const found = candidates.find((candidate) => candidate && available.includes(candidate));
  if (!found) throw new ShapeError(`${param}: unknown column "${name}". Available: ${available.join(', ')}`);
  return found;
}

export function parseOrder(order: string): { column: string; descending: boolean } {
  const descending = order.startsWith('-');
  return { column: descending ? order.slice(1) : order, descending };
}

export function validateShape(shape: Shape, available: string[], aliases: Record<string, string> = {}): Shape {
  const resolved: Shape = { ...shape };
  for (const [param, column] of THRESHOLDS) {
    if (shape[param] !== undefined && !available.includes(column)) {
      throw new ShapeError(`${param}: this table has no ${column} column`);
    }
  }
  if (shape.order_by) {
    const { column, descending } = parseOrder(shape.order_by);
    resolved.order_by = `${descending ? '-' : ''}${resolveColumn(column, available, 'order_by', aliases)}`;
  }
  if (shape.fields?.length) resolved.fields = shape.fields.map((field) => resolveColumn(field, available, 'fields', aliases));
  return resolved;
}

function compareCells(a: Cell, b: Cell, descending: boolean): number {
  const aEmpty = a === undefined || a === null || a === '';
  const bEmpty = b === undefined || b === null || b === '';
  if (aEmpty || bEmpty) return aEmpty === bEmpty ? 0 : aEmpty ? 1 : -1;
  const result = typeof a === 'number' && typeof b === 'number' ? a - b : String(a).localeCompare(String(b));
  return descending ? -result : result;
}

export function sumColumns(rows: Row[], columns: string[], money: Set<string> = new Set()): Row {
  const totals: Row = {};
  for (const column of columns) {
    if (!SUMMABLE_COLUMNS.has(column)) continue;
    let sum = 0;
    let seen = false;
    for (const row of rows) {
      const value = row[column];
      if (typeof value === 'number') {
        sum += value;
        seen = true;
      }
    }
    if (seen) totals[column] = money.has(column) ? roundTo(sum, 2) : significant(roundTo(sum, 4));
  }
  return totals;
}

export interface Shaped {
  rows: Row[];
  total: number;
  matched: number;
  totals: Row;
  columns: string[];
  order?: string;
  thresholds: string[];
}

export function shapeRows(all: Row[], shape: Shape, defaultOrder?: string, money?: Set<string>): Shaped {
  const available = columnsOf(all);
  const resolved = all.length ? validateShape(shape, available) : shape;
  const thresholds: string[] = [];
  let rows = all;
  for (const [param, column] of THRESHOLDS) {
    const minimum = resolved[param] as number | undefined;
    if (minimum === undefined) continue;
    rows = rows.filter((row) => typeof row[column] === 'number' && (row[column] as number) >= minimum);
    thresholds.push(`${param}=${minimum}`);
  }
  const matched = rows.length;

  const order = resolved.order_by ?? (defaultOrder && available.includes(parseOrder(defaultOrder).column) ? defaultOrder : undefined);
  if (order) {
    const { column, descending } = parseOrder(order);
    rows = [...rows].sort((a, b) => compareCells(a[column], b[column], descending));
  }

  const totals = sumColumns(rows, available, money);
  if (resolved.limit !== undefined && rows.length > resolved.limit) rows = rows.slice(0, resolved.limit);

  let columns = available;
  if (resolved.fields?.length) {
    columns = resolved.fields;
    rows = rows.map((row) => Object.fromEntries(columns.filter((c) => c in row).map((c) => [c, row[c]])));
  }
  return { rows, total: all.length, matched, totals, columns, order, thresholds };
}

function escapeCell(value: Cell): string {
  if (value === undefined || value === null) return '';
  return String(value).replace(/[\t\r\n]+/g, ' ');
}

export interface Layout {
  columns: string[];
  constants: Row;
}

export function layoutFor(rows: Row[], columns: string[]): Layout {
  const present = columns.filter((column) => rows.some((row) => row[column] !== undefined && row[column] !== null && row[column] !== ''));
  const constants: Row = {};
  if (rows.length < 2) return { columns: present, constants };
  const varying = present.filter((column) => {
    const first = rows[0][column];
    const constant = first !== undefined && rows.every((row) => row[column] === first);
    if (constant) constants[column] = first;
    return !constant;
  });
  return { columns: varying.length ? varying : present, constants: varying.length ? constants : {} };
}

export function renderRows(rows: Row[], columns: string[]): string {
  if (!columns.length || !rows.length) return '';
  return [columns.join('\t'), ...rows.map((row) => columns.map((column) => escapeCell(row[column])).join('\t'))].join('\n');
}

export function formatPairs(row: Row): string {
  return Object.entries(row)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([key, value]) => `${key}=${escapeCell(value)}`)
    .join(' ');
}

function pageRows(rows: Row[], columns: string[], page: number, maxChars: number): { rows: Row[]; page: number; pages: number; from: number } {
  if (!rows.length) return { rows, page: 1, pages: 1, from: 0 };
  const full = renderRows(rows, columns).length;
  let perPage = rows.length;
  if (full > maxChars) {
    const header = columns.join('\t').length + 1;
    const perRow = Math.max(1, (full - header) / rows.length);
    perPage = Math.max(1, Math.floor((maxChars - header) / perRow));
  }
  const pages = Math.ceil(rows.length / perPage);
  const current = Math.min(Math.max(1, Math.floor(page) || 1), pages);
  const start = (current - 1) * perPage;
  return { rows: rows.slice(start, start + perPage), page: current, pages, from: start + 1 };
}

export interface TableSpec {
  title: string;
  scope?: string[];
  currency?: string;
  rows: Row[];
  shape?: Shape;
  defaultOrder?: string;
  money?: Set<string>;
  matched?: number;
  totals?: Row;
  totalsLabel?: string;
  notes?: string[];
}

export function tableDocument(spec: TableSpec): string {
  const shape = spec.shape ?? {};
  const shaped = shapeRows(spec.rows, shape, spec.defaultOrder, spec.money);
  const matched = Math.max(spec.matched ?? shaped.matched, shaped.matched);
  const totals = spec.totals ?? shaped.totals;
  const layout = layoutFor(shaped.rows, shaped.columns);
  const shown = shaped.rows.length;
  const count = shape.summary
    ? [`rows=${matched}`]
    : shown < matched
    ? [`showing top ${shown} of ${matched}${shaped.order ? ` by ${shaped.order}` : ''}`]
    : [`rows=${shown}`, ...(shaped.order && shown > 1 ? [`by ${shaped.order}`] : [])];
  const head = [spec.title, ...(spec.scope ?? []), ...(spec.currency ? [`currency=${spec.currency}`] : []), ...shaped.thresholds, ...count];
  const lines = [`# ${head.join(' · ')}`];
  if (Object.keys(layout.constants).length) lines.push(`# ${formatPairs(layout.constants)}`);
  if (Object.keys(totals).length && (matched > 1 || shape.summary)) {
    const label = spec.totalsLabel ?? (matched !== shown ? `all ${matched}` : '');
    lines.push(`# totals${label ? ` (${label})` : ''}: ${formatPairs(totals)}`);
  }
  for (const note of spec.notes ?? []) lines.push(`# ${note}`);
  if (shape.summary) return lines.join('\n');

  const paged = pageRows(shaped.rows, layout.columns, shape.page ?? 1, shape.page_chars ?? DEFAULT_TABLE_PAGE_CHARS);
  const body = renderRows(paged.rows, layout.columns);
  if (body) lines.push(body);
  if (paged.pages > 1) {
    const to = paged.from + paged.rows.length - 1;
    lines.push(`# page ${paged.page}/${paged.pages}, rows ${paged.from}-${to} of ${shown}${paged.page < paged.pages ? `; page: ${paged.page + 1} for more` : ''}`);
  }
  return lines.join('\n');
}

export function sectionsDocument(header: string[], sections: Array<[string, Row[]]>): string {
  const parts = header.map((line) => `# ${line}`);
  for (const [label, rows] of sections) {
    if (!rows.length) {
      parts.push(`## ${label} (0)`);
      continue;
    }
    const layout = layoutFor(rows, columnsOf(rows));
    parts.push(`## ${label} (${rows.length})`);
    if (Object.keys(layout.constants).length) parts.push(`# ${formatPairs(layout.constants)}`);
    parts.push(renderRows(rows, layout.columns));
  }
  return parts.join('\n');
}

export function tableError(err: unknown): string | undefined {
  return err instanceof ShapeError ? `Error: ${err.message}` : undefined;
}
