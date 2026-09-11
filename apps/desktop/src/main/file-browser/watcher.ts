/**
 * Workdir File Browser — watcher 管理(经 watcher-host utility process)。
 *
 * Lifecycle: one watcher per (window × workdir) tuple. Started when the
 * renderer enters file-browse mode for a workdir, stopped when it leaves
 * (route change / window close). The renderer is the source of truth for
 * "still need this watcher" — main does not auto-start watchers based on
 * idle activity.
 *
 * 进程边界:@parcel/watcher 的 native subscribe/unsubscribe 全部发生在
 * watcher-host utility process 里(见 ../watcher-host/),main 侧只做簿记、
 * matcher 过滤与事件转发。背景:2026-07-07 Release 崩溃定位到快速切
 * session 时同一 workdir 的 unsubscribe→紧接 re-subscribe 窗口,native 层
 * 硬崩溃直接带走主进程(无 JS 异常、无 dump)。挪进子进程后同类崩溃只死
 * host,client 自动重启恢复。
 *
 * 抖动消除:renderer 的 useFileTree store 在 refCount 归零瞬间就发 stopWatch,
 * 切 session 时 React 先卸载旧面板再挂载新面板,同一 workdir 会被"拆了又建"
 * (旧日志实测 stop→start 间隔 ~10ms)。stop() 因此改为宽限期延迟执行:
 * 宽限内同 key 的 start() 直接复用现有订阅、取消 pending stop,native 层
 * 完全无感;宽限过后才真正 unsubscribe。同 key 的 native 操作全部经每 key
 * 串行队列,杜绝 unsubscribe 与 re-subscribe 交错。
 *
 * 过滤策略 (两层):
 *   1. subscribe 的 ignore 列表(绝对路径)— 预先剪掉 .git / node_modules /
 *      Library 这种"绝对不看"的大目录,让 OS watcher 根本不推这些事件。
 *   2. callback 内再过一次 .gitignore matcher, 处理 ignore 选项不支持的
 *      复杂 glob (e.g. *.log, build-*) — 与 listDir 路径共享同一份 matcher
 *      保证一致性。
 *
 * 与「显示被忽略的目录」(showIgnoredDirs)开关的关系:开关控制的是**是否把内置
 * 隐藏目录当普通目录对待**。打开后 matcher 不再躲藏 dist / build / Temp 这类目录,
 * 并且第 1 层预过滤也只保留 PREFILTER_ALWAYS(依赖与 Unity 资源缓存:原生 watch
 * 这些目录的代价是另一个量级,而且没有实时性需求)—— 即开关打开后,绝大部分被
 * 忽略目录里的改动会推事件;只有 node_modules / Library 内部仍不推。
 *
 * Event mapping: parcel's create/update/delete → 旧的 add/change/unlink。
 *   下游 (useFileTree / useFileContent) 不区分 file vs dir, 所以 'addDir' /
 *   'unlinkDir' 这两个旧 type 保留在 union 里但不再发出。
 */

import path from 'node:path';
import type { BrowserWindow } from 'electron';

import {
  loadIgnoreMatcher,
  WATCH_ALWAYS_IGNORE,
  XDT_TMP_SUFFIX,
  type Matcher,
} from '@cindy/file-browser-core';

import { createLogger } from '../logger.js';
import type { WatchedFsEvent } from '../watcher-host/protocol.js';
import type {
  WatcherHostSubscription,
  WatcherHostErrorHandler,
  WatcherHostEventsHandler,
} from '../watcher-host/WatcherHostClient.js';

const log = createLogger('file-browser/watcher');

export type FileTreeEventType =
  | 'add'
  | 'change'
  | 'unlink'
  | 'addDir'
  | 'unlinkDir';

export interface FileTreeEvent {
  workdir: string;
  type: FileTreeEventType;
  /** workdir-relative POSIX path */
  relPath: string;
}

/** 订阅函数抽象:默认走 watcher-host 单例,测试注入假实现。 */
export type WatcherSubscribeFn = (
  dir: string,
  ignore: string[],
  onEvents: WatcherHostEventsHandler,
  onError: WatcherHostErrorHandler,
) => Promise<WatcherHostSubscription>;

/**
 * 默认订阅实现。动态 import 保证本模块在单测环境可加载(watcher-host/index
 * 顶层 import electron;运行时 main 进程首次 start 时才真正加载)。
 */
const defaultSubscribeFn: WatcherSubscribeFn = async (dir, ignore, onEvents, onError) => {
  const { watcherHostClient } = await import('../watcher-host/index.js');
  return watcherHostClient.subscribe(dir, ignore, onEvents, onError);
};

/**
 * stop 宽限期:renderer 切 session 造成的同 key stop→start 抖动实测在
 * 数十 ms 量级,1.5s 给足余量;真正关闭文件面板时多挂 1.5s watcher 的代价
 * 可忽略(事件继续被 matcher / isDestroyed 守卫拦住)。
 */
const STOP_GRACE_MS = 1500;

interface WatcherEntry {
  /** 订阅句柄;starting 完成前为 null。 */
  handle: WatcherHostSubscription | null;
  matcher: Matcher;
  hideMetaFiles: boolean;
  /** 建订阅时生效的「显示被忽略的目录」开关;变了走完整重建。 */
  showIgnoredDirs: boolean;
  /**
   * 间接引用:订阅回调通过此字段路由事件,宽限期复活时 start() 更新引用
   * 即可让新组件实例收到事件,无需触碰 native 订阅。
   */
  onEvent: (event: FileTreeEvent) => void;
  /** 'active' 正常运行;'stop-scheduled' 宽限期倒计时中(start 可复活)。 */
  state: 'active' | 'stop-scheduled';
  /** 宽限期定时器;仅 state === 'stop-scheduled' 时非 null。 */
  graceTimer: ReturnType<typeof setTimeout> | null;
}

/**
 * 预过滤目录 — 这些目录名一旦出现在路径里, OS watcher 直接跳过,不再向
 * callback 推任何事件。和 ignore.ts 的 BUILTIN_IGNORE 思路一致。比靠
 * callback 内过滤省一次 IPC + 一次 matcher 调用。
 *
 * 注意: 这里只剪"目录名命中" 的 case; *.log / build-* 这种 glob 仍由
 * callback 内的 matcher 兜底。
 *
 * ALWAYS 是"即使开关打开也不看"的目录:.git 与 OS 垃圾之外,只有
 * node_modules / Library —— 它们要么条目数十万、要么需要真正的依赖分析,
 * 原生递归 watch 的代价与收益不成比例(开关打开时它们会出现在文件树里,但
 * 内部改动不推事件,手动刷新可见)。其余目录随「显示被忽略的目录」放行。
 *
 * node_modules / Library 的名单单源在 file-browser-core 的 WATCH_ALWAYS_IGNORE
 * ——远端 daemon 的事件过滤吃同一份,两侧不会各自漂移。
 */
const PREFILTER_ALWAYS: string[] = ['.git', '.svn', '.hg', ...WATCH_ALWAYS_IGNORE];

const PREFILTER_REVEALABLE = [
  'Temp', // Unity
  'Logs', // Unity
  'obj', // .NET
  'bin', // .NET (粒度可能误伤; .gitignore matcher 兜底就行)
  '.vs',
  '.idea',
  'dist',
  'build',
  '.next',
  '.turbo',
];

/**
 * 名单 → parcel ignore glob。
 *
 * @parcel/watcher 的 ignore 数组吃两种形态:非 glob 走 `ignorePaths`(相对
 * workdir resolve 成绝对路径,**前缀**比较),glob 走 picomatch 正则。前缀形态
 * 只认“工作区根下直接命中”—— 实测(2.5.6, win32)`nested/node_modules/x` 不是
 * `/workdir/node_modules` 的后代,一条事件都拦不住,monorepo
 * (`packages/foo/node_modules`)与嵌套 Unity 工程(`client/Library`)全量漏过去。
 * 所以统一发 glob:`**\/<name>/**` 覆盖任意层级。
 *
 * 末尾的 `/**` 不能省:目录名要连内部条目一起匹配,`**\/<name>` 只匹配目录自身
 * (实测)。将来名单里若出现文件项(如 .DS_Store),要另用不带后缀的形态。
 */
const ignoreGlobsForDirs = (names: readonly string[]): string[] =>
  names.map((name) => `**/${name}/**`);

function buildIgnoreList(opts: { showIgnoredDirs: boolean }): string[] {
  // ALWAYS 名单**无条件注册**,不做存在性探测:parcel 的 ignore 只在
  // subscribe 那一刻生效一次,而 node_modules / Library 常常在会话开始后才出现
  // (npm install / Unity 导入)。当时不存在就漏掉,就再也没有第二次机会 ——
  // 开关打开时这些目录被 matcher 放行,目录里每个生成路径都会一路推过
  // watcher-host + IPC。glob 不存在的目录只是永不命中,无副作用。
  const always = ignoreGlobsForDirs(PREFILTER_ALWAYS);
  // REVEALABLE 只在开关关闭时预过滤:开关打开后它们本来就该推事件;关闭时
  // 即使漏掉预过滤,callback 里的 matcher 也会拦下(代价只是多一次 IPC)。
  return opts.showIgnoredDirs
    ? always
    : [...always, ...ignoreGlobsForDirs(PREFILTER_REVEALABLE)];
}

/**
 * Multiplexes watchers by `${windowId}::${workdir}`. Lookup is O(1); the
 * Map is GC-friendly since entries clear themselves on stop().
 */
export class WatcherManager {
  private readonly entries = new Map<string, WatcherEntry>();
  /** 每 key 的操作串行链:同 key 的 subscribe/unsubscribe 绝不交错。 */
  private readonly chains = new Map<string, Promise<void>>();
  private readonly subscribeFn: WatcherSubscribeFn;

  constructor(subscribeFn: WatcherSubscribeFn = defaultSubscribeFn) {
    this.subscribeFn = subscribeFn;
  }

  private key(windowId: number, workdir: string): string {
    return `${windowId}::${workdir}`;
  }

  /** 把一个操作追加到该 key 的串行链上(前序失败不阻断后续)。 */
  private enqueue(k: string, op: () => Promise<void>): Promise<void> {
    const prev = this.chains.get(k) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(op);
    this.chains.set(k, next);
    // 注意:Promise.prototype.finally() 会继承 next 的 rejected 状态,直接 void
    // 会制造未处理 rejection。这里用 then 的双分支只做清理,不传播错误。
    void next.then(
      () => {
        if (this.chains.get(k) === next) this.chains.delete(k);
      },
      () => {
        if (this.chains.get(k) === next) this.chains.delete(k);
      },
    );
    return next;
  }

  /**
   * Start watching `workdir` for `window`. Idempotent: a second start() with
   * the same key reuses the existing entry (including one in stop-grace,
   * which gets revived without touching native at all).
   *
   * `onEvent` is called for every change after subscribe() resolves; the
   * watcher manager does NOT batch — parcel already coalesces native events
   * per-tick into the events[] array forwarded by the host.
   */
  async start(
    window: BrowserWindow,
    workdir: string,
    opts: { hideMetaFiles?: boolean; showIgnoredDirs?: boolean },
    onEvent: (event: FileTreeEvent) => void,
  ): Promise<void> {
    const k = this.key(window.id, workdir);
    const hideMetaFiles = opts.hideMetaFiles ?? true;
    const showIgnoredDirs = opts.showIgnoredDirs === true;
    await this.enqueue(k, async () => {
      const existing = this.entries.get(k);
      if (existing) {
        if (existing.state === 'stop-scheduled') {
          // 宽限期复活:取消 pending stop,native 层零操作
          if (existing.graceTimer) clearTimeout(existing.graceTimer);
          existing.graceTimer = null;
          existing.state = 'active';
          log.debug(`watcher revived within stop grace: ${k}`);
        }
        // 更新事件回调引用:即使 native 订阅不变,新的 start() 调用方可能绑定了
        // 不同的 onEvent 上下文(如不同组件实例);通过 entry.onEvent 间接路由保证
        // 新调用方能收到后续事件。
        existing.onEvent = onEvent;
        if (
          existing.hideMetaFiles === hideMetaFiles &&
          existing.showIgnoredDirs === showIgnoredDirs
        ) {
          return;
        }
        // 过滤选项变了:走完整重建(先拆后建,串行链保证不交错)
        await this.doStop(k, { onlyIfScheduled: false });
      }
      await this.doStart(window, workdir, k, hideMetaFiles, showIgnoredDirs, onEvent);
    });
  }

  /**
   * 请求停止。不立即 unsubscribe —— 进入 STOP_GRACE_MS 宽限期,期间同 key
   * 的 start() 会直接复活;宽限过后才真正拆订阅。
   */
  async stop(windowId: number, workdir: string): Promise<void> {
    const k = this.key(windowId, workdir);
    await this.enqueue(k, () => this.scheduleStop(k));
  }

  private async scheduleStop(k: string): Promise<void> {
    const entry = this.entries.get(k);
    if (!entry || entry.state === 'stop-scheduled') return;
    entry.state = 'stop-scheduled';
    entry.graceTimer = setTimeout(() => {
      entry.graceTimer = null;
      void this.enqueue(k, () => this.doStop(k, { onlyIfScheduled: true }));
    }, STOP_GRACE_MS);
    entry.graceTimer.unref?.();
  }

  async stopAllForWindow(windowId: number): Promise<void> {
    const prefix = `${windowId}::`;
    const targets = [...this.entries.keys()].filter((k) => k.startsWith(prefix));
    for (const k of targets) {
      const wd = k.slice(prefix.length);
      await this.stop(windowId, wd);
    }
  }

  private async doStart(
    window: BrowserWindow,
    workdir: string,
    k: string,
    hideMetaFiles: boolean,
    showIgnoredDirs: boolean,
    onEvent: (event: FileTreeEvent) => void,
  ): Promise<void> {
    if (this.entries.has(k)) {
      log.debug(`watcher already running for ${k}`);
      return;
    }
    const matcher = await loadIgnoreMatcher(workdir, {
      hideMetaFiles,
      honorVcsIgnore: false,
      showIgnoredDirs,
    });
    const ignore = buildIgnoreList({ showIgnoredDirs });

    const entry: WatcherEntry = {
      handle: null,
      matcher,
      hideMetaFiles,
      showIgnoredDirs,
      onEvent,
      state: 'active',
      graceTimer: null,
    };

    const startedAt = Date.now();
    let handle: WatcherHostSubscription;
    try {
      handle = await this.subscribeFn(
        workdir,
        ignore,
        (events: WatchedFsEvent[]) => {
          if (window.isDestroyed()) return;
          // 宽限期内事件照常转发(订阅仍活着);entry 被真正拆掉后 host 端
          // 订阅同步消失,不会有迟到事件。
          for (const event of events) {
            const rel = path.relative(workdir, event.path).replace(/\\/g, '/');
            if (rel === '' || rel.startsWith('..')) continue;
            // 原子写中间产物 — writeFile 创建 / rename 删除 .xdt-tmp 都会被
            // OS 推上来,前端看到 add+unlink 一闪而过的 ghost row。listDir 也
            // 同步过滤;这里阻断在 IPC 边界,避免触发不必要的 fetchDir。
            if (rel.endsWith(XDT_TMP_SUFFIX)) continue;
            // .gitignore matcher 兜底:目录命中已被 ignore 列表剪掉, 这里主要
            // 拦 *.log / build-output-* 这种 glob。matcher.ignores 不知道路径
            // 是 file 还是 dir, 双调用任一命中即丢。
            if (entry.matcher.ignores(rel, false) && entry.matcher.ignores(rel, true)) continue;
            let type: FileTreeEventType;
            switch (event.type) {
              case 'create':
                type = 'add';
                break;
              case 'update':
                type = 'change';
                break;
              case 'delete':
                type = 'unlink';
                break;
              default:
                continue;
            }
            entry.onEvent({ workdir, type, relPath: rel });
          }
        },
        (message) => {
          log.error(`watcher error for ${k}: ${message}`);
        },
      );
    } catch (err) {
      log.error(`failed to subscribe ${k}:`, err);
      throw err;
    }

    entry.handle = handle;
    this.entries.set(k, entry);

    // Window closed → tear down (covers refresh / quit without explicit stop)
    const cleanup = () => {
      void this.stop(window.id, workdir);
    };
    window.once('closed', cleanup);

    log.info(
      `watcher started: ${k} via=watcher-host subscribe=${Date.now() - startedAt}ms ignorePrefilter=${ignore.length}`,
    );
  }

  /**
   * 真正拆订阅。onlyIfScheduled=true 是宽限期定时器路径:入队后若 entry 已被
   * start() 复活(state 回到 active),本次 stop 作废;false 是 opts 变化的
   * 强制重建路径,无视状态直接拆。
   */
  private async doStop(k: string, opts: { onlyIfScheduled: boolean }): Promise<void> {
    const entry = this.entries.get(k);
    if (!entry) return;
    if (opts.onlyIfScheduled && entry.state !== 'stop-scheduled') return;
    this.entries.delete(k);
    if (entry.graceTimer) clearTimeout(entry.graceTimer);
    try {
      await entry.handle?.unsubscribe();
      log.info(`watcher stopped: ${k}`);
    } catch (err) {
      log.warn(`watcher close failed for ${k}:`, err);
    }
  }
}

/** Module-level singleton — one manager for the whole main process. */
export const watcherManager = new WatcherManager();
