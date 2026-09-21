/**
 * useMarketList — SkillHub Market 浏览列表的 view-model hook。
 *
 * 数据流：renderer → IPC `skillhub:list-market` → main `serverApiFetch` →
 *         SkillHub broker。available 视图在客户端根据本地全局安装状态过滤，
 *         避免 Hub 的分页/安装记录口径与当前机器扫描结果不一致。
 *
 * 服务端已经做了可见性过滤、搜索、排序、cursor 分页。前端只负责:
 *   1. 把 sort/q/mine 状态变化映射到一次新的请求(每次请求都从第一页开始,
 *      cursor 留给后续 loadMore 用)。
 *   2. 把服务端 ListSkillItem 映射成视图模型 MarketSkill。
 *   3. 跨引用本地 useSkillhub().skills,标记 "已安装"：
 *      - 别人的 skill：必须 registryEntry !== null 才算"装的"（避免把用户手写的同名 skill 误判为已装）。
 *      - 自己的 skill：兼容未注册的本地目录；原作者发布记录通过作者 + slug
 *        关联同一条记录的公开投影，版本判断不额外请求详情或文件摘要。
 *      版本号优先取 registryEntry.version，没有时回落 server 的 latestVersion。
 *
 * Stale-result guard:每次 fetch 拿一个 requestId,只有最后一次的结果才能
 * setState,避免快速切换 sort/q 时旧响应覆盖新结果。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';

import {
  getDataOwnerGeneration,
  isDataOwnerGenerationCurrent,
  type DataOwnerGeneration,
} from '@/contexts/dataOwnerGeneration';
import { i18n } from '@/i18n';
import { CATEGORY_ALL, type MarketCategory } from '../../../../shared/skillhubCategory';
import { skillhubCatalogKey, type SkillhubCatalogScope } from '../../../../shared/skillhubCatalog';
import type { HubPublishedVisibility } from '../lib/marketVisibility';
import { filterAvailableMarketItems } from '../lib/marketDetailViewModel';

import { useSkillhub } from './useSkillhub';
import { semverCompare } from '../versionUtils';
import { publishedLocalIdentity, publishedMarketIdentity, type MarketLocalIdentity } from '../lib/marketLocalCopies';

export type SortBy = 'trending' | 'downloads' | 'updated_at' | 'created_at';
export type CatalogScope = 'all' | 'market' | 'team';
/** 'all' 表示不筛分类（显示全部）；其他值是 MarketCategory.slug。 */
export type CategoryFilter = typeof CATEGORY_ALL | string;
/**
 * Market 列表的归属/可获取过滤。
 * - all：可视范围全部（含自己）
 * - mine：仅我自己发布
 * - available：客户端根据本地扫描结果显示"非自己且全局未装"的技能
 */
export type Visibility = 'all' | 'mine' | 'available';

/** Card 上的按钮显示根据这 4 个状态分支。 */
export type MarketCardState =
  | 'not-installed'         // 未装本地 — 显示「安装」
  | 'installed-latest'      // 装了且 == latestVersion — 显示「卸载」
  | 'installed-outdated'    // 装了但 < latestVersion — 显示「更新 vN」
  | 'installing';           // install IPC 进行中 — 显示「下载中…」可点取消

/** 从服务端 ListSkillItem 派生的视图模型。 */
export interface MarketSkill {
  /** 服务端主键 = name,前端 list key 用它。 */
  name: string;
  /** Skill 图标 URL；旧服务响应缺失时保持 undefined。 */
  icon?: string;
  displayName: string;
  description: string;
  authorName: string;
  /** 实际提交当前版本的成员；authorName 仍表示个人或组织归属。 */
  publisherName?: string;
  authorId: string;
  /** 飞书头像 URL;为 null/失败时回落到 avatarInitial 字母。 */
  authorAvatarUrl: string | null;
  /** Latin/中文首字符,用于头像 fallback。 */
  avatarInitial: string;
  isMine: boolean;
  isCreator?: boolean;
  canManage: boolean;
  latestVersion: string;
  visibility: 'PUBLIC' | 'DEPARTMENT_SCOPED';
  publishedVisibility?: HubPublishedVisibility;
  ownerType?: string;
  moderationStatus?: string;
  pendingVersion?: {
    version: string;
    status?: string;
  };
  visibilityReview?: {
    requestedVisibility: 'public';
    status: 'pending' | 'rejected';
    reason?: string;
  };
  visibleDeptIds: string[];
  /** 分类 slug 列表。服务端目前还未返回时给空数组兜底。 */
  categories: string[];
  /** 服务端可搜索标签，保留显示名供详情等消费方使用。 */
  tags: Array<{ slug: string; name: string; source?: 'platform' }>;
  /** Skill 对应的公开仓库地址；null 表示发布者未配置。 */
  githubUrl: string | null;
  publishedAt: string; // ISO
  /** 相对时间显示,如 "3 天前"、"昨天"、"刚刚"。 */
  relativeTime: string;
  /** Hub 统计的下载次数。 */
  downloads: number;
  /** 跨引用本地扫描结果:本地有同名 skill → true。 */
  installedLocally: boolean;
  /** 本地安装的版本号字符串,从 registryEntry.version 派生。null = 未装/未追踪。 */
  installedVersion: string | null;
  /** 本地安装的 absolutePath（卸载时需要），未装为 null。 */
  installedAbsolutePath: string | null;
  /** A newer remote version is available for the registry-backed primary copy. */
  updateAvailable?: boolean;
  /** global 或 project 任何位置有安装（用于显示已装 badge + [+] 按钮）。 */
  hasAnyInstall: boolean;
  /** 跨设备识别：null = pre-feature 历史版本（不亮提示，按 mine 走） */
  latestPublishedFromDeviceId: string | null;
  /** 派生的 card 状态,UI 直接 switch 这个字段决定按钮。 */
  cardState: MarketCardState;
  /** 列表所在的通用目录，后续详情和安装请求必须继续携带。 */
  catalogScope?: SkillhubCatalogScope;
}

interface ServerListItem {
  name: string;
  icon?: string;
  displayName: string;
  description: string;
  authorId: string;
  authorName: string;
  publisherName?: string;
  authorAvatarUrl: string | null;
  isMine: boolean;
  isCreator?: boolean;
  canManage: boolean;
  latestVersion: string;
  visibility: 'PUBLIC' | 'DEPARTMENT_SCOPED';
  publishedVisibility?: HubPublishedVisibility;
  ownerType?: string;
  moderationStatus?: string;
  pendingVersion?: {
    version: string;
    status?: string;
  };
  visibilityReview?: {
    requestedVisibility: 'public';
    status: 'pending' | 'rejected';
    reason?: string;
  };
  visibleDeptIds: string[];
  categories?: string[];
  tags?: Array<{ slug: string; name: string; source?: 'platform' }>;
  githubUrl?: string | null;
  publishedAt: string;
  downloads?: number;
  /** 跨设备识别：null = pre-feature 历史版本 */
  latestPublishedFromDeviceId: string | null;
  catalogScope?: SkillhubCatalogScope;
}

export const MARKET_PAGE_SIZE = 24;

function deriveAvatarInitial(authorName: string): string {
  const trimmed = authorName.trim();
  if (!trimmed) return '?';
  const first = trimmed[0];
  // ASCII letter → 大写;其它字符(中文、emoji 等)原样返回
  return /[a-zA-Z]/.test(first) ? first.toUpperCase() : first;
}

export function formatMarketRelativeTime(iso: string, translate: TFunction, nowMs = Date.now()): string {
  const timestamp = Date.parse(iso);
  if (Number.isNaN(timestamp)) return '';
  const diffMs = nowMs - timestamp;
  if (diffMs < 0) return translate('skillhub.marketCard.relativeTime.justNow');
  const sec = Math.floor(diffMs / 1000);
  if (sec < 60) return translate('skillhub.marketCard.relativeTime.justNow');
  const min = Math.floor(sec / 60);
  if (min < 60) return translate('skillhub.marketCard.relativeTime.minutes', { count: min });
  const hr = Math.floor(min / 60);
  if (hr < 24) return translate('skillhub.marketCard.relativeTime.hours', { count: hr });
  const day = Math.floor(hr / 24);
  if (day === 1) return translate('skillhub.marketCard.relativeTime.yesterday');
  if (day < 7) return translate('skillhub.marketCard.relativeTime.days', { count: day });
  const week = Math.floor(day / 7);
  if (week < 4) return translate('skillhub.marketCard.relativeTime.weeks', { count: week });
  const month = Math.floor(day / 30);
  if (month < 12) return translate('skillhub.marketCard.relativeTime.months', { count: month });
  const year = Math.floor(day / 365);
  return translate('skillhub.marketCard.relativeTime.years', { count: year });
}

export interface LocalSkillEntry {
  /** 版本号字符串来自 registryEntry.version；null = 无 registry 记录。 */
  version: string | null;
  absolutePath: string;
  /** 该本地 skill 是否有 registry 记录（registryEntry !== null）。
      false = 用户手写的本地 skill，从未与市场交互。卸载能力由本地扫描决定。 */
  hasRegistryEntry: boolean;
}

export interface LocalSkillGroup {
  global?: LocalSkillEntry;
  projects: LocalSkillEntry[];
}

export interface LocalSkillIndex {
  /** Registry-backed installs are independent for each remote catalog record. */
  byCatalogKey: Map<string, LocalSkillGroup>;
  /** User-authored local folders have no remote scope and only back owned items. */
  untrackedByName: Map<string, LocalSkillGroup>;
  publishedByIdentity?: Map<string, LocalSkillGroup>;
}

function addLocalEntry(
  index: Map<string, LocalSkillGroup>,
  key: string,
  scope: 'global' | 'project',
  entry: LocalSkillEntry,
): void {
  let group = index.get(key);
  if (!group) {
    group = { global: undefined, projects: [] };
    index.set(key, group);
  }
  if (scope === 'global') group.global ??= entry;
  else group.projects.push(entry);
}

export function localGroupForItem(
  item: MarketLocalIdentity,
  index: LocalSkillIndex,
): LocalSkillGroup | undefined {
  const identity = publishedMarketIdentity(item);
  const authored = identity ? index.publishedByIdentity?.get(identity) : undefined;
  const exact = index.byCatalogKey.get(skillhubCatalogKey(item.name, item.catalogScope));
  const tracked = exact && authored ? {
    global: exact.global ?? authored.global, projects: [...exact.projects, ...authored.projects],
  } : exact ?? authored;
  if (!item.isMine) return tracked;
  const untracked = index.untrackedByName.get(item.name);
  if (!tracked) return untracked;
  if (!untracked) return tracked;
  return {
    global: tracked.global ?? untracked.global,
    projects: [...tracked.projects, ...untracked.projects],
  };
}

export function deriveCardState(
  item: ServerListItem,
  group: LocalSkillGroup | undefined,
  installing: boolean,
): MarketCardState {
  if (installing) return 'installing';
  // 只看 global 位置决定 cardState（影响"可获取"筛选）。
  // project-level 安装不改变卡片主状态，用户仍可从 target picker 装到其他位置。
  const g = group?.global;
  // 自己发布的 skill 可能没有 registry —— 全局目录存在时仍能判定已装。
  // 换机器 / 卸载后本地无目录 → not-installed，进入「可获取」可重新下载（修正 !isMine 排除 bug）。
  if (item.isMine) return g ? 'installed-latest' : 'not-installed';
  if (!g || !g.hasRegistryEntry) return 'not-installed';
  if (g.version === null) return 'installed-latest';
  if (g.version === item.latestVersion) return 'installed-latest';
  return semverCompare(item.latestVersion, g.version) > 0 ? 'installed-outdated' : 'installed-latest';
}

export function deriveLocalInstall(
  item: Pick<MarketSkill, 'isMine' | 'latestVersion'>,
  group: LocalSkillGroup | undefined,
) {
  // Keep the badge and update action on the same copy: global, then first project.
  const primary = group?.global ?? group?.projects[0];
  const installed = !!primary && (item.isMine || primary.hasRegistryEntry);
  return {
    installedLocally: installed,
    installedVersion: installed ? primary.version : null,
    installedAbsolutePath: installed ? primary.absolutePath : null,
    updateAvailable: !!primary?.hasRegistryEntry && !!primary.version
      && semverCompare(item.latestVersion, primary.version) > 0,
    hasAnyInstall: !!group && (
      !!group.global?.hasRegistryEntry || group.projects.some((entry) => entry.hasRegistryEntry)
    ),
  };
}

function mapServerToView(
  item: ServerListItem,
  localIndex: LocalSkillIndex,
  installingNames: Set<string>,
  translate: TFunction,
): MarketSkill {
  const group = localGroupForItem(item, localIndex);
  return {
    name: item.name,
    icon: item.icon,
    displayName: item.displayName,
    description: item.description,
    authorName: item.authorName,
    publisherName: item.publisherName || item.authorName,
    authorId: item.authorId,
    authorAvatarUrl: item.authorAvatarUrl ?? null,
    avatarInitial: deriveAvatarInitial(item.authorName),
    isMine: item.isMine,
    isCreator: item.isCreator,
    canManage: item.canManage,
    latestVersion: item.latestVersion,
    visibility: item.visibility,
    publishedVisibility: item.publishedVisibility,
    ownerType: item.ownerType,
    moderationStatus: item.moderationStatus,
    pendingVersion: item.pendingVersion,
    visibilityReview: item.visibilityReview,
    visibleDeptIds: item.visibleDeptIds,
    categories: item.categories ?? [],
    tags: item.tags ?? [],
    githubUrl: item.githubUrl ?? null,
    publishedAt: item.publishedAt,
    relativeTime: formatMarketRelativeTime(item.publishedAt, translate),
    downloads: Number.isFinite(item.downloads) ? item.downloads ?? 0 : 0,
    ...deriveLocalInstall(item, group),
    latestPublishedFromDeviceId: item.latestPublishedFromDeviceId,
    cardState: deriveCardState(item, group, installingNames.has(item.name)),
    catalogScope: item.catalogScope,
  };
}

interface MarketListState {
  queryKey: string | null;
  items: MarketSkill[];
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
  nextCursor: string | null;
  resolvedScope: CatalogScope | null;
  resolvedMine: boolean | null;
}

const INITIAL: MarketListState = {
  queryKey: null,
  items: [],
  loading: false,
  loadingMore: false,
  error: null,
  nextCursor: null,
  resolvedScope: null,
  resolvedMine: null,
};

interface FetchMarketPageInput {
  cursor?: string;
  sort: SortBy;
  q: string;
  scope: CatalogScope;
  mine: boolean;
  category?: string;
}

type MarketPageResult =
  | { success: true; items: MarketSkill[]; nextCursor: string | null }
  | { success: false; error?: string };

export function useMarketList(
  initialVisibility: Visibility = 'all',
  options?: {
    /**
     * false 时完全不发市场请求(items 保持空、loading 保持 false)。
     * 供本地技能 Tab 跳过云端请求与骨架屏；切回云端目录后自动补拉。
     */
    enabled?: boolean;
    /** Initial server-side catalog partition; `all` preserves historical behavior. */
    initialScope?: CatalogScope;
    /** Fixed catalog surfaces can avoid an extra request by declaring their initial sort. */
    initialSort?: SortBy;
    initialSearchQuery?: string;
    initialCategoryFilter?: CategoryFilter;
  },
) {
  const enabled = options?.enabled ?? true;
  const owner = getDataOwnerGeneration();
  const { t, i18n: i18next } = useTranslation();
  const [searchQuery, setSearchQueryState] = useState(options?.initialSearchQuery ?? '');
  const [sortBy, setSortByState] = useState<SortBy>(() => options?.initialSort ?? 'updated_at');
  const [catalogScope, setCatalogScopeState] = useState<CatalogScope>(
    () => options?.initialScope ?? 'all',
  );
  const [categoryFilter, setCategoryFilterState] = useState<CategoryFilter>(options?.initialCategoryFilter ?? CATEGORY_ALL);
  // 默认展示当前身份可见的完整目录；“我的管理”由列表页显式切换。
  const [visibility, setVisibilityState] = useState<Visibility>(() => initialVisibility);
  const [state, setState] = useState<MarketListState>(INITIAL);
  // 当前正在跑 install 的 name 集合（按 name 串行；同 name 不能重复触发）
  const [installingNames, setInstallingNames] = useState<Set<string>>(() => new Set());

  // 本地扫描结果用来派生 cardState。useSkillhub 是模块级 store,跨组件共享。
  const { skills: localSkills } = useSkillhub();

  // Registry-backed installs use catalog+name; untracked local folders are a
  // separate fallback for owned items only.
  const localIndex: LocalSkillIndex = {
    ...(() => {
      const byCatalogKey = new Map<string, LocalSkillGroup>();
      const untrackedByName = new Map<string, LocalSkillGroup>();
      const publishedByIdentity = new Map<string, LocalSkillGroup>();
      for (const s of localSkills) {
        if (s.kind !== 'skill') continue;
        const entry: LocalSkillEntry = {
          version: s.registryEntry?.version ?? null,
          absolutePath: s.absolutePath,
          hasRegistryEntry: s.registryEntry !== null,
        };
        const index = s.registryEntry ? byCatalogKey : untrackedByName;
        const key = s.registryEntry
          ? skillhubCatalogKey(s.registrySkillName ?? s.name, s.registryEntry.catalogScope)
          : s.name;
        addLocalEntry(index, key, s.scope, entry);
        const identity = publishedLocalIdentity(s);
        if (identity) addLocalEntry(publishedByIdentity, identity, s.scope, entry);
      }
      return { byCatalogKey, untrackedByName, publishedByIdentity };
    })(),
  };

  // 用 ref 让 fetchPage 始终读到最新的 localIndex/installingNames，避免 useCallback([])
  // 闭包捕获旧值。后置 useEffect 也会再 derive 一次兜底。
  const localIndexRef = useRef(localIndex);
  localIndexRef.current = localIndex;
  const installingNamesRef = useRef(installingNames);
  installingNamesRef.current = installingNames;
  const translateRef = useRef(t);
  translateRef.current = t;
  const languageKey = i18next.resolvedLanguage ?? i18next.language;

  // Stale-guard:防止快速切换 sort/q 时旧响应覆盖新结果。
  const requestIdRef = useRef(0);

  const requestMarketPage = useCallback(async (params: FetchMarketPageInput): Promise<MarketPageResult> => {
    const res = await window.electronAPI.skillhub.listMarket({
      cursor: params.cursor,
      limit: MARKET_PAGE_SIZE,
      sort: params.sort,
      q: params.q || undefined,
      scope: params.scope,
      mine: params.mine,
      available: false,
      category: params.category,
    });
    if (!isDataOwnerGenerationCurrent(owner)) return { success: false };
    if (!res.success) return { success: false, error: res.error };
    return {
      success: true,
      items: (res.items ?? []).map((it: ServerListItem) =>
        mapServerToView(it, localIndexRef.current, installingNamesRef.current, translateRef.current),
      ),
      nextCursor: res.nextCursor ?? null,
    };
  }, [owner]);

  const collectVisiblePage = useCallback(async (
    params: FetchMarketPageInput & { available: boolean },
  ): Promise<MarketPageResult> => {
    const collected: MarketSkill[] = [];
    let cursor = params.cursor;
    let nextCursor: string | null = null;

    do {
      const res = await requestMarketPage({
        cursor,
        sort: params.sort,
        q: params.q,
        scope: params.scope,
        mine: params.mine,
        category: params.category,
      });
      if (!res.success) return res;

      const pageItems = params.available
        ? filterAvailableMarketItems(res.items ?? [])
        : (res.items ?? []);
      collected.push(...pageItems);
      nextCursor = res.nextCursor ?? null;
      cursor = nextCursor ?? undefined;
    } while (params.available && collected.length < MARKET_PAGE_SIZE && nextCursor);

    return {
      success: true as const,
      items: collected,
      nextCursor,
    };
  }, [requestMarketPage]);

  const fetchPage = useCallback(
    async (params: {
      sort: SortBy;
      q: string;
      scope: CatalogScope;
      mine: boolean;
      available: boolean;
      category?: string;
    }) => {
      const myId = ++requestIdRef.current;
      const queryKey = JSON.stringify([owner, params]);
      setState((prev) => ({
        ...(prev.queryKey === queryKey ? prev : INITIAL),
        queryKey, loading: true, loadingMore: false, error: null,
        resolvedScope: params.scope, resolvedMine: params.mine,
      }));
      const fail = (error: string) => setState((prev) => ({ ...prev, loading: false, loadingMore: false, error }));
      try {
        const res = await collectVisiblePage({
          sort: params.sort,
          q: params.q,
          scope: params.scope,
          mine: params.mine,
          available: params.available,
          category: params.category,
        });
        if (myId !== requestIdRef.current || !isDataOwnerGenerationCurrent(owner)) return; // 旧响应,丢弃
        if (!res.success) {
          fail(res.error ?? i18n.t('skillhub.market.installError'));
          return;
        }
        setState({
          queryKey,
          items: res.items ?? [],
          loading: false,
          loadingMore: false,
          error: null,
          nextCursor: res.nextCursor ?? null,
          resolvedScope: params.scope,
          resolvedMine: params.mine,
        });
      } catch (err) {
        if (myId !== requestIdRef.current || !isDataOwnerGenerationCurrent(owner)) return;
        fail(err instanceof Error ? err.message : String(err));
      }
    },
    // installedNames/localIndex 通过 ref 读取最新值；
    // fetchPage 自身只由 sort/q/mine 调用方参数驱动。
    [collectVisiblePage, owner],
  );

  const loadMore = useCallback(async () => {
    const cursor = state.nextCursor;
    if (!cursor || state.loadingMore || state.loading) return;
    const myId = requestIdRef.current;
    setState((prev) => ({ ...prev, loadingMore: true, error: null }));
    try {
      const res = await collectVisiblePage({
        cursor,
        sort: sortBy,
        q: searchQuery,
        scope: catalogScope,
        mine: visibility === 'mine',
        available: visibility === 'available',
        category: categoryFilter !== CATEGORY_ALL ? categoryFilter : undefined,
      });
      if (myId !== requestIdRef.current || !isDataOwnerGenerationCurrent(owner)) return;
      if (!res.success) {
        setState((prev) => ({ ...prev, loadingMore: false, error: res.error ?? i18n.t('skillhub.market.installError') }));
        return;
      }
      setState((prev) => ({
        ...prev,
        items: [...prev.items, ...(res.items ?? [])],
        loadingMore: false,
        nextCursor: res.nextCursor ?? null,
      }));
    } catch (err) {
      if (myId !== requestIdRef.current || !isDataOwnerGenerationCurrent(owner)) return;
      setState((prev) => ({ ...prev, loadingMore: false, error: err instanceof Error ? err.message : String(err) }));
    }
  }, [state.nextCursor, state.loadingMore, state.loading, sortBy, searchQuery, catalogScope, visibility, categoryFilter, collectVisiblePage, owner]);

  // 外部主动刷新(删除/改可见性后)→ bump tick 触发重拉
  const [reloadTick, setReloadTick] = useState(0);
  const reload = useCallback(() => setReloadTick((tick) => tick + 1), []);

  // sort/q/visibility/category 任一变化 → 重发请求,从第一页开始。
  // enabled=false 时跳过(不可见账号不触网);翻回 true 时本效果重跑,自动补拉。
  useEffect(() => {
    if (!enabled) return;
    void fetchPage({
      sort: sortBy,
      q: searchQuery,
      scope: catalogScope,
      mine: visibility === 'mine',
      available: visibility === 'available',
      category: categoryFilter !== CATEGORY_ALL ? categoryFilter : undefined,
    });
    return () => { requestIdRef.current++; };
  }, [enabled, sortBy, searchQuery, catalogScope, visibility, categoryFilter, fetchPage, reloadTick]);

  // 当本地扫描结果或 installing 集合变化时,只重新派生 cardState/installedVersion,不重发请求。
  // Include catalog scope so a same-slug install moving between catalogs remaps immediately.
  const localKey = localSkills
    .filter((s) => s.kind === 'skill')
    .map((s) => `${s.registrySkillName ?? s.name}@${s.registryEntry?.origin}@${s.registryEntry?.authorId}@${s.registryEntry?.catalogScope ?? 'native'}@${s.registryEntry?.version ?? '?'}@${s.registryEntry !== null ? 'R' : '_'}@${s.absolutePath}`)
    .join('|');
  const installingKey = Array.from(installingNames).sort().join(',');
  useEffect(() => {
    setState((prev) => {
      if (prev.items.length === 0) return prev;
      const remapped = prev.items.map((it) => {
        const group = localGroupForItem(it, localIndex);
        return {
          ...it,
          ...deriveLocalInstall(it, group),
          relativeTime: formatMarketRelativeTime(it.publishedAt, translateRef.current),
          cardState: deriveCardState(
            {
              ...it,
              isMine: it.isMine,
              latestVersion: it.latestVersion,
              pendingVersion: it.pendingVersion,
              latestPublishedFromDeviceId: it.latestPublishedFromDeviceId,
            } as ServerListItem,
            group,
            installingNames.has(it.name),
          ),
        };
      });
      const finalItems = visibility === 'available' ? filterAvailableMarketItems(remapped) : remapped;
      return { ...prev, items: finalItems };
    });
  }, [localKey, installingKey, languageKey, visibility]);

  const setSearchQuery = useCallback((q: string) => setSearchQueryState(q), []);
  const setSortBy = useCallback((s: SortBy) => setSortByState(s), []);
  const setCatalogScope = useCallback((scope: CatalogScope) => setCatalogScopeState(scope), []);
  const setCategoryFilter = useCallback((slug: CategoryFilter) => setCategoryFilterState(slug), []);
  const setVisibility = useCallback((v: Visibility) => setVisibilityState(v), []);

  // install 集合修改：组件层调用 markInstalling/clearInstalling 包住 IPC 调用
  const markInstalling = useCallback((name: string) => {
    setInstallingNames((prev) => {
      if (prev.has(name)) return prev;
      const next = new Set(prev);
      next.add(name);
      return next;
    });
  }, []);

  const clearInstalling = useCallback((name: string) => {
    setInstallingNames((prev) => {
      if (!prev.has(name)) return prev;
      const next = new Set(prev);
      next.delete(name);
      return next;
    });
  }, []);

  const currentQueryKey = JSON.stringify([owner, {
    sort: sortBy, q: searchQuery, scope: catalogScope,
    mine: visibility === 'mine', available: visibility === 'available',
    category: categoryFilter !== CATEGORY_ALL ? categoryFilter : undefined,
  }]);
  const visibleState = state.queryKey === currentQueryKey ? state : INITIAL;
  return {
    items: visibleState.items,
    loading: visibleState.loading,
    loadingMore: visibleState.loadingMore,
    error: visibleState.error,
    hasMore: visibleState.nextCursor !== null,
    resolvedScope: visibleState.resolvedScope,
    resolvedMine: visibleState.resolvedMine,
    searchQuery,
    sortBy,
    catalogScope,
    categoryFilter,
    visibility,
    setSearchQuery,
    setSortBy,
    setCatalogScope,
    setCategoryFilter,
    setVisibility,
    loadMore,
    reload,
    installingNames,
    markInstalling,
    clearInstalling,
  };
}

interface CategoryListState {
  categories: MarketCategory[];
  totalCount: number;
  myTotalCount: number;
}

const EMPTY_CATEGORY_STATE: CategoryListState = { categories: [], totalCount: 0, myTotalCount: 0 };

interface ScopedCategoryListState {
  owner: DataOwnerGeneration;
  scope: SkillhubCatalogScope;
  value: CategoryListState;
}

// 仅在同一数据所有者代际、同一目录作用域内合并并发请求。账号边界推进后必须
// 发起新请求，避免新账号复用旧账号仍在飞行中的分类响应。
const inflightCategories = new Map<
  DataOwnerGeneration,
  Map<SkillhubCatalogScope, Promise<CategoryListState>>
>();

export function useCategoryList(scope: SkillhubCatalogScope = 'market'): CategoryListState {
  const owner = getDataOwnerGeneration();
  const [state, setState] = useState<ScopedCategoryListState>({
    owner,
    scope,
    value: EMPTY_CATEGORY_STATE,
  });

  useEffect(() => {
    let cancelled = false;
    const ownerInflight =
      inflightCategories.get(owner) ??
      new Map<SkillhubCatalogScope, Promise<CategoryListState>>();
    if (!inflightCategories.has(owner)) inflightCategories.set(owner, ownerInflight);
    const existing = ownerInflight.get(scope);
    const inflight = existing ?? window.electronAPI.skillhub.listCategories({ scope, includeEmpty: false })
      .then((res) => (res.success
        ? { categories: res.categories ?? [], totalCount: res.totalCount ?? 0, myTotalCount: res.myTotalCount ?? 0 }
        : EMPTY_CATEGORY_STATE))
      .catch(() => EMPTY_CATEGORY_STATE);
    if (!existing) ownerInflight.set(scope, inflight);
    void inflight.then((next) => {
      if (ownerInflight.get(scope) === inflight) ownerInflight.delete(scope);
      if (ownerInflight.size === 0 && inflightCategories.get(owner) === ownerInflight) {
        inflightCategories.delete(owner);
      }
      if (!cancelled && isDataOwnerGenerationCurrent(owner)) {
        setState({ owner, scope, value: next });
      }
    });
    return () => { cancelled = true; };
  }, [owner, scope]);

  return state.owner === owner && state.scope === scope ? state.value : EMPTY_CATEGORY_STATE;
}
