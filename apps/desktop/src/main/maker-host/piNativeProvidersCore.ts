/**
 * Pi native providers without Electron: the version-matched Pi catalog probe, the subscription
 * and xAI projections, the Cindy gateway block's API and compat, and resolvePiNativeProviders.
 * Moved verbatim from pi-host.ts; the desktop binds the factory once with its own ports
 * (pi-host.ts) and the Node Host with its own (apps/host/src/agent/pi-native-providers.ts).
 * The probe state below is module-level, one per process, as it was in pi-host.ts.
 */
import { execFile, spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { modelWithInterface, PI_REASONING_EFFORTS } from '@cindy/model-providers';
import type { Catalog, CustomProviderConfig, PiModelApi, PiReasoningEffort } from '@cindy/model-providers';
import { PiNativeProviderProxyNotReadyError, type ModelDescriptor } from '@cindy/maker-core';
import type { PiNativeApi, PiNativeModelSpec, PiNativeProviderSpec, PiNativeProvidersResult } from '@cindy/maker-core';

import { buildPiNativeProvidersFromConfigs, officialPiModels, PI_NATIVE_APIS, piSubscriptionHeaders, PI_PROVIDER_HEADER, catalogThinkingLevelMap, catalogCostForPiNative, type PiBundledModelCatalog, type PiBundledModelInfo } from './pi-native-catalog.js';
import { sessionModelInterface } from './session-model-interface.js';
import { mergeByokNativeConfigs } from '../model-access/byokProvider.js';
import { isXaiSubscriptionProviderId } from './subscription-account-kind.js';
import { MANAGED_OLLAMA_PROVIDER_ID } from '../../shared/localModelRuntime.js';
import { MANAGED_LLAMACPP_PROVIDER_ID } from '../../shared/llamaCpp.js';
import { createLogger } from '../logger.js';
import {
  getActiveCatalog,
  getLocalCatalogOverridesSnapshot,
  resolveXdPiGatewayHintApi,
  resolveXdPiGatewayServerApi,
} from './active-catalog.js';
import {
  resolveBundledPiGatewayCatalogIdentity,
  resolveBundledPiGatewayModelProfile,
} from './pi-gateway-model-catalog.js';
import { isExclusiveXaiModelId } from '../../shared/subscriptionModels.js';
import { resolvePiRuntimeModelDescriptor } from './catalog-to-descriptors.js';

const log = createLogger('pi-host');

const PI_API_KEY_ENV = 'CINDY_PI_API_KEY';
const PI_XAI_PROXY_API_KEY_ENV = 'CINDY_PI_XAI_PROXY_API_KEY';
const PI_SESSION_ID_ENV = 'CINDY_PI_SESSION_ID';
const PI_SESSION_TOKEN_ENV = 'CINDY_PI_SESSION_TOKEN';
const PI_PROVIDER_AUTH_PLACEHOLDER_KEY = 'cindy-pi-provider-auth-placeholder';
const PI_OPENAI_PROXY_KEY_ENV = 'CINDY_PI_OPENAI_PROXY_KEY';

export type PiListedModelIds = ReadonlyMap<string, ReadonlySet<string>>;

const piBundledModelsByBinary = new Map<string, Promise<PiBundledModelCatalog | null>>();
const resolvedPiBundledModelsByBinary = new Map<string, PiBundledModelCatalog>();
const listedIdsByCatalog = new WeakMap<PiBundledModelCatalog, PiListedModelIds>();
let latestPiBundledModelCatalog: PiBundledModelCatalog | null = null;

export function listedPiModelIds(
  catalog: PiBundledModelCatalog | undefined,
): PiListedModelIds | undefined {
  return catalog ? listedIdsByCatalog.get(catalog) : undefined;
}


/**
 * PI's native ChatGPT adapter extracts account_id from its API key before it
 * sends a request. This unsigned placeholder contains no credential; the
 * authenticated loopback proxy replaces it with the real host-owned token and
 * account id before forwarding upstream.
 */
function piOpenaiProxyPlaceholderJwt(providerId = 'openai'): string {
  const encode = (value: unknown): string =>
    Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'none', typ: 'JWT' })}.${encode({
    // Pi caches sockets by native session + account id, without comparing headers.
    // Separate logical accounts must therefore have separate placeholder identities.
    'https://api.openai.com/auth': { chatgpt_account_id: providerId === 'openai' ? 'cindy-pi-proxy' : `cindy-pi-proxy:${providerId}` },
  })}.`;
}

function appendEndpointPath(endpoint: string, suffix: string): string {
  const url = new URL(endpoint);
  const normalizedSuffix = `/${suffix.replace(/^\/+/, '').replace(/\/+$/, '')}`;
  const pathname = url.pathname.replace(/\/+$/, '');
  if (!pathname.endsWith(normalizedSuffix)) {
    url.pathname = `${pathname}${normalizedSuffix}`;
  }
  return url.toString().replace(/\/$/, '');
}


export function parsePiListModels(stdout: string): ReadonlyMap<string, ReadonlySet<string>> {
  const byProvider = new Map<string, Set<string>>();
  for (const line of stdout.split(/\r?\n/)) {
    const [providerId, modelId] = line.trim().split(/\s+/);
    if (!providerId || !modelId || providerId === 'provider') continue;
    const models = byProvider.get(providerId) ?? new Set<string>();
    models.add(modelId);
    byProvider.set(providerId, models);
  }
  return byProvider;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function parsePiBundledModel(value: unknown): PiBundledModelInfo | null {
  if (!isRecord(value)) return null;
  if (
    typeof value.id !== 'string' ||
    typeof value.provider !== 'string' ||
    typeof value.api !== 'string' ||
    !PI_NATIVE_APIS.has(value.api as PiNativeApi)
  )
    return null;
  const thinkingLevelMap = isRecord(value.thinkingLevelMap)
    ? Object.fromEntries(
        Object.entries(value.thinkingLevelMap).filter(
          (entry): entry is [string, string | null] =>
            entry[1] === null || typeof entry[1] === 'string',
        ),
      )
    : undefined;
  const input = Array.isArray(value.input)
    ? value.input.filter((item): item is 'text' | 'image' => item === 'text' || item === 'image')
    : [];
  const rawCost = isRecord(value.cost) ? value.cost : null;
  const cost =
    rawCost &&
    ['input', 'output', 'cacheRead', 'cacheWrite'].every((key) => typeof rawCost[key] === 'number')
      ? {
          input: rawCost.input as number,
          output: rawCost.output as number,
          cacheRead: rawCost.cacheRead as number,
          cacheWrite: rawCost.cacheWrite as number,
        }
      : undefined;
  const headers = isRecord(value.headers)
    ? Object.fromEntries(
        Object.entries(value.headers).filter(
          (entry): entry is [string, string] => typeof entry[1] === 'string',
        ),
      )
    : undefined;
  return {
    id: value.id,
    api: value.api as PiNativeApi,
    ...(typeof value.baseUrl === 'string' && value.baseUrl.length > 0
      ? { baseUrl: value.baseUrl }
      : {}),
    name: typeof value.name === 'string' ? value.name : value.id,
    reasoning: value.reasoning === true,
    ...(thinkingLevelMap && Object.keys(thinkingLevelMap).length > 0 ? { thinkingLevelMap } : {}),
    input: Array.isArray(value.input) ? input : ['text', 'image'],
    contextWindow:
      typeof value.contextWindow === 'number' && value.contextWindow > 0
        ? value.contextWindow
        : 128_000,
    maxTokens:
      typeof value.maxTokens === 'number' && value.maxTokens > 0 ? value.maxTokens : 16_000,
    ...(cost ? { cost } : {}),
    ...(headers && Object.keys(headers).length > 0 ? { headers } : {}),
    ...(isRecord(value.compat) ? { compat: structuredClone(value.compat) } : {}),
    ...(isRecord(value.samplingParams)
      ? { samplingParams: structuredClone(value.samplingParams) }
      : {}),
  };
}

async function readPiAvailableModels(
  binaryPath: string,
  configDir: string,
  childEnv: NodeJS.ProcessEnv,
  initialProvider: string,
  initialModel: string,
): Promise<PiBundledModelCatalog> {
  const child = spawn(
    binaryPath,
    [
      '--mode',
      'rpc',
      '--provider',
      initialProvider,
      '--model',
      initialModel,
      '--no-session',
      '--no-extensions',
      '--no-skills',
      '--no-prompt-templates',
      '--no-themes',
    ],
    {
      cwd: configDir,
      env: childEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    },
  );
  return new Promise<PiBundledModelCatalog>((resolve, reject) => {
    let settled = false;
    let buffered = '';
    const timer = setTimeout(() => finish(new Error('PI catalog RPC timed out')), 5_000);
    const finish = (error: Error | null, catalog?: PiBundledModelCatalog): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdin.end();
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      if (error) reject(error);
      else resolve(catalog ?? new Map());
    };
    child.once('error', (error) => finish(error));
    child.once('exit', (code, signal) => {
      if (!settled)
        finish(new Error(`PI catalog RPC exited before response (${code ?? signal ?? 'unknown'})`));
    });
    child.stdout.on('data', (chunk: Buffer) => {
      buffered += chunk.toString('utf8');
      if (buffered.length > 8 * 1024 * 1024) {
        finish(new Error('PI catalog RPC output exceeded limit'));
        return;
      }
      let newline = buffered.indexOf('\n');
      while (newline >= 0) {
        const line = buffered.slice(0, newline).trim();
        buffered = buffered.slice(newline + 1);
        newline = buffered.indexOf('\n');
        if (!line) continue;
        let message: unknown;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (
          !isRecord(message) ||
          message.type !== 'response' ||
          message.command !== 'get_available_models' ||
          message.success !== true ||
          !isRecord(message.data) ||
          !Array.isArray(message.data.models)
        )
          continue;
        const catalog = new Map<string, Map<string, PiBundledModelInfo>>();
        for (const rawModel of message.data.models) {
          if (!isRecord(rawModel) || typeof rawModel.provider !== 'string') continue;
          const model = parsePiBundledModel(rawModel);
          if (!model) continue;
          const providerModels = catalog.get(rawModel.provider) ?? new Map();
          providerModels.set(model.id, model);
          catalog.set(rawModel.provider, providerModels);
        }
        finish(null, catalog);
        return;
      }
    });
    child.stdin.write(`${JSON.stringify({ type: 'get_available_models' })}\n`, (error) => {
      if (error) finish(error);
    });
  });
}

async function readPiCatalogProbeEnv(binaryPath: string): Promise<Record<string, string>> {
  try {
    const providersDoc = await fsp.readFile(
      path.join(path.dirname(binaryPath), 'docs', 'providers.md'),
      'utf8',
    );
    const env: Record<string, string> = {};
    for (const line of providersDoc.split(/\r?\n/)) {
      const cells = line.split('|');
      if (cells.length < 4) continue;
      for (const match of cells[2]!.matchAll(/`([A-Z][A-Z0-9_]+)`/g)) {
        env[match[1]!] = 'cindy-pi-catalog-probe';
      }
    }
    return env;
  } catch {
    // Single-file PI distributions may omit docs. The explicit provider
    // overrides below still give subscriptions a safe baseline; models absent
    // from that reduced probe require a daily piApi annotation.
    return {};
  }
}

export async function readPiBundledModels(
  binaryPath: string,
  options: { cachedOnly?: boolean } = {},
): Promise<PiBundledModelCatalog | null> {
  const cached = piBundledModelsByBinary.get(binaryPath);
  if (cached) {
    const catalog = await cached;
    if (catalog) resolvedPiBundledModelsByBinary.set(binaryPath, catalog);
    latestPiBundledModelCatalog = catalog;
    if (catalog === null) {
      piBundledModelsByBinary.delete(binaryPath);
      resolvedPiBundledModelsByBinary.delete(binaryPath);
    }
    return catalog;
  }
  // A model-switch preview may inspect a live task without launching another Pi
  // process. Its startup already attempted this exact binary's offline probe.
  if (options.cachedOnly) return null;
  const pending = (async () => {
    let configDir: string | undefined;
    try {
      configDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cindy-pi-catalog-'));
      // Placeholder keys only make bundled providers visible to the offline
      // catalog commands; no credential or network request is involved.
      await fsp.writeFile(
        path.join(configDir, 'models.json'),
        JSON.stringify({
          providers: {
            anthropic: {
              baseUrl: 'http://127.0.0.1:1',
              apiKey: 'cindy-pi-catalog-probe',
            },
            'openai-codex': {
              baseUrl: 'http://127.0.0.1:1',
              apiKey: piOpenaiProxyPlaceholderJwt(),
            },
            xai: {
              baseUrl: 'http://127.0.0.1:1/v1',
              apiKey: 'cindy-pi-catalog-probe',
            },
          },
        }),
      );
      const childEnv: NodeJS.ProcessEnv = {
        ...(await readPiCatalogProbeEnv(binaryPath)),
        PI_CODING_AGENT_DIR: configDir,
        PI_OFFLINE: '1',
      };
      for (const name of ['PATH', 'TMPDIR', 'TEMP', 'TMP', 'SystemRoot', 'WINDIR', 'PATHEXT']) {
        if (process.env[name]) childEnv[name] = process.env[name];
      }
      const stdout = await new Promise<string>((resolve, reject) => {
        execFile(
          binaryPath,
          ['--list-models'],
          {
            encoding: 'utf8',
            env: childEnv,
            maxBuffer: 1024 * 1024,
            timeout: 5_000,
            windowsHide: true,
          },
          (error, output) => (error ? reject(error) : resolve(output)),
        );
      });
      const listed = parsePiListModels(stdout);
      const preferredProviders = ['openai-codex', 'xai', 'anthropic'];
      const initialProvider = preferredProviders.find((providerId) => listed.get(providerId)?.size);
      const initialModel = initialProvider ? [...listed.get(initialProvider)!][0] : undefined;
      if (!initialProvider || !initialModel) return null;
      const catalog = await readPiAvailableModels(
        binaryPath,
        configDir,
        childEnv,
        initialProvider,
        initialModel,
      );
      if (catalog.size === 0) return null;
      listedIdsByCatalog.set(catalog, listed);
      return catalog;
    } catch (err) {
      log.warn(
        'readPiBundledModels: PI catalog probe failed; using daily PI annotations without bundled baseline',
        {
          message: err instanceof Error ? err.message : String(err),
        },
      );
      return null;
    } finally {
      if (configDir) {
        await fsp.rm(configDir, { recursive: true, force: true }).catch(() => undefined);
      }
    }
  })();
  piBundledModelsByBinary.set(binaryPath, pending);
  const catalog = await pending;
  if (catalog) resolvedPiBundledModelsByBinary.set(binaryPath, catalog);
  latestPiBundledModelCatalog = catalog;
  // A temp-dir/timeout/parse failure is transient evidence, not a permanent property of this
  // binary. Keep successful probes cached, but let the next session retry a null result.
  if (catalog === null) {
    piBundledModelsByBinary.delete(binaryPath);
    resolvedPiBundledModelsByBinary.delete(binaryPath);
  }
  return catalog;
}


/**
 * Overlay Cindy's host-managed subscription endpoints onto PI's bundled
 * provider catalog. Resolved catalog metadata is authoritative for all subscription
 * models; the version-matched PI binary remains authoritative for native API and
 * compat details that Cindy must preserve when materializing the overlay.
 */
export function buildPiSubscriptionNativeProviders(
  catalog: Catalog,
  endpoint: string,
  bundledModelsByProvider?: PiBundledModelCatalog,
  listedModelIdsByProvider?: PiListedModelIds,
  retainedOpenAiModel?: ModelDescriptor | null,
  retainedProviderId = 'openai',
): PiNativeProvidersResult {
  const providers: PiNativeProviderSpec[] = [];
  const officialXaiById = new Map(
    (officialPiModels('xai') ?? []).map((model) => [model.id, model]),
  );
  const officialOpenAiById = new Map(
    (officialPiModels('openai-codex') ?? []).map((model) => [model.id, model]),
  );
  const env: Record<string, string> = {
    [PI_OPENAI_PROXY_KEY_ENV]: piOpenaiProxyPlaceholderJwt(),
    [PI_XAI_PROXY_API_KEY_ENV]: PI_PROVIDER_AUTH_PLACEHOLDER_KEY,
  };
  const add = (
    sourceProviderId: 'openai' | 'xai',
    piProviderId: string,
    name: string,
    baseUrl: string,
    stripPrefix?: string,
  ): void => {
    const source = catalog.providers.find((provider) => provider.id === sourceProviderId);
    const models = [...(source?.models.pi ?? [])];
    if (
      sourceProviderId === 'openai' &&
      retainedProviderId === 'openai' &&
      retainedOpenAiModel?.id.startsWith('chatgpt/') &&
      !models.some((model) => model.id === retainedOpenAiModel.id)
    ) {
      // A retired context profile is intentionally absent from the public Pi catalog, but a
      // persisted session still needs the exact alias in the ChatGPT native provider. Keeping the
      // alias here preserves both its canonical identity and its subscription endpoint; it remains
      // private to this one resume and never re-enters availableModels.
      models.push({
        id: retainedOpenAiModel.id,
        name: retainedOpenAiModel.displayName,
        contextWindow: retainedOpenAiModel.contextWindow,
        ...(retainedOpenAiModel.maxOutputTokens !== undefined
          ? { maxOutput: retainedOpenAiModel.maxOutputTokens }
          : {}),
        efforts: [...retainedOpenAiModel.efforts],
        defaultEffort: retainedOpenAiModel.defaultEffort,
        ...(retainedOpenAiModel.supportsFastMode !== undefined
          ? { supportsFastMode: retainedOpenAiModel.supportsFastMode }
          : {}),
        status: 'retired',
        defaultEnabled: false,
      });
    }
    if (models.length === 0) return;
    const modelIdAliases = Object.fromEntries(
      models.flatMap((model) => {
        const wireId =
          stripPrefix && model.id.startsWith(stripPrefix)
            ? model.id.slice(stripPrefix.length)
            : model.id;
        const namespaced = sourceProviderId === 'xai' && !model.id.startsWith('xai/')
          ? `xai/${wireId}`
          : undefined;
        // alias 必须落到 spec.models[].id,不能落到 wireId。否则 ChatGPT 的
        // chatgpt/gpt-* 会被收成 gpt-*,和 namespaced candidate.id 对不上。
        return [
          [model.id, model.id],
          ...(wireId !== model.id ? [[wireId, model.id] as const] : []),
          ...(namespaced && namespaced !== model.id
            ? [[namespaced, model.id] as const]
            : []),
        ];
      }),
    );
    providers.push({
      id: piProviderId,
      sourceProviderId,
      name,
      baseUrl,
      inheritModels: true,
      ...(sourceProviderId === 'openai' ? { apiKeyEnvVar: PI_OPENAI_PROXY_KEY_ENV } : {}),
      ...(sourceProviderId === 'xai' ? { apiKeyEnvVar: PI_XAI_PROXY_API_KEY_ENV } : {}),
      modelIdAliases,
      headers: piSubscriptionHeaders(sourceProviderId),
      models: models.map((model) => {
        const wireId =
          stripPrefix && model.id.startsWith(stripPrefix)
            ? model.id.slice(stripPrefix.length)
            : model.id;
        const bundledModels = bundledModelsByProvider?.get(piProviderId);
        const bundledModel = bundledModels?.get(wireId);
        const contextProfileTemplate =
          sourceProviderId === 'openai' && wireId.endsWith('[1m]')
            ? bundledModels?.get(wireId.slice(0, -'[1m]'.length))
            : undefined;
        // A runtime probe supplies serializer details, not permission or membership.
        // Every server-declared model with a known transport gets a materialized
        // entry, including models absent from this version's native catalog.
        const officialModel = sourceProviderId === 'openai'
          ? officialOpenAiById.get(wireId)
          : sourceProviderId === 'xai' ? officialXaiById.get(wireId) : undefined;
        const api = sourceProviderId === 'openai'
          ? 'openai-codex-responses' as const
          : model.piApi ?? bundledModel?.api ?? officialModel?.api;
        const template = [bundledModel, contextProfileTemplate, officialModel]
          .find((candidate) => candidate?.api === api);
        const correction = sourceProviderId === 'xai'
          ? xaiOfficialCapabilityCorrection(bundledModel, officialModel)
          : null;
        const officialThinking = sourceProviderId === 'xai' && officialModel?.api === api
          ? officialXaiThinkingSpec(officialModel) : null;
        const compatibleCorrection = correction?.api === api ? correction : null;
        const thinking = compatibleCorrection?.thinkingLevelMap
          ?? officialThinking?.thinkingLevelMap ?? template?.thinkingLevelMap;
        const compat = compatibleCorrection?.compat ?? officialThinking?.compat ?? template?.compat;
        const cost = catalogCostForPiNative(model.cost) ?? template?.cost;
        const listedIds = listedModelIdsByProvider?.get(piProviderId)
          ?? listedPiModelIds(bundledModelsByProvider)?.get(piProviderId);
        const catalogAddition = !bundledModel && (
          sourceProviderId === 'openai'
          || (sourceProviderId === 'xai' && listedIds != null && !listedIds.has(wireId)
            && wireId === 'grok-4.6')
        );
        return {
          id: model.id,
          wireId,
          ...(api ? { api } : {}),
          ...(catalogAddition && api ? { catalogAddition: true } : {}),
          name: model.name,
          contextWindow: model.contextWindow,
          ...(model.maxOutput !== undefined || template?.maxTokens !== undefined
            ? { maxTokens: model.maxOutput ?? template?.maxTokens } : {}),
          reasoning: model.efforts.length > 0,
          input: model.supportsImageInput === undefined
            ? [...(template?.input ?? ['text', 'image'])]
            : model.supportsImageInput ? ['text', 'image'] : ['text'],
          thinkingLevelMap: catalogThinkingLevelMap(model.efforts, thinking),
          ...(cost ? { cost: { ...cost } } : {}),
          // Never reuse compatibility fields across different serializers.
          ...(template?.headers ? { headers: { ...template.headers } } : {}),
          ...(compat ? { compat: structuredClone(compat) } : {}),
          ...(template?.samplingParams
            ? { samplingParams: structuredClone(template.samplingParams) } : {}),
        };

      }),
    });
  };
  // Claude 订阅不给 Pi:它只供内置 Claude Code CLI 用自己的登录使用(Pi 原生 /login 不受影响)。
  add('openai', 'openai-codex', 'OpenAI (ChatGPT)', endpoint, 'chatgpt/');
  add('xai', 'xai', 'xAI (SuperGrok)', appendEndpointPath(endpoint, 'v1'), 'xai/');
  // Independent Claude accounts are retired and never projected into Pi.
  for (const account of catalog.providers.filter((provider) => provider.auth.native && provider.auth.native !== 'claude')) {
    // Reuse the native subscription projection with this account's catalog. Unique provider IDs
    // have no bundled registry entry, so materialize native model metadata instead of inheriting it.
    const brand = account.auth.native === 'xai' ? 'xai' : 'openai';
    const api = brand === 'xai' ? 'openai-responses' as const : 'openai-codex-responses' as const;
    const accountCatalog = {
      ...catalog,
      providers: [{ ...account, id: brand, auth: { method: 'oauth' as const } }],
    };
    const projected = buildPiSubscriptionNativeProviders(
      accountCatalog, endpoint, bundledModelsByProvider, listedModelIdsByProvider,
      retainedProviderId === account.id ? retainedOpenAiModel : null,
    ).providers.find((provider) => provider.sourceProviderId === brand);
    if (!projected) continue;
    const openaiKeyEnv = brand === 'openai'
      ? `CINDY_PI_KEY_OPENAI_PROXY_${Buffer.from(account.id).toString('hex').toUpperCase()}` : undefined;
    if (openaiKeyEnv) env[openaiKeyEnv] = piOpenaiProxyPlaceholderJwt(account.id);
    providers.push({
      ...projected,
      ...(openaiKeyEnv ? { apiKeyEnvVar: openaiKeyEnv } : {}),
      id: `${brand === 'openai' ? 'openai-codex' : brand}-${account.id}`,
      sourceProviderId: account.id,
      name: account.name,
      inheritModels: false,
      api,
      headers: piSubscriptionHeaders(account.id),
      models: projected.models.map((model) => ({
        ...model,
        api: model.api ?? api,
        input: model.input ?? ['text', 'image'],
      })),
    });
  }
  return { providers, env };
}
/** Dedicated exact remote port for the Desktop-owned xAI compat proxy. */
export const PI_XAI_COMPAT_FORWARD_PORT = 47989;

/**
 * 订阅 OAuth provider:网关 `cindy` 块经 compat proxy 用安全存储里的 OAuth 服务这些模型,
 * models.json 的 $CINDY_PI_API_KEY 只需占位(真凭证由 proxy 按 session-id 注入)。
 * xAI/BYOM provider **不在此列** —— 它们走各自原生块 + 独立 key,而网关块仍需真网关 key
 * 以便会话中途切回网关模型可用,故原生 provider 会话不能写占位符毒化网关块。
 */
const PI_OAUTH_SUBSCRIPTION_PROVIDERS = new Set(['openai']);
const PI_BUNDLED_RESERVED_PROVIDER_IDS = ['anthropic', 'openai-codex', 'xai'] as const;

/**
 * Inspect the protocol already known by the exact bundled PI build. This helper
 * is intentionally global and therefore only suitable for diagnostics/tests;
 * BYOM routing must additionally prove that the candidate belongs to the same
 * upstream origin before inheriting any protocol or metadata.
 */
export function resolvePiBundledApiByModelId(
  catalog: PiBundledModelCatalog | undefined,
  modelId: string,
): PiNativeApi | undefined {
  let resolved: PiNativeApi | undefined;
  for (const models of catalog?.values() ?? []) {
    const model = models.get(modelId);
    if (!model) continue;
    if (resolved !== undefined && resolved !== model.api) return undefined;
    resolved = model.api;
  }
  return resolved;
}






/** Keep Cindy's historical xai/ ids while Pi's official native provider uses bare model ids. */
export function piNativeModelId(providerId: string, model: string): string {
  return providerId === 'xai' && model.startsWith('xai/') ? model.slice('xai/'.length) : model;
}

function reasoningCompatEnabled(compat: Record<string, unknown> | undefined): boolean {
  return compat?.supportsReasoningEffort !== false;
}

function thinkingMapsDiffer(
  left: PiNativeModelSpec['thinkingLevelMap'] | undefined,
  right: PiNativeModelSpec['thinkingLevelMap'] | undefined,
): boolean {
  return PI_REASONING_EFFORTS.some((level) => (left?.[level] ?? null) !== (right?.[level] ?? null));
}

/**
 * Publish a full inheritModels replacement when Pi's bundled row is behind the
 * official xAI ladder. Overlay rows without `api` are dropped (writeModelsJson
 * only serializes api / catalogAddition); keeping bundled.api preserves protocol
 * while replacing thinkingLevelMap and supportsReasoningEffort.
 *
 * Source: https://docs.x.ai/developers/model-capabilities/text/reasoning (2026-08-16)
 * Grok 4.6 = low | medium | high (default) | xhigh.
 */
function officialXaiThinkingSpec(
  official: PiNativeModelSpec | undefined,
): Pick<PiNativeModelSpec, 'reasoning' | 'thinkingLevelMap' | 'compat'> | null {
  if (!official?.thinkingLevelMap) return null;
  return {
    reasoning: official.reasoning !== false,
    thinkingLevelMap: Object.fromEntries(
      PI_REASONING_EFFORTS.map((level) => [level, official.thinkingLevelMap?.[level] ?? null]),
    ),
    compat: {
      ...(official.compat ?? {}),
      supportsReasoningEffort: reasoningCompatEnabled(official.compat),
    },
  };
}

function xaiOfficialCapabilityCorrection(
  bundled: PiBundledModelInfo | undefined,
  official: PiNativeModelSpec | undefined,
): Pick<PiNativeModelSpec, 'api' | 'reasoning' | 'thinkingLevelMap' | 'compat'> | null {
  if (!bundled || !official?.thinkingLevelMap) return null;
  const mapDiffers = thinkingMapsDiffer(bundled.thinkingLevelMap, official.thinkingLevelMap);
  const compatDiffers =
    reasoningCompatEnabled(bundled.compat) !== reasoningCompatEnabled(official.compat);
  if (!mapDiffers && !compatDiffers) return null;
  return {
    api: bundled.api,
    reasoning: official.reasoning !== false,
    thinkingLevelMap: Object.fromEntries(
      PI_REASONING_EFFORTS.map((level) => [level, official.thinkingLevelMap?.[level] ?? null]),
    ),
    compat: {
      ...(bundled.compat ?? {}),
      ...(official.compat ?? {}),
      supportsReasoningEffort: reasoningCompatEnabled(official.compat),
    },
  };
}

/**
 * 裁剪网关链路 Anthropic Messages 的 Pi compat 能力位(#4982)。
 * Pi 目录探测把 Anthropic 直连的新格式能力位(tool `strict`、消息内 `tool_removal` 块、
 * 逐轮 effort)原样带进网关链路的 models.json,而 xd 网关的 Anthropic-Messages schema
 * 尚不接受 `tools[].strict` 与 `tool_removal`,Opus 5 / 5.5 每条消息 400。
 * `supportsMidConvoSystemMessages` 网关接受,保留。
 * Cindy 不再给 Pi 投影 Claude 订阅链路(订阅只归内置 Claude Code CLI);Pi 原生 /login 的
 * Anthropic 由 Pi 自己的目录决定,不经这里。
 * 恢复条件:网关 schema 补齐 `strict` / `tool_removal` 后去掉本裁剪。只改客户端生成的
 * models.json,不改代理与上游。
 */
const GATEWAY_UNSUPPORTED_ANTHROPIC_COMPAT: readonly string[] = [
  'supportsStrictTools',
  'supportsMidConvoToolChanges',
  'supportsMidConvoEffort',
];

export function pruneAnthropicCompatForGateway(
  compat: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!compat) return compat;
  const unsupported = GATEWAY_UNSUPPORTED_ANTHROPIC_COMPAT;
  if (!unsupported.some((key) => key in compat)) return compat;
  const next = { ...compat };
  for (const key of unsupported) delete next[key];
  return next;
}




function configuredPiModel(model: {
  id: string;
  name?: string;
  contextWindow?: number;
  supportsImageInput?: boolean;
  reasoning?: boolean;
  reasoningEfforts?: PiReasoningEffort[];
}): PiNativeModelSpec {
  const supportedEfforts = new Set(model.reasoningEfforts ?? []);
  return {
    id: model.id,
    name: model.name,
    contextWindow: model.contextWindow,
    ...(model.supportsImageInput === true
      ? { input: ['text', 'image'] as Array<'text' | 'image'> }
      : {}),
    ...(model.reasoning === true
      ? {
          reasoning: true,
          thinkingLevelMap: Object.fromEntries(
            PI_REASONING_EFFORTS.map((effort) => [
              effort,
              supportedEfforts.has(effort) ? effort : null,
            ]),
          ),
        }
      : {}),
  };
}


/**
 * Combine host subscriptions with user providers without changing persisted
 * custom-provider IDs. PI's bundled provider IDs (notably `openai-codex`) are
 * runtime implementation details and may legally match an existing BYOM ID.
 * In that case only the generated models.json key is namespaced; routing and
 * auth continue to use sourceProviderId, so no DB or safeStorage migration is
 * required.
 */
export function mergePiNativeProviderResults(
  subscriptions: PiNativeProvidersResult,
  custom: PiNativeProvidersResult,
  onNamespace?: (sourceProviderId: string, runtimeProviderId: string) => void,
): PiNativeProvidersResult {
  const occupiedIds = new Set([
    ...subscriptions.providers.map((provider) => provider.id),
    ...custom.providers.map((provider) => provider.id),
  ]);
  const runtimeIds = new Set<string>([
    ...PI_BUNDLED_RESERVED_PROVIDER_IDS,
    ...subscriptions.providers.map((provider) => provider.id),
  ]);
  const customProviders = custom.providers.map((provider) => {
    if (!runtimeIds.has(provider.id)) {
      runtimeIds.add(provider.id);
      return provider;
    }

    const sourceProviderId = provider.sourceProviderId ?? provider.id;
    const baseRuntimeId = `cindy-byom-${sourceProviderId}`;
    let runtimeProviderId = baseRuntimeId;
    for (let suffix = 2; occupiedIds.has(runtimeProviderId); suffix += 1) {
      runtimeProviderId = `${baseRuntimeId}-${suffix}`;
    }
    occupiedIds.add(runtimeProviderId);
    runtimeIds.add(runtimeProviderId);
    onNamespace?.(sourceProviderId, runtimeProviderId);
    return {
      ...provider,
      id: runtimeProviderId,
      sourceProviderId,
    };
  });

  return {
    providers: [...subscriptions.providers, ...customProviders],
    env: { ...subscriptions.env, ...custom.env },
  };
}


function isPiGatewayModelApi(api: PiBundledModelInfo['api']): api is PiModelApi {
  return (
    api === 'anthropic-messages' ||
    api === 'openai-responses' ||
    api === 'openai-completions' ||
    api === 'google-generative-ai'
  );
}

function resolveProbedPiGatewayModel(
  modelId: string,
  runtimeBinaryPath?: string,
): PiBundledModelInfo | undefined {
  const catalog = runtimeBinaryPath
    ? resolvedPiBundledModelsByBinary.get(runtimeBinaryPath)
    : latestPiBundledModelCatalog;
  const normalized = modelId.replace(/\[1m\]$/, '');
  const identity = resolveBundledPiGatewayCatalogIdentity(normalized);
  if (identity) {
    const matched = catalog?.get(identity.provider)?.get(identity.modelId);
    if (matched) return matched;
  }
  // Future namespaced models may use Pi's exact provider/model identity without a client alias.
  // This is an exact pair lookup, never a bare-id or family guess.
  const slash = normalized.indexOf('/');
  if (slash <= 0) return undefined;
  return catalog
    ?.get(normalized.slice(0, slash))
    ?.get(normalized.slice(slash + 1));
}

export function resolvePiCindyGatewayModelApi(
  _selectedProviderId: string | null | undefined,
  modelId: string,
  context?: { remote: boolean; runtimeBinaryPath?: string },
): PiModelApi | null | undefined {
  // Gateway membership remains the account-availability gate, but its protocol is the last hint.
  const gatewayApi = resolveXdPiGatewayHintApi(modelId);
  if (gatewayApi === undefined) return undefined;
  const serverApi = resolveXdPiGatewayServerApi(modelId);
  if (serverApi !== undefined) return serverApi;
  // The Desktop binary is not evidence about a different Pi executable on an SSH host. Remote
  // sessions skip that probe but still use this client version's explicit static configuration
  // before the last-priority Gateway hint.
  if (context?.remote) return resolveBundledPiGatewayModelProfile(modelId)?.api ?? gatewayApi;
  const probed = resolveProbedPiGatewayModel(modelId, context?.runtimeBinaryPath);
  if (probed) return isPiGatewayModelApi(probed.api) ? probed.api : null;
  return resolveBundledPiGatewayModelProfile(modelId)?.api ?? gatewayApi;
}

// #7296: these exact CindyAI Chat routes accept an empty reasoning_content fallback.
// Keep this Gateway policy independent of whether a Pi catalog version lists the model.
const PI_GATEWAY_DEEPSEEK_REASONING_REPLAY_MODELS = new Set([
  'deepseek/deepseek-v4.1-flash',
  'deepseek/deepseek-flash',
  'deepseek/deepseek-v4-pro',
  'deepseek/deepseek-v4-flash-vision-exp',
  'deepseek/deepseek-v4-flash',
]);

export function resolvePiCindyGatewayModelSpec(
  _selectedProviderId: string | null | undefined,
  modelId: string,
  context?: { remote: boolean; runtimeBinaryPath?: string },
): Pick<
  PiNativeModelSpec,
  'api' | 'compat' | 'samplingParams' | 'thinkingLevelMap'
> | null | undefined {
  const api = resolvePiCindyGatewayModelApi(_selectedProviderId, modelId, context);
  if (api === undefined || api === null) return api;
  const bundled = resolveBundledPiGatewayModelProfile(modelId);
  const probed = context?.remote
    ? undefined
    : resolveProbedPiGatewayModel(modelId, context?.runtimeBinaryPath);
  const compatibleBundled = bundled?.api === api ? bundled : undefined;
  const compatibleProbed = probed?.api === api ? probed : undefined;
  let compat = compatibleProbed?.compat ?? compatibleBundled?.compat;
  if (
    api === 'openai-completions' &&
    PI_GATEWAY_DEEPSEEK_REASONING_REPLAY_MODELS.has(modelId) &&
    compat?.requiresReasoningContentOnAssistantMessages === undefined
  ) {
    compat = { ...compat, requiresReasoningContentOnAssistantMessages: true };
  }
  if (api === 'anthropic-messages') compat = pruneAnthropicCompatForGateway(compat);
  // Gateway routing needs Pi's native session identity on every Chat/Messages request.
  // This is a Gateway transport policy, not a change to direct BYOM/subscription providers.
  if (api === 'openai-completions' || api === 'anthropic-messages') {
    compat = { ...compat, sendSessionAffinityHeaders: true };
  }
  // Remote execution never receives metadata from the Desktop binary probe. The version-matched
  // static client profile remains the second authority and is injected only when its API matches.
  if (context?.remote) {
    return {
      api,
      ...(compat ? { compat: structuredClone(compat) } : {}),
      ...(bundled?.api === api && bundled.samplingParams
        ? { samplingParams: structuredClone(bundled.samplingParams) }
        : {}),
      ...(bundled?.api === api && bundled.thinkingLevelMap
        ? { thinkingLevelMap: { ...bundled.thinkingLevelMap } }
        : {}),
    };
  }
  // Provider quirks are API-specific. Local metadata may fill omissions only when it agrees with
  // the final API; never apply stale compat across a protocol change. The exact current binary
  // probe takes precedence over the checked-in snapshot when both match that API.
  return {
    api,
    ...(compat ? { compat: structuredClone(compat) } : {}),
    ...(compatibleProbed?.samplingParams ?? compatibleBundled?.samplingParams
      ? {
          samplingParams: structuredClone(
            compatibleProbed?.samplingParams ?? compatibleBundled?.samplingParams,
          ),
        }
      : {}),
    ...(compatibleProbed?.thinkingLevelMap ?? compatibleBundled?.thinkingLevelMap
      ? {
          thinkingLevelMap: {
            ...(compatibleProbed?.thinkingLevelMap ?? compatibleBundled?.thinkingLevelMap),
          },
        }
      : {}),
  };
}

/** baseUrl 是否指向本机 loopback(与本机 proxy 同判定,远端会话不可达)。
 *  轮 24 CRITICAL-1:startsWith('127.') 会误杀 127.example.com 等合法域名
 *  —— 改为精确 IPv4 loopback 正则(/^127\.\d+\.\d+\.\d+$/)。URL.hostname 已
 *  去括号, ::1 无需再匹配 '[::1]'(保留兼容)。 */
function isLoopbackUrl(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    return (
      host === 'localhost' ||
      /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host) ||
      host === '::1' ||
      host === '[::1]'
    );
  } catch {
    return false;
  }
}

/** What resolvePiNativeProviders and the xAI projection read from their host. */
export interface PiNativeProviderPorts {
  /** Loopback endpoint of the compat proxy (desktop: anthropic-compat-proxy-host.ts). */
  getClaudeEndpoint(): string;
  isAnthropicCompatProxyHandleReady(): boolean;
  resolvePiBinaryPath(): string | null;
  isOpenAiSubscriptionProviderId(providerId?: string | null): boolean;
  hasGrokOAuthLogin(providerId?: string): boolean;
  listCustomProvidersWithSecureHeaders(): Promise<CustomProviderConfig[]>;
  readCustomProviderKey: Parameters<typeof buildPiNativeProvidersFromConfigs>[1];
  /** Refresh the global Skill projection before a local Pi startup (desktop: the Claude auth adapter). */
  ensureSharedGlobalSkills(): Promise<void>;
  /** Start the managed local model runtime a session selected (desktop: local-model-runtime/preflight.ts). */
  ensureManagedOllamaReadyForSession(input: { providerId: string; remoteHostId: string | null; userDataDir: string }): Promise<unknown>;
  getUserDataDir(): string;
}

export function createPiNativeProviderResolver(ports: PiNativeProviderPorts) {
const {
  getClaudeEndpoint, isAnthropicCompatProxyHandleReady, resolvePiBinaryPath, isOpenAiSubscriptionProviderId,
  hasGrokOAuthLogin, listCustomProvidersWithSecureHeaders, readCustomProviderKey, ensureSharedGlobalSkills,
  ensureManagedOllamaReadyForSession, getUserDataDir,
} = ports;


async function buildXaiPiNativeProvider(
  model?: string,
  allowHistoricalResume = false,
  remote = false,
  providerId = 'xai',
): Promise<PiNativeProvidersResult> {
  const catalogModels =
    getActiveCatalog().providers.find((provider) => provider.id === providerId)?.models.pi ?? [];
  // Reuse the subscription projection so SSH and local xAI receive identical
  // capacity, reasoning and input metadata, including newly discovered models.
  const projected = buildPiSubscriptionNativeProviders(getActiveCatalog(), getClaudeEndpoint())
    .providers.find(provider => provider.sourceProviderId === providerId);
  const models: PiNativeModelSpec[] = (projected?.models ?? []).map(model => ({
    ...model,
    id: `xai/${model.wireId ?? model.id}`,
    wireId: model.wireId ?? model.id,
  }));
  const aliases = Object.fromEntries(
    catalogModels.flatMap((candidate) => [
      [candidate.id, `xai/${candidate.id}`],
      [`xai/${candidate.id}`, `xai/${candidate.id}`],
    ]),
  );
  if (model) {
    const namespacedModel = model.startsWith('xai/') ? model : `xai/${model}`;
    if (!models.some((candidate) => candidate.id === namespacedModel)) {
      if (!allowHistoricalResume) {
        throw new Error(`Pi official xAI catalog does not contain model '${model}'`);
      }
      // Resume compatibility only: preserve the historical id and route it through the same
      // proxy without asserting unverified vision/reasoning capabilities or publishing it.
      models.push({
        id: namespacedModel,
        wireId: piNativeModelId('xai', namespacedModel),
        name: namespacedModel,
        api: 'openai-responses',
      });
      aliases[model] = namespacedModel;
      aliases[piNativeModelId('xai', model)] = namespacedModel;
    }
  }
  return {
    providers: [
      {
        id: providerId === 'xai' ? 'xai' : `xai-${providerId}`,
        ...(providerId === 'xai' ? {} : { sourceProviderId: providerId }),
        name: 'xAI',
        baseUrl: remote
          ? (() => {
              const endpoint = new URL(getClaudeEndpoint());
              endpoint.hostname = '127.0.0.1';
              endpoint.port = String(PI_XAI_COMPAT_FORWARD_PORT);
              return appendEndpointPath(endpoint.toString(), 'v1');
            })()
          : appendEndpointPath(getClaudeEndpoint(), 'v1'),
        api: 'openai-responses',
        apiKeyEnvVar: PI_XAI_PROXY_API_KEY_ENV,
        headers: {
          'x-cindy-pi-session-id': `$${PI_SESSION_ID_ENV}`,
          'x-cindy-pi-session-token': `$${PI_SESSION_TOKEN_ENV}`,
          [PI_PROVIDER_HEADER]: providerId,
        },
        models,
        modelIdAliases: aliases,
        ...(remote
          ? {
              hostProxyForward: {
                localUrl: getClaudeEndpoint(),
                remotePort: PI_XAI_COMPAT_FORWARD_PORT,
              },
            }
          : {}),
      },
    ],
    env: { [PI_XAI_PROXY_API_KEY_ENV]: PI_PROVIDER_AUTH_PLACEHOLDER_KEY },
  };
}

/** BYOM:读 DB 自定义 provider + safeStorage key → pi 原生 provider spec。IO 外壳,逻辑在上面。 */
async function resolvePiNativeProviders(ctx: {
  sessionId?: string;
  workingDir: string;
  remoteHostId?: string | null;
  providerId?: string | null;
  model: string;
  /** Local Pi binary frozen by maker-core for this session. */
  runtimeBinaryPath?: string;
  resumeSessionId?: string;
  purpose?: 'startup' | 'preview' | 'live-refresh';
}): Promise<PiNativeProvidersResult> {
  if (!ctx.remoteHostId && (ctx.purpose === undefined || ctx.purpose === 'startup')) {
    // Pi scans the local ~/.agents/skills root when it starts. This hook is awaited by every
    // Desktop Pi startSession caller, so refresh Codex-only projections added after app startup
    // before the process snapshots its global skills. Remote Pi has a different HOME/root.
    await ensureSharedGlobalSkills();
  }
  const compatProxyReady = isAnthropicCompatProxyHandleReady();
  const selectedOfficialXai =
    isXaiSubscriptionProviderId(ctx.providerId) || (ctx.providerId == null && isExclusiveXaiModelId(ctx.model));
  if (selectedOfficialXai && !compatProxyReady) {
    log.error('resolvePiNativeProviders: SuperGrok requires the local compat proxy', {
      providerId: ctx.providerId ?? null,
      model: ctx.model,
      remoteHostId: ctx.remoteHostId ?? null,
    });
    throw new PiNativeProviderProxyNotReadyError();
  }
  const piBinaryPath = ctx.runtimeBinaryPath ?? resolvePiBinaryPath();
  // Never treat the Desktop executable as the catalog of a different remote Pi binary.
  const bundledModels = !ctx.remoteHostId && piBinaryPath
    ? await readPiBundledModels(piBinaryPath, { cachedOnly: ctx.purpose === 'preview' })
    : null;
  let subscriptions: PiNativeProvidersResult = { providers: [], env: {} };
  if (!ctx?.remoteHostId && compatProxyReady) {
    const retainedOpenAiModel =
      ctx.resumeSessionId && ctx.providerId && isOpenAiSubscriptionProviderId(ctx.providerId)
        ? resolvePiRuntimeModelDescriptor(getActiveCatalog(), ctx.providerId, ctx.model, {
            localOverrides: getLocalCatalogOverridesSnapshot(),
          })
        : null;
    subscriptions = buildPiSubscriptionNativeProviders(
      getActiveCatalog(),
      getClaudeEndpoint(),
      bundledModels ?? undefined,
      undefined,
      retainedOpenAiModel,
      ctx.providerId ?? 'openai',
    );
  }
  let configs: CustomProviderConfig[] = [];
  try {
    configs = await listCustomProvidersWithSecureHeaders();
  } catch (err) {
    log.warn(
      'resolvePiNativeProviders: listCustomProviders failed, continuing with subscriptions only',
      {
        message: err instanceof Error ? err.message : String(err),
      },
    );
  }
  const isRemote = Boolean(ctx.remoteHostId);
  if (
    !isRemote &&
    ctx.purpose !== 'preview' &&
    (ctx.providerId === MANAGED_OLLAMA_PROVIDER_ID || ctx.providerId === MANAGED_LLAMACPP_PROVIDER_ID)
  ) {
    await ensureManagedOllamaReadyForSession({
      providerId: ctx.providerId,
      remoteHostId: ctx.remoteHostId ?? null,
      userDataDir: getUserDataDir(),
    });
  }
  // 远端会话:本地 loopback 端点(本机 Ollama/vLLM)远端够不到。
  // 轮 42 P2(codex-connector):**不再 pre-filter 掉** —— 让 PiAgent 的
  // [REMOTE_LOCAL_ONLY_PROVIDER] guard 显式拒绝, 用户才能拿到带行动指引的
  // 可行动错误码(换网关/远端可达 BYOM)。pre-filter 会让显式选择落到通用
  // 「BYOM provider cannot serve model」路径, renderer 收不到指引文案。
  if (isRemote) {
    for (const c of configs) {
      const baseUrl = c.runtimes.pi?.baseUrl;
      if (baseUrl && isLoopbackUrl(baseUrl)) {
        log.debug(
          'resolvePiNativeProviders: remote session has loopback BYOM provider (core guard will reject)',
          {
            id: c.id,
            baseUrl,
          },
        );
      }
    }
  }
  const sessionCatalog = getActiveCatalog();
  const pinnedCatalog = ctx.sessionId && ctx.purpose !== 'preview' ? { ...sessionCatalog,
    providers: sessionCatalog.providers.map(provider => provider.id !== ctx.providerId ? provider : {
      ...provider, models: { ...provider.models, pi: provider.models.pi?.map(model => {
        if (model.id !== ctx.model) return model;
        const selected = sessionModelInterface(ctx.sessionId!, provider.id, 'pi', model, sessionCatalog.modelRegistry,
          ctx.resumeSessionId ? provider.routing.pi?.wireProtocol : undefined);
        return modelWithInterface(model, selected);
      }) },
    }),
  } : sessionCatalog;
  const custom = buildPiNativeProvidersFromConfigs(
    mergeByokNativeConfigs(configs, getActiveCatalog().providers),
    readCustomProviderKey,
    (id, reason) => log.warn('resolvePiNativeProviders: skipped custom provider', { id, reason }),
    bundledModels ?? undefined,
    pinnedCatalog,
    !isRemote && compatProxyReady ? getClaudeEndpoint() : undefined,
  );
  // Remote PI cannot use the local native overlay. Preserve upstream's exact
  // SuperGrok provenance/forwarding path there; locally the version-matched PI
  // native provider above remains the protocol authority.
  // inheritModels xai 现在带占位 apiKey,Pi getAvailable() 才能看见 grok-4.6。
  // 不要再塞一份 overlay xai:reserved id 会被改名成 cindy-byom-xai；
  // 请求打到 PI native handler 会走错误的 provider 身份并返回 404。
  const xaiProviderId = isXaiSubscriptionProviderId(ctx.providerId) ? ctx.providerId! : 'xai';
  if (
    compatProxyReady &&
    !subscriptions.providers.some((provider) => (provider.sourceProviderId ?? provider.id) === xaiProviderId) &&
    (selectedOfficialXai || hasGrokOAuthLogin(xaiProviderId))
  ) {
    const selectedXaiModel =
      selectedOfficialXai
        ? ctx.model
        : undefined;
    const xai = await buildXaiPiNativeProvider(selectedXaiModel, !!ctx.resumeSessionId, isRemote, xaiProviderId);
    custom.providers.push(...xai.providers);
    Object.assign(custom.env, xai.env);
  }
  return mergePiNativeProviderResults(
    subscriptions,
    {
      providers: custom.providers,
      env: {
        ...custom.env,
        // 会话启动时即使还没登录 SuperGrok,也预埋占位 env。登录后热写 models.json
        // 才能引用 $CINDY_PI_XAI_PROXY_API_KEY,不必为注入 env 整进程重启。
        [PI_XAI_PROXY_API_KEY_ENV]:
          custom.env[PI_XAI_PROXY_API_KEY_ENV] ?? PI_PROVIDER_AUTH_PLACEHOLDER_KEY,
      },
    },
    (sourceProviderId, runtimeProviderId) => {
      log.info('resolvePiNativeProviders: namespaced custom provider runtime id', {
        sourceProviderId,
        runtimeProviderId,
      });
    },
  );
}

return { buildXaiPiNativeProvider, resolvePiNativeProviders };
}
