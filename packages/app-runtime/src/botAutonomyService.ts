import type {RoutineEngine} from '@cindy/maker-scheduler';
import {BOT_AUTONOMY_IPC,type WatchedSession} from '@cindy/companion-core/botAutonomy';
import {BotAutonomyRuntime} from '@cindy/companion-core/autonomy/runtime';
import {TaskWatch,errorCode} from '@cindy/companion-core/autonomy/taskWatch';
import type {Logger} from '@cindy/maker-core';
import type {AgentIslandService} from './session-activity/service.js';
import type {OwnerBroadcastTap} from './ownerBroadcast.js';
import type {createBotAutonomyHostData} from './botAutonomyHostData.js';
import type {createBotAutonomyHub} from './botAutonomyHub.js';
import type {createBotAutonomySettings} from './botAutonomySettings.js';
import type {createBotWorkbenchAutonomyBridge} from './botWorkbenchAutonomyBridge.js';
import type {RoutineEngineLifecycleListener} from './routineService.js';
type HostData=ReturnType<typeof createBotAutonomyHostData>;
export interface BotAutonomyServiceHost extends Pick<OwnerBroadcastTap,'getSafeDataOwnerPushStamp'|'tapWindowBroadcast'>,
 Pick<HostData,'readInterruptedSessionMetas'|'readLocalSessionMetas'|'readTaskOwnership'|'toRemoteTargets'>,
 Pick<ReturnType<typeof createBotAutonomyHub>,'getActiveBotAutonomy'|'getBotAutonomyHostDeps'|'scopeIsCurrent'|'setActiveBotAutonomy'>,
 Pick<ReturnType<typeof createBotAutonomySettings>,'readBotAutonomySettingsOverride'>,
 Pick<ReturnType<typeof createBotWorkbenchAutonomyBridge>,'registerBotAutonomyReader'> {
 getAgentIslandService():Pick<AgentIslandService,'getSessionActivitySnapshots'|'isToolCallInFlight'|'subscribeSessionActivity'>|null;
 getAppCapabilities():{canUseDeviceLink:boolean};ownerScopedUserDataPath():string;
 onRoutineEngineLifecycle(listener:RoutineEngineLifecycleListener):()=>void;
 listDevices():Promise<{devices:Parameters<HostData['toRemoteTargets']>[0]}>;
 mayServeBackgroundRead:Parameters<HostData['toRemoteTargets']>[1];
 remoteBackgroundInvoke(device:string,channel:string,args:unknown[]):Promise<{ok:true;result:unknown}|{ok:false;error:{code:string}}>;
 setBotAutonomyBotsChangedListener(listener:(()=>void)|null):void;
 remindOwner(row:WatchedSession,eventId:string):void;broadcastLocal(channel:string,payload:unknown):void;
 log:Pick<Logger,'info'|'warn'|'debug'>;
}
export function createBotAutonomyService(host:BotAutonomyServiceHost) {
 const {getAgentIslandService,getAppCapabilities,ownerScopedUserDataPath,getSafeDataOwnerPushStamp,tapWindowBroadcast,remoteBackgroundInvoke,listDevices,readBotAutonomySettingsOverride,registerBotAutonomyReader,onRoutineEngineLifecycle,mayServeBackgroundRead,readInterruptedSessionMetas,readLocalSessionMetas,readTaskOwnership,toRemoteTargets,getActiveBotAutonomy,getBotAutonomyHostDeps,scopeIsCurrent,setActiveBotAutonomy,setBotAutonomyBotsChangedListener,remindOwner,broadcastLocal,log}=host;
/** 伙伴资料 / 生命周期变化合并后再重读归属（同一次保存常连发几条广播）。 */
const BOTS_CHANGED_DEBOUNCE_MS = 300;

let initialized = false;
let unsubscribeLifecycle:(()=>void)|undefined;
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
function initBotAutonomy(): void {
  if (initialized) return;
  initialized = true;
  setBotAutonomyBotsChangedListener(onBotsChanged);
  unsubscribeLifecycle=onRoutineEngineLifecycle({
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
        const result = await listDevices();
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
      broadcastLocal(BOT_AUTONOMY_IPC.changed,payload);
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


return {initBotAutonomy,dispose(){unsubscribeLifecycle?.();setBotAutonomyBotsChangedListener(null);if(botsChangedTimer)clearTimeout(botsChangedTimer);botsChangedTimer=null;stopRuntime();}};
}
