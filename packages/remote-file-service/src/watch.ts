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
    if ((WATCH_ALWAYS_IGNORE as readonly string[]).includes(segments[i])) return true;
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
  return (WATCH_ALWAYS_IGNORE as readonly string[]).includes(last);
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
  /** 每个 workdir 的消费者 → 该消费者的过滤需求。watcher 只此一份,选项取全部
   *  消费者的可见性并集(见 effectiveOptions);start() / stop() 每轮重读它收敛。 */
  private readonly desired = new Map<string, Map<string, WatchFilterOptions>>();

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
    const consumers = this.desired.get(workdir) ?? new Map<string, WatchFilterOptions>();
    const previous = consumers.get(consumerId);
    const attempted = normalizeWatchOptions(opts);
    consumers.set(consumerId, attempted);
    this.desired.set(workdir, consumers);
    try {
      await this.reconcile(workdir);
    } catch (err) {
      // 启动失败:回滚**本次**写入的意图,否则 daemon 会留下一个「幽灵消费者」——
      // 控制端的失败处理只清本地注册、不会再发 watchStop(见 remote-watch.ts),
      // 之后别的消费者的可见性并集会被它抬高,最后一人 stop 时还会因它留下
      // 孤儿 watcher(评审 P1)。只回滚仍然是自己这次写的那个值:并发的
      // stop + start 会把同一 consumerId 覆盖成新选项,那属于它的意图。
      const current = this.desired.get(workdir);
      if (current && current.get(consumerId) === attempted) {
        if (previous) current.set(consumerId, previous);
        else current.delete(consumerId);
        if (current.size === 0) this.desired.delete(workdir);
      }
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
      if (!want) return; // 期间所有消费者都 stop:意图已撤
      const existing = this.entries.get(workdir);
      if (existing) {
        if (sameWatchOptions(existing, want)) return;
        this.closeEntry(workdir); // 选项变了:拆掉重建(不能走 stop(),它会撤销 desired)
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
    for (const opts of consumers.values()) {
      if (opts.showIgnoredDirs) showIgnoredDirs = true;
      if (!opts.hideMetaFiles) showMetaFiles = true;
    }
    return { showIgnoredDirs, hideMetaFiles: !showMetaFiles };
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
      this.closeEntry(workdir);
      void this.reconcile(workdir).catch((rerr) =>
        log.warn('watch reconcile after error failed', workdir, String(rerr)),
      );
    });
    entry.watcher = watcher;
    if (this.stopDuringStart.delete(workdir)) {
      // 启动期间来了 stop(调用方的登记已清,不会再发第二次 stop):当场拆掉。
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
        // 需求」,不承诺 watcher 在返回前已重建完。失败只记日志:订阅端各自有
        // 重连 replay / 聚焦刷新兜底。
        void this.reconcile(workdir).catch((err) =>
          log.warn('watch reconcile after partial stop failed', workdir, String(err)),
        );
        return;
      }
      this.desired.delete(workdir);
    }
    // 撤销意图:收敛循环读到 desired 缺失即结束(piggyback 的新 start 会写回)。
    // 还在启动窗口:打标记让 startInner 完成时自拆(entries 里此刻还没有它)。
    if (this.starting.has(workdir)) this.stopDuringStart.add(workdir);
    this.closeEntry(workdir);
  }

  /** 拆掉已就位的 watcher。不碰 desired —— 选项变化重建时由调用方决定意图。 */
  private closeEntry(workdir: string): void {
    const entry = this.entries.get(workdir);
    if (!entry) return;
    this.entries.delete(workdir);
    if (entry.flushTimer) clearTimeout(entry.flushTimer);
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
      const batch = [...entry.pending.values()];
      entry.pending.clear();
      for (const evt of batch) this.emit(evt);
    }, COALESCE_MS);
    entry.flushTimer.unref?.();
  }
}
