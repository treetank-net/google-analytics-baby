import { readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { OAUTH_CLIENT_ID, OAUTH_CLIENT_SECRET } from './constants.js';

export interface GaConfig {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

interface SavedConfig {
  clientId?: string;
  clientSecret?: string;
  refreshToken?: string;
  savedAt?: string;
}

function isValidEnv(val: string | undefined): val is string {
  return !!val && !val.includes('${');
}

function env(name: string): string {
  const v = process.env[name];
  return isValidEnv(v) ? v : '';
}

export function getConfigDir(): string {
  const explicit = env('GA_BABY_DATA');
  if (explicit) return explicit;
  const home = process.env['HOME'] || process.env['USERPROFILE'] || process.env['APPDATA'];
  if (home) return join(home, '.google-analytics-baby');
  return join(process.platform === 'win32' ? (process.env['TEMP'] || 'C:\\Temp') : '/tmp', '.google-analytics-baby');
}

export function getConfigPath(): string {
  return join(getConfigDir(), 'config.json');
}

export async function loadSavedConfig(): Promise<SavedConfig> {
  try {
    const data = await readFile(getConfigPath(), 'utf-8');
    return JSON.parse(data);
  } catch {
    return {};
  }
}

export async function saveConfig(config: Partial<SavedConfig>): Promise<string> {
  const existing = await loadSavedConfig();
  const merged = { ...existing, ...config, savedAt: new Date().toISOString() };
  const dir = getConfigDir();
  await mkdir(dir, { recursive: true });
  const path = getConfigPath();
  await writeFile(path, JSON.stringify(merged, null, 2));
  return path;
}

export async function configFromEnv(): Promise<GaConfig> {
  const saved = await loadSavedConfig();
  return {
    clientId: env('GOOGLE_ANALYTICS_CLIENT_ID') || saved.clientId || OAUTH_CLIENT_ID,
    clientSecret: env('GOOGLE_ANALYTICS_CLIENT_SECRET') || saved.clientSecret || OAUTH_CLIENT_SECRET,
    refreshToken: env('GOOGLE_ANALYTICS_REFRESH_TOKEN') || saved.refreshToken || '',
  };
}
