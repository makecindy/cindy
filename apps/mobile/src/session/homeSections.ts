import { i18n } from '@/i18n';
import type { MobileHomePresentation, MobileHomeProjectGroup } from './mobileHome';
import {
  activityMsFromIso,
  EMPTY_HOME_PRIORITY_CONTEXT,
  sessionPriorityRank,
  sessionPriorityRecencyMs,
  type HomeListPriorityContext,
  type HomeListSortBy,
} from './homeListPriority';
import {
  normalizeManualProjectOrder,
  type HomeProjectOrder,
} from './homeProjectOrder';
import type { RemoteSessionListItem } from './sessionList';

/** 首页列表的一行:项目分组头、对话分组头,或一条会话(置顶 / 普通 / 项目内)。 */
export type HomeRow =
  | { key: string; kind: 'project'; project: MobileHomeProjectGroup }
  | { key: string; kind: 'dialogue'; project: MobileHomeProjectGroup }
  | {
      key: string;
      kind: 'session';
      item: RemoteSessionListItem;
      source: 'chat' | 'pinned' | 'project' | 'search';
      /** 仅平铺(未按项目分组)的顶层会话行:项目名或「对话」。 */
      sourceLabel?: string;
    };

/** SectionList 的一个分区。title 为 null 的分区不渲染表头。 */
export type HomeSection = { data: HomeRow[]; key: string; title: string | null };

/** 主列表分区跨分组模式保持同一身份，避免 SectionList 把仍存在的行整批卸载重挂。 */
export const HOME_MAIN_SECTION_KEY = 'main';

export interface HomeSectionOptions {
  groupDialogue?: boolean;
  sortBy?: HomeListSortBy;
  projectOrder?: HomeProjectOrder;
  manualProjectOrder?: readonly string[];
  priorityContext?: HomeListPriorityContext;
  dialogueTitle?: string;
  /** 仅平铺对话行使用;分组模式下不要传,对齐桌面「项目分组下不带来源标签」。 */
  sourceLabel?: string;
}

/**
 * 把 home 展示模型拆成 SectionList 的分区(纯函数,便于单测)。
 * - 置顶单独成区;`pinnedCollapsed` 时清空 data 但**保留分区**(SectionList 对空 data 仍渲染
 *   表头,所以折叠时表头照常显示,只折叠下属会话)。
 * - 分组模式保留项目 folder 行,与普通对话(或对话组)按活动时间 / 优先级倒序混排。
 * - 非分组模式把项目下属会话展平;对话组开启时对话仍收成一个 folder。
 */
export function buildHomeSections(
  home: MobileHomePresentation,
  groupByProject: boolean,
  pinnedCollapsed: boolean,
  options: HomeSectionOptions = {},
): HomeSection[] {
  const sections: HomeSection[] = [];
  if (home.pinned.length > 0) {
    sections.push({
      data: pinnedCollapsed
        ? []
        : home.pinned.map((item) => ({ item, key: `pinned:${item.session.id}`, kind: 'session', source: 'pinned' })),
      key: 'pinned',
      title: i18n.t('session.row.pinnedSection'),
    });
  }

  const rows = groupByProject ? buildGroupedHomeRows(home, options) : buildMixedHomeRows(home, options);
  if (rows.length > 0) {
    sections.push({
      data: rows,
      key: HOME_MAIN_SECTION_KEY,
      title: null,
    });
  }
  return sections;
}

/**
 * 取某行在整个列表里的前一行:同 section 内取 index-1;section 首行跨区取前一个
 * **非空** section 的末行(置顶收起时 pinned 区 data 为空,要跳过)。
 * SectionList 的 renderItem 只给区内 index,置顶区 → 主列表边界的分割线唯一化
 * (prevIsBlock)必须跨区看邻接,否则相邻块的边线可能叠成双线。
 */
export function homeRowBefore(
  sections: HomeSection[],
  sectionKey: string,
  index: number,
): HomeRow | undefined {
  const sectionIndex = sections.findIndex((section) => section.key === sectionKey);
  if (sectionIndex < 0) return undefined;
  if (index > 0) return sections[sectionIndex].data[index - 1];
  for (let i = sectionIndex - 1; i >= 0; i -= 1) {
    const data = sections[i].data;
    if (data.length > 0) return data[data.length - 1];
  }
  return undefined;
}

export function isFolderHomeRow(row: HomeRow | undefined): row is Extract<HomeRow, { kind: 'project' | 'dialogue' }> {
  return !!row && (row.kind === 'project' || row.kind === 'dialogue');
}

/**
 * Fast path for folder rows rebuilt from the same home presentation. Switching
 * grouping modes sorts into fresh arrays, but the session items themselves are
 * still the same objects. Recognizing that case keeps HomeListRow from
 * serializing a large project/dialogue tree just to prove it did not change.
 */
export function homeFolderRowsShareRenderData(previous: HomeRow, next: HomeRow): boolean {
  if (Object.is(previous, next)) return true;
  if (!isFolderHomeRow(previous) || !isFolderHomeRow(next)) return false;
  if (previous.kind !== next.kind || previous.key !== next.key) return false;
  const a = previous.project;
  const b = next.project;
  return a.deviceId === b.deviceId
    && a.deviceName === b.deviceName
    && a.key === b.key
    && a.latestActivityAt === b.latestActivityAt
    && a.pendingInteractionCount === b.pendingInteractionCount
    && a.sessionCount === b.sessionCount
    && a.subtitle === b.subtitle
    && a.title === b.title
    && a.workingDir === b.workingDir
    && a.sessions.length === b.sessions.length
    && a.sessions.every((item, index) => item === b.sessions[index]);
}

/**
 * Recognizes rebuilt row wrappers that still describe the exact same rendered
 * data. buildHomeSections creates fresh wrappers whenever a display preference
 * changes; session rows can use the same reference fast path as folder rows
 * instead of serializing the complete RemoteSessionListItem for comparison.
 */
export function homeRowsShareRenderData(previous: HomeRow, next: HomeRow): boolean {
  if (Object.is(previous, next)) return true;
  if (previous.kind === 'session' && next.kind === 'session') {
    return previous.key === next.key
      && previous.source === next.source
      && previous.sourceLabel === next.sourceLabel
      && previous.item === next.item;
  }
  return homeFolderRowsShareRenderData(previous, next);
}

export function buildProjectHomeRows(
  home: MobileHomePresentation,
  options: HomeSectionOptions = {},
): HomeRow[] {
  return home.projects.map((project) => ({
    key: project.key,
    kind: 'project' as const,
    project: withSortedProjectSessions(project, options),
  }));
}

export function buildDialogueHomeRows(
  home: MobileHomePresentation,
  options: HomeSectionOptions = {},
): HomeRow[] {
  const sourceLabel = options.sourceLabel;
  const items = sortSessionItems(home.chats, options);
  return items.map((item) => ({
    item,
    key: `chat:${item.automationGroup?.key ?? item.session.id}`,
    kind: 'session' as const,
    source: 'chat' as const,
    sourceLabel,
  }));
}

export function buildDialogueGroupRow(
  home: MobileHomePresentation,
  options: HomeSectionOptions = {},
): HomeRow | null {
  if (home.chats.length === 0) return null;
  const title = options.dialogueTitle ?? i18n.t('devices.list.menu.dialogueFolder');
  const sessions = sortSessionItems(home.chats, options);
  return {
    key: 'dialogue',
    kind: 'dialogue',
    project: {
      deviceId: null,
      deviceName: '',
      key: 'dialogue',
      latestActivityAt: latestActivityAt(sessions),
      pendingInteractionCount: sessions.reduce((sum, item) => sum + item.pendingInteractionCount, 0),
      sessionCount: sessions.length,
      sessions,
      subtitle: '',
      title,
      workingDir: '',
    },
  };
}

/** 混排模式:项目下属会话展平;对话组开启时对话收成 folder,否则对话也展平。 */
export function buildMixedHomeRows(
  home: MobileHomePresentation,
  options: HomeSectionOptions = {},
): HomeRow[] {
  const dialogueTitle = options.dialogueTitle ?? i18n.t('devices.list.menu.dialogueFolder');
  const rows: HomeRow[] = home.projects.flatMap((project) =>
    sortSessionItems(project.sessions, options).map((item) => ({
      item,
      key: `project:${project.key}:${item.automationGroup?.key ?? item.session.id}`,
      kind: 'session' as const,
      source: 'project' as const,
      sourceLabel: project.title,
    })),
  );
  if (options.groupDialogue) {
    const folder = buildDialogueGroupRow(home, { ...options, dialogueTitle });
    if (folder) rows.push(folder);
  } else {
    rows.push(...buildDialogueHomeRows(home, { ...options, sourceLabel: dialogueTitle }));
  }
  return sortHomeRows(rows, options);
}

/** 分组模式:项目保留 folder 行;对话组开启时对话也收成 folder,否则按会话混排。 */
export function buildGroupedHomeRows(
  home: MobileHomePresentation,
  options: HomeSectionOptions = {},
): HomeRow[] {
  const rows: HomeRow[] = [...buildProjectHomeRows(home, options)];
  if (options.groupDialogue) {
    const folder = buildDialogueGroupRow(home, options);
    if (folder) rows.push(folder);
  } else {
    rows.push(...buildDialogueHomeRows(home, options));
  }
  return sortHomeRows(rows, options);
}

function withSortedProjectSessions(
  project: MobileHomeProjectGroup,
  options: HomeSectionOptions,
): MobileHomeProjectGroup {
  const sessions = sortSessionItems(project.sessions, options);
  return {
    ...project,
    latestActivityAt: latestActivityAt(sessions) || project.latestActivityAt,
    sessions,
  };
}

function sortSessionItems(
  items: readonly RemoteSessionListItem[],
  options: HomeSectionOptions,
): RemoteSessionListItem[] {
  const ctx = options.priorityContext ?? EMPTY_HOME_PRIORITY_CONTEXT;
  if (options.sortBy === 'priority') {
    return items.slice().sort((a, b) => compareSessionItemsByPriority(a, b, ctx));
  }
  return items.slice().sort((a, b) =>
    b.lastActivityAt.localeCompare(a.lastActivityAt) || a.session.id.localeCompare(b.session.id));
}

function sortHomeRows(rows: HomeRow[], options: HomeSectionOptions): HomeRow[] {
  if (options.projectOrder === 'custom') {
    const projects = rows.filter((row): row is Extract<HomeRow, { kind: 'project' }> => row.kind === 'project');
    const rest = rows.filter((row) => row.kind !== 'project');
    const order = normalizeManualProjectOrder(
      options.manualProjectOrder ?? [],
      projects.map((row) => row.project.key),
    );
    const rank = new Map(order.map((key, index) => [key, index]));
    projects.sort((a, b) =>
      (rank.get(a.project.key) ?? Number.MAX_SAFE_INTEGER)
      - (rank.get(b.project.key) ?? Number.MAX_SAFE_INTEGER)
      || a.key.localeCompare(b.key));
    return [...projects, ...sortHomeRowsByTaskSort(rest, options)];
  }
  return sortHomeRowsByTaskSort(rows, options);
}

function sortHomeRowsByTaskSort(rows: HomeRow[], options: HomeSectionOptions): HomeRow[] {
  const ctx = options.priorityContext ?? EMPTY_HOME_PRIORITY_CONTEXT;
  if (options.sortBy === 'priority') {
    return rows.slice().sort((a, b) =>
      homeRowPriorityRank(a, ctx) - homeRowPriorityRank(b, ctx)
      || homeRowPriorityRecencyMs(b, ctx) - homeRowPriorityRecencyMs(a, ctx)
      || a.key.localeCompare(b.key));
  }
  return rows.slice().sort(compareHomeRowsByActivityDesc);
}

function compareSessionItemsByPriority(
  a: RemoteSessionListItem,
  b: RemoteSessionListItem,
  ctx: HomeListPriorityContext,
): number {
  return sessionPriorityRank(a.session.id, ctx) - sessionPriorityRank(b.session.id, ctx)
    || sessionPriorityRecencyMs(b.session.id, activityMsFromIso(b.lastActivityAt), ctx)
      - sessionPriorityRecencyMs(a.session.id, activityMsFromIso(a.lastActivityAt), ctx)
    || a.session.id.localeCompare(b.session.id);
}

function compareHomeRowsByActivityDesc(a: HomeRow, b: HomeRow): number {
  return homeRowActivity(b).localeCompare(homeRowActivity(a)) || a.key.localeCompare(b.key);
}

function homeRowActivity(row: HomeRow): string {
  return row.kind === 'session' ? row.item.lastActivityAt : row.project.latestActivityAt;
}

function homeRowSessionItems(row: HomeRow): readonly RemoteSessionListItem[] {
  return row.kind === 'session' ? [row.item] : row.project.sessions;
}

function homeRowPriorityRank(row: HomeRow, ctx: HomeListPriorityContext): number {
  let min = Number.POSITIVE_INFINITY;
  for (const item of homeRowSessionItems(row)) {
    const rank = sessionPriorityRank(item.session.id, ctx);
    if (rank < min) min = rank;
    if (min === 0) break;
  }
  return Number.isFinite(min) ? min : 3;
}

function homeRowPriorityRecencyMs(row: HomeRow, ctx: HomeListPriorityContext): number {
  let max = 0;
  for (const item of homeRowSessionItems(row)) {
    const ms = sessionPriorityRecencyMs(
      item.session.id,
      activityMsFromIso(item.lastActivityAt),
      ctx,
    );
    if (ms > max) max = ms;
  }
  return max;
}

function latestActivityAt(items: readonly RemoteSessionListItem[]): string {
  return items.reduce((latest, item) => (
    item.lastActivityAt > latest ? item.lastActivityAt : latest
  ), '');
}
