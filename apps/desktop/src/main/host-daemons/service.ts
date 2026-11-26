/**
 * host-daemons/service —— 本机常驻清单的编排层（依赖全部注入，可直接单测）。
 *
 * 平台差异全在 target 适配器里（Windows 计划任务 / macOS LaunchAgents / Linux 用户级
 * systemd + crontab）；这里只做与平台无关的事：账号边界、归属追溯、台账、动作授权。
 *
 * 归属证据只有一种：某个会话执行过的命令里出现该条目的名字（见 attribution.ts）。
 * 有定义时刻的条目读那一刻前后的时间窗，这不是随意的截断：证据行在命令开始执行时
 * 记时刻（messagePersistBroadcaster 在 tool_use 事件里取 Date.now()），条目的创建时刻
 * 正是这条命令跑出来的，两者只差一个命令时长；没有命中时不认领，方向是安全的。
 * 没有定义时刻的条目（crontab）没有这个前提，要把工具调用历史从旧到新翻一遍。
 *
 * 两条读写纪律（工程规范 §8.2 / §8.3）：
 * - list() 只读：扫描 + 读台账，不追溯、不写盘。
 * - refresh() 是唯一的更新入口：推进一轮归属并保存台账，返回隔多久再推进。主进程自己的
 *   后台任务按它给的间隔接着做，界面收到变化通知后重读一次，不靠轮询列表来推进。
 * 没读到头不下结论：一轮只读一段，没结论的条目如实报成「待核对」。
 * 「没观察到」不等于事实：来源没读到时不清理消失条目的记录，查询失败不写负缓存。
 */

import type {
  HostDaemonEntry,
  HostDaemonsRefreshResult,
  HostDaemonsSnapshot,
} from '../../shared/hostDaemons.js';
import { ATTRIBUTION_WINDOW_MS, createOwnerHitCounter, pickOwnerSession } from './attribution.js';
import type { OwnerHitCounter } from './attribution.js';
import type { HostDaemonLedger, HostDaemonOwnerRecord } from './ledger.js';
import type { HostDaemonTarget, RawHostDaemon } from './target.js';
import { TOOL_MESSAGE_WINDOW_WIDE_LIMIT } from './toolHistory.js';
import type { ToolUseCursor, readToolUses, readToolUsesFrom } from './toolHistory.js';

/** 一次扫描里最多追溯多少个有定义时刻的未归属条目（每个各查一次时间窗）。 */
const MAX_TRACES_PER_SCAN = 40;

/** 一轮推进里全历史回看最多读多少页；冷盘时单页可达 1 秒，所以另有时间上限。 */
const SWEEP_PAGES_PER_PASS = 300;

/** 一轮推进里全历史回看最多占用多久；到期就停，剩下的留给下一轮。 */
const SWEEP_CALL_BUDGET_MS = 2_000;

/** 历史还没读完时，隔多久再推进一轮。 */
const SWEEP_POLL_MS = 1_500;

/** 这一轮没读成（库忙）时隔多久再试：不围着正在忙的库高频重试。 */
const SWEEP_RETRY_MS = 15_000;

/** 只剩等时间窗关闭时，最多隔多久再看一次（晚落库的行要从这里接上）。 */
const SWEEP_MAX_WAIT_MS = 30_000;

interface Owner {
  sessionId: string;
  title: string | null;
}

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

/** 归属追溯用的匹配词默认只有名字；适配器可以补充更具体的词。 */
function needlesOf(daemon: RawHostDaemon): readonly string[] {
  return daemon.attributionNeedles ?? [daemon.name];
}

export interface HostDaemonsServiceDeps {
  /**
   * 本平台的常驻项来源。null = 本平台没有可枚举的来源，list 回 `supported: false`。
   */
  target: HostDaemonTarget | null;
  /** 有定义时刻的条目：读定义时刻前后那一段工具调用。 */
  readToolUses: typeof readToolUses;
  /** 没有定义时刻的条目：从旧到新分页读全部工具调用。 */
  readToolUsesFrom: typeof readToolUsesFrom;
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
  /** 读路径：只扫描、只读台账，不追溯、不写盘。 */
  list(): Promise<HostDaemonsSnapshot>;
  /** 明确的更新入口：推进一轮归属追溯并保存台账。 */
  refresh(): Promise<HostDaemonsRefreshResult>;
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

/** 一次扫描里请求核对的一条没有定义时刻的条目。 */
interface SweepRequest {
  daemon: RawHostDaemon;
  stampMs: number;
}

/** 一条待核对条目的命中累计；历史是分页读的，行不必一次到齐。 */
interface SweepItem extends SweepRequest {
  counter: OwnerHitCounter;
}

/**
 * 一组条目共用的读取位置。同一通道里的条目从同一页开始读，读过的每一页都恰好
 * 喂给它们各一次 —— 既不漏（漏了会误判「无关」），也不重复（重复会让命中数
 * 翻倍、改变归属会话的先后）。
 */
interface SweepLane {
  items: SweepItem[];
  /** 接着读的起点；null = 从最早一页开始。 */
  cursor: ToolUseCursor | null;
  /** 历史已读到最新的一行。 */
  exhausted: boolean;
  /** 本轮推进里读到过头；结论只认本轮的读取，见 sweepPass。 */
  readToEndThisPass: boolean;
}

/** 时间窗还没过去：条目可能是刚由会话创建的，工具调用行或许还没落库，不能判「无关」。 */
function windowOpen(stampMs: number, nowMs: number): boolean {
  return nowMs < stampMs + ATTRIBUTION_WINDOW_MS;
}

export function createHostDaemonsService(deps: HostDaemonsServiceDeps): HostDaemonsService {
  const now = deps.now ?? Date.now;

  /**
   * 面板发起的停止 / 立即运行 / 删除一律串行：crontab 只有一份共享表格，
   * 两个删除交错时，后写的会把先删的那一行带回来。
   * 这里保证「面板的动作不互相交错」；适配器被别的入口单独使用时也要成立，
   * 所以 crontab 适配器内还有一把只属于那张表的锁。
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

  /**
   * 有定义时刻的条目：查定义时刻前后的时间窗。
   * 返回 null = 读全了确实没有；undefined = 这次读不全或结果不可信，不能下结论。
   */
  async function traceOwner(
    daemon: RawHostDaemon,
    stampMs: number,
  ): Promise<Owner | null | undefined> {
    // 边界期间数据库可能正被换掉：此刻读到的行属于哪个账号无法确定，直接不读。
    if (boundaryPending()) return undefined;
    const fromMs = stampMs - ATTRIBUTION_WINDOW_MS;
    const toMs = stampMs + ATTRIBUTION_WINDOW_MS;
    // 追溯要读消息库（跨 await）：切号期间读到的可能已是另一个账号的库。
    const scopeBefore = scopeStamp();
    let window: Awaited<ReturnType<typeof readToolUses>>;
    try {
      const narrow = await deps.readToolUses(fromMs, toMs);
      // 没读全就读全：忙的时候这 10 分钟里可能有几百次调用，前 300 行里没有不等于没有。
      window = narrow.truncated
        ? await deps.readToolUses(fromMs, toMs, TOOL_MESSAGE_WINDOW_WIDE_LIMIT)
        : narrow;
    } catch {
      // 查询失败（库忙 / 正在切账号）≠ 查无此人：不能写负缓存。
      return undefined;
    }
    // 切号后作废在途查询：旧账号的结果不能写进新账号的台账。undefined ≠ null ——
    // null 是「查无此人」（可写负缓存），undefined 是「结果不可信」（不得写任何台账）。
    if (scopeBefore !== scopeStamp()) return undefined;
    const picked = pickOwnerSession(window.rows, needlesOf(daemon));
    if (picked) return { sessionId: picked.sessionId, title: picked.title };
    // 只读到一部分就判「查无此人」，会让这条条目被负缓存永久隐藏。
    return window.truncated ? undefined : null;
  }

  /**
   * 全历史回看的进度。挂在服务实例上而不是模块上：它属于这个实例正在读的那个账号。
   * 只在内存里 —— 进度丢了最多从头再读一遍，结论不会丢（一经得出就写台账）。
   */
  let sweep: {
    /** 这份进度属于哪个账号；换账号后必须从头读。 */
    scope: string | null;
    lanes: SweepLane[];
  } | null = null;
  /** 并发的推进依次进行：同一段历史被两轮各读一遍，命中会重复计数。 */
  let sweepTurn: Promise<unknown> = Promise.resolve();
  /** 只丢属于这个账号的进度：并发的另一轮推进可能已经为新账号建了新的进度。 */
  function dropSweep(scope: string | null): void {
    if (sweep && sweep.scope === scope) sweep = null;
  }

  /** 台账写失败只影响下次是否重算，不影响本次清单或动作结果。 */
  async function persist(): Promise<void> {
    try {
      await deps.ledger.save();
    } catch {
      // 同上。
    }
  }

  /**
   * 没有定义时刻的条目没有可查的时间窗：把工具调用历史从旧到新翻一遍，读到头才算数。
   *
   * 一次只推进一段（冷盘时单页可达 1 秒），进度留在通道里，下一次 list 接着读。
   * 新条目没看过游标之前的历史，所以它一出现就单开一条从最早读起的通道，已有条目
   * 的进度不动。读到头仍无证据的条目只等时间窗关闭：期间通道停在最后一行上，晚落库
   * 的行从那里接上，不必重读整段历史。所以每一轮都从停下的位置再读一页：「无关」
   * 只认本轮读到头的那次读取。
   *
   * 读失败、切号都返回 false = 这一轮没有正常走完，不下结论。预算用完算正常走完，
   * 剩下的留给下一次。预算从回看开始那一刻算：list 前面的扫描和时间窗追溯已经
   * 花掉的时间不算在这里，否则慢机器上轮到回看时预算总是已用完，一页都读不了。
   */
  async function sweepPass(
    scope: string | null,
    lanes: readonly SweepLane[],
    requested: (item: SweepItem) => boolean,
  ): Promise<boolean> {
    const deadline = now() + SWEEP_CALL_BUDGET_MS;
    let pages = 0;
    for (const lane of lanes) {
      // 这一轮只有被保留下来的条目（来源没读到）的通道不读：它们没有最新的定义。
      if (!lane.items.some(requested)) continue;
      // 「读到头」只是上一次读取时的事实：之后落库的证据只有再读一次才看得见。读完的
      // 通道若因为时间窗刚好关闭而不再读，上一轮之后落库的行会被漏掉，却被记成「无关」。
      do {
        if (boundaryPending() || scope !== scopeStamp()) return false;
        if (pages >= SWEEP_PAGES_PER_PASS || now() >= deadline) return true;
        const page = await deps
          .readToolUsesFrom(lane.cursor)
          // 读失败（库忙 / 正在切账号）≠ 查无此人：不下结论，下次从这一页接着读。
          .catch(() => null);
        if (page === null || scope !== scopeStamp()) return false;
        // 一页同时喂给通道里的所有条目：同一段历史只读一次。
        for (const row of page.rows) {
          for (const item of lane.items) item.counter.add(row);
        }
        // 空页没有「最后一行」：位置保持不动，否则下次会从最早一页重读、命中翻倍。
        if (page.next) lane.cursor = page.next;
        lane.exhausted = page.exhausted;
        lane.readToEndThisPass = lane.exhausted;
        pages += 1;
      } while (!lane.exhausted);
    }
    return true;
  }

  interface SweepOutcome {
    lanes: SweepLane[];
    /** 本轮扫到的条目；结论只对它们下。 */
    items: SweepItem[];
    passed: boolean;
  }

  /**
   * 认领条目、组装通道、推进都在同一次排队里完成。并发的两次 list 若在排队之外
   * 组装通道，后到的会拿着过期的读取位置把同一段历史再读一遍（命中翻倍），或者
   * 把先到的那次刚读的进度整个丢掉。
   */
  function advanceSweep(
    scope: string | null,
    requests: readonly SweepRequest[],
    unread: readonly string[],
  ): Promise<SweepOutcome> {
    const run = sweepTurn.then(async (): Promise<SweepOutcome> => {
      // 上一个账号留下的回看进度不能接着用。
      if (sweep && sweep.scope !== scope) sweep = null;
      const items = requests.map(
        (request): SweepItem =>
          sweep?.lanes
            .flatMap((lane) => lane.items)
            .find(
              (item) => item.daemon.id === request.daemon.id && item.stampMs === request.stampMs,
            ) ?? {
            ...request,
            counter: createOwnerHitCounter(needlesOf(request.daemon)),
          },
      );
      const scanned = new Set(items);
      // 没读到的来源里可能仍有这些条目：没扫到不等于已删除，它们的进度不作废。
      const possiblyPresent = (item: SweepItem): boolean =>
        unread.some((prefix) => item.daemon.id.startsWith(prefix));
      // 已有结论的条目离开通道；新条目单开一条从最早读起的通道，不动已有进度。
      const lanes: SweepLane[] = (sweep?.lanes ?? [])
        .map((lane) => ({
          ...lane,
          items: lane.items.filter((item) => scanned.has(item) || possiblyPresent(item)),
          readToEndThisPass: false,
        }))
        .filter((lane) => lane.items.length > 0);
      const newcomers = items.filter((item) => !lanes.some((lane) => lane.items.includes(item)));
      if (newcomers.length > 0) {
        lanes.push({ items: newcomers, cursor: null, exhausted: false, readToEndThisPass: false });
      }
      sweep = { scope, lanes };
      return {
        lanes,
        items,
        passed: await sweepPass(scope, lanes, (item) => scanned.has(item)),
      };
    });
    sweepTurn = run.then(
      () => undefined,
      () => undefined,
    );
    // 推进本身出错按「这一轮没走完」处理：条目留在待核对里，已得出的结论不受影响。
    return run.catch(
      (): SweepOutcome => ({ lanes: [], items: [], passed: false }),
    );
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
    // 来源没读到时清单是不完整的，但已读到的条目仍是如实扫到的，照常复核。
    const { entries: daemons } = await deps.target.scan();
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
    /**
     * 读路径：扫描 + 读台账，不追溯、不写盘（工程规范 §8.2）。归属还没结论的条目只报
     * 数量；推进在 refresh()，由主进程自己的后台任务按它给的间隔接着做。
     */
    async list() {
      const capturedAtMs = now();
      const empty = (supported: boolean): HostDaemonsSnapshot => ({
        capturedAtMs,
        supported,
        entries: [],
        unrelatedCount: 0,
        pendingCount: 0,
        incomplete: false,
      });
      if (!deps.target) return empty(false);
      // 边界进行中（拆运行时 / 换库）不扫不读：库和台账目录可能分属两个账号。
      if (boundaryPending()) return empty(true);
      // 清单里的条目带归属会话标题：账号切换后本次结果作废，不能把旧账号的标题
      // 交给新账号的界面。
      const scopeBefore = scopeStamp();
      // 读盘只在首次使用时发生一次（规范允许的幂等 ensure），之后立即返回。
      await deps.ledger.ready();
      if (scopeBefore !== scopeStamp()) return empty(true);
      const scan = await deps.target.scan();
      // 扫描期间切号：同上，本次结果作废。
      if (scopeBefore !== scopeStamp()) return empty(true);
      const entries: HostDaemonEntry[] = [];
      let unrelatedCount = 0;
      let pendingCount = 0;
      for (const daemon of scan.entries) {
        const stampMs = definitionStamp(daemon, capturedAtMs);
        const owner = deps.ledger.getOwner(daemon.id);
        // 定义变了的旧记录不认，但读路径不撤它：撤销在 refresh() 里提交。
        if (owner && ownerMatchesTask(owner, daemon, stampMs)) {
          entries.push(toEntry(daemon, owner));
        } else if (deps.ledger.getMissMtime(daemon.id) === stampMs) {
          unrelatedCount += 1;
        } else {
          pendingCount += 1;
        }
      }
      entries.sort((left, right) => left.name.localeCompare(right.name));
      return {
        capturedAtMs,
        supported: true,
        entries,
        unrelatedCount,
        pendingCount,
        // 没读到的来源里有什么无从得知：它们的条目既不进清单也不计数。
        incomplete: scan.unread.length > 0,
      };
    },

    /**
     * 明确的更新入口：重新扫描、推进一轮归属追溯、保存台账。返回还有没有条目没得出
     * 结论，以及隔多久再推进。没人调用它，台账就一直是旧状态 —— 列表只读。
     *
     * 和面板的动作共用一条队列：扫描和提交之间不夹着一次删除。
     */
    async refresh(): Promise<HostDaemonsRefreshResult> {
      return serialize(async () => {
        const settled: HostDaemonsRefreshResult = { pendingCount: 0, retryAfterMs: null };
        // 边界是瞬态的（换库 / 拆运行时）：这一轮作废，但不算没事可做，否则过后不再续排。
        if (!deps.target) return settled;
        if (boundaryPending()) return { pendingCount: 0, retryAfterMs: SWEEP_RETRY_MS };
        const capturedAtMs = now();
        const scopeBefore = scopeStamp();
        await deps.ledger.ready();
        if (scopeBefore !== scopeStamp()) return settled;
        const scan = await deps.target.scan();
        const daemons = scan.entries;
        // 本轮的结论先攒在这里，整轮结束后一次性提交：只要中途切号就整批丢掉。这样
        // 「旧账号的标题写进新账号台账」在结构上不可能发生，而不是靠每一处写入点
        // 各自记得核对。
        const pendingOwners: Array<{ id: string; record: HostDaemonOwnerRecord }> = [];
        const pendingMisses: Array<{ id: string; stampMs: number }> = [];
        const pendingClears: string[] = [];
        /** 没有定义时刻的条目，交给全历史回看。 */
        const checking: SweepRequest[] = [];
        /** 有定义时刻、窗口还开着的未命中：窗口关闭后必须再读一次才能记「无关」。 */
        const waitingWindows: number[] = [];
        /** 有定义时刻的条目这一轮没查成（库忙，或超出单轮上限）：稍后要再来。 */
        let retryLater = false;
        let traces = 0;

        for (const daemon of daemons) {
          const stampMs = definitionStamp(daemon, capturedAtMs);
          if (daemon.definitionMtimeMs === null && deps.ledger.getFirstSeen(daemon.id) === null) {
            // 「首次扫到的时刻」是回看的锚点：锚点每轮换一个值，已读的进度就会被当成
            // 另一代作废、从最早一页重来。它只说明被扫到过，与历史读没读成无关。
            deps.ledger.setFirstSeen(daemon.id, stampMs);
          }
          const existing = deps.ledger.getOwner(daemon.id);
          if (existing && !ownerMatchesTask(existing, daemon, stampMs)) {
            pendingClears.push(daemon.id);
          }
          if (existing && ownerMatchesTask(existing, daemon, stampMs)) continue;
          // miss 只在时间窗关闭之后才落盘（见下），台账里记着就说明它来自窗口关闭后的
          // 一次读取，可以直接相信。
          if (deps.ledger.getMissMtime(daemon.id) === stampMs) continue;
          if (daemon.definitionMtimeMs === null) {
            checking.push({ daemon, stampMs });
            continue;
          }
          if (traces >= MAX_TRACES_PER_SCAN) {
            retryLater = true;
            continue;
          }
          traces += 1;
          const traced = await traceOwner(daemon, stampMs);
          if (traced === undefined) {
            // 切号作废，或查询失败（库忙）：既不写 owner 也不写 miss 负缓存，稍后重查。
            retryLater = true;
            continue;
          }
          if (traced) {
            pendingOwners.push({
              id: daemon.id,
              record: {
                ...traced,
                atMs: capturedAtMs,
                definitionMtimeMs: stampMs,
                command: daemon.command,
              },
            });
            continue;
          }
          // 窗口还开着时没命中，可能只是工具调用行还没落库（条目刚由会话创建，用户
          // 先打开面板、再回到会话）。记下来就成了永久的「无关」：所以不落盘，窗口内
          // 每轮重查（一次索引读），窗口关闭后的第一轮读到「没有」才记下。
          if (!windowOpen(stampMs, capturedAtMs)) pendingMisses.push({ id: daemon.id, stampMs });
          else waitingWindows.push(stampMs);
        }

        if (scopeBefore !== scopeStamp()) {
          // 整轮作废：一条都还没提交，直接丢弃即可。回看进度同理，它属于另一个账号。
          dropSweep(scopeBefore);
          // 面板若仍开着，下一轮会按新账号重新扫描；不安排就没人再推进。
          return { ...settled, retryAfterMs: SWEEP_RETRY_MS };
        }

        // 没有定义时刻的条目以「连续被扫到」为一代：没扫到就结束一代，锚点和结论一并
        // 作废 —— 同一条以后被重新加回来时，不能沿用上一代的「无关」或归属。但这只在
        // 扫描完整时成立：来源没读到时「没扫到」只说明没看到，不是已删除。
        if (scan.unread.length === 0) {
          const seenIds = new Set(daemons.map((daemon) => daemon.id));
          for (const id of deps.ledger.firstSeenIds()) {
            if (!seenIds.has(id)) deps.ledger.retireFirstSeen(id);
          }
        }

        const { lanes, items, passed } = await advanceSweep(
          scopeBefore,
          checking,
          scan.unread,
        );
        if (scopeBefore !== scopeStamp()) {
          // 回看途中切号：本轮结论作废，同上。
          dropSweep(scopeBefore);
          return { ...settled, retryAfterMs: SWEEP_RETRY_MS };
        }
        // 时间窗的结论与回看是否读成无关，照常提交。
        for (const id of pendingClears) deps.ledger.clearOwner(id);
        for (const entry of pendingOwners) deps.ledger.setOwner(entry.id, entry.record);
        for (const entry of pendingMisses) deps.ledger.setMissMtime(entry.id, entry.stampMs);
        if (!passed) {
          // 回看读失败（库忙）：条目留在「待核对」里，进度保留，下一轮从停下的地方接着读。
          await persist();
          return { pendingCount: checking.length, retryAfterMs: SWEEP_RETRY_MS };
        }

        const checkedMisses: Array<{ id: string; stampMs: number }> = [];
        const waiting: SweepItem[] = [];
        let reading = false;        for (const lane of lanes) {
          const current = lane.items.filter((item) => items.includes(item));
          if (current.length === 0) continue;
          // 读到头才下结论：命中最多的会话要读完全部历史才知道，半路记下的归属之后不会
          // 再改。而且必须是本轮读到头的：这一轮没轮到读的通道，停下的位置之后可能已有
          // 新证据。
          if (!lane.exhausted || !lane.readToEndThisPass) {
            waiting.push(...current);
            reading = true;
            continue;
          }
          for (const item of current) {
            const owner = item.counter.pick();
            if (owner) {
              pendingOwners.push({
                id: item.daemon.id,
                record: {
                  ...owner,
                  atMs: capturedAtMs,
                  definitionMtimeMs: item.stampMs,
                  command: item.daemon.command,
                },
              });
            } else if (windowOpen(item.stampMs, now())) {
              // 读完了仍无证据，只等时间窗关闭：晚落库的行要从停下的位置接上。
              waiting.push(item);
            } else {
              checkedMisses.push({ id: item.daemon.id, stampMs: item.stampMs });
            }
          }
        }
        for (const entry of pendingOwners) deps.ledger.setOwner(entry.id, entry.record);
        for (const entry of checkedMisses) deps.ledger.setMissMtime(entry.id, entry.stampMs);
        await persist();

        // 窗口还开着的条目也要有人在意：不排下一轮，窗口关闭后那次决定性的重读就不会发生。
        const pendingCount = waiting.length + waitingWindows.length;
        if (retryLater) return { pendingCount, retryAfterMs: SWEEP_RETRY_MS };
        if (pendingCount === 0) return settled;
        const nextWindow = Math.min(
          ...waiting.map((item) => item.stampMs + ATTRIBUTION_WINDOW_MS),
          ...waitingWindows.map((stampMs) => stampMs + ATTRIBUTION_WINDOW_MS),
        );
        return {
          pendingCount,
          retryAfterMs: reading
            ? SWEEP_POLL_MS
            : Math.min(SWEEP_MAX_WAIT_MS, Math.max(SWEEP_POLL_MS, nextWindow - now())),
        };
      });
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
        await persist();
      });
    },
  };
}
