import { createPiAuthAdapter } from './pi-auth.js';
import { piNativeKeyEnvVar, wireProtocolToPiApi, resolvePiBundledModelById, urlOrigin, officialPiRouteMatches, piModelCatalog, anthropicRootForV1Endpoint, type PiCatalogModel } from './pi-native-catalog.js';
export { buildPiNativeProvidersFromConfigs, type PiBundledModelCatalog, type PiBundledModelInfo, piNativeKeyEnvVar, resolvePiBundledModelById } from './pi-native-catalog.js';
import { listCindyManagedSkills } from './managed-skills.js';
import { scanLocalCustomizations } from '../skillhub/customizationScanHost';
import { resolveCompanionRuntimeEnvironment } from '../bot-import/runtime.js';
import { readCachedGenericOAuthAccessToken } from './generic-oauth.desktop.js';
import { providerPresetModelRecord, providerModelAdapterId, providerBaseUrlForApi } from '@cindy/model-providers';
import { readDisabledSkillPaths } from '../skillhub/activationPreferences';
import { subscriptionAccountKind, subscriptionAccountState } from './subscription-account-auth.js';
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

import { createPiModelResolvers } from './engineModelResolvers.js';

import {
  PiAgent,
  type AgentDeps,
  type AuthAdapter,
  type AuthState,
} from '@cindy/maker-core';
import type {
  AgentRuntimeConfig,
  AuthAdapterOptions,
  PiMcpServerRef,
} from '@cindy/maker-core';
import {
  resolvePiModelRoute,
  runtimeCustomProviderId,
  storedCustomProviderId,
} from '@cindy/model-providers';
import { providerCatalogForPi, providerModelRecord, providerModelGenerationRecord } from '@cindy/model-providers';
import type {
  ModelCost,
  ProviderWireProtocol,
} from '@cindy/model-providers';

import { getReadyBinaryPath } from '../agent-binaries/index.js';
import { t } from '../i18n.desktop.js';
import { spawnPiSubagentRunner } from '../cindy-brain/piSubagentRunnerHost.js';
import { getPiExtraSpawnConfig } from '../mcp-integrations/piEnvironment.desktop.js';
import { listCustomProvidersWithSecureHeaders } from './custom-provider-header-secrets.js';
import {
  matchesManagedOllamaFingerprint,
} from '../../shared/localModelRuntime.js';
import { ensureManagedOllamaReadyForSession } from '../local-model-runtime/preflight.js';
import {
  applyQwen38NativeOverlay,
  shouldApplyQwen38Overlay,
} from '../local-model-runtime/qwenProfile.js';
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
import { hostCredentialEndpointAllowed } from './pi-provider-transport.js';
import { hasGrokOAuthLogin } from './grok-oauth-login.desktop.js';
import { isOpenAiSubscriptionProviderId } from './codex-account-auth.desktop.js';
import { withProviderAppAttribution } from './provider-app-attribution.js';
import { createLogger } from '../logger.js';
import { registerPiProxySession } from './pi-proxy-session-auth.js';
import { derivePiProxySessionToken } from './pi-proxy-session-token.js';
import {
  getDesktopMcpToolApprovalPolicy,
} from './mcp-tool-approval-policy.js';
import { getRipgrepBinaryPath, claudeUpstreamEndpoint } from './runtime-configs.js';
import { buildPiRuntimeConfig } from './runtimeConfigsCore.js';
import {
  getActiveCatalog,
} from './active-catalog.js';
import { resolveModelContextProviderId } from './catalog-to-descriptors.js';
import { readPiNativeCompatOverride } from './pi-native-compat-overrides-store.js';
import {
  resolveManagedPiNativePackagePaths,
  resolveManagedPiPackageResources,
} from './pi-package-store.js';
import { mutateAuthorizedPiManagedPackage } from './pi-managed-package-mutation.js';
import {
  createPiNativeProviderResolver,
  resolvePiCindyGatewayModelApi,
  resolvePiCindyGatewayModelSpec,
} from './piNativeProvidersCore.js';
export {
  buildPiSubscriptionNativeProviders,
  listedPiModelIds,
  mergePiNativeProviderResults,
  parsePiListModels,
  PI_XAI_COMPAT_FORWARD_PORT,
  piNativeModelId,
  pruneAnthropicCompatForGateway,
  readPiBundledModels,
  resolvePiBundledApiByModelId,
  resolvePiCindyGatewayModelApi,
  resolvePiCindyGatewayModelSpec,
  type PiListedModelIds,
} from './piNativeProvidersCore.js';

const log = createLogger('pi-host');




/**
 * 解析 pi 主执行文件绝对路径;找不到返回 null(pi 为可选实验 agent,不阻塞启动)。
 * pi 产物是目录形态(主二进制 + theme/ 等运行时资产),路径指向其中的可执行文件。
 * 路径只来自 agent-binaries 受管链：正式版是 CDN 下载到 userData/pi/<version>/
 * 的已校验目录，dev 是 apps/pi-bin/<platform>/ 中 pnpm install:pi 的产物。
 */
export function resolvePiBinaryPath(): string | null {
  return getReadyBinaryPath('pi') ?? null;
}

// The desktop's ports for the Pi native providers shared with the Node Host (piNativeProvidersCore.ts).
const piNativeProviderResolver = createPiNativeProviderResolver({
  getClaudeEndpoint: () => getClaudeEndpoint(),
  isAnthropicCompatProxyHandleReady: () => isAnthropicCompatProxyHandleReady(),
  resolvePiBinaryPath: () => resolvePiBinaryPath(),
  isOpenAiSubscriptionProviderId: (...args) => isOpenAiSubscriptionProviderId(...args),
  hasGrokOAuthLogin: (...args) => hasGrokOAuthLogin(...args),
  listCustomProvidersWithSecureHeaders: () => listCustomProvidersWithSecureHeaders(),
  readCustomProviderKey: (...args) => readCustomProviderKey(...args),
  ensureSharedGlobalSkills: () => desktopClaudeAuthAdapter.ensureSharedGlobalSkills(),
  ensureManagedOllamaReadyForSession: (input) => ensureManagedOllamaReadyForSession(input),
  getUserDataDir: () => app.getPath('userData'),
});

export async function buildXaiPiNativeProvider(
  ...args: Parameters<typeof piNativeProviderResolver.buildXaiPiNativeProvider>
): ReturnType<typeof piNativeProviderResolver.buildXaiPiNativeProvider> {
  return piNativeProviderResolver.buildXaiPiNativeProvider(...args);
}

export async function resolvePiNativeProviders(
  ...args: Parameters<typeof piNativeProviderResolver.resolvePiNativeProviders>
): ReturnType<typeof piNativeProviderResolver.resolvePiNativeProviders> {
  return piNativeProviderResolver.resolvePiNativeProviders(...args);
}

// ── AuthAdapter(XD 网关 key)─────────────────────────────────────────────────

export const desktopPiAuthAdapter: AuthAdapter = createPiAuthAdapter({ subscriptionAccountKind, subscriptionAccountState, isOpenAiSubscriptionProviderId, desktopCodexAuthAdapter, hasGrokOAuthLogin, listCustomProvidersWithSecureHeaders, readCustomProviderKey, readCachedGenericOAuthAccessToken, readClaudeApiKey });

// ── RuntimeConfig ────────────────────────────────────────────────────────────

// Shared with the Node Host (runtimeConfigsCore.ts).
export { composePiSystemPrompt } from './runtimeConfigsCore.js';

function buildDesktopPiRuntimeConfig(): AgentRuntimeConfig {
  return buildPiRuntimeConfig({
    ripgrepPath: getRipgrepBinaryPath(),
    userDataPath: app.getPath('userData'),
    endpoint: () => getClaudeEndpoint(),
    remoteEndpoint: () => claudeUpstreamEndpoint(),
  });
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
    // 执行端动态学习；SSH 独立存储，避免把本机线路结论带到远端。
    resolvePiNativeCompatStorePath: remoteHostId => remoteHostId
      ? '$HOME/.xdt-server/v1/pi-agent-home/pi-native-compat-overrides.json'
      : path.join(app.getPath('userData'), 'pi-native-compat-overrides.json'),
    resolvePiNativeCompatOverride: (providerId, modelId, routeKey) =>
      readPiNativeCompatOverride(providerId, modelId, routeKey),
    getManagedSkills: listCindyManagedSkills,
    scanLocalCustomizations,
    ...createPiModelResolvers({ getCatalog: getActiveCatalog, resolveContextProviderId: resolveModelContextProviderId }),
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
    formatPiStartupCloudFileHint: (file) => t('logic.errors.piStartupCloudFile').replace('{{path}}', () => file),
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
