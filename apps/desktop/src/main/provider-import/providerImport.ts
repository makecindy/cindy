/**
 * Provider imports from deep links and local JSON files.
 *
 * External input may contain credentials, so it is converted immediately into a
 * short-lived Main-process draft. Only the opaque import id and redacted previews
 * are ever sent through Electron IPC to the Renderer.
 */

import { createHash, randomUUID } from 'node:crypto';
import { validateHeaderName, validateHeaderValue } from 'node:http';
import {
  isLoopbackProviderUrl,
  MODEL_METADATA_FIELDS,
  pickModelMetadata,
  validModelMetadata,
} from '@cindy/model-providers';

import type {
  AgentKind,
  CustomProviderConfig,
  OAuthProviderDescriptor,
  PiReasoningEffort,
  ProviderRuntimeModelConfig,
  ProviderView,
  ProviderPreset,
  ProviderWireProtocol,
} from '@cindy/model-providers';
import type {
  ProviderImportPreview,
  ProviderImportRuntimePreview,
} from '../../shared/providerImport.js';
import { isBuiltinApiKeyProviderId, type ProviderSecretId } from '../../shared/providerSecrets.js';
import {
  MANAGED_LMSTUDIO_PROVIDER_ID,
  isManagedSidecarProviderId,
} from '../../shared/localModelRuntime.js';
import {
  adaptCustomProviderModelEfforts,
  configuredPresetAgents,
} from '../../shared/piRuntimeInitialization.js';
import { presetConnectionRuntime } from '../../shared/presetConnectionRuntime.js';
import type {
  LocalProviderImportItem,
  LocalProviderSource,
  LocalProviderIssue,
} from '../../shared/localProviderImport.js';
import type { LocalSourceEntry } from './local/sources.js';

const IMPORT_TTL_MS = 10 * 60_000;
const MAX_URL_LENGTH = 32 * 1024;
const MAX_JSON_LENGTH = 24 * 1024;
const MAX_API_KEY_LENGTH = 4 * 1024;
const MAX_BUILTIN_API_KEY_LENGTH = 1024;
const MAX_ENDPOINTS = 8;
const MAX_MODELS_PER_ENDPOINT = 256;
const MAX_FILE_MODELS_PER_ENDPOINT = 10_000;
export const MAX_PROVIDER_IMPORT_FILE_BYTES = 4 * 1024 * 1024;
const MAX_FILE_PROVIDERS = 50;
const MAX_HEADERS_PER_ENDPOINT = 24;
const MAX_TEXT_LENGTH = 2 * 1024;
const MAX_DRAFTS = 128;
const PROVIDER_ID_RE = /^[a-z0-9_-]{1,40}$/;
const AGENTS: readonly AgentKind[] = ['claude-code', 'codex', 'pi'];
const PROTOCOLS: readonly ProviderWireProtocol[] = [
  'anthropic-messages',
  'openai-responses',
  'openai-chat',
  'google-generative-ai',
];
const PI_EFFORTS: readonly PiReasoningEffort[] = [
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
];
function normalizeOAuthParamKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

const FORBIDDEN_OAUTH_IMPORT_PARAM_KEYS = new Set(
  [
    'access_token',
    'assertion',
    'client_assertion',
    'client_secret',
    'code',
    'device_code',
    'id_token',
    'password',
    'refresh_token',
    'token',
  ].map(normalizeOAuthParamKey),
);

type ProviderImportScope = { dataOwnerId: string | null; generation: number };

export type ProviderImportDraft =
  | { kind: 'builtin'; provider: ProviderSecretId; apiKey: string }
  | {
      kind: 'custom';
      presetId?: string;
      presetApiKey?: string;
      config: CustomProviderConfig;
      keys: Partial<Record<AgentKind, string>>;
    };

type DraftRecord = {
  draft: ProviderImportDraft;
  expiresAt: number;
  scope?: ProviderImportScope;
  resolution?: ProviderImportResolution;
  confirming: boolean;
  local?: {
    source: LocalProviderSource;
    entry: LocalSourceEntry;
    original: string;
    reload: () => Promise<LocalSourceEntry | undefined>;
    issue?: LocalProviderIssue;
    completed?: string;
  };
};

export interface ProviderImportResolution {
  action: 'create' | 'update' | 'replace-key';
  providerId: string;
  existingProviderName?: string;
}

const drafts = new Map<string, DraftRecord>();

function fail(message: string): never {
  throw new Error(message);
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    fail(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function exactFields(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(value).find((key) => !allowedSet.has(key));
  if (unknown) fail(`${label}.${unknown} is not supported`);
}

function boundedString(value: unknown, label: string, max = MAX_TEXT_LENGTH): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    fail(`${label} must be a non-empty bounded string`);
  }
  return value.trim();
}

function httpUrl(
  value: unknown,
  label: string,
  httpsOnly = false,
  rejectQueryAndFragment = false,
): string {
  const raw = boundedString(value, label);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    fail(`${label} must be a valid URL`);
  }
  if (
    (httpsOnly
      ? url.protocol !== 'https:'
      : url.protocol !== 'https:' && url.protocol !== 'http:') ||
    url.username ||
    url.password ||
    (rejectQueryAndFragment && (url.search || url.hash))
  ) {
    fail(`${label} must be an ${httpsOnly ? 'https' : 'http(s)'} URL without embedded credentials`);
  }
  return raw;
}

function parseStringRecord(
  value: unknown,
  label: string,
  maxItems: number,
): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  const input = object(value, label);
  const entries = Object.entries(input);
  if (entries.length === 0 || entries.length > maxItems) fail(`${label} has too many entries`);
  const result: Record<string, string> = {};
  for (const [key, raw] of entries) {
    if (
      !key.trim() ||
      key.length > 128 ||
      typeof raw !== 'string' ||
      raw.length > MAX_TEXT_LENGTH ||
      /[\r\n]/.test(key) ||
      /[\r\n]/.test(raw)
    ) {
      fail(`${label} must contain bounded string keys and values`);
    }
    result[key] = raw;
  }
  return result;
}

function parsePublicOAuthParams(
  value: unknown,
  label: 'auth.extraAuthParams' | 'auth.extraDeviceParams',
): Record<string, string> {
  const params = parseStringRecord(value, label, 16)!;
  const sensitiveKey = Object.keys(params).find((key) =>
    FORBIDDEN_OAUTH_IMPORT_PARAM_KEYS.has(normalizeOAuthParamKey(key)),
  );
  if (sensitiveKey) fail(`${label}.${sensitiveKey} cannot contain OAuth credentials`);
  return params;
}

function assertHttpHeaderValue(value: string, label: string): void {
  try {
    validateHeaderValue('X-Provider-Import', value);
  } catch {
    // Validator errors must never expose imported credential values.
    fail(`${label} contains an invalid HTTP header value`);
  }
}

function parseApiKey(value: unknown, label: string, max: number): string {
  const key = boundedString(value, label, max);
  assertHttpHeaderValue(key, label);
  return key;
}

function parseHttpHeaders(value: unknown, label: string): Record<string, string> {
  const headers = parseStringRecord(value, label, MAX_HEADERS_PER_ENDPOINT)!;
  for (const [name, headerValue] of Object.entries(headers)) {
    try {
      validateHeaderName(name);
    } catch {
      fail(`${label} contains an invalid HTTP header name`);
    }
    assertHttpHeaderValue(headerValue, label);
  }
  return headers;
}

function parseModel(value: unknown, label: string): ProviderRuntimeModelConfig {
  if (typeof value === 'string') {
    const id = boundedString(value, label, 256);
    return { id, name: id };
  }
  const model = object(value, label);
  exactFields(
    model,
    [
      'id',
      'name',
      ...MODEL_METADATA_FIELDS,
      'defaultEnabled',
      'supportsImageInput',
      'reasoning',
      'reasoningEfforts',
      'reasoningDefaultEffort',
      'discoveredMetadata',
    ],
    label,
  );
  const id = boundedString(model.id, `${label}.id`, 256);
  const name = model.name === undefined ? id : boundedString(model.name, `${label}.name`, 256);
  for (const field of MODEL_METADATA_FIELDS) {
    if (model[field] !== undefined && !validModelMetadata({ [field]: model[field] }))
      fail(`${label}.${field} is invalid`);
  }
  if (model.discoveredMetadata !== undefined && !validModelMetadata(model.discoveredMetadata))
    fail(`${label}.discoveredMetadata is invalid`);
  const result: ProviderRuntimeModelConfig = {
    ...pickModelMetadata(model),
    id,
    name,
    ...(model.discoveredMetadata
      ? { discoveredMetadata: pickModelMetadata(model.discoveredMetadata as object) }
      : {}),
  };
  if (model.contextWindow !== undefined) {
    if (!Number.isInteger(model.contextWindow) || (model.contextWindow as number) <= 0) {
      fail(`${label}.contextWindow must be a positive integer`);
    }
    result.contextWindow = model.contextWindow as number;
  }
  for (const field of ['defaultEnabled', 'supportsImageInput', 'reasoning'] as const) {
    if (model[field] !== undefined && typeof model[field] !== 'boolean') {
      fail(`${label}.${field} must be a boolean`);
    }
  }
  // A link selects a model, not compatibility engines. Explicit off remains off.
  if (model.defaultEnabled === false) result.defaultEnabled = false;
  if (typeof model.supportsImageInput === 'boolean')
    result.supportsImageInput = model.supportsImageInput;
  if (model.reasoning === false) result.reasoning = false;
  if (model.reasoning === true) {
    if (model.reasoningEfforts !== undefined && !Array.isArray(model.reasoningEfforts)) {
      fail(`${label}.reasoningEfforts is required when reasoning is enabled`);
    }
    const efforts = model.reasoningEfforts?.map((effort) => {
      if (typeof effort !== 'string' || !PI_EFFORTS.includes(effort as PiReasoningEffort)) {
        fail(`${label}.reasoningEfforts contains an unsupported value`);
      }
      return effort as PiReasoningEffort;
    });
    if (efforts && new Set(efforts).size !== efforts.length)
      fail(`${label}.reasoningEfforts contains duplicates`);
    result.reasoning = true;
    if (efforts) result.reasoningEfforts = efforts;
    if (model.reasoningDefaultEffort !== undefined) {
      if (!efforts?.includes(model.reasoningDefaultEffort as PiReasoningEffort))
        fail(`${label}.reasoningDefaultEffort is unsupported`);
      result.reasoningDefaultEffort = model.reasoningDefaultEffort as PiReasoningEffort;
    }
  } else if (model.reasoningEfforts !== undefined || model.reasoningDefaultEffort !== undefined) {
    fail(`${label}.reasoningEfforts requires reasoning=true`);
  }
  return result;
}

type ParsedEndpoint = {
  protocol: ProviderWireProtocol;
  baseUrl: string;
  targets?: AgentKind[];
  models: ProviderRuntimeModelConfig[];
  modelsUrl?: string;
  requestPath?: string;
  headers?: Record<string, string>;
  apiKey?: string;
};

/** Discovery uses catalog-sized limits, independently of the compact deep-link payload. */
export function assertProviderImportModels(
  models: readonly { id: string; name: string; contextWindow?: number }[],
): void {
  if (models.length > 10_000) fail('discovered models exceed the catalog limit');
  for (const model of models) {
    parseModel(
      {
        id: model.id,
        name: model.name,
        ...(model.contextWindow !== undefined ? { contextWindow: model.contextWindow } : {}),
      },
      'models',
    );
  }
}

function parseEndpoint(value: unknown, index: number, maxModels: number): ParsedEndpoint {
  const label = `endpoints[${index}]`;
  const endpoint = object(value, label);
  exactFields(
    endpoint,
    ['protocol', 'baseUrl', 'targets', 'models', 'modelsUrl', 'requestPath', 'headers', 'apiKey'],
    label,
  );
  if (
    typeof endpoint.protocol !== 'string' ||
    !PROTOCOLS.includes(endpoint.protocol as ProviderWireProtocol)
  ) {
    fail(`${label}.protocol is unsupported`);
  }
  const protocol = endpoint.protocol as ProviderWireProtocol;
  let targets: AgentKind[] | undefined;
  if (endpoint.targets !== undefined) {
    if (!Array.isArray(endpoint.targets) || endpoint.targets.length === 0)
      fail(`${label}.targets must be a non-empty array`);
    targets = endpoint.targets.map((target) => {
      if (typeof target !== 'string' || !AGENTS.includes(target as AgentKind))
        fail(`${label}.targets contains an unsupported Harness`);
      return target as AgentKind;
    });
    if (new Set(targets).size !== targets.length) fail(`${label}.targets contains duplicates`);
  }
  const modelsRaw = endpoint.models ?? [];
  if (!Array.isArray(modelsRaw) || modelsRaw.length > maxModels) {
    fail(`${label}.models must be a bounded array`);
  }
  const models = modelsRaw.map((model, modelIndex) =>
    parseModel(model, `${label}.models[${modelIndex}]`),
  );
  if (new Set(models.map((model) => model.id)).size !== models.length)
    fail(`${label}.models contains duplicate ids`);
  let requestPath: string | undefined;
  if (endpoint.requestPath !== undefined) {
    requestPath = boundedString(endpoint.requestPath, `${label}.requestPath`, 256);
    if (!/^\/(?!\/)[^?#\s]*$/.test(requestPath)) fail(`${label}.requestPath is invalid`);
  }
  let apiKey: string | undefined;
  if (endpoint.apiKey !== undefined)
    apiKey = parseApiKey(endpoint.apiKey, `${label}.apiKey`, MAX_API_KEY_LENGTH);
  const baseUrl = httpUrl(endpoint.baseUrl, `${label}.baseUrl`, false, true);
  const modelsUrl =
    endpoint.modelsUrl !== undefined
      ? httpUrl(endpoint.modelsUrl, `${label}.modelsUrl`, false, true)
      : undefined;
  if (modelsUrl && new URL(modelsUrl).origin !== new URL(baseUrl).origin) {
    fail(`${label}.modelsUrl must share the endpoint origin`);
  }
  return {
    protocol,
    baseUrl,
    ...(targets ? { targets } : {}),
    models,
    ...(modelsUrl ? { modelsUrl } : {}),
    ...(requestPath ? { requestPath } : {}),
    ...(endpoint.headers !== undefined
      ? {
          headers: parseHttpHeaders(endpoint.headers, `${label}.headers`),
        }
      : {}),
    ...(apiKey ? { apiKey } : {}),
  };
}

function parseOAuth(auth: Record<string, unknown>): OAuthProviderDescriptor {
  const flow = auth.flow ?? 'authorization-code';
  if (flow !== 'authorization-code' && flow !== 'device-code') fail('auth.flow is unsupported');
  const common = {
    tokenUrl: httpUrl(auth.tokenUrl, 'auth.tokenUrl', true, true),
    clientId: boundedString(auth.clientId, 'auth.clientId', 512),
    scopes: auth.scopes === '' ? '' : boundedString(auth.scopes, 'auth.scopes', 2_048),
    ...(auth.modelsDiscoveryUrl !== undefined
      ? {
          modelsDiscoveryUrl: httpUrl(
            auth.modelsDiscoveryUrl,
            'auth.modelsDiscoveryUrl',
            true,
            true,
          ),
        }
      : {}),
  };
  if (flow === 'device-code') {
    exactFields(
      auth,
      [
        'method',
        'flow',
        'deviceAuthorizationUrl',
        'tokenUrl',
        'clientId',
        'scopes',
        'modelsDiscoveryUrl',
        'extraDeviceParams',
      ],
      'auth',
    );
    return {
      flow: 'device-code',
      deviceAuthorizationUrl: httpUrl(
        auth.deviceAuthorizationUrl,
        'auth.deviceAuthorizationUrl',
        true,
        true,
      ),
      ...common,
      ...(auth.extraDeviceParams !== undefined
        ? {
            extraDeviceParams: parsePublicOAuthParams(
              auth.extraDeviceParams,
              'auth.extraDeviceParams',
            ),
          }
        : {}),
    };
  }
  exactFields(
    auth,
    [
      'method',
      'flow',
      'authorizeUrl',
      'tokenUrl',
      'clientId',
      'scopes',
      'modelsDiscoveryUrl',
      'redirectPort',
      'extraAuthParams',
    ],
    'auth',
  );
  let redirectPort: number | undefined;
  if (auth.redirectPort !== undefined) {
    if (
      !Number.isInteger(auth.redirectPort) ||
      (auth.redirectPort as number) <= 0 ||
      (auth.redirectPort as number) >= 65_536
    ) {
      fail('auth.redirectPort is invalid');
    }
    redirectPort = auth.redirectPort as number;
  }
  return {
    flow: 'authorization-code',
    authorizeUrl: httpUrl(auth.authorizeUrl, 'auth.authorizeUrl', true, true),
    ...common,
    ...(redirectPort ? { redirectPort } : {}),
    ...(auth.extraAuthParams !== undefined
      ? { extraAuthParams: parsePublicOAuthParams(auth.extraAuthParams, 'auth.extraAuthParams') }
      : {}),
  };
}

function defaultTargets(protocol: ProviderWireProtocol): AgentKind[] {
  if (protocol === 'anthropic-messages' || protocol === 'google-generative-ai') {
    return ['claude-code', 'codex', 'pi'];
  }
  return ['codex', 'pi'];
}

function protocolPriority(agent: AgentKind, protocol: ProviderWireProtocol): number {
  if (agent === 'claude-code') {
    if (protocol === 'anthropic-messages') return 100;
    if (protocol === 'google-generative-ai') return 30;
    if (protocol === 'openai-chat') return 20;
    if (protocol === 'openai-responses') return 10;
    return -1;
  }
  if (agent === 'codex') {
    if (protocol === 'openai-responses') return 30;
    if (protocol === 'openai-chat') return 20;
    return 10;
  }
  if (protocol === 'openai-chat') return 30;
  if (protocol === 'openai-responses') return 20;
  return 10;
}

function slugFromName(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return slug || `provider-${randomUUID().slice(0, 8)}`;
}

function parsePayload(value: unknown, maxModels: number): ProviderImportDraft {
  const input = object(value, 'data');
  if (input.kind === 'builtin') {
    exactFields(input, ['kind', 'provider', 'apiKey'], 'data');
    if (!isBuiltinApiKeyProviderId(input.provider)) fail('unsupported built-in API-key slot');
    return {
      kind: 'builtin',
      provider: input.provider,
      apiKey: parseApiKey(input.apiKey, 'data.apiKey', MAX_BUILTIN_API_KEY_LENGTH),
    };
  }
  if (input.kind === 'preset') {
    exactFields(input, ['kind', 'preset', 'apiKey'], 'data');
    return {
      kind: 'custom',
      presetId: boundedString(input.preset, 'data.preset', 128),
      presetApiKey: parseApiKey(input.apiKey, 'data.apiKey', MAX_API_KEY_LENGTH),
      config: { id: `import-${randomUUID().slice(0, 8)}`, name: 'Import', runtimes: {} },
      keys: {},
    };
  }
  if (input.kind !== 'custom') fail('data.kind is unsupported');
  exactFields(input, ['kind', 'id', 'name', 'auth', 'endpoints'], 'data');
  const name = boundedString(input.name, 'data.name', 60);
  const explicitId = input.id !== undefined;
  const id = explicitId ? boundedString(input.id, 'data.id', 40) : slugFromName(name);
  if (!PROVIDER_ID_RE.test(id)) fail('data.id must be a lowercase provider slug');
  if (
    [
      'anthropic',
      'openai',
      'xai',
      'xd',
      'cindy',
      'gemini',
      'openai-images',
      MANAGED_LMSTUDIO_PROVIDER_ID,
    ].includes(id) ||
    isManagedSidecarProviderId(id)
  ) {
    fail('data.id is reserved');
  }
  const authInput =
    input.auth === undefined ? { method: 'apiKey' } : object(input.auth, 'data.auth');
  if (
    authInput.method !== 'apiKey' &&
    authInput.method !== 'oauth' &&
    authInput.method !== 'none'
  ) {
    fail('data.auth.method is unsupported');
  }
  let auth: CustomProviderConfig['auth'];
  let sharedApiKey: string | undefined;
  if (authInput.method === 'apiKey') {
    exactFields(authInput, ['method', 'apiKey'], 'auth');
    if (authInput.apiKey !== undefined)
      sharedApiKey = parseApiKey(authInput.apiKey, 'auth.apiKey', MAX_API_KEY_LENGTH);
    auth = { method: 'apiKey' };
  } else if (authInput.method === 'none') {
    exactFields(authInput, ['method'], 'auth');
    auth = { method: 'none' };
  } else {
    auth = { method: 'oauth', oauth: parseOAuth(authInput) };
  }
  if (
    !Array.isArray(input.endpoints) ||
    input.endpoints.length === 0 ||
    input.endpoints.length > MAX_ENDPOINTS
  ) {
    fail('data.endpoints must be a bounded non-empty array');
  }
  const endpoints = input.endpoints.map((endpoint, index) =>
    parseEndpoint(endpoint, index, maxModels),
  );
  if (
    auth?.method === 'none' &&
    endpoints.some(
      (endpoint) =>
        !isLoopbackProviderUrl(endpoint.baseUrl) ||
        (endpoint.modelsUrl !== undefined && !isLoopbackProviderUrl(endpoint.modelsUrl)),
    )
  ) {
    fail('no-auth endpoints and model discovery must use loopback URLs');
  }
  if (
    auth?.method !== 'apiKey' &&
    endpoints.some((endpoint) => endpoint.apiKey || endpoint.headers)
  ) {
    fail('endpoint credentials are only supported with API-key authentication');
  }
  // OAuth model discovery sends the access token to this URL. A deep link is untrusted input,
  // so it must not be able to nominate an unrelated collector host. This restriction applies
  // at the external import boundary and does not change existing manually-authored providers.
  if (auth?.method === 'oauth' && auth.oauth?.modelsDiscoveryUrl) {
    const discoveryOrigin = new URL(auth.oauth.modelsDiscoveryUrl).origin;
    if (!endpoints.some((endpoint) => new URL(endpoint.baseUrl).origin === discoveryOrigin)) {
      fail('auth.modelsDiscoveryUrl must share an endpoint origin');
    }
  }
  const candidates = new Map<AgentKind, ParsedEndpoint[]>();
  for (const endpoint of endpoints) {
    // Generic OAuth credentials are held by Cindy's OAuth runner and Pi does not consume them.
    // Keep the compact vendor format useful by omitting Pi from implicit defaults; an explicit
    // Pi target remains an error so a vendor cannot accidentally advertise an unusable runtime.
    const targets =
      endpoint.targets ??
      defaultTargets(endpoint.protocol).filter(
        (target) => auth?.method !== 'oauth' || target !== 'pi',
      );
    for (const target of targets) {
      if (target === 'claude-code' && !PROTOCOLS.includes(endpoint.protocol)) {
        fail('Claude Code endpoint protocol is unsupported');
      }
      if (target === 'pi' && auth?.method === 'oauth')
        fail('custom OAuth providers do not support Pi');
      const list = candidates.get(target) ?? [];
      list.push(endpoint);
      candidates.set(target, list);
    }
  }
  const runtimes: CustomProviderConfig['runtimes'] = {};
  const keys: Partial<Record<AgentKind, string>> = {};
  for (const agent of AGENTS) {
    const list = candidates.get(agent) ?? [];
    if (list.length === 0) continue;
    const ranked = [...list].sort(
      (a, b) => protocolPriority(agent, b.protocol) - protocolPriority(agent, a.protocol),
    );
    const selected = ranked[0]!;
    if (
      ranked[1] &&
      protocolPriority(agent, ranked[1].protocol) === protocolPriority(agent, selected.protocol)
    ) {
      fail(`multiple endpoints compete for ${agent}; set explicit targets`);
    }
    const models = selected.models.map((source) => adaptCustomProviderModelEfforts(source, agent));
    runtimes[agent] = {
      wireProtocol: selected.protocol,
      baseUrl: selected.baseUrl,
      models,
      ...(agent !== 'pi' && selected.requestPath ? { requestPath: selected.requestPath } : {}),
      ...(selected.modelsUrl ? { modelsUrl: selected.modelsUrl } : {}),
      ...(selected.headers ? { headers: { ...selected.headers } } : {}),
    };
    const key = selected.apiKey ?? sharedApiKey;
    if (auth?.method === 'apiKey' && key) keys[agent] = key;
  }
  // A vendor slug is a naming hint, never the identity of an existing local account.
  return {
    kind: 'custom',
    config: { id: `${id.slice(0, 24)}-${randomUUID().slice(0, 8)}`, name, auth, runtimes },
    keys,
  };
}

function decodeBase64Url(value: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) fail('data is not valid base64url');
  const bytes = Buffer.from(value, 'base64url');
  const canonical = bytes.toString('base64url');
  if (canonical !== value.replace(/=+$/, '')) fail('data is not canonical base64url');
  const decoded = bytes.toString('utf8');
  if (Buffer.from(decoded, 'utf8').compare(bytes) !== 0) fail('data is not valid UTF-8');
  if (bytes.length === 0 || bytes.length > MAX_JSON_LENGTH)
    fail('decoded data exceeds the size limit');
  return decoded;
}

function pruneExpired(now = Date.now()): void {
  for (const [id, record] of drafts)
    if (!record.confirming && record.expiresAt <= now) drafts.delete(id);
}

/** Both transports use the same validation, ownership, preview and confirmation lifecycle. */
function createDraft(value: unknown, maxModels: number, scope?: ProviderImportScope): string {
  const draft = parsePayload(value, maxModels);
  if (draft.kind === 'custom' && draft.config.auth?.method === 'oauth') {
    const discovery = draft.config.auth.oauth?.modelsDiscoveryUrl;
    if (
      discovery &&
      Object.values(draft.config.runtimes).some(
        (runtime) => new URL(runtime!.baseUrl).origin !== new URL(discovery).origin,
      )
    )
      fail('OAuth model discovery must share every runtime origin');
  }
  pruneExpired();
  if (drafts.size >= MAX_DRAFTS) fail('too many pending provider imports');
  const importId = randomUUID();
  drafts.set(importId, {
    draft,
    expiresAt: Date.now() + IMPORT_TTL_MS,
    confirming: false,
    ...(scope ? { scope: { ...scope } } : {}),
  });
  return importId;
}

/** Main-only: the file contains a v1 payload, never a URL or renderer-provided path. */
export function createProviderImportDraftFromFile(
  bytes: Buffer,
  scope: ProviderImportScope,
): string {
  return createDraft(decodeProviderImportFile(bytes), MAX_FILE_MODELS_PER_ENDPOINT, scope);
}

function decodeProviderImportFile(bytes: Buffer): unknown {
  if (!bytes.length || bytes.length > MAX_PROVIDER_IMPORT_FILE_BYTES)
    fail('provider import file exceeds the size limit');
  const decoded = bytes.toString('utf8');
  if (!Buffer.from(decoded, 'utf8').equals(bytes)) fail('provider import file is not UTF-8');
  // UTF-8 BOMs are common in files saved by Windows editors.
  return JSON.parse(decoded.replace(/^\uFEFF/, ''));
}

/** Validate the whole batch before exposing any drafts; rollback only in-memory drafts on failure. */
export function createProviderImportDraftsFromFile(
  bytes: Buffer,
  scope: ProviderImportScope,
): string[] {
  const input = object(decodeProviderImportFile(bytes), 'data');
  if (!Object.hasOwn(input, 'providers'))
    return [createDraft(input, MAX_FILE_MODELS_PER_ENDPOINT, scope)];
  exactFields(input, ['providers'], 'data');
  if (
    !Array.isArray(input.providers) ||
    !input.providers.length ||
    input.providers.length > MAX_FILE_PROVIDERS
  )
    fail('providers must contain 1 to 50 configurations');
  const ids: string[] = [];
  const destinations = new Set<string>();
  try {
    for (const value of input.providers) {
      const id = createDraft(value, MAX_FILE_MODELS_PER_ENDPOINT, scope);
      ids.push(id);
      const draft = drafts.get(id)!.draft;
      const source = object(value, 'provider');
      const destination =
        draft.kind === 'builtin'
          ? `builtin:${draft.provider}`
          : typeof source.id === 'string'
            ? `custom:${source.id.trim()}`
            : undefined;
      if (destination) {
        if (destinations.has(destination)) fail('duplicate provider identity in file');
        destinations.add(destination);
      }
    }
    return ids;
  } catch (error) {
    for (const id of ids) drafts.delete(id);
    throw error;
  }
}

/** Parse the exact `provider/import` path and create a short-lived secret-bearing draft. */
export function createProviderImportDraftFromRest(rest: string): string | null {
  if (!rest.startsWith('provider/')) return null;
  if (rest.length > MAX_URL_LENGTH || rest.includes('#')) return null;
  const queryIndex = rest.indexOf('?');
  if (queryIndex < 0 || rest.slice(0, queryIndex) !== 'provider/import') return null;
  const params = new URLSearchParams(rest.slice(queryIndex + 1));
  if ([...params.keys()].some((key) => key !== 'v' && key !== 'data')) return null;
  if (
    params.getAll('v').length !== 1 ||
    params.getAll('data').length !== 1 ||
    params.get('v') !== '1'
  )
    return null;
  const encoded = params.get('data');
  if (!encoded) return null;
  try {
    return createDraft(JSON.parse(decodeBase64Url(encoded)), MAX_MODELS_PER_ENDPOINT);
  } catch {
    return null;
  }
}

function normalizedUrl(value: string): string {
  try {
    return new URL(value).toString().replace(/\/$/, '');
  } catch {
    return value.trim().replace(/\/$/, '');
  }
}

/** Only credentials for the same explicitly selected destinations may be replaced. */
export function importKeysForCurrentConfig(
  draft: ProviderImportDraft,
  current: CustomProviderConfig,
): void {
  if (
    draft.kind !== 'custom' ||
    (draft.config.auth?.method ?? 'apiKey') !== 'apiKey' ||
    (current.auth?.method ?? 'apiKey') !== 'apiKey' ||
    isManagedSidecarProviderId(current.id) ||
    current.id === MANAGED_LMSTUDIO_PROVIDER_ID
  )
    fail('connection cannot receive imported keys');
  const agents = AGENTS.filter((agent) => draft.keys[agent]);
  if (!agents.length) fail('no API keys to update');
  for (const agent of agents) {
    const incoming = draft.config.runtimes[agent]!;
    const existing = current.runtimes[agent];
    const protocol = (value: typeof existing) =>
      value?.wireProtocol ?? (agent === 'claude-code' ? 'anthropic-messages' : 'openai-responses');
    if (
      !existing ||
      normalizedUrl(incoming.baseUrl) !== normalizedUrl(existing.baseUrl) ||
      protocol(incoming) !== protocol(existing) ||
      (incoming.requestPath ?? '') !== (existing.requestPath ?? '')
    )
      fail('connection destinations changed');
  }
}

function canUpdate(draft: ProviderImportDraft, provider: ProviderView): boolean {
  if (provider.source !== 'user') return false;
  const runtimes: CustomProviderConfig['runtimes'] = {};
  for (const agent of AGENTS) {
    const route = provider.routing[agent];
    if (route)
      runtimes[agent] = {
        baseUrl: route.upstream,
        wireProtocol: route.wireProtocol,
        requestPath: route.requestPath,
        models: [],
      };
  }
  try {
    importKeysForCurrentConfig(draft, {
      id: provider.id,
      name: provider.name,
      auth: { method: provider.auth.method },
      runtimes,
    } as CustomProviderConfig);
    return true;
  } catch {
    return false;
  }
}

function resolveDraft(
  draft: ProviderImportDraft,
  providers: readonly ProviderView[],
  target?: unknown,
): ProviderImportResolution {
  if (target !== undefined && (typeof target !== 'string' || !target || target.length > 128))
    fail('invalid target connection');
  if (draft.kind === 'builtin') {
    if (target !== undefined) fail('built-in key target is fixed');
    const provider = providers.find((candidate) => candidate.id === draft.provider);
    return {
      action: 'replace-key',
      providerId: draft.provider,
      existingProviderName:
        provider?.name ?? (draft.provider === 'gemini' ? 'Google Gemini' : 'OpenAI Images'),
    };
  }
  if (target !== undefined) {
    const provider = providers.find((candidate) => candidate.id === target);
    if (!provider || !canUpdate(draft, provider)) fail('selected connection is not compatible');
    return { action: 'update', providerId: provider.id, existingProviderName: provider.name };
  }
  if (providers.some((provider) => provider.id === draft.config.id))
    fail('new connection ID is already in use');
  return { action: 'create', providerId: draft.config.id };
}

/** Resolve public catalog IDs locally once, then freeze exactly what the user reviews. */
function materializePreset(record: DraftRecord, presets: readonly ProviderPreset[]): void {
  const draft = record.draft;
  if (draft.kind !== 'custom' || !draft.presetId) return;
  const preset = presets.find((candidate) => candidate.id === draft.presetId);
  if (!preset || preset.authMethod === 'none') fail('unsupported API-key preset');
  const runtimes: CustomProviderConfig['runtimes'] = {};
  for (const agent of configuredPresetAgents(preset)) {
    const rt = preset.runtimes[agent]!;
    runtimes[agent] = presetConnectionRuntime(
      preset,
      agent,
      rt.models.map((model) => ({
        id: model.id,
        name: model.name,
        discoveredMetadata: {},
        ...(model.mode ? { mode: model.mode } : {}),
        ...(model.modalities ? { modalities: model.modalities } : {}),
        ...(model.officialDocs ? { officialDocs: model.officialDocs } : {}),
        ...(agent === 'pi' && model.piApi ? { piApi: model.piApi } : {}),
        ...(model.route ? { route: model.route } : {}),
      })),
    );
    draft.keys[agent] = draft.presetApiKey!;
  }
  if (!Object.keys(runtimes).length) fail('preset has no supported runtimes');
  draft.config = { id: draft.config.id, name: preset.name, runtimes };
  delete draft.presetId;
  delete draft.presetApiKey;
}

function sameScope(a: ProviderImportScope | undefined, b: ProviderImportScope): boolean {
  return !!a && a.dataOwnerId === b.dataOwnerId && a.generation === b.generation;
}

function requireRecord(importId: unknown): DraftRecord {
  pruneExpired();
  if (typeof importId !== 'string' || !/^[0-9a-f-]{36}$/.test(importId))
    fail('invalid provider import id');
  const record = drafts.get(importId);
  if (!record) fail('provider import expired or was already used');
  return record;
}

export function previewProviderImport(
  importId: unknown,
  scope: ProviderImportScope,
  providers: readonly ProviderView[],
  target?: unknown,
  presets: readonly ProviderPreset[] = [],
): ProviderImportPreview {
  const record = requireRecord(importId);
  if (record.scope && !sameScope(record.scope, scope)) fail('the active account changed');
  if (record.confirming) fail('provider import confirmation is already running');
  if (record.local && (record.local.issue || record.local.completed))
    fail('local import requires input or was completed');
  materializePreset(record, presets);
  const resolution = resolveDraft(record.draft, providers, target);
  record.scope = { ...scope };
  record.resolution = resolution;
  const draft = record.draft;
  if (draft.kind === 'builtin') {
    return {
      importId: importId as string,
      kind: 'builtin',
      name: resolution.existingProviderName ?? 'Google Gemini',
      authMethod: 'apiKey',
      ...resolution,
      runtimes: [],
      updateTargets: [],
    };
  }
  const authMethod = draft.config.auth?.method ?? 'apiKey';
  const runtimes = AGENTS.flatMap((agent): ProviderImportRuntimePreview[] => {
    const runtime = draft.config.runtimes[agent];
    if (!runtime) return [];
    return [
      {
        agent,
        protocol:
          runtime.wireProtocol ??
          (agent === 'claude-code' ? 'anthropic-messages' : 'openai-responses'),
        baseUrl: runtime.baseUrl,
        modelCount: runtime.models.length,
        willFetchModels:
          resolution.action === 'create' && authMethod !== 'oauth' && runtime.models.length === 0,
        ...(runtime.modelsUrl ? { modelsUrl: runtime.modelsUrl } : {}),
        hasApiKey: Boolean(draft.keys[agent]),
        headerNames: Object.keys(runtime.headers ?? {}).sort(),
      },
    ];
  });
  const oauth = draft.config.auth?.method === 'oauth' ? draft.config.auth.oauth : null;
  return {
    importId: importId as string,
    kind: 'custom',
    name: draft.config.name,
    ...(record.local ? { localSource: record.local.source } : {}),
    authMethod,
    ...resolution,
    runtimes,
    updateTargets: (record.local ? [] : providers)
      .filter((provider) => canUpdate(draft, provider))
      .map(({ id, name }) => ({ id, name })),
    ...(oauth
      ? {
          oauth: {
            flow: oauth.flow === 'device-code' ? 'device-code' : 'authorization-code',
            authorizeHost: new URL(
              oauth.flow === 'device-code' ? oauth.deviceAuthorizationUrl : oauth.authorizeUrl,
            ).hostname,
            tokenHost: new URL(oauth.tokenUrl).hostname,
          },
        }
      : {}),
  };
}

export function beginProviderImportConfirm(
  importId: unknown,
  scope: ProviderImportScope,
  providers: readonly ProviderView[],
  target?: unknown,
): { draft: ProviderImportDraft; resolution: ProviderImportResolution } {
  const record = requireRecord(importId);
  if (record.scope && !sameScope(record.scope, scope)) fail('the active account changed');
  if (!record.scope || !record.resolution) fail('preview this import again before confirming');
  if (record.confirming) fail('provider import confirmation is already running');
  const latest = resolveDraft(record.draft, providers, target);
  if (JSON.stringify(latest) !== JSON.stringify(record.resolution))
    fail('provider list changed; preview the import again');
  record.confirming = true;
  return { draft: record.draft, resolution: latest };
}

export function finishProviderImportConfirm(importId: string, succeeded: boolean): void {
  const record = drafts.get(importId);
  if (!record) return;
  if (succeeded && record.local && record.draft.kind === 'custom') {
    const providerId = record.draft.config.id;
    record.local.completed = providerId;
    record.local.entry = { ref: '', name: '', endpoints: [] };
    record.draft = { kind: 'custom', config: { id: providerId, name: '', runtimes: {} }, keys: {} };
    record.confirming = false;
  } else if (succeeded) drafts.delete(importId);
  else record.confirming = false;
}

export function cancelProviderImport(importId: unknown): void {
  if (typeof importId === 'string' && !drafts.get(importId)?.confirming) drafts.delete(importId);
}

/** Test-only reset for deterministic isolation. */
export function clearProviderImportDraftsForTest(): void {
  drafts.clear();
}

/** Stable Main-only comparison. Neither this material nor its digest crosses IPC. */
export function localEntryVersion(entry: LocalSourceEntry): string {
  return createHash('sha256')
    .update(JSON.stringify(canonical(entry)))
    .digest('hex');
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, canonical(v)]),
    );
  return value;
}
function localHasCredential(endpoint: LocalSourceEntry['endpoints'][number]): boolean {
  return (
    !!endpoint.apiKey ||
    Object.entries(endpoint.headers ?? {}).some(
      ([k, v]) => /^(authorization|x-api-key|api-key|x-goog-api-key)$/i.test(k) && !!v,
    )
  );
}
function rebuildLocalDraft(record: DraftRecord): void {
  const local = record.local!;
  record.resolution = undefined;
  if (local.entry.issue) {
    local.issue = local.entry.issue;
    return;
  }
  if (
    !local.entry.endpoints.length ||
    local.entry.endpoints.some((e) => !e.baseUrl || !e.protocol || !localHasCredential(e))
  ) {
    local.issue = 'needsInput';
    return;
  }
  try {
    const previousId = record.draft.kind === 'custom' ? record.draft.config.id : '';
    const draft = parsePayload(
      {
        kind: 'custom',
        name: local.entry.name,
        auth: { method: 'apiKey' },
        endpoints: local.entry.endpoints.map(({ agent, ...e }) => ({ ...e, targets: [agent] })),
      },
      MAX_FILE_MODELS_PER_ENDPOINT,
    );
    if (draft.kind !== 'custom') fail('invalid local draft');
    draft.config.id = previousId;
    for (const e of local.entry.endpoints) {
      for (const model of draft.config.runtimes[e.agent]?.models ?? []) {
        if (e.models.find((m) => m.id === model.id)?.defaultEnabled === true)
          model.defaultEnabled = true;
      }
    }
    record.draft = draft;
    local.issue = undefined;
  } catch {
    local.issue = 'invalid';
  }
}
/** Shares the existing quota, expiry, owner and confirmation store. */
export function createLocalProviderImport(
  source: LocalProviderSource,
  entry: LocalSourceEntry,
  scope: ProviderImportScope,
  reload: () => Promise<LocalSourceEntry | undefined>,
): LocalProviderImportItem {
  pruneExpired();
  if (drafts.size >= MAX_DRAFTS) fail('too many pending provider imports');
  const id = randomUUID();
  const record: DraftRecord = {
    draft: {
      kind: 'custom',
      config: { id: `local-${randomUUID().replaceAll('-', '')}`, name: entry.name, runtimes: {} },
      keys: {},
    },
    scope: { ...scope },
    expiresAt: Date.now() + IMPORT_TTL_MS,
    confirming: false,
    local: { source, entry: structuredClone(entry), original: localEntryVersion(entry), reload },
  };
  rebuildLocalDraft(record);
  drafts.set(id, record);
  return localProviderImportItem(id, scope);
}
export function isLocalProviderImport(id: unknown): boolean {
  return typeof id === 'string' && !!drafts.get(id)?.local;
}
/** Main-only access for comparing with owner-scoped persisted credentials. */
export function localProviderImportDraft(
  id: string,
  scope: ProviderImportScope,
): ProviderImportDraft {
  const record = localRecord(id, scope);
  if (record.local!.issue || record.local!.completed) fail('local import is not ready');
  return record.draft;
}
export function completeEquivalentLocalImport(
  id: string,
  providerId: string,
  scope: ProviderImportScope,
): void {
  const record = localRecord(id, scope);
  if (record.draft.kind !== 'custom') fail('invalid local draft');
  record.draft.config.id = providerId;
  finishProviderImportConfirm(id, true);
}
function localRecord(id: unknown, scope: ProviderImportScope): DraftRecord {
  const record = requireRecord(id);
  if (!record.local || !sameScope(record.scope, scope))
    fail('local import expired or owner changed');
  return record;
}
export function localProviderImportItem(
  id: string,
  scope: ProviderImportScope,
): LocalProviderImportItem {
  const record = localRecord(id, scope),
    local = record.local!;
  // Malformed URL text may itself contain a secret. Never show query/userinfo fragments.
  const safeUrl = (raw: string): string => {
    try {
      const u = new URL(raw);
      return /^https?:$/.test(u.protocol) && !u.username && !u.password && !u.search && !u.hash
        ? u.toString()
        : '';
    } catch {
      return '';
    }
  };
  return {
    importId: id,
    source: local.source,
    name: local.entry.name.slice(0, 60),
    ...(local.entry.disabled ? { disabled: true } : {}),
    ...(local.issue ? { issue: local.issue } : {}),
    endpoints: local.entry.endpoints.map((e) => ({
      agent: e.agent,
      protocol: e.protocol,
      baseUrl: safeUrl(e.baseUrl),
      hasCredential: localHasCredential(e),
    })),
  };
}
export function editLocalProviderImport(
  id: unknown,
  input: unknown,
  scope: ProviderImportScope,
): LocalProviderImportItem {
  const record = localRecord(id, scope),
    local = record.local!;
  if (record.confirming || local.completed || local.entry.issue || local.issue === 'changed')
    fail('local import cannot be edited');
  const edit = object(input, 'edit');
  exactFields(edit, ['name', 'endpoints'], 'edit');
  const name = boundedString(edit.name, 'name', 60);
  if (!Array.isArray(edit.endpoints) || edit.endpoints.length !== local.entry.endpoints.length)
    fail('invalid local endpoints');
  const endpoints = edit.endpoints.map((raw, i) => {
    const e = object(raw, 'endpoint');
    exactFields(e, ['baseUrl', 'protocol', 'apiKey'], 'endpoint');
    const baseUrl = httpUrl(e.baseUrl, 'baseUrl', false, true);
    if (!PROTOCOLS.includes(e.protocol as ProviderWireProtocol)) fail('invalid protocol');
    const prior = local.entry.endpoints[i];
    // Exact destination/protocol edits release old credentials and discovery destination.
    let same = false;
    try {
      same =
        new URL(baseUrl).toString() === new URL(prior.baseUrl).toString() &&
        e.protocol === prior.protocol;
    } catch {
      /* missing source URL */
    }
    const { apiKey: oldKey, headers, modelsUrl, requestPath, ...rest } = prior;
    const ordinaryHeaders = Object.fromEntries(
      Object.entries(headers ?? {}).filter(
        ([k]) => !/^(authorization|x-api-key|api-key|x-goog-api-key)$/i.test(k),
      ),
    );
    const replacement =
      e.apiKey === undefined
        ? undefined
        : e.apiKey === ''
          ? ''
          : parseApiKey(e.apiKey, 'apiKey', MAX_API_KEY_LENGTH);
    const authHeaders = Object.entries(headers ?? {}).filter(([k]) =>
      /^(authorization|x-api-key|api-key|x-goog-api-key)$/i.test(k),
    );
    const headerAuth =
      !oldKey &&
      e.protocol === prior.protocol &&
      authHeaders.length === 1 &&
      (authHeaders[0][0].toLowerCase() !== 'authorization' || /^Bearer\s+/i.test(authHeaders[0][1]))
        ? authHeaders[0]
        : undefined;
    const replacementHeaders = {
      ...(same ? ordinaryHeaders : {}),
      ...(headerAuth && replacement
        ? {
            [headerAuth[0]]:
              headerAuth[0].toLowerCase() === 'authorization'
                ? `Bearer ${replacement}`
                : replacement,
          }
        : {}),
    };
    return {
      ...rest,
      baseUrl,
      protocol: e.protocol as ProviderWireProtocol,
      ...(same ? { apiKey: oldKey, headers, modelsUrl, requestPath } : {}),
      ...(replacement !== undefined
        ? {
            apiKey: headerAuth ? undefined : replacement || undefined,
            headers: Object.keys(replacementHeaders).length ? replacementHeaders : undefined,
          }
        : {}),
    };
  });
  local.entry = { ...local.entry, name, endpoints };
  rebuildLocalDraft(record);
  return localProviderImportItem(id as string, scope);
}
export async function checkLocalProviderImportSource(
  id: unknown,
  scope: ProviderImportScope,
): Promise<string | undefined> {
  if (!isLocalProviderImport(id)) return;
  const record = localRecord(id, scope),
    local = record.local!;
  if (record.confirming) fail('local confirmation is running');
  if (local.completed) return local.completed;
  const current = await local.reload();
  localRecord(id, scope);
  if (!current || localEntryVersion(current) !== local.original) {
    local.issue = 'changed';
    record.resolution = undefined;
    fail('saved source changed; scan again');
  }
  if (local.issue) fail('local import requires input');
}
/** Ignore discovered models only when the source supplied no explicit model selection. */
export function equivalentLocalProvider(
  draft: ProviderImportDraft,
  config: CustomProviderConfig,
  keys: Partial<Record<AgentKind, string>>,
): boolean {
  if (draft.kind !== 'custom' || (config.auth?.method ?? 'apiKey') !== 'apiKey') return false;
  const incoming = draft.config;
  if (Object.keys(incoming.runtimes).sort().join() !== Object.keys(config.runtimes).sort().join())
    return false;
  for (const agent of AGENTS) {
    const a = incoming.runtimes[agent],
      b = config.runtimes[agent];
    if (!a || !b) {
      if (a || b) return false;
      continue;
    }
    const { models: ms, ...route } = a;
    const { models: otherModels, ...otherRoute } = b;
    if (
      JSON.stringify(canonical(route)) !== JSON.stringify(canonical(otherRoute)) ||
      (draft.keys[agent] ?? '') !== (keys[agent] ?? '')
    )
      return false;
    if (
      ms.length &&
      (ms.length !== otherModels.length ||
        ms.some(
          (m) =>
            !otherModels.some((other) =>
              Object.entries(m).every(
                ([k, v]) =>
                  JSON.stringify(canonical(v)) ===
                  JSON.stringify(canonical(other[k as keyof typeof other])),
              ),
            ),
        ))
    )
      return false;
  }
  return true;
}
