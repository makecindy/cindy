/**
 * useSkillhub — module-level store + hook for the SkillHub scan result.
 *
 * Why a module-level store instead of React Context: the SidebarUpper is
 * rendered through a slot mechanism (`useRegisterSidebarUpper`) and ends up
 * mounted in the shell's React tree, *outside* any provider that the feature
 * Layout could place. To let the sidebar tree, the welcome view, and the
 * detail view all observe the same scan state, we mirror the project's
 * existing pattern (see `useCCSessions` + `sessionsBus`): a singleton in
 * module scope plus a subscription set, with a thin React hook on top.
 *
 * 项目列表（prod spec v0.3 F2）：scanner 一次扫描所有 CC Agent 项目，
 * 不再让用户手选单个目录。Layout 通过 `projectGrouping.groupSessions`
 * 从 `useCCSessions` 派生项目轴，为每个 projectRoot 计算稳定 projectHash，
 * 再用 `syncProjects(...)` 推到这里。列表变化时重新扫描，让 Local tree 与
 * CC Agent 项目集合同步。
 */

import { useEffect, useMemo, useState } from 'react';
import { skillhubCatalogKey } from '../../../../shared/skillhubCatalog';
import { invalidateSkillSyncRequests, registerSyncStoreSetters } from './useSkillSync';

interface SkillhubProject {
  /** 项目资产归属根目录，来自会话分组后的 project root。 */
  projectRoot: string;
  /** 来自 `lib/projectHash.ts` 的稳定 URL hash。 */
  hash: string;
  /** 来自 `extractDisplayName` 的显示名，必要时带父目录消歧。 */
  displayName: string;
}

interface SkillhubState {
  skills: SkillhubSkill[];
  sources: SkillhubSourceReport[];
  loading: boolean;
  error: string | null;
  /** 当前参与扫描的项目集合，来源是 CC Agent 的 projectGrouping。 */
  projects: SkillhubProject[];
  /** True once a first scan has completed (success or failure). */
  bootstrapped: boolean;
  /** v0.2.1: sync results map keyed by skill name */
  syncResults: Map<string, SkillhubSyncResult>;
  /** v0.2.1: error from last sync attempt */
  syncError: string | null;
  /**
   * Hub 按全局安装状态算出的"可获取"数量：
   * 非自己创建，且未全局安装。
   */
  availableUninstalledCount: number;
}

let state: SkillhubState = {
  skills: [],
  sources: [],
  loading: false,
  error: null,
  projects: [],
  bootstrapped: false,
  syncResults: new Map(),
  syncError: null,
  availableUninstalledCount: 0,
};

const listeners = new Set<() => void>();

function notify(): void {
  for (const l of listeners) l();
}

function setState(patch: Partial<SkillhubState>): void {
  state = { ...state, ...patch };
  notify();
}

// 过期结果保护：每次 scan 领取递增 id，只有最新请求能写回 state，避免旧项目列表的
// 慢响应覆盖新项目列表的扫描结果。
let scanRequestId = 0;
let latestScan: { id: number; promise: Promise<SkillhubSkill[]> } | null = null;

export function refresh(): Promise<SkillhubSkill[]> {
  const myId = ++scanRequestId;
  const promise = (async (): Promise<SkillhubSkill[]> => {
    setState({ loading: true, error: null });
    try {
      const result = await window.electronAPI.skillhub.scan({
        projects: state.projects.map((p) => ({ projectRoot: p.projectRoot, hash: p.hash })),
      });
      if (myId !== scanRequestId) {
        return latestScan?.id === scanRequestId ? latestScan.promise : state.skills;
      }
      if (result.success) {
        const skills = result.skills ?? [];
        setState({
          skills,
          sources: result.sources ?? [],
          loading: false,
          bootstrapped: true,
        });
        return skills;
      }
      setState({
        error: result.error ?? 'scan failed with no error message',
        loading: false,
        bootstrapped: true,
      });
      return state.skills;
    } catch (err) {
      if (myId !== scanRequestId) {
        return latestScan?.id === scanRequestId ? latestScan.promise : state.skills;
      }
      setState({
        error: err instanceof Error ? err.message : String(err),
        loading: false,
        bootstrapped: true,
      });
      return state.skills;
    }
  })();
  latestScan = { id: myId, promise };
  return promise;
}

/**
 * Layout 侧推送当前 CC Agent 项目集合。按 projectRoot + hash 比较；项目增删
 * 或重排时更新状态并重新扫描。顺序由调用方负责，sidebar 会按传入顺序渲染。
 */
export function syncProjects(projects: SkillhubProject[]): void {
  const prev = state.projects;
  if (prev.length === projects.length) {
    let identical = true;
    for (let i = 0; i < prev.length; i++) {
      if (prev[i].projectRoot !== projects[i].projectRoot || prev[i].hash !== projects[i].hash) {
        identical = false;
        break;
      }
    }
    if (identical) return;
  }
  state = { ...state, projects };
  notify();
  void refresh();
}

let bootstrapped = false;
let activeDataOwnerId: string | null | undefined;
/**
 * Idempotent — call from the Layout's mount effect. Fires the initial scan
 * (with whatever projects have been pushed by the time we get here, possibly
 * an empty list if useCCSessions hasn't loaded yet — a follow-up sync will
 * trigger a rescan once it does).
 */
export function bootstrapSkillhub(): void {
  if (bootstrapped) return;
  bootstrapped = true;
  void refresh();
}

// ── v0.2.1: sync result store mutations ──────────────────────────────────────

/**
 * Full replace — called after batch sync returns results.
 * availableUninstalledCount 仅在调用方显式传入时更新；本地详情同步不刷新计数。
 */
export function setSyncResults(
  results: SkillhubSyncResult[],
  availableUninstalledCount?: number,
): void {
  const map = new Map<string, SkillhubSyncResult>();
  for (const r of results) map.set(skillhubCatalogKey(r.name, r.catalogScope), r);
  setState({
    syncResults: map,
    syncError: null,
    ...(typeof availableUninstalledCount === 'number' ? { availableUninstalledCount } : {}),
  });
}

/**
 * Incremental merge — called after publish success triggers partial sync.
 * 增量场景下 availableUninstalledCount 不可靠（只是部分技能的请求），
 * 不更新此字段，等下一次全量 sync 自然刷新。
 */
export function mergeSyncResults(results: SkillhubSyncResult[]): void {
  const map = new Map(state.syncResults);
  for (const r of results) map.set(skillhubCatalogKey(r.name, r.catalogScope), r);
  setState({ syncResults: map });
}

/** Record sync failure without clearing existing results. */
export function setSyncError(err: string | null): void {
  setState({ syncError: err });
}

/**
 * Full state reset — called on data-owner changes. Clears sync results,
 * skills and both bootstrap guards. In-flight scans are invalidated so an old
 * owner's late result cannot repopulate the new owner's store.
 */
export function reset(): void {
  scanRequestId += 1;
  latestScan = null;
  invalidateSkillSyncRequests();
  bootstrapped = false;
  state = {
    skills: [],
    sources: [],
    loading: false,
    error: null,
    projects: [],
    bootstrapped: false,
    syncResults: new Map(),
    syncError: null,
    availableUninstalledCount: 0,
  };
  notify();
}

/** Reset the singleton exactly once for each committed data-owner boundary. */
export function setSkillhubDataOwner(dataOwnerId: string | null): void {
  if (activeDataOwnerId === dataOwnerId) return;
  activeDataOwnerId = dataOwnerId;
  reset();
}

// ── Auth change listener — reset store on every data-owner boundary ─────────

let authListenerUnsubscribe: (() => void) | null = null;

function ensureAuthListener(): void {
  if (authListenerUnsubscribe) return;
  authListenerUnsubscribe = window.electronAPI.onAuthStateChange((authState) => {
    setSkillhubDataOwner(authState.dataOwnerId);
  });
}

// ── v0.2.1: wire up sync store setters into useSkillSync ─────────────────────

registerSyncStoreSetters({ setSyncResults, mergeSyncResults, setSyncError });

interface UseSkillhubReturn extends SkillhubState {
  refresh: () => Promise<SkillhubSkill[]>;
}

export function useSkillhub(): UseSkillhubReturn {
  const [snapshot, setSnapshot] = useState<SkillhubState>(state);

  useEffect(() => {
    ensureAuthListener();
    const sync = () => setSnapshot(state);
    listeners.add(sync);
    sync(); // resync in case state changed between render and effect
    return () => {
      listeners.delete(sync);
    };
  }, []);

  return {
    ...snapshot,
    refresh,
  };
}

export type { SkillhubProject };

// ──────────────────────────────────────────────────────────────────────────
// Last-visited entry (localStorage)
//
// Restores the user back to whichever skill / command / agent they were
// reading last time SkillHub was open. Stored value is the entry's `id`
// (kind:scope[:hash]:name) — same shape `makeId()` uses on the main side,
// so verification is just `skills.find(s => s.id === lastId)`.
//
// On lookup: if the entry no longer exists (folder deleted / moved), the
// stored id is dropped and the welcome view stays put.
// ──────────────────────────────────────────────────────────────────────────

const LAST_ENTRY_KEY = 'skillhub.lastEntryId.v1';

export function getLastEntryId(): string | null {
  try {
    return localStorage.getItem(LAST_ENTRY_KEY);
  } catch {
    return null;
  }
}

export function setLastEntryId(id: string): void {
  try {
    localStorage.setItem(LAST_ENTRY_KEY, id);
  } catch {
    // localStorage may be unavailable / full — degrade silently.
  }
}

export function clearLastEntryId(): void {
  try {
    localStorage.removeItem(LAST_ENTRY_KEY);
  } catch {
    // ignore
  }
}


// 旧版本用 sessionStorage 保存 detail 内部历史栈。现在返回按钮直接退出详情页，
// 这里只保留清理函数，防止升级后旧栈继续影响入口状态。
const HISTORY_KEY = 'skillhub.navHistory.v1';

export function clearHistory(): void {
  try {
    sessionStorage.removeItem(HISTORY_KEY);
  } catch {
    // ignore
  }
}

// ── F-UI-3 / F-UI-4 派生 hook ────────────────────────────────────────────────

/**
 * useInstallsByName — 返回本地所有与 skillName 同名、且有 registry 记录的 skill。
 *
 * 完全派生自 useSkillhub().skills，零额外 IPC。
 * 典型用途：MarketSelectionPanel 的状态 C（已装 ≥1 处）列表。
 *
 * 注:用户本地手写并 publish 的 skill 也会有 registry 记录 ——
 * publish 流程 (skillhub/publishService) 在没有现存 install 时会 addInstall
 * 一条 authorId = 当前登录用户 userId 的记录。
 */
/**
 * useSkillhubBadgeCount — SkillHub tab 右上角徽标显示的数字。
 *
 * 总数直接读 Hub 权威的可获取计数。Hub 已根据全局安装状态在分页前排除
 * 全局安装；project-scoped 安装不影响该数量。
 */
export function useSkillhubBadgeCount(): number {
  const { availableUninstalledCount } = useSkillhub();
  return availableUninstalledCount;
}

export function useInstallsByName(
  skillName: string | null,
): {
  installs: Array<{ skill: SkillhubSkill; entry: StoredInstall }>;
  loading: boolean;
} {
  const { skills, loading } = useSkillhub();
  const installs = useMemo(() => {
    if (!skillName) return [];
    return skills
      .filter(
        (s): s is SkillhubSkill & { registryEntry: StoredInstall } =>
          s.kind === 'skill' && s.name === skillName && s.registryEntry !== null,
      )
      .map((s) => ({ skill: s, entry: s.registryEntry }));
  }, [skills, skillName]);
  return { installs, loading };
}
