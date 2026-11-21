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
import { ATTRIBUTION_WINDOW_MS, pickOwnerSession } from './attribution.js';
import type { ToolMessageWindow } from './toolHistory.js';
import type { HostDaemonLedger, HostDaemonOwnerRecord } from './ledger.js';
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
  /**
   * 读取 [fromMs, toMs] 内的工具调用消息（含会话标题），并回报是否只读到一部分。
   * 匹配放在这里的 JS 里做（Unicode 大小写折叠）；`truncated` 为真时没命中不能
   * 当作「查无此人」，否则会被写进长期负缓存。
   */
  readToolMessages: (fromMs: number, toMs: number) => Promise<ToolMessageWindow>;
  ledger: HostDaemonLedger;
  stopTask: (id: string) => Promise<void>;
  /** 立即运行一次（停止之后把任务重新拉起来）。 */
  runTask: (id: string) => Promise<void>;
  deleteTask: (id: string) => Promise<void>;
  now?: () => number;
  platform?: NodeJS.Platform;
  /**
   * 当前账号边界标识（切号即变）。默认不启用校验：纯逻辑层不依赖账号态，
   * 由 main 接线时传入 `activeOwnerScopeKey`。
   */
  ownerScopeKey?: () => string;
  /**
   * 账号边界是否正在进行（拆运行时 / 换库）。期间读到的是旧账号的消息、写的是
   * 新账号的台账，任何归属结论都不可信，必须整体作废。
   */
  isOwnerBoundaryPending?: () => boolean;
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
  run(id: string): Promise<void>;
  remove(id: string): Promise<void>;
}

export function createHostDaemonsService(deps: HostDaemonsServiceDeps): HostDaemonsService {
  const now = deps.now ?? Date.now;
  const platform = deps.platform ?? process.platform;

  /** 账号边界是否正在进行。未接线（纯逻辑 / 单测）时永远为 false。 */
  function boundaryPending(): boolean {
    return deps.ownerScopeKey ? (deps.isOwnerBoundaryPending?.() ?? false) : false;
  }

  /**
   * 账号边界快照。null = 未接线（纯逻辑 / 单测不校验账号）。
   *
   * 必须保留真实 key：边界期间 `activeOwnerScopeKey()` 会随 owner 提交而改变，
   * 用一个固定哨兵代替它，等于把「中间换过账号」这件事藏起来 —— 请求开始和结束
   * 都落在边界里、但中间已经切了账号时，相等检查就会误判为没变。
   *
   * 归属记录带会话标题，所以任何跨 await 的读、以及任何台账写入，都必须先取得
   * 这个值，再在之后重新比对；不一致就整体作废，不能只把返回值清空。
   */
  function scopeStamp(): string | null {
    if (!deps.ownerScopeKey) return null;
    return `${deps.ownerScopeKey()}|${boundaryPending() ? 'pending' : 'idle'}`;
  }

  async function traceOwner(
    task: RawScheduledTask,
  ): Promise<{ sessionId: string; title: string | null } | null | undefined> {
    if (!task.definitionMtimeMs) return null;
    // 边界期间数据库可能正被换掉：此刻读到的行属于哪个账号无法确定，直接不读。
    if (boundaryPending()) return undefined;
    const fromMs = task.definitionMtimeMs - ATTRIBUTION_WINDOW_MS;
    const toMs = task.definitionMtimeMs + ATTRIBUTION_WINDOW_MS;
    // 追溯要读消息库（跨 await）：切号期间读到的可能已是另一个账号的库。
    const scopeBefore = scopeStamp();
    const { rows, truncated } = await deps.readToolMessages(fromMs, toMs);
    // 切号后作废在途查询：旧账号的结果不能写进新账号的台账。undefined ≠ null ——
    // null 是「查无此人」（可写负缓存），undefined 是「结果不可信」（不得写任何台账）。
    if (scopeBefore !== scopeStamp()) return undefined;
    const picked = pickOwnerSession(rows, [task.name]);
    if (picked) return { sessionId: picked.sessionId, title: picked.title };
    // 只读到一部分就判「查无此人」，会让这条任务在窗口关闭后被负缓存永久隐藏。
    return truncated ? undefined : null;
  }

  /**
   * 台账记录是否仍然描述「现在这条」任务。
   * 同名同路径的任务被删掉、随后由别的程序重建时，定义写入时刻与启动命令都会变；
   * 只按 id 认权限会让新任务继承旧授权，所以定义变了就撤销。
   */
  function ownerMatchesTask(owner: HostDaemonOwnerRecord | null, task: RawScheduledTask): boolean {
    if (!owner) return false;
    return owner.definitionMtimeMs === task.definitionMtimeMs && owner.command === toCommand(task);
  }

  /** 取当前有效归属；定义已变则顺手撤销，返回 null 让调用方重新判定。 */
  function currentOwner(task: RawScheduledTask): HostDaemonOwnerRecord | null {
    const owner = deps.ledger.getOwner(task.id);
    if (!owner || ownerMatchesTask(owner, task)) return owner;
    deps.ledger.clearOwner(task.id);
    return null;
  }

  /** 操作前重新扫描并复核归属：renderer 只提供候选 id，授权依据在 main 重算。 */
  async function requireOwnedTask(id: string): Promise<RawScheduledTask> {
    if (platform !== 'win32') {
      throw new HostDaemonActionError('UNSUPPORTED', 'host daemons are Windows only');
    }
    if (!id.startsWith('\\') || isSystemScheduledTaskId(id)) {
      throw new HostDaemonActionError('NOT_FOUND', 'host daemon is not operable');
    }
    if (boundaryPending()) {
      throw new HostDaemonActionError('NOT_OWNED', 'account boundary in progress');
    }
    const scopeBefore = scopeStamp();
    const tasks = await deps.scanTasks();
    // 扫描期间切号：这条授权可能来自上一个账号的台账，不能拿来操作本机任务。
    if (scopeBefore !== scopeStamp()) {
      throw new HostDaemonActionError('NOT_OWNED', 'account changed during the rescan');
    }
    const task = tasks.find((candidate) => candidate.id === id);
    if (!task) throw new HostDaemonActionError('NOT_FOUND', 'scheduled task no longer exists');
    // 只有本功能登记过、且定义没变过的条目才允许操作 —— 绝不变成任意计划任务管理器。
    if (!ownerMatchesTask(currentOwner(task), task)) {
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
      // 边界进行中（拆运行时 / 换库）不扫不读：库和台账目录可能分属两个账号。
      if (boundaryPending()) {
        return { capturedAtMs, supported: true, entries: [], unrelatedCount: 0 };
      }
      // 清单里的条目带归属会话标题：账号切换后本次结果作废，不能把旧账号的标题
      // 交给新账号的界面（下次扫描会按新账号重新归属）。
      const scopeBefore = scopeStamp();
      const tasks = await deps.scanTasks();
      const entries: HostDaemonEntry[] = [];
      // 扫描期间的归属结论先攒在这里，整轮结束后一次性提交：只要中途切号（或边界
      // 进行中）就整批丢掉。这样「旧账号的标题写进新账号台账」在结构上不可能发生，
      // 而不是靠每一处写入点各自记得核对。
      const pendingOwners: Array<{ id: string; record: HostDaemonOwnerRecord }> = [];
      const pendingMisses: Array<{ id: string; mtimeMs: number }> = [];
      const pendingClears: string[] = [];
      let unrelatedCount = 0;
      let traces = 0;
      let scopeLost = scopeBefore !== scopeStamp();

      for (const task of tasks) {
        if (scopeBefore !== scopeStamp()) {
          scopeLost = true;
          break;
        }
        const existing = deps.ledger.getOwner(task.id);
        const definitionChanged = existing !== null && !ownerMatchesTask(existing, task);
        if (definitionChanged) pendingClears.push(task.id);
        let owner = definitionChanged ? null : existing;

        if (!owner) {
          const mtime = task.definitionMtimeMs;
          // 时间窗还没过去时必须重算：任务可能是刚由会话创建的，工具调用行可能比
          // 这次扫描晚落库（用户先打开面板、再回到会话），此时记下的 miss 会让它
          // 永远停在「无关」里。窗口过去之后才相信 miss。
          const windowOpen = mtime !== null && capturedAtMs <= mtime + ATTRIBUTION_WINDOW_MS;
          const alreadyMissed =
            mtime !== null && !windowOpen && deps.ledger.getMissMtime(task.id) === mtime;
          if (mtime === null || alreadyMissed || traces >= MAX_TRACES_PER_SCAN) {
            unrelatedCount += 1;
            continue;
          }
          traces += 1;
          let traced: { sessionId: string; title: string | null } | null | undefined = null;
          try {
            traced = await traceOwner(task);
          } catch {
            // 查询失败（库忙 / 正在切账号）≠ 查无此人：不能写负缓存，否则一次失败就
            // 让这条任务永远隐身。本次按「无关」计数，下次扫描重试。
            unrelatedCount += 1;
            continue;
          }
          if (traced === undefined) {
            // 切号作废：既不写 owner 也不写 miss 负缓存，本次按「无关」计数，
            // 下次扫描按新账号重新归属。
            unrelatedCount += 1;
            continue;
          }
          if (traced) {
            const record: HostDaemonOwnerRecord = {
              ...traced,
              atMs: capturedAtMs,
              definitionMtimeMs: task.definitionMtimeMs ?? 0,
              command: toCommand(task),
            };
            pendingOwners.push({ id: task.id, record });
            owner = record;
          } else {
            pendingMisses.push({ id: task.id, mtimeMs: mtime });
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

      if (scopeLost || scopeBefore !== scopeStamp()) {
        // 整轮作废：一条都还没提交，直接丢弃即可。
        return { capturedAtMs, supported: true, entries: [], unrelatedCount };
      }

      for (const id of pendingClears) deps.ledger.clearOwner(id);
      for (const entry of pendingOwners) deps.ledger.setOwner(entry.id, entry.record);
      for (const entry of pendingMisses) deps.ledger.setMissMtime(entry.id, entry.mtimeMs);
      try {
        // save() 自身只在有改动时落盘。
        deps.ledger.save();
      } catch {
        // 台账写失败只影响下次是否重算，不影响本次清单。
      }

      entries.sort((left, right) => left.name.localeCompare(right.name));
      return { capturedAtMs, supported: true, entries, unrelatedCount };
    },

    async stop(id) {
      await requireOwnedTask(id);
      await deps.stopTask(id);
    },

    async run(id) {
      await requireOwnedTask(id);
      await deps.runTask(id);
    },

    async remove(id) {
      await requireOwnedTask(id);
      const scopeBefore = scopeStamp();
      await deps.deleteTask(id);
      // 删除期间切号：新账号的台账不是这次授权的来源，不能顺手动它。
      if (scopeBefore !== scopeStamp()) return;
      // 任务已不在：顺手撤掉授权，避免同名任务重建后继承。
      deps.ledger.clearOwner(id);
      try {
        deps.ledger.save();
      } catch {
        // 写失败只影响下次扫描，不影响这次删除结果。
      }
    },
  };
}
