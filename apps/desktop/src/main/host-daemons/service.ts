/**
 * host-daemons/service —— 本机常驻清单的编排层（依赖全部注入，可直接单测）。
 *
 * 平台差异全在 target 适配器里（Windows 计划任务 / macOS LaunchAgents / Linux 用户级
 * systemd + crontab）；这里只做与平台无关的事：账号边界、归属追溯、台账、动作授权。
 *
 * 一次 list 的成本：1 次本机常驻扫描（Windows 冷启 ~0.7s）+ 每个「还没归属过」的
 * 条目 1 次时间窗查询（索引命中，本机实测 16ms）。归属一旦落台账就不再查询。
 */

import type { HostDaemonEntry, HostDaemonsSnapshot } from '../../shared/hostDaemons.js';
import { ATTRIBUTION_WINDOW_MS, pickOwnerSession } from './attribution.js';
import type { ToolMessageQueryOptions, ToolMessageWindow } from './toolHistory.js';
import type { HostDaemonLedger, HostDaemonOwnerRecord } from './ledger.js';
import type { HostDaemonTarget, RawHostDaemon } from './target.js';

/** 一次扫描里最多追溯多少个未归属条目（防止异常环境下反复拖慢面板）。 */
const MAX_TRACES_PER_SCAN = 40;

/**
 * 没有文件级定义时刻的来源（crontab）用「首次扫描到它的时刻」当锚点，往前找多久。
 * 比计划任务的 5 分钟宽得多：条目可能是几天前建的，面板却是今天才第一次打开。
 */
const FIRST_SEEN_LOOKBACK_MS = 6 * 60 * 60_000;

/** 无锚点回溯时一次取多少行工具消息（超出按最新优先保留）。 */
const FIRST_SEEN_TRACE_LIMIT = 500;

export type HostDaemonActionErrorCode =
  | 'NOT_FOUND'
  | 'NOT_OWNED'
  | 'UNSUPPORTED'
  | 'NOT_STOPPABLE';

export class HostDaemonActionError extends Error {
  readonly code: HostDaemonActionErrorCode;

  constructor(code: HostDaemonActionErrorCode, message: string) {
    super(message);
    this.name = 'HostDaemonActionError';
    this.code = code;
  }
}

/** 匹配用的替换词默认只有名字；适配器可以补充更具体的词。 */
function needlesOf(daemon: RawHostDaemon): readonly string[] {
  return daemon.attributionNeedles ?? [daemon.name];
}

export interface HostDaemonsServiceDeps {
  /**
   * 本平台的常驻项来源。null = 本平台没有可枚举的来源，list 回 `supported: false`。
   */
  target: HostDaemonTarget | null;
  /**
   * 读取 [fromMs, toMs] 内的工具调用消息（含会话标题），并回报是否只读到一部分。
   * 匹配放在这里的 JS 里做（Unicode 大小写折叠）；`truncated` 为真时没命中不能
   * 当作「查无此人」，否则会被写进长期负缓存。
   */
  readToolMessages: (
    fromMs: number,
    toMs: number,
    options?: ToolMessageQueryOptions,
  ) => Promise<ToolMessageWindow>;
  ledger: HostDaemonLedger;
  now?: () => number;
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

export interface HostDaemonsService {
  list(): Promise<HostDaemonsSnapshot>;
  stop(id: string): Promise<void>;
  run(id: string): Promise<void>;
  remove(id: string): Promise<void>;
}

function toEntry(
  daemon: RawHostDaemon,
  owner: { sessionId: string; title: string | null },
): HostDaemonEntry {
  return {
    id: daemon.id,
    name: daemon.name,
    kind: daemon.kind,
    state: daemon.state,
    command: daemon.command,
    trigger: daemon.trigger,
    ownerTitle: owner.title,
    ownerSessionId: owner.sessionId,
    lastRunAtMs: daemon.lastRunAtMs,
  };
}

export function createHostDaemonsService(deps: HostDaemonsServiceDeps): HostDaemonsService {
  const now = deps.now ?? Date.now;

  /**
   * 所有改动本机常驻项的动作串行执行。
   *
   * 适配器的写侧是「读当前整表 → 算新表 → 写回」：crontab 只有一份共享表格，
   * systemd 要先落文件再 daemon-reload。两个动作交错时，后者的写回会覆盖掉前者
   * （删掉 A 的同时停止 B，A 会被复活或 B 的停止丢失）。串行化放在这一处，
   * 而不是让每个适配器各自记锁。
   */
  let mutationQueue: Promise<unknown> = Promise.resolve();
  function serialize<T>(task: () => Promise<T>): Promise<T> {
    const result = mutationQueue.then(task, task);
    mutationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

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

  /**
   * 「这条常驻物的定义是什么时候落地的」，归属记录的身份也要用它。
   *
   * 有定义文件时刻就用它；没有（crontab）就用首次扫描到的时刻，并记进台账 ——
   * 否则每次扫描都会换一个锚点，归属记录永远对不上，条目会反复被重新追溯。
   */
  function definitionStamp(daemon: RawHostDaemon, capturedAtMs: number): number {
    if (daemon.definitionMtimeMs !== null) return daemon.definitionMtimeMs;
    return deps.ledger.getFirstSeen(daemon.id) ?? capturedAtMs;
  }

  async function traceOwner(
    daemon: RawHostDaemon,
    stampMs: number,
  ): Promise<{ sessionId: string; title: string | null } | null | undefined> {
    // 边界期间数据库可能正被换掉：此刻读到的行属于哪个账号无法确定，直接不读。
    if (boundaryPending()) return undefined;
    const timeless = daemon.definitionMtimeMs === null;
    const fromMs = stampMs - (timeless ? FIRST_SEEN_LOOKBACK_MS : ATTRIBUTION_WINDOW_MS);
    const toMs = stampMs + ATTRIBUTION_WINDOW_MS;
    // 追溯要读消息库（跨 await）：切号期间读到的可能已是另一个账号的库。
    const scopeBefore = scopeStamp();
    const { rows, truncated } = await deps.readToolMessages(
      fromMs,
      toMs,
      timeless ? { limit: FIRST_SEEN_TRACE_LIMIT, newestFirst: true } : undefined,
    );
    // 切号后作废在途查询：旧账号的结果不能写进新账号的台账。undefined ≠ null ——
    // null 是「查无此人」（可写负缓存），undefined 是「结果不可信」（不得写任何台账）。
    if (scopeBefore !== scopeStamp()) return undefined;
    const picked = pickOwnerSession(rows, needlesOf(daemon));
    if (picked) return { sessionId: picked.sessionId, title: picked.title };
    // 只读到一部分就判「查无此人」，会让这条条目在窗口关闭后被负缓存永久隐藏。
    return truncated ? undefined : null;
  }

  /**
   * 台账记录是否仍然描述「现在这一条」。
   * 同名同路径的条目被删掉、随后由别的程序重建时，定义时刻与启动命令都会变；
   * 只按 id 认权限会让新条目继承旧授权，所以定义变了就撤销。
   */
  function ownerMatchesTask(
    owner: HostDaemonOwnerRecord | null,
    daemon: RawHostDaemon,
    stampMs: number,
  ): boolean {
    if (!owner) return false;
    return owner.definitionMtimeMs === stampMs && owner.command === daemon.command;
  }

  /** 取当前有效归属；定义已变则顺手撤销，返回 null 让调用方重新判定。 */
  function currentOwner(daemon: RawHostDaemon, stampMs: number): HostDaemonOwnerRecord | null {
    const owner = deps.ledger.getOwner(daemon.id);
    if (!owner || ownerMatchesTask(owner, daemon, stampMs)) return owner;
    deps.ledger.clearOwner(daemon.id);
    return null;
  }

  /** 操作前重新扫描并复核归属：renderer 只提供候选 id，授权依据在 main 重算。 */
  async function requireOwnedTask(id: string): Promise<RawHostDaemon> {
    if (!deps.target) {
      throw new HostDaemonActionError('UNSUPPORTED', 'host daemons are not available here');
    }
    if (boundaryPending()) {
      throw new HostDaemonActionError('NOT_OWNED', 'account boundary in progress');
    }
    const scopeBefore = scopeStamp();
    await deps.ledger.ready();
    const daemons = await deps.target.scan();
    // 扫描期间切号：这条授权可能来自上一个账号的台账，不能拿来操作本机条目。
    if (scopeBefore !== scopeStamp()) {
      throw new HostDaemonActionError('NOT_OWNED', 'account changed during the rescan');
    }
    const daemon = daemons.find((candidate) => candidate.id === id);
    if (!daemon) throw new HostDaemonActionError('NOT_FOUND', 'host daemon no longer exists');
    const stampMs = definitionStamp(daemon, now());
    // 只有本功能登记过、且定义没变过的条目才允许操作 —— 绝不变成任意常驻项管理器。
    if (!ownerMatchesTask(currentOwner(daemon, stampMs), daemon, stampMs)) {
      throw new HostDaemonActionError('NOT_OWNED', 'host daemon was not created by Cindy');
    }
    return daemon;
  }

  return {
    async list() {
      const capturedAtMs = now();
      if (!deps.target) {
        return { capturedAtMs, supported: false, entries: [], unrelatedCount: 0 };
      }
      // 边界进行中（拆运行时 / 换库）不扫不读：库和台账目录可能分属两个账号。
      if (boundaryPending()) {
        return { capturedAtMs, supported: true, entries: [], unrelatedCount: 0 };
      }
      // 清单里的条目带归属会话标题：账号切换后本次结果作废，不能把旧账号的标题
      // 交给新账号的界面（下次扫描会按新账号重新归属）。
      const scopeBefore = scopeStamp();
      // 台账读盘是异步的（列表 IPC 上不能同步 I/O），必须在读 getter 之前完成。
      await deps.ledger.ready();
      if (scopeBefore !== scopeStamp()) {
        return { capturedAtMs, supported: true, entries: [], unrelatedCount: 0 };
      }
      const daemons = await deps.target.scan();
      const entries: HostDaemonEntry[] = [];
      // 扫描期间的归属结论先攒在这里，整轮结束后一次性提交：只要中途切号（或边界
      // 进行中）就整批丢掉。这样「旧账号的标题写进新账号台账」在结构上不可能发生，
      // 而不是靠每一处写入点各自记得核对。
      const pendingOwners: Array<{ id: string; record: HostDaemonOwnerRecord }> = [];
      const pendingMisses: Array<{ id: string; stampMs: number }> = [];
      const pendingFirstSeen: Array<{ id: string; stampMs: number }> = [];
      const pendingClears: string[] = [];
      let unrelatedCount = 0;
      let traces = 0;
      let scopeLost = scopeBefore !== scopeStamp();

      for (const daemon of daemons) {
        if (scopeBefore !== scopeStamp()) {
          scopeLost = true;
          break;
        }
        const stampMs = definitionStamp(daemon, capturedAtMs);
        if (daemon.definitionMtimeMs === null && deps.ledger.getFirstSeen(daemon.id) === null) {
          pendingFirstSeen.push({ id: daemon.id, stampMs });
        }
        const existing = deps.ledger.getOwner(daemon.id);
        const definitionChanged = existing !== null && !ownerMatchesTask(existing, daemon, stampMs);
        if (definitionChanged) pendingClears.push(daemon.id);
        let owner = definitionChanged ? null : existing;

        if (!owner) {
          // 时间窗还没过去时必须重算：条目可能是刚由会话创建的，工具调用行可能比
          // 这次扫描晚落库（用户先打开面板、再回到会话），此时记下的 miss 会让它
          // 永远停在「无关」里。窗口过去之后才相信 miss。
          const windowOpen = capturedAtMs <= stampMs + ATTRIBUTION_WINDOW_MS;
          const alreadyMissed =
            !windowOpen && deps.ledger.getMissMtime(daemon.id) === stampMs;
          if (alreadyMissed || traces >= MAX_TRACES_PER_SCAN) {
            unrelatedCount += 1;
            continue;
          }
          traces += 1;
          let traced: { sessionId: string; title: string | null } | null | undefined = null;
          try {
            traced = await traceOwner(daemon, stampMs);
          } catch {
            // 查询失败（库忙 / 正在切账号）≠ 查无此人：不能写负缓存，否则一次失败就
            // 让这条条目永远隐身。本次按「无关」计数，下次扫描重试。
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
              definitionMtimeMs: stampMs,
              command: daemon.command,
            };
            pendingOwners.push({ id: daemon.id, record });
            owner = record;
          } else {
            pendingMisses.push({ id: daemon.id, stampMs });
            unrelatedCount += 1;
            continue;
          }
        }

        if (!owner) {
          unrelatedCount += 1;
          continue;
        }
        entries.push(toEntry(daemon, owner));
      }

      if (scopeLost || scopeBefore !== scopeStamp()) {
        // 整轮作废：一条都还没提交，直接丢弃即可。
        return { capturedAtMs, supported: true, entries: [], unrelatedCount };
      }

      for (const id of pendingClears) deps.ledger.clearOwner(id);
      for (const entry of pendingFirstSeen) deps.ledger.setFirstSeen(entry.id, entry.stampMs);
      for (const entry of pendingOwners) deps.ledger.setOwner(entry.id, entry.record);
      for (const entry of pendingMisses) deps.ledger.setMissMtime(entry.id, entry.stampMs);
      try {
        // save() 自身只在有改动时落盘。
        await deps.ledger.save();
      } catch {
        // 台账写失败只影响下次是否重算，不影响本次清单。
      }

      entries.sort((left, right) => left.name.localeCompare(right.name));
      return { capturedAtMs, supported: true, entries, unrelatedCount };
    },

    async stop(id) {
      return serialize(async () => {
        const daemon = await requireOwnedTask(id);
        // crontab 这类没有单条运行态的常驻项只能整条删除，不能单独停止。
        if (daemon.stoppable === false) {
          throw new HostDaemonActionError(
            'NOT_STOPPABLE',
            'host daemon cannot be stopped on its own',
          );
        }
        await deps.target!.stop(id);
      });
    },

    async run(id) {
      return serialize(async () => {
        await requireOwnedTask(id);
        await deps.target!.run(id);
      });
    },

    async remove(id) {
      return serialize(async () => {
        await requireOwnedTask(id);
        const scopeBefore = scopeStamp();
        await deps.target!.remove(id);
        // 删除期间切号：新账号的台账不是这次授权的来源，不能顺手动它。
        if (scopeBefore !== scopeStamp()) return;
        // 条目已不在：顺手撤掉授权，避免同名条目重建后继承。
        deps.ledger.clearOwner(id);
        try {
          await deps.ledger.save();
        } catch {
          // 写失败只影响下次扫描，不影响这次删除结果。
        }
      });
    },
  };
}
