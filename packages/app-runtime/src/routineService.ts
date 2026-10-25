import {REMOTE_RESOURCE_CHANGED_CHANNEL} from '@cindy/device-link';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {RoutineEngine,rewriteRoutinePluginSource,type Routine,type RoutineRun,type RoutineInput,type Schedule,type ScheduleStorage,type Scheduler} from '@cindy/maker-scheduler';
import {RoutineFileStore} from '@cindy/maker-scheduler/routine-store';
import {throwIpcError} from '@cindy/remote-agent/ipcValidate';
import {assertPreRunHookCommandSyntax} from './schedulePreRunHook.js';
import {buildRoutineSchedule,createCompanionRoutineTransfer} from '@cindy/companion-core/routines';
import {botProfiles} from '@cindy/runtime-db/schema';
import {BUILTIN_FOLLOW_UP_ROUTINE_PREFIX,BUILTIN_TODO_CHECK_ROUTINE_PREFIX} from '@cindy/companion-core/botAutonomy';
import {TODO_CHECK_PROMPT_VERSION,buildTodoCheckRoutineInput,builtinTodoCheckRoutineId} from '@cindy/companion-core/autonomy/todoCheckRoutine';
import type {Logger} from '@cindy/maker-core';
import type {createCurrentDbClient} from '@cindy/runtime-db/client/current';
import type {OwnerBroadcastTap} from './ownerBroadcast.js';
import type {MessageServiceHost} from './messageServiceHost.js';
import type {createBotAutonomyHub} from './botAutonomyHub.js';
export type {CompanionRoutineValue} from '@cindy/companion-core/routines';
export interface RoutineHostDeps {
  assertImportedAutomationReady?: (root:string,botId:string,routineId:string,assertOwner:()=>void,request?:{input?:RoutineInput;expectedRevision?:number})=>Promise<number|void>;
  prepareImportedAutomation?: (root:string,routine:Routine,runId:string,signal:AbortSignal,assertOwner:()=>void)=>Promise<{runId:string;prompt:string;direct?:string;skipped?:boolean;deferred?:boolean;exhausted?:boolean}|undefined>;
  finishImportedAutomation?: (root:string,routine:Routine,sessionId:string,runId:string,text:string,direct:boolean,signal:AbortSignal,assertOwner:()=>void)=>Promise<boolean>;
  recoverImports?: () => Promise<void>;
  getBot(botId: string): Promise<{ status: string; canonicalSessionId?: string | null }>;
  getScheduler(): Pick<Scheduler, 'runNow' | 'pause' | 'delete'> | null;
  getScheduleStorage(): Pick<ScheduleStorage, 'get' | 'insert' | 'update' | 'listRuns'>;
}
export interface RoutineEngineLifecycleListener {
  started(engine: RoutineEngine, scope: string): void;
  stopped(engine: RoutineEngine): void;
  /** 伙伴恢复后（setBotPaused(false) 已落盘），内置规则需要补建。 */
  botResumed?(botId: string): void;
}

export interface RoutineServiceHost<Event> extends Pick<OwnerBroadcastTap,'tapWindowBroadcast'|'getSafeDataOwnerPushStamp'> {
 activeOwnerScopeKey():string;getActiveAppSession():{dataOwnerId:string|null};isAppSessionBoundaryPending():boolean;
 ownerScopedUserDataPath(...parts:string[]):string;isPackaged():boolean;log:Pick<Logger,'info'|'warn'>;
 getCurrentDbClientSnapshot:ReturnType<typeof createCurrentDbClient>['getCurrentDbClientSnapshot'];
 isCompanionShadowed(id:string):boolean;
 currentFollowUpEvents:ReturnType<typeof createBotAutonomyHub>['currentFollowUpEvents'];
 broadcastLocal(channel:string):void;
 createStore(directory:string):Pick<RoutineFileStore,'load'|'save'>;
 ipcMain:MessageServiceHost<Event>['ipc'];assertTrustedAppRendererEvent(event:Event):void;
}
export function createRoutineService<Event>(host:RoutineServiceHost<Event>) {
 const {activeOwnerScopeKey,getActiveAppSession,isAppSessionBoundaryPending,ownerScopedUserDataPath,assertTrustedAppRendererEvent,getCurrentDbClientSnapshot,isCompanionShadowed,currentFollowUpEvents,isPackaged,broadcastLocal,tapWindowBroadcast,getSafeDataOwnerPushStamp,ipcMain,log,createStore}=host;
/** Bootstrap supplies live getters without a service -> scheduler -> IPC dependency cycle. */

let hostDeps: RoutineHostDeps | undefined;

/**
 * 引擎生命周期观察者（宿主内置事件源与内置规则用）：事件源注册表只在内存里，引擎每次
 * 创建后都要重新登记；引擎停止（换账号 / 重建）时观察者同步收手。观察者异常只记日志，
 * 不影响引擎启动或停止。
 */

const engineLifecycleListeners = new Set<RoutineEngineLifecycleListener>();

function onRoutineEngineLifecycle(listener: RoutineEngineLifecycleListener): () => void {
  engineLifecycleListeners.add(listener);
  // 已经在跑的引擎也要立刻告知，避免注册晚于启动时漏掉第一次登记。
  if (current && !isAppSessionBoundaryPending() && current.scope === activeOwnerScopeKey()) {
    try { listener.started(current.engine, current.scope); } catch (error) { log.warn('routine lifecycle listener failed', { error: String(error) }); }
  }
  return () => engineLifecycleListeners.delete(listener);
}

function notifyEngineLifecycle(call: (listener: RoutineEngineLifecycleListener) => void): void {
  for (const listener of engineLifecycleListeners) {
    try {
      call(listener);
    } catch (error) {
      log.warn('routine lifecycle listener failed', { error: String(error) });
    }
  }
}

function configureRoutineHost(deps: RoutineHostDeps): void {
  hostDeps = deps;
}

function getRoutineHost(): RoutineHostDeps {
  if (!hostDeps) throw new Error('Routine host is not configured');
  return hostDeps;
}


/** Logged once per demoted teammate until it runs here again. */
const shadowedRoutineBots = new Set<string>();
let current:
  { scope: string; engine: RoutineEngine; timer: ReturnType<typeof setInterval> } | undefined;
let starting: Promise<RoutineEngine> | undefined;
let startingScope: string | undefined;
let startupAbort: AbortController | undefined;
let stopping: Promise<void> | undefined;
let generation = 0;

function assertScope(scope: string): void {
  if (
    !getActiveAppSession().dataOwnerId ||
    isAppSessionBoundaryPending() ||
    activeOwnerScopeKey() !== scope
  ) {
    throw new Error('Routine account is no longer active');
  }
}

/** One shared startup wait keeps first plugin reports pending across host readiness gaps. */
async function waitForStartupDependency<T>(
  scope: string,
  epoch: number,
  signal: AbortSignal,
  read: () => T | null,
): Promise<T> {
  for (;;) {
    assertScope(scope);
    if (epoch !== generation || signal.aborted) throw new Error('Routine service was reset');
    const ready = read();
    if (ready !== null) return ready;
    try {
      await delay(100, undefined, { signal, ref: false });
    } catch (error) {
      if (signal.aborted) throw new Error('Routine service was reset');
      throw error;
    }
  }
}

/** Resolve the current canonical task at dispatch time, preserving its actual model and permissions. */
async function execute(scope: string, routine: Routine, run: RoutineRun, signal: AbortSignal, canDispatch: () => boolean) {
  assertScope(scope);
  const scheduler = getRoutineHost().getScheduler();
  if (!scheduler) return { deferred: true };
  const bot = await getRoutineHost().getBot(routine.botId);
  assertScope(scope);
  if (signal.aborted) throw new Error('Routine cancelled');
  if (bot.status !== 'active' || !bot.canonicalSessionId)
    throw new Error('The teammate is unavailable');
  // Its home moved to another computer (cloud-companions.md §3): routines run only there.
  if (isCompanionShadowed(routine.botId)) {
    if (!shadowedRoutineBots.has(routine.botId)) {
      shadowedRoutineBots.add(routine.botId);
      log.info('routine skipped: teammate runs on another computer', { botId: routine.botId });
    }
    return { skipped: true };
  }
  shadowedRoutineBots.delete(routine.botId);
  if (!canDispatch()) return { deferred: true };
  // Persisted batches can predate an upgrade, opt-out or reassignment. Never replay their
  // task summaries under an obsolete follow-up choice. Manual runs remain explicit actions.
  let events = run.events;
  if (routine.builtin === 'follow-up' && events.length > 0) {
    const allowed = await currentFollowUpEvents(routine.botId, events);
    assertScope(scope);
    if (allowed === null) return { deferred: true };
    if (allowed.events.length === 0) return { skipped: true };
    events = allowed.events;
    const engineCanDispatch = canDispatch;
    canDispatch = () => engineCanDispatch() && allowed.canDispatch();
  }
  const root = ownerScopedUserDataPath();
  const imported = await getRoutineHost().prepareImportedAutomation?.(root, routine, run.id, signal, () => assertScope(scope));
  assertScope(scope);
  if (signal.aborted) throw new Error('Routine cancelled');
  if (!canDispatch()) return { deferred: true };
  if (imported?.deferred) return { deferred: true };
  if (imported?.exhausted) return { skipped: true, disableRoutine: true };
  if (imported?.skipped) return { skipped: true };
  if (imported?.direct !== undefined) {
    const exhausted = await getRoutineHost().finishImportedAutomation?.(root, routine, bot.canonicalSessionId, run.id, imported.direct, true, signal, () => assertScope(scope));
    return { resultText: imported.direct, ...(exhausted ? { disableRoutine: true } : {}) };
  }
  const storage = getRoutineHost().getScheduleStorage();
  const id = `routine-${routine.id}`;
  const now = Date.now();
  const schedule = buildRoutineSchedule(routine, run, bot.canonicalSessionId, imported?.prompt ?? routine.prompt, events, now);
  const existing = await storage.get(id);
  assertScope(scope);
  if (existing) await storage.update(id, { ...schedule, createdAt: existing.createdAt });
  else await storage.insert(schedule);
  assertScope(scope);
  if (signal.aborted) throw new Error('Routine cancelled');
  let cancellation: Promise<unknown> | undefined;
  const abort = () => {
    cancellation = scheduler
      .pause(id, { internalRoutine: true })
      .catch((error) => log.warn('routine cancellation failed', { error: String(error) }));
  };
  signal.addEventListener('abort', abort, { once: true });
  try {
    const result = await scheduler.runNow(id, { deferToCaller: true, internalRoutine: true, canDispatch });
    assertScope(scope);
    // The routine queue owns this batch and its retry delay, not the backing schedule.
    if (result.deferred) return { deferred: true };
    const rows = await storage.listRuns(id, 10);
    const completed = rows.find((row) => row.id === result.runId);
    if (!completed) throw new Error('Routine execution record is missing');
    const exhausted = imported && completed.status === 'success'
      ? await getRoutineHost().finishImportedAutomation?.(root, routine, bot.canonicalSessionId, run.id, completed.resultText ?? '', false, signal, () => assertScope(scope)) : false;
    return {
      ...(exhausted ? { disableRoutine: true } : {}),
      scheduleRunId: result.runId,
      skipped: completed.status === 'skipped',
      resultText: completed.resultText,
      ...(completed?.status === 'success' || completed?.status === 'skipped'
        ? {}
        : { error: completed?.errorMsg ?? 'Routine execution did not complete' }),
    };
  } finally {
    signal.removeEventListener('abort', abort);
    await cancellation;
  }
}

/** The service exists only for the active local data owner. */
async function getRoutineEngine(): Promise<RoutineEngine> {
  if (!isPackaged() && process.env.XDT_SCHEDULER_PASSIVE === '1') {
    throw new Error('Routines are disabled in a passive development instance');
  }
  if (stopping) {
    await stopping;
    return getRoutineEngine();
  }
  const scope = activeOwnerScopeKey();
  assertScope(scope);
  if (starting) {
    const pendingScope = startingScope;
    try {
      await starting;
    } catch (error) {
      assertScope(scope);
      // A new owner's first request must not inherit cancellation of the old owner's startup.
      if (pendingScope === scope) throw error;
    }
    return getRoutineEngine();
  }
  if (current?.scope === scope) return current.engine;
  const epoch = generation;
  const ownerId = getActiveAppSession().dataOwnerId;
  const controller = new AbortController();
  startupAbort = controller;
  startingScope = scope;
  starting = (async () => {
    if (current) {
      const previous = current.engine;
      clearInterval(current.timer);
      await current.engine.stop();
      current = undefined;
      notifyEngineLifecycle((listener) => listener.stopped(previous));
    }
    const store = createStore(ownerScopedUserDataPath('routines'));
    const saved = await store.load();
    assertScope(scope);
    if (epoch !== generation) throw new Error('Routine service was reset');
    const botStates = new Map<string, 'active' | 'paused' | 'deleted'>();
    if (saved?.routines.length) {
      const database = await waitForStartupDependency(scope, epoch, controller.signal, () => {
        const snapshot = getCurrentDbClientSnapshot();
        return snapshot?.userId === ownerId ? snapshot.client : null;
      });
      assertScope(scope);
      const profiles = await database.drizzle
        .select({ id: botProfiles.id, status: botProfiles.status }).from(botProfiles);
      assertScope(scope);
      for (const routine of saved.routines) {
        const profile = profiles.find((row) => row.id === routine.botId);
        botStates.set(routine.botId, !profile ? 'deleted' : profile.status === 'active' ? 'active' : 'paused');
      }
      // Recover an interrupted lifecycle before the first queued run can be dispatched.
      for (const routine of saved.routines) {
        const status = botStates.get(routine.botId);
        if (status !== 'active') {
          await waitForStartupDependency(scope, epoch, controller.signal, () => getRoutineHost().getScheduler());
          await cleanBackingSchedules(scope, [routine.id], status === 'deleted');
        }
      }
    }
    const engine = new RoutineEngine({
      load: async () => saved,
      save: async (state) => {
        assertScope(scope);
        if (epoch !== generation) throw new Error('Routine service was reset');
        await store.save(state);
        assertScope(scope);
      },
      execute: (routine, run, signal, canDispatch) => {
        if (epoch !== generation) throw new Error('Routine service was reset');
        return execute(scope, routine, run, signal, canDispatch);
      },
      id: randomUUID,
      now: Date.now,
      changed: () => {
        if (scope !== activeOwnerScopeKey() || isAppSessionBoundaryPending()) return;
        tapWindowBroadcast(
          REMOTE_RESOURCE_CHANGED_CHANNEL,
          { collectionId: 'routines' },
          getSafeDataOwnerPushStamp(),
        );
        broadcastLocal('routines:changed');
      },
      onError: (error) => log.warn('routine operation failed', { error: String(error) }),
    });
    try {
      await engine.start(botStates);
      assertScope(scope);
      if (epoch !== generation) throw new Error('Routine service was reset');
    } catch (error) {
      await engine.stop();
      throw error;
    }
    const timer = setInterval(() => {
      if (scope !== activeOwnerScopeKey() || isAppSessionBoundaryPending()) {
        clearInterval(timer);
        void stopRoutines().catch((error) => log.warn('routine stop failed', { error: String(error) }));
        return;
      }
      void engine
        .tick()
        .catch((error) => log.warn('routine tick failed', { error: String(error) }));
    }, 1000);
    timer.unref();
    current = { scope, engine, timer };
    notifyEngineLifecycle((listener) => listener.started(engine, scope));
    void hostDeps?.recoverImports?.().catch(error => log.warn('Imported automation recovery remains pending', { code: error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message : 'IMPORT_RECOVERY_FAILED' }));
    return engine;
  })();
  try {
    return await starting;
  } finally {
    starting = undefined;
    startingScope = undefined;
    if (startupAbort === controller) startupAbort = undefined;
  }
}

async function stopRoutines(): Promise<void> {
  if (stopping) return stopping;
  generation += 1;
  startupAbort?.abort();
  const stop = (async () => {
    if (starting) {
      try {
        await starting;
      } catch {
        /* Startup is invalidated by this reset. */
      }
    }
    if (current) {
      const previous = current.engine;
      clearInterval(current.timer);
      await current.engine.stop();
      current = undefined;
      notifyEngineLifecycle((listener) => listener.stopped(previous));
    }
  })();
  // Both explicit teardown and the account timer must block replacement startup.
  stopping = stop;
  try {
    await stop;
  } finally {
    if (stopping === stop) stopping = undefined;
  }
}

async function cleanBackingSchedules(scope: string, ids: string[], remove: boolean): Promise<void> {
  if (!ids.length) return;
  assertScope(scope);
  const scheduler = getRoutineHost().getScheduler();
  if (!scheduler) throw new Error('Routine scheduler is not ready; retry later');
  const storage = getRoutineHost().getScheduleStorage();
  for (const id of ids) {
    const scheduleId = `routine-${id}`;
    const schedule = await storage.get(scheduleId);
    assertScope(scope);
    if (!schedule) continue;
    if (remove) await scheduler.delete(scheduleId, { internalRoutine: true });
    else await scheduler.pause(scheduleId, { internalRoutine: true });
    assertScope(scope);
  }
}

/** Invoked inside the Bot lifecycle lock, including before permanent profile deletion. */
async function updateBotRoutineLifecycle(botId: string, action: 'pause' | 'resume' | 'delete'): Promise<void> {
  const scope = activeOwnerScopeKey();
  assertScope(scope);
  const engine = await getRoutineEngine();
  assertScope(scope);
  const ids = engine.list(botId).map((routine) => routine.id);
  if (action === 'resume') {
    await engine.setBotPaused(botId, false);
    notifyEngineLifecycle((listener) => listener.botResumed?.(botId));
  } else {
    await engine.setBotPaused(botId, true);
    assertScope(scope);
    await cleanBackingSchedules(scope, ids, action === 'delete');
    if (action === 'delete') await engine.removeBot(botId);
  }
  assertScope(scope);
}

/** Local UI CRUD uses fixed IPC methods; publishers cannot reach these via the event protocol. */
function registerRoutinesIpc(): void {
  const methods = {
    list: routineTools.list,
    save: routineTools.save,
    remove: routineTools.remove,
    'run-now': routineTools.runNow,
    history: routineTools.history,
  };
  for (const [method, handler] of Object.entries(methods)) {
    ipcMain.handle(`routines:${method}`, async (event, botId: unknown, ...args: unknown[]) => {
      assertTrustedAppRendererEvent(event);
      if (typeof botId !== 'string' || !botId || botId.length > 128)
        throwIpcError('INVALID_PARAMS', 'Invalid teammate');
      try {
        return await (handler as (botId: string, ...args: unknown[]) => Promise<unknown>)(
          botId,
          ...args,
        );
      } catch {
        throwIpcError(
          'INVALID_PARAMS',
          'Routine operation failed; check the teammate and trigger settings',
        );
      }
    });
  }
  ipcMain.handle('routines:sources', async (event) => {
    assertTrustedAppRendererEvent(event);
    try {
      return (await getRoutineEngine()).listSources();
    } catch {
      throwIpcError('INTERNAL', 'Routine sources are unavailable');
    }
  });
}

async function withBot<T>(
  botId: string,
  operation: (engine: RoutineEngine, scope: string) => T | Promise<T>,
): Promise<T> {
  if (typeof botId !== 'string' || !botId || botId.length > 128)
    throw new Error('Invalid teammate');
  const scope = activeOwnerScopeKey();
  assertScope(scope);
  await getRoutineHost().getBot(botId);
  assertScope(scope);
  const engine = await getRoutineEngine();
  assertScope(scope);
  const result = await operation(engine, scope);
  assertScope(scope);
  return result;
}

/** Single management boundary used by desktop, remote resources and all MCP harnesses. */
/** routine_save、伙伴设置与远程资源共用的保存边界:与调度器保存同一套前置检查语法预检。 */
async function assertRoutineHookSyntax(input: RoutineInput): Promise<void> {
  if (input.preRunHook?.command?.trim()) await assertPreRunHookCommandSyntax(input.preRunHook.command);
}

const routineTools = {
  list: (botId: string) => withBot(botId, (engine) => engine.list(botId)),
  createOnce: (botId: string, input: RoutineInput, creationId: string) =>
    withBot(botId, async (engine, scope) => {
      await assertRoutineHookSyntax(input);
      if (input.enabled) await getRoutineHost().assertImportedAutomationReady?.(ownerScopedUserDataPath(), botId, creationId, () => assertScope(scope), { input });
      assertScope(scope);
      return engine.createOnce(botId, input, creationId);
    }),
  save: (botId: string, input: RoutineInput, id?: string, expectedRevision?: number) =>
    withBot(botId, async (engine, scope) => {
      await assertRoutineHookSyntax(input);
      if (id && input.enabled) {
        const recoveredRevision = await getRoutineHost().assertImportedAutomationReady?.(ownerScopedUserDataPath(), botId, id, () => assertScope(scope), { input, expectedRevision });
        if (recoveredRevision !== undefined) expectedRevision = recoveredRevision;
      }
      assertScope(scope);
      return engine.put(botId, input, id, expectedRevision);
    }),
  remove: (botId: string, id: string, expectedRevision?: number) =>
    withBot(botId, async (engine, scope) => {
      await engine.remove(botId, id, () => cleanBackingSchedules(scope, [id], true), expectedRevision);
    }),
  runNow: (botId: string, id: string, expectedRevision?: number) => withBot(botId, async (engine, scope) => {
    const recoveredRevision = await getRoutineHost().assertImportedAutomationReady?.(ownerScopedUserDataPath(), botId, id, () => assertScope(scope), { expectedRevision });
    if (recoveredRevision !== undefined) expectedRevision = recoveredRevision;
    assertScope(scope);
    return engine.runNow(botId, id, expectedRevision);
  }),
  history: (botId: string, id: string) =>
    withBot(botId, (engine) => {
      if (!engine.list(botId).some((routine) => routine.id === id))
        throw new Error('Routine not found');
      return engine.history(id);
    }),
  sources: async () => (await getRoutineEngine()).listSources(),
  /** 近况里「每天帮我查一次」：内置「每天查待办」是否存在且开着。 */
  todoCheckEnabled: (botId: string) => withBot(botId, (engine) =>
    engine.list(botId).some((routine) => routine.id === builtinTodoCheckRoutineId(botId) && routine.enabled)),
  /**
   * 打开时按模板落地（首次创建，或模板版本变化时重写）并恢复；关掉只暂停，保留同一条。
   * 内置规则只能经 ensureBuiltin 写内容，这里的 put 只切换 enabled。
   */
  setTodoCheck: (botId: string, enabled: boolean) => withBot(botId, async (engine, scope) => {
    const id = builtinTodoCheckRoutineId(botId);
    let routine = engine.list(botId).find((row) => row.id === id) ?? null;
    if (enabled) {
      const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
      routine = await engine.ensureBuiltin(botId, 'todo-check', buildTodoCheckRoutineInput(timezone), id, TODO_CHECK_PROMPT_VERSION);
      assertScope(scope);
      if (!routine) throw new Error('The teammate is paused');
    }
    if (!routine || routine.enabled === enabled) return enabled && !!routine;
    const { name, prompt, triggers, silentWhenIdle, preRunHook } = routine;
    const saved = await engine.put(botId, { name, prompt, triggers, silentWhenIdle, preRunHook, enabled }, id, routine.revision);
    return saved.enabled;
  }),
};

/** A stopped/crashed plugin must not continue to appear as a listening source. */
function disconnectRoutineSource(pluginId: string): void {
  if (current?.scope === activeOwnerScopeKey() && !isAppSessionBoundaryPending()) {
    current.engine.removeSource(`plugin:${pluginId}`);
  }
}

/** Follow an archived plugin so the replacement does not inherit its event routines. */
async function relocateRoutinePluginSource(fromPart: string, toPart: string): Promise<void> {
  if (fromPart === toPart) return;
  const scope = activeOwnerScopeKey();
  if (current?.scope === scope && !isAppSessionBoundaryPending()) {
    await current.engine.relocatePluginSource(fromPart, toPart);
    return;
  }
  const store = createStore(ownerScopedUserDataPath());
  const state = await store.load();
  if (!state) return;
  const next = rewriteRoutinePluginSource(state, fromPart, toPart);
  if (next !== state) await store.save(next);
}


const { listCompanionRoutines, importCompanionRoutines } = createCompanionRoutineTransfer(routineTools);

return {onRoutineEngineLifecycle,configureRoutineHost,getRoutineEngine,stopRoutines,updateBotRoutineLifecycle,registerRoutinesIpc,routineTools,disconnectRoutineSource,relocateRoutinePluginSource,listCompanionRoutines,importCompanionRoutines};
}
