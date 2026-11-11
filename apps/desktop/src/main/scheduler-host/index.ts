/** Shared scheduler startup, target validation, locking and account-bound teardown. */
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { Scheduler, type Logger, type FireContext, type PreRunPluginConfig, type Schedule, type ScheduleRunner, type Notifier } from '@cindy/maker-scheduler';
import type { Maker } from '@cindy/maker-core';
import type { GhostControlPointResult, GhostScheduleRunPointData } from '../../shared/ghost.js';
import type { DiagnosePreRunHookFailure } from './pre-run-hook-diagnosis';
import { sessions } from '../localDb/schema.js';
import { isReviewSessionSource } from '../../shared/sessionSource.js';
import { dbToMakerAgentKind } from '../../shared/agentKindConversion.js';
import { assertScheduledHarnessSupported } from '../maker-ipc/scheduledModelSelection';
import type { DrizzleScheduleStorage, SchedulerDrizzleDb } from './storage';
import { ProjectAutomationLoader } from './project-automation-loader';
import type { MakerScheduleRunner, SchedulerQueueDeps } from './runner';
import type { ScriptScheduleRunner } from './script-runner';
import { setSilencedRunProbe } from './silent-output';
import { buildForcedFailureRun } from './forcedFailureRun';
import { screenScheduleRun } from '../cindy-brain/scheduleControlPointGate.js';
import { withScheduleLock } from './scheduleLock';
import { runSchedulerStartup } from './scheduler-startup-lifecycle';

export interface SchedulerHostStartDeps {
  maker: Maker;
  getDb: () => SchedulerDrizzleDb;
  logger: Logger;
  beforeDispatchUserTurn?: (sessionId: string, signal?: AbortSignal) => void | Promise<void>;
  onUndispatchedUserTurn?: (sessionId: string) => void;
  /** 插件控制节点 will-schedule-run：任务选了插件前置检查时，每次执行前(不含恢复中断的续跑)询问它。 */
  screenControlPoint?: (
    point: 'will-schedule-run',
    data: GhostScheduleRunPointData,
    target: PreRunPluginConfig,
  ) => Promise<GhostControlPointResult>;
  /** 保存插件前置检查时把插件解析为实例 id;插件不可选时抛错。 */
  resolvePreRunPlugin?: (pluginId: string) => string;
  /** 检查脚本失败时识别「所属插件未安装或未启用」，让失败提示能指向安装。 */
  diagnosePreRunHookFailure?: DiagnosePreRunHookFailure;
}

export interface SchedulerHostRuntime<Deps extends SchedulerHostStartDeps> {
  createStorage(getDb: () => SchedulerDrizzleDb): DrizzleScheduleStorage;
  createRunners(deps: Deps, storage: DrizzleScheduleStorage): {
    notifier: Notifier;
    promptRunner: MakerScheduleRunner;
    scriptRunner: ScriptScheduleRunner;
  };
  isPassive(): boolean;
  dialogueWorkspaceRoots(): string[];
  onStarted(scheduler: Scheduler, deps: Deps, passive: boolean): void;
  /** Wraps the runner, e.g. to skip a teammate project's automations on a computer it was handed away from. */
  wrapRunner?(runner: ScheduleRunner): ScheduleRunner;
  /** A real teammate project of this account: its automation files sync without the import prompt. */
  isOwnTeammateProject?(workingDir: string): Promise<boolean>;
  beforeReset(): Promise<void>;
}

export function createSchedulerHost<Deps extends SchedulerHostStartDeps>(runtime: SchedulerHostRuntime<Deps>) {
  let _scheduler: Scheduler | null = null;
  let _promptRunner: MakerScheduleRunner | null = null;
  let _storage: DrizzleScheduleStorage | null = null;
  let _loader: ProjectAutomationLoader | null = null;
  // Reset increments this before awaiting stop(). A start that was already
  // blocked in scheduler.start() must not publish its stale instance after the
  // account boundary has moved on.
  let _startupGeneration = 0;
  // resetScheduler must wait for the old account's complete startup operation,
  // not only fence its eventual publication.
  let _startupPromise: Promise<Scheduler> | null = null;

  function startScheduler(deps: Deps): Promise<Scheduler> {
    if (_scheduler) return Promise.resolve(_scheduler);
    if (_startupPromise) return _startupPromise;
    const startup = startSchedulerInternal(deps);
    _startupPromise = startup;
    void startup.finally(() => {
      if (_startupPromise === startup) _startupPromise = null;
    }).catch(() => {});
    return startup;
  }

  async function startSchedulerInternal(deps: Deps): Promise<Scheduler> {
    const startupGeneration = _startupGeneration;

    const storage = runtime.createStorage(deps.getDb);
    _storage = storage;
    const { notifier, promptRunner, scriptRunner } = runtime.createRunners(deps, storage);
    // 与检查脚本拦下时同一条失败通知：先认领，避免卡死守卫再投第二条。
    const notifyPluginStop = async (schedule: Schedule, ctx: FireContext, errorMsg: string) => {
      if (_scheduler?.isRunAbandoned(ctx.runId)) return;
      ctx.onRunnerNotified?.('failure');
      await notifier.notify(schedule, {
        id: ctx.runId, scheduleId: schedule.id, firedAt: ctx.firedAt, finishedAt: Date.now(), status: 'failed', errorMsg,
      }).catch(() => {});
    };
    const baseRunner: ScheduleRunner = {
      fire: (schedule, ctx) =>
        withScheduleLock(schedule.id, ctx.signal, async () => {
          // 所有定时任务(Agent / 脚本)的唯一入口：插件前置检查放在检查脚本、建任务之前。
          const stopped = deps.screenControlPoint
            ? await screenScheduleRun(deps.screenControlPoint, schedule, ctx, (errorMsg) => notifyPluginStop(schedule, ctx, errorMsg))
            : null;
          if (stopped) return stopped;
          return schedule.executionMode === 'script'
            ? scriptRunner.fire(schedule, ctx)
            : promptRunner.fire(schedule, ctx);
        }),
    };
    const runner = runtime.wrapRunner ? runtime.wrapRunner(baseRunner) : baseRunner;

    // 双开让位开关:同一台机器同时跑 dev + release(共用同一 userData/DB)时,
    // 给其中一个实例(通常 dev)设 XDT_SCHEDULER_PASSIVE=1 → 本实例不参与自动触发
    // (不 tick、不把另一实例 in-flight 的 run 误标 interrupted),定时任务全交对方跑;
    // 本实例的任务管理 UI / MCP / 手动"立即运行"不受影响。正常单开不要设。
    // 仅 dev 生效:packaged 版本无条件忽略(与 devCliFlags 的 --passive 同一语义)——
    // 否则用户 shell 里残留的全局 env 会让正式版静默停摆所有定时任务。
    // 不设时 claimDueFire 的 DB 级 CAS 兜底去重,但有已知窄窗口:一实例 start() 归一
    // 无法区分"崩溃残留的空 nextFireAt"和"另一实例 in-flight 的认领",长 run 期间对方
    // 重启可能并发跑一次(根治需 claim 租约字段,follow-up)——双开期间优先用本开关。
    const passive = runtime.isPassive();

    const scheduler = new Scheduler({
      storage,
      runner,
      logger: deps.logger,
      passive,
      instanceId: `${process.pid}:${randomUUID()}`,
      processId: process.pid,
      // 对话工作区根目录(userData/dialogues)下的路径都是 app 内部分配的会话 cwd。
      // agent 在对话里建任务时常把自己的 cwd 当 workingDir 传入 —— 引擎据此归一成
      // 对话任务,避免任务/会话错误归入项目分组。path.relative 同时兼容两端分隔符。
      resolvePreRunPlugin: deps.resolvePreRunPlugin,
      isManagedWorkspaceDir: (dir) => {
        return runtime.dialogueWorkspaceRoots().some((root) => {
          const rel = path.relative(root, dir);
          return !rel.startsWith('..') && !path.isAbsolute(rel);
        });
      },
      // Review sessions are host-owned read-only tasks, not normal unattended
      // automation targets. Re-read their durable source for CRUD and every fire
      // so renderer filtering or a restored schedule row cannot bypass isolation.
      validateTargetSession: async (targetSessionId, _operation, selection) => {
        const [row] = await deps
          .getDb()
          .select({ source: sessions.source, agentKind: sessions.agentKind,
            status: sessions.status, agentDeviceId: sessions.agentDeviceId,
            remoteHostId: sessions.remoteHostId, orcaRole: sessions.orcaRole })
          .from(sessions)
          .where(eq(sessions.id, targetSessionId))
          .limit(1);
        if (isReviewSessionSource(row?.source)) {
          throw new Error('Review tasks cannot be targets of scheduled automations');
        }
        assertScheduledHarnessSupported(row ? {
          ...row, agentKind: dbToMakerAgentKind(row.agentKind),
        } : null, selection.modelAgentKind, selection.modelAgentDeviceId === undefined
          ? undefined : selection.modelAgentDeviceId || null);
      },
      // 卡死收口的通知出口。通知投递平时住在两个 runner 里(它们各自持 notifier),而
      // 卡死收口刻意绕过 runner —— 要么它压根不返回、要么它把守卫 abort 当普通中断处理。
      // 没有这条线,用户配了桌面/飞书通知也只会看到一个未读红点(PR #944 review P1)。
      // notify() 自身保证不 throw;这里再读回真实 run 行,让通知内容与历史一致。
      notifyForcedFailure: async ({ scheduleId, runId, errorMsg }) => {
        const schedule = await storage.get(scheduleId);
        if (!schedule) return;
        const run = (await storage.listRuns(scheduleId, 20)).find((r) => r.id === runId);
        // 读回的行**不一定是终态**(落库失败时它还停在 'running'),判据与理由见
        // buildForcedFailureRun。
        await notifier.notify(
          schedule,
          buildForcedFailureRun({ scheduleId, runId, errorMsg, run, now: Date.now() }),
        );
      },
    });
    const loader = new ProjectAutomationLoader({
      scheduler,
      storage,
      getDb: deps.getDb,
      logger: deps.logger,
      ...(runtime.isOwnTeammateProject ? { isOwnTeammateProject: runtime.isOwnTeammateProject } : {}),
    });
    // archived 兜底要 scheduler.pause/update，runner 反向持有 scheduler
    promptRunner.attachScheduler(scheduler);
    scriptRunner.attachScheduler(scheduler);

    await runSchedulerStartup(startupGeneration, () => _startupGeneration, {
      create: () => scheduler,
      afterStart: async () => {
        try {
          const orphans = await storage.deleteOrphanRuns();
          if (orphans > 0) deps.logger.info?.(`[scheduler-host] cleaned ${orphans} orphan run(s)`);
        } catch (err) {
          deps.logger.warn?.(`[scheduler-host] deleteOrphanRuns failed (non-fatal): ${String(err)}`);
        }
      },
    });
    _scheduler = scheduler;
    _promptRunner = promptRunner;
    setSilencedRunProbe((runId) => scheduler.isRunSilenced(runId));
    _loader = loader;
    runtime.onStarted(scheduler, deps, passive);
    deps.logger.info?.(`[scheduler-host] started${passive ? ' (passive: auto-fire disabled)' : ''}`);
    void loader.reconcileAll().catch((err) => {
      deps.logger.warn?.(
        `[project-automation] reconcileAll failed (non-fatal): ${String(err)}`,
      );
    });
    return scheduler;
  }

  /** Called only by the host's validated, explicit Continue input path. */
  async function resumeInterruptedScheduleRun(
    sessionId: string,
    enqueuePrompt: SchedulerQueueDeps['enqueuePrompt'],
  ) {
    const runner = _promptRunner;
    if (!_scheduler || !runner) return null;
    return _scheduler.resumeInterruptedRun(sessionId, {
      fire: (schedule, ctx) => runner.fireManualContinuation(schedule, ctx, enqueuePrompt),
    });
  }

  /** Cold-start probe for callers that own a durable deferred queue. */
  function getSchedulerIfInitialized(): Scheduler | null {
    return _scheduler;
  }

  function getScheduler(): Scheduler {
    if (!_scheduler) {
      throw new Error('scheduler not started: call startScheduler() first');
    }
    return _scheduler;
  }

  function getScheduleStorage(): DrizzleScheduleStorage {
    if (!_storage) {
      throw new Error('schedule storage not started: call startScheduler() first');
    }
    return _storage;
  }

  /**
   * Non-throwing lifecycle probe for callers that run before localDb/scheduler startup.
   * Once storage exists, callers must still let query errors propagate so real DB
   * failures are not confused with the expected cold-start state.
   */
  function getScheduleStorageIfInitialized(): DrizzleScheduleStorage | null {
    return _storage;
  }

  function getProjectAutomationLoader(): ProjectAutomationLoader {
    if (!_loader) {
      throw new Error('project automation loader not started: call startScheduler() first');
    }
    return _loader;
  }

  /**
   * Phase 4+ 切账号时调；Phase 3 不接入 bootstrap 流程。
   * 当前 resetMaker（maker-host:131）也不会调本函数。
   */
  async function resetScheduler(): Promise<void> {
    await runtime.beforeReset();
    _startupGeneration++;
    const pendingStartup = _startupPromise;
    if (pendingStartup) {
      try {
        await pendingStartup;
      } catch {
        // Superseded startup rejects after stopping itself; teardown continues.
      }
    }
    setSilencedRunProbe(null);
    if (_scheduler) {
      await _scheduler.stop();
    }
    _scheduler = null;
    _promptRunner = null;
    _storage = null;
    _loader = null;
  }
  return { startScheduler, resumeInterruptedScheduleRun, getSchedulerIfInitialized, getScheduler, getScheduleStorage, getScheduleStorageIfInitialized, getProjectAutomationLoader, resetScheduler };
}
