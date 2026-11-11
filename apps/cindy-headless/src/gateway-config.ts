import { chmod, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface GatewayConfig {
  baseUrl: string;
  apiKey: string;
  codexBasePath?: string;
}

const ENV_CONFIG = 'CINDY_HEADLESS_CONFIG_FILE';
const CODEX_ENV_KEY = 'CINDY_CODEX_API_KEY';

function validateBaseUrl(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error('gateway.baseUrl must be a non-empty string');
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('gateway.baseUrl must be a valid URL'); }
  if (!['https:', 'http:'].includes(url.protocol)) throw new Error('gateway.baseUrl must use http or https');
  if (url.protocol === 'http:' && !['127.0.0.1', 'localhost', '::1'].includes(url.hostname)) throw new Error('gateway.baseUrl must use https except for loopback');
  if (url.username || url.password) throw new Error('gateway.baseUrl must not contain credentials');
  return value.replace(/\/+$/, '');
}

function parseConfig(raw: unknown): GatewayConfig {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('gateway config must be an object');
  const value = raw as { gateway?: { baseUrl?: unknown; apiKey?: unknown; codexBasePath?: unknown } };
  const gateway = value.gateway;
  if (!gateway || typeof gateway !== 'object') throw new Error('gateway section is required');
  if (typeof gateway.apiKey !== 'string' || gateway.apiKey.trim() === '') throw new Error('gateway.apiKey must be a non-empty string');
  const codexBasePath = gateway.codexBasePath ?? '/v1';
  if (typeof codexBasePath !== 'string' || !codexBasePath.startsWith('/')) throw new Error('gateway.codexBasePath must start with /');
  return { baseUrl: validateBaseUrl(gateway.baseUrl), apiKey: gateway.apiKey, codexBasePath: codexBasePath.replace(/\/+$/, '') };
}

export function gatewayConfigCandidates(): string[] {
  return [
    process.env[ENV_CONFIG],
    path.join(process.cwd(), 'config.local.json'),
    path.join(process.cwd(), 'apps', 'cindy-headless', 'config.local.json'),
    path.join(process.cwd(), '.cindy-headless.json'),
    path.join(process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), 'cindy-headless', 'config.json'),
    path.join(os.homedir(), '.config', 'cindy-headless', 'config.json'),
  ].filter((value): value is string => Boolean(value));
}

export async function loadGatewayConfig(): Promise<GatewayConfig | null> {
  const envBaseUrl = process.env.CINDY_HEADLESS_BASE_URL ?? process.env.ANTHROPIC_BASE_URL;
  const envKey = process.env.CINDY_HEADLESS_API_KEY ?? process.env.ANTHROPIC_API_KEY ?? process.env.CINDY_CODEX_API_KEY;
  const configuredPath = gatewayConfigCandidates().find((candidate) => {
    try { return existsSync(candidate); } catch { return false; }
  });
  if (!configuredPath) {
    if (!envBaseUrl || !envKey) return null;
    return parseConfig({ gateway: { baseUrl: envBaseUrl, apiKey: envKey } });
  }
  await assertConfigFilePermissions(configuredPath);
  const config = parseConfig(JSON.parse(await readFile(configuredPath, 'utf8')));
  return { ...config, baseUrl: envBaseUrl ? validateBaseUrl(envBaseUrl) : config.baseUrl, apiKey: envKey ?? config.apiKey };
}

export function applyGatewayConfig(config: GatewayConfig | null): void {
  if (!config) return;
  process.env.CINDY_HEADLESS_API_KEY = config.apiKey;
  process.env.ANTHROPIC_API_KEY = config.apiKey;
  process.env.CINDY_HEADLESS_BASE_URL = config.baseUrl;
  process.env.ANTHROPIC_BASE_URL = config.baseUrl;
  process.env.CINDY_CODEX_API_KEY = config.apiKey;
  process.env.CINDY_CODEX_BASE_URL = `${config.baseUrl}${config.codexBasePath ?? '/v1'}`;
}

export function buildCodexGatewayArgs(config: GatewayConfig): string[] {
  const provider = 'cindy_gateway';
  const baseUrl = process.env.CINDY_CODEX_BASE_URL ?? `${config.baseUrl}${config.codexBasePath ?? '/v1'}`;
  return [
    '-c', `model_provider="${provider}"`,
    '-c', `model_providers.${provider}.name="Cindy Gateway"`,
    '-c', `model_providers.${provider}.base_url="${baseUrl}"`,
    '-c', `model_providers.${provider}.wire_api="responses"`,
    '-c', `model_providers.${provider}.env_key="${CODEX_ENV_KEY}"`,
    '-c', `model_providers.${provider}.supports_websockets=false`,
  ];
}

export async function assertConfigFilePermissions(filePath: string): Promise<void> {
  if (process.platform !== 'win32') await chmod(filePath, 0o600);
}
