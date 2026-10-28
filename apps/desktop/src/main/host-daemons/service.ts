/**
 * host-daemons/service —— 本机常驻清单的编排层（依赖全部注入，可直接单测）。
 *
 * 一次 list 的成本：1 次计划任务扫描（~0.7s 冷启）+ 每个「还没归属过」的任务 1 次
 * 时间窗查询（索引命中，本机实测 16ms）。归属一旦落台账就不再查询，稳态为 0 次。
 */

import type {
  HostDaemonEntry,
  HostDaemonState,
  HostDaemonTrigger,
  HostDaemonsSnapshot,
} from '../../shared/hostDaemons.js';
import {
  ATTRIBUTION_WINDOW_MS,
  pickOwnerSession,
  type ToolMessageRow,
} from './attribution.js';
import type { HostDaemonLedger } from './ledger.js';
import {
  isSystemScheduledTaskId,
  type RawScheduledTask,
} from './scheduledTasks.js';

/** 一次扫描里最多追溯多少个未归属任务（防止异常环境下反复拖慢面板）。 */
const MAX_TRACES_PER_SCAN = 40;

export type HostDaemonActionErrorCode = 'NOT_FOUND' | 'NOT_OWNED' | 'UNSUPPORTED';

export class HostDaemonActionError extends Error {
  readonly code: HostDaemonActionErrorCode;

  constructor(code: HostDaemonActionErrorCode, message: string) {
    super(message);
    this.name = 'HostDaemonActionError';
    this.code = code;
  }
}

export interface HostDaemonsServiceDeps {
  scanTasks: () => Promise<RawScheduledTask[]>;
  /** 读取 [fromMs, toMs] 内的工具调用消息（含会话标题）。 */
  readToolMessages: (fromMs: number, toMs: number) => Promise<ToolMessageRow[]>;
  ledger: HostDaemonLedger;
  stopTask: (id: string) => Promise<void>;
  deleteTask: (id: string) => Promise<void>;
  now?: () => number;
  platform?: NodeJS.Platform;
}

function toState(raw: string): HostDaemonState {
  const value = raw.toLowerCase();
  if (value === 'running') return 'running';
  if (value === 'ready') return 'ready';
  if (value === 'disabled') return 'disabled';
  return 'unknown';
}

function toTrigger(raw: string): HostDaemonTrigger {
  if (/logon/i.test(raw)) return 'logon';
  if (/boot/i.test(raw)) return 'startup';
  if (/time|daily|weekly|monthly|calendar|sessionstate|registration/i.test(raw)) {
    return 'schedule';
  }
  return 'other';
}

function toCommand(task: RawScheduledTask): string {
  const args = task.args.trim();
  return args ? `${task.exec} ${args}` : task.exec;
}

function toEntry(
  task: RawScheduledTask,
  owner: { sessionId: string; title: string | null },
): HostDaemonEntry {
  return {
    id: task.id,
    name: task.name,
    kind: 'scheduled-task',
    state: toState(task.state),
    command: toCommand(task),
    trigger: toTrigger(task.triggers),
    ownerTitle: owner.title,
    ownerSessionId: owner.sessionId,
    lastRunAtMs: task.lastRunAtMs,
  };
}

export interface HostDaemonsService {
  list(): Promise<HostDaemonsSnapshot>;
  stop(id: string): Promise<void>;
  remove(id: string): Promise<void>;
}

export function createHostDaemonsService(deps: HostDaemonsServiceDeps): HostDaemonsService {
  const now = deps.now ?? Date.now;
  const platform = deps.platform ?? process.platform;

  async function traceOwner(
    task: RawScheduledTask,
  ): Promise<{ sessionId: string; title: string | null } | null> {
    if (!task.definitionMtimeMs) return null;
    const fromMs = task.definitionMtimeMs - ATTRIBUTION_WINDOW_MS;
    const toMs = task.definitionMtimeMs + ATTRIBUTION_WINDOW_MS;
    const rows = await deps.readToolMessages(fromMs, toMs);
    const picked = pickOwnerSession(rows, [task.name]);
    return picked ? { sessionId: picked.sessionId, title: picked.title } : null;
  }

  /** 操作前重新扫描并复核归属：renderer 只提供候选 id，授权依据在 main 重算。 */
  async function requireOwnedTask(id: string): Promise<RawScheduledTask> {
    if (platform !== 'win32') {
      throw new HostDaemonActionError('UNSUPPORTED', 'host daemons are Windows only');
    }
    if (!id.startsWith('\\') || isSystemScheduledTaskId(id)) {
      throw new HostDaemonActionError('NOT_FOUND', 'host daemon is not operable');
    }
    const tasks = await deps.scanTasks();
    const task = tasks.find((candidate) => candidate.id === id);
    if (!task) throw new HostDaemonActionError('NOT_FOUND', 'scheduled task no longer exists');
    // 只有本功能登记过的条目才允许停止/删除 —— 绝不变成任意计划任务管理器。
    if (!deps.ledger.getOwner(id)) {
      throw new HostDaemonActionError('NOT_OWNED', 'scheduled task was not created by Cindy');
    }
    return task;
  }

  return {
    async list() {
      const capturedAtMs = now();
      if (platform !== 'win32') {
        return { capturedAtMs, supported: false, entries: [], unrelatedCount: 0 };
      }

      const tasks = await deps.scanTasks();
      const entries: HostDaemonEntry[] = [];
      let unrelatedCount = 0;
      let traces = 0;
      let dirty = false;

      for (const task of tasks) {
        let owner = deps.ledger.getOwner(task.id);

        if (!owner) {
          const mtime = task.definitionMtimeMs;
          const alreadyMissed = mtime !== null && deps.ledger.getMissMtime(task.id) === mtime;
          if (mtime === null || alreadyMissed || traces >= MAX_TRACES_PER_SCAN) {
            unrelatedCount += 1;
            continue;
          }
          traces += 1;
          let traced: { sessionId: string; title: string | null } | null = null;
          try {
            traced = await traceOwner(task);
          } catch {
            // 追溯失败（库忙 / 正在切账号）只影响本条归属，不让整张清单失败。
            traced = null;
          }
          if (traced) {
            deps.ledger.setOwner(task.id, { ...traced, atMs: capturedAtMs });
            dirty = true;
            owner = deps.ledger.getOwner(task.id);
          } else {
            deps.ledger.setMissMtime(task.id, mtime);
            dirty = true;
            unrelatedCount += 1;
            continue;
          }
        }

        if (!owner) {
          unrelatedCount += 1;
          continue;
        }
        entries.push(toEntry(task, owner));
      }

      if (dirty) {
        try {
          deps.ledger.save();
        } catch {
          // 台账写失败只影响下次是否重算，不影响本次清单。
        }
      }

      entries.sort((left, right) => left.name.localeCompare(right.name));
      return { capturedAtMs, supported: true, entries, unrelatedCount };
    },

    async stop(id) {
      await requireOwnedTask(id);
      await deps.stopTask(id);
    },

    async remove(id) {
      await requireOwnedTask(id);
      await deps.deleteTask(id);
    },
  };
}
