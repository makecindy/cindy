// Original Pi catalog discovery and provider projection, shared by both hosts.
import { execFile, spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Logger, ModelDescriptor, PiNativeApi, PiNativeModelSpec, PiNativeProviderSpec, PiNativeProvidersResult } from '@cindy/maker-core';
import { PI_REASONING_EFFORTS, resolvePiModelRoute, runtimeCustomProviderId, storedCustomProviderId, providerCatalogForPi, providerModelRecord, providerModelGenerationRecord, providerPresetModelRecord, providerModelAdapterId } from '@cindy/model-providers';
import type { Catalog, ModelCost, PiModelApi, PiReasoningEffort, ProviderWireProtocol } from '@cindy/model-providers';
import { matchesManagedOllamaFingerprint } from '@cindy/model-providers/localModelRuntime';
import { applyQwen38NativeOverlay, shouldApplyQwen38Overlay } from './qwenProfile.js';
import { hostCredentialEndpointAllowed } from './piHostCredentialEndpoint.js';
import { resolveBundledPiGatewayCatalogIdentity } from '@cindy/model-providers/model-plane/pi-gateway-model-catalog';
const PI_XAI_PROXY_API_KEY_ENV = 'CINDY_PI_XAI_PROXY_API_KEY';
const PI_PROVIDER_AUTH_PLACEHOLDER_KEY = 'cindy-pi-provider-auth-placeholder';
const PI_OPENAI_PROXY_KEY_ENV = 'CINDY_PI_OPENAI_PROXY_KEY';
const PI_PROVIDER_HEADER = 'x-cindy-pi-provider-id';
const PI_BUNDLED_RESERVED_PROVIDER_IDS = ['anthropic', 'openai-codex', 'xai'] as const;

export interface PiBundledModelInfo {
  id: string;
  api: PiNativeApi;
  baseUrl?: string;
  name: string;
  reasoning: boolean;
  thinkingLevelMap?: PiNativeModelSpec['thinkingLevelMap'];
  input: Array<'text' | 'image'>;
  contextWindow: number;
  maxTokens: number;
  cost?: PiNativeModelSpec['cost'];
  headers?: Record<string, string>;
  compat?: Record<string, unknown>;
  samplingParams?: Record<string, unknown>;
}

export type PiBundledModelCatalog = ReadonlyMap<string, ReadonlyMap<string, PiBundledModelInfo>>;
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
const PI_NATIVE_APIS = new Set<PiNativeApi>([
  'anthropic-messages',
  'openai-responses',
  'openai-completions',
  'google-generative-ai',
  'openai-codex-responses',
  'bedrock-converse-stream', 'azure-openai-responses', 'google-vertex', 'mistral-conversations',
]);

/**
 * PI's native ChatGPT adapter extracts account_id from its API key before it
 * sends a request. This unsigned placeholder contains no credential; the
 * authenticated loopback proxy replaces it with the real host-owned token and
 * account id before forwarding upstream.
 */
export function piOpenaiProxyPlaceholderJwt(): string {
  const encode = (value: unknown): string =>
    Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'none', typ: 'JWT' })}.${encode({
    'https://api.openai.com/auth': { chatgpt_account_id: 'cindy-pi-proxy' },
  })}.`;
}

export function appendEndpointPath(endpoint: string, suffix: string): string {
  const url = new URL(endpoint);
  const normalizedSuffix = `/${suffix.replace(/^\/+/, '').replace(/\/+$/, '')}`;
  const pathname = url.pathname.replace(/\/+$/, '');
  if (!pathname.endsWith(normalizedSuffix)) {
    url.pathname = `${pathname}${normalizedSuffix}`;
  }
  return url.toString().replace(/\/$/, '');
}

export function piSubscriptionHeaders(providerId: string): Record<string, string> {
  return {
    'x-cindy-pi-session-id': '$CINDY_PI_SESSION_ID',
    'x-cindy-pi-session-token': '$CINDY_PI_SESSION_TOKEN',
    [PI_PROVIDER_HEADER]: providerId,
  };
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

export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function parsePiBundledModel(value: unknown): PiBundledModelInfo | null {
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

export async function readPiAvailableModels(
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

export async function readPiCatalogProbeEnv(binaryPath: string): Promise<Record<string, string>> {
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
  options: { cachedOnly?: boolean; logger?: Pick<Logger, 'warn'> } = {},
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
      (options.logger ?? console).warn(
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

export function catalogCostForPiNative(cost: ModelCost | undefined): PiNativeModelSpec['cost'] {
  if (
    !cost ||
    (typeof cost.input !== 'number' &&
      typeof cost.output !== 'number' &&
      typeof cost.cacheRead !== 'number' &&
      typeof cost.cacheWrite !== 'number')
  ) {
    return undefined;
  }
  return {
    input: cost.input ?? 0,
    output: cost.output ?? 0,
    cacheRead: cost.cacheRead ?? 0,
    cacheWrite: cost.cacheWrite ?? 0,
    ...(cost.tiers ? { tiers: cost.tiers.map(tier => ({
      inputTokensAbove: tier.inputTokensAbove,
      input: tier.input ?? cost.input ?? 0,
      output: tier.output ?? cost.output ?? 0,
      cacheRead: tier.cacheRead ?? cost.cacheRead ?? 0,
      cacheWrite: tier.cacheWrite ?? cost.cacheWrite ?? 0,
    })) } : {}),
  };
}

/**
 * CatalogModel 只保存 Cindy 可选择的 effort 档位，Pi 原生目录还可能把档位映射到
 * 另一条 wire 值（例如 minimal -> low）。叠加服务端能力时保留同源 bundled 映射；
 * 服务端新增的档位没有原生映射才按同名值发送。
 */
export function catalogThinkingLevelMap(
  efforts: readonly string[],
  bundled: PiNativeModelSpec['thinkingLevelMap'] | undefined,
): NonNullable<PiNativeModelSpec['thinkingLevelMap']> {
  return Object.fromEntries(
    PI_REASONING_EFFORTS.map((effort) => [
      effort,
      efforts.includes(effort) ? (bundled?.[effort] ?? effort) : null,
    ]),
  );
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
    providers.push({
      ...projected,
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
/** Cindy wire protocol → pi models.json api 形态。 */
export function wireProtocolToPiApi(wp: ProviderWireProtocol): PiNativeApi {
  switch (wp) {
    case 'google-generative-ai':
      return 'google-generative-ai';
    case 'anthropic-messages':
      return 'anthropic-messages';
    case 'openai-responses':
      return 'openai-responses';
    case 'openai-chat':
      return 'openai-completions';
    default:
      throw new Error(`Unsupported PI wire protocol: ${String(wp)}`);
  }
}

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

export function urlOrigin(value: string | undefined): string | null {
  if (!value) return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

/**
 * Pick the bundled PI entry belonging to the same upstream origin. This keeps
 * both protocol and endpoint together: copying a Claude-compatible preset URL
 * while borrowing PI's OpenAI protocol would be just another broken hybrid.
 */
export function resolvePiBundledModelById(
  catalog: PiBundledModelCatalog | undefined,
  modelId: string,
  sourceBaseUrl?: string,
): PiBundledModelInfo | undefined {
  const candidates: PiBundledModelInfo[] = [];
  for (const models of catalog?.values() ?? []) {
    const model = models.get(modelId);
    if (model) candidates.push(model);
  }
  if (candidates.length === 0) return undefined;
  const sourceOrigin = urlOrigin(sourceBaseUrl);
  if (!sourceOrigin) return undefined;
  const sameOrigin = candidates.filter((model) => urlOrigin(model.baseUrl) === sourceOrigin);
  const exactBaseUrl = sameOrigin.filter((model) => model.baseUrl === sourceBaseUrl);
  if (exactBaseUrl.length === 1) return exactBaseUrl[0];
  return sameOrigin.length === 1 ? sameOrigin[0] : undefined;
}

/** env 变量名(该 provider 的 api key):CINDY_PI_KEY_<ID>,ID 规整成 [A-Z0-9_]。 */
export function piNativeKeyEnvVar(providerId: string): string {
  return `CINDY_PI_KEY_${providerId.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`;
}

interface PiCatalogModel extends PiNativeModelSpec {
  provider: string;
  baseUrl: string;
}

const piModelCatalog = providerCatalogForPi() as unknown as {
  generatedAt: string;
  providers: Record<string, PiCatalogModel[]>;
};

/** Keep Cindy's historical xai/ ids while Pi's official native provider uses bare model ids. */
export function piNativeModelId(providerId: string, model: string): string {
  return providerId === 'xai' && model.startsWith('xai/') ? model.slice('xai/'.length) : model;
}

export function reasoningCompatEnabled(compat: Record<string, unknown> | undefined): boolean {
  return compat?.supportsReasoningEffort !== false;
}

export function thinkingMapsDiffer(
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
export function officialXaiThinkingSpec(
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

export function xaiOfficialCapabilityCorrection(
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

export function officialPiModels(providerId: string): PiNativeModelSpec[] | null {
  const models = piModelCatalog.providers[providerId];
  if (!models) return null;
  return models.map((model) => ({
    id: model.id,
    name: model.name,
    ...(model.headers && Object.keys(model.headers).length > 0 ? { headers: model.headers } : {}),
    api: model.api,
    reasoning: model.reasoning,
    thinkingLevelMap: model.thinkingLevelMap,
    input: model.input,
    cost: model.cost,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    compat: model.compat,
    samplingParams: model.samplingParams,
  }));
}

export function officialPiRouteMatches(
  providerId: string,
  baseUrl: string,
  wireProtocol: ProviderWireProtocol | undefined,
): boolean {
  const models = piModelCatalog.providers[providerId];
  if (!models?.length) return false;
  const baseUrls = new Set(models.map((model) => model.baseUrl.replace(/\/+$/, '')));
  const apis = new Set(models.map((model) => model.api));
  return (
    baseUrls.size === 1 &&
    baseUrls.has(baseUrl.trim().replace(/\/+$/, '')) &&
    apis.size === 1 &&
    (wireProtocol === undefined || apis.has(wireProtocolToPiApi(wireProtocol)))
  );
}

export function configuredPiModel(model: {
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
 * 纯映射:自定义 provider 配置(含 pi runtime)→ pi 原生 provider spec + env。
 * key 读取经 `readKey` 注入(便于单测)。规则:
 *  - 无 pi runtime → 跳过;
 *  - oauth → authenticated loopback forwarding; host injects refreshed credentials per request;
 *  - apiKey 形态但 key / 自定义 headers 都没有 → 跳过(避免半可用);
 *  - none(keyless,本机 Ollama 等)→ apiKeyEnvVar 留空,models.json 写 dummy key;
 *  - 自定义 header 值全部搬进子进程 env,models.json 只保留 `$ENV` 引用。
 * 直连用户端点,不过 anthropic-compat 代理(设计原则:pi 主导,禁双重转义)。
 */
export function buildPiNativeProvidersFromConfigs(
  configs: Array<{
    id: string;
    name: string;
    auth?: { method?: string; oauth?: unknown };
    runtimes: {
      pi?: {
        baseUrl: string;
        wireProtocol?: ProviderWireProtocol;
        requestPath?: string;
        headers?: Record<string, string>;
        piCatalogProviderId?: string;
        catalogPresetId?: string;
        models: Array<{
          id: string;
          name?: string;
          contextWindow?: number;
          supportsImageInput?: boolean;
          reasoning?: boolean;
          reasoningEfforts?: PiReasoningEffort[];
          api?: PiModelApi;
          piApi?: PiModelApi;
          route?: {
            baseUrl: string;
            wireProtocol: ProviderWireProtocol;
            requestPath?: string;
          };
        }>;
      };
    };
  }>,
  readKey: (providerId: string, agent: string) => string | null,
  onSkip?: (id: string, reason: string) => void,
  bundledModelsByProvider?: PiBundledModelCatalog,
  resolvedCatalog?: Catalog,
  oauthProxyEndpoint?: string,
): PiNativeProvidersResult {
  const providers: PiNativeProviderSpec[] = [];
  const env: Record<string, string> = {};
  // 派生 env 名去重:CINDY_PI_KEY_<ID> 会把 `-`/`_` 归一,不同合法 id(my-vllm / my_vllm)
  // 可能塌缩到同名 → 后写覆盖 → 一个 provider 的 key 被发往另一个端点(凭证串号)。撞名时
  // 追加 _2/_3 保证每个 provider 拿到独立 env 名。
  const usedEnvVars = new Set<string>();
  const uniqueEnvVar = (id: string): string => {
    const base = piNativeKeyEnvVar(id);
    if (!usedEnvVars.has(base)) {
      usedEnvVars.add(base);
      return base;
    }
    for (let n = 2; ; n++) {
      const candidate = `${base}_${n}`;
      if (!usedEnvVars.has(candidate)) {
        usedEnvVars.add(candidate);
        return candidate;
      }
    }
  };
  for (const cfg of configs) {
    const rt = cfg.runtimes.pi;
    if (!rt) continue;
    const authMethod = cfg.auth?.method ?? 'apiKey';
    if (authMethod === 'oauth' && (!cfg.auth?.oauth || !oauthProxyEndpoint)) {
      onSkip?.(cfg.id, 'oauth proxy not ready for pi native');
      continue;
    }
    const managedOllama = matchesManagedOllamaFingerprint({
      id: cfg.id,
      authMethod,
      runtimes: cfg.runtimes,
    });
    const runtimeApi =
      rt.wireProtocol === undefined ? undefined : wireProtocolToPiApi(rt.wireProtocol);
    // Protocol authority, in order: per-model override, explicit endpoint default,
    // strictly same-origin PI bundled knowledge, then an explicitly matched official
    // PI catalog. Missing protocol is not Chat: one unresolved model makes the whole
    // provider unusable so PI cannot silently send it to a guessed endpoint shape.
    const bundledModels = rt.models.map((model) => {
      // 显式 runtime 协议决定端点形状，但不应阻止同源 Pi 目录补齐图片、输出上限等能力。
      // 只有 per-model piApi 明确改写协议时才不借用；协议冲突也必须隔离。
      if (model.piApi) return undefined;
      const bundled = resolvePiBundledModelById(bundledModelsByProvider, model.id, rt.baseUrl);
      if (!bundled || !runtimeApi || bundled.api === runtimeApi) return bundled;
      return undefined;
    });
    const official =
      rt.piCatalogProviderId &&
      officialPiRouteMatches(rt.piCatalogProviderId, rt.baseUrl, rt.wireProtocol)
        ? officialPiModels(rt.piCatalogProviderId)
        : null;
    const officialById = new Map((official ?? []).map((model) => [model.id, model]));
    // The pinned binary predates Astra. Exact public API endpoint/protocol matches
    // may use our catalog addition even when the user entered the endpoint by hand.
    // Never lend subscription capabilities to an API key or another endpoint.
    const openaiAddition = !rt.piCatalogProviderId &&
      runtimeApi === 'openai-responses' &&
      officialPiRouteMatches('openai', rt.baseUrl, rt.wireProtocol)
        ? officialPiModels('openai')?.find((model) => model.id === 'gpt-6-astra')
        : undefined;
    const standardModels = rt.models.map(model => {
      if (model.route?.requestPath || rt.requestPath) return undefined;
      const row = providerModelRecord(model.id, model.route?.baseUrl ?? rt.baseUrl,
        model.api ?? model.piApi ?? (model.route ? model.route.wireProtocol : rt.wireProtocol),
        !model.api && !model.piApi && !model.route)
        ?? ((model.api ?? model.piApi) ? providerPresetModelRecord(rt.catalogPresetId, model.id, model.api ?? model.piApi) : undefined)
        ?? providerModelGenerationRecord(model.id, model.route?.baseUrl ?? rt.baseUrl,
          model.api ?? model.piApi ?? (model.route ? model.route.wireProtocol : rt.wireProtocol), rt.catalogPresetId);
      if (!row || !PI_NATIVE_APIS.has(row.execution.pi.api as PiNativeApi)) return undefined;
      return {
        id: row.id, name: row.name, baseUrl: row.upstream,
        ...row.execution.pi, api: row.execution.pi.api as PiModelApi,
        contextWindow: row.contextWindow, maxTokens: row.maxOutput,
        input: (row.modalities?.input ?? ['text']).filter((value): value is 'text' | 'image' => value === 'text' || value === 'image'),
        reasoning: row.reasoning,
        cost: row.cost?.input !== undefined && row.cost.output !== undefined
          ? { input: row.cost.input, output: row.cost.output,
              cacheRead: row.cost.cacheRead ?? 0, cacheWrite: row.cost.cacheWrite ?? 0 }
          : undefined,
      };
    });
    const metadataModels = rt.models.map(
      (model, index) => standardModels[index] ?? bundledModels[index] ?? officialById.get(model.id) ??
        (model.id === openaiAddition?.id && !model.route &&
          (!model.piApi || model.piApi === openaiAddition.api) ? openaiAddition : undefined),
    );
    const modelApis = rt.models.map(
      (model, index) =>
        model.api ?? model.piApi ??
        (model.route ? wireProtocolToPiApi(model.route.wireProtocol) : undefined) ??
        resolvedCatalog?.providers.find(provider => provider.id === cfg.id)?.models.pi?.find(item => item.id === model.id)?.api ??
        standardModels[index]?.api ??
        runtimeApi ??
        metadataModels[index]?.api,
    );
    const unresolvedModelIndex = modelApis.findIndex((api) => api === undefined);
    if (unresolvedModelIndex >= 0) {
      onSkip?.(
        cfg.id,
        `pi protocol not configured for model '${rt.models[unresolvedModelIndex]!.id}'`,
      );
      continue;
    }
    const providerApi = runtimeApi ?? modelApis[0];
    if (!providerApi) {
      onSkip?.(cfg.id, 'pi protocol not configured for provider default');
      continue;
    }
    const headers =
      rt.headers && Object.keys(rt.headers).length > 0
        ? Object.fromEntries(
            Object.entries(rt.headers).map(([name, value]) => {
              const envVar = uniqueEnvVar(`${cfg.id}_HEADER_${name}`);
              env[envVar] = value;
              return [name, `$${envVar}`];
            }),
          )
        : undefined;
    let apiKeyEnvVar: string | undefined;
    if (authMethod === 'apiKey') {
      const key = readKey(cfg.id, 'pi');
      if (!key && !headers) {
        onSkip?.(cfg.id, 'apiKey provider missing pi key and custom headers');
        continue;
      }
      if (key) {
        apiKeyEnvVar = uniqueEnvVar(cfg.id);
        env[apiKeyEnvVar] = key;
      }
    }
    if (rt.models.some((model, index) => {
      const api = modelApis[index]!;
      if (api !== 'google-vertex' && api !== 'bedrock-converse-stream') return false;
      if (api === 'google-vertex' && apiKeyEnvVar) return false;
      return !hostCredentialEndpointAllowed(api, model.route?.baseUrl ?? rt.baseUrl);
    })) {
      onSkip?.(cfg.id, 'native SDK requires an approved cloud endpoint');
      continue;
    }
    const adapterIds = new Set(rt.models.flatMap((model, index) => {
      const api = modelApis[index];
      // The native ChatGPT subscription transport owns its authentication separately.
      if (!api || api === 'openai-codex-responses') return [];
      const row = providerModelRecord(model.id, model.route?.baseUrl ?? rt.baseUrl, api)
        ?? providerPresetModelRecord(rt.catalogPresetId, model.id, api)
        ?? providerModelGenerationRecord(model.id, model.route?.baseUrl ?? rt.baseUrl, api, rt.catalogPresetId);
      const adapter = row ? providerModelAdapterId(row, rt.catalogPresetId) : undefined;
      return adapter ? [adapter] : [];
    }));
    providers.push({
      ...(adapterIds.size === 1 ? { adapterProvider: [...adapterIds][0] } : {}),
      id: runtimeCustomProviderId(cfg.id),
      name: cfg.name,
      // The proxy already retains the supplier base path (e.g. /api/v1).
      // OpenAI SDKs append /chat/completions or /responses themselves.
      baseUrl: authMethod === 'oauth' ? oauthProxyEndpoint! : rt.baseUrl,
      ...(authMethod === 'oauth' ? { cacheIdentityBaseUrl: rt.baseUrl } : {}),
      api: providerApi,
      apiKeyEnvVar,
      ...(headers && Object.keys(headers).length > 0 ? { headers } : {}),
      ...(authMethod === 'oauth' ? { headers: piSubscriptionHeaders(cfg.id) } : {}),
      models: rt.models.map((configuredModel, index) => {
        // Public/default/discovery/user precedence was resolved by the active catalog.
        // Carry those facts to the serializer instead of reintroducing SDK precedence.
        // Endpoint, protocol and credentials remain exclusively connection-owned.
        const resolved = resolvedCatalog?.providers.find(p => p.id === cfg.id)
          ?.models.pi?.find(model => model.id === configuredModel.id);
        const m = resolved ? {
          ...configuredModel,
          name: resolved.name,
          contextWindow: resolved.contextWindow,
          supportsImageInput: resolved.supportsImageInput ?? configuredModel.supportsImageInput,
          reasoning: resolved.efforts.length > 0,
          reasoningEfforts: resolved.efforts.filter((effort): effort is PiReasoningEffort =>
            (PI_REASONING_EFFORTS as readonly string[]).includes(effort)),
        } : configuredModel;
        const supportedEfforts = new Set(m.reasoningEfforts ?? []);
        const modelApi = modelApis[index]!;
        const bundledModel = metadataModels[index];
        const explicitRoute = resolvePiModelRoute(m, {
          baseUrl: rt.baseUrl,
          wireProtocol: rt.wireProtocol,
        });
        const explicitRouteApi = explicitRoute
          ? wireProtocolToPiApi(explicitRoute.wireProtocol)
          : undefined;
        // bundled/official rows may lend protocol-compatible capabilities, but never routing.
        // A same-origin URL is not the same endpoint: replacing /proxy/v1 with /v1 can bypass
        // the user's proxy. Only the model's own explicit route may create a model-level baseUrl.
        const modelBaseUrl =
          m.api && m.route ? m.route.baseUrl :
          m.route && explicitRouteApi === modelApi ? explicitRoute?.baseUrl : undefined;
        const spec = {
          id: m.id,
          ...(authMethod === 'oauth' ? { cacheIdentityBaseUrl: modelBaseUrl ?? rt.baseUrl } : {}),
          ...(resolved?.supportsFastMode !== undefined ? { supportsFastMode: resolved.supportsFastMode } : {}),
          ...(m.api || m.piApi || modelApi !== providerApi ? { api: modelApi } : {}),
          ...(authMethod === 'oauth'
            ? { baseUrl: oauthProxyEndpoint! }
            : modelBaseUrl && modelBaseUrl !== rt.baseUrl ? { baseUrl: modelBaseUrl } : {}),
          name: m.name ?? bundledModel?.name,
          // 下发文件明确写出的上下文优先；本地 Pi 目录只补缺失值。
          contextWindow: m.contextWindow ?? bundledModel?.contextWindow,
          ...(resolved?.maxOutput !== undefined || bundledModel?.maxTokens !== undefined
            ? { maxTokens: resolved?.maxOutput ?? bundledModel?.maxTokens } : {}),
          ...(m.supportsImageInput !== undefined
            ? { input: (m.supportsImageInput ? ['text', 'image'] : ['text']) as Array<'text' | 'image'> }
            : bundledModel?.input ? { input: [...bundledModel.input] } : {}),
          ...(m.reasoning !== undefined || m.reasoningEfforts !== undefined
            ? {
                reasoning: m.reasoning ?? (m.reasoningEfforts?.length ?? 0) > 0,
                ...(m.reasoningEfforts !== undefined
                  ? { thinkingLevelMap: { ...catalogThinkingLevelMap(m.reasoningEfforts, bundledModel?.thinkingLevelMap), ...(resolved?.reasoningRequired ? { off: null } : {}) } }
                  : {}),
              }
            : bundledModel
            ? {
                reasoning: bundledModel.reasoning,
                ...(bundledModel.reasoning && bundledModel.thinkingLevelMap
                  ? { thinkingLevelMap: { ...bundledModel.thinkingLevelMap } }
                  : {}),
              }
            : m.reasoning === true
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
          ...(resolved?.cost ? { cost: catalogCostForPiNative(resolved.cost) }
            : bundledModel?.cost ? { cost: { ...bundledModel.cost } } : {}),
          ...(bundledModel?.headers ? { headers: { ...bundledModel.headers } } : {}),
          ...(bundledModel?.compat
            ? { compat: structuredClone(bundledModel.compat) }
            : !bundledModel && modelApi === 'openai-completions'
              ? // 未知自定义 Chat Completions 端点保守回落(#3832):火山引擎等
                // OpenAI 兼容网关只接受 system/assistant/user/tool,而 Pi 的
                // detectCompat 对陌生端点默认 supportsDeveloperRole=true,会把
                // system 指令按 role=developer 发出 → 整个模型不可用。system
                // role 在所有 OpenAI 兼容端点均可用,故无同源 bundled 元数据时
                // 默认收敛为 system;有 bundled 元数据的端点维持 Pi 原生判定。
                { compat: { supportsDeveloperRole: false } }
              : {}),
          ...(bundledModel?.samplingParams
            ? { samplingParams: structuredClone(bundledModel.samplingParams) }
            : {}),
        };
        return managedOllama && shouldApplyQwen38Overlay(m.id)
          ? applyQwen38NativeOverlay(spec)
          : spec;
      }),
    });
  }
  return { providers, env };
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

export function isPiGatewayModelApi(api: PiBundledModelInfo['api']): api is PiModelApi {
  return (
    api === 'anthropic-messages' ||
    api === 'openai-responses' ||
    api === 'openai-completions' ||
    api === 'google-generative-ai'
  );
}

export function resolveProbedPiGatewayModel(
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

