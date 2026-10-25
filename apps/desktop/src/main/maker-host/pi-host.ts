import { createPiGatewayModelResolver } from '@cindy/app-runtime/piGatewayModelResolver';
import { forwardSshPiMcp } from '@cindy/app-runtime/sshPiMcp';
import { pruneAnthropicCompatForGateway } from '@cindy/model-providers/model-plane/pi-gateway-model-catalog';
export { pruneAnthropicCompatForGateway } from '@cindy/model-providers/model-plane/pi-gateway-model-catalog';
import { ANSWER_DELIVERY_PROMPT } from '@cindy/maker-shared/rich-answer-guide';
import { listCindyManagedSkills } from './managed-skills.js';
import { scanLocalCustomizations } from '../skillhub/customizationScanHost';
import { resolveCompanionRuntimeEnvironment } from '../bot-import/runtime.js';
import { readCachedGenericOAuthAccessToken } from './generic-oauth.js';

import { mergeByokNativeConfigs } from '../model-access/byokProvider.js';
import { readDisabledSkillPaths } from '../skillhub/activationPreferences';
import { subscriptionAccountKind, subscriptionAccountState, isXaiSubscriptionProviderId } from './subscription-account-auth.js';
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
 *    只注入凭证并原样转发。Cindy Gateway 的成员与显式 API 来自 Model Access；
 *    版本匹配的 Pi 本地模型表只补足缺失 API 及协议一致的 compat。
 *  - 二进制:与 cc/codex 同链 —— splash prepare 经 agent-binaries 按 CDN manifest
 *    的 pi 字段下载整目录 tar.gz 到 userData/pi/<version>/(SHA256 校验,清单一变
 *    下次启动即换新)。dev 期使用 apps/pi-bin 中 pnpm install:pi 的产物；正式版
 *    不内置 Pi，清单缺失或下载失败时 buildPiAgent 返回 null，本次不注册 pi，
 *    对 Cindy 启动零影响。
 */



import os from 'node:os';
import path from 'node:path';
import { app } from 'electron';

import { readModelContextLimit } from './model-context-limit-store.js';
import { toolchainThreadCapEnv } from './toolchain-thread-cap.js';
import { inputHandoffTaskShellEnv } from '../input-handoff/askpass/index.js';

import { PiAgent, PiNativeProviderProxyNotReadyError, type AgentDeps, type AuthAdapter, type AuthState } from '@cindy/maker-core';
import type { AgentRuntimeConfig, AuthAdapterOptions, PiNativeModelSpec, PiNativeProvidersResult } from '@cindy/maker-core';
import { storedCustomProviderId } from '@cindy/model-providers';

import type { CustomProviderConfig } from '@cindy/model-providers';

import { getReadyBinaryPath } from '../agent-binaries/index.js';
import { t } from '../i18n.js';
import { spawnPiSubagentRunner } from '../cindy-brain/piSubagentRunnerHost.js';
import { getPiExtraSpawnConfig } from '../mcp-integrations/piEnvironment.js';
import { listCustomProvidersWithSecureHeaders } from './custom-provider-header-secrets.js';
import { MANAGED_OLLAMA_PROVIDER_ID } from '../../shared/localModelRuntime.js';
import { ensureManagedOllamaReadyForSession } from '../local-model-runtime/preflight.js';
import { MANAGED_LLAMACPP_PROVIDER_ID } from '../../shared/llamaCpp.js';

import { readCustomProviderKey } from '../secrets/providerSecretStore.js';
import { desktopClaudeAuthAdapter, desktopCodexAuthAdapter, readClaudeApiKey } from './auth-adapters.js';
import { getClaudeEndpoint, isAnthropicCompatProxyHandleReady } from './anthropic-compat-proxy-host.js';

import { hasGrokOAuthLogin } from './grok-oauth-login.js';
import { isOpenAiSubscriptionProviderId } from './codex-account-auth.js';
import hostSystemPrompt from './host-system-prompt.md?raw';
import piSystemPrompt from './pi-system-prompt.md?raw';
import { createLogger } from '../logger.js';
import { readMemorySettings } from './memory-settings-store.js';
import { readPiCompactionPct } from './compaction-settings-store.js';
import { registerPiProxySession } from './pi-proxy-session-auth.js';
import { derivePiProxySessionToken } from './pi-proxy-session-token.js';
import { getDesktopMcpToolApprovalPolicy } from './mcp-tool-approval-policy.js';
import { getRipgrepBinaryPath, claudeUpstreamEndpoint } from './runtime-configs.js';
import { getActiveCatalog, getLocalCatalogOverridesSnapshot, resolveXdPiGatewayHintApi, resolveXdPiGatewayServerApi } from './active-catalog.js';

import { isExclusiveXaiModelId } from '../../shared/subscriptionModels.js';
import { resolvePiRuntimeModelDescriptor, resolveModelDefaultContextWindow, resolveModelContextProviderId } from './catalog-to-descriptors.js';
import { readPiNativeCompatOverride } from './pi-native-compat-overrides-store.js';
import { resolveManagedPiNativePackagePaths, resolveManagedPiPackageResources } from './pi-package-store.js';
import { mutateAuthorizedPiManagedPackage } from './pi-managed-package-mutation.js';

const log = createLogger('pi-host');

const PI_API_KEY_ENV = 'CINDY_PI_API_KEY';
const PI_XAI_PROXY_API_KEY_ENV = 'CINDY_PI_XAI_PROXY_API_KEY';
const PI_SESSION_ID_ENV = 'CINDY_PI_SESSION_ID';
const PI_SESSION_TOKEN_ENV = 'CINDY_PI_SESSION_TOKEN';
const PI_PROVIDER_AUTH_PLACEHOLDER_KEY = 'cindy-pi-provider-auth-placeholder';
const PI_OPENAI_PROXY_KEY_ENV = 'CINDY_PI_OPENAI_PROXY_KEY';
const PI_PROVIDER_HEADER = 'x-cindy-pi-provider-id';

import { listedPiModelIds, piOpenaiProxyPlaceholderJwt, appendEndpointPath, piSubscriptionHeaders, parsePiListModels, isRecord, parsePiBundledModel, readPiAvailableModels, readPiCatalogProbeEnv, catalogCostForPiNative, catalogThinkingLevelMap, buildPiSubscriptionNativeProviders, wireProtocolToPiApi, resolvePiBundledApiByModelId, urlOrigin, resolvePiBundledModelById, piNativeKeyEnvVar, piNativeModelId, reasoningCompatEnabled, thinkingMapsDiffer, officialXaiThinkingSpec, xaiOfficialCapabilityCorrection, officialPiModels, officialPiRouteMatches, configuredPiModel, buildPiNativeProvidersFromConfigs, mergePiNativeProviderResults, isPiGatewayModelApi, resolveProbedPiGatewayModel, readPiBundledModels as readSharedPiBundledModels, type PiBundledModelInfo, type PiBundledModelCatalog, type PiListedModelIds } from '@cindy/app-runtime/piNativeProviders';
export { listedPiModelIds, piOpenaiProxyPlaceholderJwt, appendEndpointPath, piSubscriptionHeaders, parsePiListModels, isRecord, parsePiBundledModel, readPiAvailableModels, readPiCatalogProbeEnv, catalogCostForPiNative, catalogThinkingLevelMap, buildPiSubscriptionNativeProviders, wireProtocolToPiApi, resolvePiBundledApiByModelId, urlOrigin, resolvePiBundledModelById, piNativeKeyEnvVar, piNativeModelId, reasoningCompatEnabled, thinkingMapsDiffer, officialXaiThinkingSpec, xaiOfficialCapabilityCorrection, officialPiModels, officialPiRouteMatches, configuredPiModel, buildPiNativeProvidersFromConfigs, mergePiNativeProviderResults, isPiGatewayModelApi, resolveProbedPiGatewayModel, type PiBundledModelInfo, type PiBundledModelCatalog, type PiListedModelIds } from '@cindy/app-runtime/piNativeProviders';
export function readPiBundledModels(binaryPath: string, options: { cachedOnly?: boolean } = {}) { return readSharedPiBundledModels(binaryPath, {...options, logger: log}); }
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
    if (providerId && subscriptionAccountKind(providerId)) return subscriptionAccountState(providerId);
    // Claude 订阅只供内置 Claude Code CLI 使用,Pi 会话不能选它(旧会话在此明确拒绝)。
    if (providerId === 'anthropic') {
      return { authenticated: false, errorReason: 'anthropic_oauth_unavailable' };
    }
    if (providerId && isOpenAiSubscriptionProviderId(providerId)) {
      return desktopCodexAuthAdapter.getState({ credentialMode: 'oauth-bearer', providerId });
    }
    if (providerId === 'xai') {
      return hasGrokOAuthLogin()
        ? { authenticated: true, identity: 'SuperGrok', authSource: 'oauth' }
        : { authenticated: false, errorReason: 'xai_oauth_unavailable' };
    }
    if (providerId) {
      const storageProviderId = storedCustomProviderId(providerId);
      try {
        const custom = mergeByokNativeConfigs(
          await listCustomProvidersWithSecureHeaders(),
          getActiveCatalog().providers,
        ).find(
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
          if (method === 'oauth' && custom.auth?.method === 'oauth' && custom.auth.oauth) {
            return readCachedGenericOAuthAccessToken(storageProviderId, custom.auth.oauth)
              ? { authenticated: true, identity: custom.name, authSource: 'oauth' }
              : { authenticated: false, errorReason: 'pi_native_oauth_unavailable' };
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
    if (options?.providerId && (PI_OAUTH_SUBSCRIPTION_PROVIDERS.has(options.providerId)
      || isOpenAiSubscriptionProviderId(options.providerId))) {
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
    behaviorFlags: (ctx) => ctx.spawnMode === 'remote' ? {} : toolchainThreadCapEnv(),
    // 代输入: sudo / ssh / git password prompts of this task go to the owner.
    taskShellEnv: inputHandoffTaskShellEnv,
    // 保留 host 共用身份段,再追加 Pi 专属行为段；maker-core 会整体追加到 Pi 原生 prompt。
    systemPrompt: composePiSystemPrompt(hostSystemPrompt, piSystemPrompt),
    answerDeliveryPrompt: ANSWER_DELIVERY_PROMPT,
    // Pi 的 grep 以及 Cindy 覆盖的 find 都固定复用随 Desktop 校验、打包的 rg。
    // 下发绝对路径而非 PATH，避免 Windows 从不受信工作目录优先命中同名 rg.exe。
    managedExecutablePaths: { ripgrep: ripgrepPath },
    userDataPath: app.getPath('userData'),
  };
  Object.defineProperty(config, 'piAutoCompactThresholdPct', {
    get: () => readPiCompactionPct(),
    enumerable: true,
    configurable: false,
  });
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
  /** Commit-edge fence; live caller retirement remains post-receipt below. */
  onPiManagedPackageMutationCommitted?: () => Promise<void>;
  onPiManagedPackageMutationSettled?: AgentDeps['onPiManagedPackageMutationSettled'];
  resolvePiRuntimeModelDescriptor?: AgentDeps['resolvePiRuntimeModelDescriptor'];
  resolvePiRuntimeModels?: AgentDeps['resolvePiRuntimeModels'];
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
  getRemoteAgentFileOps?: AgentDeps['getRemoteAgentFileOps'];
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

export async function buildXaiPiNativeProvider(
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

export const {resolvePiCindyGatewayModelApi, resolvePiCindyGatewayModelSpec} = createPiGatewayModelResolver({resolveXdPiGatewayHintApi, resolveXdPiGatewayServerApi});

/** BYOM:读 DB 自定义 provider + safeStorage key → pi 原生 provider spec。IO 外壳,逻辑在上面。 */
export async function resolvePiNativeProviders(ctx: {
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
    await desktopClaudeAuthAdapter.ensureSharedGlobalSkills();
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
      userDataDir: app.getPath('userData'),
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
  const custom = buildPiNativeProvidersFromConfigs(
    mergeByokNativeConfigs(configs, getActiveCatalog().providers),
    readCustomProviderKey,
    (id, reason) => log.warn('resolvePiNativeProviders: skipped custom provider', { id, reason }),
    bundledModels ?? undefined,
    getActiveCatalog(),
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
    resolveSessionEnvironment: resolveCompanionRuntimeEnvironment,
    getDisabledSkillPaths: readDisabledSkillPaths,
    // 上游拒收可选请求字段（如 prompt_cache_retention / prompt_cache_key）后学到的 per-model
    // compat 修正，写 models.json 时合并；只改 compat，不动路由与凭证。
    resolvePiNativeCompatOverride: (providerId, modelId, routeKey) =>
      readPiNativeCompatOverride(providerId, modelId, routeKey),
    getManagedSkills: listCindyManagedSkills,
    scanLocalCustomizations,
    resolveModelContextLimit: (providerId, modelId) => {
      const catalog = getActiveCatalog();
      const source = resolveModelContextProviderId(catalog, 'pi', providerId, modelId);
      return source ? readModelContextLimit('pi', source, modelId)
        ?? resolveModelDefaultContextWindow(catalog, 'pi', source, modelId) : null;
    },
    auth: desktopPiAuthAdapter,
    runtimeConfig: buildDesktopPiRuntimeConfig(),
    get binaryPath() { return resolvePiBinaryPath() ?? binaryPath; },
    logger: opts.logger,
    turnChangeCapture: opts.turnChangeCapture,
    registerLocalAgentProcess: opts.registerLocalAgentProcess,
    spawnPiSubagentRunner,
    derivePiProxySessionToken,
    capabilityAdditions: opts.capabilityAdditions,
    reviewAutoPermissionAction: opts.reviewAutoPermissionAction,
    mcpProviders: opts.mcpProviders,
    makerMemory: opts.makerMemory,
    // 与 Claude Code / Codex 同一份第一方 MCP 审批真源。Pi 之前没接,导致 orca 这类
    // 可信 server 的工具落进 Auto-review 灰区被模型静默 block(详见 pi/index.ts 权限门)。
    getMcpToolApprovalPolicy: getDesktopMcpToolApprovalPolicy,
    resolvePiAgentHome: (remoteHostId) => {
      // 轮 40-w4-t3 CRITICAL:远端 agentHome 承载 session 历史(sessions/*.jsonl,
      // 与 DB sdk_session_id 持久关联)—— 必须落远端持久目录, 不能用本机
      // userData(远端 fileOps 会创建含反斜杠的字面目录)或 /tmp(重启即丢)。
      // $HOME 由远端 fileOps 的 bash 统一展开;DB 里存 $HOME/... 字面, 跨会话
      // 一致。run-tmp 等短生命周期内容仍走 agentHome/run-tmp。
      if (remoteHostId) return '$HOME/.xdt-server/v1/pi-agent-home';
      return path.join(app.getPath('userData'), 'pi-agent-home');
    },
    resolvePiGlobalContextHome: (remoteHostId) => {
      if (remoteHostId) return '$HOME/.pi/agent';
      const override = process.env.PI_CODING_AGENT_DIR;
      return override
        ? path.resolve(override.replace(/^~(?=$|[\\/])/, () => os.homedir()))
        : path.join(os.homedir(), '.pi', 'agent');
    },
    resolvePiManagedPackageResources: resolveManagedPiPackageResources,
    resolvePiNativePackagePaths: resolveManagedPiNativePackagePaths,
    mutatePiManagedPackage: (request) => mutateAuthorizedPiManagedPackage(
      request,
      undefined,
      opts.onPiManagedPackageMutationCommitted
        ? { onRuntimeInvalidationPublished: opts.onPiManagedPackageMutationCommitted }
        : undefined,
    ),
    onPiManagedPackageMutationSettled: opts.onPiManagedPackageMutationSettled,
    getPiExtensionUiStrings: () => ({
      confirm: t('settings.piPackages.extensionDialogConfirm'),
      cancel: t('settings.piPackages.cancel'),
      mutationFailed: t('settings.piPackages.operationFailed'),
      mutationFailure: {
        'source-unavailable': t('settings.piPackages.failure.sourceUnavailable'),
        'package-not-found': t('settings.piPackages.failure.packageNotFound'),
        'version-not-found': t('settings.piPackages.failure.versionNotFound'),
        'state-unavailable': t('settings.piPackages.failure.stateUnavailable'),
        'native-command-failed': t('settings.piPackages.failure.nativeCommandFailed'),
      },
      mutationSuccess: {
        install: t('settings.piPackages.success.install'),
        installEnabled: t('settings.piPackages.success.installEnabled'),
        update: t('settings.piPackages.success.update'),
        remove: t('settings.piPackages.success.remove'),
      },
    }),
    preparePiExtraSpawnConfig: async (providers, ctx) => { return forwardSshPiMcp(await getPiExtraSpawnConfig(providers, opts.logger, ctx),ctx?.remoteHostId,opts.rewriteRemotePiMcpBridgeUrl); },
    registerPiProxySession,
    resolvePiNativeProviders: (ctx) => resolvePiNativeProviders(ctx),
    resolvePiRuntimeModelDescriptor: opts.resolvePiRuntimeModelDescriptor,
    resolvePiRuntimeModels: opts.resolvePiRuntimeModels,
    resolvePiGatewayModelDescriptor: opts.resolvePiGatewayModelDescriptor,
    // `cindy` is the gateway fallback block even when the session starts on a subscription or
    // BYOM provider. Its explicit protocol comes from the exact XD model; the local Pi table only
    // fills a remote omission and never inherits the currently selected provider's endpoint.
    resolvePiGatewayModelApi: resolvePiCindyGatewayModelApi,
    resolvePiGatewayModelSpec: resolvePiCindyGatewayModelSpec,
    getGhostRosterPrompt: opts.getGhostRosterPrompt,
    resolvePiProjectTrustInput: opts.resolvePiProjectTrustInput,
    resolvePiVisionBridgeEnv: opts.resolvePiVisionBridgeEnv,
    getRemotePiTransport: opts.getRemotePiTransport,
    getRemotePiFileOps: opts.getRemotePiFileOps,
    getRemoteAgentFileOps: opts.getRemoteAgentFileOps,
    resolveRemotePiBinaryPath: opts.resolveRemotePiBinaryPath,
    remotePiSkipMcpBridge: opts.remotePiSkipMcpBridge,
    getRemotePiAgentProxyEnv: opts.getRemotePiAgentProxyEnv,
  });
}
