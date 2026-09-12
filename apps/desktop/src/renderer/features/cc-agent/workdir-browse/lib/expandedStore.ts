/**
 * expandedStore — workdir → expanded folder set persistence (localStorage).
 *
 * Why module-level + localStorage rather than module-level only:
 *   Survives reload / dev restart / app restart. User's expectation when
 *   navigating away from /cc-agent/files/* and coming back is "my folders
 *   are still where I left them" regardless of what triggered the unmount.
 *
 * 展开态按**视图模式**分片(见 expandedScopeKey):「显示被忽略的目录」关闭时
 * 沿用历史键(存量用户零迁移),打开时用独立一份 —— 两态可见的目录集合不同,
 * 混用会在切回隐藏态时把 node_modules / Library 这类巨大目录当成"已展开"去
 * 恢复,init 一次并行 listDir 上百个隐藏目录(本地卡顿,SSH 上还是一条条 RPC)。
 *
 * Storage shape:
 *   {
 *     "<workdir absolute path>": ["Assets", "Assets/Scripts", "Design"],
 *     "<workdir absolute path>::reveal": ["node_modules"],
 *     ...
 *   }
 *
 * Cap: max 200 paths per scope (defends against runaway state if a user
 * mass-expands a deep tree); 100 scopes total in the bag (LRU evict the
 * oldest keys to keep storage bounded). 200 paths × ~80 chars × 100 scopes
 * ≈ 1.6 MB worst case — well under localStorage's 5 MB quota.
 *
 * 注:同一个 workdir 打开开关后占两个 scope,有效 workdir 数量减半(50) ——
 * 上限本来就是防御极端情况的粗糙阀值,不值再引入一套二级结构。
 */

const STORAGE_KEY = 'cc-agent.workdirBrowse.expandedFolders.v1';
const MAX_PATHS_PER_WORKDIR = 200;
const MAX_WORKDIRS = 100;

type Bag = Record<string, string[]>;

function loadBag(): Bag {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Bag;
    }
    return {};
  } catch {
    return {};
  }
}

function saveBag(bag: Bag): void {
  try {
    // Cap workdir count: drop the lexicographically-smallest keys until
    // we're under the limit. Lexicographic isn't true LRU but localStorage
    // doesn't track access time and we don't want to maintain a separate
    // recency index for this. The eviction is rare enough not to matter.
    const keys = Object.keys(bag);
    if (keys.length > MAX_WORKDIRS) {
      const evict = keys.sort().slice(0, keys.length - MAX_WORKDIRS);
      for (const k of evict) delete bag[k];
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(bag));
  } catch {
    // localStorage full / disabled — degrade silently. The in-memory state
    // for this session still works; user just loses persistence across
    // restart.
  }
}

export interface ExpandedScopeOptions {
  /** 「显示被忽略的目录」开关:true = 独立 scope(默认 false,沿用历史键)。 */
  showIgnoredDirs?: boolean;
}

/**
 * 持久化 scope 键。隐藏态 = workdir 本身（与历史版本一致，升级不丢展开态）；
 * 放行态用**不可打印的 NUL 分隔** —— POSIX 路径不允许含 NUL（内核唯一禁用的
 * 字节），所以 `${workdir}\0reveal` 不可能撞上任何 workdir 的隐藏键。
 *
 * 旧实现用 `::reveal` 裸后缀：workdir 以 `::reveal` 结尾时（如
 * `/srv/project::reveal`），它的隐藏键恰好等于 `/srv/project` 的 reveal 键，两个
 * 项目的展开态互相覆盖、各自恢复无关路径（评审 P1）。
 */
const REVEAL_SCOPE_SUFFIX = '\u0000reveal';

function expandedScopeKey(workdir: string, opts: ExpandedScopeOptions): string {
  return opts.showIgnoredDirs ? `${workdir}${REVEAL_SCOPE_SUFFIX}` : workdir;
}

/** 旧版 reveal 键（`::reveal`）：只用于**读取回退**，避免升级后丢展开态。 */
function legacyRevealScopeKey(workdir: string, opts: ExpandedScopeOptions): string | null {
  return opts.showIgnoredDirs ? `${workdir}::reveal` : null;
}

export function loadExpandedSet(
  workdir: string,
  opts: ExpandedScopeOptions = {},
): Set<string> {
  const bag = loadBag();
  // 新键优先；没有则回退到旧版 `::reveal` 键（迁移前写入的数据）。
  const legacy = legacyRevealScopeKey(workdir, opts);
  const list = bag[expandedScopeKey(workdir, opts)] ?? (legacy ? bag[legacy] : undefined);
  if (!Array.isArray(list)) return new Set();
  return new Set(list.filter((s): s is string => typeof s === 'string'));
}

export function saveExpandedSet(
  workdir: string,
  expanded: Set<string>,
  opts: ExpandedScopeOptions = {},
): void {
  const bag = loadBag();
  const key = expandedScopeKey(workdir, opts);
  const list = [...expanded];
  // Filter out the empty-string root key (always implicit) + dedupe.
  const filtered = list.filter((p) => p !== '');
  if (filtered.length === 0) {
    // Don't keep empty entries in the bag — it'd just bloat over time.
    delete bag[key];
  } else {
    bag[key] = filtered.slice(0, MAX_PATHS_PER_WORKDIR);
  }
  // 不清旧版 `::reveal` 键：它和隐藏键共用同一个字符串空间（`/srv/project::reveal`
  // 既是 /srv/project 的旧 reveal 键、又是它自己的隐藏键），删它就会误删另一个
  // workdir 的数据。旧键只是残留、不再被写入，读取已回退到新键。
  saveBag(bag);
}
