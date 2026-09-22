/**
 * CC Switch provider import adapter. It opens CC Switch's SQLite database read-only and
 * converts supported rows into Cindy custom-provider inputs. Credentials remain Main-only.
 */

import { createHash } from 'node:crypto';
import { validateHeaderName, validateHeaderValue } from 'node:http';

import type {
  AgentKind,
  CustomProviderConfig,
  PiModelApi,
  ProviderRuntimeModelConfig,
  ProviderWireProtocol,
} from '@cindy/model-providers';
import Database from 'better-sqlite3';
import { parse as parseToml } from 'smol-toml';

import type { CcSwitchSourceApp } from '../../shared/ccSwitchProviderSync.js';
import { resolveBetterSqliteNativeBinding } from '../localDb/betterSqliteFactory.js';

const MAX_ROWS = 256;
const MAX_JSON_BYTES = 1024 * 1024;
const MAX_MODELS = 256;
const MAX_HEADERS = 32;

export interface CcSwitchProviderRow {
  id: string;
  app_type: string;
  name: string;
  settings_config: string;
  meta: string | null;
  provider_type?: string | null;
}

export interface CcSwitchProviderSyncCandidate {
  sourceApp: CcSwitchSourceApp;
  agent: AgentKind;
  config: CustomProviderConfig;
  keys: Partial<Record<AgentKind, string>>;
}

export interface CcSwitchProviderReadResult {
  candidates: CcSwitchProviderSyncCandidate[];
  skippedCount: number;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function safeJsonObject(raw: string | null): Record<string, unknown> | null {
  if (raw === null || Buffer.byteLength(raw, 'utf8') > MAX_JSON_BYTES) return null;
  try {
    return record(JSON.parse(raw));
  } catch {
    return null;
  }
}

function safeBaseUrl(value: unknown): string | null {
  const raw = text(value);
  if (!raw || raw.length > 2048 || /[{}]/.test(raw)) return null;
  try {
    const parsed = new URL(raw);
    if (
      (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash
    ) {
      return null;
    }
    return parsed.toString().replace(/\/$/, '');
  } catch {
    return null;
  }
}

function importedProviderId(app: CcSwitchSourceApp, sourceId: string): string {
  const digest = createHash('sha256').update(`${app}\0${sourceId}`).digest('hex').slice(0, 16);
  return `ccs_${app}_${digest}`;
}

function importedName(value: string, app: CcSwitchSourceApp): string {
  const fallback =
    app === 'claude'
      ? 'CC Switch · Claude Code'
      : app === 'codex'
        ? 'CC Switch · Codex'
        : 'CC Switch · Pi';
  return (value.trim() || fallback).slice(0, 60);
}

function model(value: unknown): ProviderRuntimeModelConfig | null {
  if (typeof value === 'string') {
    const id = value.trim();
    return id && id.length <= 256 ? { id, name: id } : null;
  }
  const input = record(value);
  const id = text(input?.id);
  if (!id || id.length > 256) return null;
  const name = (text(input?.name) ?? id).slice(0, 256);
  const output: ProviderRuntimeModelConfig = { id, name };
  const contextWindow = input?.contextWindow;
  if (
    typeof contextWindow === 'number' &&
    Number.isSafeInteger(contextWindow) &&
    contextWindow > 0
  ) {
    output.contextWindow = contextWindow;
  }
  if (input?.reasoning === true) output.reasoning = true;
  if (Array.isArray(input?.input) && input.input.includes('image'))
    output.supportsImageInput = true;
  return output;
}

function uniqueModels(values: readonly unknown[]): ProviderRuntimeModelConfig[] {
  const seen = new Set<string>();
  const result: ProviderRuntimeModelConfig[] = [];
  for (const value of values.slice(0, MAX_MODELS)) {
    const parsed = model(value);
    if (!parsed || seen.has(parsed.id)) continue;
    seen.add(parsed.id);
    result.push(parsed);
  }
  return result;
}

function protocolFromFormat(value: unknown, fallback: ProviderWireProtocol): ProviderWireProtocol {
  switch (text(value)?.toLowerCase()) {
    case 'openai_chat':
    case 'openai-chat':
    case 'chat':
    case 'chat_completions':
      return 'openai-chat';
    case 'openai_responses':
    case 'openai-responses':
    case 'responses':
      return 'openai-responses';
    case 'gemini_native':
    case 'google-generative-ai':
      return 'google-generative-ai';
    case 'anthropic':
    case 'anthropic-messages':
      return 'anthropic-messages';
    default:
      return fallback;
  }
}

function safeHeaders(value: unknown): Record<string, string> | undefined {
  const input = record(value);
  if (!input) return undefined;
  const entries: [string, string][] = [];
  for (const [name, rawValue] of Object.entries(input).slice(0, MAX_HEADERS)) {
    if (typeof rawValue !== 'string') continue;
    try {
      validateHeaderName(name);
      validateHeaderValue(name, rawValue);
      entries.push([name, rawValue]);
    } catch {
      // Skip malformed source headers without ever including their values in an error.
    }
  }
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function containsManagedOAuth(
  settings: Record<string, unknown>,
  row: CcSwitchProviderRow,
  meta: Record<string, unknown>,
): boolean {
  const auth = record(settings.auth);
  const providerType = text(row.provider_type) ?? text(meta.providerType);
  const authMode = text(auth?.auth_mode)?.toLowerCase();
  return (
    Boolean(auth?.tokens) ||
    Boolean(providerType?.toLowerCase().includes('oauth')) ||
    (authMode !== undefined && !['api-key', 'api_key', 'apikey'].includes(authMode))
  );
}

function claudeCandidate(
  row: CcSwitchProviderRow,
  settings: Record<string, unknown>,
  meta: Record<string, unknown>,
): CcSwitchProviderSyncCandidate | null {
  if (containsManagedOAuth(settings, row, meta)) return null;
  const env = record(settings.env);
  const baseUrl = safeBaseUrl(env?.ANTHROPIC_BASE_URL);
  if (!env || !baseUrl) return null;
  const key =
    text(env.ANTHROPIC_AUTH_TOKEN) ??
    text(env.ANTHROPIC_API_KEY) ??
    text(env.OPENROUTER_API_KEY) ??
    text(env.GOOGLE_API_KEY);
  const models = uniqueModels([
    env.ANTHROPIC_MODEL,
    env.ANTHROPIC_DEFAULT_OPUS_MODEL,
    env.ANTHROPIC_DEFAULT_SONNET_MODEL,
    env.ANTHROPIC_DEFAULT_HAIKU_MODEL,
    record(meta.testConfig)?.testModel,
    settings.model,
  ]);
  const agent: AgentKind = 'claude-code';
  const config: CustomProviderConfig = {
    id: importedProviderId('claude', row.id),
    name: importedName(row.name, 'claude'),
    auth: { method: 'apiKey' },
    runtimes: {
      [agent]: {
        baseUrl,
        wireProtocol: protocolFromFormat(meta.apiFormat, 'anthropic-messages'),
        models,
      },
    },
  };
  return { sourceApp: 'claude', agent, config, keys: key ? { [agent]: key } : {} };
}

function codexCandidate(
  row: CcSwitchProviderRow,
  settings: Record<string, unknown>,
  meta: Record<string, unknown>,
): CcSwitchProviderSyncCandidate | null {
  if (containsManagedOAuth(settings, row, meta)) return null;
  const configText = text(settings.config);
  if (!configText || Buffer.byteLength(configText, 'utf8') > MAX_JSON_BYTES) return null;
  let parsed: Record<string, unknown>;
  try {
    parsed = record(parseToml(configText)) ?? {};
  } catch {
    return null;
  }
  const providerName = text(parsed.model_provider);
  const providerTable = record(record(parsed.model_providers)?.[providerName ?? '']);
  const baseUrl = safeBaseUrl(providerTable?.base_url);
  if (!providerName || !providerTable || !baseUrl) return null;
  const auth = record(settings.auth);
  const key = text(auth?.OPENAI_API_KEY) ?? text(providerTable.experimental_bearer_token);
  const headers = safeHeaders(providerTable.http_headers);
  const models = uniqueModels([parsed.model, providerTable.model]);
  const agent: AgentKind = 'codex';
  const config: CustomProviderConfig = {
    id: importedProviderId('codex', row.id),
    name: importedName(row.name, 'codex'),
    auth: { method: 'apiKey' },
    runtimes: {
      [agent]: {
        baseUrl,
        wireProtocol: protocolFromFormat(
          providerTable.wire_api ?? meta.apiFormat,
          'openai-responses',
        ),
        models,
        ...(headers ? { headers } : {}),
      },
    },
  };
  return { sourceApp: 'codex', agent, config, keys: key ? { [agent]: key } : {} };
}

function piApi(value: unknown): PiModelApi | null {
  switch (text(value)?.toLowerCase()) {
    case 'openai-completions':
    case 'openai-chat':
      return 'openai-completions';
    case 'openai-responses':
      return 'openai-responses';
    case 'anthropic-messages':
      return 'anthropic-messages';
    case 'google-generative-ai':
      return 'google-generative-ai';
    default:
      return null;
  }
}

function wireFromPiApi(api: PiModelApi): ProviderWireProtocol {
  if (api === 'openai-completions') return 'openai-chat';
  if (api === 'openai-responses') return 'openai-responses';
  if (api === 'google-generative-ai') return 'google-generative-ai';
  return 'anthropic-messages';
}

function piCandidate(
  row: CcSwitchProviderRow,
  settings: Record<string, unknown>,
  meta: Record<string, unknown>,
): CcSwitchProviderSyncCandidate | null {
  if (containsManagedOAuth(settings, row, meta)) return null;
  const baseUrl = safeBaseUrl(settings.baseUrl ?? settings.base_url);
  const api = piApi(settings.api ?? meta.apiFormat);
  if (!baseUrl || !api) return null;
  const models = uniqueModels(Array.isArray(settings.models) ? settings.models : []);
  for (const item of models) item.piApi = api;
  const headers = safeHeaders(settings.headers);
  const key = text(settings.apiKey ?? settings.api_key);
  const agent: AgentKind = 'pi';
  const config: CustomProviderConfig = {
    id: importedProviderId('pi', row.id),
    name: importedName(row.name, 'pi'),
    auth: { method: 'apiKey' },
    runtimes: {
      [agent]: {
        baseUrl,
        wireProtocol: wireFromPiApi(api),
        models,
        ...(headers ? { headers } : {}),
      },
    },
  };
  return { sourceApp: 'pi', agent, config, keys: key ? { [agent]: key } : {} };
}

export function parseCcSwitchProviderRows(
  rows: readonly CcSwitchProviderRow[],
): CcSwitchProviderReadResult {
  const candidates: CcSwitchProviderSyncCandidate[] = [];
  let skippedCount = Math.max(0, rows.length - MAX_ROWS);
  for (const row of rows.slice(0, MAX_ROWS)) {
    if (
      typeof row.id !== 'string' ||
      row.id.length === 0 ||
      row.id.length > 256 ||
      typeof row.name !== 'string'
    ) {
      skippedCount += 1;
      continue;
    }
    const settings = safeJsonObject(row.settings_config);
    const meta = safeJsonObject(row.meta ?? '{}') ?? {};
    if (!settings) {
      skippedCount += 1;
      continue;
    }
    const candidate =
      row.app_type === 'claude'
        ? claudeCandidate(row, settings, meta)
        : row.app_type === 'codex'
          ? codexCandidate(row, settings, meta)
          : row.app_type === 'pi'
            ? piCandidate(row, settings, meta)
            : null;
    if (candidate) candidates.push(candidate);
    else skippedCount += 1;
  }
  return { candidates, skippedCount };
}

export function readCcSwitchProviderCandidates(dbPath: string): CcSwitchProviderReadResult {
  const nativeBinding = resolveBetterSqliteNativeBinding();
  const db = new Database(dbPath, {
    readonly: true,
    fileMustExist: true,
    ...(nativeBinding ? { nativeBinding } : {}),
  });
  try {
    db.pragma('query_only = ON');
    db.pragma('busy_timeout = 1000');
    const columns = new Set(
      (db.prepare('PRAGMA table_info(providers)').all() as { name: string }[]).map(
        (column) => column.name,
      ),
    );
    for (const required of ['id', 'app_type', 'name', 'settings_config', 'meta']) {
      if (!columns.has(required)) throw new Error('unsupported CC Switch provider database schema');
    }
    const providerType = columns.has('provider_type') ? 'provider_type' : 'NULL AS provider_type';
    const sortIndex = columns.has('sort_index') ? 'sort_index' : 'NULL';
    const createdAt = columns.has('created_at') ? 'created_at' : 'NULL';
    const rows = db
      .prepare(
        `SELECT id, app_type, name, settings_config, meta, ${providerType}
         FROM providers
         WHERE app_type IN ('claude', 'codex', 'pi')
         ORDER BY app_type, ${sortIndex}, ${createdAt}, id
         LIMIT ${MAX_ROWS + 1}`,
      )
      .all() as CcSwitchProviderRow[];
    return parseCcSwitchProviderRows(rows);
  } finally {
    db.close();
  }
}
