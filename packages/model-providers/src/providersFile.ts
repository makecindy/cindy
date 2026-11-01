/**
 * `~/.cindy-harness/providers.yaml` validation (ROADMAP 2.1a). Pure logic: it takes the
 * already-parsed document, so the package keeps zero runtime dependencies; reading and
 * YAML parsing live in maker-core (`providers/providers-file.ts`).
 *
 * The file lists endpoints the owner runs or pays for (Ollama, LM Studio, llama.cpp, any
 * OpenAI-compatible API). It never holds a secret: `keyEnv` is the NAME of an environment
 * variable, and anything shaped like a key is rejected. A bad entry is reported and skipped;
 * the rest still load.
 */

import type { ProbeLike } from './routeHealth.js';
import type { CatalogModel } from './types.js';
import { DEFAULT_CUSTOM_CONTEXT_WINDOW } from './user-provider.js';

export const PROVIDER_FILE_KINDS = ['ollama', 'lmstudio', 'llamacpp', 'openai-compatible'] as const;
export type ProviderFileKind = (typeof PROVIDER_FILE_KINDS)[number];

export interface ProviderFileCapabilities {
  tools: boolean;
  vision: boolean;
  /** Tokens; unset when the file does not say. */
  contextLength?: number;
}

export interface ProviderFileEntry {
  id: string;
  kind: ProviderFileKind;
  /** Normalised: no trailing slash. */
  baseUrl: string;
  /** Name of the environment variable holding the key. Absent for keyless local endpoints. */
  keyEnv?: string;
  capabilities: ProviderFileCapabilities;
  /** True for endpoints on this machine (loopback host). */
  local: boolean;
}

export interface ProviderFileIssue {
  /** Entry id when it could be read, else its 1-based position. */
  entry: string;
  message: string;
}

export interface ProviderFileResult {
  providers: ProviderFileEntry[];
  issues: ProviderFileIssue[];
}

const ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
// Env var NAMES are upper snake case. A real key (sk-..., mixed case, dashes, long) is not.
const ENV_NAME_PATTERN = /^[A-Z_][A-Z0-9_]{0,63}$/;
const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function parseEntry(raw: unknown, position: number, seen: Set<string>): ProviderFileEntry | ProviderFileIssue {
  const label = isRecord(raw) && typeof raw.id === 'string' && raw.id ? raw.id : String(position);
  const fail = (message: string): ProviderFileIssue => ({ entry: label, message });
  if (!isRecord(raw)) return fail('entry must be a mapping');

  const id = typeof raw.id === 'string' ? raw.id.trim() : '';
  if (!ID_PATTERN.test(id)) return fail('"id" must be lowercase letters, digits, ".", "_" or "-" (max 64)');
  if (seen.has(id)) return fail(`duplicate id "${id}"`);

  if (typeof raw.kind !== 'string' || !(PROVIDER_FILE_KINDS as readonly string[]).includes(raw.kind)) {
    return fail(`"kind" must be one of ${PROVIDER_FILE_KINDS.join(', ')}`);
  }
  const kind = raw.kind as ProviderFileKind;

  if (typeof raw.baseUrl !== 'string') return fail('"baseUrl" is required');
  let url: URL;
  try {
    url = new URL(raw.baseUrl.trim());
  } catch {
    return fail('"baseUrl" is not a valid URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return fail('"baseUrl" must be http or https');
  if (url.username || url.password) return fail('"baseUrl" must not contain credentials');

  let keyEnv: string | undefined;
  if (raw.keyEnv !== undefined && raw.keyEnv !== null) {
    if (typeof raw.keyEnv !== 'string' || !ENV_NAME_PATTERN.test(raw.keyEnv)) {
      return fail('"keyEnv" must be the NAME of an environment variable (like OPENAI_API_KEY), never the key itself');
    }
    keyEnv = raw.keyEnv;
  }
  for (const forbidden of ['apiKey', 'api_key', 'key', 'token', 'secret']) {
    if (forbidden in raw) return fail(`"${forbidden}" is not allowed: keep secrets in the environment and reference them with "keyEnv"`);
  }

  const capsRaw = raw.capabilities;
  if (capsRaw !== undefined && !isRecord(capsRaw)) return fail('"capabilities" must be a mapping');
  const caps = (capsRaw ?? {}) as Record<string, unknown>;
  for (const flag of ['tools', 'vision'] as const) {
    if (caps[flag] !== undefined && typeof caps[flag] !== 'boolean') return fail(`capabilities.${flag} must be true or false`);
  }
  let contextLength: number | undefined;
  if (caps.contextLength !== undefined) {
    if (typeof caps.contextLength !== 'number' || !Number.isInteger(caps.contextLength) || caps.contextLength <= 0) {
      return fail('capabilities.contextLength must be a positive integer');
    }
    contextLength = caps.contextLength;
  }

  seen.add(id);
  return {
    id,
    kind,
    baseUrl: url.toString().replace(/\/+$/, ''),
    ...(keyEnv ? { keyEnv } : {}),
    capabilities: {
      tools: caps.tools === true,
      vision: caps.vision === true,
      ...(contextLength !== undefined ? { contextLength } : {}),
    },
    local: LOOPBACK.has(url.hostname),
  };
}

/** Validate a parsed `providers.yaml`. Never throws. */
export function parseProvidersFile(doc: unknown): ProviderFileResult {
  const result: ProviderFileResult = { providers: [], issues: [] };
  if (doc === undefined || doc === null) return result;
  if (!isRecord(doc) || (doc.providers !== undefined && !Array.isArray(doc.providers))) {
    result.issues.push({ entry: '(file)', message: 'top level must be a mapping with a "providers" list' });
    return result;
  }
  const seen = new Set<string>();
  (doc.providers ?? []).forEach((raw: unknown, i: number) => {
    const out = parseEntry(raw, i + 1, seen);
    if ('message' in out) result.issues.push(out);
    else result.providers.push(out);
  });
  return result;
}

export type ProviderFileEndpointStatus = 'online' | 'offline' | 'error' | 'unprobed';

/**
 * Display and catalog projection of a `providers.yaml` endpoint merged with its
 * latest discovery probe (ROADMAP 2.1b / 2.2b).
 */
export interface ProviderFileEndpointView extends ProviderFileEntry {
  status: ProviderFileEndpointStatus;
  models: string[];
  latencyMs?: number;
  error?: string;
}

/**
 * Projects `providers.yaml` entries into `CatalogModel` records for a single
 * endpoint, preserving declared tool/vision capabilities and context length.
 */
export function providerFileEntryToCatalogModels(
  entry: ProviderFileEntry,
  modelIds: readonly string[],
): CatalogModel[] {
  if (!entry || !Array.isArray(modelIds)) return [];
  const contextWindow = entry.capabilities.contextLength ?? DEFAULT_CUSTOM_CONTEXT_WINDOW;
  const hasExplicitContext = entry.capabilities.contextLength !== undefined;
  const seen = new Set<string>();
  const models: CatalogModel[] = [];

  for (const rawId of modelIds) {
    const id = typeof rawId === 'string' ? rawId.trim() : '';
    if (!id || seen.has(id)) continue;
    seen.add(id);
    models.push({
      id,
      name: id,
      contextWindow,
      contextWindowVerified: hasExplicitContext,
      contextWindowExplicit: hasExplicitContext,
      efforts: [],
      defaultEffort: null,
      supportsToolCalls: entry.capabilities.tools,
      supportsImageInput: entry.capabilities.vision,
      modalities: {
        input: entry.capabilities.vision ? ['text', 'image'] : ['text'],
        output: ['text'],
      },
      capabilities: {
        toolCall: entry.capabilities.tools,
        attachment: entry.capabilities.vision,
      },
    });
  }

  return models;
}

/**
 * Merges validated `providers.yaml` entries with optional discovery probes in
 * entry order. An offline or error probe never carries stale model ids.
 */
export function projectProviderFileEndpoints(
  entries: readonly ProviderFileEntry[],
  probes: readonly (ProbeLike & { latencyMs?: number })[] = [],
): ProviderFileEndpointView[] {
  if (!Array.isArray(entries)) return [];
  const probeById = new Map(
    (Array.isArray(probes) ? probes : []).map((probe) => [probe.id, probe]),
  );

  return entries.map((entry) => {
    const probe = probeById.get(entry.id);
    if (!probe) {
      return {
        ...entry,
        status: 'unprobed',
        models: [],
      };
    }
    const online = probe.status === 'online';
    return {
      ...entry,
      status: probe.status,
      models: online && Array.isArray(probe.models) ? [...probe.models] : [],
      ...(typeof probe.latencyMs === 'number' && Number.isFinite(probe.latencyMs)
        ? { latencyMs: probe.latencyMs }
        : {}),
      ...(!online && probe.error ? { error: probe.error } : {}),
    };
  });
}
