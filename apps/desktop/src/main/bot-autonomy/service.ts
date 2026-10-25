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
import { onRoutineEngineLifecycle } from '../routines/service.js';
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

import {createBotAutonomyService} from '@cindy/app-runtime/botAutonomyService';
const log=createLogger('bot-autonomy');
export const {initBotAutonomy}=createBotAutonomyService({getAgentIslandService:(...args)=>getAgentIslandService(...args),getAppCapabilities:(...args)=>getAppCapabilities(...args),ownerScopedUserDataPath:(...args)=>ownerScopedUserDataPath(...args),getSafeDataOwnerPushStamp:(...args)=>getSafeDataOwnerPushStamp(...args),tapWindowBroadcast:(...args)=>tapWindowBroadcast(...args),remoteBackgroundInvoke:(...args)=>remoteBackgroundInvoke(...args),readBotAutonomySettingsOverride:(...args)=>readBotAutonomySettingsOverride(...args),registerBotAutonomyReader:(...args)=>registerBotAutonomyReader(...args),onRoutineEngineLifecycle:(...args)=>onRoutineEngineLifecycle(...args),mayServeBackgroundRead:(...args)=>mayServeBackgroundRead(...args),readInterruptedSessionMetas:(...args)=>readInterruptedSessionMetas(...args),readLocalSessionMetas:(...args)=>readLocalSessionMetas(...args),readTaskOwnership:(...args)=>readTaskOwnership(...args),toRemoteTargets:(...args)=>toRemoteTargets(...args),getActiveBotAutonomy:(...args)=>getActiveBotAutonomy(...args),getBotAutonomyHostDeps:(...args)=>getBotAutonomyHostDeps(...args),scopeIsCurrent:(...args)=>scopeIsCurrent(...args),setActiveBotAutonomy:(...args)=>setActiveBotAutonomy(...args),setBotAutonomyBotsChangedListener:(...args)=>setBotAutonomyBotsChangedListener(...args),remindOwner:(...args)=>remindOwner(...args),listDevices:()=>handleListDevices(deviceDirectoryDeps()),broadcastLocal:(channel,payload)=>{for(const window of BrowserWindow.getAllWindows())if(!window.isDestroyed())window.webContents.send(channel,payload);},log});
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

