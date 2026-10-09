import { groupAutomationListItems } from '@cindy/maker-shared/session-list';
import { mobilePresentationLocalizer } from '@/i18n/presentationLocalizer';
import {
  activeContentFilterCount,
  DAY_MS,
  HOME_DIALOGUE_FILTER_KEY,
  LAST_ACTIVITY_DAYS,
  projectFilterIncludes,
  type HomeContentFilters,
  type HomeVendorFilter,
} from './homeDisplaySettings';
import { activityMsFromIso } from './homeListPriority';
import type { MobileHomePresentation } from './mobileHome';
import {
  createSessionListTranslator,
  localizeRemoteSessionListItem,
  type RemoteSessionListItem,
} from './sessionList';

// 首页「筛选」(项目 / Harness / 最近活跃)作用到展示模型。与 homeDisplaySettings 分开:
// 自动化组部分命中时要重新折叠并本地化,依赖 i18n;设置本身的纯逻辑不应带上这条依赖。

/**
 * 单条任务行的筛选器:返回筛后的行,整行不保留时返回 null。
 * 自动化组按组内每次运行单独筛选(组代表可能是较旧的运行,不能只看代表),
 * 部分命中时用剩下的运行重新折叠成组,组内只留匹配项、计数随之变化。
 */
export function createHomeContentFilter(
  filters: HomeContentFilters,
  nowMs: number,
): ((item: RemoteSessionListItem) => RemoteSessionListItem | null) | null {
  if (filters.vendor === 'all' && filters.lastActivity === 'all') return null;
  const cutoff = filters.lastActivity === 'all'
    ? null
    : nowMs - LAST_ACTIVITY_DAYS[filters.lastActivity] * DAY_MS;
  const keep = (item: RemoteSessionListItem): boolean => {
    if (filters.vendor !== 'all' && sessionVendor(item) !== filters.vendor) return false;
    if (cutoff !== null && activityMsFromIso(item.lastActivityAt) < cutoff) return false;
    return true;
  };
  let translate: ReturnType<typeof createSessionListTranslator> | null = null;
  return (item) => {
    const group = item.automationGroup;
    if (!group) return keep(item) ? item : null;
    const runs = group.items.filter(keep);
    if (runs.length === group.items.length) return item;
    if (runs.length === 0) return null;
    // 只剩一次运行时退化为普通行(组内成员已本地化)。
    if (runs.length === 1) return runs[0];
    // 与 buildMobileHomePresentation 同一流水线:先折叠再本地化。组内运行同一组键,理应折回一组;
    // 万一不是,保留原组行而不是丢掉其余运行。
    const regroupedRows = groupAutomationListItems(runs, nowMs, true, undefined, mobilePresentationLocalizer);
    const regrouped = regroupedRows.length === 1 ? regroupedRows[0] : undefined;
    if (!regrouped?.automationGroup) return item;
    translate ??= createSessionListTranslator();
    return {
      ...localizeRemoteSessionListItem(regrouped, nowMs, translate),
      automationGroup: { ...regrouped.automationGroup, key: group.key, baseKey: group.baseKey },
    };
  };
}

function filterItems(
  items: readonly RemoteSessionListItem[],
  filter: (item: RemoteSessionListItem) => RemoteSessionListItem | null,
): RemoteSessionListItem[] {
  const next: RemoteSessionListItem[] = [];
  for (const item of items) {
    const kept = filter(item);
    if (kept) next.push(kept);
  }
  return next;
}

/**
 * 按筛选收窄首页展示模型。与桌面侧栏一致(设计文档 §3.3,2026-08-12 用户重申):
 * **筛选一律不作用于置顶区**——置顶是「我要一直看见它」,被筛掉会让人以为置顶丢了。
 * 项目筛选作用于项目组与对话;Harness / 最近活跃作用于项目组与对话里的任务。
 * 筛完为空的项目组整组隐藏。共享任务分组见 filterSharedHomeRows。
 */
export function applyHomeContentFilters(
  home: MobileHomePresentation,
  filters: HomeContentFilters,
  nowMs: number,
): MobileHomePresentation {
  if (activeContentFilterCount(filters) === 0) return home;
  const filter = createHomeContentFilter(filters, nowMs);
  const narrow = (items: readonly RemoteSessionListItem[]) => (filter ? filterItems(items, filter) : [...items]);
  const projects = home.projects.flatMap((project) => {
    if (!projectFilterIncludes(filters.projects, project.key)) return [];
    const sessions = narrow(project.sessions);
    if (sessions.length === 0) return [];
    const unchanged = sessions.length === project.sessions.length
      && sessions.every((item, index) => item === project.sessions[index]);
    return [unchanged ? project : { ...project, sessionCount: sessions.length, sessions }];
  });
  return {
    ...home,
    chats: projectFilterIncludes(filters.projects, HOME_DIALOGUE_FILTER_KEY) ? narrow(home.chats) : [],
    pinned: home.pinned,
    projects,
  };
}

/**
 * 共享任务分组与置顶同口径:受 Harness / 最近活跃筛选,不受项目筛选。
 * 只有账号发现、本机还没有会话数据的行没有可判断的字段,原样保留。
 */
export function filterSharedHomeRows<Row extends { item?: RemoteSessionListItem }>(
  rows: readonly Row[],
  filters: HomeContentFilters,
  nowMs: number,
): readonly Row[] {
  const filter = createHomeContentFilter(filters, nowMs);
  if (!filter) return rows;
  return rows.flatMap((row) => {
    if (!row.item) return [row];
    const item = filter(row.item);
    if (!item) return [];
    return [item === row.item ? row : { ...row, item }];
  });
}

function sessionVendor(item: RemoteSessionListItem): HomeVendorFilter {
  const kind = (item.session as { agentKind?: unknown }).agentKind;
  return kind === 'codex' || kind === 'pi' ? kind : 'cc';
}
