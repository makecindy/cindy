import { app } from 'electron';
import './pre-run-hook.desktop.js';
import type { BrowserWindow } from 'electron';
import { eq } from 'drizzle-orm';

import type { FeishuIM } from '@cindy/im';

import { dialogueWorkspaceRoots } from '../localDb/dialogueWorkspace';
import { sessions } from '../localDb/schema.js';
import { getDbClient } from '../localDb/client/current';
import { startRewoundSchedulerPromptCleanup, stopRewoundSchedulerPromptCleanup } from './rewoundSchedulerPromptCleanup.js';
import { readRemoteProviderRoute } from '../remote-agent/controller/deviceCatalog.js';
import {
  resolveDefaultScheduleRoute,
  resolveRouteCopyCapabilities,
  resolveScheduledModelSelectionLive,
  verdictForModelRoute,
} from '../maker-host/model-route-guard-live.js';
import { getAgentIslandService } from '../agent-island/service.js';
import { getDesktopNotificationsEnabled } from '../notificationService.js';
import {
  applyPiImModelSelectionUnderLock,
  acquirePendingAgentSwitchForDirectSend,
  prepareScheduledModelPreferencesUnderLock,
  recordDispatchedModel,
  broadcastSessionCreated,
  bootstrapScheduledSession,
  cancelSchedulerAutoResume,
  enqueueSchedulerPrompt,
  ensureSchedulerQueueRestored,
  findSchedulerUsageLimitWait,
  getSessionLastUserActionAt,
  hasQueuedSchedulerPrompt,
  isSchedulerAutoResumePending,
  isSchedulerPromptTracked,
  isSchedulerTargetSessionBusy,
  onSchedulerAutoResumeFailed,
  removeQueuedSchedulerPrompt,
} from '../maker-ipc/register.js';
import { DrizzleScheduleStorage } from './storage.desktop';
import { MakerScheduleRunner } from './runner.desktop';
import { captureScheduledOwnerGuard } from '../maker-ipc/scheduledSessionBootstrap.js';
import { listMessagesForAgentHandoff } from '../localDb/ipc/messages.js';
import { drainPersistQueue } from '../messagePersistBroadcaster.desktop.js';
import { ScriptScheduleRunner } from './script-runner.desktop';
import { SchedulerScriptCapabilityBroker } from './script-capability-broker.desktop';
import { DesktopNotifier } from './notifier.desktop';
import { sendFeishuSessionNotification } from '../im/feishu/notificationOrigin';
import { wecomGroupNotificationService } from '../wecomGroupNotification';
import { withTeammateHomeGuard } from './teammateHomeGuard.js';
import { ownTeammateProjectState } from './ownTeammateProject.js';
import { companionHomes } from '../companion-cloud/homes.js';
import { startScheduleWebhooks, stopScheduleWebhooks } from './webhook/runtime.js';

import { createSchedulerHost, type SchedulerHostStartDeps } from './index.js';

export interface StartSchedulerDeps extends SchedulerHostStartDeps {
  getMainWindow: () => BrowserWindow | null;
  feishuIm: FeishuIM;
}

const desktop = createSchedulerHost<StartSchedulerDeps>({
  createStorage: getDb => new DrizzleScheduleStorage(getDb),
  createRunners(deps, storage) {
    const notifier = new DesktopNotifier({
      hasUnrecoveredMatchingFailure: (run) => storage.hasUnrecoveredMatchingFailure(run),
      sendFeishuSessionNotification: async (sessionId, text) => {
        await sendFeishuSessionNotification(deps.feishuIm, sessionId, text);
      },
      getMainWindow: deps.getMainWindow,
      feishuIm: deps.feishuIm,
      logger: deps.logger,
      shouldNotifyDesktop: getDesktopNotificationsEnabled,
      isRunAlertShownElsewhere: (run) =>
        getAgentIslandService()?.ownsTaskAlert(run.status === 'failed' ? 'error' : 'done') === true,
      wecomGroupPublisher: wecomGroupNotificationService,
    });
    const promptRunner = new MakerScheduleRunner({
      maker: deps.maker,
      bootstrapSession: bootstrapScheduledSession,
      getDb: deps.getDb,
      notifier,
      logger: deps.logger,
      diagnosePreRunHookFailure: deps.diagnosePreRunHookFailure,
      beforeDispatchUserTurn: deps.beforeDispatchUserTurn,
      readAutoReviewHistory: async (sessionId) => {
        await drainPersistQueue();
        return listMessagesForAgentHandoff(sessionId, null, undefined, 'authorization');
      },
      onUndispatchedUserTurn: deps.onUndispatchedUserTurn,
      findUsageLimitWait: findSchedulerUsageLimitWait,
      acquirePendingAgentSwitch: acquirePendingAgentSwitchForDirectSend,
      prepareModelPreferences: prepareScheduledModelPreferencesUnderLock,
      onModelDispatched: recordDispatchedModel,
      applyPiModelSelectionUnderLock: applyPiImModelSelectionUnderLock,
      resolveModelSelection: (selection, location) => {
        const route = { ...selection, agentDeviceId: selection.agentDeviceId === undefined ? location?.agentDeviceId : selection.agentDeviceId };
        return resolveScheduledModelSelectionLive(route, async (agentDeviceId) => [
          (await readRemoteProviderRoute({ ...route, agentDeviceId })).provider,
        ]);
      },
      onSessionCreated: broadcastSessionCreated,
      // 停用轴裁决:每次 fire 前判保存路由是否已被用户停用(见 runner deps 注释)。
      checkModelRoute: verdictForModelRoute,
      // Agent 在另一台电脑运行的任务按那台的目录裁决，本机停用轴不适用(读失败按本机任务处理)。
      isAgentOnOtherDevice: async (sessionId) => {
        const [row] = await getDbClient()
          .drizzle.select({ agentDeviceId: sessions.agentDeviceId, remoteHostId: sessions.remoteHostId })
          .from(sessions)
          .where(eq(sessions.id, sessionId))
          .limit(1);
        return !!row?.agentDeviceId && !row.remoteHostId;
      },
      // 隐式改道后按落地拷贝 reconcile effort/Fast(见 runner deps 注释,R27)。
      resolveRouteCopyCapabilities,
      resolveDefaultModelRoute: resolveDefaultScheduleRoute,
      // 心跳撞忙排队桥:实现挂在 maker-ipc/register.ts 的 coordinator 装配处
      // 先恢复快照再判忙闲；holder 未就绪时恢复返回 false，由 runner 顺延。
      schedulerQueue: {
        getLastUserActionAt: getSessionLastUserActionAt,
        ensureQueueRestored: ensureSchedulerQueueRestored,
        isSessionBusy: isSchedulerTargetSessionBusy,
        hasQueuedPrompt: hasQueuedSchedulerPrompt,
        enqueuePrompt: enqueueSchedulerPrompt,
        removeQueuedPrompt: removeQueuedSchedulerPrompt,
        isPromptTracked: isSchedulerPromptTracked,
        isAutoResumePending: isSchedulerAutoResumePending,
        onAutoResumeFailed: onSchedulerAutoResumeFailed,
        cancelAutoResume: cancelSchedulerAutoResume,
      },
    });
    const scriptRunner = new ScriptScheduleRunner({
      broker: new SchedulerScriptCapabilityBroker({
        resolveDefaultModelRoute: resolveDefaultScheduleRoute,
      }),
      logger: deps.logger,
      notifier,
      getDb: deps.getDb,
      diagnosePreRunHookFailure: deps.diagnosePreRunHookFailure,
    });
    return { notifier, promptRunner, scriptRunner };
  },
  // A teammate's project automations run only on its main computer (handed away: skipped here).
  captureFireContext: captureScheduledOwnerGuard,
  wrapRunner: runner => withTeammateHomeGuard(runner, () => companionHomes.snapshot().demotedBotIds, ownTeammateProjectState),
  isOwnTeammateProject: async workingDir => (await ownTeammateProjectState(workingDir)) !== null,
  isPassive: () => !app.isPackaged && process.env.XDT_SCHEDULER_PASSIVE === '1',
  dialogueWorkspaceRoots: () => dialogueWorkspaceRoots(),
  onStarted(scheduler, deps, passive) {
    startRewoundSchedulerPromptCleanup({ logger: deps.logger });
    if (!passive) void startScheduleWebhooks(scheduler, deps.logger).catch(error =>
      deps.logger.warn?.(`[scheduler-host] schedule webhooks failed to start (non-fatal): ${String(error)}`));
  },
  async beforeReset() {
    stopRewoundSchedulerPromptCleanup();
    await stopScheduleWebhooks();
  },
});

export const startScheduler = desktop.startScheduler;
export const resumeInterruptedScheduleRun = desktop.resumeInterruptedScheduleRun;
export const getSchedulerIfInitialized = desktop.getSchedulerIfInitialized;
export const getScheduler = desktop.getScheduler;
export const getScheduleStorage = desktop.getScheduleStorage;
export const getScheduleStorageIfInitialized = desktop.getScheduleStorageIfInitialized;
export const getProjectAutomationLoader = desktop.getProjectAutomationLoader;
export const resetScheduler = desktop.resetScheduler;
