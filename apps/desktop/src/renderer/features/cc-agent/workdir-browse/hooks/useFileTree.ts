/**
 * useFileTree — workdir file tree state + main-process integration.
 *
 * Lazy expansion model:
 *   - Tree is a Map<relPath, DirEntry[]> keyed by parent folder relative path.
 *     '' (empty string) = workdir root. Sub-folders only get listed when
 *     toggled open by the user.
 *   - `expanded: Set<string>` tracks which folders are open (also keyed by
 *     relPath; '' is always open implicitly).
 *
 * chokidar push events:
 *   - 'add'/'unlink'/'change' on a file at relPath X → invalidate the dir
 *     containing X by re-listing it (cheap, <12ms even for huge folders).
 *   - 'addDir'/'unlinkDir' similarly.
 *   - The watcher is started on first mount per (workdir, options), stopped
 *     on last unmount (ref-counted).
 *
 * Selection (which file is open in the body view) is intentionally NOT here;
 * it lives in caller (URL search param ?file= for doc mode, plugin state for
 * RSB file-browser tabs).
 *
 * The hook is NOT generic — it's specifically tied to electronAPI.fileBrowser.*
 * IPC. If we ever need a non-electron build this hook becomes the seam.
 *
 * ── 共享 store 设计(2026-07-01) ─────────────────────────────────────────────
 * 早期 useFileTree 是 per-instance React state——同一 workdir 的多个 caller
 * (doc 模式 sidebar / 多个 RSB file-browser tab)各自持一份 entries / expanded /
 * loadingPaths,toggle 一个目录不会同步到其它 caller,反直觉。
 *
 * 现在改成模块级 store(stores Map<key, FileTreeStore>),按 `workdir + 配置`
 * 分片。所有 useFileTree({workdir, ...}) 共享同一份 state——任何 caller
 * toggle / collapseAll / refresh / expandToPath 都立刻反映到所有订阅者(useSyncExternalStore)。
 *
 * 生命周期:
 *   - 首个挂载触发 init(initial listDir root + 恢复 expanded localStorage +
 *     启动 chokidar watcher)
 *   - refCount 归 0 时触发 cleanup(stopWatch + 从 stores Map 移除)
 *   - 切 workdir / 卸载组件 → refCount-- → 视情况 cleanup
 *
 * watcher / IPC token 等"非 React state"挂在 FileTreeStore 自身,
 * 不进 React state,避免 setState 触发不必要的订阅者重渲。
 */

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';

import { createLogger } from '@/lib/logger';
import { useDeviceLinkReconnectEpoch } from '@/features/device-link/useDeviceLinkReconnectEpoch';
import {
  deviceSupportsRevealIgnoredDirs,
  fileBrowserApiFor,
  isDeviceTooOldError,
  onFileTreeEventFor,
  startWatchFor,
  stopWatchFor,
} from '@/lib/fileBrowserTransport';
import { loadExpandedSet, saveExpandedSet } from '../lib/expandedStore';

const log = createLogger('useFileTree');

export interface DirEntry {
  name: string;
  relPath: string;
  type: 'file' | 'directory';
  size: number;
  mtimeMs: number;
}

interface UseFileTreeOptions {
  workdir: string;
  /**
   * 非空 = SSH remote 会话:listDir 经 main 路由到远端 file-service;
   * 本地 watcher 不启动(远端暂无 watch,P4 计划事件推回),树的时效性靠
   * refresh() 手动/聚焦刷新兜底。
   */
  remoteHostId?: string | null;
  /**
   * 非空 = device-link 远程会话(被控设备):全部操作经隧道在被控端执行,
   * watch 走 fs-watch topic 订阅。与 remoteHostId 互斥(嵌套时 deviceId 优先,
   * SSH 二跳由被控端处理)。
   */
  deviceId?: string | null;
  /** default true — Unity .meta files cut ~47% of typical entries */
  hideMetaFiles?: boolean;
  /**
   * Doc mode: only doc/config text files (md/txt/json/yaml/...); only
   * directories with at least one such descendant. Filtering happens in
   * main; watcher events trigger refetch of the full ancestor chain (a
   * new/deleted doc file can change which dirs appear at any depth above).
   */
  docMode?: boolean;
  /**
   * 用户开关「显示被忽略的目录」:列出依赖 / 构建产物 / 缓存目录
   * (build / dist / out / node_modules / Library ...)。
   *
   * 进 store key:切换开关会换一份 store(listDir 与 watcher 都用新 matcher
   * 重建),已展开目录的缓存在新 store 里重建。
   */
  showIgnoredDirs?: boolean;
}

export interface UseFileTreeReturn {
  /** Entries per folder, keyed by relPath ('' = root). */
  entries: ReadonlyMap<string, readonly DirEntry[]>;
  /** Set of expanded folder relPaths. '' (root) is always expanded implicitly. */
  expanded: ReadonlySet<string>;
  /** Folder paths still loading (after expand). */
  loadingPaths: ReadonlySet<string>;
  /** True until the root listDir() call returns the first time. */
  initialLoading: boolean;
  /** root 加载失败标记(device-too-old = 对方设备版本过旧);见 store 注释。 */
  loadError: 'device-too-old' | 'load-failed' | null;
  /**
   * 「显示被忽略的目录」在当前会话是否真的生效:
   *   - true  本地 / SSH / 支持该字段的被控端;
   *   - false device-link 连到老 Desktop —— 它的 listDir 静默忽略这个字段,
   *           开关看起来按下去了、树里什么也不变;
   *   - null  device 会话首帧,能力探测还没回来(非 device 会话恒为 true)。
   * 标题行据此把开关渲染成不可用 + 说明原因;树本身在 false 时已经按隐藏态
   * 建 store(不向老端发一个无效字段)。
   */
  showIgnoredDirsSupported: boolean | null;

  toggleFolder: (relPath: string) => void;
  /** Collapse every folder back to root. Also clears persisted state. */
  collapseAll: () => void;
  refresh: () => Promise<void>;
  /**
   * 展开 relPath 的所有祖先目录(让该文件可见),触发未 cache 的目录 lazy fetch,
   * 返回 Promise 等所有 listDir 完成。
   *
   * 用于"筛选文件 / 搜索 / 跳转"等需要把目标��件在树里露出来的场景 —— 上层调
   * 完 expandToPath 再 scrollIntoView 那一行,visual 节奏稳。
   *
   * Root 文件(relPath 不含 '/')直接 no-op return —— 它已经在根级,无需展开。
   */
  expandToPath: (relPath: string) => Promise<void>;
}

const ROOT_KEY = '';
const EVENT_COALESCE_MS = 50;

/**
 * 结构等价判定 —— name/type/relPath 完全相同(顺序也相同, listDir 是稳定排序),
 * 只有 mtime/size 变化时返回 true。
 *
 * 用途:setEntries 前的去重。chokidar/parcel 对我们自己 writeFile 的原子 rename
 * 也会推 change 事件 → 触发 fetchDir 拿到一组对象引用全新但内容结构没变的
 * DirEntry[]。如果直接 setEntries(new Map)会让 flattenTree useMemo 重算 +
 * 所有 FileTreeRow 重渲, 视觉上"刷一下"。
 *
 * 当前所有 entries 消费者(FileTreeView, WorkdirBrowseSidebar.findEntryByRelPath)
 * 都不读 mtime/size, 所以跳过更新无功能影响。如果未来加了"按 mtime 排序"
 * / "显示文件大小"之类的 UI, 这里要相应放宽比较。
 */
function entriesStructurallyEqual(
  a: readonly DirEntry[],
  b: readonly DirEntry[],
): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (x.relPath !== y.relPath) return false;
    if (x.name !== y.name) return false;
    if (x.type !== y.type) return false;
  }
  return true;
}

/**
 * 模块级共享 store。
 *
 * snapshot 字段是给 useSyncExternalStore 返回的稳定 readonly 视图(immutable
 * 引用,变化时整体替换),React 据此判断是否触发重渲。其余字段是 store 自管的
 * 非 React state(IPC token / watcher off / listener set / refCount)。
 *
 * 任何 mutation 必须 (a) new 一个新的 snapshot 对象 (b) 调 emit() 通知订阅者。
 */
interface FileTreeStore {
  readonly key: string;
  readonly workdir: string;
  readonly remoteHostId: string | null;
  readonly deviceId: string | null;
  readonly hideMetaFiles: boolean;
  readonly docMode: boolean;
  readonly showIgnoredDirs: boolean;
  snapshot: {
    entries: ReadonlyMap<string, readonly DirEntry[]>;
    expanded: ReadonlySet<string>;
    loadingPaths: ReadonlySet<string>;
    initialLoading: boolean;
    /**
     * root listDir 失败的稳定错误标记:'device-too-old' = 对方设备版本过旧
     * (老被控端无 remote-op channel);'load-failed' = 其它失败。非 null 时
     * FileBrowserBody 渲染错误占位而不是永远空树。
     */
    loadError: 'device-too-old' | 'load-failed' | null;
  };
  /** 同一 relPath 的并发 listDir,latest 赢:每次开 listDir 前 bump,resolve
   *  时比对 —— 不一致就丢结果。 */
  tokens: Map<string, number>;
  /** Single-flight directory requests plus one dirty bit for a trailing scan. */
  inFlight: Map<string, DirectoryRefresh>;
  /** Parent directories observed by the IPC listener in the current turn. */
  pendingEventParents: Set<string>;
  eventFlushTimer: ReturnType<typeof setTimeout> | null;
  /** chokidar listener 取消函数。首个挂载时挂、refCount 归 0 时调。 */
  watcherOff: (() => void) | null;
  /** ref count + listeners 用来驱动 lifecycle 和重渲订阅。 */
  refCount: number;
  listeners: Set<() => void>;
}

interface DirectoryRefresh {
  promise: Promise<void>;
  trailing: boolean;
  /** At most one trailing scan may be queued for this refresh lifecycle. */
  trailingScheduled: boolean;
}

/** 全局 stores 表。key 由 storeKey() 算,同 (workdir, options) 共享同一份。 */
const stores = new Map<string, FileTreeStore>();

function storeKey(opts: Required<UseFileTreeOptions>): string {
  const remote = opts.remoteHostId ? `::remote=${opts.remoteHostId}` : '';
  const device = opts.deviceId ? `::device=${opts.deviceId}` : '';
  const reveal = opts.showIgnoredDirs ? '::reveal' : '';
  return `${opts.workdir}::doc=${opts.docMode}::hideMeta=${opts.hideMetaFiles}${reveal}${remote}${device}`;
}

function emit(store: FileTreeStore): void {
  for (const l of store.listeners) l();
}

/**
 * 切换「显示被忽略的目录」会换一份 store(key 含 reveal 位),新 store 若从
 * 空快照 + initialLoading 起步,FileTreeView 会把整棵树替换成占位(本地
 * <300ms 连 spinner 都没有,就是空白),视觉上闪一下;同一 workdir 的另一半
 * reveal scope 的 store 此刻通常还在表里 —— 旧 store 的 refCount 归零发生在
 * 本次 commit 的 effect cleanup,晚于 render 期间的 useMemo —— 借它的
 * **根目录列表**当首帧内容,新 matcher 的 listDir 回来后再原地校正。
 *
 * 只借根列表,不借子树缓存与 expanded:那两者都带旧 matcher 的语义。reveal 态
 * 展开过 node_modules 时,把它们带进 hidden store 会让被忽略路径进入展开集合与
 * warm 列表(hidden 侧会给它们发 listDir,SSH 上可达数百个 RPC),并在根列表
 * 回来前把被忽略的行显示出来。展开态仍按各自 scope 从 localStorage 恢复
 * (expandedStore 的分片本意),不跨 scope 合并。
 *
 * 「刷新」按钮没有这个问题:它在同一份 store 上原地 refetch,从不经过空态。
 */
function findRevealSiblingSeed(opts: Required<UseFileTreeOptions>): {
  rootEntries: readonly DirEntry[] | null;
  loadError: FileTreeStore['snapshot']['loadError'];
} | null {
  const siblingKey = storeKey({ ...opts, showIgnoredDirs: !opts.showIgnoredDirs });
  const sibling = stores.get(siblingKey);
  if (!sibling) return null;
  return {
    rootEntries: sibling.snapshot.entries.get(ROOT_KEY) ?? null,
    loadError: sibling.snapshot.loadError,
  };
}

function getOrCreateStore(opts: Required<UseFileTreeOptions>): FileTreeStore {
  const key = storeKey(opts);
  const existing = stores.get(key);
  if (existing) return existing;
  // 切开关路径:借另一半 reveal scope 的根列表,第一帧就有内容可渲染,不经过
  // initialLoading 空白;首次挂载(无兄弟 store)仍走原来的 loading 路径。
  const seed = findRevealSiblingSeed(opts);
  const store: FileTreeStore = {
    key,
    workdir: opts.workdir,
    remoteHostId: opts.remoteHostId,
    deviceId: opts.deviceId,
    hideMetaFiles: opts.hideMetaFiles,
    docMode: opts.docMode,
    showIgnoredDirs: opts.showIgnoredDirs,
    snapshot: seed
      ? {
          entries: seed.rootEntries ? new Map([[ROOT_KEY, seed.rootEntries]]) : new Map(),
          expanded: new Set([ROOT_KEY]),
          // 新 store 自己还没有 in-flight 请求,seed 的 loadingPaths 不继承。
          loadingPaths: new Set(),
          initialLoading: false,
          // 错误态一并继承:首帧直接是错误占位,而不是先闪一帧空树再变错误。
          loadError: seed.loadError,
        }
      : {
          entries: new Map(),
          expanded: new Set([ROOT_KEY]),
          loadingPaths: new Set(),
          initialLoading: true,
          loadError: null,
        },
    tokens: new Map(),
    inFlight: new Map(),
    pendingEventParents: new Set(),
    eventFlushTimer: null,
    watcherOff: null,
    refCount: 0,
    listeners: new Set(),
  };
  stores.set(key, store);
  return store;
}

/** 把 fetchDir 抽成 store 方法 —— 所有订阅者(无论挂在哪个 hook 实例)共享同
 *  一份 entries / loadingPaths 状态。 */
async function fetchDirOnce(store: FileTreeStore, relPath: string): Promise<void> {
  const myToken = (store.tokens.get(relPath) ?? 0) + 1;
  store.tokens.set(relPath, myToken);

  // loadingPaths 设置
  try {
    const list = await fileBrowserApiFor(store.deviceId).listDir({
      workdir: store.workdir,
      remoteHostId: store.remoteHostId,
      relPath,
      hideMetaFiles: store.hideMetaFiles,
      docMode: store.docMode,
      showIgnoredDirs: store.showIgnoredDirs,
    });
    if (store.tokens.get(relPath) !== myToken) return; // stale
    if (store.snapshot.loadError) {
      store.snapshot = { ...store.snapshot, loadError: null };
    }
    // 结构等价 → 跳过 setEntries,避免子组件无意义重渲(参见函数顶部注释)。
    const prevList = store.snapshot.entries.get(relPath);
    if (prevList && entriesStructurallyEqual(prevList, list)) return;
    const nextEntries = new Map(store.snapshot.entries);
    nextEntries.set(relPath, list);
    store.snapshot = { ...store.snapshot, entries: nextEntries };
    emit(store);
  } catch (err) {
    log.warn(`listDir failed for ${relPath}`, err);
    // root 失败要可见:空树 + 无提示会被读成"项目是空的"。device-link 的
    // 版本偏差(老被控端无 remote-op channel)单独标记,渲染升级提示。
    if (relPath === ROOT_KEY) {
      store.snapshot = {
        ...store.snapshot,
        loadError: isDeviceTooOldError(err) ? 'device-too-old' : 'load-failed',
      };
      emit(store);
    }
    // Keep prior state; user can refresh manually.
  }
}

function setDirectoryLoading(store: FileTreeStore, relPath: string, loading: boolean): void {
  const alreadyLoading = store.snapshot.loadingPaths.has(relPath);
  if (alreadyLoading === loading) return;
  const nextLoading = new Set(store.snapshot.loadingPaths);
  if (loading) nextLoading.add(relPath);
  else nextLoading.delete(relPath);
  store.snapshot = { ...store.snapshot, loadingPaths: nextLoading };
  emit(store);
}

/**
 * Fetch one directory at a time. Calls made while the request is running set
 * one trailing bit; the request loop consumes that bit after the current
 * result is applied. The trailing budget is capped at one scan per lifecycle,
 * so a watcher storm cannot keep the loop alive indefinitely.
 */
function fetchDir(store: FileTreeStore, relPath: string): Promise<void> {
  const current = store.inFlight.get(relPath);
  if (current) {
    if (!current.trailingScheduled) {
      current.trailingScheduled = true;
      current.trailing = true;
    }
    return current.promise;
  }

  const refresh: DirectoryRefresh = {
    promise: Promise.resolve(),
    trailing: false,
    trailingScheduled: false,
  };
  refresh.promise = (async () => {
    do {
      refresh.trailing = false;
      await fetchDirOnce(store, relPath);
    } while (refresh.trailing);
  })().finally(() => {
    if (store.inFlight.get(relPath) === refresh) {
      store.inFlight.delete(relPath);
    }
    setDirectoryLoading(store, relPath, false);
  });
  store.inFlight.set(relPath, refresh);
  setDirectoryLoading(store, relPath, true);
  return refresh.promise;
}

function parentPath(relPath: string): string {
  const slashIdx = relPath.lastIndexOf('/');
  return slashIdx < 0 ? ROOT_KEY : relPath.slice(0, slashIdx);
}

function addDocModeAncestors(
  store: FileTreeStore,
  parent: string,
  targets: Set<string>,
): void {
  let cursor: string | null = parent;
  while (cursor !== null) {
    // An ancestor can still be warming during initial restore. Include an
    // in-flight directory as a target so a watcher event arriving in that
    // window gets a trailing refresh instead of being lost before the first
    // result is committed.
    if (store.snapshot.entries.has(cursor) || store.inFlight.has(cursor)) {
      targets.add(cursor);
    }
    if (cursor === ROOT_KEY) break;
    cursor = parentPath(cursor);
  }
}

/**
 * Coalesce synchronous IPC deliveries by parent directory. The IPC contract
 * intentionally remains one event per changed path; only tree refresh work is
 * merged here. In doc mode every cached ancestor is retained because a
 * directory can disappear when its last visible descendant is removed.
 */
function queueEventRefresh(store: FileTreeStore, eventRelPath: string): void {
  store.pendingEventParents.add(parentPath(eventRelPath));
  if (store.eventFlushTimer) return;
  store.eventFlushTimer = setTimeout(() => {
    store.eventFlushTimer = null;
    const parents = [...store.pendingEventParents];
    store.pendingEventParents.clear();
    if (store.refCount === 0) return;

    const targets = new Set<string>();
    for (const parent of parents) {
      if (store.docMode) {
        addDocModeAncestors(store, parent, targets);
      } else if (store.snapshot.entries.has(parent) || store.inFlight.has(parent)) {
        targets.add(parent);
      }
    }
    for (const target of targets) void fetchDir(store, target);
  }, EVENT_COALESCE_MS);
}

/** 首次挂载触发:initial fetch + 恢复 localStorage expanded + 启动 watcher。
 *  幂等:重复调用直接 no-op(refCount 已 >0)。 */
async function initStore(store: FileTreeStore): Promise<void> {
  // 恢复 localStorage 持久化的 expanded 集合(workdir × 视图模式共享,见
  // expandedStore 的 scope 说明)。分片是刻意的:两个 scope 各记自己的展开态,
  // 不跨 scope 合并 —— 合并会把 reveal 态展开过的 node_modules 带进 hidden 态。
  const restored = loadExpandedSet(store.workdir, { showIgnoredDirs: store.showIgnoredDirs });
  const nextExpanded = new Set<string>([ROOT_KEY, ...restored]);
  store.snapshot = { ...store.snapshot, expanded: nextExpanded };
  emit(store);

  // watcher 监听:per workdir 启停。共享 store 后只挂一次,所有订阅者共享。
  // doc 模式 / 默认模式的差异在 onEvent handler 里按 store.docMode 分支处理。
  // 三路同语义:本地 chokidar / SSH 远端 daemon fs.watch / device-link 被控端
  // watch(fs-watch topic 订阅驱动)——事件 payload 完全同形,handler 无分支。
  {
    void startWatchFor(store.deviceId, {
      workdir: store.workdir,
      remoteHostId: store.remoteHostId,
      hideMetaFiles: store.hideMetaFiles,
      showIgnoredDirs: store.showIgnoredDirs,
    }).catch((err) => log.warn('startWatch failed', err));

    store.watcherOff = onFileTreeEventFor(store.deviceId, (event) => {
      if (event.workdir !== store.workdir) return;
      queueEventRefresh(store, event.relPath);
    });
  }

  // Initial root fetch + 已 restore expanded 目录的并行 lazy fetch。每个 listDir
  // <12ms,即使 50 个 restored 也能在 <1s 内 warm 完。
  await Promise.all([
    fetchDir(store, ROOT_KEY),
    ...[...restored].map((p) => fetchDir(store, p)),
  ]);
  store.snapshot = { ...store.snapshot, initialLoading: false };
  emit(store);
}

/** 最后一个订阅者离开:停 watcher、从 stores 表移除。store 对象被回收。 */
function disposeStore(store: FileTreeStore): void {
  if (store.eventFlushTimer) clearTimeout(store.eventFlushTimer);
  store.eventFlushTimer = null;
  store.pendingEventParents.clear();
  store.inFlight.clear();
  if (store.watcherOff) {
    store.watcherOff();
    store.watcherOff = null;
  }
  void stopWatchFor(store.deviceId, {
    workdir: store.workdir,
    remoteHostId: store.remoteHostId,
  }).catch(() => {});
  stores.delete(store.key);
}

// ── Public actions (store-level,跟 UseFileTreeReturn 的同名方法对应) ────────

function toggleFolder(store: FileTreeStore, relPath: string): void {
  if (relPath === ROOT_KEY) return;
  const prev = store.snapshot.expanded;
  const next = new Set(prev);
  if (next.has(relPath)) {
    next.delete(relPath);
  } else {
    next.add(relPath);
    if (!store.snapshot.entries.has(relPath)) {
      void fetchDir(store, relPath);
    }
  }
  saveExpandedSet(store.workdir, next, { showIgnoredDirs: store.showIgnoredDirs });
  store.snapshot = { ...store.snapshot, expanded: next };
  emit(store);
}

function collapseAll(store: FileTreeStore): void {
  const nextExpanded = new Set([ROOT_KEY]);
  const prevEntries = store.snapshot.entries;
  const nextEntries = new Map<string, readonly DirEntry[]>();
  const rootEntries = prevEntries.get(ROOT_KEY);
  if (rootEntries) nextEntries.set(ROOT_KEY, rootEntries);
  saveExpandedSet(store.workdir, new Set(), { showIgnoredDirs: store.showIgnoredDirs });
  store.snapshot = {
    ...store.snapshot,
    expanded: nextExpanded,
    entries: nextEntries,
  };
  emit(store);
}

async function refresh(store: FileTreeStore): Promise<void> {
  const targets = [...store.snapshot.entries.keys()];
  await Promise.all(targets.map((p) => fetchDir(store, p)));
}

async function expandToPath(store: FileTreeStore, relPath: string): Promise<void> {
  if (!relPath) return;
  const parts = relPath.split('/');
  if (parts.length < 2) return; // root 级文件
  const ancestors: string[] = [];
  for (let i = 1; i < parts.length; i++) {
    ancestors.push(parts.slice(0, i).join('/'));
  }
  // 一次性写 expanded set
  const nextExpanded = new Set(store.snapshot.expanded);
  for (const a of ancestors) nextExpanded.add(a);
  saveExpandedSet(store.workdir, nextExpanded, { showIgnoredDirs: store.showIgnoredDirs });
  store.snapshot = { ...store.snapshot, expanded: nextExpanded };
  emit(store);
  // 未 cache 的祖先并行 fetch
  const toFetch = ancestors.filter((a) => !store.snapshot.entries.has(a));
  await Promise.all(toFetch.map((a) => fetchDir(store, a)));
}

// ── Hook ────────────────────────────────────────────────────────────────────

export function useFileTree({
  workdir,
  remoteHostId = null,
  deviceId = null,
  hideMetaFiles = true,
  docMode = false,
  showIgnoredDirs = false,
}: UseFileTreeOptions): UseFileTreeReturn {
  // device 会话:探测被控端是否支持 showIgnoredDirs。老端的 listDir 会静默忽略
  // 这个字段 —— 开关看起来按下去了、树里什么也不变。
  //
  // 探到不支持就按“隐藏态”建 store(不给老端发无效字段),并把结论 expose 给
  // 标题行(开关渲染成不可用 + 说明原因)。非 device 会话恒为 true。
  //
  // 瞬态失败(隧道不可达 / 重连中)保持「未知」而不是落定成 false:把一次网络抖动
  // 显示成「对方版本过旧」并把开关禁掉,连接恢复后也不会自愈。重探由
  // reconnectEpoch 驱动 —— relay 或目标设备恢复 online 时它自增。
  const revealReconnectEpoch = useDeviceLinkReconnectEpoch(deviceId ?? undefined);
  const [deviceRevealSupported, setDeviceRevealSupported] = useState<boolean | null>(null);
  /** 上次探测结论归属的设备;换设备不留用旧结论(重连不清,避免开关闪一下)。 */
  const revealProbedDeviceRef = useRef<string | null>(null);
  useEffect(() => {
    if (!deviceId) {
      revealProbedDeviceRef.current = null;
      setDeviceRevealSupported(null);
      return;
    }
    if (revealProbedDeviceRef.current !== deviceId) {
      revealProbedDeviceRef.current = deviceId;
      setDeviceRevealSupported(null);
    }
    let cancelled = false;
    void deviceSupportsRevealIgnoredDirs(deviceId, workdir, revealReconnectEpoch).then(
      (supported) => {
        if (cancelled) return;
        // null = 瞬态失败:保持现状(首帧仍是「未知」,已有结论也不推翻),
        // 等下一次 reconnectEpoch 或重新挂载时再问一次。
        if (supported === null) return;
        setDeviceRevealSupported(supported);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [deviceId, workdir, revealReconnectEpoch]);

  // 探测未返回时(device 首帧)沿用用户偏好:猜错只多一次重建,不会发出无法
  // 兑现的用户可见承诺。
  const effectiveShowIgnoredDirs = showIgnoredDirs && deviceRevealSupported !== false;

  // store 实例按 (workdir + options) 共享 —— 多个 hook 实例订阅同一份。
  // memo 用 dep 化 options,确保 workdir 切换会换 store。
  const store = useMemo(
    () => getOrCreateStore({
      workdir,
      remoteHostId,
      deviceId,
      hideMetaFiles,
      docMode,
      showIgnoredDirs: effectiveShowIgnoredDirs,
    }),
    [workdir, remoteHostId, deviceId, hideMetaFiles, docMode, effectiveShowIgnoredDirs],
  );

  // ref-count 生命周期:首挂触发 init(initial fetch + start watch),最后离开
  // 触发 dispose(stop watch + 从 stores 表移除)。
  useEffect(() => {
    store.refCount += 1;
    if (store.refCount === 1) {
      void initStore(store);
    }
    return () => {
      store.refCount -= 1;
      if (store.refCount === 0) {
        disposeStore(store);
      }
    };
  }, [store]);

  // 订阅 store snapshot 变化。useSyncExternalStore 保证多个订阅者 + concurrent
  // mode 下 tearing-free。
  const snapshot = useSyncExternalStore(
    useCallback(
      (cb) => {
        store.listeners.add(cb);
        return () => store.listeners.delete(cb);
      },
      [store],
    ),
    () => store.snapshot,
    () => store.snapshot,
  );

  // 把 store-level actions wrap 成跟 store 绑死的稳定引用。
  const toggleFolderCb = useCallback((relPath: string) => toggleFolder(store, relPath), [store]);
  const collapseAllCb = useCallback(() => collapseAll(store), [store]);
  const refreshCb = useCallback(() => refresh(store), [store]);
  const expandToPathCb = useCallback(
    (relPath: string) => expandToPath(store, relPath),
    [store],
  );

  return useMemo(
    () => ({
      entries: snapshot.entries,
      expanded: snapshot.expanded,
      loadingPaths: snapshot.loadingPaths,
      initialLoading: snapshot.initialLoading,
      loadError: snapshot.loadError,
      // 非 device 会话恒 true;device 会话见上面探测注释。
      showIgnoredDirsSupported: deviceId ? deviceRevealSupported : true,
      toggleFolder: toggleFolderCb,
      collapseAll: collapseAllCb,
      refresh: refreshCb,
      expandToPath: expandToPathCb,
    }),
    [snapshot, deviceId, deviceRevealSupported, toggleFolderCb, collapseAllCb, refreshCb, expandToPathCb],
  );
}
