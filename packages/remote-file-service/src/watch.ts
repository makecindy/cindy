/**
 * watch — daemon 端的 workdir 文件监听(P4)。
 *
 * 实现选型:Node 内建 `fs.watch(dir, { recursive: true })`。
 *  - 远端跑在 bundled Node(≥22)上,Linux(inotify 递归模拟)/ macOS(FSEvents)
 *    都原生支持 recursive;不引原生依赖(@parcel/watcher 的 prebuilt .node
 *    进不了 esbuild 单文件 bundle,这正是它留在 desktop 侧的原因)。
 *  - fs.watch 只报 'rename' | 'change' + 相对 filename:'rename' 不区分
 *    add/unlink,用一次 lstat 判存在性映射到 FileTreeEvent 的 add/unlink。
 *
 * 过滤(与 desktop 本地 watcher 同语义):
 *  - ignore matcher(.gitignore + builtin)兜底,file/dir 双查任一命中即丢;
 *  - `.xdt-tmp` 原子写中间产物直接丢(防前端 ghost row);
 *  - 50ms 窗口按 (type, relPath) coalesce,吸收 agent 批量写盘的事件风暴——
 *    消费端(desktop → renderer fetchDir)按父目录 refetch,重复事件只是
 *    浪费 IPC,合并无语义损失。
 *
 * 生命周期:per-workdir 单 watcher(重复 watchStart 幂等);stdin EOF /
 * watchStop 时 close。事件经注入的 emit 回调发 `fileTree` 帧。
 *
 * 注:自带过滤器(ignore matcher / .xdt-tmp)在 watchStart 时就固定下来,
 * 控制端改开关后需要先 watchStop 再 watchStart 才能换 matcher。
 *
 * 同一 workdir 会被**多个消费方**请求(desktop 的 SSH 文件浏览器、device-link
 * 的 fs-watch topic)。每个消费方用 consumerId 登记自己的过滤需求,watcher 取
 * 全部消费者的**可见性并集** —— 否则后到的一方(控制端默认隐藏)会把前一方的
 * reveal matcher 覆盖掉:desktop 仍列着 build / dist,它们的改动却永远没有
 * 事件。多推的帧由订阅端按各自视图忽略,代价远小于静默丢事件。任一消费者在,
 * watcher 就不拆;最后一个 stop 才关。选项变化由 start() / stop() 收敛。
 */

import { watch as fsWatch, promises as fs, type FSWatcher } from 'node:fs';
import path from 'node:path';
import {
  createEventIgnoreMatcher,
  loadIgnoreMatcher,
  scopedLogger,
  WATCH_ALWAYS_IGNORE,
  XDT_TMP_SUFFIX,
  type Matcher,
} from '@cindy/file-browser-core';

const log = scopedLogger('file-service/watch');

/**
 * 「即使开关打开也不推事件」的恒真层(node_modules / Library / VCS / OS 垃圾)。
 * 与 desktop 本地 watcher 的 PREFILTER_ALWAYS 同一份名单(单源:
 * file-browser-core 的 WATCH_ALWAYS_IGNORE),因为 fs.watch recursive 会把
 * 这些目录的事件照单全推上来 —— 没有这层兜底,`npm install` 或 Unity 导入会在
 * SSH + IPC 上打出一串与路径数同阶的 fileTree 帧。容器依赖 workdir,常量即可。
 */
const eventAlwaysIgnore = createEventIgnoreMatcher();

/**
 * `WATCH_ALWAYS_IGNORE` 的小写集合。
 *
 * 按段比较的本地判断必须折叠大小写，与 `ignore` 包（createEventIgnoreMatcher
 * 消费它，`ignorecase` 默认 true）的口径一致：大小写不敏感卷上 `NODE_MODULES` /
 * `library` 这类变体在开关打开时可见，若本地比较区分大小写，它们**自身**的事件
 * 会被恒真层吞掉，行陈旧到手动刷新（评审 P2）。
 */
const alwaysIgnoreNamesLower = new Set(
  (WATCH_ALWAYS_IGNORE as readonly string[]).map((name) => name.toLowerCase()),
);

/**
 * 路径是否落在「开关打开也永远不推事件」目录的**内部**(不含目录自身)。
 *
 * 为什么不直接问 eventAlwaysIgnore:`ignore` 的目录模式(`node_modules/`)同时
 * 匹配该目录自身与它全部后代,而这里要的只是后代 —— 开关打开时 node_modules /
 * Library 这一行就在树里,它自己被创建 / 删除 / 改名必须让父目录 refetch
 * (评审 P1:整条 rename 被吞掉的话,树会陈旧到手动刷新)。所以按路径段判断:
 * 除最后一段外任一段命中名单即为「内部」。
 */
function isInsideAlwaysIgnoredDir(relPath: string): boolean {
  const segments = relPath.split('/');
  for (let i = 0; i < segments.length - 1; i += 1) {
    if (alwaysIgnoreNamesLower.has(segments[i].toLowerCase())) return true;
  }
  return false;
}

/**
 * 路径是否是「开关打开也永远不推事件」目录的**自身**(node_modules / Library)。
 * 这些行在开关打开时就在树里(见 isInsideAlwaysIgnoredDir),而恒真层的`ignore`
 * 模式对自身也命中 —— 兜底那一行必须先把它排除掉,否则目录自身的 rename 又会被
 * 吞回去。
 */
function isAlwaysIgnoredDirItself(relPath: string): boolean {
  const last = relPath.slice(relPath.lastIndexOf('/') + 1);
  return alwaysIgnoreNamesLower.has(last.toLowerCase());
}

export interface RemoteFileTreeEvent {
  workdir: string;
  type: 'add' | 'change' | 'unlink';
  /** workdir-relative POSIX path */
  relPath: string;
}

interface WatchEntry {
  watcher: FSWatcher;
  matcher: Matcher;
  /** 建 watcher 时生效的过滤开关;变了要重建 matcher(fs.watch 本身不变)。 */
  hideMetaFiles: boolean;
  showIgnoredDirs: boolean;
  /** coalesce 缓冲:key = `${type}::${relPath}`。 */
  pending: Map<string, RemoteFileTreeEvent>;
  flushTimer: NodeJS.Timeout | null;
}

/** 决定 watcher 过滤行为的选项(不含 workdir)。 */
interface WatchFilterOptions {
  hideMetaFiles: boolean;
  showIgnoredDirs: boolean;
}

/** 一个消费者在某个 workdir 上的意图。 */
interface ConsumerIntent {
  /** 当前尝试的过滤需求(reconcile 与并集用这个)。 */
  options: WatchFilterOptions;
  /** 最近一次 reconcile **成功后**生效过的值;从没成功过是 null。
   *  失败回滚恢复到它 —— 不能快照「进入 start 时的前值」:同一 consumerId 的
   *  重叠 start 里,那个前值可能是另一个尚未提交、同样失败的尝试(评审 P1)。 */
  committed: WatchFilterOptions | null;
}

function normalizeWatchOptions(opts: {
  hideMetaFiles?: boolean;
  showIgnoredDirs?: boolean;
}): WatchFilterOptions {
  return { hideMetaFiles: opts.hideMetaFiles ?? true, showIgnoredDirs: opts.showIgnoredDirs === true };
}

function sameWatchOptions(a: WatchFilterOptions, b: WatchFilterOptions): boolean {
  return a.hideMetaFiles === b.hideMetaFiles && a.showIgnoredDirs === b.showIgnoredDirs;
}

const COALESCE_MS = 50;

/** watcher 报错后重建的退避参数：起点 / 上限 / 次数上限。 */
const RECONCILE_RETRY_BASE_MS = 500;
const RECONCILE_RETRY_MAX_MS = 8_000;
/** 退避指数的封顶档位:计数到这里后不再变大,转为固定 RECONCILE_RETRY_MAX_MS 重试。 */
const RECONCILE_RETRY_BACKOFF_CAP = 5;

export class WorkdirWatchManager {
  private readonly entries = new Map<string, WatchEntry>();
  /** 启动中的 workdir:has 判定与 entries.set 之间隔着 loadIgnoreMatcher 的
   *  await,并发 start(双窗口 / 重连 replay)会双双通过判定,各建一个原生
   *  watcher——事件双份、先建的那个 watchStop 够不着直到 daemon 退出。
   *  并发请求 piggyback 同一个启动 promise。 */
  private readonly starting = new Map<string, Promise<void>>();
  /** 启动窗口内收到 stop 的 workdir:startInner 完成时不装 watcher(装完即拆),
   *  否则快速开关文件浏览会留下无人再来 stop 的孤儿原生 watcher。 */
  private readonly stopDuringStart = new Set<string>();
  /** 每个 workdir 的消费者 → 它的意图(当前尝试 + 最近一次生效值)。watcher 只此
   *  一份,选项取全部消费者的可见性并集(见 effectiveOptions);start() / stop()
   *  每轮重读它收敛。 */
  private readonly desired = new Map<string, Map<string, ConsumerIntent>>();

  /** watcher 报错后的重建重试定时器与次数（退避 + 上限，见 scheduleReconcileRetry）。 */
  private readonly retryTimers = new Map<string, NodeJS.Timeout>();
  private readonly retryAttempts = new Map<string, number>();

  /** 没带 consumerId 的调用方(旧控制端 / 内部调用)归到这个默认消费者。 */
  private static readonly DEFAULT_CONSUMER = 'default';
  private readonly emit: (event: RemoteFileTreeEvent) => void;

  constructor(emit: (event: RemoteFileTreeEvent) => void) {
    this.emit = emit;
  }

  /** 幂等启动。matcher 加载失败 / fs.watch 抛错向上冒(RPC 返回 OPERATION_FAILED)。
   *  已存在同 workdir 的 watcher 时:过滤开关不同则重建(控制端改了「显示被忽略
   *  的目录」后无需先 stop,重启守护进程也不必同步状态)。 */
  async start(
    workdir: string,
    opts: { hideMetaFiles?: boolean; showIgnoredDirs?: boolean } = {},
    consumerId: string = WorkdirWatchManager.DEFAULT_CONSUMER,
  ): Promise<void> {
    const consumers = this.desired.get(workdir) ?? new Map<string, ConsumerIntent>();
    const attempted = normalizeWatchOptions(opts);
    consumers.set(consumerId, {
      options: attempted,
      committed: consumers.get(consumerId)?.committed ?? null,
    });
    this.desired.set(workdir, consumers);
    try {
      await this.reconcile(workdir);
      this.clearReconcileRetry(workdir); // 新意图已生效:旧的重试状态作废
      // 成功才记 committed:失败回滚只恢复到「真的生效过」的值。
      const settled = this.desired.get(workdir)?.get(consumerId);
      if (settled && settled.options === attempted) settled.committed = attempted;
    } catch (err) {
      // 启动失败:回滚**本次**写入的意图,否则 daemon 会留下一个「幽灵消费者」——
      // 控制端的失败处理只清本地注册、不会再发 watchStop(见 remote-watch.ts),
      // 之后别的消费者的可见性并集会被它抬高,最后一人 stop 时还会因它留下
      // 孤儿 watcher(评审 P1)。
      //
      // 恢复到 **committed** 而不是进入时快照:同一 consumerId 的重叠 start(双
      // 窗口启同一 workdir)里,快照可能是另一个尚未提交、同样失败的尝试 ——
      // 恢复它等于让失败注册复活,而下面 fire-and-forget 的 reconcile 会真给
      // 它建一个没人再 stop 的 watcher。没有 committed = 该 consumer 从未成功
      // 注册过,直接删。
      const current = this.desired.get(workdir)?.get(consumerId);
      if (current && current.options === attempted) {
        if (current.committed) {
          current.options = current.committed;
        } else {
          this.desired.get(workdir)?.delete(consumerId);
          if (this.desired.get(workdir)?.size === 0) this.desired.delete(workdir);
        }
      }
      // 回滚改变了并集,而且失败可能就在「选项变化 → closeEntry 拆掉旧 watcher →
      // startInner 失败」之后:原有消费者此刻没有 watcher。按恢复后的意图再收敛
      // 一次;这次也失败(挂载仍不可用)就走**带退避的重试** —— 只记日志会让原消费
      // 者静默失去直播,直到下一次显式 start / stop 或 daemon 重连(评审 P1)。
      void this.reconcile(workdir)
        .then(() => this.retryAttempts.delete(workdir))
        .catch((rerr) => {
          log.warn('watch reconcile after rollback failed', workdir, String(rerr));
          this.scheduleReconcileRetry(workdir);
        });
      throw err;
    }
  }

  /**
   * 收敛到「当前所有消费者的可见性并集」。为什么不直接 piggyback 启动中的
   * promise:启动窗口内到达的 stop 会给 stopDuringStart 打标记让那个 watcher
   * 自拆,而带新选项的 start 如果只是复用旧 promise,就会既丢掉新选项、又因为
   * 标记留下「没有 watcher」的空档(两个 RPC 都报 success)。这里每轮重读
   * desired,所以两种中途变化都在下一轮收敛。
   *
   * 终止性:每轮要么直接确认返回、要么推进一次真实的 startInner;desired 只会
   * 被更新的请求改写或被 stop 删除,并发调用者数量有限 —— 循环次数以此封顶。
   */
  private async reconcile(workdir: string): Promise<void> {
    for (;;) {
      const inflight = this.starting.get(workdir);
      if (inflight) {
        // 前一轮可能用了已被覆盖的旧选项,也可能因期间到来的 stop 自拆 ——
        // 都交给下一轮。它的失败由发起它的 caller 冒走,这里不吞也不重试。
        await inflight;
        continue;
      }
      const want = this.effectiveOptions(workdir);
      if (!want) {
        // 没有消费者了:watcher 不该活着。所有进入这里的路径(stop、回滚删掉
        // 最后一个消费者)都要维护这个不变量 —— 否则会留下没人再 stop 的孤儿
        // watcher(评审 P1 同类:回滚删注册后 fire-and-forget 的收敛不会再拆)。
        this.closeEntry(workdir);
        return;
      }
      const existing = this.entries.get(workdir);
      if (existing) {
        if (sameWatchOptions(existing, want)) return;
        // 选项变了:拆掉重建(不能走 stop(),它会撤销 desired)。重建前先转发
        // 合并窗口里的事件 —— 否则还在线的消费者会漏掉这一批(评审 P2)。
        this.closeEntry(workdir, { flushPending: true });
      }
      const run = this.startInner(workdir, want);
      this.starting.set(workdir, run);
      try {
        await run;
      } finally {
        this.starting.delete(workdir);
        this.stopDuringStart.delete(workdir);
      }
    }
  }

  /**
   * 全部消费者的可见性并集:任一消费者要看被忽略目录 / `.meta`,watcher 就得
   * 放行它们(推给各订阅端后由各自的视图忽略)。没有消费者时返回 null。
   */
  private effectiveOptions(workdir: string): WatchFilterOptions | null {
    const consumers = this.desired.get(workdir);
    if (!consumers || consumers.size === 0) return null;
    let showIgnoredDirs = false;
    let showMetaFiles = false;
    for (const intent of consumers.values()) {
      if (intent.options.showIgnoredDirs) showIgnoredDirs = true;
      if (!intent.options.hideMetaFiles) showMetaFiles = true;
    }
    return { showIgnoredDirs, hideMetaFiles: !showMetaFiles };
  }

  /**
   * watcher 报错后的收敛重试(退避封顶,不设总上限)。
   *
   * 为什么不能只 catch 一下:错误把 entry 拆掉后,如果紧接着的 reconcile 又失败
   * (远程挂载短暂不可用 / 目录正在被替换),消费者意图仍留在 desired、但已经
   * 没有 watcher,也没有任何定时器会再来收敛 —— SSH 连接没断的情况下,后续文件
   * 事件会永久停止,直到用户改开关或重挂载面板(评审 P2)。退避避免持续失败时
   * 形成紧密重建循环。
   *
   * 为什么退避到顶还要继续:挂载 / 权限故障持续超过退避窗口(约 15.5s)在真实
   * 环境里很常见(扩容挂载、目录正在被替换),此时不能永久放弃 —— 意图还在,
   * watcher 就必须最终建回来,否则故障恢复后事件永久静默、只能靠重挂面板救
   * (评审 P1)。封顶后按固定频率重试,单次只做一次 matcher 加载 + fs.watch,
   * 代价可忽略;消费者撤销由 clearReconcileRetry / stopAll 结束这个循环。
   */
  private scheduleReconcileRetry(workdir: string): void {
    if (this.retryTimers.has(workdir)) return;
    if (!this.desired.has(workdir)) return; // 期间消费者全撤了:不再重试
    const attempt = (this.retryAttempts.get(workdir) ?? 0) + 1;
    // 计数封顶:延迟计算不会越界,超限后转为固定频率重试。
    const capped = Math.min(attempt, RECONCILE_RETRY_BACKOFF_CAP);
    this.retryAttempts.set(workdir, capped);
    if (attempt === RECONCILE_RETRY_BACKOFF_CAP + 1) {
      log.warn('watch reconcile still failing, retrying at capped backoff', workdir);
    }
    const delay = Math.min(
      RECONCILE_RETRY_BASE_MS * 2 ** (capped - 1),
      RECONCILE_RETRY_MAX_MS,
    );
    const timer = setTimeout(() => {
      this.retryTimers.delete(workdir);
      void this.reconcile(workdir)
        .then(() => this.retryAttempts.delete(workdir))
        .catch((err) => {
          log.warn('watch reconcile retry failed', workdir, String(err));
          this.scheduleReconcileRetry(workdir);
        });
    }, delay);
    timer.unref?.();
    this.retryTimers.set(workdir, timer);
  }

  /** 清掉某个 workdir 的重试状态(stop / 新 start 成功时调用)。 */
  private clearReconcileRetry(workdir: string): void {
    const timer = this.retryTimers.get(workdir);
    if (timer) {
      clearTimeout(timer);
      this.retryTimers.delete(workdir);
    }
    this.retryAttempts.delete(workdir);
  }

  private async startInner(workdir: string, opts: WatchFilterOptions): Promise<void> {
    const matcher = await loadIgnoreMatcher(workdir, {
      hideMetaFiles: opts.hideMetaFiles,
      honorVcsIgnore: false,
      showIgnoredDirs: opts.showIgnoredDirs,
    });

    const entry: WatchEntry = {
      watcher: null as unknown as FSWatcher,
      matcher,
      hideMetaFiles: opts.hideMetaFiles,
      showIgnoredDirs: opts.showIgnoredDirs,
      pending: new Map(),
      flushTimer: null,
    };
    const watcher = fsWatch(workdir, { recursive: true }, (eventType, filename) => {
      // filename 偶发 null(平台边缘情况),无法定位目标 — 丢弃,聚焦刷新兜底。
      if (!filename) return;
      void this.handleRaw(workdir, entry, eventType, filename.toString());
    });
    watcher.on('error', (err) => {
      // watcher 挂了(权限 / 目录被删):拆掉**这个** entry,保留消费者意图并按
      // 剩余并集重建。不能走 stop(workdir) —— 那要挑一个 consumerId,而错误不是
      // 任何消费者的意图变化:拿默认 id 会删错人,reconcile 又看到同一个坏
      // entry 选项没变而原地返回,直播就静默冻结到手动改开关或 daemon 重启。
      log.warn('fs.watch error, dropping watcher', workdir, String(err));
      if (this.entries.get(workdir) !== entry) return; // 已被替换 / 停止:不碰新 entry
      // 报错前已入队的事件仍是真实事件:重建前先转发,不随旧 entry 丢弃(评审 P2)。
      this.closeEntry(workdir, { flushPending: true });
      // 就地收敛;失败(挂载短暂不可用 / 目录正在被替换)则带退避重试,直到成功
      // 或耗尽 —— 只记日志会让这个入口静默失效到用户改开关(评审 P2)。
      void this.reconcile(workdir)
        .then(() => this.retryAttempts.delete(workdir))
        .catch((rerr) => {
          log.warn('watch reconcile after error failed', workdir, String(rerr));
          this.scheduleReconcileRetry(workdir);
        });
    });
    entry.watcher = watcher;
    if (this.stopDuringStart.delete(workdir)) {
      // 启动期间来了 stop(调用方的登记已清,不会再发第二次 stop):当场拆掉。
      // 标记的清理归 reconcile 的 finally(成功 / 失败两条路径都走那里)。
      try {
        watcher.close();
      } catch {
        // already closed
      }
      log.info('watch start cancelled by stop during startup', workdir);
      return;
    }
    this.entries.set(workdir, entry);
    log.info('watch started', workdir);
  }

  stop(workdir: string, consumerId: string = WorkdirWatchManager.DEFAULT_CONSUMER): void {
    const consumers = this.desired.get(workdir);
    if (consumers) {
      consumers.delete(consumerId);
      if (consumers.size > 0) {
        // 还有别的消费者:按剩余并集收敛(可能收窄,需要重建 matcher)。这里是
        // sync 的 RPC handler,重建异步进行 —— RPC 语义是「撤销本消费者的
        // 需求」,不承诺 watcher 在返回前已重建完。失败要走带退避的**重试**:
        // 旧 watcher 此刻已经被拆了,只记日志会让剩下的消费者在挂载短暂不可用
        // 时永久失去实时事件,直到下一次显式 start / stop 或 daemon 重连
        // (评审 P2)。
        void this.reconcile(workdir)
          .then(() => this.retryAttempts.delete(workdir))
          .catch((err) => {
            log.warn('watch reconcile after partial stop failed', workdir, String(err));
            this.scheduleReconcileRetry(workdir);
          });
        return;
      }
      this.desired.delete(workdir);
    }
    this.clearReconcileRetry(workdir);
    // 撤销意图:收敛循环读到 desired 缺失即结束(piggyback 的新 start 会写回)。
    // 还在启动窗口:打标记让 startInner 完成时自拆(entries 里此刻还没有它)。
    if (this.starting.has(workdir)) this.stopDuringStart.add(workdir);
    this.closeEntry(workdir);
  }

  /** 把合并窗口里已经入队的事件立刻发出去（重建前保序转发用）。 */
  private flushPending(entry: WatchEntry): void {
    if (entry.flushTimer) {
      clearTimeout(entry.flushTimer);
      entry.flushTimer = null;
    }
    if (entry.pending.size === 0) return;
    const batch = [...entry.pending.values()];
    entry.pending.clear();
    for (const evt of batch) this.emit(evt);
  }

  /**
   * 拆掉已就位的 watcher。不碰 desired —— 选项变化重建时由调用方决定意图。
   *
   * `flushPending`：**重建**路径（选项变化 / watcher 报错后重建）要先转发合并
   * 窗口里的事件 —— 旧 entry 的 `pending` 随 entry 一起被丢的话，还活着的消费者
   * 会漏掉这次事件，文件树陈旧到同目录下一次事件或手动刷新（评审 P2）。
   * 最后一个消费者停止 / stopAll 不带这个旗标：那时事件已无人消费，直接丢。
   */
  private closeEntry(workdir: string, opts?: { flushPending?: boolean }): void {
    const entry = this.entries.get(workdir);
    if (!entry) return;
    this.entries.delete(workdir);
    if (opts?.flushPending) this.flushPending(entry);
    else if (entry.flushTimer) clearTimeout(entry.flushTimer);
    try {
      entry.watcher.close();
    } catch {
      // already closed
    }
    log.info('watch stopped', workdir);
  }

  stopAll(): void {
    // 全部意图撤销:启动中的 workdir 也要让收敛循环看到「没有 desired」而结束。
    this.desired.clear();
    for (const timer of this.retryTimers.values()) clearTimeout(timer);
    this.retryTimers.clear();
    this.retryAttempts.clear();
    for (const workdir of [...this.starting.keys()]) this.stopDuringStart.add(workdir);
    for (const workdir of [...this.entries.keys()]) this.closeEntry(workdir);
  }

  private async handleRaw(
    workdir: string,
    entry: WatchEntry,
    eventType: string,
    rawFilename: string,
  ): Promise<void> {
    const relPath = rawFilename.split(path.sep).join('/');
    if (relPath === '' || relPath.startsWith('..')) return;
    if (relPath.endsWith(XDT_TMP_SUFFIX)) return;
    /** matcher 不知道路径是 file 还是 dir,双查任一命中即丢(同 desktop watcher)。 */
    if (entry.matcher.ignores(relPath, false) && entry.matcher.ignores(relPath, true)) return;
    // 开关打开也永远不推的目录(node_modules / Library):只丢**内部**事件,
    // 目录自身的生命周期事件要留(见 isInsideAlwaysIgnoredDir)。
    if (isInsideAlwaysIgnoredDir(relPath)) return;
    // 兜底:BUILTIN_IGNORE_ALWAYS(.git / .DS_Store 之类,自身与后代都不显示)。
    // 但恒真忽略目录自身已在上一行放行,不能再被这里拦下。
    if (!isAlwaysIgnoredDirItself(relPath) && eventAlwaysIgnore.ignores(relPath, true)) return;

    let type: RemoteFileTreeEvent['type'];
    if (eventType === 'change') {
      type = 'change';
    } else {
      // 'rename' = add 或 unlink,lstat 判存在性。
      try {
        await fs.lstat(path.join(workdir, relPath));
        type = 'add';
      } catch {
        type = 'unlink';
      }
    }
    this.enqueue(entry, { workdir, type, relPath });
  }

  private enqueue(entry: WatchEntry, event: RemoteFileTreeEvent): void {
    entry.pending.set(`${event.type}::${event.relPath}`, event);
    if (entry.flushTimer) return;
    entry.flushTimer = setTimeout(() => {
      entry.flushTimer = null;
      this.flushPending(entry);
    }, COALESCE_MS);
    entry.flushTimer.unref?.();
  }
}
