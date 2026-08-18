/**
 * pi agent 的 desktop host 装配 —— auth / runtimeConfig / 二进制解析 / 构造,
 * 集中在本模块,maker-host/index.ts 只做一次 buildPiAgent() 调用。
 *
 * P0 范围(实验性,dev-first):
 *  - 凭证:按会话来源复用 Cindy AI / Claude.ai / ChatGPT / SuperGrok 既有连接态。
 *    pi 子进程只拿网关 key或无权限占位 key；订阅 OAuth 由本地 compat proxy
 *    从安全存储注入，models.json 不落任何真实订阅凭证。
 *  - endpoint:统一走 authenticated loopback proxy。PI 按供应商使用原生协议：
 *    Claude=Messages、ChatGPT=Codex Responses、SuperGrok=PI bundled API；host
 *    只注入凭证并原样转发。Cindy Gateway 继续按 Model Access v3 下发协议。
 *  - 二进制:与 cc/codex 同链 —— splash prepare 经 agent-binaries 按 CDN manifest
 *    的 pi 字段下载整目录 tar.gz 到 userData/pi/<version>/(SHA256 校验,清单一变
 *    下次启动即换新)。dev 期使用 apps/pi-bin 中 pnpm install:pi 的产物；正式版
 *    不内置 Pi，清单缺失或下载失败时 buildPiAgent 返回 null，本次不注册 pi，
 *    对 Cindy 启动零影响。
 */

import { execFile, spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { app } from 'electron';

import {
  PiAgent,
  type AgentDeps,
  type AuthAdapter,
  type AuthState,
  type ModelDescriptor,
} from '@cindy/maker-core';
import type {
  AgentRuntimeConfig,
  AuthAdapterOptions,
  PiMcpServerRef,
  PiNativeApi,
  PiNativeModelSpec,
  PiNativeProviderSpec,
  PiNativeProvidersResult,
} from '@cindy/maker-core';
import {
  PI_REASONING_EFFORTS,
  resolvePiModelRoute,
  runtimeCustomProviderId,
  storedCustomProviderId,
} from '@cindy/model-providers';
import piModelCatalogJson from '@cindy/model-providers/pi-model-catalog' with { type: 'json' };
import type {
  Catalog,
  CustomProviderConfig,
  PiModelApi,
  PiReasoningEffort,
  ProviderWireProtocol,
} from '@cindy/model-providers';

import { getReadyBinaryPath } from '../agent-binaries/index.js';
import { getPiExtraSpawnConfig } from '../mcp-integrations/piEnvironment.js';
import { listCustomProvidersWithSecureHeaders } from './custom-provider-header-secrets.js';
import { readCustomProviderKey } from '../secrets/providerSecretStore.js';
import {
  desktopClaudeAuthAdapter,
  desktopCodexAuthAdapter,
  readClaudeApiKey,
} from './auth-adapters.js';
import {
  getClaudeEndpoint,
  isAnthropicCompatProxyHandleReady,
} from './anthropic-compat-proxy-host.js';
import { hasClaudeAiOAuth } from './claude-credentials-store.js';
import { hasGrokOAuthLogin } from './grok-oauth-login.js';
import hostSystemPrompt from './host-system-prompt.md?raw';
import piSystemPrompt from './pi-system-prompt.md?raw';
import { createLogger } from '../logger.js';
import { readMemorySettings } from './memory-settings-store.js';
import { registerPiProxySession } from './pi-proxy-session-auth.js';
import { derivePiProxySessionToken } from './pi-proxy-session-token.js';
import {
  getDesktopMcpToolApprovalPolicy,
  getDesktopMcpToolApprovalPresentation,
} from './mcp-tool-approval-policy.js';
import { getRipgrepBinaryPath, claudeUpstreamEndpoint } from './runtime-configs.js';
import {
  getActiveCatalog,
  getLocalCatalogOverridesSnapshot,
  resolveXdPiGatewayWireProtocol,
} from './active-catalog.js';
import { resolvePiRuntimeModelDescriptor } from './catalog-to-descriptors.js';

const log = createLogger('pi-host');

const PI_API_KEY_ENV = 'CINDY_PI_API_KEY';
const PI_XAI_PROXY_API_KEY_ENV = 'CINDY_PI_XAI_PROXY_API_KEY';
const PI_SESSION_ID_ENV = 'CINDY_PI_SESSION_ID';
const PI_SESSION_TOKEN_ENV = 'CINDY_PI_SESSION_TOKEN';
const PI_PROVIDER_AUTH_PLACEHOLDER_KEY = 'cindy-pi-provider-auth-placeholder';
const PI_OPENAI_PROXY_KEY_ENV = 'CINDY_PI_OPENAI_PROXY_KEY';
const PI_PROVIDER_HEADER = 'x-cindy-pi-provider-id';

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
const listedIdsByCatalog = new WeakMap<PiBundledModelCatalog, PiListedModelIds>();

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
]);

/**
 * PI's native ChatGPT adapter extracts account_id from its API key before it
 * sends a request. This unsigned placeholder contains no credential; the
 * authenticated loopback proxy replaces it with the real host-owned token and
 * account id before forwarding upstream.
 */
function piOpenaiProxyPlaceholderJwt(): string {
  const encode = (value: unknown): string =>
    Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'none', typ: 'JWT' })}.${encode({
    'https://api.openai.com/auth': { chatgpt_account_id: 'cindy-pi-proxy' },
  })}.`;
}

function appendEndpointPath(endpoint: string, suffix: string): string {
  return `${endpoint.replace(/\/+$/, '')}/${suffix.replace(/^\/+/, '')}`;
}

function piSubscriptionHeaders(providerId: string): Record<string, string> {
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
    input: input.length > 0 ? input : ['text'],
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
): Promise<PiBundledModelCatalog | null> {
  const cached = piBundledModelsByBinary.get(binaryPath);
  if (cached) return cached;
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
  return pending;
}

function catalogCostForPiNative(cost: {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
} | undefined): { input: number; output: number; cacheRead: number; cacheWrite: number } | undefined {
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
  };
}

/**
 * Overlay Cindy's host-managed subscription endpoints onto PI's bundled
 * provider catalog. Registry metadata is authoritative for OpenAI subscription
 * models; the version-matched PI binary remains authoritative for native API and
 * compat details that Cindy must preserve when materializing the overlay.
 */
export function buildPiSubscriptionNativeProviders(
  catalog: Catalog,
  endpoint: string,
  bundledModelsByProvider?: PiBundledModelCatalog,
  listedModelIdsByProvider?: PiListedModelIds,
  retainedOpenAiModel?: ModelDescriptor | null,
): PiNativeProvidersResult {
  const providers: PiNativeProviderSpec[] = [];
  const env: Record<string, string> = {
    [PI_OPENAI_PROXY_KEY_ENV]: piOpenaiProxyPlaceholderJwt(),
  };
  const add = (
    sourceProviderId: 'anthropic' | 'openai' | 'xai',
    piProviderId: string,
    name: string,
    baseUrl: string,
    stripPrefix?: string,
  ): void => {
    const source = catalog.providers.find((provider) => provider.id === sourceProviderId);
    const models = [...(source?.models.pi ?? [])];
    if (
      sourceProviderId === 'openai' &&
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
    providers.push({
      id: piProviderId,
      sourceProviderId,
      name,
      baseUrl,
      inheritModels: true,
      ...(sourceProviderId === 'openai' ? { apiKeyEnvVar: PI_OPENAI_PROXY_KEY_ENV } : {}),
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
        // A missing/empty/partial PI probe is not evidence that the daily
        // catalog annotation is wrong. Keep annotated rows in the overlay so
        // inheritModels cannot filter out a confirmed addition or correction.
        const isAnnotatedAddition = !!model.piApi && !bundledModel;
        const isContextProfileAddition =
          sourceProviderId === 'openai' && wireId.endsWith('[1m]') && !bundledModel;
        const isProtocolCorrection =
          sourceProviderId !== 'openai' &&
          !!model.piApi &&
          !!bundledModel &&
          bundledModel.api !== model.piApi;
        const isRegistryBaselineOverlay = sourceProviderId === 'openai' && !!bundledModel;
        const catalogCost = catalogCostForPiNative(model.cost);
        if (isRegistryBaselineOverlay) {
          const input = model.supportsImageInput === undefined
            ? [...bundledModel.input]
            : model.supportsImageInput
              ? ['text', 'image'] as Array<'text' | 'image'>
              : ['text'] as Array<'text' | 'image'>;
          const cost = catalogCost ?? bundledModel.cost;
          return {
            id: model.id,
            wireId,
            // Materialize Registry metadata for same-id OpenAI models. `api`
            // makes inheritModels emit the overlay into models.json, while PI's
            // bundled provider remains authoritative for native transport quirks.
            api: bundledModel.api,
            name: model.name,
            contextWindow: model.contextWindow,
            maxTokens: model.maxOutput ?? bundledModel.maxTokens,
            reasoning: model.efforts.length > 0,
            input,
            thinkingLevelMap: Object.fromEntries(
              PI_REASONING_EFFORTS.map((effort) => [
                effort,
                model.efforts.includes(effort) ? effort : null,
              ]),
            ),
            ...(cost ? { cost: { ...cost } } : {}),
            ...(bundledModel.headers ? { headers: { ...bundledModel.headers } } : {}),
            ...(bundledModel.compat ? { compat: structuredClone(bundledModel.compat) } : {}),
            ...(bundledModel.samplingParams
              ? { samplingParams: structuredClone(bundledModel.samplingParams) }
              : {}),
          };
        }
        const preserved = isProtocolCorrection ? bundledModel : contextProfileTemplate;
        return {
          id: model.id,
          wireId,
          // ChatGPT subscription uses PI's specialized openai-codex adapter. A
          // portable piApi marks a daily catalog addition here. Existing models
          // stay untouched so their full bundled compat/pricing metadata survives;
          // only IDs proven absent from this exact PI binary are added.
          ...(sourceProviderId === 'openai' && (isAnnotatedAddition || isContextProfileAddition)
            ? { catalogAddition: true }
            : {}),
          // SuperGrok 没有官方列模型通道，Cindy 目录是成员唯一来源。
          // 缺席证明必须来自未过滤的 --list-models id：解析后的
          // bundled 表会丢掉未知 api 的行，不能把「解析失败」当成
          // 「二进制没有这个模型」。
          ...(() => {
            if (sourceProviderId !== 'xai') return {};
            const listedIds =
              listedModelIdsByProvider?.get(piProviderId) ??
              listedPiModelIds(bundledModelsByProvider)?.get(piProviderId);
            if (!listedIds || listedIds.has(wireId)) return {};
            return { catalogAddition: true };
          })(),
          ...(sourceProviderId !== 'openai' &&
          model.piApi &&
          (isAnnotatedAddition || isProtocolCorrection)
            ? { api: model.piApi }
            : {}),
          name: isContextProfileAddition ? model.name : (preserved?.name ?? model.name),
          contextWindow: isContextProfileAddition
            ? model.contextWindow
            : (preserved?.contextWindow ?? model.contextWindow),
          ...(preserved?.maxTokens
            ? { maxTokens: preserved.maxTokens }
            : model.maxOutput
              ? { maxTokens: model.maxOutput }
              : {}),
          reasoning: preserved?.reasoning ?? model.efforts.length > 0,
          ...(preserved?.input
            ? { input: [...preserved.input] }
            : model.supportsImageInput === true
              ? { input: ['text', 'image'] as Array<'text' | 'image'> }
              : {}),
          ...(preserved?.thinkingLevelMap
            ? { thinkingLevelMap: { ...preserved.thinkingLevelMap } }
            : model.efforts.length > 0
              ? {
                  thinkingLevelMap: Object.fromEntries(
                    PI_REASONING_EFFORTS.map((effort) => [
                      effort,
                      model.efforts.includes(effort) ? effort : null,
                    ]),
                  ),
                }
              : {}),
          ...(preserved?.cost
            ? { cost: { ...preserved.cost } }
            : catalogCost
              ? { cost: catalogCost }
              : {}),
          ...(preserved?.headers ? { headers: { ...preserved.headers } } : {}),
          ...(preserved?.compat ? { compat: structuredClone(preserved.compat) } : {}),
        };
      }),
    });
  };
  add('anthropic', 'anthropic', 'Anthropic', endpoint);
  add('openai', 'openai-codex', 'OpenAI (ChatGPT)', endpoint, 'chatgpt/');
  add('xai', 'xai', 'xAI (SuperGrok)', appendEndpointPath(endpoint, 'v1'), 'xai/');
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
const PI_OAUTH_SUBSCRIPTION_PROVIDERS = new Set(['anthropic', 'openai']);
const PI_BUNDLED_RESERVED_PROVIDER_IDS = ['anthropic', 'openai-codex', 'xai'] as const;

/**
 * 解析 pi 主执行文件绝对路径;找不到返回 null(pi 为可选实验 agent,不阻塞启动)。
 * pi 产物是目录形态(主二进制 + theme/ 等运行时资产),路径指向其中的可执行文件。
 * 路径只来自 agent-binaries 受管链：正式版是 CDN 下载到 userData/pi/<version>/
 * 的已校验目录，dev 是 apps/pi-bin/<platform>/ 中 pnpm install:pi 的产物。
 */
export function resolvePiBinaryPath(): string | null {
  return getReadyBinaryPath('pi') ?? null;
}

// ── AuthAdapter(XD 网关 key)─────────────────────────────────────────────────

class DesktopPiAuthAdapter implements AuthAdapter {
  async getState(options?: AuthAdapterOptions): Promise<AuthState> {
    const providerId = options?.providerId?.trim() || null;
    if (providerId === 'anthropic') {
      return hasClaudeAiOAuth()
        ? { authenticated: true, identity: 'Claude.ai', authSource: 'oauth' }
        : { authenticated: false, errorReason: 'anthropic_oauth_unavailable' };
    }
    if (providerId === 'openai') {
      return desktopCodexAuthAdapter.getState({ credentialMode: 'oauth-bearer' });
    }
    if (providerId === 'xai') {
      return hasGrokOAuthLogin()
        ? { authenticated: true, identity: 'SuperGrok', authSource: 'oauth' }
        : { authenticated: false, errorReason: 'xai_oauth_unavailable' };
    }
    if (providerId) {
      const storageProviderId = storedCustomProviderId(providerId);
      try {
        const custom = (await listCustomProvidersWithSecureHeaders()).find(
          (provider) => provider.id === storageProviderId && provider.runtimes.pi,
        );
        if (custom) {
          const method = custom.auth?.method ?? 'apiKey';
          if (method === 'none') {
            // AuthState 只有 oauth/api-key 两种“子进程凭证族”；keyless native provider
            // 归入 provider-key 族即可，实际 models.json 使用固定 dummy key。
            return { authenticated: true, identity: custom.name, authSource: 'api-key' };
          }
          if (method === 'apiKey') {
            const hasHeaderCredential = Object.keys(custom.runtimes.pi?.headers ?? {}).length > 0;
            return readCustomProviderKey(storageProviderId, 'pi') || hasHeaderCredential
              ? { authenticated: true, identity: custom.name, authSource: 'api-key' }
              : { authenticated: false, errorReason: 'pi_native_api_key_unavailable' };
          }
          return { authenticated: false, errorReason: 'pi_native_oauth_unsupported' };
        }
      } catch (err) {
        log.warn('pi auth: custom provider lookup failed', {
          providerId,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
    const key = readClaudeApiKey();
    if (!key) {
      return { authenticated: false, errorReason: 'cindy_gateway_key_unavailable' };
    }
    return { authenticated: true, identity: 'Cindy AI', authSource: 'api-key' };
  }

  async triggerLogin(): Promise<AuthState> {
    // pi 无独立登录面;网关 key 随 Cindy 账号凭据同步下发。
    return this.getState();
  }

  async logout(): Promise<void> {
    // 网关 key 生命周期归账号体系管,pi 侧无可清理凭证。
  }

  async getAuthEnv(options?: AuthAdapterOptions): Promise<Record<string, string>> {
    // 共用 cindy provider 的订阅 OAuth 路由用占位符(真凭证由 compat proxy 注入)。
    if (options?.providerId && PI_OAUTH_SUBSCRIPTION_PROVIDERS.has(options.providerId)) {
      return { [PI_API_KEY_ENV]: PI_PROVIDER_AUTH_PLACEHOLDER_KEY };
    }
    const key = readClaudeApiKey();
    // xAI/BYOM 不依赖 Cindy 登录。models.json 始终包含 gateway `cindy` 块，
    // 有网关 key 就保留给会话内切回 Cindy/XD；无 key 时才用不可用占位值。
    // xAI 原生块自身使用 PI_XAI_PROXY_API_KEY_ENV，不再与网关块争用此变量。
    return { [PI_API_KEY_ENV]: key ?? PI_PROVIDER_AUTH_PLACEHOLDER_KEY };
  }
}

export const desktopPiAuthAdapter: AuthAdapter = new DesktopPiAuthAdapter();

// ── RuntimeConfig ────────────────────────────────────────────────────────────

export function composePiSystemPrompt(hostPrompt: string, agentPrompt: string): string {
  return [hostPrompt, agentPrompt]
    .map((section) => section.trim())
    .filter(Boolean)
    .join('\n\n');
}

function buildDesktopPiRuntimeConfig(): AgentRuntimeConfig {
  const ripgrepPath = getRipgrepBinaryPath();
  const config: AgentRuntimeConfig = {
    // 保留 host 共用身份段,再追加 Pi 专属行为段；maker-core 会整体追加到 Pi 原生 prompt。
    systemPrompt: composePiSystemPrompt(hostSystemPrompt, piSystemPrompt),
    // Pi 的 grep 以及 Cindy 覆盖的 find 都固定复用随 Desktop 校验、打包的 rg。
    // 下发绝对路径而非 PATH，避免 Windows 从不受信工作目录优先命中同名 rg.exe。
    managedExecutablePaths: { ripgrep: ripgrepPath },
    userDataPath: app.getPath('userData'),
  };
  // 网关 endpoint 随 model-access 凭据同步就绪,用 getter 惰性读(与 claude remoteEndpoint 同理)。
  Object.defineProperty(config, 'endpoint', {
    get: () => getClaudeEndpoint(),
    enumerable: true,
    configurable: false,
  });
  // 远端会话专用:真上游网关端点(非本地 loopback compat proxy)。远端机器够不到
  // 本机 127.0.0.1,必须直连网关 —— 与 CC 的 buildDesktopClaudeRuntimeConfig 对齐。
  // 缺省会 fallback 到 endpoint(loopback),远端不可用 —— 但 writeModelsJson 的
  // remote 分支显式读它,缺失时写 127.0.0.1:0 是 bug(见 R1/R2 审核);这里保证
  // 恒有真上游。
  Object.defineProperty(config, 'remoteEndpoint', {
    get: () => claudeUpstreamEndpoint(),
    enumerable: true,
    configurable: false,
  });
  Object.defineProperties(config, {
    memoryEnabled: {
      get: () => readMemorySettings().pi,
      enumerable: true,
    },
    makerMemoryEnabled: {
      get: () => readMemorySettings().maker,
      enumerable: true,
    },
  });
  return config;
}

// ── 构造入口 ─────────────────────────────────────────────────────────────────

export interface BuildPiAgentOpts {
  logger: AgentDeps['logger'];
  turnChangeCapture?: AgentDeps['turnChangeCapture'];
  registerLocalAgentProcess?: AgentDeps['registerLocalAgentProcess'];
  capabilityAdditions?: AgentDeps['capabilityAdditions'];
  reviewAutoPermissionAction?: AgentDeps['reviewAutoPermissionAction'];
  /** Cindy MCP providers(与 claude/codex 同源工厂产物);经 HTTP bridge 暴露给 pi。 */
  mcpProviders?: AgentDeps['mcpProviders'];
  makerMemory?: AgentDeps['makerMemory'];
  resolvePiRuntimeModelDescriptor?: AgentDeps['resolvePiRuntimeModelDescriptor'];
  resolvePiGatewayModelDescriptor?: AgentDeps['resolvePiGatewayModelDescriptor'];
  getGhostRosterPrompt?: AgentDeps['getGhostRosterPrompt'];
  /** Trusted project-approval authority; omitted until the host has one, which fails closed. */
  resolvePiProjectTrustInput?: AgentDeps['resolvePiProjectTrustInput'];
  /** 层 C：视觉桥后端 env（cindy-bridge 的 vision 工具读取）。 */
  resolvePiVisionBridgeEnv?: AgentDeps['resolvePiVisionBridgeEnv'];
  /** SSH remote pi 会话的 transport 工厂(host 装配;缺省 = 远端 pi 会话被拒)。 */
  getRemotePiTransport?: AgentDeps['getRemotePiTransport'];
  /** SSH remote pi 会话的 agentHome 文件操作原语(host 装配;缺省 = 远端 fs 走本地,错误语义)。 */
  getRemotePiFileOps?: AgentDeps['getRemotePiFileOps'];
  /** 远端 pi 二进制解析(host probe;缺省 = 回落本地路径)。 */
  resolveRemotePiBinaryPath?: AgentDeps['resolveRemotePiBinaryPath'];
  /** 远端会话是否跳过 in-process MCP bridge(Phase 1 不桥 orca/memory/ghost)。 */
  remotePiSkipMcpBridge?: AgentDeps['remotePiSkipMcpBridge'];
  /** 远端 MCP bridge URL 改写器:把本地 loopback URL 改成 remote-forward 地址。
   *  轮 24 HIGH-2:返回 { url, close } —— close 关闭本次 rewrite 建立的 forward,
   *  pi-host 在会话 dispose 时调用, 防远端端口随会话累积泄漏。 */
  rewriteRemotePiMcpBridgeUrl?: (
    remoteHostId: string,
    localUrl: string,
  ) => Promise<{ url: string; close: () => void }>;
  /** 远端 agent-proxy env(HTTPS_PROXY/HTTP_PROXY/NO_PROXY 经 SSH remote-forward)。 */
  getRemotePiAgentProxyEnv?: AgentDeps['getRemotePiAgentProxyEnv'];
}

/** Cindy wire protocol → pi models.json api 形态。 */
function wireProtocolToPiApi(wp: ProviderWireProtocol): PiNativeApi {
  switch (wp) {
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

function urlOrigin(value: string | undefined): string | null {
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

const piModelCatalog = piModelCatalogJson as unknown as {
  generatedAt: string;
  providers: Record<string, PiCatalogModel[]>;
};

/** Keep Cindy's historical xai/ ids while Pi's official native provider uses bare model ids. */
export function piNativeModelId(providerId: string, model: string): string {
  return providerId === 'xai' && model.startsWith('xai/') ? model.slice('xai/'.length) : model;
}

function officialPiModels(providerId: string): PiNativeModelSpec[] | null {
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

function officialPiRouteMatches(
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
 * 纯映射:自定义 provider 配置(含 pi runtime)→ pi 原生 provider spec + env。
 * key 读取经 `readKey` 注入(便于单测)。规则:
 *  - 无 pi runtime → 跳过;
 *  - oauth 形态 → 跳过(pi models.json 仅支持 radius oauth,不通用);
 *  - apiKey 形态但 key / 自定义 headers 都没有 → 跳过(避免半可用);
 *  - none(keyless,本机 Ollama 等)→ apiKeyEnvVar 留空,models.json 写 dummy key;
 *  - 自定义 header 值全部搬进子进程 env,models.json 只保留 `$ENV` 引用。
 * 直连用户端点,不过 anthropic-compat 代理(设计原则:pi 主导,禁双重转义)。
 */
export function buildPiNativeProvidersFromConfigs(
  configs: Array<{
    id: string;
    name: string;
    auth?: { method?: string };
    runtimes: {
      pi?: {
        baseUrl: string;
        wireProtocol?: ProviderWireProtocol;
        headers?: Record<string, string>;
        piCatalogProviderId?: string;
        models: Array<{
          id: string;
          name?: string;
          contextWindow?: number;
          supportsImageInput?: boolean;
          reasoning?: boolean;
          reasoningEfforts?: PiReasoningEffort[];
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
    if (authMethod === 'oauth') {
      onSkip?.(cfg.id, 'oauth not supported for pi native');
      continue;
    }
    const runtimeApi =
      rt.wireProtocol === undefined ? undefined : wireProtocolToPiApi(rt.wireProtocol);
    // Protocol authority, in order: per-model override, explicit endpoint default,
    // strictly same-origin PI bundled knowledge, then an explicitly matched official
    // PI catalog. Missing protocol is not Chat: one unresolved model makes the whole
    // provider unusable so PI cannot silently send it to a guessed endpoint shape.
    const bundledModels = rt.models.map((model) =>
      !model.piApi && !runtimeApi
        ? resolvePiBundledModelById(bundledModelsByProvider, model.id, rt.baseUrl)
        : undefined,
    );
    const official =
      rt.piCatalogProviderId &&
      officialPiRouteMatches(rt.piCatalogProviderId, rt.baseUrl, rt.wireProtocol)
        ? officialPiModels(rt.piCatalogProviderId)
        : null;
    const officialById = new Map((official ?? []).map((model) => [model.id, model]));
    const metadataModels = rt.models.map(
      (model, index) => bundledModels[index] ?? officialById.get(model.id),
    );
    const modelApis = rt.models.map(
      (model, index) =>
        model.piApi ??
        (model.route ? wireProtocolToPiApi(model.route.wireProtocol) : undefined) ??
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
    providers.push({
      id: runtimeCustomProviderId(cfg.id),
      name: cfg.name,
      baseUrl: rt.baseUrl,
      api: providerApi,
      apiKeyEnvVar,
      ...(headers && Object.keys(headers).length > 0 ? { headers } : {}),
      models: rt.models.map((m, index) => {
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
        const modelBaseUrl =
          explicitRouteApi === modelApi
            ? explicitRoute?.baseUrl
            : bundledModel?.api === modelApi
              ? bundledModel.baseUrl
              : undefined;
        return {
          id: m.id,
          ...(m.piApi || modelApi !== providerApi ? { api: modelApi } : {}),
          ...(modelBaseUrl && modelBaseUrl !== rt.baseUrl ? { baseUrl: modelBaseUrl } : {}),
          name: bundledModel?.name ?? m.name,
          contextWindow: bundledModel?.contextWindow ?? m.contextWindow,
          ...(bundledModel?.maxTokens ? { maxTokens: bundledModel.maxTokens } : {}),
          ...(bundledModel?.input
            ? { input: [...bundledModel.input] }
            : m.supportsImageInput === true
              ? { input: ['text', 'image'] as Array<'text' | 'image'> }
              : {}),
          ...(bundledModel
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
          ...(bundledModel?.cost ? { cost: { ...bundledModel.cost } } : {}),
          ...(bundledModel?.headers ? { headers: { ...bundledModel.headers } } : {}),
          ...(bundledModel?.compat ? { compat: structuredClone(bundledModel.compat) } : {}),
          ...(bundledModel?.samplingParams
            ? { samplingParams: structuredClone(bundledModel.samplingParams) }
            : {}),
        };
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

export async function buildXaiPiNativeProvider(
  model?: string,
  allowHistoricalResume = false,
  remote = false,
): Promise<PiNativeProvidersResult> {
  const catalogModels =
    getActiveCatalog().providers.find((provider) => provider.id === 'xai')?.models.pi ?? [];
  const officialById = new Map(
    (officialPiModels('xai') ?? []).map((candidate) => [candidate.id, candidate]),
  );
  const models = catalogModels.map((catalogModel) => ({
    ...(officialById.get(catalogModel.id) ??
      configuredPiModel({
        id: catalogModel.id,
        name: catalogModel.name,
        supportsImageInput:
          catalogModel.supportsImageInput === true ||
          catalogModel.modalities?.input.includes('image') === true,
        reasoning: catalogModel.efforts.length > 0,
        reasoningEfforts: catalogModel.efforts.filter(
          (effort): effort is PiReasoningEffort => effort !== 'ultra',
        ),
      })),
    id: `xai/${catalogModel.id}`,
    // Keep the xai/ prefix on the wire so the existing compat proxy selects its Responses
    // bridge, which refreshes OAuth per request, recovers 401/403, and injects x_search.
    api: 'anthropic-messages' as const,
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
      models.push({ id: namespacedModel, name: namespacedModel, api: 'anthropic-messages' });
      aliases[model] = namespacedModel;
      aliases[piNativeModelId('xai', model)] = namespacedModel;
    }
  }
  return {
    providers: [
      {
        id: 'xai',
        name: 'xAI',
        baseUrl: remote
          ? (() => {
              const endpoint = new URL(getClaudeEndpoint());
              endpoint.hostname = '127.0.0.1';
              endpoint.port = String(PI_XAI_COMPAT_FORWARD_PORT);
              return endpoint.toString().replace(/\/$/, '');
            })()
          : getClaudeEndpoint(),
        api: 'anthropic-messages',
        apiKeyEnvVar: PI_XAI_PROXY_API_KEY_ENV,
        headers: {
          'x-cindy-pi-session-id': `$${PI_SESSION_ID_ENV}`,
          'x-cindy-pi-session-token': `$${PI_SESSION_TOKEN_ENV}`,
          [PI_PROVIDER_HEADER]: 'xai',
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

export function resolvePiCindyGatewayModelApi(
  _selectedProviderId: string | null | undefined,
  modelId: string,
): 'anthropic-messages' | 'openai-responses' | null | undefined {
  return resolveXdPiGatewayWireProtocol(modelId);
}

/** BYOM:读 DB 自定义 provider + safeStorage key → pi 原生 provider spec。IO 外壳,逻辑在上面。 */
export async function resolvePiNativeProviders(ctx: {
  workingDir: string;
  remoteHostId?: string | null;
  providerId?: string | null;
  model: string;
  resumeSessionId?: string;
}): Promise<PiNativeProvidersResult> {
  if (!ctx.remoteHostId) {
    // Pi scans the local ~/.agents/skills root when it starts. This hook is awaited by every
    // Desktop Pi startSession caller, so refresh Codex-only projections added after app startup
    // before the process snapshots its global skills. Remote Pi has a different HOME/root.
    await desktopClaudeAuthAdapter.ensureSharedGlobalSkills();
  }
  const piBinaryPath = resolvePiBinaryPath();
  const bundledModels = piBinaryPath ? await readPiBundledModels(piBinaryPath) : null;
  let subscriptions: PiNativeProvidersResult = { providers: [], env: {} };
  if (!ctx?.remoteHostId && isAnthropicCompatProxyHandleReady()) {
    const retainedOpenAiModel =
      ctx.resumeSessionId && ctx.providerId === 'openai'
        ? resolvePiRuntimeModelDescriptor(getActiveCatalog(), 'openai', ctx.model, {
            localOverrides: getLocalCatalogOverridesSnapshot(),
          })
        : null;
    subscriptions = buildPiSubscriptionNativeProviders(
      getActiveCatalog(),
      getClaudeEndpoint(),
      bundledModels ?? undefined,
      undefined,
      retainedOpenAiModel,
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
  const custom = buildPiNativeProvidersFromConfigs(
    configs,
    readCustomProviderKey,
    (id, reason) => log.warn('resolvePiNativeProviders: skipped custom provider', { id, reason }),
    bundledModels ?? undefined,
  );
  // Remote PI cannot use the local native overlay. Preserve upstream's exact
  // SuperGrok provenance/forwarding path there; locally the version-matched PI
  // native provider above remains the protocol authority.
  if (
    !subscriptions.providers.some((provider) => provider.id === 'xai') &&
    (ctx.providerId === 'xai' || hasGrokOAuthLogin())
  ) {
    const selectedXaiModel =
      ctx.providerId === 'xai' || (!ctx.providerId && ctx.model.startsWith('xai/'))
        ? ctx.model
        : undefined;
    const xai = await buildXaiPiNativeProvider(selectedXaiModel, !!ctx.resumeSessionId, isRemote);
    custom.providers.push(...xai.providers);
    Object.assign(custom.env, xai.env);
  }
  return mergePiNativeProviderResults(
    subscriptions,
    custom,
    (sourceProviderId, runtimeProviderId) => {
      log.info('resolvePiNativeProviders: namespaced custom provider runtime id', {
        sourceProviderId,
        runtimeProviderId,
      });
    },
  );
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

/** pi 二进制缺失时返回 null(调用方跳过注册);其余情况构造 PiAgent。 */
export function buildPiAgent(opts: BuildPiAgentOpts): PiAgent | null {
  const binaryPath = resolvePiBinaryPath();
  if (!binaryPath) {
    log.warn('pi binary unavailable after managed prepare; pi agent disabled for this launch');
    return null;
  }
  log.info('pi agent enabled', { binaryPath });
  return new PiAgent({
    auth: desktopPiAuthAdapter,
    runtimeConfig: buildDesktopPiRuntimeConfig(),
    binaryPath,
    logger: opts.logger,
    turnChangeCapture: opts.turnChangeCapture,
    registerLocalAgentProcess: opts.registerLocalAgentProcess,
    derivePiProxySessionToken,
    capabilityAdditions: opts.capabilityAdditions,
    reviewAutoPermissionAction: opts.reviewAutoPermissionAction,
    mcpProviders: opts.mcpProviders,
    makerMemory: opts.makerMemory,
    // 与 Claude Code / Codex 同一份第一方 MCP 审批真源。Pi 之前没接,导致 orca 这类
    // 可信 server 的工具落进 Auto-review 灰区被模型静默 block(详见 pi/index.ts 权限门)。
    getMcpToolApprovalPolicy: getDesktopMcpToolApprovalPolicy,
    getMcpToolApprovalPresentation: getDesktopMcpToolApprovalPresentation,
    resolvePiAgentHome: (remoteHostId) => {
      // 轮 40-w4-t3 CRITICAL:远端 agentHome 承载 session 历史(sessions/*.jsonl,
      // 与 DB sdk_session_id 持久关联)—— 必须落远端持久目录, 不能用本机
      // userData(远端 fileOps 会创建含反斜杠的字面目录)或 /tmp(重启即丢)。
      // $HOME 由远端 fileOps 的 bash 统一展开;DB 里存 $HOME/... 字面, 跨会话
      // 一致。run-tmp 等短生命周期内容仍走 agentHome/run-tmp。
      if (remoteHostId) return '$HOME/.xdt-server/v1/pi-agent-home';
      return path.join(app.getPath('userData'), 'pi-agent-home');
    },
    preparePiExtraSpawnConfig: async (providers, ctx) => {
      const extra = await getPiExtraSpawnConfig(providers, opts.logger, ctx);
      if (!extra?.mcpBridge || extra.mcpBridge.servers.length === 0) return extra;
      // 远端会话:把 in-process bridge 的 loopback URL 改成 remote-forward 地址
      // (SSH 隧道转发回本地 bridge)。身份 query / token 不变。
      const remoteHostId = ctx?.remoteHostId;
      const rewriter = opts.rewriteRemotePiMcpBridgeUrl;
      if (remoteHostId && rewriter) {
        let servers;
        // 轮 24 HIGH-2:rewriter 每次调用建一条远端 forward, 会话结束必须关闭
        // —— 收集 close, 包装进 disposeSessionCtx, 否则端口随会话累积泄漏。
        const forwardClosers: Array<() => void> = [];
        // 轮 40-w4-t8 HIGH:并发重写时一个 rewriter reject 后, 其它 pending 的
        // rewriter 晚到 resolve 仍会 push close 并创建 forward —— Promise.all
        // 的 catch 只关当时已收集的, 晚到的 forward 永不关闭(端口/句柄泄漏)。
        // 改 Promise.allSettled: 全部 settle 后统一判定, 任一失败则关闭所有
        // 已成功项(含晚到的), 再重抛。
        const settled = await Promise.allSettled(
          extra.mcpBridge.servers.map(async (s) => {
            if (s.remote) return s; // 外部 HTTP MCP 直连,不改。
            const rewritten = await rewriter(remoteHostId, s.url);
            forwardClosers.push(rewritten.close);
            // 轮 29 LOW-2:显式标 PiMcpServerRef —— rewrite 后 URL 指向 SSH
            // 隧道本地端(不再是远端直连), remote 字段缺省 = undefined。
            const ref: PiMcpServerRef = {
              name: s.name,
              url: rewritten.url,
            };
            return ref;
          }),
        );
        const failed = settled.find((r) => r.status === 'rejected');
        if (failed) {
          // URL 改写失败(SSH forward 不可用等):**所有**已建立的 forward 一并
          // 关闭(含晚到 resolve 的), 再注销已注册的 session ctx(否则 bridge
          // 端残留引用泄漏 —— R2 凭证 Bug7)。然后重抛,由 PiAgent 的 catch
          // 降级为「远端无 MCP」。
          for (const close of forwardClosers) {
            try {
              close();
            } catch {
              /* best-effort */
            }
          }
          try {
            extra.disposeSessionCtx?.();
          } catch {
            /* best-effort */
          }
          const reason = (failed as PromiseRejectedResult).reason;
          throw reason instanceof Error ? reason : new Error(String(reason));
        }
        servers = settled.map((r) => (r as PromiseFulfilledResult<PiMcpServerRef>).value);
        const baseDispose = extra.disposeSessionCtx;
        return {
          ...extra,
          mcpBridge: { ...extra.mcpBridge, servers },
          disposeSessionCtx: () => {
            for (const close of forwardClosers) {
              try {
                close();
              } catch {
                /* best-effort */
              }
            }
            baseDispose?.();
          },
        };
      }
      return extra;
    },
    registerPiProxySession,
    resolvePiNativeProviders: (ctx) => resolvePiNativeProviders(ctx),
    resolvePiRuntimeModelDescriptor: opts.resolvePiRuntimeModelDescriptor,
    resolvePiGatewayModelDescriptor: opts.resolvePiGatewayModelDescriptor,
    // `cindy` is the gateway fallback block even when the session starts on a subscription or
    // BYOM provider. Its model protocol must therefore come from the exact XD model, never from
    // the currently selected provider's endpoint default.
    resolvePiGatewayModelApi: resolvePiCindyGatewayModelApi,
    getGhostRosterPrompt: opts.getGhostRosterPrompt,
    resolvePiProjectTrustInput: opts.resolvePiProjectTrustInput,
    resolvePiVisionBridgeEnv: opts.resolvePiVisionBridgeEnv,
    getRemotePiTransport: opts.getRemotePiTransport,
    getRemotePiFileOps: opts.getRemotePiFileOps,
    resolveRemotePiBinaryPath: opts.resolveRemotePiBinaryPath,
    remotePiSkipMcpBridge: opts.remotePiSkipMcpBridge,
    getRemotePiAgentProxyEnv: opts.getRemotePiAgentProxyEnv,
  });
}
