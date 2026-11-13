import { randomUUID } from 'node:crypto';
import { permissionModeOrAsk } from '@cindy/maker-shared/permission-mode';
import { gateBuiltinMcpProviders } from './provider-gate.js';
import { createIMessageMcpServer } from './imessageMcpServer';
import { createTerminalToolExecutor } from '../terminal/terminalToolAccess.js';
import { createFileToolExecutor } from '../cindy-brain/fileToolAccess.js';
import { getGhostFsSlot, getGhostStorageService } from '../cindy-brain/index.js';
import { createStorageToolExecutor } from '../cindy-brain/storageToolAccess.js';
import { getDesktopHostTerminalService } from '../terminal/terminalService.desktop.js';
import { getDefaultShellPref } from '../terminal/terminalPrefsStore.js';
import { findGhostForInstanceId } from '../cindy-brain/index.js';
import { searchGhostRuntimeMemories } from '../cindy-brain/index.js';
import { getPiKernelManager } from '../agent-binaries/index.js';
import { PiKernelError } from '../agent-binaries/pi-kernel-manager.js';
import { manageAppSettings } from '../app-settings/sections.js';
import { importThemePackageFromTask } from '../local-themes/agent.js';
import { manageAppModels } from '../app-settings/models.js';
import { classifyOrigin } from '../input-handoff/originPolicy.js';
import { inspectAppDefaultModel, changeAppDefaultModel } from '../maker-ipc/appDefaultModelControl.js';
import { hostname } from 'node:os';
import { isSessionSharedTaskActive } from '../device-link/sharedTaskDispatch.js';
import { listMachines, type MachineDirectoryDeps } from '../machines/directory.js';
import { readLocalMachineStatus } from '../machines/localStatus.js';
import { SSH_STATUS_COMMAND } from '../machines/sshStatus.js';
import { readGithub, manageGithubPrs } from '../git-context/githubReadRuntime';
import type { GithubReadMethod } from '@cindy/maker-shared';
import { getDeviceId } from '../authManager.js';
import { buildHistorySessionDeepLink } from '../deepLink.js';
import { activeCompanionCloud } from '../companion-cloud/runtime.js';
import { t } from '../i18n.desktop.js';
import { executeTaskTags } from '../localDb/ipc/taskTags.js';
import { getPluginMarketService } from '../plugin-market/service.js';
import { resolveHelperSurface } from './helperSurface.js';
import { createProject } from './createProject.js';
import { createMoveSession } from './moveSession.js';
import { createTaskWorktreeHost } from './createTaskWorktree.js';
import { sessionImportCallbacks } from '../session-import/agentTools.js';
import { listProjects, renameProject, removeProject, readCurrentSessionProject } from './projectManagement.js';
import { activeOwnerScopeKey, getActiveDataOwnerPushStamp, isAppSessionBoundaryPending, ownerScopedUserDataPath } from '../appSessionState.js';
import { botProfileDir } from '../maker-ipc/botProfileFolder.js';
import type { createBotCapabilityService } from '../maker-ipc/botCapabilityService.js';
import { join as pathJoin } from 'node:path';
import { homedir } from 'node:os';
import { app } from 'electron';
import { and, eq, isNull } from 'drizzle-orm';

import {
  createLiziMcpProviders,
  resolveLiziMcpSessionContext,
  setSessionPathAuthorizer,
  type LiziMcpProvider,
  type LiziMcpSessionContext,
  type LspServerPool,
  type XdtHelperMcpDeps,
  type SshHostSnapshotLike,
} from '@cindy/mcps';
import type { OrcaMcpDeps } from '@cindy/mcps';
import type { Schedule } from '@cindy/maker-scheduler';
import { createCindyGhostsMcpServer } from 'cindy-tools';
import type { MakerMemoryManager } from '@cindy/maker-core';
import {
  authorizeDesktopSessionPath,
  getCindyGhostsMcpDeps,
  type GhostGrantLiveSessionState,
  type CindyGhostsHostDeps,
  type ToolResultImageDescription,
} from './ghost.desktop.js';
import { createGroupHistoryMcpServer } from './groupHistoryMcpServer.js';
import { compressInlineImage } from './inlineImageCompressor.js';
import { createTelegramBotMcpServer } from './telegramBotMcpServer.js';
import { renderHtmlToPdf } from '../doc-tools/htmlPdfRenderer.js';
import { writeDocsOutput } from '../doc-tools/docsOutputWriter.js';
import { inspectPdf } from '../doc-tools/pdfInspector.js';
import { getAndroidMcpDeps } from './android.js';
import { getBrowserMcpDeps } from './browser.desktop.js';
import { getComputerMcpDeps } from './computer.desktop.js';
import { feishuIm, wechatIm } from '../im';
import { getBotFeishuTransport } from '../im/shared/botImConnectionRuntime';
import { createFeishuTransportResolver } from './feishuTransportRouting';
import { readChannelToolScope } from '../im/shared/channelToolScope';
import { hasImChannelVendorOptions } from '../../shared/botImConnection.js';
import { sendFeishuSessionNotification } from '../im/feishu/notificationOrigin';
import { getSlackToolBridge } from '../hook-control/slackToolBridge.js';
import { createLogger } from '../logger.js';
import { createAgentAppUpdateCallbacks } from '../agent-app-update/index.js';
import { getScheduler } from '../scheduler-host/index.desktop.js';
import { getScheduleWebhookHost, scheduleWebhookReceiver } from '../scheduler-host/webhook/runtime.js';
import { stabilizeHookCommand } from '../scheduler-host/hook-script-generator.js';
import { assertPreRunHookCommandSyntax } from '../scheduler-host/pre-run-hook.js';
import { searchSessionsWithBotScope } from '../maker-host/session-search.js';
import { readLspModeSettings } from '../maker-host/lsp-mode-store.js';
import {
  tryGetBotDirectMessageService,
  tryGetOrcaCollabService,
  isSessionInTurn,
  getTaskActionInputState,
  isActiveInputAccountScoped,
  getTaskActionSession,
  confirmTaskAction,
  requestMcpSetupForSession,
} from '../maker-ipc/register.js';
import { createBotProfile } from '../localDb/ipc/bots.js';
import { readTeammateDirectory } from '../localDb/teammateDirectory.js';
import { readDesktopHistoryAttachment } from './historyAttachment.desktop.js';
import { submitGithubIssueForSession } from '../github-issue/index.js';
import {
  isDbClientNotReadyError,
  getDbClient,
  tryGetDbClient,
  getCurrentDbClientSnapshot,
} from '../localDb/client/current.js';
import {
  listBotSkillsForSession,
  saveBotSkillForSession,
} from '../maker-ipc/botSkillService.js';
import { captureBotCreatedTaskResponsibility } from '../maker-ipc/botTaskCreation.js';
import { runBotProjectsTool } from '../maker-ipc/botLinkedProjects.js';
import { createTaskDigestReader } from './taskDigest.js';
import { createDesktopTaskDigestDeps } from './taskDigestHost.js';
import { createTaskToolCallAuthorizer } from '../maker-ipc/taskToolCallAuthorizer.js';
import { createHistoryToolCallbacks } from './historyToolCallbacks.js';
import { authorizePluginHostToolCall, getPluginHostToolCaller, hostServiceCatalog, setHostToolProviders } from './hostToolCaller.js';
import { createHostServiceToolExecutor } from '../cindy-brain/hostServiceCatalog.js';
import { createDesktopTaskActionAuthorizer } from '../maker-ipc/taskActionHost.js';
import { forkTaskAtMessage } from '../maker-ipc/fork.js';
import { commitTaskRewind } from '../maker-ipc/rewind.js';
import { authorizeGroupTool, reportGroupTaskCreated } from '../maker-ipc/botGroupToolAuthorization.js';
import { createSharedTaskTools } from './sharedTaskTools.js';
import { assertTaskActionCurrent, captureTaskActionSyncGuard } from '../maker-ipc/taskActionAuthorization.js';
import {
  getSessionRowSnapshot,
  patchSessionMetaInDb,
  renameSessionTitlesInDb,
  setSessionsStatusInDb,
} from '../localDb/ipc/sessions.js';
import { getInputHandoffService } from '../input-handoff/service.js';
import { isInputHandoffDisabledForSession } from '../input-handoff/botPolicy.js';
import { readHandoffPicture } from '../input-handoff/pictureRef.js';
import { isIpcError } from '../../shared/ipc-errors.js';
import type { PluginRegistry } from '../maker-host/plugins/plugin-registry.js';
import { BUILTIN_LIZI_MCP_IDS } from '../maker-host/plugins/builtin-plugins.js';
import {
  type ChatHistoryReaderDeps,
} from './remoteChatHistory.js';
import { botSessionLinks, sessions } from '../localDb/schema.js';
import { createSchedulerRemoteDeps } from './schedulerDevices.js';
import { createRemoteSessionHandoff } from './sessionHandoffRemote.js';
import { createRemoteSessionsStatusSetter, remoteSessionMutationFailure } from './sessionStatusRemote.js';
import { DeviceLinkError } from '@cindy/device-link';
import { MAKER_INVOKE } from '../maker-ipc/channels.js';
import { isCindyLearnSkillEnabled } from '../skillhub/activationPreferences.js';
import { botLearningTracker } from '../maker-ipc/botLearningTracker.js';
import { getLearnController } from '../learn-host/index.js';
import { HELP_KNOWLEDGE } from '../maker-ipc/helpKnowledge.generated.js';
import { consumeLearnInvocationGrant } from '../learn-host/invocationGrant.js';
import { createSkillhubAgentTools } from '../skillhub/agentTools.js';
import { startGrokDeviceLogin, grokDeviceLoginStatus, cancelGrokDeviceLogin } from '../maker-host/grok-device-login-service.js';
import { resolveSessionTeammate } from '../maker-ipc/sessionTeammate.js';

export interface DesktopMcpProvidersDeps {
  askUserQuestionAsync?: XdtHelperMcpDeps['askUserQuestionAsync'];
  manageUserQuestions?: XdtHelperMcpDeps['manageUserQuestions'];
  runtimeCapabilities?: XdtHelperMcpDeps['runtimeCapabilities'];
  botCapabilities: Pick<ReturnType<typeof createBotCapabilityService>, 'list' | 'select'> & Partial<Pick<ReturnType<typeof createBotCapabilityService>, 'models' | 'setDefaultModel'>>;
  createMediaDownloadContext?: CindyGhostsHostDeps['createMediaDownloadContext'];
  /** 当前 Desktop 版本，供 Forge 为具体插件包生成默认 minCindyVersion。 */
  getAppVersion?: () => string;
  getMakerMemoryManager: () => MakerMemoryManager;
  lspPool: LspServerPool;
  /** Current owner's registry; may be a getter, so do not capture it at construction. */
  readonly pluginRegistry: PluginRegistry;
  /** Device-link transport stays host-injected so provider tests do not load Electron runtime services. */
  invokeRemote: (
    deviceId: string,
    channel: string,
    args: unknown[],
    options?: { preSend?: () => void },
  ) => ReturnType<ChatHistoryReaderDeps['invokeRemote']>;
  historyRemote?: import('@cindy/mcps').HistoryRemoteDeps;
  captureSharedTaskCommand?: (sessionId: string, assertCurrent: () => void) => (command: import('@cindy/device-link').SharedTaskHostCommand) => Promise<unknown>;
  /** list_machines：账号下的电脑从这里读，SSH 主机与本机资源在这个文件里接。 */
  machineDirectory?: Pick<MachineDirectoryDeps, 'listDevices' | 'invokeStatus'>;
  /** 插件文件交接只认活跃 Session 的实时权限；缺失时由 ghost.ts fail closed。 */
  getLiveSessionGrantState?: (
    sessionId: string,
    sessionInstanceId: string,
  ) => GhostGrantLiveSessionState | null;
  /** Agent 发起插件安装时向该任务投宿主权限确认卡；缺失时安装 fail closed。 */
  requestHostPermission?: CindyGhostsHostDeps['requestHostPermission'];
  /** Reject stale, remote, or already-closed Session tool contexts. */
  isCurrentLocalSessionInstance?: (
    sessionId: string,
    sessionInstanceId: string | undefined,
  ) => boolean;
  /** Current live session, including sessions whose agent runs over SSH. */
  isCurrentGrokLoginCaller?: (sessionId: string, sessionInstanceId: string) => boolean;
  /** 把工具结果图片转成文字描述（视觉桥，最佳努力）。缺失 = 不处理。
   *  返回结构区分「有意跳过」(skipped:true, 视觉桥未开/模型不命中, 不告警)与
   *  「真正尝试但失败」(skipped:false + null, 计入 attemptedCount 供告警)。 */
  describeToolResultImage?: (input: {
    imageUrl: string;
    sessionId: string | null;
    sessionInstanceId: string | null;
    signal?: AbortSignal;
  }) => Promise<ToolResultImageDescription>;
  /** 工具结果图片全部描述失败时回调（视觉桥不可用告警）。缺失 = 不告警。 */
  onToolResultImagesFailed?: (sessionId: string, attemptedCount: number) => void;
}

/**
 * 当前 tool-call 所属的飞书逐轮作用域(个人 bot 或伙伴自有连接), 没有就是 null。
 * 用 sessionId + sessionInstanceId 查租约: 旧实例借不到新实例的权限。
 */
function readFeishuTurnScope(
  session: { sessionId?: string; sessionInstanceId?: string } | undefined,
) {
  const scope = readChannelToolScope({
    sessionId: session?.sessionId,
    sessionInstanceId: session?.sessionInstanceId,
  });
  return scope?.channel === 'feishu' ? scope : null;
}

const feishuTransportFor = createFeishuTransportResolver({
  readTurnScope: readFeishuTurnScope,
  getCompanionTransport: getBotFeishuTransport,
  personalIm: feishuIm,
});

export function createDesktopMcpProviders(deps: DesktopMcpProvidersDeps): LiziMcpProvider[] {
  setSessionPathAuthorizer((request) =>
    authorizeDesktopSessionPath(request, deps.getLiveSessionGrantState),
  );
  // 代输入 gates shared by window and picture handoffs: a current local task,
  // the service, and the teammate switch (unknown policy fails closed).
  const admitInputHandoff = async (context: { sessionId?: string; sessionInstanceId?: string }) => {
    if (!context.sessionId || !deps.isCurrentLocalSessionInstance?.(context.sessionId, context.sessionInstanceId))
      return { ok: false as const, errorCode: 'NO_SESSION_CONTEXT', message: 'This task is no longer current.' };
    const service = getInputHandoffService();
    if (!service) return { ok: false as const, errorCode: 'CAPABILITY_NOT_AVAILABLE', message: 'Input handoff is not ready yet.' };
    if (await isInputHandoffDisabledForSession(context.sessionId).catch(() => true))
      return {
        ok: false as const,
        errorCode: 'DISABLED_BY_OWNER',
        message: 'The user turned off input handoff for this buddy. Tell the user what is still needed instead.',
      };
    const row = await getSessionRowSnapshot(context.sessionId).catch(() => null);
    return { ok: true as const, service, sessionId: context.sessionId, requester: row?.title?.trim().slice(0, 120) };
  };
  let redactSshText: ((snapshot: SshHostSnapshotLike, text: string) => string) | undefined;
  const loadRemoteSsh = async () => {
    const remoteSsh = await import('../remote-ssh/index.js');
    redactSshText = (snapshot, text) =>
      remoteSsh.redactSshSensitiveText(snapshot.config, text);
    return remoteSsh;
  };

  // 辅助桥接 OrcaCollabService → OrcaMcpDeps / sendToSession，
  // 并在边界捕获 HOST_NOT_READY / INTERNAL。
  function wrap<Args extends unknown[], R>(fn: (svc: NonNullable<ReturnType<typeof tryGetOrcaCollabService>>, ...args: Args) => Promise<R>): (...args: Args) => Promise<R> {
    return async (...args) => {
      const s = tryGetOrcaCollabService();
      if (!s) return { ok: false, errorCode: 'HOST_NOT_READY' as const, message: 'orca collab service not initialized' } as R;
      try { return await fn(s, ...args); }
      catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const errorCode = isDbClientNotReadyError(err) ? 'HOST_NOT_READY' : 'INTERNAL';
        return { ok: false, errorCode, message } as R;
      }
    };
  }

  const remoteSessionHandoff = deps.historyRemote
    ? createRemoteSessionHandoff({
        captureRequest: async (id, text, target) => (await import('../maker-ipc/register.js')).captureSessionAgentRequest(id, text, target),
        captureAccess: deps.historyRemote.captureAccess,
        invoke: deps.invokeRemote,
      })
    : null;
  // 跨电脑投递的来源:发起任务的 id 与标题(对方按「由任务「X」发送」标注来源)。
  const remoteHandoffSender = async (dispatcherSessionId: string | undefined) => {
    if (!dispatcherSessionId) {
      const plugin = getPluginHostToolCaller();
      if (!plugin) throw new Error('NO_SESSION_CONTEXT');
      return { kind: 'plugin' as const, pluginId: plugin.caller.pluginId };
    }
    const dbClient = tryGetDbClient();
    const [row] = dbClient
      ? await dbClient.drizzle.select({ title: sessions.title }).from(sessions)
        .where(eq(sessions.id, dispatcherSessionId)).limit(1).catch(() => [])
      : [];
    return { sessionId: dispatcherSessionId, ...(row?.title ? { title: row.title } : {}) };
  };

  const readTaskDigest = createTaskDigestReader(createDesktopTaskDigestDeps({
    invokeRemote: deps.invokeRemote,
    ...(deps.historyRemote ? { listDevices: deps.historyRemote.listDevices } : {}),
    getSessionRuntime: async (sessionId) => {
      const svc = tryGetOrcaCollabService();
      return svc ? svc.getSessionRuntime({ targetSessionId: sessionId }) : { ok: false as const };
    },
    listSessionQueuedCounts: async (sessionIds) => {
      const svc = tryGetOrcaCollabService();
      return svc ? svc.listSessionQueuedCounts(sessionIds) : { ok: false as const };
    },
    // git-context 牵连 Electron 窗口广播,按需加载,不让工具装配一引用就把它带进来。
    readSessionPrStatuses: async (sessionId) =>
      (await import('../git-context/ipc.js')).readSessionPrStatuses(sessionId),
    readRuntimeFacts: async (sessionId) => {
      const [{ getMakerIfReady }, { getSessionLastLiveUsage }] = await Promise.all([
        import('../maker-host/index.js'),
        import('../maker-ipc/sessionLastLiveUsage.js'),
      ]);
      const session = getMakerIfReady()?.getSession(sessionId);
      // 原样交出两份运行时读数,可信用量由 deriveFollowUpUsage 统一推导。
      const pick = (usage: { contextTokens: number; contextWindow: number } | null | undefined) =>
        usage ? { contextTokens: usage.contextTokens, contextWindow: usage.contextWindow } : null;
      const live = pick(session?.getUsageSnapshot());
      const closed = pick(getSessionLastLiveUsage(sessionId));
      const terminal = session?.getObservedCurrentTurnTerminal();
      return {
        live,
        closed,
        terminalError: terminal?.kind === 'error'
          ? {
            ...(terminal.sdkError ? { sdkError: terminal.sdkError } : {}),
            ...(terminal.codexErrorInfo ? { codexErrorInfo: terminal.codexErrorInfo } : {}),
            ...(typeof terminal.errorStatus === 'number' ? { errorStatus: terminal.errorStatus } : {}),
          }
          : null,
      };
    },
  }));

  const remoteSessionId = (sessionId: string, device?: string): string => {
    if (!device || device === 'local') return sessionId;
    const separator = sessionId.indexOf('::');
    if (separator < 0) return sessionId;
    const prefix = sessionId.slice(0, separator);
    const localId = sessionId.slice(separator + 2);
    return prefix === device && localId ? localId : sessionId;
  };

  // Share the installer's directory resolver with its reviewed target snapshot.
  // A remote target must be read from that computer; resolving its session id
  // against this Mac would approve the wrong cwd.
  const resolveHookSessionWorkDir = async (sessionId: string, device?: string) => {
    if (device && device !== 'local') {
      if (!deps.historyRemote) throw new Error('SCHEDULE_DEFINITION_UNAVAILABLE');
      let assertAccess: (() => void) | undefined;
      try {
        assertAccess = deps.historyRemote.captureAccess();
        const response = await deps.invokeRemote(
          device,
          'local-db:sessions:get',
          [remoteSessionId(sessionId, device)],
          { preSend: assertAccess },
        );
        assertAccess();
        if (!response.ok) {
          const code = response.error && typeof response.error === 'object' && 'code' in response.error
            ? String((response.error as { code?: unknown }).code ?? '') : '';
          if (code === 'NOT_FOUND') return undefined;
          throw new Error('SCHEDULE_DEFINITION_UNAVAILABLE');
        }
        const row = response.result && typeof response.result === 'object' && !Array.isArray(response.result)
          ? response.result as { workingDir?: unknown }
          : null;
        return typeof row?.workingDir === 'string' && row.workingDir.trim() ? row.workingDir : undefined;
      } catch (error) {
        if (error instanceof Error && error.message === 'SCHEDULE_DEFINITION_UNAVAILABLE') throw error;
        throw new Error('SCHEDULE_DEFINITION_UNAVAILABLE');
      }
    }
    try {
      const { getMaker } = await import('../maker-host/index.js');
      const meta = await getMaker().getSessionMeta(sessionId);
      return meta?.workDir?.trim() ? meta.workDir : undefined;
    } catch {
      return undefined;
    }
  };

  const authorizeTaskToolCall = createTaskToolCallAuthorizer({
    authorizePluginCall: authorizePluginHostToolCall,
    getDb: () => (isAppSessionBoundaryPending() ? null : tryGetDbClient()),
    isScopeCurrent: (db) => !isAppSessionBoundaryPending() && db === tryGetDbClient(),
    authorizeAction: createDesktopTaskActionAuthorizer({
      input: getTaskActionInputState, getSession: getTaskActionSession, confirm: confirmTaskAction,
    }),
  });
  const botReadsAccountHistory = async (sessionId: string | undefined): Promise<boolean> => {
    if (!sessionId && getPluginHostToolCaller()) return true;
    return (await authorizeTaskToolCall({ sessionId, server: 'cindy_helper', tool: 'history', args: {} })).ok;
  };

  const withAccountDataAccess = async <T>(sessionId: string | undefined, operation: (assertCurrent: () => Promise<void>) => Promise<T>): Promise<T> => {
    const dbClient = tryGetDbClient();
    const plugin = !sessionId ? getPluginHostToolCaller() : undefined;
    if (!dbClient || (!sessionId && !plugin)) throw new Error('Account data caller unavailable');
    const assertAccess = async () => {
      plugin?.assertCurrent();
      if (isAppSessionBoundaryPending() || dbClient !== tryGetDbClient()) throw new Error('Account changed');
      if (sessionId && await resolveHelperSurface(dbClient, sessionId) === 'restricted')
        throw new Error('Account data is unavailable for this task');
      if (isAppSessionBoundaryPending() || dbClient !== tryGetDbClient()) throw new Error('Account changed');
    };
    await assertAccess();
    const result = await operation(assertAccess);
    await assertAccess();
    return result;
  };

  const providers = createLiziMcpProviders({
    // 先传完整内置列表；按会话启停由下面的 isEnabled 包装处理。
    enabled: BUILTIN_LIZI_MCP_IDS,
    android: getAndroidMcpDeps({
      isAndroidAutomationEnabled: (context) =>
        // Codex provider presence is the bridge-creation enablement snapshot.
        // Keep that snapshot for a busy turn when a disable refresh is deferred;
        // a successfully rebuilt bridge omits this provider via the outer gate.
        context?.agentKind === 'codex' || deps.pluginRegistry.isEnabled('android'),
    }),
    browser: getBrowserMcpDeps(),
    computer: getComputerMcpDeps({
      isComputerUseEnabled: (context) =>
        context?.agentKind === 'codex' || deps.pluginRegistry.isEnabled('computer'),
    }),
    // lizi_feishu 已于 2026-07-16 摘壳:飞书能力(44 精品 + 123 只读直通)迁入
    // 内置意识 xd-feishu;2026-07-17 起授权切到意识 OAuth broker
    // (tokenBroker:'feishu'),主机 token 刷新链(mcp-integrations/feishu.ts)
    // 与 scheduler registry 直调一并退役(scheduler 飞书方法走 ghost pipe)。
    // mivo 已于 2026-07-13 退役:整体迁入内置意识 xd-mivo(见 xd-mivo/ghost.json)。
    // slack 官方 MCP 已于 2026-07-15 退役(迁入内置意识 cindy-slack,授权走
    // oauth-broker 的 slack provider;老账号由 slackAccountsMigration 无感搬入)。
    // lizi_jira / lizi_confluence 已于 2026-07-14 退役(迁入内置意识 xd-atlassian,
    // 授权走 XDT server broker;历史附件的 xdt-image 冻结读取见 imageCacheStore)。
    // lizi_github 已于 2026-07-14 退役(迁入内置意识 cindy-github;老 PAT 由
    // githubAccountsMigration 无感搬进意识保险库)。
    // lizi_gitlab 已于 2026-07-14 退役(迁入内置意识 cindy-gitlab;老 PAT +
    // 实例地址由 gitlabAccountsMigration 无感搬进意识多连接声明)。
    feishuBot: {
      // 轮次内直通工具的作用域: 逐轮租约(im/shared/channelToolScope.ts), 不来自模型参数;
      // 非飞书轮次 / 轮次已结束为 null, 工具 fail closed。
      readLaneScope: (session) => {
        const scope = readFeishuTurnScope(session);
        if (!scope) return null;
        return {
          im: scope.im,
          laneUserId: scope.laneUserId,
          chatId: scope.chatId,
          threadId: scope.threadId,
          chatKind: scope.chatKind,
          requesterIsOwner: scope.requesterIsOwner,
          triggerMessageId: scope.triggerMessageId,
          companion: scope.companion,
        };
      },
      // Fallback receiver for send_message_to_user / send_file_to_user when
      // the current session isn't a feishu one — semantically "notify the
      // bot's human owner". Same TOFU accessor scheduler completion
      // notifications use; returns null before the user has DM'd the bot.
      getOwnerOpenId: async (session) => {
        const { im, assertCurrent } = await feishuTransportFor(session);
        assertCurrent();
        return im.getOwnerOpenId();
      },
      sendFile: async (chatId: string, absPath: string, displayName?: string, session?) => {
        try {
          const { im, assertCurrent } = await feishuTransportFor(session, chatId);
          assertCurrent();
          return await im.sendFile(chatId, absPath, displayName);
        } catch (err) {
          createLogger('mcp/cindy_feishu_bot').warn(
            'sendFile failed target=...%s detail=%s',
            chatId.slice(-8),
            err instanceof Error ? err.message : String(err),
          );
          return { ok: false, reason: 'SEND_FAIL' };
        }
      },
      // sendMarkdownText throws on any SDK/network failure — wrap it into the
      // {ok, reason} shape the MCP tool handler expects so the handler stays
      // branch-free. Feishu returns 400 with structured `response.data.code/msg`
      // for business errors (rate-limit, invalid text, …); those get folded
      // into `reason` for logging without leaking axios internals to the tool.
      sendMessage: async (chatId, markdown, notificationSessionId, session) => {
        try {
          const { im, assertCurrent } = await feishuTransportFor(session, chatId);
          assertCurrent();
          // 只有个人 bot 维护通知到普通任务的回复关联; 伙伴连接已有自己的主任务。
          if (im === feishuIm && notificationSessionId && chatId === feishuIm.getOwnerOpenId()) {
            const { messageId, sessionLinked } = await sendFeishuSessionNotification(
              feishuIm, notificationSessionId, markdown,
            );
            return { ok: true, messageId, sessionLinked };
          }
          const { messageId } = await im.sendMarkdownText(chatId, markdown);
          return { ok: true, messageId };
        } catch (err) {
          const r = (err as { response?: { data?: { code?: number; msg?: string }; status?: number } }).response;
          const detail = r
            ? `status=${r.status ?? 'n/a'} code=${r.data?.code ?? '?'} msg=${r.data?.msg ?? '?'}`
            : err instanceof Error
              ? err.message
              : String(err);
          createLogger('mcp/cindy_feishu_bot').warn(
            'sendMessage failed target=...%s detail=%s',
            chatId.slice(-8),
            detail,
          );
          return { ok: false, reason: 'SEND_FAIL' };
        }
      },
      logger: createLogger('mcp/cindy_feishu_bot'),
    },
    wechatBot: {
      getActivePeerIdForSession: (sessionId) =>
        wechatIm.getActivePeerIdForSession(sessionId),
      getMostRecentPeerId: () => wechatIm.getMostRecentPeerId(),
      sendMessage: async (peerId, text) => {
        try {
          const { messageId } = await wechatIm.sendText(peerId, text);
          return { ok: true, messageId };
        } catch (error) {
          createLogger('mcp/cindy_wechat').warn(
            'sendMessage failed target=...%s detail=%s',
            peerId.slice(-8),
            error instanceof Error ? error.message : String(error),
          );
          return { ok: false, reason: 'SEND_FAIL' };
        }
      },
      sendFile: async (peerId, absPath, displayName) => {
        const result = await wechatIm.sendFile(peerId, absPath, displayName);
        if (!result.ok) {
          createLogger('mcp/cindy_wechat').warn(
            'sendFile failed target=...%s reason=%s',
            peerId.slice(-8),
            result.reason ?? 'unknown',
          );
        }
        return result;
      },
      logger: createLogger('mcp/cindy_wechat'),
    },
    // cindy_slack(2026-07-19): Slack 网关工具。桥经 hook-control 的零依赖
    // 注册表取用(静态 import ipc.ts 会与 maker-host 闭环, 见 slackToolBridge
    // 模块头); 未注册 = null, provider isEnabled fail-closed。
    slackHook: {
      compressInlineImage,
      withAccountDataAccess,
      getBridge: () => getSlackToolBridge(),
      logger: createLogger('mcp/cindy_slack'),
    },
    scheduler: {
      withAccountDataAccess,
      authorizeCall: authorizeTaskToolCall,
      getScheduler: () => getScheduler(),
      getApprovedScheduleGuard: () => getPluginHostToolCaller()?.scheduleGuard,
      // 其它电脑上的定时任务:与历史查询共用设备目录与 owner fence,走既有远程控制通道。
      ...(deps.historyRemote
        ? {
            remote: createSchedulerRemoteDeps({
              listDevices: deps.historyRemote.listDevices,
              captureAccess: deps.historyRemote.captureAccess,
              captureInvocationGuard: () => getPluginHostToolCaller()?.assertCurrent,
              invoke: deps.invokeRemote,
            }),
          }
        : {}),
      // 前置检查脚本统一安装服务:落盘路径/协议/自测与 UI「AI 生成」共用同一实现
      // (hook-script-generator)。lazy import:该链上有 electron app 依赖,且 maker
      // 仅 description 生成模式需要,tool-call 时才解引用。
      webhookStatus: (schedule) => getScheduleWebhookHost()?.status(schedule) ?? null,
      webhookReceiver: scheduleWebhookReceiver,
      webhookManagement: {
        list: async () => {
          const host = getScheduleWebhookHost();
          if (!host) throw new Error('scheduler not started');
          return host.accountOverview();
        },
        release: async (id) => {
          const host = getScheduleWebhookHost();
          if (!host) throw new Error('scheduler not started');
          await assertTaskActionCurrent();
          await host.releaseEndpoint(id);
        },
        restore: async (id) => {
          const host = getScheduleWebhookHost();
          const schedule = await getScheduler().get(id);
          if (!host) throw new Error('scheduler not started');
          if (!schedule) throw new Error('Schedule not found');
          await assertTaskActionCurrent();
          await host.restoreEndpoint(schedule);
        },
      },
      hookScript: {
        isSessionAgentOnOtherDevice: async (sessionId) => {
          const row = await getSessionRowSnapshot(sessionId);
          return !!row?.agentDeviceId && !row.remoteHostId;
        },
        // 绑定会话(heartbeat)任务安装 hook 时解析会话真实工作目录 —— schedule
        // 行上的 workingDir 为空/过期,落盘与自测必须用会话 meta.workDir。
        resolveSessionWorkDir: resolveHookSessionWorkDir,
        stabilizeCommand: async ({ command, workingDir }) => {
          await assertPreRunHookCommandSyntax(command);
          return stabilizeHookCommand(command, workingDir);
        },
        install: async (input) => {
          const [{ installHookScript }, { getMaker }, { app }] = await Promise.all([
            import('../scheduler-host/hook-script-generator.js'),
            import('../maker-host/index.js'),
            import('electron'),
          ]);
          // Recheck after target resolution and lazy imports, before any script write/self-test.
          await assertTaskActionCurrent();
          // maker 仅 description 生成模式需要;未就绪时传 null,script 模式照常工作,
          // description 模式由生成器报"maker not ready"。
          let maker = null;
          try {
            maker = getMaker();
          } catch {
            maker = null;
          }
          return installHookScript(
            {
              maker,
              fallbackDir: pathJoin(app.getPath('userData'), 'schedule-hooks'),
              logger: createLogger('mcp/cindy_scheduler:hook-script'),
            },
            input,
          );
        },
      },
      // 运行位置与模型:与协同 Worker 的 list_available_models 同一份 host 实现。
      listModels: wrap((s, params) => s.listAvailableModels(params)),
      logger: createLogger('mcp/cindy_scheduler'),
    },
    // cindy_ssh: agent 直接在已配置 SSH 主机上执行命令(远端零安装)。
    // ⚠️ 必须 lazy await import():静态 import remote-ssh 会形成
    // mcp-providers → remote-ssh/index.ts(imports maker-host) →
    // maker-host/index.ts(imports createDesktopMcpProviders) → mcp-providers 环
    // (同上方 scheduler hookScript 的先例)。
    ssh: {
      // hydrated accessor:冷启动时 pool 是空的(hydrate 只在用户访问设置或
      // connect 路径触发),ssh_list_hosts / resolveHost 读 pool.list() 前必须
      // 先从 ~/.ssh/config hydrate,否则已配置主机全部 HOST_NOT_FOUND。
      getPool: async () => (await loadRemoteSsh()).getRemoteSshPoolHydrated(),
      ensureReady: async (id: string) =>
        (await loadRemoteSsh()).ensureRemoteHostReady(id),
      // 与设置页「添加」「重新读取」同一实现，Agent 与用户写的是同一份配置。
      addHost: async (input) => {
        await (await loadRemoteSsh()).addRemoteSshHost(input);
      },
      listHosts: async () => (await loadRemoteSsh()).listRemoteSshHostsForAgent(),
      updateHost: async (input) => (await (await loadRemoteSsh()).updateRemoteSshHost(input, { patch: true })).host,
      removeHost: async (id) => { await (await loadRemoteSsh()).removeRemoteSshHost({ id }); },
      reloadConfig: async () => {
        const result = await (await loadRemoteSsh()).reloadRemoteSshConfig();
        return { diagnostic: result.diagnostic?.kind ?? null, warningCount: result.warningCount };
      },
      redactSensitiveText: (snapshot, text) => {
        if (!redactSshText) throw new Error('SSH redactor is not initialized');
        return redactSshText(snapshot, text);
      },
      // 普通工具策略在 Claude runtime / Codex thread 创建时冻结。不要在 tool-call
      // 时重新读取 registry，否则运行中的工具清单与执行权限会随 Settings 分叉。
      logger: createLogger('mcp/cindy_ssh'),
    },
    memory: {
      withAccountDataAccess,
      getManager: deps.getMakerMemoryManager,
      searchProviders: searchGhostRuntimeMemories,
      beginWrite: (context) => {
        const saved = botLearningTracker.capture(botLearningTracker.learnsFrom(context?.sessionId, context?.memoryScopeKey));
        return receipt => saved({ ...receipt, kind: 'memory' });
      },
      searchSessions: async (query, opts = {}) => {
        const dbClient = tryGetDbClient();
        if (!dbClient || isAppSessionBoundaryPending() || !opts.callerSessionId)
          throw new Error('Task history caller unavailable');
        // session_search bypasses cindy_helper, so share its account-data surface.
        if (await resolveHelperSurface(dbClient, opts.callerSessionId) === 'restricted')
          throw new Error('Task history search is unavailable for this task');
        if (isAppSessionBoundaryPending() || dbClient !== tryGetDbClient())
          throw new Error('Task history caller unavailable');
        const hits = await searchSessionsWithBotScope(query, opts, {
          botAccountWide: await botReadsAccountHistory(opts.callerSessionId),
        });
        if (isAppSessionBoundaryPending() || dbClient !== tryGetDbClient())
          throw new Error('Task history caller unavailable');
        if (await resolveHelperSurface(dbClient, opts.callerSessionId) === 'restricted')
          throw new Error('Task history search is unavailable for this task');
        if (isAppSessionBoundaryPending() || dbClient !== tryGetDbClient())
          throw new Error('Task history caller unavailable');
        return hits;
      },
      logger: createLogger('mcp/cindy_memory'),
    },
    lsp: {
      pool: deps.lspPool,
      logger: createLogger('mcp/cindy_lsp'),
      isUserEnabled: () => readLspModeSettings().enabled,
    },
    // cindy_docs(文档工坊): docx / pptx / xlsx / csv 全在 @cindy/mcps 内用纯 JS 库实现,
    // 这里只补上包里做不到的三件事 —— 都需要 electron:
    //   writeDocsOutput: 最终落盘靠 cwd 绑定的单次 utility process;
    //   renderHtmlToPdf: HTML → PDF 靠 Chromium printToPDF(隐藏窗即用即毁);
    //   inspectPdf:     回读 PDF 结构靠一次性 utility process 里的 pdfjs。
    docs: {
      logger: createLogger('mcp/cindy_docs'),
      writeDocsOutput: input => {
        const plugin = getPluginHostToolCaller();
        if (!plugin) return writeDocsOutput(input);
        const current = input.isCurrent;
        return writeDocsOutput({ ...input, isCurrent: () => {
          try { plugin.assertCurrent(); return current?.() !== false; } catch { return false; }
        } });
      },
      renderHtmlToPdf,
      inspectPdf,
    },
    // xdt-helper: 自省 + history + send_to_session (essential 常开)。
    // send_to_session 是 skill(issue-bot 等)的会话路由原语, 放 essential 常开不断。
    // tryGetOrcaCollabService() 是延迟查找：createDesktopMcpProviders 在 app
    // 启动早期跑, 那时 registerMakerIpc 还没执行, holder 是 null; 回调真正被调时
    // (LLM 调工具时) registerMakerIpc 早已执行完毕, holder 已 ready。
    xdtHelper: {
      hostServices: createHostServiceToolExecutor(hostServiceCatalog, { pluginCall: getPluginHostToolCaller, getGhost: findGhostForInstanceId }),
      files: createFileToolExecutor(getGhostFsSlot, getPluginHostToolCaller),
      storage: createStorageToolExecutor(getGhostStorageService, getPluginHostToolCaller),
      terminal: createTerminalToolExecutor({ service: getDesktopHostTerminalService(), owner: getActiveDataOwnerPushStamp,
        pending: isAppSessionBoundaryPending, pluginCall: getPluginHostToolCaller, getGhost: findGhostForInstanceId,
        getSession: getTaskActionSession, pluginDirectory: id => ownerScopedUserDataPath('ghost-fs', id), defaultShell: getDefaultShellPref }),
      github: { call: (caller, method, args) => withAccountDataAccess(caller, async assertCurrent => {
        const session = typeof args.session_id === 'string' ? args.session_id : caller;
        const parts = session.split('::');
        if (parts.length > 2 || parts.some(part => !part)) throw new Error('INVALID_SESSION');
        const device = typeof args.device === 'string' && args.device !== 'local' ? args.device : parts.length === 2 ? parts[0] : undefined;
        if (parts.length === 2 && device !== parts[0]) throw new Error('DEVICE_MISMATCH');
        const localArgs = { ...args, session_id: parts.at(-1) };
        await assertCurrent();
        if (device && device !== getDeviceId()) {
          if (!deps.historyRemote) throw new Error('REMOTE_GITHUB_UNAVAILABLE');
          const assertAccess = deps.historyRemote.captureAccess();
          const remote = await deps.invokeRemote(device, 'git-context:github-read', [{ method, args: localArgs }], { preSend: assertAccess });
          assertAccess();
          await assertCurrent();
          if (!remote.ok) return { ok: false, errorCode: remote.error?.message?.startsWith('GITHUB_READ_UNSUPPORTED') ? 'GITHUB_READ_UNSUPPORTED' : 'REMOTE_GITHUB_UNAVAILABLE', error: remote.error };
          return remote.result as Record<string, unknown>;
        }
        const result = method === 'manage_session_prs'
          ? await manageGithubPrs(parts.at(-1)!, localArgs, `agent:${caller}`)
          : await readGithub(method as GithubReadMethod, localArgs);
        await assertCurrent();
        return result;
      }) },
      getSessionProject: readCurrentSessionProject,
      runtimeCapabilities: deps.runtimeCapabilities,
      productHelpDocs: HELP_KNOWLEDGE,
      // Install / auto-update requests become owner-only Host cards (see agent-app-update/).
      appUpdate: createAgentAppUpdateCallbacks((sessionId, sessionInstanceId) =>
        deps.isCurrentLocalSessionInstance?.(sessionId, sessionInstanceId) === true),
      logger: createLogger('mcp/cindy_helper'),
      // 代输入: Host-owned card; values never return through this tool.
      inputHandoff: {
        start: async (context, request) => {
          const ready = await admitInputHandoff(context);
          if (!ready.ok) return ready;
          // Report a bad target now, not as target_gone after the turn ended.
          const problem = await ready.service.checkTarget(request.target).catch(() => null);
          if (problem) return { ok: false, ...problem };
          const result = ready.service.start({
            sessionId: ready.sessionId,
            purpose: request.purpose,
            ...(request.note ? { note: request.note } : {}),
            ...(ready.requester ? { requester: ready.requester } : {}),
            target: request.target,
            ...(request.completeWhen ? { completeWhen: request.completeWhen } : {}),
            ...(request.timeoutMinutes ? { timeoutMinutes: request.timeoutMinutes } : {}),
          });
          return result.ok ? { ok: true, requestId: result.requestId } : result;
        },
        startImage: async (context, request) => {
          const ready = await admitInputHandoff(context);
          if (!ready.ok) return ready;
          const picture = await readHandoffPicture(request.image, context.workingDir, (absPath) => authorizeDesktopSessionPath({
            sessionId: ready.sessionId,
            sessionInstanceId: context.sessionInstanceId,
            workingDir: context.workingDir ?? '',
            path: absPath,
            toolName: 'cindy_helper.request_input_handoff',
            operation: 'read',
          }, deps.getLiveSessionGrantState));
          if (!picture.ok) return picture;
          const result = await ready.service.startImageQr({
            sessionId: ready.sessionId,
            purpose: request.purpose,
            ...(request.note ? { note: request.note } : {}),
            ...(ready.requester ? { requester: ready.requester } : {}),
            image: picture.bytes,
            ...(request.timeoutMinutes ? { timeoutMinutes: request.timeoutMinutes } : {}),
          });
          picture.bytes.fill(0);
          return result.ok ? { ok: true, requestId: result.requestId } : result;
        },
      },
      grokLogin: {
        start: async (context) => {
          if (!context.sessionId || !context.sessionInstanceId
            || !deps.isCurrentGrokLoginCaller?.(context.sessionId, context.sessionInstanceId))
            throw new Error('Stale Grok login caller');
          return startGrokDeviceLogin();
        },
        status: async (context) => {
          if (!context.sessionId || !context.sessionInstanceId
            || !deps.isCurrentGrokLoginCaller?.(context.sessionId, context.sessionInstanceId))
            throw new Error('Stale Grok login caller');
          return grokDeviceLoginStatus();
        },
        cancel: async (context) => {
          if (!context.sessionId || !context.sessionInstanceId
            || !deps.isCurrentGrokLoginCaller?.(context.sessionId, context.sessionInstanceId))
            throw new Error('Stale Grok login caller');
          return cancelGrokDeviceLogin();
        },
      },
      sessionTags: async (callerSessionId, request) => {
        const result = await executeTaskTags(request, callerSessionId);
        return ['update', 'delete'].includes(request.action) ? { ...result, sessions: [] } : result;
      },
      createProject,
      moveSession: createMoveSession(isSessionInTurn),
      createTaskWorktree: createTaskWorktreeHost(),
      projectManagement: {
        list: async ({ device, ...options }) => {
          if (!device || device === 'local' || device === getDeviceId()) return listProjects(options);
          if (isSessionSharedTaskActive(options.callerSessionId)) return { ok: false, errorCode: 'PERMISSION_DENIED', message: 'Not available in a shared task' };
          return withAccountDataAccess(options.callerSessionId, async assertCurrent => {
            const support = await deps.invokeRemote(device, 'maker:session:handoff', [{ action: 'task-action-capability' }]);
            await assertCurrent();
            if (!support.ok || (support.result as { projectCatalogVersion?: unknown } | null)?.projectCatalogVersion !== 1)
              return { ok: false as const, errorCode: 'UNSUPPORTED_CAPABILITY', message: 'The destination must support the remote project catalog. Update it and retry.' };
            const { callerSessionId: _caller, ...remoteOptions } = options;
            const response = await deps.invokeRemote(device, 'maker:session:handoff', [{ action: 'list-projects', options: remoteOptions }]);
            await assertCurrent();
            if (!response.ok) return { ok: false as const, errorCode: 'INTERNAL', message: response.error.message };
            return response.result as Awaited<ReturnType<typeof listProjects>>;
          });
        },
        rename: renameProject, remove: removeProject,
      },
      authorizeSkillLearning: async (request, context) => {
        if (!isCindyLearnSkillEnabled()) {
          return {
            ok: false,
            errorCode: 'SKILL_DISABLED',
            message: 'Cindy Learn is disabled in Local Skills.',
          };
        }
        if (!getLearnController()) {
          return {
            ok: false,
            errorCode: 'HOST_NOT_READY',
            message: 'Cindy Learn is not ready yet.',
          };
        }
        const sessionInstanceId = context.sessionInstanceId;
        if (
          !sessionInstanceId
          || !deps.isCurrentLocalSessionInstance?.(request.callerSessionId, sessionInstanceId)
        ) {
          return {
            ok: false,
            errorCode: 'USER_REQUEST_REQUIRED',
            message: 'Cindy Learn is not authorized for this task instance.',
          };
        }
        const authorization = await consumeLearnInvocationGrant(request, sessionInstanceId);
        return authorization.ok
          ? { ok: true, sessionInstanceId }
          : authorization;
      },
      skillLearning: async ({
        callerSessionId,
        input,
        sourceKind,
        hubSlug,
        hubCatalogScope,
      }, authorization) => {
        try {
          if (!isCindyLearnSkillEnabled()) {
            return {
              ok: false,
              errorCode: 'SKILL_DISABLED',
              message: 'Cindy Learn is disabled in Local Skills.',
            };
          }
          const controller = getLearnController();
          if (!controller) {
            return {
              ok: false,
              errorCode: 'HOST_NOT_READY',
              message: 'Cindy Learn is not ready yet.',
            };
          }
          if (!deps.isCurrentLocalSessionInstance?.(
            callerSessionId,
            authorization.sessionInstanceId,
          )) {
            return {
              ok: false,
              errorCode: 'USER_REQUEST_REQUIRED',
              message: 'Cindy Learn is not authorized for this task instance.',
            };
          }
          const { runId } = await controller.startLearn({
            input,
            sourceKind,
            originSessionId: callerSessionId,
            ...(hubSlug ? { hubSlug } : {}),
            ...(hubCatalogScope ? { hubCatalogScope } : {}),
          });
          return { ok: true, runId };
        } catch (err) {
          const rawCode = (err as { code?: unknown })?.code;
          const errorCode =
            typeof rawCode === 'string'
            && ['LEARN_BUSY', 'LEARN_INVALID_STATE', 'INVALID_PARAMS', 'NOT_FOUND'].includes(rawCode)
              ? rawCode
              : 'INTERNAL';
          return {
            ok: false,
            errorCode,
            message: err instanceof Error ? err.message : 'Failed to start Cindy Learn.',
          };
        }
      },
      // 共用任务与账号有效性检查；操作权限由当前 Agent 的权限档处理。
      authorizeCall: authorizeTaskToolCall,
      resolveSurface: async ({ sessionId }) => {
        const dbClient = tryGetDbClient();
        if (!dbClient || isAppSessionBoundaryPending()) return 'restricted';
        const surface = await resolveHelperSurface(dbClient, sessionId);
        if (isAppSessionBoundaryPending() || dbClient !== tryGetDbClient()) return 'restricted';
        return surface;
      },
      sessionQueue: {
        listSessionQueue: wrap((service, sessionId: string) => service.listSessionQueue(sessionId)),
        listSessionQueuedCounts: wrap((service, sessionIds: string[]) =>
          service.listSessionQueuedCounts(sessionIds)),
      },
      sessionControl: {
        updateQueuedMessage: wrap((service, params) => service.updateSessionQueuedMessage(params)),
        cancelQueuedMessage: wrap((service, params) => service.cancelSessionQueuedMessage(params)),
        steerQueuedMessage: wrap((service, params) => service.steerSessionQueuedMessage(params)),
        moveQueuedMessage: wrap((service, params) => service.moveSessionQueuedMessage(params)),
        steerSession: wrap((service, params) => service.steerSession(params)),
        stopSessionTurn: wrap((service, params) => service.stopSessionTurn(params)),
        getSessionRuntime: wrap((service, params) => service.getSessionRuntime(params)),
        setSessionRuntime: wrap((service, params) => service.setSessionRuntime(params)),
      },
      setCurrentSessionTitle: async ({ sessionId, title }) => {
        if (!tryGetDbClient()) {
          return { ok: false, errorCode: 'HOST_NOT_READY', message: 'localDb not ready' };
        }
        try {
          const updated = await patchSessionMetaInDb(sessionId, { title });
          return { ok: true, sessionId: updated.id, title: updated.title ?? title };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (isIpcError(err) && err.code === 'NOT_FOUND') {
            return { ok: false, errorCode: err.code, message };
          }
          return { ok: false, errorCode: 'INTERNAL', message };
        }
      },
      askUserQuestionAsync: deps.askUserQuestionAsync,
      manageUserQuestions: deps.manageUserQuestions,
      sessionImport: sessionImportCallbacks,
      renameSessions: async ({ changes, dryRun }) => {
        if (!tryGetDbClient()) {
          return { ok: false, errorCode: 'HOST_NOT_READY', message: 'localDb not ready' };
        }
        try {
          const renamed = await renameSessionTitlesInDb(changes, dryRun, assertTaskActionCurrent);
          return { ok: true, changes: renamed };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (isIpcError(err)) {
            if (err.code === 'NOT_FOUND' || err.code === 'PRECONDITION_FAILED') {
              return { ok: false, errorCode: err.code, message };
            }
            if (err.code === 'INVALID_PARAMS') {
              return { ok: false, errorCode: 'INVALID_ARGS', message };
            }
          }
          return { ok: false, errorCode: 'INTERNAL', message };
        }
      },
      setRemoteSessionsStatus: deps.historyRemote
        ? createRemoteSessionsStatusSetter({ captureAccess: deps.historyRemote.captureAccess, invoke: deps.invokeRemote })
        : undefined,
      deleteSession: ({ sessionId, callerSessionId }) => withAccountDataAccess(callerSessionId, async assertCurrent => {
        await assertTaskActionCurrent();
        await assertCurrent();
        const split = sessionId.indexOf('::');
        if (split > 0) {
          if (!deps.historyRemote) return { ok: false as const, errorCode: 'REMOTE_UNSUPPORTED', message: 'Remote task control is unavailable.' };
          const result = await createRemoteSessionsStatusSetter({ captureAccess: deps.historyRemote.captureAccess, invoke: deps.invokeRemote })({
            deviceId: sessionId.slice(0, split), sessionIds: [sessionId.slice(split + 2)], status: 'deleted',
          });
          return result.ok ? { ok: true as const, sessionId, status: 'deleted' as const } : result;
        }
        try {
          await patchSessionMetaInDb(sessionId, { status: 'deleted' }, { beforeWrite: captureTaskActionSyncGuard() });
          return { ok: true as const, sessionId, status: 'deleted' as const };
        } catch (error) {
          return { ok: false as const, errorCode: isIpcError(error) ? error.code : 'INTERNAL', message: error instanceof Error ? error.message : 'Task deletion failed.' };
        }
      }),
      sessionHistory: params => withAccountDataAccess(params.callerSessionId, async assertCurrent => {
        await assertTaskActionCurrent();
        await assertCurrent();
        const split = params.sessionId.indexOf('::');
        const remote = split > 0;
        try {
          let result: { id: string };
          if (remote) {
            if (!deps.historyRemote) return { ok: false as const, errorCode: 'REMOTE_UNSUPPORTED', message: 'Remote task control is unavailable.' };
            const access = deps.historyRemote.captureAccess();
            const action = captureTaskActionSyncGuard();
            const response = await deps.invokeRemote(params.sessionId.slice(0, split),
              params.kind === 'fork' ? MAKER_INVOKE.FORK : MAKER_INVOKE.REWIND_COMMIT,
              [params.sessionId.slice(split + 2), params.messageClientId, ...(params.kind === 'rewind'
                ? [{ stopIfRunning: params.stopIfRunning, allowFileRestore: params.allowFileRestore }] : [])],
              { preSend: () => { access(); action?.(); } });
            await assertCurrent();
            if (!response.ok) return { ok: false as const, ...remoteSessionMutationFailure(response.error.code, response.error.message) };
            const row = response.result as { id?: unknown } | null;
            if (!row || typeof row.id !== 'string' || (params.kind === 'rewind' && row.id !== params.sessionId.slice(split + 2)))
              return { ok: false as const, ...remoteSessionMutationFailure('UNKNOWN', '') };
            result = { id: `${params.sessionId.slice(0, split)}::${row.id}` };
          } else {
            result = params.kind === 'fork'
              ? await forkTaskAtMessage(params.sessionId, params.messageClientId)
              : await commitTaskRewind(params.sessionId, params.messageClientId,
                { stopIfRunning: params.stopIfRunning, allowFileRestore: params.allowFileRestore });
          }
          return { ok: true as const, sessionId: result.id };
        } catch (error) {
          if (remote) return { ok: false as const, ...remoteSessionMutationFailure(error instanceof DeviceLinkError ? error.code : 'IPC_ERROR',
            error instanceof Error ? error.message : '', error instanceof DeviceLinkError && !error.inFlight) };
          const code = (error as { code?: unknown }).code;
          return { ok: false as const, errorCode: typeof code === 'string' ? code : 'INTERNAL', message: error instanceof Error ? error.message : 'Task history operation failed.' };
        }
      }),
      setSessionsStatus: async ({ sessionIds, status }) => {
        if (!tryGetDbClient()) {
          return { ok: false, errorCode: 'HOST_NOT_READY', message: 'localDb not ready' };
        }
        try {
          const changed = await setSessionsStatusInDb(sessionIds, status, assertTaskActionCurrent);
          return { ok: true, changed };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (isIpcError(err)) {
            if (err.code === 'NOT_FOUND' || err.code === 'PRECONDITION_FAILED') {
              return { ok: false, errorCode: err.code, message };
            }
          }
          return { ok: false, errorCode: 'INTERNAL', message };
        }
      },
      listAvailableModels: async params => {
        if (params.callerSessionId && isSessionSharedTaskActive(params.callerSessionId))
          return { ok: false, errorCode: 'PERMISSION_DENIED', message: 'Not available in a shared task' };
        return withAccountDataAccess(params.callerSessionId, async () => {
          const svc = tryGetOrcaCollabService();
          return svc ? svc.listAvailableModels(params)
            : { ok: false, errorCode: 'HOST_NOT_READY', message: 'Model catalog is not ready' };
        });
      },
      // 目标在另一台电脑(deviceId::sessionId):交给那台电脑按它本机的同一条通路投递。
      ...(remoteSessionHandoff
        ? {
            sendToRemoteSession: async ({ deviceId, sessionId, message, dispatcherSessionId }) => {
              const result = await remoteSessionHandoff({ deviceId, sessionId }, {
                message, sender: () => remoteHandoffSender(dispatcherSessionId),
              });
              if (!result.ok) return result;
              if (result.wakeKind === 'created') return { ok: false, errorCode: 'DELIVERY_UNKNOWN', message: 'Unexpected creation receipt for an existing task.' };
              return { ...result, wakeKind: result.wakeKind };
            },
          }
        : {}),
      sendToSession: async ({
        device,
        targetSessionId,
        message,
        dispatcherSessionId,
        title,
        useWorktree,
        workingDir,
        projectDir,
        agentKind,
        model,
        effort,
        fast,
        agentDeviceId,
      }) => {
        if (!targetSessionId && device && device !== 'local' && device !== getDeviceId()) {
          if (!remoteSessionHandoff || !dispatcherSessionId)
            return { ok: false, errorCode: 'REMOTE_UNSUPPORTED', message: 'Remote task creation is unavailable in this host.' };
          const id = randomUUID();
          const qualifiedId = `${device}::${id}`;
          let recordCreation: Awaited<ReturnType<typeof captureBotCreatedTaskResponsibility>> = null;
          const result = await remoteSessionHandoff({ deviceId: device, sessionId: id }, {
            message, sender: () => remoteHandoffSender(dispatcherSessionId),
            create: async () => {
              if (isSessionSharedTaskActive(dispatcherSessionId)) throw new Error('Shared tasks cannot create remote tasks');
              const [source] = await getDbClient().drizzle.select({ permissionMode: sessions.permissionMode })
                .from(sessions).where(eq(sessions.id, dispatcherSessionId)).limit(1);
              if (!source) throw new Error('Source task is unavailable');
              recordCreation = await captureBotCreatedTaskResponsibility(dispatcherSessionId, { remoteDeviceId: device });
              return { title: title?.trim() || message.split('\n')[0].slice(0, 60), projectDir, workingDir,
                useWorktree, agentKind, model, effort, fast, agentDeviceId,
                permissionMode: permissionModeOrAsk(source.permissionMode) };
            },
          });
          if (!result.ok) return { ...result,
            ...(['DELIVERY_UNKNOWN', 'CREATED_NOT_DELIVERED'].includes(result.errorCode)
              ? { recoverySessionId: qualifiedId, message: `${result.message} Recovery target_session_id: ${qualifiedId}. Do not repeat create.` } : {}) };
          const accepted = { ...result, targetSessionId: qualifiedId, targetDeviceId: device };
          // Opened from a group: the group shows the task as a card (bot-group-chat.md §10).
          reportGroupTaskCreated(dispatcherSessionId, { taskId: id, deviceId: device, title: title?.trim() || message.split('\n')[0].slice(0, 60) });
          if (recordCreation) {
            try { await (recordCreation as (sessionId: string) => Promise<void>)(qualifiedId); }
            catch { return { ...accepted, responsibilityRecorded: false }; }
          }
          return accepted;
        }
        const svc = tryGetOrcaCollabService();
        if (!svc) {
          return { ok: false, errorCode: 'HOST_NOT_READY', message: 'orca collab service not initialized' };
        }
        try {
          const hasExecutionOverrides =
            agentKind !== undefined
            || model !== undefined
            || effort !== undefined
            || fast !== undefined;
          const recordCreation = targetSessionId ? null : await captureBotCreatedTaskResponsibility(dispatcherSessionId);
          const result = await svc.sendToSession({
            targetSessionId,
            message,
            dispatcherSessionId,
            title,
            useWorktree,
            workingDir,
            projectDir,
            ...(hasExecutionOverrides
              ? {
                  execution: {
                    agentKind,
                    model,
                    effort,
                    fastMode: fast,
                  },
                }
              : {}),
            ...(agentDeviceId !== undefined ? { agentDeviceId } : {}),
          });
          if (result.ok && result.wakeKind === 'created' && dispatcherSessionId)
            reportGroupTaskCreated(dispatcherSessionId, { taskId: result.targetSessionId, deviceId: null,
              title: title?.trim() || message.split('\n')[0].slice(0, 60) });
          if (result.ok && result.wakeKind === 'created' && recordCreation) {
            try { await recordCreation(result.targetSessionId); }
            catch { return { ...result, responsibilityRecorded: false }; }
          }
          return result;
        } catch (err) {
          return { ok: false, errorCode: 'INTERNAL', message: err instanceof Error ? err.message : String(err) };
        }
      },
      botMessaging: {
        sendToUser: async (params) => {
          const svc = tryGetBotDirectMessageService();
          if (!svc) return { ok: false, errorCode: 'HOST_NOT_READY', message: t('groupTools.privateUnavailable') };
          return svc.sendToUser(params);
        },
        listAgents: async ({ callerSessionId }) => {
          if (isSessionSharedTaskActive(callerSessionId)) return { ok: false, errorCode: 'PERMISSION_DENIED', message: 'Not available in a shared task' };
          const svc = tryGetBotDirectMessageService();
          if (!svc) return { ok: false, errorCode: 'HOST_NOT_READY', message: 'Buddy service is not ready' };
          return svc.listAgents(callerSessionId);
        },
      },
      ...(deps.machineDirectory ? { machines: {
        requestRemoteControl: async ({ callerSessionId, deviceId, purpose }: { callerSessionId: string; deviceId: string; purpose: string }) => {
          if (isSessionSharedTaskActive(callerSessionId) || isAppSessionBoundaryPending()) {
            return { ok: false as const, errorCode: 'PERMISSION_DENIED', message: 'Not available in this task' };
          }
          const { requestRemoteControlConsent } = await import('../device-link/index.js');
          const status = await requestRemoteControlConsent(deviceId, purpose);
          return { ok: true as const, status };
        },
        list: async ({ callerSessionId }: { callerSessionId: string }) => {
          // 共享任务里的访客不是账号本人，不能经 Agent 看到账号下的机器。
          if (isSessionSharedTaskActive(callerSessionId)) {
            return { ok: false as const, errorCode: 'PERMISSION_DENIED', message: 'Not available in a shared task' };
          }
          let sshConfigProblem: string | null = null;
          const machines = await listMachines({
            ...deps.machineDirectory!,
            readLocal: readLocalMachineStatus,
            selfName: () => hostname(),
            listSsh: async () => {
              const remoteSsh = await loadRemoteSsh();
              const pool = await remoteSsh.getRemoteSshPoolHydrated();
              sshConfigProblem = remoteSsh.remoteSshConfigProblem();
              return pool.list().map(({ config, status }) => ({
                kind: 'ssh' as const, id: config.id, hostname: config.hostname, port: config.port, user: config.user, connection: status,
              }));
            },
            sshConfigProblem: () => sshConfigProblem,
            isSshKeyKnown: async (hostname, port) => (await loadRemoteSsh()).isRemoteHostKeyKnown(hostname, port),
            readSsh: async (id) => {
              const remoteSsh = await loadRemoteSsh();
              await remoteSsh.ensureRemoteHostReady(id);
              const remote = (await remoteSsh.getRemoteSshPoolHydrated()).get(id);
              if (!remote) throw new Error('[SSH_HOST_NOT_FOUND]');
              return (await remote.exec(SSH_STATUS_COMMAND, { timeoutMs: 8_000, label: `list_machines(${id})`, maxOutputBytes: 64 * 1024 })).stdout;
            },
          });
          return { ok: true as const, machines };
        },
      } } : {}),
      // 伙伴的主力电脑:与界面同一条路径(本机交出 / 请主力电脑交出 / 在这台电脑继续)。
      teammateHome: {
        get: async ({ teammateId }) => {
          const runtime = activeCompanionCloud();
          if (!runtime) return { ok: false, errorCode: 'NOT_ENABLED', message: 'Cloud companions are not available on this server' };
          const choices = await runtime.homeChoices(teammateId);
          if (choices.reason === 'NOT_FOUND') return { ok: false, errorCode: 'NOT_FOUND', message: 'No such buddy in this account' };
          return { ok: true, teammateId, mode: choices.mode, ...(choices.reason ? { reason: choices.reason } : {}),
            home: choices.homeDeviceId ? { deviceId: choices.homeDeviceId, name: choices.homeName ?? '', isSelf: choices.mode === 'local' } : null,
            choices: choices.targets.map(target => ({ deviceId: target.deviceId, name: target.name, isSelf: target.isSelf === true })) };
        },
        move: async ({ teammateId, targetDeviceId, whenBusy }) => {
          const runtime = activeCompanionCloud();
          if (!runtime) return { ok: false, errorCode: 'NOT_ENABLED', message: 'Cloud companions are not available on this server' };
          const result = await runtime.switchHome(teammateId, targetDeviceId, whenBusy ? { whenBusy } : undefined);
          return result.ok ? { ok: true, teammateId, homeDeviceId: targetDeviceId }
            : { ok: false, errorCode: result.code, message: `The buddy did not move (${result.code})` };
        },
      },
      botProfiles: {
        create: async ({ callerSessionId, callerSessionInstanceId, name, description, identitySource }) => {
          if (!tryGetDbClient()) {
            return { ok: false, errorCode: 'HOST_NOT_READY', message: 'localDb not ready' };
          }
          const owned = await resolveSessionTeammate(callerSessionId);
          if (!owned) {
            return { ok: false, errorCode: 'NOT_A_BOT_SESSION', message: '当前调用未绑定伙伴主任务' };
          }
          try {
            const profile = await createBotProfile({
              name,
              description,
              identitySource,
              prepareInvitation: true,
            });
            return {
              ok: true,
              bot: { id: profile.id, name: profile.name, description: profile.description },
            };
          } catch (err) {
            return {
              ok: false,
              errorCode: isIpcError(err) && err.code === 'INVALID_PARAMS' ? 'INVALID_ARGS' : 'INTERNAL',
              message: err instanceof Error ? err.message : String(err),
            };
          }
        },
      },
      // 伙伴自己沉淀的真技能。归属同样由 callerSessionId 反查,工具面不收 botId。
      modelSettings: {
        call: ({ callerSessionId, ...input }, signal) => withAccountDataAccess(callerSessionId, async (assertCurrent) => {
          const guard = async () => {
            await assertCurrent();
            if (input.operation === 'set' || input.operation === 'provider' || input.operation === 'connection') await assertTaskActionCurrent();
          };
          return manageAppModels(input, guard, async (name, endpoints, lifetime) => {
            await guard();
            if (await isInputHandoffDisabledForSession(callerSessionId)) throw new Error('DISABLED_BY_OWNER');
            await guard();
            const service = getInputHandoffService();
            if (!service) throw new Error('SECRET_INPUT_UNAVAILABLE');
            return new Promise<string | null>((resolve, reject) => {
              const started = service.startHostSecretPrompt({
                sessionId: callerSessionId,
                ...lifetime,
                step: {
                  purpose: `${name.slice(0, 128)} · API key${endpoints[1] ? ` · ${new URL(endpoints[1]).origin}` : ''}`,
                  source: { app: 'Cindy', ...classifyOrigin(endpoints[0], true) },
                  controls: [{ id: 'answer', kind: 'text', label: 'API key', contentType: 'password' }],
                },
                answer: resolve,
              });
              if (!started.ok) reject(new Error(started.errorCode));
            });
          }, signal);
        }),
      },
      piRuntime: {
        call: (callerSessionId, input) => withAccountDataAccess(callerSessionId, async assertCurrent => {
          await assertCurrent();
          const manager = getPiKernelManager();
          try {
            if (input.install) {
              await assertTaskActionCurrent();
              await manager.install(input.install);
            }
            const state = await (input.check ? manager.check() : manager.state());
            await assertCurrent();
            return { ...state, scope: 'local-managed-pi', runningProcesses: 'unchanged' };
          } catch (error) {
            return { ok: false, errorCode: error instanceof PiKernelError ? error.reason : 'PI_RUNTIME_FAILED',
              message: 'Pi 操作未确认完成；请重新读取版本和状态。' };
          }
        }),
      },
      themePackages: {
        import: (context, filePath) => withAccountDataAccess(context.sessionId, async assertCurrent => {
          const sessionId = context.sessionId;
          if (!sessionId) throw new Error('Task caller unavailable');
          const assertAction = captureTaskActionSyncGuard();
          const assertCaller = async () => {
            await assertCurrent();
            await assertTaskActionCurrent();
            if (!deps.isCurrentLocalSessionInstance?.(sessionId, context.sessionInstanceId)) throw new Error('Task instance changed');
          };
          return importThemePackageFromTask({ filePath, workingDir: context.workingDir ?? '' }, {
            assertCurrent: assertCaller,
            assertCurrentSync: () => {
              assertAction?.();
              if (!deps.isCurrentLocalSessionInstance?.(sessionId, context.sessionInstanceId)) throw new Error('Task instance changed');
            },
            authorizePath: absolutePath => authorizeDesktopSessionPath({
              sessionId, sessionInstanceId: context.sessionInstanceId, workingDir: context.workingDir ?? '',
              path: absolutePath, toolName: 'cindy_helper.import_theme_package', operation: 'read',
            }, deps.getLiveSessionGrantState),
          });
        }),
      },
      appSettings: {
        call: ({ callerSessionId, ...input }) => withAccountDataAccess(callerSessionId, async (assertCurrent) => {
          return manageAppSettings(input, async () => {
            await assertCurrent();
            if (input.operation === 'update' || input.operation === 'reset') await assertTaskActionCurrent();
          });
        }),
      },
      appModels: {
        models: ({ callerSessionId }) => withAccountDataAccess(callerSessionId, async (assertCurrent) => {
          const surface = await resolveHelperSurface(tryGetDbClient()!, callerSessionId);
          if (surface === 'bot' || surface === 'bot-main') {
            if (!deps.botCapabilities.models) throw new Error('HOST_NOT_READY');
            return deps.botCapabilities.models({ callerSessionId });
          }
          await assertCurrent();
          return { ok: true as const, ...await inspectAppDefaultModel() };
        }),
        setDefaultModel: ({ callerSessionId, id, effort, fastMode }) => withAccountDataAccess(callerSessionId, async (assertCurrent) => {
          const surface = await resolveHelperSurface(tryGetDbClient()!, callerSessionId);
          if (surface === 'bot' || surface === 'bot-main') {
            if (!deps.botCapabilities.setDefaultModel) throw new Error('HOST_NOT_READY');
            return deps.botCapabilities.setDefaultModel({ callerSessionId, id, effort, fastMode });
          }
          const owner = activeOwnerScopeKey();
          await assertCurrent();
          await assertTaskActionCurrent();
          const result = await changeAppDefaultModel(id, effort, async () => {
            await assertCurrent();
            await assertTaskActionCurrent();
            if (isAppSessionBoundaryPending() || activeOwnerScopeKey() !== owner) throw new Error('OWNER_SCOPE_CHANGED');
          }, fastMode);
          return { ok: true as const, ...result };
        }),
      },
      botCapabilities: deps.botCapabilities,
      botSkills: {
        save: async (params) => {
          const saved = botLearningTracker.capture(params.callerSessionId);
          const result = await saveBotSkillForSession(params);
          if (result.ok) saved({ kind: 'skill', key: result.skill.slug, title: result.skill.name,
            action: result.created ? 'created' : 'updated' });
          return result;
        },
        list: (params) => listBotSkillsForSession(params),
      },
      // Linked projects of the calling teammate; the host derives the teammate from the caller session.
      teammateProjects: runBotProjectsTool,
      skillhub: createSkillhubAgentTools({
        isCurrentSession: (context) => !!context.sessionId
          && deps.isCurrentLocalSessionInstance?.(context.sessionId, context.sessionInstanceId) === true,
        authorizePath: (request) => authorizeDesktopSessionPath(request, deps.getLiveSessionGrantState),
      }),
      history: {
        ...createHistoryToolCallbacks({ authorizeCall: authorizeTaskToolCall, invokeRemote: deps.invokeRemote }),
        readSessionAttachment: (args, context) => withAccountDataAccess(context?.sessionId, async assertCurrent => {
          const result = await readDesktopHistoryAttachment(args, context);
          await assertCurrent();
          return result;
        }),
        listTeammates: (args, callerSessionId) => withAccountDataAccess(callerSessionId, async assertCurrent => {
          const page = await readTeammateDirectory(args);
          await assertCurrent();
          return { ok: true as const, page };
        }),
        sessionUrl: (sessionId) => buildHistorySessionDeepLink(sessionId, getDeviceId()),
        remote: deps.historyRemote,
        searchCompanionRooms: async ({ callerSessionId, query, teammateId, roles, fromMs, toMs }) => {
          // 共享任务里的访客不是账号本人，不能经 Agent 读主人和伙伴的对话。
          const runtime = isSessionSharedTaskActive(callerSessionId) ? null : activeCompanionCloud();
          return runtime ? runtime.searchOtherRooms(query, { filter: { roles, fromMs, toMs }, ...(teammateId ? { teammateId } : {}) }) : null;
        },
        // get_task_digest:一件任务的短摘要(本机或 deviceId::sessionId 只读)。
        taskDigest: async (args) => {
          try { return await readTaskDigest(args); }
          catch (err) { const msg = err instanceof Error ? err.message : String(err); const errorCode = isDbClientNotReadyError(err) ? 'HOST_NOT_READY' : 'INTERNAL'; return { ok: false, errorCode, message: msg }; }
        },
      },
      // submit_github_issue: 官方反馈提交(确认卡片 → serverApiFetch)。
      // holder 同样是延迟查找，registerMakerIpc 里 init。
      githubIssue: (req) => submitGithubIssueForSession(req),
      mcpSetup: (context, proposal) => requestMcpSetupForSession(
        context.sessionId!, context.sessionInstanceId!, proposal),
      ...(deps.captureSharedTaskCommand ? { sharedTask: createSharedTaskTools({
        caller: context => {
          const sessionId = context.sessionId ?? '';
          const session = getTaskActionSession(sessionId);
          const input = getTaskActionInputState(sessionId);
          const lane = readChannelToolScope({ sessionId, sessionInstanceId: context.sessionInstanceId });
          return {
            key: JSON.stringify([activeOwnerScopeKey(), getCurrentDbClientSnapshot()?.clientEpoch, input.key, input.boundary,
              lane?.channel, lane?.botId, lane?.chatId, lane?.inputClientId,
              session?.stablePermissionModeState, session?.stablePlanModeState]),
            accountScoped: lane ? lane.requesterIsOwner : isActiveInputAccountScoped(sessionId),
            current: !isAppSessionBoundaryPending() && !!tryGetDbClient() &&
              !!context.sessionInstanceId && session?.instanceId === context.sessionInstanceId &&
              input.permission?.isCurrent?.() === true,
            planMode: input.permission?.planModeEnabled !== false || input.permission?.permissionMode === 'plan',
          };
        },
        captureGroupAccess: async context => {
          const [link] = await getDbClient().drizzle.select({ botId: botSessionLinks.botId, role: botSessionLinks.role })
            .from(botSessionLinks).where(eq(botSessionLinks.sessionId, context.sessionId!)).limit(1);
          return link?.role === 'group' ? authorizeGroupTool(context.sessionId!, link.botId, 'owner-action') : null;
        },
        assertActionCurrent: assertTaskActionCurrent,
        captureCommand: deps.captureSharedTaskCommand,
      }) } : {}),
    },
    // cindy_orca: 多 worker 协同 team 工具集。创建权限由 Main handler 实时校验。
    orca: {
      authorizeCall: authorizeTaskToolCall,
      startTeam: wrap((s, params) => s.startTeam(params)),
      createWorker: wrap((s, params) => s.createWorker(params)),
      listWorkers: wrap((s, params) => s.listWorkers(params)),
      switchFocus: wrap((s, params) => s.switchFocus(params)),
      sendToWorker: wrap(
        (
          s,
          params: {
            callerLeadSessionId: string;
            targetSessionId: string;
            message: string;
            delivery?: 'queue' | 'steer';
            /** MCP 工具层字段名; host service 内部叫 imagePaths。 */
            images?: string[];
          },
        ) => {
          const { images, ...rest } = params;
          return s.sendToWorker({ ...rest, ...(images ? { imagePaths: images } : {}) });
        },
      ),
      interruptWorker: wrap((s, params) => s.interruptWorker(params)),
      listWorkerQueuedMessages: wrap((s, params) => s.listWorkerQueuedMessages(params)),
      updateWorkerQueuedMessage: wrap((s, params) => s.updateWorkerQueuedMessage(params)),
      cancelWorkerQueuedMessage: wrap((s, params) => s.cancelWorkerQueuedMessage(params)),
      mergeWorkerQueuedMessages: wrap((s, params) => s.mergeWorkerQueuedMessages(params)),
      steerWorkerQueuedMessage: wrap((s, params) => s.steerWorkerQueuedMessage(params)),
      moveWorkerQueuedMessage: wrap((s, params) => s.moveWorkerQueuedMessage(params)),
      idleWorker: wrap((s, params) => s.idleWorker(params)),
      endTeam: wrap((s, params) => s.endTeam(params)),
      archiveWorker: wrap((s, params) => s.archiveWorker(params)),
      updateWorker: wrap((s, params) => s.updateWorker(params)),
      listAvailableModels: wrap((s, params) => s.listAvailableModels(params)),
      getWorkspaceInfo: wrap((s, params) => s.getWorkspaceInfo(params)),
      getWorkerStatus: wrap((s, params) => s.getWorkerStatus(params)),
      readWorker: wrap((s, params) => s.readWorker(params)),
    } as OrcaMcpDeps,
    // xd-service 已于 2026-07-13 整包退役:Pages 全部能力(含部署)迁入内置
    // 意识 xd-pages(登录邮箱派生凭证 + 目录过户上传),经 ghost_call 调用。
  });

  // 用 plugin registry gate 包装每个 provider 的 isEnabled。
  // essential plugin 始终放行；非 essential plugin 按 project → user → default 判定。
  // provider name(如 'lizi_jira') 会先映射成用户可见的 plugin id(如 'jira')。
  const gated = gateBuiltinMcpProviders(providers, () => deps.pluginRegistry);

  // cindy:意识总机(cindy-tools;网关模式,
  // docs/dev-rules/plugin-security-and-authoring.md;2026-07-12 由 cindy_ghosts 更名——server 名进
  // 工具全名 mcp__<server>__<tool>,短名让调用行少啰嗦一截,历史消息的旧
  // 全名由 shared/ghost.ts isGhostCallToolName 兼容匹配)。常注册不设
  // plugin gate——工具面恒定是缓存前缀稳定的前提,"没装任何意识"表现为
  // ghost_list 返回空清单而非 server 消失,LLM 不困惑、老会话即时生效。
  gated.push({
    name: 'cindy_group_history',
    isEnabled: () => true,
    toClaudeSdkConfig: (ctx) => ({
      type: 'sdk',
      name: 'cindy_group_history',
      instance: createGroupHistoryMcpServer({
        getSessionContext: () => resolveLiziMcpSessionContext(ctx),
      }),
    }),
  });

  gated.push({
    name: 'cindy_imessage',
    isEnabled: ctx => hasImChannelVendorOptions(ctx.vendorOptions, 'imessage')
      || ((ctx.agentKind === 'codex' || ctx.agentKind === 'pi') && !ctx.workingDir),
    toClaudeSdkConfig: ctx => ({ type: 'sdk', name: 'cindy_imessage',
      instance: createIMessageMcpServer({ getSessionContext: () => resolveLiziMcpSessionContext(ctx) }) }),
  });

  // cindy_telegram_bot: 个人 / 伙伴 Telegram bot 轮次里的 Bot API 直通。只挂在带 Telegram 渠道
  // vendorOptions 的会话上: 专线 / 个人 bot 会话由 adapter.buildVendorOptions 写 telegramChatId,
  // 伙伴主任务由 botProfileRuntime 写「绑了哪些渠道」标记(官方 hook 会话不写, 桌面任务也没有),
  // 别处看不到这组工具。真正能不能动哪个 chat 由逐轮作用域租约(im/shared/channelToolScope.ts)
  // 在调用期判定, 没有租约一律 fail closed。
  // Codex / Pi 的共享 app-server / bridge 在还没有 thread / workdir 的阶段(空 ctx)建一次工具
  // 清单, 这里不注册它就永远挂不上; 所以空 workdir 快照先放行, 逐会话可见性由
  // codexEnvironment.buildSessionMcpConfig / piEnvironment capabilityGated 按同一份标记决定。
  gated.push({
    name: 'cindy_telegram_bot',
    isEnabled: (ctx) =>
      hasImChannelVendorOptions(ctx.vendorOptions, 'telegram')
      || ((ctx.agentKind === 'codex' || ctx.agentKind === 'pi') && !ctx.workingDir),
    toClaudeSdkConfig: (ctx) => ({
      type: 'sdk',
      name: 'cindy_telegram_bot',
      instance: createTelegramBotMcpServer({
        getSessionContext: () => resolveLiziMcpSessionContext(ctx),
      }),
    }),
  });

  gated.push({
    name: 'cindy',
    capability: {
      title: 'Plugins and media', description: 'Discover installed plugins, their tools, accounts and media capabilities.',
      source: 'builtin', discovery: { tool: 'ghost_list' },
    },
    isEnabled: () => true,
    // ctx 闭包进 deps:claude in-process 路径的 tool-call 没有 ALS 语境,
    // 目录过户(workdir 钳制)与卡片 session 锚定都靠这份按 session 绑定的
    // 语境;codex 路径运行期仍以 ALS 恢复的语境优先(见 getCindyGhostsMcpDeps)。
    toClaudeSdkConfig: (ctx) => ({
      type: 'sdk',
      name: 'cindy',
      instance: createCindyGhostsMcpServer(
        getCindyGhostsMcpDeps(ctx, {
          pluginMarket: getPluginMarketService(),
          getAppVersion: deps.getAppVersion,
          getLiveSessionGrantState: deps.getLiveSessionGrantState,
          requestHostPermission: deps.requestHostPermission,
          createMediaDownloadContext: deps.createMediaDownloadContext,
          describeToolResultImage: deps.describeToolResultImage,
          onToolResultImagesFailed: deps.onToolResultImagesFailed,
        }),
      ),
    }),
  });

  setHostToolProviders(gated, getActiveDataOwnerPushStamp());
  return gated;
}
