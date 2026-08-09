/**
 * apps/desktop/src/main/maker-host
 *
 * Desktop 端 Maker Core host 层。
 * 把所有 Electron 适配器组装好，构造 Maker 单例供 IPC bridge 使用。
 *
 * 注意：Maker 单例是 lazy-init 的 —— 第一次调用 getMaker() 时才构造。
 * 这样可以确保 localDb.ensureReady(userId) 已经完成才能用 SessionStorage。
 */

import { app, BrowserWindow } from 'electron';

import {
  Maker,
  ClaudeCodeAgent,
  CodexAgent,
  DEFAULT_AUTO_REVIEW_TIMEOUT_POLICY,
  configureDefaultImageResizer,
  type McpProvider,
} from '@cindy/maker-core';
import {
  getActiveCatalog,
  setActiveCatalogChangedListener,
  setDiscoveredCodexModels,
} from './active-catalog.js';
import {
  createCodexModelBackfillCoordinator,
  type CodexModelBackfillCoordinator,
} from './codex-model-backfill.js';
import {
  createOrcaWorkerBridgeMcpProvider,
  type OrcaBridgeMcpDeps,
} from '@cindy/orca-workflow';
import { LspServerPool } from '@cindy/mcps';

import { createMessage } from '../localDb/ipc/messages.js';
import {
  getWorkerLink,
  updateWorkerStatus,
} from '../localDb/orcaTeamStore.js';
import { cleanupSessionTempAttachments } from '../maker-ipc/normalizeAttachments.js';
import {
  markKnownOrcaWorkerSession,
} from '../maker-ipc/orcaManualInterrupt.js';
import { markOrcaMcpHydratedIfNeeded } from '../maker-ipc/orcaMcpHydrationCache.js';
import { preparePersistedOrcaSessionStart } from '../maker-ipc/orcaSessionStartOptions.js';
import type { MakerSessionCreateOpts } from '../maker-ipc/sessionRequest.js';
import { dispatchInterAgentMessage, isSessionInTurn, wireSessionToIpc } from '../maker-ipc/register.js';
import { MAKER_PUSH } from '../maker-ipc/channels.js';
import { tapWindowBroadcast } from '../device-link/broadcast-tap.js';
import { remoteInvoke } from '../device-link/index.js';
import { WorktreePool } from '../worktree/index.js';
import { getReadyBinaryPath, getCachedBinaryStatus } from '../agent-binaries/index.js';
import { activeOwnerScopeKey, isAppSessionBoundaryPending } from '../appSessionState.js';
import {
  desktopClaudeAuthAdapter,
  desktopCodexAuthAdapter,
  getCodexHome,
  readClaudeApiKey,
} from './auth-adapters.js';
import {
  desktopSessionStorage,
  readCodexHistoryHasProductPrompt,
  writeCodexHistoryHasProductPrompt,
} from './session-storage.js';
import { desktopMakerLogger } from './logger-adapter.js';
import { resolveSessionCcDebugFile } from '../logger.js';
import { resetProviderModelAutoRefreshCooldowns } from './provider-model-auto-refresh.js';
import { createSshDaemonTransport } from './codex-remote-transport.js';
import { getRemoteSshPool } from '../remote-ssh/index.js';
import {
  getRemoteAgentProxyEnv,
  reconcileCodexAgentProxyEnv,
} from '../remote-ssh/agent-proxy.js';
import { openCcManagerSession } from './cc-manager-client.js';
import { routeInjectedRemoteMcpApprovalsThroughCindy } from './remote-claude-permission-mode.js';
import { getRemoteClaudeBinaryPath } from '../remote-ssh/cc-manager-install.js';
import {
  createBashConcurrencyHooks,
  mergeClaudeHooks,
} from './claude-hooks/bash-concurrency-hook.js';
import { createReadImageHook } from './claude-hooks/read-image-hook.js';
import { readAgentResourceSettings } from './agent-resource-settings-store.js';
import { createCommandConcurrencyGate } from './command-concurrency-gate.js';
import {
  deriveAvailableModels,
  refreshCatalogDerivedModels,
  resolvePiRuntimeModelDescriptor,
  resolveVerifiedContextWindow,
} from './catalog-to-descriptors.js';
import { buildPiAgent } from './pi-host.js';
import { clearChatgptBridgeCredentialCache } from './anthropic-responses-bridge-host.js';
import {
  getDesktopSelectableCatalog,
  reloadActiveCatalogForEndpointChange,
  refreshDiscoveredCodexModels,
  setNativeProviderClaimListener,
} from './createDesktopProviderService.js';
import {
  clearAnthropicDiscoveredModels,
  setAnthropicDiscoveryFailureListener,
} from './model-discovery/anthropic.js';
import {
  buildDesktopClaudeRuntimeConfig,
  desktopCodexRuntimeConfig,
  ensureBundledRipgrepReady,
} from './runtime-configs.js';
import { getClaudeEndpoint, setClaudeProxyGatewayKeyReader, setClaudeProxyOAuthSpawnChecker } from './anthropic-compat-proxy-host.js';
import { resolveRemoteClaudeRoute } from './remote-claude-route.js';
import { claudeSubagentUsageBridge } from './claude-subagent-usage-bridge.js';
import { createAutoPermissionReviewer } from './auto-permission-reviewer.js';
import { requestUtilityText } from '../utility-model/oneShotCandidates.js';
import { accountProviderReadinessBarrier } from './account-provider-readiness-barrier.js';
import { hasClaudeAiOAuth } from './claude-credentials-store.js';
import {
  armCodexHttpRecovery,
  clearCodexProxyAuthInjection,
  ensureCodexControlPlaneProxyReady,
  ensureCodexProxyReady,
  getCodexControlPlaneProxyEndpoint,
  getCodexProxyAuthInjectionState,
  getCodexProxyEndpoint,
  getCodexThreadUpstreamOrigin,
  isCodexControlPlaneProxyHandleReady,
  isCodexProxyHandleReady,
  setCodexProxyAuthInjection,
  setCodexProxyGatewayKeyReader,
  registerComposed as registerCodexProxyComposed,
  registerChildThread as registerCodexProxyChildThread,
  unregister as unregisterCodexProxyPrompt,
} from './codex-proxy-host.js';
import { createDesktopMcpProviders } from '../mcp-integrations/mcp-providers.js';
import { getGhostRosterPrompt } from '../mcp-integrations/ghost.js';
import { readContactsSettings } from './contacts-settings-store.js';
import {
  captureKnownFileBefore,
  noteOpaqueTurnChange,
} from '../turn-change-set/store.js';

/**
 * 最近一次成功构建的 codex spawn 配置里, 通讯录开关的实际取值(null = 尚未
 * spawn 过)。codex 的 MCP flags 冻结在 cached spawn 配置且 app-server 跨会话
 * 长活 —— 开关切换后若失效失败(busy), running 实例仍是旧工具面; codex 的
 * getContactsPromptState 用这份快照识别该 stale 窗口, 避免 prompt 指挥模型调
 * stale 桥里不存在的工具。在 prepareCodexExtraSpawnConfig 内更新。
 */
let codexAppliedContactsEnabled: boolean | null = null;
import {
  registerCustomMcpArrays,
  refreshCustomMcpProviders,
  resetCustomMcpRegistry,
} from '../mcp-integrations/custom-mcp-registry.js';
import { cleanupComputerDriverSession } from '../mcp-integrations/computer.js';
import { createPluginRegistry, resetPluginRegistry } from './plugins/index.js';
import {
  getActiveCodexBridgeServerNames,
  getCodexExtraSpawnConfig,
  registerCodexMcpThreadContext,
  setCodexEnvironmentShutdownHook,
  unregisterCodexMcpThreadContext,
} from '../mcp-integrations/codexEnvironment.js';
import type { CodexHttpBridge } from '../mcp-integrations/codexHttpBridge.js';
import { setRemoteMcpBridgeTokenRotatedHook } from '../mcp-integrations/remoteMcpBridgeToken.js';
import { ensureRemoteMcpForward, setRemoteMcpForwardRearmedHook, stripRemoteCodexMcpConfig } from '../remote-ssh/codex-remote-mcp.js';
import {
  buildCcRemoteHttpMcpServers,
  CC_MCP_DISABLED_FINGERPRINT,
  readCcAppliedFingerprint,
  writeCcAppliedFingerprint,
} from './cc-remote-mcp.js';
import { getRemoteSessionStartEnsure, getRemoteCodexLiveTurnChecker, setRemoteCcTurnSettledHandler, setRemoteCcStaleQuery } from './remote-session-start-ensure.js';
import {
  refreshRemoteCodexMcpAfterBridgeRecreate,
  invalidateRemoteCcQueriesForMcpGenerationChange,
  maybeDetachStaleRemoteCcQuery,
} from './remote-codex-mcp-recovery.js';
import {
  CODEX_DISABLED_BUILTIN_PLUGIN_IDS_KEY,
  readDisabledBuiltinPluginIds,
} from '../mcp-integrations/codexBuiltinToolPolicy.js';
import { buildCodexProxySpawnArgs, CODEX_OPENAI_COMPACT_PROVIDER_ID } from './codex-gateway-config.js';
import {
  buildCodexSubagentSpawnArgs,
  resolveCodexSubagentModelFallback,
} from './codex-subagent-config.js';
import { readSubagentModelSettings } from './subagent-model-settings-store.js';
import {
  registerAgentProcess,
  registerCodexProcessRole,
} from '../process-monitor/codex-process-registry.js';
import { getOutboundPathSnapshotFor } from './outbound-proxy-resolver.js';
import {
  createDesktopMakerMemoryManager,
  attachAgentsToMakerMemory,
} from './maker-memory-host.js';
import { prepareExternalCodexSessionForResume } from './codex-local-sessions.js';
import { rehydrateCloseSuppression, withRehydrateCloseSuppressed } from './rehydrateCloseSuppression.js';
import { hydrateSessionProvider } from './session-provider-store.js';
import { prepareLocalCodexCredentialModeSwitch } from './codex-credential-switch.js';
import { createDesktopOrcaTeamStoreAdapter } from './orcaTeamStoreAdapter.js';
import { broadcastOrcaWorkerChanged } from './orcaWorkerBroadcast.js';
import {
  getDesktopClaudeReadOnlyAllowedTools,
  getDesktopMcpToolApprovalPolicy,
} from './mcp-tool-approval-policy.js';
import { mapCodexAppServerModelsToCatalog } from './codex-model-discovery.js';
import { prepareSharedProjectSkillLinks } from './shared-global-skills.js';
import {
  buildDesktopCapabilityRoutingPolicy,
  DESKTOP_CAPABILITY_ROUTING_POLICY,
} from './capability-routing.js';
import {
  prepareCodexBrowserCompanion,
  resolveCodexBrowserCompanionSpawnConfig,
} from './codex-browser-companion.js';
export { withRehydrateCloseSuppressed };

type RemoteCcQuery = Awaited<
  ReturnType<NonNullable<ConstructorParameters<typeof ClaudeCodeAgent>[0]['remoteCcQueryFactory']>>
>;

let _maker: Maker | null = null;

const reviewAutoPermissionAction = createAutoPermissionReviewer({
  logger: desktopMakerLogger,
  requestText: async (request, prompt) => {
    const maker = _maker;
    if (!maker) return null;
    const result = await requestUtilityText(maker, prompt, {
      providerId: request.providerId?.trim() || undefined,
      agentKind: request.agentKind,
      model: request.model,
      maxTokens: 384,
      timeoutMs: DEFAULT_AUTO_REVIEW_TIMEOUT_POLICY.requestTimeoutMs,
      reasoningEffort: 'low',
    });
    return result.ok ? result.text : null;
  },
});

/**
 * Codex 模型补拉 coordinator —— 随 maker 一起创建(需要 maker 实例做 live 拉取)、随
 * resetMaker 一起作废(它闭包捕获了那个 maker,换账号后绝不能再对旧实例发拉取请求)。
 * null = maker 尚未构造:那时既没有 agent 也没有会话,没有任何东西在等模型清单。
 */
let _codexModelBackfill: CodexModelBackfillCoordinator | null = null;

/** Refresh selectable model capabilities, then notify every local/remote renderer. */
function refreshSelectableModelsAndBroadcast(payload: Record<string, unknown>): void {
  if (_maker) refreshCatalogDerivedModels(_maker, getDesktopSelectableCatalog());
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    try {
      win.webContents.send(MAKER_PUSH.PROVIDER_CHANGED, payload);
    } catch {
      // Window teardown may race the broadcast; other windows still receive it.
    }
  }
  tapWindowBroadcast(MAKER_PUSH.PROVIDER_CHANGED, payload);
}

/**
 * active catalog 的唯一 desktop 收口：先原地刷新两种 agent 的 capabilities，
 * 再广播同一 revision。这样 provider 列表先变而 backend 仍校验旧模型的窗口不会出现。
 */
setActiveCatalogChangedListener((revision) => {
  try {
    refreshSelectableModelsAndBroadcast({ revision });
  } catch (error) {
    desktopMakerLogger.warn('active catalog capabilities refresh failed', {
      revision,
      error: error instanceof Error ? error.message : String(error),
    });
    return;
  }
});

/**
 * anthropic 清单发现的失败态变化 → 广播 PROVIDER_CHANGED。
 *
 * 归因不进 active catalog(清单没变,没有 revision 可言),但 renderer 往往在拉取失败
 * **之前**就取走了 provider 快照(15s 超时那条路径尤其明显)。不主动通知,设置页会一直
 * 停在「正在发现」而不是讲明失败理由(PR #548 review)。
 */
setAnthropicDiscoveryFailureListener(() => {
  try {
    // 复用既有的「刷 capabilities + 广播」收口:清单确实没变,这一步只是把 provider
    // 快照重新推给 renderer,让它重取带上失败归因的 listProviders。
    refreshSelectableModelsAndBroadcast({});
  } catch (error) {
    desktopMakerLogger.warn('anthropic discovery failure broadcast failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

/**
 * 本机凭证绑定自愈成功 → 广播 PROVIDER_CHANGED。
 *
 * 连接态刚从 false 翻成 true，但只有触发那次读取的调用方拿到了新快照。其它窗口留在
 * 「未连接」，配对的手机 / 控制端更是只认这条推送来失效缓存（PR #548 review）。
 * anthropic 那条链路碰巧能在清单变化时顺带广播，xAI 则完全没有出口 —— 统一在这里补。
 */
setNativeProviderClaimListener(() => {
  resetProviderModelAutoRefreshCooldowns();
  try {
    refreshSelectableModelsAndBroadcast({});
  } catch (error) {
    desktopMakerLogger.warn('native provider claim broadcast failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

/** Re-project provider/model availability after the Cindy auth session changes. */
export function refreshProviderAccessAfterAuthChange(): void {
  resetProviderModelAutoRefreshCooldowns();
  void reloadActiveCatalogForEndpointChange()
    .then(() => {
      refreshSelectableModelsAndBroadcast({});
    })
    .catch((error) => {
      desktopMakerLogger.warn('provider catalog reload after auth realm change failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  try {
    refreshSelectableModelsAndBroadcast({});
  } catch (error) {
    desktopMakerLogger.warn('provider access refresh after auth change failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
/**
 * codexAgent 的模块级引用 —— 仅供 restartCodexAfterAuthModeChange() 在 API 模式切换 /
 * api_key 变更时 dispose 重建 app-server。getMaker() 构造后回填,resetMaker() 清空。
 */
let _codexAgent: CodexAgent | null = null;
/**
 * codexMcpProviders 的模块级引用 —— 供 ensureCodexMcpBridgeStartedForRemote()
 * 在远端 daemon MCP 注入链路里懒启动 bridge 时取用。getMaker() 构造后回填。
 */
let _codexMcpProviders: McpProvider[] | null = null;
/**
 * 本进程已对哪些 cc session 做过 bridge MCP 的强制 fresh start。bridge 是
 * 进程内存态, 随 app 重启清空 — 重启后首轮注入重新强制 fresh; SSH 断线
 * 重连 (bridge 表还在) 不重复 kill。见 remoteCcQueryFactory 注释。
 */
const forcedFreshCcBridgeSessions = new Set<string>();
/**
 * 被 invalidate 判定为「MCP 代际已过期」的远端 CC session (bridge 重建 /
 * 端口重绑 / bridge shutdown / collab 禁用)。下次 lazy-resume 重建时无论
 * 本次能否注入都必须 forceFresh kill 旧 query — 否则 attach 回带旧 URL
 * 的 query (codex-connector R22 P2)。open 成功后从集合移除。
 */
const staleInvalidatedCcSessions = new Set<string>();
/**
 * 本进程见过的 bridge 实例 — ensureCodexMcpBridgeStartedForRemote 据此检测
 * bridge 重建并清空 forcedFreshCcBridgeSessions (旧 bridge 的
 * mcp-session-id 随重建全部失效)。
 */
let _lastBridgeForForcedFresh: CodexHttpBridge | null = null;
/** getMaker() 首次构造时发起的自定义 MCP 初始加载 promise，供 bootstrap 在注册会话 IPC 前 await。 */
let _initialCustomMcpRefresh: Promise<void> | undefined;
type CodexLocalCredentialChangeGuard = Awaited<ReturnType<CodexAgent['beginLocalHostCredentialChange']>>;
let _codexCredentialChangeGuard: CodexLocalCredentialChangeGuard | null = null;

/**
 * 本地 Codex 会话加入 shared host 前的回调(maker-ipc 注入,见
 * DeferredCodexRestartService.flushBeforeLocalCodexSessionStart):延迟记忆重启
 * pending 时先尝试兑现,让新会话直接在新状态的 fresh host 上起跑。依赖方向:
 * maker-ipc → maker-host,故用 setter 注入而非反向 import。回调自身不抛错、
 * busy 时立即返回,不会卡住会话创建。
 */
let _beforeLocalCodexSessionStartHook: (() => Promise<void>) | null = null;
export function setBeforeLocalCodexSessionStartHook(hook: (() => Promise<void>) | null): void {
  _beforeLocalCodexSessionStartHook = hook;
}

/**
 * detach 某 host 上活跃的远端 codex session (跳过 turn 中的)。
 * 使用点:daemon 被 (重) bootstrap 后 (bridge 重建恢复 / shutdown strip) —
 * 旧 transport 已死, detach 让下次 send 走 lazy-resume 重建
 * (codex-connector R26 P1)。
 */
function detachActiveRemoteCodexSessions(hostId: string, reason: string): void {
  for (const s of _maker?.listActiveSessions() ?? []) {
    if (s.agentKind !== 'codex' || s.remoteHostId !== hostId) continue;
    if (s.isTurnRunning()) continue;
    void s.detach().catch((err) => {
      desktopMakerLogger.warn('remote codex session detach after daemon rebootstrap failed', {
        sessionId: s.id,
        hostId,
        reason,
        message: err instanceof Error ? err.message : String(err),
      });
    });
  }
}

/**
 * bridge 重建 / forward 端口重绑后的远端 CC query 失效 (装配版)。
 * fresh 标记无条件删 (下次注入重新 forceFresh);无 turn 的直接 detach,
 * 有 turn 的由 turn-done holder 补 detach — 不打断进行中的 turn。
 */
function invalidateActiveRemoteCcQueries(opts: { hostId?: string; reason: string }): void {
  invalidateRemoteCcQueriesForMcpGenerationChange(
    {
      listRemoteCcSessions: () =>
        (_maker?.listActiveSessions() ?? []).filter((s) => s.agentKind === 'claude-code'),
      // invalidate 的语义是「该 query 的 MCP 代际已过期」— 除清 fresh 标记
      // 外记入 stale 集合:下次重建 (lazy-resume) 无论本次是否注入 (例如
      // collab 已禁用 → 无 server 可注) 都必须 forceFresh kill 旧 query,
      // 否则 attach 回带旧 collab URL 的 query (codex-connector R22 P2)。
      clearFreshMark: (sessionId) => {
        forcedFreshCcBridgeSessions.delete(sessionId);
        staleInvalidatedCcSessions.add(sessionId);
      },
      log: desktopMakerLogger,
    },
    opts,
  );
}

/**
 * bridge shutdown 时的远端即时失效 (codex-connector R21 P1):插件/全局
 * 设置变更触发 shutdownCodexEnvironment 后, 远端 session 的 MCP URL /
 * session id 都指向已停 bridge — 等 lazy 重建会让窗口期内 send 持续
 * 404 / connection-refused。这里立刻:
 *   - 远端 CC:fresh 失效 + 无 turn query detach (下次 send 触发 lazy
 *     重建并重注入, 全链路自愈);
 *   - 远端 codex:逐 host strip 受管段 + 清 daemon env (404 MCP 当场降级
 *     为无 MCP);lazy 重建后恢复遍历重新注入。
 * 挂在 shutdownCodexEnvironment 的各调用点 (hook-control / 账号切换)。
 */
export function handleCodexEnvironmentShutdownForRemote(): void {
  invalidateActiveRemoteCcQueries({ reason: 'bridge-shutdown' });
  const hostIds = new Set<string>();
  for (const s of _maker?.listActiveSessions() ?? []) {
    if (s.remoteHostId && s.agentKind === 'codex') hostIds.add(s.remoteHostId);
  }
  const liveTurnChecker = getRemoteCodexLiveTurnChecker();
  for (const hostId of hostIds) {
    const host = getRemoteSshPool().get(hostId);
    if (host?.getStatus() !== 'ready') continue;
    void stripRemoteCodexMcpConfig(host, {
      hasLiveTurnOnHost: liveTurnChecker ?? undefined,
    })
      .then((result) => {
        if (!result.daemonRebootstrapped) return;
        // strip 的 bootstrap (清 env 重启 daemon) 同样杀死旧 transport —
        // live-turn 豁免内已在 strip 里跳过, 这里 detach 剩余活跃 session
        // (codex-connector R26 P1 同源)。
        detachActiveRemoteCodexSessions(hostId, 'bridge-shutdown-strip');
      })
      .catch((err) => {
        desktopMakerLogger.warn('remote codex MCP strip on bridge shutdown failed', {
          hostId,
          error: err instanceof Error ? err.message : String(err),
        });
      });
  }
}

/**
 * 远端 codex daemon / cc query 经 SSH remote-forward 直连本机 MCP bridge 的
 * 注入链路 (remote-ssh/codex-remote-mcp.ts、cc-remote-mcp 调用) 调用:确保
 * HTTP bridge 已启动并返回端口、server 名单与 bridge 实例 (per-session
 * token 注册需要)。与 prepareCodexExtraSpawnConfig 共用
 * getCodexExtraSpawnConfig 的 lazy+cached 单例,不重复起 server;providers
 * 未装配或 bridge 启动失败时返回 null (调用方按"远端无 MCP"降级放行 session)。
 */
export async function ensureCodexMcpBridgeStartedForRemote(): Promise<{
  port: number;
  serverNames: string[];
  bridgeInstanceId: string;
  bridge: CodexHttpBridge;
} | null> {
  if (!_codexMcpProviders) return null;
  try {
    const cfg = await getCodexExtraSpawnConfig({
      mcpProviders: _codexMcpProviders,
      logger: desktopMakerLogger,
    });
    if (!cfg.bridge) return null;
    if (cfg.bridge !== _lastBridgeForForcedFresh) {
      // bridge 重建 (custom MCP CRUD / 全局插件开关触发
      // shutdownCodexEnvironment 后的 lazy 重建):旧 bridge 的
      // mcp-session-id 全部失效, 之前 fresh 过的 session 必须重新
      // forceFresh — 否则 reconnect attach 回持旧 id 的 query, 协同 MCP
      // 404 (review P2 回归)。首次调用 (null → 实例) 也走这里, 对空 Set
      // clear 无害。
      forcedFreshCcBridgeSessions.clear();
      const isRecreate = _lastBridgeForForcedFresh !== null;
      _lastBridgeForForcedFresh = cfg.bridge;
      if (isRecreate) {
        // 远端 codex 侧同步恢复:session 的 SSH forward 仍指旧 bridge 端口、
        // daemon 持旧 MCP session — 对活跃 remote codex host 补一次
        // best-effort ensure 全链路自愈 (codex-connector R18 P1)。
        refreshRemoteCodexMcpAfterBridgeRecreate({
          listRemoteCodexHostIds: () => {
            const ids = new Set<string>();
            for (const s of _maker?.listActiveSessions() ?? []) {
              if (s.remoteHostId && s.agentKind === 'codex') ids.add(s.remoteHostId);
            }
            return [...ids];
          },
          getReadyHost: (hostId) => {
            const host = getRemoteSshPool().get(hostId);
            return host?.getStatus() === 'ready' ? host : null;
          },
          ensureBridgeStarted: ensureCodexMcpBridgeStartedForRemote,
          getLiveTurnChecker: getRemoteCodexLiveTurnChecker,
          // 恢复路径同闸门 (codex-connector R21 P1):collab 全局禁用时
          // ensure 走清理而非重注入。
          isCollabEnabled: () => getPluginRegistry().isEnabled('collab'),
          // Maker Memory 同源闸门:开着时补刀不得把 cindy_memory 剥掉。
          isMakerMemoryEnabled: () => _maker?.makerMemory?.isEnabled() ?? false,
          detachRemoteCodexSessionsOnHost: (hostId) =>
            detachActiveRemoteCodexSessions(hostId, 'bridge-recreate-rebootstrap'),
          log: desktopMakerLogger,
        });
        // 远端 CC 侧同源恢复 (codex-connector R19 P2):活跃 query 持旧
        // bridge 的 mcpServers URL / mcp-session-id — fresh 标记失效 +
        // 无 turn 的 detach (下次 send 重新注入);有 turn 的只删标记,
        // turn-done 经 maybeDetachStaleRemoteCcQuery 补 detach。
        invalidateActiveRemoteCcQueries({ reason: 'bridge-recreate' });
      }
    }
    return {
      port: cfg.bridge.port,
      serverNames: cfg.bridgeServerNames,
      bridgeInstanceId: cfg.bridge.instanceId,
      bridge: cfg.bridge,
    };
  } catch (err) {
    desktopMakerLogger.error('ensureCodexMcpBridgeStartedForRemote failed', {
      message: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

export async function readCodexRuntimeRoute(): Promise<{
  authInjection: 'oauth-bearer' | 'env-key' | 'provider-oauth';
}> {
  // spawn 冻结态优先;未 spawn 时按当前 OAuth 登录态合成(连了 = oauth-bearer,否则 env-key)。
  // 退役全局 authMode 后,codex spawn 凭证形态只取决于「有无 Codex OAuth 登录」。
  const frozenAuthInjection = getCodexProxyAuthInjectionState();
  if (frozenAuthInjection) {
    return { authInjection: frozenAuthInjection };
  }
  const hasOAuth = await desktopCodexAuthAdapter.hasCodexOAuthLogin().catch(() => false);
  return { authInjection: hasOAuth ? 'oauth-bearer' : 'env-key' };
}

async function broadcastCodexRuntimeRoute(): Promise<void> {
  const payload = await readCodexRuntimeRoute();
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    try {
      win.webContents.send(MAKER_PUSH.CODEX_RUNTIME_ROUTE_CHANGED, payload);
    } catch {
      // Best-effort UI refresh only.
    }
  }
}

// Lazy: bootstrap-electron 在 app.whenReady 前调 app.setPath('userData') 切到 dev 隔离目录,
// 但 import 是 hoist 到顶的, eager `new LspServerPool({ userDataPath: app.getPath('userData') })`
// 会拿到 setPath 之前的老路径。lazy 拖到首次使用(已过 setPath)再读路径。
let lspPool: LspServerPool | null = null;

function getLspPool(): LspServerPool {
  lspPool ??= new LspServerPool({
    userDataPath: app.getPath('userData'),
    logger: desktopMakerLogger.child('lsp-pool'),
  });
  return lspPool;
}

/** Get the plugin registry singleton (delegates to plugins/index.ts module-level cache). */
export function getPluginRegistry() {
  return createPluginRegistry();
}

/**
 * 获取 Maker 单例。第一次调用时构造（要求 localDb 已 ensureReady, 且 splash
 * 阶段已完成 claude/codex binary provisioning —— 否则 binaryPath 拿不到, 直接抛错）。
 *
 * MCP 由 @cindy/mcps 包提供 server/tool 定义，desktop main 在这里注入 token、
 * OAuth、缓存、bot 发送等宿主能力，再交给 maker-core 的 ClaudeCodeAgent。
 */
export function getMaker(): Maker {
  if (!_maker) {
    // splash 已经 prepare 过, 这里只是同步读 cache 路径; 任一缺失说明 bootstrap
    // 顺序错了, 早抛比 session.start 时再炸更清晰。
    // splash 已经 prepare 过, 这里只是同步读 cache 路径; 任一缺失说明 bootstrap
    // 顺序错了, 早抛比 session.start 时再炸更清晰。
    const claudePath = getReadyBinaryPath('claude-code');
    if (!claudePath) {
      throw new Error('getMaker: Claude binary not provisioned (bootstrap must run agent-binaries.prepare("claude-code") before getMaker)');
    }
    const codexPath = getCachedBinaryStatus('codex').binaryPath;
    if (!codexPath) {
      throw new Error('getMaker: Codex binary not provisioned (bootstrap must run agent-binaries.prepare("codex") before getMaker)');
    }
    // bundled ripgrep 检查与上面 claude/codex 二进制同层:真正的启动期 fail-fast
    // 在 splash check-environment(Phase 2.5,缺 rg 时 splash 进失败态可重试);
    // 这里是防御性断言 —— 走到本函数说明 bootstrap 已完成环境检查,缺 rg 即顺序
    // 错误,早抛比 spawn 时再炸清晰(throw 会被 bootstrap 的 register catch 兜住
    // 并留 ERROR 日志,与 claude/codex 缺失的处理一致)。
    ensureBundledRipgrepReady();

    // 图片送进模型前的 last-mile resize (省 vision token)。host 注入 logger
    // 让 sharp 失败 / 超时 / LRU 淘汰等告警进项目日志, 而不是默默丢黑洞。
    // 阈值/缓存策略走 image-resizer.ts 的默认 (1568px / WebP q=85 / ≤500KB
    // 跳过 / 200MB 全局 LRU / 并发 2 / 5s 超时)。
    configureDefaultImageResizer({
      logger: desktopMakerLogger.child('image-resizer'),
    });

    // Maker Memory manager — 先建 (agents={}), agents 创建后再 attach。
    // sqliteFactory + basePath 在工厂内部用 Electron API 准备好, maker-core 拿不到。
    const makerMemoryManager = createDesktopMakerMemoryManager();

    // Plugin registry — 先于 agent 构造, 让 createDesktopMcpProviders 拿 registry
    // 包进每个 MCP provider 的 isEnabled 闭包里。registry 内部读 <userData>/plugin-prefs.json
    // 和项目 .claude/settings.json, mtime-based 缓存, 只在 session start 时同步检查。
    const pluginRegistry = createPluginRegistry();

    const makerMemoryProviderDeps = {
      getMakerMemoryManager: () => makerMemoryManager,
      lspPool: getLspPool(),
      pluginRegistry,
      invokeRemote: remoteInvoke,
      // 只读活跃 Session 的运行时真相。权限切换是 runtime-first、DB-second，
      // 因此插件过户自动放行不得回退 sessions.permission_mode；会话不再 active
      // 时同样 fail closed。闭包在 MCP tool-call 时执行，此时 _maker 已装配完成。
      getLiveSessionGrantState: (sessionId: string, sessionInstanceId: string) => {
        if (!sessionInstanceId) return null;
        const session = _maker?.getSession(sessionId);
        if (!session || session.instanceId !== sessionInstanceId) return null;
        const permission = session.stablePermissionModeState;
        if (!permission) return null;
        return {
          permissionMode: permission.mode,
          remoteHostId: session.remoteHostId,
        };
      },
    };
    const orcaTeamStoreAdapter = createDesktopOrcaTeamStoreAdapter({
      getWorkerLink,
      updateWorkerStatus,
      markKnownOrcaWorkerSession,
      broadcastOrcaWorkerChanged,
      logger: desktopMakerLogger,
    });
    // bridge shutdown 后的远端失效统一折进 shutdownCodexEnvironment 内部
    // (codex-connector R22 P1):插件开关 / custom MCP CRUD / contacts /
    // Slack provider / 账号切换等所有 shutdown 路径自动覆盖, 不靠逐点调用。
    setCodexEnvironmentShutdownHook(handleCodexEnvironmentShutdownForRemote);
    // bridge token 轮换 (账号切换 secrets 清空) 时同步失效远端 CC query —
    // 旧 Authorization header 在新 bridge 上持续 401;独立于 shutdown 路径
    // (本地 turn 忙时 shutdown 会被跳过, codex-connector R24 P2)。
    setRemoteMcpBridgeTokenRotatedHook(() => {
      invalidateActiveRemoteCcQueries({ reason: 'bridge-token-rotated' });
    });
    // forward 端口重绑 (SSH 重连 onRearmed) 时, 该 host 上活跃远端 CC
    // query 的 mcpServers URL 还指旧端口 — fresh 失效 + detach 促重建
    // (codex-connector R19 P2)。
    setRemoteMcpForwardRearmedHook((hostId, remotePort) => {
      desktopMakerLogger.info('remote MCP forward re-armed — invalidating remote CC queries on host', {
        hostId,
        remotePort,
      });
      invalidateActiveRemoteCcQueries({ hostId, reason: 'forward-rearmed' });
    });
    // register.ts 的 turn 收口经 holder 回调:远端 CC 的 fresh 已失效且
    // 无 turn 时 detach 旧 query (bridge 重建 / 端口重绑的补刀路径)。
    setRemoteCcStaleQuery((sessionId) => staleInvalidatedCcSessions.has(sessionId));
    setRemoteCcTurnSettledHandler((sessionId) => {
      maybeDetachStaleRemoteCcQuery(
        {
          getSession: (id) => {
            const s = _maker?.getSession(id);
            return s && s.agentKind === 'claude-code' ? s : null;
          },
          hasStaleMark: (id) => staleInvalidatedCcSessions.has(id),
          log: desktopMakerLogger,
        },
        sessionId,
      );
    });
    const orcaBridgeDeps = {
      getMaker: () => {
        if (!_maker) throw new Error('maker not initialized');
        return _maker;
      },
      logger: desktopMakerLogger,
      persistUserMessage: (sessionId: string, message: { clientId: string; content: string }) =>
        createMessage(sessionId, {
          clientId: message.clientId,
          role: 'user',
          content: message.content,
        }).then(() => undefined),
      wireSession: wireSessionToIpc,
      hydrateSessionRoute: (sessionId: string, providerId: string | null) =>
        hydrateSessionProvider(sessionId, providerId),
      // bridge rehydrate remote lead/worker 时经 holder 调 register.ts 的
      // ensureRemoteReadyForSessionStart (SSH 重连 / agent install / codex
      // MCP 注入) — 与 IPC create/send 路径同一 preflight。holder 在 IPC
      // 注册时填入 (晚于本 deps 构造, 早于任何 bridge 回调)。
      ensureRemoteSessionStart: async (params) => {
        // ensure 会在 createOpts 上就地归一化 makerMemoryEnabled (全局设置
        // backfill + stale-bridge 钳制) — 这里是临时对象, 必须把结果读回
        // 交给 bridge 的真实 createSession (review R6 P2)。
        const createOpts: { id: string; agentKind: typeof params.agentKind; remoteHostId: string; makerMemoryEnabled?: boolean } = {
          id: params.sessionId,
          agentKind: params.agentKind,
          remoteHostId: params.remoteHostId,
        };
        await getRemoteSessionStartEnsure()?.({ createOpts });
        return { makerMemoryEnabled: createOpts.makerMemoryEnabled === true };
      },
      orcaTeamStore: orcaTeamStoreAdapter,
      dispatchInterAgentMessage,
    } satisfies OrcaBridgeMcpDeps;
    const orcaWorkerBridgeProvider = createOrcaWorkerBridgeMcpProvider(orcaBridgeDeps);

    // logger 不 pre-child agent kind —— agent 内部会自己 child(this.kind),
    // host 这里再 child 一次会变成 maker/claude-code/claude-code。
    // endpoint 走 getter 注入: 每次 startSession() 时 env-builder 读 runtimeConfig.endpoint
    // 都会调用 getClaudeEndpoint() 拿当时最新的 proxy 就绪状态 —— proxy 在 splash 期异步起,
    // 就绪后新建 session 自动用上 loopback, 不需要重启 app / 重置 Maker 单例。
    //   proxy ready → loopback URL(请求经 proxy 做路由 + 字段适配)
    //   proxy 没起   → 真上游 + 日志(fail-open 兜底)
    // 'oauth' 模式下 provider 路由模型(gpt/deepseek/...)要把 OAuth bearer 换成 gateway key
    // 再转 gateway —— 这把 key 不进子进程 env(R4),由本地 proxy 旁路读取。注入 reader,
    // 与 codex setCodexProxyGatewayKeyReader 同源(都用 readClaudeApiKey 读那把 XD gateway key)。
    setClaudeProxyGatewayKeyReader(readClaudeApiKey);
    // cc spawn 凭证形态(oauth-spawn vs gateway-spawn)由「是否连了 Claude.ai 订阅」决定;
    // proxy 的默认路由据此分流(oauth-spawn 默认换网关 key、gateway-spawn passthrough)。live 读。
    setClaudeProxyOAuthSpawnChecker(hasClaudeAiOAuth);
    // 两个 agent 各自持有一份 mcpProviders 数组(内置 lizi + orca bridge)。用户自定义 MCP
    // 由 custom-mcp-registry 在启动 + 每次 CRUD 后**原地追加/刷新**到这两个数组末尾,
    // 因此这里必须用具名 const 保住引用(不能内联 spread 出临时数组)。
    const claudeMcpProviders = [
      ...createDesktopMcpProviders(makerMemoryProviderDeps),
      orcaWorkerBridgeProvider,
    ];
    // agent Bash 命令的全局并发闸门(跨所有本地 cc session / worker / subagent 共享)。
    // 上限每次准入判断现读设置文件,热更即刻生效;默认 0 = 不限 = 不排队。
    const commandConcurrencyGate = createCommandConcurrencyGate({
      readMaxConcurrent: () => readAgentResourceSettings().maxConcurrentCommands,
      log: desktopMakerLogger.child('command-gate'),
    });
    const claudeAgent = new ClaudeCodeAgent({
      auth: desktopClaudeAuthAdapter,
      runtimeConfig: buildDesktopClaudeRuntimeConfig(getClaudeEndpoint),
      binaryPath: claudePath,
      logger: desktopMakerLogger,
      turnChangeCapture: {
        beforeKnownFileWrite: captureKnownFileBefore,
        noteOpaqueWrite: noteOpaqueTurnChange,
      },
      registerLocalAgentProcess: ({ pid, kind, role }) =>
        registerAgentProcess(pid, kind, role),
      reviewAutoPermissionAction,
      // 每个 session 的 cc 子进程 debug 写到 sessions/<id>/cc-debug.raw.log (logger 拼路径
      // + mkdir), tailer 再归一化汇入该 session 的 <date>.ndjson。
      resolveCcDebugFile: resolveSessionCcDebugFile,
      mcpProviders: claudeMcpProviders,
      capabilityRouting: DESKTOP_CAPABILITY_ROUTING_POLICY,
      makerMemory: makerMemoryManager,
      // 智能通讯录 prompt 段的「本会话有效状态」: 与 mcp-providers.ts 的 provider
      // 包装同一判定链(PluginRegistry 工作区/用户覆盖 → 全局开关), 保证工具面与
      // prompt 不分叉; agent 侧对 enabled 还会与实际注册的 server 集合取交。
      getContactsPromptState: ({ workingDir }) => {
        if (!getPluginRegistry().isEnabled('contacts', workingDir)) return 'unavailable';
        return readContactsSettings().enabled ? 'enabled' : 'disabled';
      },
      getGhostRosterPrompt,
      // 第一方只读工具走 SDK allowedTools, 避免 auto 模式为 discovery/read-only
      // 操作额外调用远程安全分类器; 列表按精确工具名维护, 不放行动态 call_tool。
      claudeAllowedTools: getDesktopClaudeReadOnlyAllowedTools(),
      // MCP 工具审批与 Codex 共用同一份策略(mcp-tool-approval-policy.ts)。没有这一
      // 行时, Claude 只剩上面那份静态只读白名单, 可信第一方 server 的 call_tool
      // (浏览器自动化等高频入口)会逐次弹窗, 与 Codex 侧的静默执行行为分叉。
      getMcpToolApprovalPolicy: getDesktopMcpToolApprovalPolicy,
      // 模型清单 SSoT = 目录（providers.json，OSS 运行时真源 / bundled 兜底）。maker-core 的
      // CLAUDE_MODELS 已删、availableModels 起始为空；host 从账号可选目录派生 cc 列表注入
      // （含 claude 订阅模型 + XD 网关路由的 gpt / 国产 / gemini 等）。active catalog 已在 splash 期
      // ensureActiveCatalogLoaded 加载完成（早于本构造点）。详见 catalog-to-descriptors.ts。
      capabilityAdditions: {
        availableModels: deriveAvailableModels(getDesktopSelectableCatalog(), 'claude-code'),
      },
      // SDK PreToolUse / PostToolUse 等 in-process hook 注入点。host 自己定义 hook
      // 实现 (./claude-hooks/*.ts), maker-core 不感知具体逻辑。
      //
      // 当前 hook:
      //   - read-image-hook: agent 自主 Read 本地图片时, 透明把原图缩成 vision-friendly
      //     WebP 副本, 把 Read 的 file_path 改写到副本路径再交给 SDK (原图不动).
      //     解决 agent 自主 Read 大图把 vision context 撑爆的问题 (用户附图那条路本来
      //     就走压缩, 但 agent 自己调 Read 绕过了).
      //   - bash-concurrency-hooks: agent Bash 命令的全局并发闸门(跨 session)。
      //     PreToolUse 满员挂起排队, Post/Failure/Denied/SessionEnd 释放;
      //     maxConcurrentCommands 默认 0 = 不限 = 行为与无此 hook 时一致。
      //   (slack-empty-cursor-hook 已随 slack-official MCP 集成退役 2026-07-15:
      //    它只认老集成的 mcp__slack__* 工具名;空 cursor 清洗移入 cindy-slack
      //    意识的 slack_call_tool。)
      claudeHooks: mergeClaudeHooks(
        {
          PreToolUse: [
            {
              matcher: 'Read',
              hooks: [createReadImageHook(desktopMakerLogger)],
            },
          ],
        },
        createBashConcurrencyHooks(commandConcurrencyGate, desktopMakerLogger),
      ),
      registerClaudeSubagentTask: (task) => claudeSubagentUsageBridge.registerTask(task),
      getClaudeSubagentTaskUsage: (taskId) => claudeSubagentUsageBridge.getTaskUsage(taskId),
      // 远端 Claude 会话的路由 materialization:把该会话真实上游 + 鉴权 + 定制头解析成 cc
      // env(native OAuth 订阅 / 自定义 Claude Code 供应商),覆盖「远端恒用网关」旧行为。
      // 返回 null = 有效路由是 XD 网关,maker-core 维持既有网关远端路径。见 remote-claude-route.ts。
      resolveRemoteClaudeRoute,
      // Phase 4.3: 远端 cc 路由 — 当 session 标了 remoteHostId, ClaudeCodeAgent
      // 调这个 factory 拿一个连远端 cc-mgr daemon 的 Query (替代本地 sdkQuery
      // 起 cc 子进程)。详见 packages/maker-core/src/agents/base-agent.ts 的
      // AgentDeps.remoteCcQueryFactory 文档。
      //
      // RemoteQuery 实现 SDK Query interface 的子集 (ClaudeCodeAgent 实际只调
      // for-await / interrupt / setModel / setPermissionMode / applyFlagSettings),
      // factory 返回时直接 `as unknown as Query` cast 即可。
      remoteCcQueryFactory: async ({ remoteHostId, sessionId, sessionInstanceId, startParams, vendorOptions, onApprovalRequest, onOAuthRefresh, makerMemoryEnabled }) => {
        const host = getRemoteSshPool().get(remoteHostId);
        if (host?.getStatus() !== 'ready') {
          throw new Error(`remote ssh host not ready: ${remoteHostId}`);
        }
        // 「Agent 流量走本地 Proxy」: pref 开启时确保 SSH 反向隧道就绪, 把代理
        // env 合入 startParams.env — cc-mgr daemon 按 session spawn SDK, 每次
        // 会话都吃到当前配置, 无需像 codex daemon 那样重启。隧道 arm 失败
        // (sshd 拒 remote forwarding 等) 直接抛错, 不静默回落直连。
        const proxyEnv = await getRemoteAgentProxyEnv(host);
        // SDK can't self-locate its native CLI binary on remote (bundled-into-cc-mgr
        // optional-dep resolver is frozen to desktop build platform). Probe + cache
        // the path here and pass it down; cc-manager-client merges it into the SDK
        // options via `pathToClaudeCodeExecutable`. First call ~200ms, cache hit instant.
        const claudeBinaryPath = await getRemoteClaudeBinaryPath(host);

        // 远端 cc 的协同 MCP 恢复通道:bridge + remote-forward + per-session
        // token,把 cindy_orca / orca_worker_bridge 以 http 形态追加进
        // startParams.mcpServers (cc remote 过滤器本来就放行 http transport)。
        // 注入失败降级为"远端无协同 MCP"(历史行为),不阻塞 session 建立。
        let mcpCleanup: () => void = () => {};
        let injectedServerCount = 0;
        let mcpNeedsFreshStart = false;
        let mcpInjectFingerprint: string | undefined;
        try {
          const injected = await buildCcRemoteHttpMcpServers(
            {
              host,
              sessionId,
              sessionInstanceId,
              workingDir: typeof startParams.cwd === 'string' ? startParams.cwd : '',
              vendorOptions,
              // per-session Maker Memory 开关 (maker-core 归一后透传)。
              makerMemoryEnabled,
            },
            {
              ensureBridgeStarted: ensureCodexMcpBridgeStartedForRemote,
              ensureForward: ensureRemoteMcpForward,
              // collab 全局禁用 (Tier 4) 时整个不注入 — bridge 名单不反映
              // 开关 (codex-connector R20 P2, 与 codex daemon 侧同闸门)。
              isCollabEnabled: () => pluginRegistry.isEnabled('collab'),
            },
          );
          mcpCleanup = injected.cleanup;
          mcpNeedsFreshStart = injected.needsFreshStart === true;
          mcpInjectFingerprint = injected.fingerprint;
          if (Object.keys(injected.servers).length > 0) {
            injectedServerCount = Object.keys(injected.servers).length;
            const mutableParams = startParams as { mcpServers?: Record<string, unknown> };
            mutableParams.mcpServers = { ...(mutableParams.mcpServers ?? {}), ...injected.servers };
          }
        } catch (err) {
          desktopMakerLogger.warn('cc remote MCP injection skipped', {
            remoteHostId,
            sessionId,
            message: err instanceof Error ? err.message : String(err),
          });
        }

        // maker-core computes the initial permission mode before this factory
        // injects collaboration MCP servers. Native OAuth Auto bypasses the
        // approval RPC entirely, so finalize the mode after injection but
        // before openCcManagerSession consumes startParams.
        routeInjectedRemoteMcpApprovalsThroughCindy(startParams, injectedServerCount);

        // app 重启后首轮 bridge MCP 注入:daemon 侧旧 query 若还 alive, 其
        // SDK 持有的 mcp-session-id 在新 bridge 已不存在, attach 会让协同
        // MCP 每次调用 404 且 SDK 不自动重新 initialize。本进程首次注入该
        // session 时强制 fresh start (startParams 带 resumeSdkSessionId,
        // 上下文经远端 cc CLI session 文件恢复)。SSH 断线重连 (app 未重启,
        // bridge 内存表还在) 不触发 — 本 Set 随进程生命周期。
        // 状态只在 open 成功后提交:open 失败 (daemon 未起等) 时下次重试
        // 仍要 forceFresh, 否则 attach 到旧 query 上协同 MCP 永久 404。
        // token 失效 (mcpNeedsFreshStart) 同样强制 fresh:attach 回带旧
        // token header 的 alive query 会持续 401 (codex-connector R21 P2)。
        // 被 invalidate 过 (staleInvalidatedCcSessions) 也一样:collab 禁用
        // 等场景重建时无 server 可注, 不 forceFresh 会 attach 回带旧 collab
        // URL 的 query (codex-connector R22 P2)。
        // 持久代际指纹 drift (codex-connector R23 P2):collab 开→关 /
        // token 轮换 / bridge 代际 / 端口重绑后跨 app 重启, 进程内集合
        // 清空也能判出存活 query 的 MCP 配置属旧代际。
        const ccAppliedFingerprint = readCcAppliedFingerprint(sessionId);
        const ccGenerationDrift =
          mcpInjectFingerprint !== undefined &&
          ccAppliedFingerprint !== null &&
          mcpInjectFingerprint !== ccAppliedFingerprint;
        // 注入失败 / bridge 不可用时没有 desired 指纹,但旧 alive query 可能
        // 仍带着上一代 MCP 配置 (老版本/首次注入尚无 applied 记录时也成立),
        // attach 会复用失效 Authorization / URL / mcp-session-id。此时
        // forceFresh 成无 MCP 的干净 query,并在 open 成功后把 applied 收敛
        // 为 disabled,避免故障期间每次 open 都重复 kill + fresh
        // (Greptile R29 P1)。
        const ccMissingDesiredStale =
          mcpInjectFingerprint === undefined &&
          ccAppliedFingerprint !== CC_MCP_DISABLED_FINGERPRINT;
        // 持久代际 drift (ccGenerationDrift) 不受 fresh 集合豁免:
        // token/bridge/端口变化后 applied 指纹 ≠ desired 时, 已 fresh 过的
        // session 也必须重新 forceFresh — 否则豁免让 drift 判定只在「从未
        // fresh 过」时生效, attach 回持旧 Authorization/URL 的 query
        // (codex-connector R27 P1)。fresh 集合只豁免「同代际的重复注入」。
        const forceFreshQuery =
          ((injectedServerCount > 0 || mcpNeedsFreshStart || staleInvalidatedCcSessions.has(sessionId)) &&
            !forcedFreshCcBridgeSessions.has(sessionId)) ||
          ccGenerationDrift ||
          ccMissingDesiredStale;

        // 协同 MCP 已 mutate 进 startParams.mcpServers;这里再把 proxy env 合入
        // 得到最终 startParams (mcpServers 与 env 都带上)。
        const startParamsWithProxy = proxyEnv
          ? {
              ...(startParams as Record<string, unknown>),
              env: {
                ...((startParams as { env?: Record<string, string> }).env ?? {}),
                ...proxyEnv,
              },
            }
          : startParams;

        const { remoteQuery, dispose, detach } = await (async () => {
          try {
            return await openCcManagerSession({
              host,
              sessionId,
              startParams: startParamsWithProxy as unknown as Parameters<typeof openCcManagerSession>[0]['startParams'],
              claudeBinaryPath,
              onApprovalRequest: onApprovalRequest as Parameters<typeof openCcManagerSession>[0]['onApprovalRequest'],
              onOAuthRefresh: onOAuthRefresh as Parameters<typeof openCcManagerSession>[0]['onOAuthRefresh'],
              forceFreshQuery,
            });
          } catch (err) {
            // openCcManagerSession 失败时上面注册的 per-session ctx / forward
            // intent 必须清掉,否则残留到同 session 下一次重建或应用退出。
            try {
              mcpCleanup();
            } catch { /* cleanup 失败不掩盖原始错误 */ }
            throw err;
          }
        })();
        if (forceFreshQuery) {
          forcedFreshCcBridgeSessions.add(sessionId);
          staleInvalidatedCcSessions.delete(sessionId);
        }
        // 注入/禁用代际随 open 成功落盘 (attach 也算 — 它确认了该 query
        // 的 MCP 代际);下次 open 前据此判 drift。
        const appliedFingerprintToWrite =
          mcpInjectFingerprint ?? (ccMissingDesiredStale ? CC_MCP_DISABLED_FINGERPRINT : undefined);
        if (appliedFingerprintToWrite) {
          writeCcAppliedFingerprint(sessionId, appliedFingerprintToWrite);
        }

        // 把 ssh transport disposer 串进 remoteQuery.close — maker-core 不知道
        // ssh / RpcClient / nc 这层 transport, 只会调它认得的 Query.close()。
        // openCcManagerSession 的 dispose 已经内部先 await remoteQuery.close()
        // (查询 close RPC + unsubscribe + end queue), 再 client.dispose() 关
        // RpcClient, 再 handle.kill() 关 ssh exec。所以 close 直接重定向到
        // dispose 即可, 不需要分两步。漏接这个 hook 会让 ClaudeCodeAgent close
        // 时 ssh exec 一直挂着, 远端 nc 子进程也不退, 文件描述符泄漏。
        // close 同时注销 per-session MCP token (detach 不清:detach 是断传输
        // 保 session, 重连时 factory 会重新注册)。
        const disposeWithMcpCleanup = async (): Promise<void> => {
          try {
            mcpCleanup();
          } catch (err) {
            desktopMakerLogger.warn('cc remote MCP token cleanup failed', {
              sessionId,
              message: err instanceof Error ? err.message : String(err),
            });
          }
          await dispose();
        };
        const remoteQueryWithDispose = Object.assign(remoteQuery, {
          close: disposeWithMcpCleanup,
          detach,
        });
        return remoteQueryWithDispose as unknown as RemoteCcQuery;
      },
    });
    const codexMcpProviders = [
      ...createDesktopMcpProviders(makerMemoryProviderDeps),
      orcaWorkerBridgeProvider,
    ];
    _codexMcpProviders = codexMcpProviders;
    const codexAgent = new CodexAgent({
      auth: desktopCodexAuthAdapter,
      runtimeConfig: desktopCodexRuntimeConfig,
      binaryPath: codexPath,
      logger: desktopMakerLogger,
      registerLocalCodexAppServerProcess: ({ pid, role }) =>
        registerCodexProcessRole(pid, role),
      // Codex 也接 Cindy MCP providers (跟 claude 共享同一份 provider instances);
      // codex 子进程没法消费 in-process JS instance, prepareCodexExtraSpawnConfig
      // 起 streamable-HTTP bridge 把 instance 通过 -c 'mcp_servers...=...' 注入。
      mcpProviders: codexMcpProviders,
      // Evaluate after app-server startup prepared (or reused) the MCP bridge.
      // The bridge snapshot is the applied capability surface; the preference
      // alone can be ahead of it while a busy Codex turn defers refresh.
      get capabilityRouting() {
        return buildDesktopCapabilityRoutingPolicy({
          cindyComputerAvailable:
            getActiveCodexBridgeServerNames()?.includes('cindy_computer') === true,
        });
      },
      resolveCapabilityRouting: async ({
        workingDir,
        remoteHostId,
        vendorOptions,
        codexBrowserUseProvisioned,
        ensureCodexBrowserUseReady,
      }) => {
        const disabledPluginIds =
          readDisabledBuiltinPluginIds(vendorOptions)
          ?? getPluginRegistry().getDisabledRuntimePluginIds(workingDir);
        const cindyBrowserEnabled = !disabledPluginIds.includes('browser');
        let connectedCodexBrowserUse = codexBrowserUseProvisioned;
        if (!remoteHostId && !cindyBrowserEnabled && connectedCodexBrowserUse) {
          connectedCodexBrowserUse = await ensureCodexBrowserUseReady();
        }
        return buildDesktopCapabilityRoutingPolicy({
          cindyComputerAvailable:
            getActiveCodexBridgeServerNames()?.includes('cindy_computer') === true,
          cindyBrowserEnabled,
          codexBrowserUseAvailable: connectedCodexBrowserUse,
          codexBrowserUseProvisioned,
          remoteHostId,
        });
      },
      makerMemory: makerMemoryManager,
      // 通讯录 prompt 段有效状态(codex 版): 在 claude 的判定链之上再与「实际应用
      // 到 running app-server 的 spawn 快照」对齐 —— 开关切换后失效失败(busy,
      // contacts-ipc 折成 codexMcpRefreshed:false)时 stale 桥里没有新工具面,
      // live=开 / applied=关 → unavailable(静默), 直到重建成功快照跟上。
      getContactsPromptState: ({ workingDir }) => {
        if (!getPluginRegistry().isEnabled('contacts', workingDir)) return 'unavailable';
        const live = readContactsSettings().enabled;
        if (!live) return 'disabled';
        const applied = codexAppliedContactsEnabled ?? live;
        return applied ? 'enabled' : 'unavailable';
      },
      getGhostRosterPrompt,
      // 模型清单 SSoT = 目录（providers.json，OSS 运行时真源 / bundled 兜底）。maker-core 的
      // CODEX_MODELS 已删、availableModels 起始为空；host 从账号可选目录派生 codex 列表注入
      // （gpt 原生 + codex/ 折扣网关路由）。「折扣GPT」codex/ 仍是「XD 网关来源」,渲染层按
      // 「XD 网关已连接」gate 可见性（ModelSelector onlyConnected / CreateWorkerPopover / ScheduleChips）。
      capabilityAdditions: {
        availableModels: deriveAvailableModels(getDesktopSelectableCatalog(), 'codex'),
      },
      // 把 app-server 上报的上下文窗口收敛到该**路由**真实上限。每次调用读 live 目录:
      // 模型发现 / 切账号 / 自定义 provider 增删改都要即时反映。按 providerId 定夺而不是
      // 让 agent 按 id 回查 availableModels —— 那张表去重后 provider 归属已丢。
      resolveVerifiedContextWindow: (providerId, modelId) =>
        resolveVerifiedContextWindow(getDesktopSelectableCatalog(), 'codex', providerId, modelId),
      onCodexLocalModelsListed: (models) => {
        setDiscoveredCodexModels(mapCodexAppServerModelsToCatalog(models));
      },
      // 「后端不可达」终局升级时读一次本次请求的出站路径判定,把通用猜测换成实测事实。
      // 快照的 proxy 字段在 resolver 侧已脱敏,可直接进用户可见的错误消息。
      //
      // 两步定位,缺一不可:
      //  1. codex-proxy-host 记的 threadId → 本次实际出口 origin。codex 的出口随会话
      //     选定的 provider 变(订阅直连 ChatGPT、网关、xAI、自定义供应商),猜候选或
      //     按时间戳挑最新都会把别的会话的判定报到本次故障上。
      //  2. 该 origin 在 resolver 侧的判定。resolver 是共享的(anthropic-compat proxy、
      //     通用 outbound-fetch 也在调),按 origin 取才不会串到别的消费方。
      // 任一步查不到就返回 null,退回通用文案 —— 尤其 gateway-key fallback 下
      // codexProxyActive=false、codex 直连不经本 proxy 时,这里必然查不到映射,
      // 于是不会报出一条本次根本没走过的路径。
      getOutboundPathFact: ({ threadId }) => {
        if (!threadId) return null;
        const origin = getCodexThreadUpstreamOrigin(threadId);
        return origin ? getOutboundPathSnapshotFor([origin]) : null;
      },
      reviewAutoPermissionAction,
      prepareCodexLocalCredentialModeSwitch: async (ctx) => {
        const maker = _maker;
        if (!maker) throw new Error('Maker is not initialized for Codex credential mode switch');
        await prepareLocalCodexCredentialModeSwitch({
          maker,
          isSessionInTurn,
          fromMode: ctx.fromMode,
          fromModeEffective: ctx.fromModeEffective,
          toMode: ctx.toMode,
        });
      },
      prepareCodexExtraSpawnConfig: async (providers, ctx) => {
        if (ctx.remoteHostId) {
          // The remote daemon owns its own CODEX_HOME and Chrome companion.
          // Do not let the local Desktop platform or local companion probe
          // disable a remote runtime that is already configured there.
          return {
            extraArgs: [],
            extraEnv: {},
            codexProxyActive: false,
            codexBrowserUseAvailable: true,
          };
        }
        let mcpExtraArgs: string[] = [];
        let mcpExtraEnv: Record<string, string> = {};
        let buildSessionMcpConfig:
          | ((sessionInstanceId: string) => Record<string, unknown>)
          | undefined;
        try {
          const cfg = await getCodexExtraSpawnConfig({
            mcpProviders: providers,
            logger: desktopMakerLogger,
          });
          // getCodexExtraSpawnConfig may return a cached array; per-host
          // Browser overrides must never mutate that shared snapshot.
          mcpExtraArgs = [...cfg.extraArgs];
          mcpExtraEnv = cfg.extraEnv;
          buildSessionMcpConfig = cfg.buildSessionMcpConfig;
          // 本次 spawn 配置实际应用的通讯录可用性快照 —— 从返回的 cfg 本体推导,
          // 不另读 settings: getCodexExtraSpawnConfig 是模块级缓存, 失效失败后
          // 命中缓存返回的还是 pre-toggle 配置, 此时 live 设置读数会谎报新状态
          // (review: 快照必须等于 applied config, 而非 applied 时刻的旁路读数)。
          codexAppliedContactsEnabled = cfg.bridgeServerNames.includes('cindy_contacts');
        } catch (err) {
          desktopMakerLogger.error('codex MCP bridge prep failed, continuing without lizi MCP', {
            message: err instanceof Error ? err.message : String(err),
          });
          // bridge 整体缺席 = cindy_contacts 必然不可达
          codexAppliedContactsEnabled = false;
        }
        const isControlPlane = ctx.hostPurpose === 'control-plane';
        const browserCompanion = isControlPlane
          ? null
          : await prepareCodexBrowserCompanion({ codexHome: getCodexHome() });
        const browserCompanionSpawnConfig =
          resolveCodexBrowserCompanionSpawnConfig(browserCompanion);
        mcpExtraArgs.push(...browserCompanionSpawnConfig.extraArgs);
        if (
          browserCompanion?.status === 'unavailable' &&
          browserCompanion.reason !== 'platform_unsupported'
        ) {
          desktopMakerLogger.warn('Codex Browser companion unavailable', {
            reason: browserCompanion.reason,
            detail: browserCompanion.detail,
          });
        }
        // API 模式: 追加 model_provider override, 让 codex app-server 走 AI Gateway
        // 而非 OAuth 订阅后端。每次 createHost 都现读 mode, 切模式后重建即生效。
        // 关掉 API 模式则不带这些 flag —— 天然可逆 (见 codex-gateway-config.ts)。
        //
        // proxy 路线: codex 始终经本地 loopback proxy 出口(不分 oauth/api 全局开关),
        // proxy 按 model + 模式分流。spawn 鉴权优先服从本次 session 的显式来源:
        //   gateway-key  → env_key(codex 带 gateway key,不触碰 OAuth cloud config)
        //   oauth-bearer → requires_openai_auth(codex 带 OAuth token,普通模型走 ChatGPT)
        //   provider-oauth → env_key 占位,proxy 用供应商 OAuth 覆盖 Authorization(如 xAI)
        // 未显式选择来源时才保留旧 fallback:有 OAuth 用 OAuth,否则用 gateway key。
        const credentialMode = ctx.credentialMode ??
          (await desktopCodexAuthAdapter.hasCodexOAuthLogin() ? 'oauth-bearer' : 'gateway-key');
        const authInjection =
          credentialMode === 'oauth-bearer'
            ? 'oauth-bearer'
            : credentialMode === 'provider-oauth'
              ? 'provider-oauth'
              : 'env-key';
        const useOAuthBearer = authInjection === 'oauth-bearer';
        if (!isControlPlane) {
          setCodexProxyAuthInjection(authInjection);
          await broadcastCodexRuntimeRoute();
        }
        setCodexProxyGatewayKeyReader(readClaudeApiKey);

        // 这个点在 CodexAgent.createHost() 内。返回的 codexProxyActive 会被冻到 AppServerHost 实例上,
        // 后续 startSession 只读 host 自己的事实,不再 live 读全局 flag。
        if (isControlPlane) {
          await ensureCodexControlPlaneProxyReady(authInjection);
        } else {
          await ensureCodexProxyReady();
        }
        const ready = isControlPlane
          ? isCodexControlPlaneProxyHandleReady(authInjection)
          : isCodexProxyHandleReady();
        if ((useOAuthBearer || authInjection === 'provider-oauth') && !ready) {
          const error = new Error(
            authInjection === 'provider-oauth'
              ? 'Codex provider OAuth mode requires the local proxy, but the proxy is not ready'
              : 'Codex OAuth mode requires the local proxy, but the proxy is not ready',
          );
          // fallback OAuth 也是凭据隔离要求,不能被 maker-core 当成普通 MCP 降级吞掉。
          (error as { codexSpawnConfigFatal?: boolean }).codexSpawnConfigFatal = true;
          throw error;
        }
        // gateway-key 模式下 proxy 挂了仍可 fallback 到 gateway base_url(codex 直连 gateway, 不裸奔)。
        const endpoint = isControlPlane
          ? getCodexControlPlaneProxyEndpoint(authInjection)
          : getCodexProxyEndpoint();
        const subagentModelSettings = readSubagentModelSettings();
        const subagentModelFallback = resolveCodexSubagentModelFallback(
          subagentModelSettings,
          ctx.remoteHostId,
        );
        return {
          // 子代理护栏/默认模型每次 createHost 现读 store:DeferredCodexRestart 兑现
          // (dispose host)后的新 spawn 自动带新值。agents.* 对 control-plane 的
          // model/list 无影响,不加 hostPurpose 分支。
          extraArgs: [
            ...mcpExtraArgs,
            ...buildCodexSubagentSpawnArgs(subagentModelSettings),
            ...buildCodexProxySpawnArgs(endpoint, authInjection),
          ],
          extraEnv: mcpExtraEnv,
          ...(subagentModelFallback ? { subagentModelFallback } : {}),
          ...(buildSessionMcpConfig ? { buildSessionMcpConfig } : {}),
          codexProxyActive: ready,
          codexBrowserUseAvailable: browserCompanionSpawnConfig.codexBrowserUseAvailable,
          ...(browserCompanion?.status === 'ready'
            ? {
                codexBrowserUseVersion: browserCompanion.version,
                codexBrowserUseStartupTimeoutMs: browserCompanion.startupTimeoutMs,
              }
            : {}),
          // oauth spawn 才定义 OpenAI 身份 provider(spawn args 同源);maker-core 只对
          // 「订阅直连路由」的 thread 用它开 OpenAI 远端压缩,其余 thread 保持本地压缩。
          ...(useOAuthBearer && ready
            ? { codexRemoteCompactionProviderId: CODEX_OPENAI_COMPACT_PROVIDER_ID }
            : {}),
        };
      },
      registerCodexMcpThreadContext: ({ threadId, sessionId, sessionInstanceId, mcpCallerKind, mcpCallerAttested, workingDir, remoteHostId, vendorOptions }) => {
        // Codex shares one app-server across sessions. Freeze the effective
        // ordinary-tool policy at thread creation so later Settings changes do
        // not mutate a runtime that is already running.
        const disabledPluginIds =
          readDisabledBuiltinPluginIds(vendorOptions)
          ?? getPluginRegistry().getDisabledRuntimePluginIds(workingDir);
        registerCodexMcpThreadContext(threadId, {
          agentKind: 'codex',
          sessionId,
          mcpCallerKind,
          mcpCallerAttested,
          ...(sessionInstanceId ? { sessionInstanceId } : {}),
          workingDir,
          // remote thread ctx: scope key 语义见 buildMemoryScopeKey。
          ...(remoteHostId ? { remoteHostId } : {}),
          vendorOptions: {
            ...vendorOptions,
            [CODEX_DISABLED_BUILTIN_PLUGIN_IDS_KEY]: disabledPluginIds,
          },
        });
      },
      unregisterCodexMcpThreadContext,
      prepareCodexResumeSession: prepareExternalCodexSessionForResume,
      registerCodexSystemPromptForThread: ({ sessionId, threadId, text }) =>
        registerCodexProxyComposed(sessionId, threadId, text),
      armCodexHttpRecovery,
      registerCodexChildThreadForParent: ({ parentThreadId, childThreadId }) => {
        registerCodexProxyChildThread(parentThreadId, childThreadId);
      },
      // host 自家、用户已通过 OAuth/账号授权过且完成权限 review 的 MCP server,
      // 按精确 server name 自动通过 Codex MCP elicitation，避免每次可信写操作都弹
      // PermissionPrompt。`cindy_` 只是 namespace，不构成信任边界；新 provider
      // 默认仍弹审批，必须显式加入 allowlist。同一份策略也注入 Claude Code
      // (见上方 claudeAgent 构造)，两端对同一个 MCP 工具必须给出同一个答案。
      // 例外:`cindy_ssh` 显式排除——它的 ssh_exec 在远端机器上执行任意命令,
      // 属于跨机器写操作,必须保留 Codex MCP elicitation 审批(PR #874 review)。
      // cindy_contacts 是渐进式 list_tools/call_tool server：不能按 serverName
      // 粗粒度信任，否则 delete/merge/系统回写/文件覆盖都会被 outer call_tool
      // 一并放行。Codex metadata 带 outer tool params，可在执行前解析 inner tool；
      // 未知或高风险 action 逐次弹卡且禁止“本会话允许”。
      // 详见 AgentDeps.getMcpToolApprovalPolicy。
      getMcpToolApprovalPolicy: getDesktopMcpToolApprovalPolicy,
      // 远端 Codex (P2): 给 session 标 remoteHostId 的, CodexAgent 通过这个钩子拿
      // 远端 transport — SSH 连接已有 ConnectionPool (remote-ssh feature 起的) 管,
      // 这里包一层把 RemoteHost + SshDaemonTransport 装起来。
      // 远端机器没在 pool / 未连接 → 抛错, CodexAgent 把它当 startSession 失败传上去。
      getRemoteCodexTransport: (remoteHostId) => {
        const remoteHost = getRemoteSshPool().get(remoteHostId);
        if (!remoteHost) {
          throw new Error(`remote SSH host "${remoteHostId}" not found in pool — connect it first under Settings → Remote`);
        }
        if (remoteHost.getStatus() !== 'ready') {
          throw new Error(`remote SSH host "${remoteHostId}" is not connected (status=${remoteHost.getStatus()}) — connect it under Settings → Remote first`);
        }
        return createSshDaemonTransport({
          remoteHost,
          logger: desktopMakerLogger,
          // 「Agent 流量走本地 Proxy」: pref 开启时先建 SSH 反向隧道 + 对账
          // codex daemon 的 env marker (漂移 → 重写 + 重启 daemon), 然后才让
          // transport 探活/拉起 daemon。pref 关闭时 reconcile 是幂等 no-op。
          beforeDaemonProbe: async () => {
            // markerChanged && !daemonRestarted = 旧 daemon 活着跑旧 env —
            // 继续 probe 会 attach 到 stale daemon, UI 报 tunnel active 而
            // codex 流量走旧路由 (codex R10 P1): 按 bootstrap 失败抛出, 让
            // session start 显式报错, 而不是静默复用。
            // deferredForLiveTurn (host 上有别的 turn 在跑) 则放行 attach:
            // 这正是「不 mid-turn 杀 daemon」的代价 — 新 session 暂用旧
            // env, turn-done 挂钩补刀后自愈。
            const reconciled = await reconcileCodexAgentProxyEnv(remoteHost);
            if (reconciled.markerChanged && !reconciled.daemonRestarted) {
              throw new Error(
                'codex daemon survived pkill after agent-proxy env change; refusing to attach the stale daemon (retry or restart the host)',
              );
            }
          },
        });
      },
    });

    // 模块级回填 codexAgent 引用 —— restartCodexAfterAuthModeChange() 需要它在
    // API 模式切换 / api_key 变更时 dispose 重建 app-server (单例进程, 配置 spawn 冻入)。
    _codexAgent = codexAgent;

    // 装配第二步: 把 agents 引用挂回 manager (manager.enable() 时遍历 setMemory(false))。
    attachAgentsToMakerMemory(makerMemoryManager, {
      'claude-code': claudeAgent,
      codex: codexAgent,
    });
    if (makerMemoryManager.isEnabled()) {
      void makerMemoryManager.enable();
    }

    // logout 后强制 dispose 本地 host —— local app-server 子进程内存里仍持有旧 token,
    // 不收割切账号时会拿旧 token 跑请求(撞 401, 或更糟: 把老账号的 session 暴露给新账号)。
    // 远端 host 使用远端 daemon / 远端用户配置,本地 logout 不应误关 remote:* host。
    // dispose 幂等: 没 spawn 过就 no-op。
    //
    desktopCodexAuthAdapter.setOnLogoutSuccess(async () => {
      resetProviderModelAutoRefreshCooldowns('openai');
      // auth 边界变了:「清单已在场」和「试过几次」都不再适用于下一个账号。
      resetCodexModelBackfillState();
      await codexAgent.forceDisposeLocalHostForAuthChange('Codex desktop auth logout');
      clearCodexProxyAuthInjection();
      await broadcastCodexRuntimeRoute();
    });
    // 登录成功也要对称重启本地 host:网关 key fallback 下 host 可能在 OAuth 登录前
    // 就以 env-key 形态跑着("auth gate 挡住未授权 spawn"的老前提在该场景不成立),
    // 不重启则隐式会话继续复用旧钥匙形态,新登录不生效(codex review 2026-07-03 P2)。
    // 下次 getHost 会按新 fallback(oauth-bearer)重建并重设 proxy 注入。
    desktopCodexAuthAdapter.setOnLoginSuccess(async () => {
      resetProviderModelAutoRefreshCooldowns('openai');
      resetCodexModelBackfillState();
      // 必须在新 app-server 首次 model/list / Responses 请求之前清：bridge 的旧账号
      // accessToken/accountId 有 30s 内存缓存，晚清会让新 host 短暂带旧账号凭证请求。
      clearChatgptBridgeCredentialCache();
      await codexAgent.forceDisposeLocalHostForAuthChange('Codex desktop auth login');
      await broadcastCodexRuntimeRoute();
      // 这里刻意**不**补拉:登录路径的清单收口在 maker-ipc/auth.ts,它会在 live 拉取没
      // applied 时回退读 models_cache（cache miss 即清空,防串号）。在这里并发补拉会与那次
      // 清空交错,刚拉到的清单可能被空 cache 覆盖。补拉挂在那条收口之后,顺序确定。
    });
    // 「本机已有 ChatGPT 凭证被自动认领」这条路径不走 OAuth 登录动作,拿不到上面那个收口。
    // 不在这里补拉,新机器首启就会停在「已连接 + 零模型」,直到用户打开设置页或模型选择器
    // 才由 auto-refresh 兜住 —— 这正是首启 Codex tab 只剩少数模型的直接原因。
    desktopCodexAuthAdapter.setOnOAuthBindingClaimed(async () => {
      resetProviderModelAutoRefreshCooldowns('openai');
      await requestCodexModelBackfill();
    });
    // codex CLI 在 stderr 报 refresh_token 失效时, agent 会调 auth.invalidate() →
    // logout + 这里这个 broadcast, 让 useCodexAuth hook 立刻进 'unauthenticated' 状态,
    // UI 弹 "请重新登录" — 否则错误只会反复埋在后台日志里。payload 字段对齐
    // maker-ipc/auth.ts logout handler 的 broadcast 形态。
    desktopCodexAuthAdapter.setOnInvalidatedBroadcast(async (reason, credentialScope) => {
      resetProviderModelAutoRefreshCooldowns('openai');
      resetCodexModelBackfillState();
      // 运行中 401/token invalidation 不经过 maker:auth:logout IPC，必须在这里做同一套
      // auth-boundary catalog 收口；否则磁盘 cache 已删但内存 discovered/capabilities 仍旧。
      try {
        // **必须先退役旧 host**，再清目录（PR #1076 review 第三轮）。
        //
        // 凭证失效与 logout / login 是同一类 auth 边界，却是三条路径里唯一没有退役 host 的
        // ——于是旧 host 上在途的 `model/list` 会在目录被清空之后带着已失效账号的清单回来。
        // 拦得住它的判据本来就有：CodexAgent 在把结果交给宿主前会校验
        // `this.hosts.get(key) !== host`（见 agents/codex/index.ts 的 model/list 收尾），
        // 只是这条路径从没让那个校验生效过。退役即补齐对称性，不需要在写入侧再加一层闸门。
        await codexAgent.forceDisposeLocalHostForAuthChange(
          `Codex credential invalidated: ${reason}`,
        );
        clearChatgptBridgeCredentialCache();
        await refreshDiscoveredCodexModels(false);
      } catch (e) {
        // 目录刷新是失效广播的附加收口，不能因其异常让 renderer 错过“请重新登录”。
        desktopMakerLogger.warn('Codex invalidation catalog cleanup failed', {
          error: e instanceof Error ? e.message : String(e),
        });
      }
      const payload = {
        agentKind: 'codex' as const,
        authenticated: false,
        errorReason: reason,
        credentialScope,
      };
      for (const win of BrowserWindow.getAllWindows()) {
        if (win.isDestroyed()) continue;
        try { win.webContents.send(MAKER_PUSH.AUTH_STATE_CHANGED, payload); } catch { /* no-op */ }
      }
    });
    // Claude 同款:订阅 refresh token 被服务端作废(invalid_grant)时,adapter.invalidate()
    // 清态后经这里广播,UI 立刻进「请重新登录」而不是连环 401 的假连接状态。
    desktopClaudeAuthAdapter.setOnInvalidatedBroadcast((reason) => {
      resetProviderModelAutoRefreshCooldowns('anthropic');
      // 凭证已失效 = anthropic 动态清单失去可用性证明,与登出同款收口(清单+磁盘缓存)。
      void clearAnthropicDiscoveredModels().catch(() => { /* 清理失败不阻断失效广播 */ });
      const payload = {
        agentKind: 'claude-code' as const,
        authenticated: false,
        errorReason: reason,
      };
      for (const win of BrowserWindow.getAllWindows()) {
        if (win.isDestroyed()) continue;
        try { win.webContents.send(MAKER_PUSH.AUTH_STATE_CHANGED, payload); } catch { /* no-op */ }
      }
    });
    // 预热 codex-home 骨架 + 与本机 codex CLI reconcile 凭证。原本挂在
    // DesktopCodexAuthAdapter 构造函数里(import 即写盘),会让所有传递性 import 到
    // auth-adapters 的测试在真实文件系统留痕(2026-07-03 曾把含真实凭证硬链的
    // codex-home 生成进仓库),现改为装配 maker 时显式预热,import 保持零副作用。
    desktopCodexAuthAdapter.warmUp();

    // pi(实验性,个人分支):二进制在位才注册;缺失时 agents map 不含 pi,
    // 既有环境零影响。模型清单走目录 pi 投影(xd 网关模型经 active-catalog 按
    // claude-code 可达面镜像给 pi);登录后目录刷新经 refreshCatalogDerivedModels
    // 原地 splice 同步进 capabilities(PiAgent 每次 startSession 现读)。
    const piMcpProviders = [
      ...createDesktopMcpProviders(makerMemoryProviderDeps),
      orcaWorkerBridgeProvider,
    ];
    // 用户自定义 MCP:三个 agent 都必须注册其实际持有的数组引用，再统一做初始 refresh。
    // localDb onReady 可能在 Maker 构造前就已触发（此时 registry 无数组，refresh 空跑）；
    // 在此补一次 refresh，若 DB 尚未就绪则 refreshCustomMcpProviders 内部 catch 后静默跳过。
    // 此后每次 CRUD（mcpHandlers.afterChange）也会原地刷新三份数组；运行中会话保持启动快照。
    registerCustomMcpArrays(claudeMcpProviders, codexMcpProviders, piMcpProviders);
    _initialCustomMcpRefresh = refreshCustomMcpProviders();

    const piAgent = buildPiAgent({
      logger: desktopMakerLogger,
      turnChangeCapture: {
        beforeKnownFileWrite: captureKnownFileBefore,
        noteOpaqueWrite: noteOpaqueTurnChange,
      },
      registerLocalAgentProcess: ({ pid, kind, role }) =>
        registerAgentProcess(pid, kind, role),
      reviewAutoPermissionAction,
      capabilityAdditions: {
        availableModels: deriveAvailableModels(getDesktopSelectableCatalog(), 'pi'),
      },
      resolvePiRuntimeModelDescriptor: (providerId, modelId) =>
        resolvePiRuntimeModelDescriptor(getDesktopSelectableCatalog(), providerId, modelId),
      resolvePiGatewayModelDescriptor: (modelId) =>
        resolvePiRuntimeModelDescriptor(getDesktopSelectableCatalog(), 'cindy', modelId),
      mcpProviders: piMcpProviders,
      makerMemory: makerMemoryManager,
      getGhostRosterPrompt,
    });

    _maker = new Maker({
      agents: {
        'claude-code': claudeAgent,
        codex: codexAgent,
        ...(piAgent ? { pi: piAgent } : {}),
      },
      storage: desktopSessionStorage,
      logger: desktopMakerLogger,
      makerMemory: makerMemoryManager,
      // Desktop-specific session 生命周期副作用钩子。maker-core 不知道文件系统细节，
      // 启动前的 Skill 共享与关闭后的清理都由 desktop host 注入。
      lifecycleHooks: {
        prepareStartOptions: async (sessionId, opts) => {
          const providerScopeKey = activeOwnerScopeKey();
          const providerReady = await accountProviderReadinessBarrier.waitForScope(providerScopeKey);
          if (
            !providerReady ||
            activeOwnerScopeKey() !== providerScopeKey ||
            isAppSessionBoundaryPending()
          ) {
            throw new Error(
              'Account provider models are not ready for this app session; retry.',
            );
          }
          await preparePersistedOrcaSessionStart(sessionId, opts as MakerSessionCreateOpts);
          if (opts.agentKind === 'codex') {
            const disabledPluginIds = getPluginRegistry().getDisabledRuntimePluginIds(
              opts.workingDir,
            );
            opts.vendorOptions = {
              ...(opts.vendorOptions ?? {}),
              [CODEX_DISABLED_BUILTIN_PLUGIN_IDS_KEY]: disabledPluginIds,
            };
          }
        },
        onBeforeStart: async ({ agentKind, workingDir, remoteHostId }) => {
          // 延迟记忆重启 pending 时,本地 Codex 新会话加入 shared host 前先尝试
          // 兑现(其它会话全空闲才会真的重启;仍 busy 则放行,残余窗口见
          // deferredCodexRestart.ts 模块注释)。
          if (agentKind === 'codex' && !remoteHostId) {
            await _beforeLocalCodexSessionStartHook?.();
          }
          // SSH remote 的 workingDir 属于远端文件系统，本机不能为它创建兼容链接。
          if (remoteHostId || !workingDir) return;
          const result = await prepareSharedProjectSkillLinks({ workingDir });
          for (const warning of result.warnings) {
            desktopMakerLogger.warn('shared project skill link warning', {
              workingDir,
              warning,
            });
          }
          // Codex app-server 会按 cwd 缓存 skills/list；本轮新建链接后必须在
          // startSession 前失效缓存，确保首个 session 就能使用刚共享的 Skill。
          if (agentKind === 'codex' && result.changed) {
            await codexAgent.listAgentSkills({ workingDir, forceReload: true });
          }
        },
        onStartSucceeded: (sessionId, opts) => {
          const createOpts = opts as MakerSessionCreateOpts;
          markOrcaMcpHydratedIfNeeded(sessionId, createOpts);
          if (createOpts.orcaRole === 'worker') {
            markKnownOrcaWorkerSession(sessionId);
          }
        },
        getCodexHistoryHasProductPrompt: (sessionId) =>
          readCodexHistoryHasProductPrompt(sessionId),
        onCodexProductPromptDelivery: async ({ sessionId, historyHasProductPrompt }) => {
          await writeCodexHistoryHasProductPrompt(sessionId, historyHasProductPrompt);
        },
        onClose: async (sessionId) => {
          // rehydrate close suppression 只跳过 worktree / temp file 这类重副作用;
          // registry 必须先清,后续 resume 会在首个 /responses 前重新登记,避免旧 thread prompt 驻留。
          unregisterCodexProxyPrompt(sessionId);
          void cleanupComputerDriverSession(sessionId);
          await rehydrateCloseSuppression.runOnCloseSideEffects(sessionId, async () => {
            await cleanupSessionTempAttachments(sessionId);
            // ephemeral worktree: clean → 池化复用, dirty → 保留不删(scheduler 生命周期)。
            // 非 ephemeral worktree **不再在 close 时回收**(P0 重构):close 是进程
            // 生命周期事件,不代表用户不要工作区了(/clear、重连、CLI 崩溃都会走到
            // 这)。回收只由会话显式删除/归档驱动,见 localDb/ipc/sessions.ts →
            // worktree/sessionRemovalRecycle.ts。
            await WorktreePool.releaseWorktree(sessionId).catch(() => undefined);
          });
        },
      },
    });
    // 存量已登录用户补拉:maker 首次就绪后,若 Codex 已登录但当前无 codex 模型
    // (从没跑过会话、models_cache 未生成),fire-and-forget 触发一次 live model/list。
    // 不阻塞 getMaker 返回 / 启动(类比 refreshAnthropicModelsFromHttp 的后台刷新)。
    //
    // coordinator 而非一次性调用:首启这一刻 owner 绑定常常还没认领完,此时 hasCodexLogin()
    // 为 false —— 一次性调用会被 skipped-unauthed 白白消费掉唯一机会。授权就绪后的重试
    // 由 codex auth 事件驱动(见下方 requestCodexModelBackfill 的调用点)。
    const makerRef = _maker;
    _codexModelBackfill = createCodexModelBackfillCoordinator({
      hasCodexLogin: () => desktopCodexAuthAdapter.hasCodexOAuthLogin(),
      hasCodexModels: () =>
        (getActiveCatalog().providers.find((p) => p.id === 'openai')?.models.codex?.length ?? 0) > 0,
      refreshLive: () => makerRef.refreshAgentLocalModels('codex', {
        credentialMode: 'oauth-bearer',
      }),
      onApplied: () => refreshSelectableModelsAndBroadcast({}),
      log: desktopMakerLogger,
    });
    void _codexModelBackfill.request();
  }
  return _maker;
}

/**
 * 按 auth 事件请求一次 Codex 模型补拉(幂等 + 并发去重 + 失败封顶,见 coordinator 注释)。
 * maker 未构造时是 no-op —— 它的补拉会在构造时自己跑第一轮。
 */
export async function requestCodexModelBackfill(): Promise<void> {
  const coordinator = _codexModelBackfill;
  if (!coordinator) return;
  try {
    const outcome = await coordinator.request();
    desktopMakerLogger.debug('codex model backfill request settled', { outcome });
  } catch (err) {
    // coordinator 内部已吞异常并转成 outcome;这里只兜住理论上的意外,绝不让 auth 收口抛穿。
    desktopMakerLogger.warn('codex model backfill request threw', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * 重置补拉的失败计数 —— 只在 codex auth 边界真的变了时调(登录 / 登出 / 凭证失效 / 换账号)。
 * 新边界下「上个账号试过几次都不成」这个结论不再适用。
 */
export function resetCodexModelBackfillState(): void {
  _codexModelBackfill?.reset();
}

/**
 * 已构造则返回 Maker 单例,未构造返回 null——**不**触发懒构造。
 * 供"顺带关会话"类调用方(如会话删除/归档触发的 worktree 回收)使用:
 * Maker 没构造过说明不存在活跃子进程,没有东西要关,不值得为此拉起全套 agent。
 */
export function getMakerIfReady(): Maker | null {
  return _maker;
}

/**
 * 重置 Maker 单例（切账号 / 测试用）。
 */
export function resetMaker(): void {
  cancelCodexAuthModeChange();
  _maker = null;
  _codexAgent = null;
  // coordinator 闭包捕获了刚作废的那个 maker —— 不清掉的话,换账号窗口期内到达的 auth
  // 事件会拿旧实例去拉模型清单(串号)。下次 getMaker() 会带着干净记账重建它。
  _codexModelBackfill = null;
  _initialCustomMcpRefresh = undefined;
  resetPluginRegistry();
  resetCustomMcpRegistry();
}

/**
 * getMaker() 首次构造时会异步加载自定义 MCP 列表。
 * bootstrap 在注册会话 IPC 前 await 此函数，确保第一个会话能看到用户已保存的 MCP。
 * refresh 失败（DB 未就绪等）时内部已静默处理，不会抛错。
 */
export async function waitForInitialCustomMcpRefresh(): Promise<void> {
  await (_initialCustomMcpRefresh ?? Promise.resolve());
}

/**
 * Codex 鉴权配置变更后重建 app-server —— 供 "切换 API 模式" 和 "API 模式下改/删
 * api_key" 两处调用。
 *
 * 为什么必须重建: codex app-server 是整个 app 共享的单例子进程, model_provider (`-c`
 * flag) 和 gateway key (env 变量) 都在 spawn 那一刻冻入, 进程跑起来后改 settings 它
 * 不感知。dispose() 后下一次 send 会用最新配置重新 spawn。
 *
 * dispose() 幂等 (host 没起过就 no-op), 且不动 auth.json —— 切回订阅 / 切回未授权
 * 全靠 auth-adapter 的 getState 分支, 这里只负责收割旧进程 + 把最新鉴权态推给 UI。
 *
 * **老会话可续聊**: dispose 单例 app-server 会让所有存活 codex 会话的 in-memory thread
 * 失效 (原地 turn/start 撞 'thread not found')。为了让用户切模式后还能接着聊旧对话,
 * 这里在 dispose 之前先把存活的 codex 会话 "软重启" —— 抑制 onClose 副作用 (保住
 * worktree / 临时附件) 地 closeSession, 从 activeSessions 摘除。这样用户下次在该会话
 * 发消息会走 SEND 的 lazy-create 分支, 带着持久化的 sdkSessionId(=threadId) →
 * CodexAgent thread/resume 从磁盘 rollout 恢复历史, 在新模式的 app-server 上接着聊。
 * 复用 Orca rehydrate 同款 withRehydrateCloseSuppressed 机制 (见 register.ts SEND 路径)。
 *
 * null-safe: getMaker() 还没构造过 codexAgent 时直接 no-op (此时也没进程要收)。
 */
export async function prepareCodexForAuthModeChange(): Promise<void> {
  if (_codexCredentialChangeGuard) {
    throw new Error('Codex credential mode change is already in progress');
  }
  const guard = _codexAgent
    ? await _codexAgent.beginLocalHostCredentialChange('Codex desktop auth mode changed')
    : null;
  let prepared = false;
  // 软重启存活的本地 codex 会话。busy session 直接 fail closed，调用方据此避免先改持久化状态。
  const maker = _maker;
  try {
    if (maker) {
      try {
        await prepareLocalCodexCredentialModeSwitch({
          maker,
          isSessionInTurn,
        });
      } catch (e) {
        desktopMakerLogger.warn('restartCodexAfterAuthModeChange: soft-close codex sessions failed', {
          error: e instanceof Error ? e.message : String(e),
        });
        throw e;
      }
    }
    guard?.assertIdle();
    _codexCredentialChangeGuard = guard;
    prepared = true;
  } finally {
    if (!prepared) {
      guard?.release();
    }
  }
}

export function cancelCodexAuthModeChange(): void {
  const guard = _codexCredentialChangeGuard;
  _codexCredentialChangeGuard = null;
  guard?.release();
}

export async function finalizeCodexAfterAuthModeChange(): Promise<void> {
  // 只 dispose 本地 app-server, 让下一次本地 send 按新模式重新 spawn。
  // 远端 Codex host 使用远端 daemon / 远端用户配置,不能被本地 key / OAuth 变化误关。
  const guard = _codexCredentialChangeGuard;
  _codexCredentialChangeGuard = null;
  const agent = _codexAgent;
  if (guard || agent) {
    try {
      if (guard) {
        await guard.finalize();
      } else {
        await agent?.disposeLocalHostForCredentialChange();
      }
      clearCodexProxyAuthInjection();
      await broadcastCodexRuntimeRoute();
    } catch (e) {
      desktopMakerLogger.warn('restartCodexAfterAuthModeChange: dispose threw', {
        error: e instanceof Error ? e.message : String(e),
      });
      throw e;
    }
  }
  // proxy 路线: proxy 始终保活(两种 spawn 形态都依赖它), 仅在 app quit(bootstrap-electron onQuit)dispose。
  // codex 登录态变化只需上面 dispose codex agent 重 spawn —— 重 spawn 时按最新 OAuth 登录态冻结
  // authInjection(oauth-bearer / env-key), routingTransform 据此 + per-session 选择出路由。
  // auth mode 变更后清 ChatGPT bridge 凭证缓存 —— 旧 OAuth token 已无效,下次请求重读 auth.json。
  clearChatgptBridgeCredentialCache();
  // 重读 codex models_cache 刷新规范化模型快照 —— active-catalog 会同时投影 Codex 与
  // Claude bridge;放在 auth 广播前,renderer refetch 即见最新。
  await refreshDiscoveredCodexModels();
  // auth 模式变了,上一条边界下的失败计数不再适用;随后补一次 live 拉取兜住
  // 「已登录 + models_cache 还没落盘」——必须排在上面的 cache 重读之后,否则被空快照覆盖。
  resetCodexModelBackfillState();
  await requestCodexModelBackfill();
  await broadcastCodexAuthStateChanged();
}

export async function restartCodexAfterAuthModeChange(): Promise<void> {
  await prepareCodexForAuthModeChange();
  await finalizeCodexAfterAuthModeChange();
}

/**
 * 把最新的 Codex 鉴权态广播给 renderer(AUTH_STATE_CHANGED, agentKind='codex')。
 */
export async function broadcastCodexAuthStateChanged(): Promise<void> {
  try {
    const state = await desktopCodexAuthAdapter.getState();
    const payload = { agentKind: 'codex' as const, ...state };
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed()) continue;
      try { win.webContents.send(MAKER_PUSH.AUTH_STATE_CHANGED, payload); } catch { /* no-op */ }
    }
  } catch (e) {
    desktopMakerLogger.warn('broadcastCodexAuthStateChanged: broadcast state failed', {
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

/**
 * 把最新的 Claude 鉴权态广播给 renderer(AUTH_STATE_CHANGED, agentKind='claude-code')。
 *
 * 用户在 Settings 登录 / 登出 Claude.ai 订阅(写入 / 清空 OAuth 凭证)后,IPC handler 调一次
 * 本函数 —— 模型供应商页(useProviders)/ 其它订阅者立刻刷新连接态。
 * 与 Codex 不同:Claude 是 per-session spawn,无单例进程要 dispose,连接态变化只影响新建 session,
 * 所以这里**只广播状态**,不做软重启。payload 形态对齐 maker-ipc auth handlers / codex 广播。
 */
export async function broadcastClaudeAuthStateChanged(): Promise<void> {
  try {
    const state = await desktopClaudeAuthAdapter.getState();
    const payload = { agentKind: 'claude-code' as const, ...state };
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed()) continue;
      try { win.webContents.send(MAKER_PUSH.AUTH_STATE_CHANGED, payload); } catch { /* no-op */ }
    }
  } catch (e) {
    desktopMakerLogger.warn('broadcastClaudeAuthStateChanged: broadcast state failed', {
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

/**
 * xAI(SuperGrok)OAuth 登录 / 登出后广播 PROVIDER_CHANGED,触发所有窗口的 useProviders refetch。
 *
 * xAI 不是 maker AgentKind('claude-code'/'codex'),无独立的 AUTH_STATE_CHANGED payload 规范;
 * 用 PROVIDER_CHANGED(无 payload)语义最准确:provider 连接态已变更,请各消费方重新拉取列表。
 * useProviders 同时订阅 AUTH_STATE_CHANGED 和 PROVIDER_CHANGED,两者都能触发 refetch。
 */
export function broadcastXaiAuthStateChanged(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    try { win.webContents.send(MAKER_PUSH.PROVIDER_CHANGED, {}); } catch { /* no-op */ }
  }
}

/**
 * Soft-close every live `claude-code` (cc) session whose `remoteHostId` matches
 * `hostId`. Called from the cc-mgr force-upgrade IPC right BEFORE we pkill the
 * remote daemon — otherwise the existing ClaudeCodeAgent handles hold on to a
 * `RemoteSdkTransport` whose `RpcClient` is wired into the **old** ssh exec /
 * nc channel of the **old** daemon. After the daemon dies and respawns, those
 * stale transports never reconnect: next `handle.send` writes RPC into a
 * dead pipe, no response comes back, UI gets wedged in streaming state with
 * no SDK turn-start ever logged.
 *
 * Pattern is a direct mirror of [[restartCodexAfterAuthModeChange]] — close
 * the handles inside `withRehydrateCloseSuppressed` so close-time side-effects
 * (worktree cleanup, temp attachments) don't fire. Next send routes through
 * SEND's lazy create-session path: builds a fresh ClaudeCodeAgent handle,
 * which calls `remoteCcQueryFactory` again → fresh `openCcManagerSession`
 * (new ssh exec / new RpcClient / new RemoteQuery) → new daemon. The
 * persisted `sdkSessionId` is fed back as `resumeSdkSessionId`, so the
 * daemon-side SDK resumes the conversation from its on-disk rollout.
 *
 * Idempotent / null-safe: no-op when Maker singleton not constructed yet or
 * when no live cc session targets that host.
 */
export async function softCloseCcSessionsForHost(
  hostId: string,
  opts: { onlySessionId?: string } = {},
): Promise<void> {
  const maker = _maker;
  if (!maker) return;
  let liveCc = maker
    .listActiveSessions()
    .filter((s) => s.agentKind === 'claude-code' && s.remoteHostId === hostId);
  // **Scope gate**: 升级走这里的时候我们只想关 "发起 upgrade 的那个 session" —
  // 它有 UpgradeBanner 做的 retry snapshot, close 后下次 send 会重发。其它同 host
  // 的 streaming session **没有** retry snapshot, 这里如果一并 close 会让那个
  // session 静默 finalize, 用户的 in-flight turn 直接丢。改成只关 onlySessionId 后
  // 其它 session 会通过 daemon-kill → subscribeClose 自然 surface 成 error event
  // (用户至少看得见 "session 中断"), 而不是 silent close。
  // 如果 caller 不传 onlySessionId, 沿用原行为 (整个 host 全关) — 用于 dev/test
  // 场景, 生产里 force-upgrade IPC 永远传 onlySessionId。
  if (opts.onlySessionId) {
    liveCc = liveCc.filter((s) => s.id === opts.onlySessionId);
  }
  if (liveCc.length === 0) return;
  desktopMakerLogger.info('softCloseCcSessionsForHost: closing', {
    hostId,
    onlySessionId: opts.onlySessionId,
    count: liveCc.length,
    sessionIds: liveCc.map((s) => s.id),
  });
  for (const s of liveCc) {
    try {
      await withRehydrateCloseSuppressed(s.id, async () => {
        await maker.closeSession(s.id);
      });
    } catch (e) {
      desktopMakerLogger.warn('softCloseCcSessionsForHost: close failed', {
        sessionId: s.id,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
}

export async function shutdownLspServerPool(): Promise<void> {
  await lspPool?.shutdown();
  lspPool = null;
}

// re-exports for IPC layer
export { desktopClaudeAuthAdapter, desktopCodexAuthAdapter };
