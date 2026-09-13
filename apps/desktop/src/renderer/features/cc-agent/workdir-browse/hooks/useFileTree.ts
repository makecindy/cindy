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
import {
  BUILTIN_IGNORE_ALWAYS,
  BUILTIN_IGNORE_REVEALABLE,
} from '../../../../../shared/ignoreNames';

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

  /** 当前 store 的稳定标识（workdir + hideMetaFiles + showIgnoredDirs + host/device）。
   *  切「显示被忽略的目录」会换一份 store，这个值跟着变；同一 store 内因 snapshot
   *  更新造成的重渲染不会变 —— 需要区分"换视图"与"同一视图刷新"的地方（如滚动
   *  锚点、DOM 复用判定）用它，而不是靠对象引用。 */
  storeKey: string;

  toggleFolder: (relPath: string) => void;
  /** Collapse every folder back to root. Also clears persisted state. */
  collapseAll: () => void;
  refresh: () => Promise<void>;
  /**
   * 展开 relPath 的所有祖先目录(让该文件可见),触发未 cache 的目录 lazy fetch,
   * 返回 Promise 等所有 listDir 完成。
   *
   * 用于"筛选文件 / 搜索 / 跳转"等需要把目标文件在树里露出来的场景 —— 上层调
   * 完 expandToPath 再调 FileTreeView 的 scrollToPath 把那一行滚进视口,visual
   * 节奏稳（虚拟化后由 virtualizer.scrollToIndex 完成）。
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
  /** 本 store 的 entries 是否还是从兄弟 scope **借来**的 seed 数据（切换开关的
   *  过渡窗口）。借来的树一旦根请求失败就不代表当前视图，留着会让失败看起来像
   *  加载成功（评审 P2）。 */
  seeded: boolean;
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
 * 隐藏态会忽略的一级目录名。名单从 @cindy/file-browser-core/ignoreNames 单源
 * 导入(经 shared 转发),只覆盖内置项 —— `.gitignore` / `.p4ignore` 里的自定义
 * 条目 renderer 拿不到,要等新 matcher 的数据回来才消失。
 *
 * 名单与比较都折叠大小写:matcher 的 `ignore` 包默认 `ignorecase=true`,大小写
 * 变体(`DIST` / `BUILD`)在隐藏态同样不可见,不折叠会让它们在首帧多留一拍。
 */
const HIDDEN_VIEW_DIR_NAMES = new Set(
  [...BUILTIN_IGNORE_ALWAYS, ...BUILTIN_IGNORE_REVEALABLE]
    .filter((name) => name.endsWith('/'))
    .map((name) => name.slice(0, -1).toLowerCase()),
);

/**
 * 关开关的首帧过滤:把 reveal 态树里「隐藏态会被忽略」的目录行**逐列表**拿掉
 * —— 不只是根列表。被忽略目录可能嵌在已展开的普通目录下面
 * (`packages/foo/node_modules`):只滤根列表的话它会一直挂在展开的父目录下,
 * 而 pruneExpandedForCurrentTree 会拿**过期的 reveal 子列表**当可达性依据、
 * 把它判成可达,于是永久保留到手动刷新。
 *
 * 同时**丢掉被移除目录的整棵缓存**(不只是那一行):它们不再可达,但 refresh()
 * 是「按 entries 的 key 逐个 listDir」—— 留着会让隐藏态下一次刷新给 node_modules
 * 子树白发数百个 listDir(本地卡顿,SSH / device-link 上就是数百条 RPC)。
 *
 * 逐列表过滤同时修好 prune 的判据:父列表里已经没有那一行,可达性自然为假。
 * 其余子树缓存与展开集合整体不动(不可达的分支本来就不渲染),不重拉任何目录 ——
 * 「整体一次性消失」的观感不变。
 *
 * 只覆盖内置名单:`.gitignore` / `.p4ignore` 的自定义条目 renderer 拿不到
 * (不读盘),要等新 matcher 的数据回来才消失。
 */
function filterSeedTreeForHiddenView(
  entries: ReadonlyMap<string, readonly DirEntry[]>,
): ReadonlyMap<string, readonly DirEntry[]> {
  const droppedRoots = new Set<string>();
  const next = new Map<string, readonly DirEntry[]>();
  for (const [dir, list] of entries) {
    const kept = list.filter((entry) => {
      if (entry.type === 'directory' && HIDDEN_VIEW_DIR_NAMES.has(entry.name.toLowerCase())) {
        droppedRoots.add(entry.relPath);
        return false;
      }
      return true;
    });
    next.set(dir, kept.length === list.length ? list : kept);
  }
  if (droppedRoots.size === 0) return entries;
  for (const dir of [...next.keys()]) {
    if (dir === ROOT_KEY) continue;
    // 逐级向上查:key 落在被移除目录自己或它的子树里就丢。
    for (let probe = dir; probe !== ''; ) {
      if (droppedRoots.has(probe)) {
        next.delete(dir);
        break;
      }
      const cut = probe.lastIndexOf('/');
      probe = cut < 0 ? '' : probe.slice(0, cut);
    }
  }
  return next;
}

/**
 * 切换「显示被忽略的目录」会换一份 store(key 含 reveal 位),新 store 若从
 * 空快照 + initialLoading 起步,FileTreeView 会把整棵树替换成占位(本地
 * <300ms 连 spinner 都没有,就是空白),视觉上闪一下;同一 workdir 的另一半
 * reveal scope 的 store 此刻通常还在表里 —— 旧 store 的 refCount 归零发生在
 * 本次 commit 的 effect cleanup,晚于 render 期间的 useMemo —— 借它
 * **整棵可见的树**(entries + expanded)当首帧内容,新 matcher 的 listDir 回来
 * 后再整体替换。
 *
 * 为什么整棵借、而不是只借根列表:只借根列表会把消失动作拆成两段 —— 子行先因
 * expanded 掉落而消失(父行还在),root 数据回来再拿掉父行 —— 多级展开时看起来
 * 就是「从最子级逐级折叠回去」。整棵借过来,关闭开关的动作是一次性的:树先保持
 * 不动,数据回来整体切换。
 *
 * 代价是过渡窗口(reveal → hidden)里旧 matcher 的行还会短暂可见 —— 窗口就是
 * 一次 listDir(本地 <12ms;慢通道到数据回来为止)。这是有意的取舍:全量、一次性
 * 地消失,比先闪空再重建、或逐级折叠都更接近直觉。
 *
 * 借来的 expanded 是**过渡态**:initStore 不据此 warm(免得给被忽略路径白发
 * listDir),root 数据回来时由 pruneExpandedForCurrentTree 按新树剪掉不可达路径
 * —— 否则它们会落进 hidden scope 的 localStorage,下次启动白拉一批。
 *
 * 「刷新」按钮没有这个问题:它在同一份 store 上原地 refetch,从不经过空态。
 */
function findRevealSiblingSnapshot(
  opts: Required<UseFileTreeOptions>,
): FileTreeStore['snapshot'] | null {
  const siblingKey = storeKey({ ...opts, showIgnoredDirs: !opts.showIgnoredDirs });
  return stores.get(siblingKey)?.snapshot ?? null;
}

/**
 * root 数据回来后,把「过渡期借来的、在当前树上不可达的展开路径」剪掉。
 *
 * 切开关时 seed 会把另一半 reveal scope 的整棵可见树带过来(见
 * findRevealSiblingSnapshot)。hidden 树下 node_modules / Library 这类路径已经
 * 不在 root 列表里,但它们的展开态还挂在 expanded 上 —— 留着会让用户在 hidden
 * 态做下一次操作时把它们写进 hidden scope 的 localStorage,下次启动就白发一批
 * listDir。逐级查父链:任一级不在对应父列表里即不可达。
 *
 * 查不到祖先列表(缓存被清 / 还没拉过)时保守保留 —— 宁可留一个 stale 展开位,
 * 也不能把用户真实的展开态删掉。
 *
 * 剪枝后**同步回写持久化**(评审 P2):过渡窗口里 root 数据还没到时,用户若做过
 * 一次 toggleFolder,那次 saveExpandedSet 会把继承来的 reveal-only 路径一并
 * 写进本 scope —— 不回写就会把它们固化进 localStorage,下次挂载按这些路径逐个
 * listDir(上限 200 个,SSH / device-link 上代价明显)。
 */
function pruneExpandedForCurrentTree(store: FileTreeStore): void {
  if (!store.snapshot.entries.has(ROOT_KEY)) return;
  const reachable = (relPath: string): boolean => {
    const parts = relPath.split('/');
    let parent = ROOT_KEY;
    for (const part of parts) {
      const list = store.snapshot.entries.get(parent);
      if (!list) return true;
      const child = parent === ROOT_KEY ? part : `${parent}/${part}`;
      if (!list.some((entry) => entry.relPath === child)) return false;
      parent = child;
    }
    return true;
  };
  const next = new Set<string>();
  let changed = false;
  for (const relPath of store.snapshot.expanded) {
    if (relPath === ROOT_KEY || reachable(relPath)) next.add(relPath);
    else changed = true;
  }
  if (!changed) return;
  store.snapshot = { ...store.snapshot, expanded: next };
  emit(store);
  saveExpandedSet(store.workdir, next, { showIgnoredDirs: store.showIgnoredDirs });
}

function getOrCreateStore(opts: Required<UseFileTreeOptions>): FileTreeStore {
  const key = storeKey(opts);
  const existing = stores.get(key);
  if (existing) return existing;
  // 切开关路径:借另一半 reveal scope 的整棵树当首帧内容,不经过 initialLoading
  // 空白;首次挂载(无兄弟 store)仍走原来的 loading 路径。
  const seed = findRevealSiblingSnapshot(opts);
  // 兄弟 store 可能还卡在首次 listDir 上(慢通道):没有可显示内容时不得冒充
  // 「已加载」—— 否则 FileTreeView 会把 initialLoading:false + 空 rows 渲染成
  // 「此文件夹为空」,而不是延迟 loading 态。终态错误可显示(渲染错误占位)。
  const seedDisplayable = !!seed && (seed.entries.size > 0 || seed.loadError !== null);
  const store: FileTreeStore = {
    key,
    workdir: opts.workdir,
    remoteHostId: opts.remoteHostId,
    deviceId: opts.deviceId,
    hideMetaFiles: opts.hideMetaFiles,
    docMode: opts.docMode,
    showIgnoredDirs: opts.showIgnoredDirs,
    snapshot:
      seedDisplayable && seed
        ? {
            // 关开关的首帧就滤掉内置忽略目录(避免慢通道下它们在新数据回来前
            // 还挂在「已隐藏」的视图里),见 filterSeedTreeForHiddenView。
            entries: opts.showIgnoredDirs
              ? seed.entries
              : filterSeedTreeForHiddenView(seed.entries),
            expanded: seed.expanded,
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
    seeded: seedDisplayable && !!seed,
    tokens: new Map(),
    inFlight: new Map(),
    pendingEventParents: new Set(),
    eventFlushTimer: null,
    watcherOff: null,
    refCount: 0,
    listeners: new Set(),
  };
  // 继承来的展开集合要按**（可能已过滤的）**树剪一次：剪枝那条路径挂在 fetch
  // 成功分支上，根请求失败时根本不会执行 —— 而 reveal-only 路径一旦被写进本
  // scope 的 localStorage（用户在错误恢复前操作目录、或 expandToPath 等路径），
  // 下次挂载就会变成最多 200 次无用 listDir（评审 P2）。剪完顺带回写本 scope。
  pruneExpandedForCurrentTree(store);
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
    // 根请求**成功**（无论后面是否结构等价而跳过替换）都代表「借来的树」窗口
    // 结束：之后任何一次根刷新失败都不能再把已属于本 scope 的树当成借来的清掉
    // （评审 P1；结构等价的路径同样要落定，否则会长久停在"借来"态）。
    if (relPath === ROOT_KEY) store.seeded = false;
    // 结构等价 → 跳过 setEntries，避免子组件无意义重渲（参见函数顶部注释）。
    // root 仍要 prune 一次：seed 的 root 可能与新 root 结构一致而展开态还是借的。
    const prevList = store.snapshot.entries.get(relPath);
    if (prevList && entriesStructurallyEqual(prevList, list)) {
      if (relPath === ROOT_KEY) pruneExpandedForCurrentTree(store);
      return;
    }
    const nextEntries = new Map(store.snapshot.entries);
    nextEntries.set(relPath, list);
    store.snapshot = { ...store.snapshot, entries: nextEntries };
    emit(store);
    // 过渡期(seed)借来的展开态在新树里可能已不可达,root 数据落地即剪。
    if (relPath === ROOT_KEY) pruneExpandedForCurrentTree(store);
  } catch (err) {
    log.warn(`listDir failed for ${relPath}`, err);
    // root 失败要可见:空树 + 无提示会被读成"项目是空的"。device-link 的
    // 版本偏差(老被控端无 remote-op channel)单独标记,渲染升级提示。
    if (relPath === ROOT_KEY) {
      const seededEntries = store.seeded;
      store.seeded = false;
      store.snapshot = {
        ...store.snapshot,
        // seed 过渡：借来的树一旦根请求失败就不代表当前视图，留着会让「开关已按下
        // + 树还是隐藏态旧数据」看起来像加载成功（错误占位只在 entries 为空时显示，
        // 见 FileBrowserBody）。清掉它让失败可见且可重试；只清一次，之后恢复既有
        // 「保留旧树」语义（那时 entries 确实属于当前视图）（评审 P2）。
        entries: seededEntries ? new Map() : store.snapshot.entries,
        loadError: isDeviceTooOldError(err) ? 'device-too-old' : 'load-failed',
      };
      // 借来的展开态在空树下不可达，剪枝与回写由**创建时**那次
      // pruneExpandedForCurrentTree（getOrCreateStore）完成；root 首次失败时
      // snapshot.entries 已被清空，再调 prune 会因缺 ROOT_KEY 直接早退，不重复。
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
  // expandedStore 的 scope 说明)。seed 带来的展开集合是过渡态(见
  // findRevealSiblingSnapshot):先一并留着让整树平滑替换,root 数据回来时
  // pruneExpandedForCurrentTree 按新树剪掉不可达路径。
  const restored = loadExpandedSet(store.workdir, { showIgnoredDirs: store.showIgnoredDirs });
  const nextExpanded = new Set<string>([ROOT_KEY, ...restored, ...store.snapshot.expanded]);
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
  //
  // seed 带来的展开父目录(不在 restored 里的那些)按**方向**分别处理:
  //  - 切到 reveal:hidden 态的数据缺了被忽略目录,不重拉就永远看不到
  //    node_modules / build(评审 P2),所以按新 matcher 重拉一遍;
  //  - 切到 hidden:reveal 态的数据多出被忽略项,首帧已由
  //    filterSeedTreeForHiddenView 就地滤掉,不再白发一轮 listDir。
  const inheritedExpanded = [...store.snapshot.expanded].filter(
    (p) => p !== ROOT_KEY && !restored.has(p),
  );
  const refetchInherited = store.showIgnoredDirs ? inheritedExpanded : [];
  await Promise.all([
    fetchDir(store, ROOT_KEY),
    ...[...restored].map((p) => fetchDir(store, p)),
    ...refetchInherited.map((p) => fetchDir(store, p)),
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
    // reconnectEpoch 在这里只负责「何时重问」;缓存代次由 transport 自己按全局
    // reconnect 流记账 —— hook 卸载期间的重连它也能看到(见 fileBrowserTransport)。
    void deviceSupportsRevealIgnoredDirs(deviceId, workdir).then((supported) => {
      if (cancelled) return;
      // null = 瞬态失败:保持现状(首帧仍是「未知」,已有结论也不推翻),
      // 等下一次 reconnectEpoch 或重新挂载时再问一次。
      if (supported === null) return;
      setDeviceRevealSupported(supported);
    });
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
      storeKey: store.key,
      toggleFolder: toggleFolderCb,
      collapseAll: collapseAllCb,
      refresh: refreshCb,
      expandToPath: expandToPathCb,
    }),
    [snapshot, deviceId, deviceRevealSupported, store, toggleFolderCb, collapseAllCb, refreshCb, expandToPathCb],
  );
}
