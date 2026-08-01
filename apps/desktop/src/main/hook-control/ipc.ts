/**
 * hook-control/ipc.ts
 * ---------------------------------------------------------------------------
 * Slack Hook 的 Electron 组装层: 默认 store(userData 单配置文件)与 manager
 * 单例、IPC handler 注册、状态广播、登录态联动。业务体都在 store/manager
 * (可注入依赖, 单测不需要 Electron), 本文件只做 adapter(规则 14)。
 *
 * 鉴权模型: 与 device-link 同款 —— transport 建连时实时取登录 accessToken,
 * 现值缺失尝试 refresh 一次; 登录/登出经 onAuthStateChange 触发 manager.sync
 * 即连即断。没有密钥概念, 旧 safeStorage secret 文件由 store 迁移时清理。
 */

import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';

import { app, ipcMain, BrowserWindow, shell, type IpcMainInvokeEvent } from 'electron';

import { isModelVisible, visibleModelUnion } from '@cindy/model-providers';
import { BRAND_NAME } from '@cindy/maker-shared/branding';

import { createLogger } from '../logger.js';
import { getMaker, restartCodexAfterAuthModeChange } from '../maker-host/index.js';
import { shutdownCodexEnvironment } from '../mcp-integrations/codexEnvironment.js';
import { getDesktopProviderService } from '../maker-host/createDesktopProviderService.js';
import { getModelVisibilityOverride } from '../maker-host/model-visibility-mirror.js';
import { WorktreeManager } from '../worktree/index.js';
import { prepareHandoffWorktree } from '../maker-ipc/handoffWorktree.js';
import {
  onUiContinuation,
  onUiSessionIntervention,
  onUiTurnDispatching,
  onUiTurnUndispatched,
} from '../maker-ipc/uiContinuationSignal.js';
import {
  throwIpcError,
  requireObject,
  requireNullableString,
  requireString,
} from '../utils/ipcValidate.js';
import {
  listWorkspaceProviderSources,
  setWorkspaceProviderSource,
} from './workspaceProviderSourceStore.js';
import { patchSessionMetaInDb } from '../localDb/ipc/sessions.js';
import {
  dialogueWorkspaceRootDir,
  ensureDialogueWorkspaceDir,
} from '../localDb/dialogueWorkspace.js';
import * as authManager from '../authManager.js';
import { getClientEndpoint } from '../clientEndpointsService.js';
import { CURRENT_CINDY_REGION } from '../../shared/brandRegion.js';
import { getAppCapabilities } from '../appCapabilities.js';
import { ownerScopedUserDataPath } from '../appSessionState.js';
import {
  HOOK_CONTROL_EVENT,
  HOOK_CONTROL_INVOKE,
  HOOK_WORKSPACE_ALIAS_RE,
  HOOK_WORKSPACE_PROVIDER_SOURCE_MAX_ENTRIES,
  type HookPrefsPatch,
  type HookPrefsView,
  type ProviderPrefsView,
  type SlackHookView,
} from '../../shared/hookControlIpc.js';
import {
  DEFAULT_SLACK_LIFECYCLE_ANNOUNCEMENT,
  createSlackHookStore,
  HookConnectionValidationError,
  type SlackHookStore,
} from './store.js';
import {
  createHookControlManager,
  hookNotConnectedIpcMessage,
  HookNotConnectedError,
  HookPrefsTimeoutError,
  type HookControlManager,
} from './manager.js';
import { createHookTransport } from './transport.js';
import { registerSlackToolBridge, unregisterSlackToolBridge } from './slackToolBridge.js';
import { createHookBindingStore } from './bindings.js';
import { buildGroupContextPrefix, resetGroupContextCursors } from './groupWindow.js';
import { createHookDispatcher } from './dispatcher.js';
import { createMakerHookSessionRunner } from './session-runner.js';
import { resolveHookInteraction } from './interactions.js';
import { listRecentHookSessions } from './recentSessions.js';
import { validateTelegramExternalUrl } from './telegramDeepLink.js';
import { validateXExternalUrl } from './xDeepLink.js';
import { isAppContentWindow } from '../windowFocusClassifier.js';
import { assertTrustedAppRendererEvent } from '../security/trustedAppRenderer.js';
import { getAgentIslandService } from '../agent-island/service.js';
import { setLifecycleAnnouncementFromIpc } from './lifecycleAnnouncementIpc.js';

const log = createLogger('hook-control');

let store: SlackHookStore | null = null;
let manager: HookControlManager | null = null;
let disposeAuthListener: (() => void) | null = null;
let observedAuthRealm: ReturnType<typeof authManager.getActiveAuthRealm> | null = null;
let codexMcpRefreshPending = false;
let codexMcpRefreshRunning = false;
let codexMcpRefreshRetryTimer: NodeJS.Timeout | null = null;
let latestSlackToolProviderEnabled = false;

const CODEX_MCP_REFRESH_RETRY_MS = 2_000;

function hookControlAvailable(): boolean {
  return getAppCapabilities().canUseCindyAccountServices;
}

function requireHookControl(): void {
  if (!hookControlAvailable()) {
    throwIpcError('PERMISSION_DENIED', 'Cindy IM bots require a Cindy account.');
  }
}

/** Local/signed-out sessions must not observe a previous cloud owner's config. */
function disabledHookView(): SlackHookView {
  return {
    enabled: false,
    lifecycleAnnouncement: DEFAULT_SLACK_LIFECYCLE_ANNOUNCEMENT,
    url: getClientEndpoint('slackHookWsUrl'),
    workspaces: {},
    status: 'disabled',
    lastError: null,
    binding: null,
    bindings: [],
    pendingBind: null,
    serverMultiTeam: false,
    telegram: {
      enabled: false,
      url: getClientEndpoint('telegramHookWsUrl'),
      status: 'disabled',
      lastError: null,
      available: false,
      capabilityPending: false,
      binding: null,
      defaultWorkspace: null,
    },
    x: {
      enabled: false,
      url: getClientEndpoint('xHookWsUrl'),
      status: 'disabled',
      lastError: null,
      available: false,
      capabilityPending: false,
      binding: null,
      defaultWorkspace: null,
    },
  };
}

/**
 * Slack 绑定态会改变 lizi_slack 是否出现在 Codex 的冻结 MCP 清单里。
 *
 * 先软关 Codex app-server(含 busy turn 的 fail-closed 检查)，成功后再关 HTTP
 * bridge / 清 spawn cache；反过来会让仍在运行的 session 指向已停 bridge。
 * busy 时保留 pending 并低频重试，避免「绑定发生在 Codex turn 中」后必须重启
 * 整个 App 才能看到工具。多次快速翻转合并到同一条串行 drain，不并发 dispose。
 */
function requestCodexMcpRefreshForSlackAvailability(enabled: boolean): void {
  latestSlackToolProviderEnabled = enabled;
  codexMcpRefreshPending = true;
  if (codexMcpRefreshRetryTimer !== null) {
    clearTimeout(codexMcpRefreshRetryTimer);
    codexMcpRefreshRetryTimer = null;
  }
  void drainCodexMcpRefreshForSlackAvailability();
}

async function drainCodexMcpRefreshForSlackAvailability(): Promise<void> {
  if (codexMcpRefreshRunning) return;
  codexMcpRefreshRunning = true;
  try {
    while (codexMcpRefreshPending) {
      codexMcpRefreshPending = false;
      try {
        await restartCodexAfterAuthModeChange();
        await shutdownCodexEnvironment();
        log.info('Codex MCP environment refreshed after Slack provider availability changed', {
          enabled: latestSlackToolProviderEnabled,
        });
      } catch (err) {
        codexMcpRefreshPending = true;
        log.warn('Codex MCP refresh deferred after Slack provider availability changed', {
          enabled: latestSlackToolProviderEnabled,
          error: err instanceof Error ? err.message : String(err),
        });
        break;
      }
    }
  } finally {
    codexMcpRefreshRunning = false;
  }
  if (codexMcpRefreshPending && codexMcpRefreshRetryTimer === null) {
    codexMcpRefreshRetryTimer = setTimeout(() => {
      codexMcpRefreshRetryTimer = null;
      void drainCodexMcpRefreshForSlackAvailability();
    }, CODEX_MCP_REFRESH_RETRY_MS);
    codexMcpRefreshRetryTimer.unref?.();
  }
}

function broadcastStatus(view: SlackHookView): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed() && isAppContentWindow(w)) {
      w.webContents.send(HOOK_CONTROL_EVENT.STATUS_CHANGED, view);
    }
  }
}

function broadcastPrefs(view: HookPrefsView): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed() && isAppContentWindow(w)) {
      w.webContents.send(HOOK_CONTROL_EVENT.PREFS_CHANGED, view);
    }
  }
}

function broadcastProviderPrefs(view: ProviderPrefsView): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed() && isAppContentWindow(w)) {
      w.webContents.send(HOOK_CONTROL_EVENT.PROVIDER_PREFS_CHANGED, view);
    }
  }
}

/** Never persist raw account identity; region also isolates shared dev userData. */
function currentAccountFingerprint(): string | null {
  const userId = authManager.getCurrentUserId();
  if (!userId) return null;
  const fingerprintSource = `${CURRENT_CINDY_REGION}\0${userId}`;
  // userId is a public account identifier used only for local namespacing, not a password.
  // codeql[js/insufficient-password-hash]
  return createHash('sha256').update(fingerprintSource).digest('base64url').slice(0, 22);
}

/** prefs 往返错误 -> IPC 错误码(规则 13)。not-connected 文案随 provider 区分,
 *  Telegram 偏好查询失败不再误报 Slack Hook 断线(issue #279)。 */
function throwHookPrefsError(err: unknown): never {
  if (err instanceof HookNotConnectedError) {
    throwIpcError('HOOK_NOT_CONNECTED', hookNotConnectedIpcMessage(err.provider));
  }
  if (err instanceof HookPrefsTimeoutError) {
    throwIpcError(
      'HOOK_PREFS_TIMEOUT',
      'hook server did not answer prefs request (server too old or stalled)',
    );
  }
  throw err;
}

function ensureInstances(): { store: SlackHookStore; manager: HookControlManager } {
  if (!store) {
    store = createSlackHookStore({
      filePath: ownerScopedUserDataPath('slack-hook.json'),
      legacyFilePath: ownerScopedUserDataPath('hook-connections.json'),
      // 无覆写时跟随运行期端点清单(清单全权,烘焙兜底已随 2026-07 端点重构退役)
      defaultUrl: () => getClientEndpoint('slackHookWsUrl'),
      getAccountFingerprint: currentAccountFingerprint,
      // 旧多连接时代的 secret 加密文件按 id 清理(best-effort)
      cleanupLegacySecrets: (legacyIds) => {
        const dir = path.join(app.getPath('userData'), 'safe-storage');
        for (const legacyId of legacyIds) {
          try {
            fs.unlinkSync(path.join(dir, `hook-conn-${legacyId}.enc`));
          } catch {
            /* ENOENT ok */
          }
        }
      },
      log,
    });
  }
  if (!manager) {
    const dispatcher = createHookDispatcher({
      // 两个 provider 复用 dispatcher，但连接身份和服务地址彼此隔离。
      getConnection: (connectionId) => {
        const config = store!.get();
        // connectionId 形如 `slack:<账号指纹>:<provider>`(manager 的 dispatchId
        // 拼装, 指纹是 base64url 不含冒号)或裸 id(Slack legacy 线, 末段即
        // 'slack')—— 按末段解析 provider。未登记的 provider 返回 null,
        // dispatcher 按连接不存在拒绝(fail closed): 回落到 Slack 会让它读到
        // 错误的开关与端点。
        const provider = connectionId.split(':').pop() ?? '';
        const metaByProvider: Record<
          string,
          { name: string; url: string; enabled: boolean } | undefined
        > = {
          telegram: {
            name: `${BRAND_NAME} Telegram`,
            url: getClientEndpoint('telegramHookWsUrl'),
            enabled: config.telegramEnabled,
          },
          x: {
            name: `${BRAND_NAME} X`,
            url: getClientEndpoint('xHookWsUrl'),
            enabled: config.xEnabled,
          },
          slack: {
            name: `${BRAND_NAME} Slack`,
            url: store!.effectiveUrl(),
            enabled: config.enabled,
          },
        };
        const meta = metaByProvider[provider];
        if (!meta) return null;
        return {
          id: connectionId,
          name: meta.name,
          url: meta.url,
          enabled: meta.enabled,
          workspaces: config.workspaces,
          createdAt: 0,
        };
      },
      bindings: createHookBindingStore({
        filePath: ownerScopedUserDataPath('hook-bindings.json'),
        log,
      }),
      runner: createMakerHookSessionRunner({ log }),
      buildContextPrefix: buildGroupContextPrefix,
      // 新建 hook 会话默认预建独立 worktree(并发隔离); deps 组装与
      // maker-ipc/register.ts 的 use_worktree 分支同款。失败由 dispatcher
      // 回退共享目录。
      prepareWorktree: async (workingDir) => {
        try {
          const prep = await prepareHandoffWorktree(
            {
              getForSession: WorktreeManager.getForSession,
              listAll: WorktreeManager.listAll,
              detectCwd: WorktreeManager.detectCwd,
              suggestName: WorktreeManager.suggestName,
              listBranches: WorktreeManager.listBranches,
              createWorktree: WorktreeManager.createWorktree,
              createId: () => randomUUID(),
            },
            undefined, // hook 派发没有 dispatcher session, 直接从 workingDir 解析 base repo
            workingDir,
          );
          if (!prep.ok) return { ok: false, message: prep.message };
          return {
            ok: true,
            sessionId: prep.sessionId,
            path: prep.meta.path,
            cleanup: () => WorktreeManager.removeWorktreeForSession(prep.sessionId),
          };
        } catch (err) {
          return { ok: false, message: err instanceof Error ? err.message : String(err) };
        }
      },
      // 内置「对话」伪目录(chat): 与桌面端无项目对话同一套 app 托管目录
      dialogue: {
        rootDir: dialogueWorkspaceRootDir,
        allocateDir: async (sessionId) => ensureDialogueWorkspaceDir(sessionId, Date.now()),
      },
      // task.cancel 的中断出口: 与用户手动 Stop 同一条 session.abort() 路径
      abortSession: async (sessionId) => {
        const session = getMaker().getSession(sessionId);
        if (!session) return;
        try {
          getAgentIslandService()?.handleSessionStopped(
            sessionId,
            session.getCurrentTurnId?.() ?? null,
          );
        } catch (error) {
          log.warn('Agent Island session stop update failed before hook provider abort', {
            sessionId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        await session.abort();
      },
      // session.archive 的归档出口: 与 device-link 远程归档同一条
      // patchSessionMetaInDb 路径(落库 + sessions:patched 广播, sidebar 即时移出)
      archiveSessionRow: async (sessionId) => {
        await patchSessionMetaInDb(sessionId, { status: 'archived' });
      },
      // 交互卡按钮回流的配对出口(interaction.decision -> 挂起决策 resolve)
      resolveInteraction: resolveHookInteraction,
      // 「用户在桌面端点了重试 / 继续任务」信号 -> 把那一轮接回渠道原消息
      // (turn.reopen, 协议阶段 18)。信号由 maker 的发送事务发布。
      subscribeUiContinuation: onUiContinuation,
      subscribeUiSessionIntervention: onUiSessionIntervention,
      subscribeUiTurnDispatching: onUiTurnDispatching,
      subscribeUiTurnUndispatched: onUiTurnUndispatched,
      accountInitiallyActive: false,
      log,
    });
    manager = createHookControlManager({
      store,
      isAvailable: hookControlAvailable,
      createTransport: createHookTransport,
      getTelegramUrl: () => getClientEndpoint('telegramHookWsUrl'),
      getXUrl: () => getClientEndpoint('xHookWsUrl'),
      // 与 device-link 同款 token 源: 现值优先, 缺失 refresh 一次
      getAuthToken: async () => {
        if (!hookControlAvailable()) return null;
        const token = authManager.getAccessToken();
        if (token) return token;
        const ok = await authManager.refresh().catch(() => false);
        return ok ? authManager.getAccessToken() : null;
      },
      // upgrade 401 表示现有 accessToken 已被服务端拒绝；强制走一次 refresh，
      // transport 自带单次预算，成功后立即用新 token 重连。
      refreshAuthToken: () =>
        hookControlAvailable() ? authManager.refresh().catch(() => false) : Promise.resolve(false),
      deviceInfo: () => ({
        deviceId: authManager.getDeviceId(),
        deviceName: os.hostname(),
      }),
      agents: ['claude-code', 'codex'],
      notifyStatus: broadcastStatus,
      onSlackToolProviderEnabledChanged: requestCodexMcpRefreshForSlackAvailability,
      notifyPrefs: broadcastPrefs,
      notifyProviderPrefs: broadcastProviderPrefs,
      dispatcher,
      getAccountFingerprint: currentAccountFingerprint,
      accountInitiallyActive: false,
      listRecentSessions: () => listRecentHookSessions(store!.get().workspaces),
      // /model /effort 实时问答的数据源: 与会话内模型选择器**同一套规则**——
      // live providers(含自定义供应商 + 实时连接态)-> 仅已连接供应商 ->
      // 可见性过滤(renderer 镜像到 main 的 override + 目录 defaultEnabled,
      // 与 IM /model 同源), 拍平 first-wins 去重(visibleModelUnion)。
      // permissionModes 仍取 capabilities(运行时能力, 与供应商无关), server
      // 侧据此渲染权限档下拉(选中值经 dispatch options.permissionMode 回流)
      listAgentModels: async () => {
        const providers = await getDesktopProviderService().listProviders({ allowSideEffects: true });
        return (['claude-code', 'codex'] as const).map((agentKind) => {
          const models = visibleModelUnion(providers, agentKind, (providerId, m) =>
            isModelVisible(
              getModelVisibilityOverride(agentKind, providerId, m.id),
              m.defaultEnabled,
            ),
          );
          return {
            agentKind,
            models: models.map((m) => ({
              id: m.id,
              displayName: m.name,
              efforts: m.efforts,
              defaultEffort: m.defaultEffort,
              // 分组随行: 折扣版(gpt-budget)与官方版 displayName 故意同名,
              // Slack 卡与 Tina 下拉都靠 group 加区分后缀
              ...(m.group !== undefined ? { group: m.group } : {}),
            })),
            permissionModes: getMaker()
              .getCapabilities(agentKind)
              .permissionModes.map((pm) => ({ id: pm.id, displayName: pm.displayName })),
          };
        });
      },
      // 绑定授权链接: 用系统浏览器打开(远程控制时落被控机, 设置页另给复制链接)
      openExternalUrl: (url) => {
        void shell.openExternal(url);
      },
      openTelegramUrl: (url) => {
        const safeUrl = validateTelegramExternalUrl(url);
        return shell.openExternal(safeUrl);
      },
      openXUrl: (url) => {
        const safeUrl = validateXExternalUrl(url);
        return shell.openExternal(safeUrl);
      },
      log,
    });
    // Slack 网关工具桥: lizi_slack provider 经叶子注册表取用(不直接 import
    // 本模块, 避免 mcp-providers <-> ipc 的静态引用闭环)
    const m = manager;
    registerSlackToolBridge({
      availability: () =>
        hookControlAvailable()
          ? m.getSlackToolAvailability()
          : {
              connected: false,
              bound: false,
              serverSupportsTools: false,
              binding: null,
              multiTeam: false,
              bindings: [],
            },
      // teamId: (multi-team)以哪个 workspace 身份执行(lizi_slack 工具入参透传)
      callTool: (tool, args, teamId) =>
        hookControlAvailable()
          ? m.callSlackTool(tool, args, teamId)
          : Promise.resolve({
              ok: false as const,
              error: {
                code: 'PERMISSION_DENIED',
                message: 'Slack Hook requires a Cindy account.',
              },
            }),
    });
  }
  return { store, manager };
}

/** 把 store 的校验错误翻译为 IPC 错误, 其余原样抛出。 */
function translateValidation<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    if (err instanceof HookConnectionValidationError) {
      throwIpcError('INVALID_PARAMS', err.message);
    }
    throw err;
  }
}

/** IPC is a privilege boundary: only Cindy-owned top-level renderer frames may call it. */
function assertTrustedHookControlSender(event: IpcMainInvokeEvent): void {
  assertTrustedAppRendererEvent(event);
}

type HookControlIpcHandler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;

/** Register one fixed hook-control channel with the shared sender guard. */
function registerTrustedHookControlHandler(channel: string, handler: HookControlIpcHandler): void {
  ipcMain.handle(channel, (event, ...args) => {
    assertTrustedHookControlSender(event);
    return handler(event, ...args);
  });
}

/** 注册 IPC 并按配置 + 登录态拉起连接。bootstrap 里调用一次。 */
export function registerHookControlIpc(): void {
  registerTrustedHookControlHandler(HOOK_CONTROL_INVOKE.GET, () => ({
    hook: hookControlAvailable() ? ensureInstances().manager.snapshot() : disabledHookView(),
  }));

  // 开关即绑定(设置页 toggle 直接调, 无确认弹窗): 开 = 连接 + 置自动绑定意图
  // (连上后 main 自动发起 OIDC 弹浏览器); 关 = 解除绑定并断开(再开需重新
  // 浏览器授权)。取消"未安装 App"确认框也走关分支(作废 server 等安装登记)。
  // 编排全在 main(规则 9)。
  registerTrustedHookControlHandler(HOOK_CONTROL_INVOKE.SET_ENABLED, (_e, payload) => {
    requireHookControl();
    const { manager: m } = ensureInstances();
    const p = requireObject(payload);
    if (typeof p.enabled !== 'boolean') throwIpcError('INVALID_PARAMS', 'enabled must be boolean');
    if (p.enabled) {
      m.armAutoBind();
    } else {
      m.revokeAndDisconnect();
    }
    m.setProviderEnabled('slack', p.enabled);
    return { hook: m.snapshot() };
  });

  registerTrustedHookControlHandler(
    HOOK_CONTROL_INVOKE.SET_LIFECYCLE_ANNOUNCEMENT,
    (_e, payload) => {
      requireHookControl();
      const { manager: m } = ensureInstances();
      const p = requireObject(payload);
      if (typeof p.enabled !== 'boolean') {
        throwIpcError('INVALID_PARAMS', 'enabled must be boolean');
      }
      return setLifecycleAnnouncementFromIpc(m, p.enabled, log);
    },
  );

  registerTrustedHookControlHandler(HOOK_CONTROL_INVOKE.SET_PROVIDER_ENABLED, (_e, payload) => {
    requireHookControl();
    const { manager: m } = ensureInstances();
    const p = requireObject(payload);
    if (p.provider !== 'telegram' && p.provider !== 'x') {
      throwIpcError('INVALID_PARAMS', 'provider must be telegram or x');
    }
    if (typeof p.enabled !== 'boolean') throwIpcError('INVALID_PARAMS', 'enabled must be boolean');
    m.setProviderEnabled(p.provider, p.enabled);
    return { hook: m.snapshot() };
  });

  /** provider-neutral 绑定动作的 provider 形参校验(telegram / x)。 */
  const requireNeutralProvider = (payload: unknown): 'telegram' | 'x' => {
    const p = requireObject(payload);
    if (p.provider !== 'telegram' && p.provider !== 'x') {
      throwIpcError('INVALID_PARAMS', 'provider must be telegram or x');
    }
    return p.provider;
  };
  const providerDisplayName = (provider: 'telegram' | 'x'): string =>
    provider === 'telegram' ? 'Telegram' : 'X';

  registerTrustedHookControlHandler(HOOK_CONTROL_INVOKE.PROVIDER_BIND_START, (_e, payload) => {
    requireHookControl();
    const { manager: m } = ensureInstances();
    const provider = requireNeutralProvider(payload);
    if (!m.providerBindStart(provider)) {
      throwIpcError('HOOK_NOT_CONNECTED', `${providerDisplayName(provider)} provider is not connected`);
    }
    return { hook: m.snapshot() };
  });

  registerTrustedHookControlHandler(HOOK_CONTROL_INVOKE.PROVIDER_BIND_CANCEL, (_e, payload) => {
    requireHookControl();
    const { manager: m } = ensureInstances();
    const provider = requireNeutralProvider(payload);
    if (!m.providerBindCancel(provider)) {
      throwIpcError('HOOK_NOT_CONNECTED', `${providerDisplayName(provider)} binding attempt is not active`);
    }
    return { hook: m.snapshot() };
  });

  registerTrustedHookControlHandler(HOOK_CONTROL_INVOKE.PROVIDER_BIND_REVOKE, (_e, payload) => {
    requireHookControl();
    const { manager: m } = ensureInstances();
    const provider = requireNeutralProvider(payload);
    if (!m.providerBindRevoke(provider)) {
      throwIpcError('HOOK_NOT_CONNECTED', `${providerDisplayName(provider)} binding is not connected`);
    }
    return { hook: m.snapshot() };
  });

  registerTrustedHookControlHandler(
    HOOK_CONTROL_INVOKE.PROVIDER_OPEN_ACTION,
    async (_e, payload) => {
      requireHookControl();
      const { manager: m } = ensureInstances();
      const provider = requireNeutralProvider(payload);
      const p = requireObject(payload);
      const action = requireString(p.action, 'action');
      if (action !== 'connect' && action !== 'provider' && action !== 'add-to-group') {
        throwIpcError('INVALID_PARAMS', `invalid ${providerDisplayName(provider)} open action`);
      }
      try {
        if (!(await m.openProviderAction(provider, action))) {
          throwIpcError('INVALID_PARAMS', `${providerDisplayName(provider)} action is not available`);
        }
      } catch (err) {
        if (
          err instanceof Error &&
          (err.name === 'TelegramDeepLinkValidationError' || err.name === 'XLinkValidationError')
        ) {
          throwIpcError('INVALID_PARAMS', err.message);
        }
        throw err;
      }
      return { ok: true as const };
    },
  );

  registerTrustedHookControlHandler(HOOK_CONTROL_INVOKE.SET_WORKSPACES, (_e, payload) => {
    requireHookControl();
    const { store: s, manager: m } = ensureInstances();
    const p = requireObject(payload);
    const workspaces = requireObject(p.workspaces) as Record<string, string>;
    translateValidation(() => s.setWorkspaces(workspaces));
    // 别名清单变更要让 server 侧感知: 在线时直接重发 hello(server 以最新
    // 一帧为准, 连接不动 —— 整条重建会让设置页状态/偏好区闪烁); 未连接时
    // 回退重建, 下次建连的 hello 自带新清单
    if (!m.refreshHello()) m.sync();
    return { hook: m.snapshot() };
  });

  registerTrustedHookControlHandler(HOOK_CONTROL_INVOKE.SET_X_DEFAULT_WORKSPACE, (_e, payload) => {
    requireHookControl();
    const { store: s, manager: m } = ensureInstances();
    const p = requireObject(payload);
    // 只认显式的 null 或字符串: 这里的 null 是「清空默认目录」这个破坏性动作,
    // 把缺字段当 null 会让 renderer 的一次调用疏忽静默清掉用户已保存的设置。
    const alias = requireNullableString(p.alias, 'alias');
    translateValidation(() => s.setXDefaultWorkspace(alias));
    // 与 SET_WORKSPACES 同款: 默认目录也走 hello, 在线时重发一帧即可让 server
    // 感知(它以最新一帧为准), 不重建连接 —— 重建会让设置页状态与偏好区闪烁。
    if (!m.refreshHello()) m.sync();
    return { hook: m.snapshot() };
  });

  // 发起 Slack 账号绑定(SIWS OIDC): 经已连接的 WS 发 bind.start(无参); server
  // 回 bind.update(pending, authorizeUrl), main 打开系统浏览器并广播状态。
  registerTrustedHookControlHandler(HOOK_CONTROL_INVOKE.BIND_START, () => {
    requireHookControl();
    const { manager: m } = ensureInstances();
    if (!m.bindStart()) {
      throwIpcError('HOOK_NOT_CONNECTED', 'slack hook is not connected');
    }
    return { ok: true as const };
  });

  registerTrustedHookControlHandler(HOOK_CONTROL_INVOKE.BIND_REVOKE, () => {
    requireHookControl();
    if (!ensureInstances().manager.bindRevoke()) {
      throwIpcError('HOOK_NOT_CONNECTED', 'slack hook is not connected');
    }
    return { ok: true as const };
  });

  // ── (multi-team)多 workspace 绑定动作 ──────────────────────────────────
  // 全部要求 server 已宣告 multi-team(renderer 按 serverMultiTeam 隐藏入口,
  // 这里是防御性兜底); 动作失败按「能力缺失 / 不在线」双码区分(规则 13)。

  /** 能力检查 + 动作执行的公共体: false 一律翻译为结构化 IPC 错误。 */
  const runMultiTeamAction = (
    action: (mgr: HookControlManager) => boolean,
  ): { hook: SlackHookView } => {
    requireHookControl();
    const mgr = ensureInstances().manager;
    if (!mgr.snapshot().serverMultiTeam) {
      throwIpcError(
        'HOOK_MULTI_TEAM_UNSUPPORTED',
        'hook server does not support multi-team binding',
      );
    }
    if (!action(mgr)) {
      throwIpcError('HOOK_NOT_CONNECTED', 'slack hook is not connected');
    }
    return { hook: mgr.snapshot() };
  };

  registerTrustedHookControlHandler(HOOK_CONTROL_INVOKE.ADD_BINDING, () =>
    runMultiTeamAction((mgr) => mgr.addBinding()),
  );

  registerTrustedHookControlHandler(HOOK_CONTROL_INVOKE.REBIND_TEAM, (_e, payload) => {
    const p = requireObject(payload);
    const teamId = requireString(p.teamId, 'teamId');
    return runMultiTeamAction((mgr) => mgr.rebindTeam(teamId));
  });

  registerTrustedHookControlHandler(HOOK_CONTROL_INVOKE.REVOKE_TEAM, (_e, payload) => {
    requireHookControl();
    const p = requireObject(payload);
    const teamId = requireString(p.teamId, 'teamId');
    // displaced 行的删除是纯本地操作, 离线也要能删 —— 不做 multi-team 能力
    // 前置检查(manager 内部区分 displaced/活跃行)
    const mgr = ensureInstances().manager;
    if (!mgr.revokeTeam(teamId)) {
      throwIpcError('HOOK_NOT_CONNECTED', 'slack hook is not connected');
    }
    return { hook: mgr.snapshot() };
  });

  registerTrustedHookControlHandler(HOOK_CONTROL_INVOKE.CANCEL_PENDING_BIND, () => {
    requireHookControl();
    // 取消在途授权本地收口无条件成功(离线也能清), 不需要能力/在线检查
    const mgr = ensureInstances().manager;
    mgr.cancelPendingBind();
    return { hook: mgr.snapshot() };
  });

  // 目录偏好远程读写: 数据正本在 slack-hook-server 的 user_prefs(与 Slack
  // /model 卡同一份), 这里只是经 WS 往返的 adapter; 校验在协议层 + server。
  registerTrustedHookControlHandler(HOOK_CONTROL_INVOKE.PREFS_GET, async () => {
    requireHookControl();
    const { manager: m } = ensureInstances();
    try {
      return { prefs: await m.getWorkspacePrefs() };
    } catch (err) {
      throwHookPrefsError(err);
    }
  });

  registerTrustedHookControlHandler(HOOK_CONTROL_INVOKE.PREFS_SET, async (_e, payload) => {
    requireHookControl();
    const { manager: m } = ensureInstances();
    const p = requireObject(payload);
    const workspace = requireString(p.workspace, 'workspace');
    const rawPatch = requireObject(p.patch);
    const patch: HookPrefsPatch = {};
    for (const field of ['model', 'effort', 'agentKind', 'permissionMode'] as const) {
      const v = rawPatch[field];
      if (v === undefined) continue;
      if (v !== null && typeof v !== 'string') {
        throwIpcError('INVALID_PARAMS', `${field} must be a string or null`);
      }
      patch[field] = v as string | null;
    }
    // (multi-team)偏好归属 team: 可选; 缺省/null = 单绑定语境(server 侧按
    // 设备唯一绑定落值)
    const teamId =
      p.teamId === undefined || p.teamId === null ? null : requireString(p.teamId, 'teamId');
    try {
      return { prefs: await m.setWorkspacePrefs(workspace, patch, teamId) };
    } catch (err) {
      throwHookPrefsError(err);
    }
  });

  registerTrustedHookControlHandler(HOOK_CONTROL_INVOKE.PROVIDER_PREFS_GET, async (_e, payload) => {
    requireHookControl();
    const { manager: m } = ensureInstances();
    const provider = requireNeutralProvider(payload);
    try {
      return { prefs: await m.getProviderWorkspacePrefs(provider) };
    } catch (err) {
      throwHookPrefsError(err);
    }
  });

  registerTrustedHookControlHandler(HOOK_CONTROL_INVOKE.PROVIDER_PREFS_SET, async (_e, payload) => {
    requireHookControl();
    const { manager: m } = ensureInstances();
    const provider = requireNeutralProvider(payload);
    const p = requireObject(payload);
    const workspace = requireString(p.workspace, 'workspace');
    const rawPatch = requireObject(p.patch);
    const patch: HookPrefsPatch = {};
    for (const field of ['model', 'effort', 'agentKind', 'permissionMode'] as const) {
      const value = rawPatch[field];
      if (value === undefined) continue;
      if (value !== null && typeof value !== 'string') {
        throwIpcError('INVALID_PARAMS', `${field} must be a string or null`);
      }
      patch[field] = value as string | null;
    }
    try {
      return { prefs: await m.setProviderWorkspacePrefs(provider, workspace, patch) };
    } catch (err) {
      throwHookPrefsError(err);
    }
  });

  // 工作目录模型来源偏好: 纯本地文件, 不经 WS(来源是纯客户端维度, server 零感知)。
  registerTrustedHookControlHandler(
    HOOK_CONTROL_INVOKE.WORKSPACE_PROVIDER_SOURCE_GET,
    async () => ({ entries: listWorkspaceProviderSources() }),
  );

  registerTrustedHookControlHandler(
    HOOK_CONTROL_INVOKE.WORKSPACE_PROVIDER_SOURCE_SET,
    async (_e, payload) => {
      const p = requireObject(payload);
      const channel = requireString(p.channel, 'channel');
      if (channel !== 'slack' && channel !== 'telegram' && channel !== 'x') {
        throwIpcError('INVALID_PARAMS', 'channel must be slack, telegram or x');
      }
      // 输入设界(codex review): 即使 renderer 被攻破, 也不允许任意长度/格式的键
      // 无限追加条目撑爆本地文件 —— workspace 按别名正则(与 prefs 同规), 其余限长。
      const workspace = requireString(p.workspace, 'workspace');
      if (!HOOK_WORKSPACE_ALIAS_RE.test(workspace)) {
        throwIpcError('INVALID_PARAMS', 'workspace must match the alias format');
      }
      const teamId =
        p.teamId === undefined || p.teamId === null ? null : requireString(p.teamId, 'teamId');
      if (teamId !== null && teamId.length > 64) {
        throwIpcError('INVALID_PARAMS', 'teamId too long');
      }
      const providerId =
        p.providerId === undefined || p.providerId === null
          ? null
          : requireString(p.providerId, 'providerId');
      if (providerId !== null && providerId.length > 128) {
        throwIpcError('INVALID_PARAMS', 'providerId too long');
      }
      // 条目总量上限(codex review): 键合法性校验挡不住海量唯一 teamId 的无限
      // 追加 —— 新增(非替换/删除)且已达上限时拒绝。按精确键判新增(不能用
      // getWorkspaceProviderSource, 它的 teamId null 兜底会把新 team 误判为已存在)。
      const existing = listWorkspaceProviderSources();
      const isReplace = existing.some(
        (e) => e.channel === channel && e.teamId === teamId && e.workspace === workspace,
      );
      if (
        providerId !== null &&
        !isReplace &&
        existing.length >= HOOK_WORKSPACE_PROVIDER_SOURCE_MAX_ENTRIES
      ) {
        throwIpcError('INVALID_PARAMS', 'too many workspace provider source entries');
      }
      // fs 异常在 IPC 边界翻译(codex review): 只读盘/满盘/rename 失败的原始
      // 异常含 owner-scoped 绝对路径, 不得未脱敏穿透给 renderer;统一走
      // throwIpcError 协议给稳定错误码, 细节留 main 日志。
      let entries: ReturnType<typeof setWorkspaceProviderSource>;
      try {
        entries = setWorkspaceProviderSource(channel, teamId, workspace, providerId);
      } catch (err) {
        log.warn(
          `workspace provider source write failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        throwIpcError('INTERNAL', 'failed to persist workspace provider source');
      }
      // 多窗口同步(codex review): 会话副窗也能开设置页, 写后全窗口广播全量条目。
      for (const w of BrowserWindow.getAllWindows()) {
        if (!w.isDestroyed() && isAppContentWindow(w)) {
          w.webContents.send(HOOK_CONTROL_EVENT.WORKSPACE_PROVIDER_SOURCE_CHANGED, entries);
        }
      }
      return { entries };
    },
  );

  // Account teardown is orchestrated before its DB closes. This listener is a
  // fail-closed backstop for signed-out/local sessions; activation waits for
  // the next owner DB readiness callback (with app:ready-for-bot as a
  // compatibility retry).
  observedAuthRealm = authManager.getActiveAuthRealm();
  disposeAuthListener = authManager.onAuthStateChange(() => {
    const nextRealm = authManager.getActiveAuthRealm();
    const realmChanged = observedAuthRealm !== null && observedAuthRealm !== nextRealm;
    observedAuthRealm = nextRealm;
    if (!hookControlAvailable()) {
      void stopHookControlAccount().catch((err: unknown) => {
        log.warn(
          `hook-control account deactivation failed (${err instanceof Error ? err.name : 'unknown'})`,
        );
      });
    } else if (realmChanged) {
      // manager.sync() 同时 dispose 两条旧 transport，并用当前清单重读
      // Slack / Telegram URL；authManager 已在发通知前提交新 token。
      manager?.sync();
    }
  });

  log.info('hook-control ipc registered');
}

/** Called after the current account DB is ready; app:ready-for-bot may retry it. */
export function startHookControlAccount(): void {
  if (!hookControlAvailable()) return;
  // 群窗口 TTL 兜底清扫在 manager.activateAccount 内执行(纳入账号级
  // pendingAccountOps, 登出/切号不打断在途落库)。
  ensureInstances().manager.activateAccount();
}

/** Close hook ingress before the old account DB is disposed. */
export async function stopHookControlAccount(): Promise<void> {
  if (manager) await manager.deactivateAccount();
}

/** Stop and discard all state tied to the current data owner; IPC stays registered. */
export function resetHookControlOwnerBoundary(): void {
  unregisterSlackToolBridge();
  resetGroupContextCursors();
  manager?.dispose();
  manager = null;
  store = null;
}
export function disposeHookControl(): void {
  codexMcpRefreshPending = false;
  if (codexMcpRefreshRetryTimer !== null) {
    clearTimeout(codexMcpRefreshRetryTimer);
    codexMcpRefreshRetryTimer = null;
  }
  disposeAuthListener?.();
  disposeAuthListener = null;
  observedAuthRealm = null;
  resetHookControlOwnerBoundary();
}
