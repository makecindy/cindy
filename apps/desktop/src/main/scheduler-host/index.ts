/**
 * Phase 3: scheduler-host 单例 + 启停。
 *
 * 启动时机（bootstrap-electron.ts:557 registerMakerIpcsAfterSplash 内）：
 *   splash → 两个 binary provision → maker 构造 → 全部 maker:* IPC 注册 → startScheduler
 * 此时 (a) getMaker() 可调 (b) DbClient 不抛（用户登录在前，localDb ensureReady 已完成）
 *      (c) mainWindow 已 createWindow。
 *
 * 切账号 / 登出时的 scheduler 重启留给 Phase 4+：本文件导出 resetScheduler() 占位，
 * Phase 3 不在 bootstrap-electron 里联动 resetMaker。
 */

import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { app } from 'electron';
import type { BrowserWindow } from 'electron';

import { Scheduler } from '@cindy/maker-scheduler';
import type { Logger, ScheduleRunner } from '@cindy/maker-scheduler';
import type { Maker } from '@cindy/maker-core';
import type { FeishuIM } from '@cindy/im';

import { dialogueWorkspaceRootDir } from '../localDb/dialogueWorkspace';
import { getAgentIslandService } from '../agent-island/service.js';
import { getDesktopNotificationsEnabled } from '../notificationService.js';
import {
  applyPendingAgentSwitchForDirectSend,
  broadcastSessionCreated,
  enqueueSchedulerPrompt,
  hasQueuedSchedulerPrompt,
  isSchedulerPromptTracked,
  isSchedulerTargetSessionBusy,
  removeQueuedSchedulerPrompt,
} from '../maker-ipc/register.js';
import { DrizzleScheduleStorage, type SchedulerDrizzleDb } from './storage';
import { ProjectAutomationLoader } from './project-automation-loader';
import { MakerScheduleRunner } from './runner';
import { ScriptScheduleRunner } from './script-runner';
import { SchedulerScriptCapabilityBroker } from './script-capability-broker';
import { DesktopNotifier } from './notifier';
import { withScheduleLock } from './scheduleLock';

export interface StartSchedulerDeps {
  maker: Maker;
  getDb: () => SchedulerDrizzleDb;
  getMainWindow: () => BrowserWindow | null;
  feishuIm: FeishuIM;
  logger: Logger;
  beforeDispatchUserTurn?: (sessionId: string) => void | Promise<void>;
  onUndispatchedUserTurn?: (sessionId: string) => void;
}

let _scheduler: Scheduler | null = null;
let _storage: DrizzleScheduleStorage | null = null;
let _loader: ProjectAutomationLoader | null = null;

export async function startScheduler(deps: StartSchedulerDeps): Promise<Scheduler> {
  if (_scheduler) return _scheduler;

  const storage = new DrizzleScheduleStorage(deps.getDb);
  _storage = storage;
  const notifier = new DesktopNotifier({
    getMainWindow: deps.getMainWindow,
    feishuIm: deps.feishuIm,
    logger: deps.logger,
    shouldNotifyDesktop: () =>
      getDesktopNotificationsEnabled() && !(getAgentIslandService()?.isEnabled() ?? false),
  });
  const promptRunner = new MakerScheduleRunner({
    maker: deps.maker,
    getDb: deps.getDb,
    notifier,
    logger: deps.logger,
    beforeDispatchUserTurn: deps.beforeDispatchUserTurn,
    onUndispatchedUserTurn: deps.onUndispatchedUserTurn,
    applyPendingAgentSwitch: applyPendingAgentSwitchForDirectSend,
    onSessionCreated: broadcastSessionCreated,
    // 心跳撞忙排队桥:实现挂在 maker-ipc/register.ts 的 coordinator 装配处
    // (holder 未就绪时 isSessionBusy 返回 false → runner 走原直发路径)。
    schedulerQueue: {
      isSessionBusy: isSchedulerTargetSessionBusy,
      hasQueuedPrompt: hasQueuedSchedulerPrompt,
      enqueuePrompt: enqueueSchedulerPrompt,
      removeQueuedPrompt: removeQueuedSchedulerPrompt,
      isPromptTracked: isSchedulerPromptTracked,
    },
  });
  const scriptRunner = new ScriptScheduleRunner({
    broker: new SchedulerScriptCapabilityBroker(),
    logger: deps.logger,
    notifier,
    getDb: deps.getDb,
  });
  const runner: ScheduleRunner = {
    fire: (schedule, ctx) =>
      withScheduleLock(schedule.id, ctx.signal, () =>
        schedule.executionMode === 'script'
          ? scriptRunner.fire(schedule, ctx)
          : promptRunner.fire(schedule, ctx),
      ),
  };

  // 双开让位开关:同一台机器同时跑 dev + release(共用同一 userData/DB)时,
  // 给其中一个实例(通常 dev)设 XDT_SCHEDULER_PASSIVE=1 → 本实例不参与自动触发
  // (不 tick、不把另一实例 in-flight 的 run 误标 interrupted),定时任务全交对方跑;
  // 本实例的任务管理 UI / MCP / 手动"立即运行"不受影响。正常单开不要设。
  // 仅 dev 生效:packaged 版本无条件忽略(与 devCliFlags 的 --passive 同一语义)——
  // 否则用户 shell 里残留的全局 env 会让正式版静默停摆所有定时任务。
  // 不设时 claimDueFire 的 DB 级 CAS 兜底去重,但有已知窄窗口:一实例 start() 归一
  // 无法区分"崩溃残留的空 nextFireAt"和"另一实例 in-flight 的认领",长 run 期间对方
  // 重启可能并发跑一次(根治需 claim 租约字段,follow-up)——双开期间优先用本开关。
  const passive = !app.isPackaged && process.env.XDT_SCHEDULER_PASSIVE === '1';

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
    isManagedWorkspaceDir: (dir) => {
      const rel = path.relative(dialogueWorkspaceRootDir(), dir);
      return !rel.startsWith('..') && !path.isAbsolute(rel);
    },
  });
  const loader = new ProjectAutomationLoader({
    scheduler,
    storage,
    getDb: deps.getDb,
    logger: deps.logger,
  });
  // archived 兜底要 scheduler.pause/update，runner 反向持有 scheduler
  promptRunner.attachScheduler(scheduler);
  scriptRunner.attachScheduler(scheduler);

  await scheduler.start();
  try {
    const orphans = await storage.deleteOrphanRuns();
    if (orphans > 0) deps.logger.info?.(`[scheduler-host] cleaned ${orphans} orphan run(s)`);
  } catch (err) {
    deps.logger.warn?.(`[scheduler-host] deleteOrphanRuns failed (non-fatal): ${String(err)}`);
  }
  _scheduler = scheduler;
  _loader = loader;
  deps.logger.info?.(`[scheduler-host] started${passive ? ' (passive: auto-fire disabled)' : ''}`);
  void loader.reconcileAll().catch((err) => {
    deps.logger.warn?.(
      `[project-automation] reconcileAll failed (non-fatal): ${String(err)}`,
    );
  });
  return scheduler;
}

export function getScheduler(): Scheduler {
  if (!_scheduler) {
    throw new Error('scheduler not started: call startScheduler() first');
  }
  return _scheduler;
}

export function getScheduleStorage(): DrizzleScheduleStorage {
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
export function getScheduleStorageIfInitialized(): DrizzleScheduleStorage | null {
  return _storage;
}

export function getProjectAutomationLoader(): ProjectAutomationLoader {
  if (!_loader) {
    throw new Error('project automation loader not started: call startScheduler() first');
  }
  return _loader;
}

/**
 * Phase 4+ 切账号时调；Phase 3 不接入 bootstrap 流程。
 * 当前 resetMaker（maker-host:131）也不会调本函数。
 */
export async function resetScheduler(): Promise<void> {
  if (_scheduler) {
    await _scheduler.stop();
  }
  _scheduler = null;
  _storage = null;
  _loader = null;
}
