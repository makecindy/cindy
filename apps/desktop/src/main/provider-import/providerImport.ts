/**
 * Provider import deep links.
 *
 * The external URL may contain credentials, so it is converted immediately into a
 * short-lived Main-process draft. Only the opaque import id and redacted previews
 * are ever sent through Electron IPC to the Renderer.
 */

import { randomUUID } from 'node:crypto';

import type {
  AgentKind,
  CustomProviderConfig,
  OAuthProviderDescriptor,
  PiReasoningEffort,
  ProviderRuntimeModelConfig,
  ProviderView,
  ProviderWireProtocol,
} from '@cindy/model-providers';
import type {
  ProviderImportPreview,
  ProviderImportRuntimePreview,
} from '../../shared/providerImport.js';

const IMPORT_TTL_MS = 10 * 60_000;
const MAX_URL_LENGTH = 32 * 1024;
const MAX_JSON_LENGTH = 24 * 1024;
const MAX_API_KEY_LENGTH = 4 * 1024;
const MAX_BUILTIN_API_KEY_LENGTH = 1024;
const MAX_ENDPOINTS = 8;
const MAX_MODELS_PER_ENDPOINT = 256;
const MAX_HEADERS_PER_ENDPOINT = 24;
const MAX_TEXT_LENGTH = 2 * 1024;
const MAX_DRAFTS = 128;
const PROVIDER_ID_RE = /^[a-z0-9_-]{1,40}$/;
const AGENTS: readonly AgentKind[] = ['claude-code', 'codex', 'pi'];
const PROTOCOLS: readonly ProviderWireProtocol[] = [
  'anthropic-messages',
  'openai-responses',
  'openai-chat',
];
const PI_EFFORTS: readonly PiReasoningEffort[] = [
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
];
const FORBIDDEN_OAUTH_IMPORT_PARAM_KEYS = new Set([
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
]);

type ProviderImportScope = { dataOwnerId: string | null; generation: number };

export type ProviderImportDraft =
  | { kind: 'builtin'; provider: 'gemini'; apiKey: string }
  | {
      kind: 'custom';
      explicitId: boolean;
      config: CustomProviderConfig;
      keys: Partial<Record<AgentKind, string>>;
    };

type DraftRecord = {
  draft: ProviderImportDraft;
  expiresAt: number;
  scope?: ProviderImportScope;
  resolution?: ProviderImportResolution;
  confirming: boolean;
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
    FORBIDDEN_OAUTH_IMPORT_PARAM_KEYS.has(key.trim().toLowerCase().replace(/-/g, '_')),
  );
  if (sensitiveKey) fail(`${label}.${sensitiveKey} cannot contain OAuth credentials`);
  return params;
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
      'contextWindow',
      'defaultEnabled',
      'supportsImageInput',
      'reasoning',
      'reasoningEfforts',
    ],
    label,
  );
  const id = boundedString(model.id, `${label}.id`, 256);
  const name = model.name === undefined ? id : boundedString(model.name, `${label}.name`, 256);
  const result: ProviderRuntimeModelConfig = { id, name };
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
  if (model.defaultEnabled === false) result.defaultEnabled = false;
  if (model.supportsImageInput === true) result.supportsImageInput = true;
  if (model.reasoning === true) {
    if (!Array.isArray(model.reasoningEfforts) || model.reasoningEfforts.length === 0) {
      fail(`${label}.reasoningEfforts is required when reasoning is enabled`);
    }
    const efforts = model.reasoningEfforts.map((effort) => {
      if (typeof effort !== 'string' || !PI_EFFORTS.includes(effort as PiReasoningEffort)) {
        fail(`${label}.reasoningEfforts contains an unsupported value`);
      }
      return effort as PiReasoningEffort;
    });
    if (new Set(efforts).size !== efforts.length)
      fail(`${label}.reasoningEfforts contains duplicates`);
    result.reasoning = true;
    result.reasoningEfforts = efforts;
  } else if (model.reasoningEfforts !== undefined) {
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

function parseEndpoint(value: unknown, index: number): ParsedEndpoint {
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
  if (!Array.isArray(modelsRaw) || modelsRaw.length > MAX_MODELS_PER_ENDPOINT) {
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
    apiKey = boundedString(endpoint.apiKey, `${label}.apiKey`, MAX_API_KEY_LENGTH);
  return {
    protocol,
    baseUrl: httpUrl(endpoint.baseUrl, `${label}.baseUrl`, false, true),
    ...(targets ? { targets } : {}),
    models,
    ...(endpoint.modelsUrl !== undefined
      ? { modelsUrl: httpUrl(endpoint.modelsUrl, `${label}.modelsUrl`, false, true) }
      : {}),
    ...(requestPath ? { requestPath } : {}),
    ...(endpoint.headers !== undefined
      ? {
          headers: parseStringRecord(
            endpoint.headers,
            `${label}.headers`,
            MAX_HEADERS_PER_ENDPOINT,
          ),
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
    scopes: boundedString(auth.scopes, 'auth.scopes', 2_048),
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
  if (protocol === 'anthropic-messages') return ['claude-code', 'codex', 'pi'];
  return ['codex', 'pi'];
}

function protocolPriority(agent: AgentKind, protocol: ProviderWireProtocol): number {
  if (agent === 'claude-code') return protocol === 'anthropic-messages' ? 100 : -1;
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

function parsePayload(value: unknown): ProviderImportDraft {
  const input = object(value, 'data');
  if (input.kind === 'builtin') {
    exactFields(input, ['kind', 'provider', 'apiKey'], 'data');
    if (input.provider !== 'gemini') fail('only the built-in Gemini API-key slot can be imported');
    return {
      kind: 'builtin',
      provider: 'gemini',
      apiKey: boundedString(input.apiKey, 'data.apiKey', MAX_BUILTIN_API_KEY_LENGTH),
    };
  }
  if (input.kind !== 'custom') fail('data.kind is unsupported');
  exactFields(input, ['kind', 'id', 'name', 'auth', 'endpoints'], 'data');
  const name = boundedString(input.name, 'data.name', 60);
  const explicitId = input.id !== undefined;
  const id = explicitId ? boundedString(input.id, 'data.id', 40) : slugFromName(name);
  if (!PROVIDER_ID_RE.test(id)) fail('data.id must be a lowercase provider slug');
  if (['anthropic', 'openai', 'xai', 'xd', 'cindy', 'gemini', 'openai-images'].includes(id)) {
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
      sharedApiKey = boundedString(authInput.apiKey, 'auth.apiKey', MAX_API_KEY_LENGTH);
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
  const endpoints = input.endpoints.map(parseEndpoint);
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
    const targets = endpoint.targets ?? defaultTargets(endpoint.protocol).filter(
      (target) => auth?.method !== 'oauth' || target !== 'pi',
    );
    for (const target of targets) {
      if (target === 'claude-code' && endpoint.protocol !== 'anthropic-messages') {
        fail('Claude Code only supports anthropic-messages endpoints');
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
    const models = selected.models.map((model) => {
      if (agent === 'pi') return { ...model };
      const { reasoning: _reasoning, reasoningEfforts: _efforts, ...portable } = model;
      return portable;
    });
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
  return { kind: 'custom', explicitId, config: { id, name, auth, runtimes }, keys };
}

function decodeBase64Url(value: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) fail('data is not valid base64url');
  const bytes = Buffer.from(value, 'base64url');
  const canonical = bytes.toString('base64url');
  if (canonical !== value.replace(/=+$/, '')) fail('data is not canonical base64url');
  const decoded = bytes.toString('utf8');
  if (Buffer.from(decoded, 'utf8').compare(bytes) !== 0) fail('data is not valid UTF-8');
  if (decoded.length === 0 || decoded.length > MAX_JSON_LENGTH)
    fail('decoded data exceeds the size limit');
  return decoded;
}

function pruneExpired(now = Date.now()): void {
  for (const [id, record] of drafts) if (record.expiresAt <= now) drafts.delete(id);
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
    const draft = parsePayload(JSON.parse(decodeBase64Url(encoded)));
    if (draft.kind === 'custom' && draft.config.auth?.method === 'oauth') {
      const discovery = draft.config.auth.oauth.modelsDiscoveryUrl;
      if (discovery) {
        const runtimeUrls = Object.values(draft.config.runtimes).map((runtime) => runtime!.baseUrl);
        if (runtimeUrls.some((baseUrl) => new URL(baseUrl).origin !== new URL(discovery).origin)) {
          return null;
        }
      }
    }
    pruneExpired();
    if (drafts.size >= MAX_DRAFTS) return null;
    const importId = randomUUID();
    drafts.set(importId, { draft, expiresAt: Date.now() + IMPORT_TTL_MS, confirming: false });
    return importId;
  } catch {
    return null;
  }
}

function normalizedUrl(value: string): string {
  try {
    const url = new URL(value);
    url.hash = '';
    url.search = '';
    return url.toString().replace(/\/$/, '');
  } catch {
    return value.trim().replace(/\/$/, '');
  }
}

function runtimeSignatureFromConfig(config: CustomProviderConfig): string {
  return AGENTS.flatMap((agent) => {
    const runtime = config.runtimes[agent];
    return runtime
      ? [
          [
            agent,
            runtime.wireProtocol ?? '',
            normalizedUrl(runtime.baseUrl),
            runtime.requestPath ?? '',
            normalizedUrl(runtime.modelsUrl ?? ''),
            Object.keys(runtime.headers ?? {})
              .map((name) => name.toLowerCase())
              .sort()
              .join(','),
          ].join('\n'),
        ]
      : [];
  })
    .sort()
    .join('\n---\n');
}

function runtimeSignatureFromProvider(provider: ProviderView): string {
  return AGENTS.flatMap((agent) => {
    const route = provider.routing[agent];
    return route
      ? [
          [
            agent,
            route.wireProtocol ?? '',
            normalizedUrl(route.upstream),
            route.requestPath ?? '',
            normalizedUrl(route.modelsUrl ?? ''),
            Object.keys(route.headerOverride ?? {})
              .map((name) => name.toLowerCase())
              .sort()
              .join(','),
          ].join('\n'),
        ]
      : [];
  })
    .sort()
    .join('\n---\n');
}

function resolveDraft(
  draft: ProviderImportDraft,
  providers: readonly ProviderView[],
): ProviderImportResolution {
  if (draft.kind === 'builtin') {
    const provider = providers.find((candidate) => candidate.id === draft.provider);
    return {
      action: 'replace-key',
      providerId: draft.provider,
      ...(provider ? { existingProviderName: provider.name } : {}),
    };
  }
  const byDesiredId = providers.find((provider) => provider.id === draft.config.id);
  if (draft.explicitId && byDesiredId) {
    if (byDesiredId.source !== 'user') fail('the requested provider id is reserved');
    if (runtimeSignatureFromProvider(byDesiredId) !== runtimeSignatureFromConfig(draft.config)) {
      fail('the requested provider id does not match the existing provider endpoints');
    }
    return { action: 'update', providerId: byDesiredId.id, existingProviderName: byDesiredId.name };
  }
  const signature = runtimeSignatureFromConfig(draft.config);
  const matches = providers.filter(
    (provider) =>
      provider.source === 'user' && runtimeSignatureFromProvider(provider) === signature,
  );
  if (matches.length > 1) fail('multiple existing providers match this import');
  if (matches[0])
    return { action: 'update', providerId: matches[0].id, existingProviderName: matches[0].name };
  const ids = new Set(providers.map((provider) => provider.id));
  let id = draft.config.id;
  if (ids.has(id)) {
    const base = id.slice(0, 34) || 'provider';
    for (let suffix = 2; suffix < 10_000; suffix += 1) {
      const candidate = `${base}-${suffix}`.slice(0, 40);
      if (!ids.has(candidate)) {
        id = candidate;
        break;
      }
    }
  }
  return { action: 'create', providerId: id };
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
): ProviderImportPreview {
  const record = requireRecord(importId);
  if (record.scope && !sameScope(record.scope, scope)) fail('the active account changed');
  const resolution = resolveDraft(record.draft, providers);
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
        willFetchModels: authMethod !== 'oauth' && runtime.models.length === 0,
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
    authMethod,
    ...resolution,
    runtimes,
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
): { draft: ProviderImportDraft; resolution: ProviderImportResolution } {
  const record = requireRecord(importId);
  if (record.scope && !sameScope(record.scope, scope)) fail('the active account changed');
  if (!record.scope || !record.resolution) fail('preview this import again before confirming');
  if (record.confirming) fail('provider import confirmation is already running');
  const latest = resolveDraft(record.draft, providers);
  if (JSON.stringify(latest) !== JSON.stringify(record.resolution))
    fail('provider list changed; preview the import again');
  record.confirming = true;
  return { draft: record.draft, resolution: latest };
}

export function finishProviderImportConfirm(importId: string, succeeded: boolean): void {
  const record = drafts.get(importId);
  if (!record) return;
  if (succeeded) drafts.delete(importId);
  else record.confirming = false;
}

export function cancelProviderImport(importId: unknown): void {
  if (typeof importId === 'string') drafts.delete(importId);
}

/** Test-only reset for deterministic isolation. */
export function clearProviderImportDraftsForTest(): void {
  drafts.clear();
}
