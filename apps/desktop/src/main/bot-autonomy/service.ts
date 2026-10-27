/**
 * 伙伴自主跟进 · 宿主装配（Electron / 数据库 / 设备互联 / 通知）。
 *
 * 生命周期跟随例行任务引擎：引擎在某个账号范围启动 → 建运行体、登记 `host:sessions`、开始观察；
 * 引擎停止（换账号 / 重建）→ 运行体立刻停止，状态表丢弃。纯逻辑在 runtime / taskWatch / events /
 * follower / glance / phase；输入协调器与伙伴 IPC 只经 hub.ts，不加载本文件的重依赖。
 * 只由 bootstrap 引入。
 */
import { BrowserWindow } from 'electron';
import type { RoutineEngine } from '@cindy/maker-scheduler';

import { BOT_AUTONOMY_IPC, type WatchedSession } from '../../shared/botAutonomy.js';
import { getAgentIslandService } from '../agent-island/service.js';
import { getAppCapabilities } from '../appCapabilities.js';
import { ownerScopedUserDataPath } from '../appSessionState.js';
import { getSafeDataOwnerPushStamp, tapWindowBroadcast } from '../device-link/broadcast-tap.js';
import { getMobileNotifyGeneration, remoteBackgroundInvoke, sendMobileSessionNotify } from '../device-link/index.js';
import { defaultDeps as deviceDirectoryDeps, handleListDevices } from '../device-link/ipc.js';
import { createLogger } from '../logger.js';
import { readBotAutonomySettingsOverride } from '../maker-host/bot-autonomy-settings-store.js';
import { registerBotAutonomyReader } from '../maker-ipc/botWorkbenchAutonomyBridge.js';
import { getDesktopNotificationsEnabled, showDesktopSessionEvent } from '../notificationService.js';
import { ensureNightlyLearningBuiltin, onRoutineEngineLifecycle } from '../routines/service.js';
import { mayServeBackgroundRead } from '../usage/peerUsageSync.js';
import {
  readInterruptedSessionMetas,
  readLocalSessionMetas,
  readTaskOwnership,
  toRemoteTargets,
} from './hostData.js';
import {
  getActiveBotAutonomy,
  getBotAutonomyHostDeps,
  scopeIsCurrent,
  setActiveBotAutonomy,
} from './hub.js';
import { setBotAutonomyBotsChangedListener } from './botsChangedSignal.js';
import { BotAutonomyRuntime } from './runtime.js';
import { TaskWatch, errorCode } from './taskWatch.js';

export { configureBotAutonomyHost } from './hub.js';

const log = createLogger('bot-autonomy');
/** 伙伴资料 / 生命周期变化合并后再重读归属（同一次保存常连发几条广播）。 */
const BOTS_CHANGED_DEBOUNCE_MS = 300;

let initialized = false;
let botsChangedTimer: ReturnType<typeof setTimeout> | null = null;

function onBotsChanged(): void {
  if (botsChangedTimer) return;
  botsChangedTimer = setTimeout(() => {
    botsChangedTimer = null;
    const active = getActiveBotAutonomy();
    if (!active || !scopeIsCurrent(active.scope)) return;
    active.runtime.refreshFollowers().catch((error) => log.warn('autonomy follower refresh failed', { error: errorCode(error) }));
  }, BOTS_CHANGED_DEBOUNCE_MS);
  botsChangedTimer.unref?.();
}

function assertScope(scope: string): void {
  if (!scopeIsCurrent(scope)) throw Object.assign(new Error('owner changed'), { code: 'OWNER_CHANGED' });
}

/** 启动时调用一次：挂到例行任务引擎生命周期上。 */
export function initBotAutonomy(): void {
  if (initialized) return;
  initialized = true;
  setBotAutonomyBotsChangedListener(onBotsChanged);
  onRoutineEngineLifecycle({
    started: (engine, scope) => startRuntime(engine, scope),
    stopped: (engine) => {
      if (getActiveBotAutonomy()?.engine === engine) stopRuntime();
    },
    botResumed: (botId) => {
      void getActiveBotAutonomy()?.runtime.ensureBot(botId);
    },
  });
}

function stopRuntime(): void {
  const active = getActiveBotAutonomy();
  if (!active) return;
  active.runtime.stop();
  setActiveBotAutonomy(null);
  registerBotAutonomyReader(null);
}

function startRuntime(engine: RoutineEngine, scope: string): void {
  const existing = getActiveBotAutonomy();
  if (existing?.engine === engine && existing.scope === scope) return;
  stopRuntime();
  const userDataDir = ownerScopedUserDataPath();
  const ownerStamp = getSafeDataOwnerPushStamp();
  const runtime = new BotAutonomyRuntime({
    engine,
    ensureOwnBuiltins: async (botId) => { await ensureNightlyLearningBuiltin(engine, botId); },
    now: Date.now,
    log,
    isCurrent: () => scopeIsCurrent(scope),
    createWatch: (onChange) => new TaskWatch({
      now: Date.now,
      log,
      onChange,
      getActivitySnapshots: () => getAgentIslandService()?.getSessionActivitySnapshots() ?? [],
      readSessionExecution: (id) => getBotAutonomyHostDeps().readSessionExecution?.(id) ?? null,
      isToolCallInFlight: (sessionId) => getAgentIslandService()?.isToolCallInFlight(sessionId) ?? false,
      getPendingInteractions: (sessionId) => {
        try {
          return getBotAutonomyHostDeps().getPendingInteractions?.(sessionId) ?? [];
        } catch {
          return [];
        }
      },
      readLocalSessions: async (ids) => {
        assertScope(scope);
        const rows = await readLocalSessionMetas(ids);
        assertScope(scope);
        return rows;
      },
      readInterruptedSessions: async (sinceMs, limit, sessionIds) => {
        assertScope(scope);
        const rows = await readInterruptedSessionMetas(sinceMs, limit, sessionIds);
        assertScope(scope);
        return rows;
      },
      readOwnership: async () => {
        assertScope(scope);
        const snapshot = await readTaskOwnership(userDataDir);
        assertScope(scope);
        return snapshot;
      },
      readSchedulerOverride: () => {
        assertScope(scope);
        return readBotAutonomySettingsOverride();
      },
      listRemoteDevices: async () => {
        if (!scopeIsCurrent(scope) || !getAppCapabilities().canUseDeviceLink) return null;
        const result = await handleListDevices(deviceDirectoryDeps());
        if (!scopeIsCurrent(scope)) return null;
        return toRemoteTargets(result.devices, mayServeBackgroundRead);
      },
      invokeRemote: async (deviceId, channel, args) => {
        assertScope(scope);
        const result = await remoteBackgroundInvoke(deviceId, channel, args);
        assertScope(scope);
        if (!result.ok) throw Object.assign(new Error('remote read failed'), { code: result.error.code });
        return result.result;
      },
    }),
    subscribeActivity: (watch) => {
      const island = getAgentIslandService();
      if (!island) return null;
      // 订阅晚于启动时，把当前快照补进来。
      for (const snapshot of island.getSessionActivitySnapshots()) watch.applyActivity(snapshot.sessionId, snapshot);
      return island.subscribeSessionActivity(({ sessionId, current: next }) => watch.applyActivity(sessionId, next));
    },
    remind: (row, eventId) => remindOwner(row, eventId),
    push: (payload) => {
      if (!scopeIsCurrent(scope)) return;
      for (const window of BrowserWindow.getAllWindows()) {
        if (!window.isDestroyed()) window.webContents.send(BOT_AUTONOMY_IPC.changed, payload);
      }
      tapWindowBroadcast(BOT_AUTONOMY_IPC.changed, payload, ownerStamp);
    },
  });
  setActiveBotAutonomy({ scope, engine, runtime });
  const live = () => getActiveBotAutonomy()?.runtime === runtime && scopeIsCurrent(scope);
  registerBotAutonomyReader({
    // 归属还没读到时返回 null（工具报 HOST_NOT_READY），不把空表当成「什么都不用管」交给伙伴。
    glance: (botId) => (live() && runtime.watch.isReady() ? runtime.glance(botId) : null),
    schedulerBotId: () => (live() ? runtime.watch.getSchedulerBotId() : null),
    watched: (sessionId) => (live() ? runtime.watch.get(sessionId) ?? null : null),
  });
  runtime.start().catch((error) => log.warn('autonomy start failed', { error: errorCode(error) }));
  log.info('autonomy started');
}

/** 没人跟的本机任务在等主人：桌面通知（主窗口在前台时不弹）+ 手机推送。 */
function remindOwner(row: WatchedSession, eventId: string): void {
  const getWindow = () => getBotAutonomyHostDeps().getMainWindow?.() ?? null;
  const window = getWindow();
  const focused = !!window && !window.isDestroyed() && window.isVisible() && window.isFocused();
  if (!focused && getDesktopNotificationsEnabled()) {
    showDesktopSessionEvent(getWindow, {
      sessionId: row.sessionId,
      title: row.title,
      kind: 'needs-reply',
      ...(row.pendingQuestion ? { body: row.pendingQuestion } : {}),
    });
  }
  sendMobileSessionNotify({
    sessionId: row.sessionId,
    title: row.title,
    kind: 'needs-reply',
    ...(row.pendingQuestion ? { detail: row.pendingQuestion } : {}),
    eventId: `bot-autonomy:${eventId}`,
    generation: getMobileNotifyGeneration(),
  });
}

