import { taskInboxSection, taskInboxSignalsFromRank, taskSnoozeUntil } from '@cindy/maker-shared/live-task-priority';
import { i18n } from '@/i18n';
import {
  automationGroupKey,
  compareSessionListStrings,
  groupAutomationListItems,
} from '@cindy/maker-shared/session-list';
import { mobilePresentationLocalizer } from '@/i18n/presentationLocalizer';
import {
  compareSessionsByStatusThenActivityDesc,
  type MobileHomePresentation,
  type MobileHomeProjectGroup,
  type MobileHomeSessionLike,
} from './mobileHome';
import { LIVE_TASK_PRIORITY } from '@cindy/maker-shared/live-task-priority';
import {
  activityMsFromIso,
  collectInboxHomePriorityContext,
  EMPTY_HOME_PRIORITY_CONTEXT,
  naturalPriorityRankForId,
  sessionPriorityRank,
  sessionPriorityRecencyMs,
  type HomeListPriorityContext,
  type HomeListSortBy,
} from './homeListPriority';
import {
  normalizeManualProjectOrder,
  type HomeProjectOrder,
} from './homeProjectOrder';
import {
  createSessionListTranslator,
  localizeRemoteSessionListItem,
  type RemoteSessionListItem,
} from './sessionList';
import { taskTeammateId } from './teammateTaskSource';
import type { RemoteSession } from './types';

/** 首页列表的一行:目录分组头,或一条任务(置顶 / 普通 / 项目内)。 */
export type HomeRow =
  | { key: string; kind: 'project'; project: MobileHomeProjectGroup }
  | { key: string; kind: 'dialogue'; project: MobileHomeProjectGroup }
  | { key: string; kind: 'cindy-make'; project: MobileHomeProjectGroup }
  /** 「自动化」目录:自动化运行出来的任务(项目里的与对话的),组内同一自动化仍收成一行。 */
  | { key: string; kind: 'automation'; project: MobileHomeProjectGroup }
  | {
      key: string;
      kind: 'session';
      item: RemoteSessionListItem;
      source: 'chat' | 'pinned' | 'project' | 'search';
      /** 仅平铺(未按项目分组)的顶层会话行:项目名或「对话」。 */
      sourceLabel?: string;
    };

/** SectionList 的一个分区。title 为 null 的分区不渲染表头。 */
export type HomeSection = { data: HomeRow[]; key: string; title: string | null; count?: number };

/** 主列表分区跨分组模式保持同一身份，避免 SectionList 把仍存在的行整批卸载重挂。 */
export const HOME_MAIN_SECTION_KEY = 'main';

export interface HomeSectionOptions {
  groupDialogue?: boolean;
  /** 自动化运行的任务收进「自动化」目录(与桌面「分组 → 自动化」同口径)。 */
  groupAutomation?: boolean;
  automationTitle?: string;
  /** The compact task-switching drawer only renders flat session rows. */
  groupCindyMake?: boolean;
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
 * - 非分组模式把项目下属会话展平;Cindy Make 保留专用目录,对话组遵循自己的开关。
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

  const partitioned = options.groupAutomation ? partitionAutomationItems(home) : null;
  const listHome = partitioned?.home ?? home;
  const automations = partitioned ? mergeAutomationItems(partitioned.automations) : [];
  // 跨项目合并会换代表运行;排序档位要按合并后的全部成员重新聚合。
  const rowOptions = automations.length && options.priorityContext
    ? { ...options, priorityContext: withMergedAutomationPriority(options.priorityContext, automations) }
    : options;
  const rows = groupByProject ? buildGroupedHomeRows(listHome, rowOptions) : buildMixedHomeRows(listHome, rowOptions);
  if (automations.length > 0) {
    rows.push(buildAutomationGroupRow(automations, rowOptions));
  }
  if (rows.length > 0) {
    sections.push({
      data: partitioned ? sortHomeRows(rows, rowOptions) : rows,
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

export function isFolderHomeRow(
  row: HomeRow | undefined,
): row is Extract<HomeRow, { kind: 'project' | 'dialogue' | 'cindy-make' | 'automation' }> {
  return !!row && (row.kind === 'project' || row.kind === 'dialogue' || row.kind === 'cindy-make'
    || row.kind === 'automation');
}

function isAutomationItem(item: RemoteSessionListItem): boolean {
  return automationGroupKey(item) !== null;
}

/**
 * 按来源(自动化运行)把任务从项目和对话里抽出;只剩自动化任务的项目随之消失,
 * 与 Cindy Make 目录同口径。Cindy Make 目录不参与。
 */
export function partitionAutomationItems(home: MobileHomePresentation): {
  home: MobileHomePresentation;
  automations: RemoteSessionListItem[];
} {
  const automations: RemoteSessionListItem[] = [];
  const projects = home.projects.flatMap((project) => {
    if (project.kind === 'cindy-make') return [project];
    const sessions = project.sessions.filter((item) => {
      if (!isAutomationItem(item)) return true;
      automations.push(item);
      return false;
    });
    if (sessions.length === project.sessions.length) return [project];
    if (sessions.length === 0) return [];
    return [{
      ...project,
      latestActivityAt: latestActivityAt(sessions),
      pendingInteractionCount: sessions.reduce((sum, item) => sum + item.pendingInteractionCount, 0),
      sessionCount: sessions.reduce((sum, item) => sum + (item.automationGroup?.sessionCount ?? 1), 0),
      sessions,
    }];
  });
  const chats = home.chats.filter((item) => {
    if (!isAutomationItem(item)) return true;
    automations.push(item);
    return false;
  });
  return { home: { ...home, chats, projects }, automations };
}

function automationDeviceKey(item: RemoteSessionListItem): string {
  const session = item.session as { canonicalDeviceId?: string | null; deviceLinkDeviceId?: string | null };
  return session.canonicalDeviceId ?? session.deviceLinkDeviceId ?? '';
}

/**
 * 上游按项目各自折叠自动化运行。收进「自动化」目录后按设备 + 自动化重新合并,改过项目目录
 * (或同时有项目内与对话里运行)的同一条自动化只显示一个文件夹。只重建确实被拆开的那些,
 * 其余保留原对象,行比较仍走引用快路径。
 */
export function mergeAutomationItems(
  items: readonly RemoteSessionListItem[],
  nowMs = Date.now(),
): RemoteSessionListItem[] {
  const buckets = new Map<string, RemoteSessionListItem[]>();
  for (const item of items) {
    const baseKey = item.automationGroup?.baseKey ?? automationGroupKey(item) ?? `session:${item.session.id}`;
    const key = `${automationDeviceKey(item)}|${baseKey}`;
    const bucket = buckets.get(key);
    if (bucket) bucket.push(item);
    else buckets.set(key, [item]);
  }
  let translate: ReturnType<typeof createSessionListTranslator> | null = null;
  const merged: RemoteSessionListItem[] = [];
  for (const bucket of buckets.values()) {
    if (bucket.length === 1) {
      merged.push(bucket[0]);
      continue;
    }
    // 各项目的成员拼在一起会打乱顺序;恢复上游的「状态 → 最近活动」顺序,组内前几条仍是最新的。
    const runs = bucket
      .flatMap((item) => item.automationGroup?.items ?? [item])
      .sort((a, b) => compareSessionsByStatusThenActivityDesc(a.session as MobileHomeSessionLike, b.session as MobileHomeSessionLike));
    // 与 buildMobileHomePresentation 同一流水线:先折叠再本地化(组内成员已本地化)。
    const rows = groupAutomationListItems(runs, nowMs, true, automationDeviceKey, mobilePresentationLocalizer);
    if (rows.length !== 1 || !rows[0].automationGroup) {
      merged.push(...bucket);
      continue;
    }
    translate ??= createSessionListTranslator();
    merged.push(localizeRemoteSessionListItem(rows[0], nowMs, translate));
  }
  return merged;
}

/**
 * 优先级上下文按合并前各组的代表运行收集。合并后的组按每个成员各自的档位取最优,新代表
 * 只继承这一档:不把不同成员的原始信号并在一起(否则旧目录的完成未读 + 新目录的运行中
 * 会被当成同一任务的新一轮运行,整组降到 running 档)。
 */
export function withMergedAutomationPriority(
  ctx: HomeListPriorityContext,
  items: readonly RemoteSessionListItem[],
): HomeListPriorityContext {
  let waiting: Set<string> | null = null;
  let unread: Set<string> | null = null;
  let running: Set<string> | null = null;
  for (const item of items) {
    const members = item.automationGroup?.items;
    if (!members) continue;
    const id = item.session.id;
    const current = naturalPriorityRankForId(id, ctx);
    const best = members.reduce(
      (rank, member) => Math.min(rank, naturalPriorityRankForId(member.session.id, ctx)),
      current,
    );
    if (best >= current) continue;
    if (best === LIVE_TASK_PRIORITY.waiting) {
      (waiting ??= new Set(ctx.waitingSessionIds)).add(id);
    } else if (best === LIVE_TASK_PRIORITY.unread) {
      (unread ??= new Set(ctx.unreadSessionIds)).add(id);
      if (ctx.runningSessionIds.has(id)) (running ??= new Set(ctx.runningSessionIds)).delete(id);
    } else if (best === LIVE_TASK_PRIORITY.running) {
      (running ??= new Set(ctx.runningSessionIds)).add(id);
    }
  }
  if (!waiting && !unread && !running) return ctx;
  return {
    ...ctx,
    runningSessionIds: running ?? ctx.runningSessionIds,
    unreadSessionIds: unread ?? ctx.unreadSessionIds,
    waitingSessionIds: waiting ?? ctx.waitingSessionIds,
  };
}

/** 「自动化」目录行;items 已经过 mergeAutomationItems。 */
export function buildAutomationGroupRow(
  items: readonly RemoteSessionListItem[],
  options: HomeSectionOptions = {},
): HomeRow {
  const title = options.automationTitle ?? i18n.t('devices.list.menu.automationFolder');
  const sessions = sortSessionItems(items, options);
  return {
    key: 'automation',
    kind: 'automation',
    project: {
      deviceId: null,
      deviceName: '',
      key: 'automation',
      latestActivityAt: latestActivityAt(sessions),
      pendingInteractionCount: sessions.reduce((sum, item) => sum + item.pendingInteractionCount, 0),
      sessionCount: sessions.reduce((sum, item) => sum + (item.automationGroup?.sessionCount ?? 1), 0),
      sessions,
      subtitle: '',
      title,
      workingDir: '',
    },
  };
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
    kind: project.kind === 'cindy-make' ? 'cindy-make' as const : 'project' as const,
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
  const rows: HomeRow[] = home.projects.flatMap((project): HomeRow[] => {
    if (project.kind === 'cindy-make' && options.groupCindyMake !== false) {
      return [{ key: project.key, kind: 'cindy-make', project: withSortedProjectSessions(project, options) }];
    }
    return sortSessionItems(project.sessions, options).map((item) => ({
      item,
      key: `project:${project.key}:${item.automationGroup?.key ?? item.session.id}`,
      kind: 'session' as const,
      source: 'project' as const,
      sourceLabel: project.title,
    }));
  });
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
  if (options.sortBy === 'created') {
    return items.slice().sort((a, b) =>
      sessionCreatedMs(b) - sessionCreatedMs(a) || compareSessionListStrings(a.session.id, b.session.id));
  }
  return items.slice().sort((a, b) =>
    compareSessionListStrings(b.lastActivityAt, a.lastActivityAt) || compareSessionListStrings(a.session.id, b.session.id));
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
      || compareSessionListStrings(a.key, b.key));
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
      || compareSessionListStrings(a.key, b.key));
  }
  if (options.sortBy === 'created') {
    return rows.slice().sort((a, b) =>
      homeRowCreatedMs(b) - homeRowCreatedMs(a) || compareSessionListStrings(a.key, b.key));
  }
  return rows.slice().sort(compareHomeRowsByActivityDesc);
}

/** 创建时间排序:目录行取组内最新创建的任务,与桌面 sortProjectsForSidebar 同口径。 */
function homeRowCreatedMs(row: HomeRow): number {
  let max = 0;
  for (const item of homeRowSessionItems(row)) {
    const ms = sessionCreatedMs(item);
    if (ms > max) max = ms;
  }
  return max;
}

/** 自动化组行代表多次运行,取组内最新创建的一次(组代表可能是较旧的未读 / 待处理运行)。 */
function sessionCreatedMs(item: RemoteSessionListItem): number {
  let max = activityMsFromIso(item.session.createdAt);
  for (const run of item.automationGroup?.items ?? []) {
    const ms = activityMsFromIso(run.session.createdAt);
    if (ms > max) max = ms;
  }
  return max;
}

function compareSessionItemsByPriority(
  a: RemoteSessionListItem,
  b: RemoteSessionListItem,
  ctx: HomeListPriorityContext,
): number {
  return sessionPriorityRank(a.session.id, ctx) - sessionPriorityRank(b.session.id, ctx)
    || sessionPriorityRecencyMs(b.session.id, activityMsFromIso(b.lastActivityAt), ctx)
      - sessionPriorityRecencyMs(a.session.id, activityMsFromIso(a.lastActivityAt), ctx)
    || compareSessionListStrings(a.session.id, b.session.id);
}

function compareHomeRowsByActivityDesc(a: HomeRow, b: HomeRow): number {
  return compareSessionListStrings(homeRowActivity(b), homeRowActivity(a)) || compareSessionListStrings(a.key, b.key);
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


/** Inbox never uses unread as a settled marker. Automation runs are individually actionable. */
export function buildInboxHomeSections(
  home: MobileHomePresentation,
  collapsed: ReadonlySet<string>,
  priorityContext: HomeListPriorityContext,
  nowMs: number,
): HomeSection[] {
  const original = buildHomeSections(home, false, true, {
    groupDialogue: false, groupCindyMake: false, sortBy: 'priority', priorityContext,
  });
  const sections: HomeSection[] = [];
  const groups = new Map<string, HomeRow[]>(['inbox', 'working', 'snoozed', 'archived'].map(key => [key, []]));
  // Every listed task (including folded automation runs and tasks outside the regular list's
  // scope) contributes its own unread / waiting signals.
  const items = original.flatMap(section => section.data)
    .flatMap(row => row.kind === 'session' ? [row.item] : []);
  const ctx = collectInboxHomePriorityContext(items, priorityContext.runningSessionIds, {
    heldPriorityRanks: new Map(priorityContext.heldPriorityRanks),
    recentlyViewedAtMs: new Map(priorityContext.recentlyViewedAtMs),
  });
  for (const section of original) {
    if (section.key === 'pinned') continue;
    for (const row of section.data) {
      if (row.kind !== 'session') continue;
      for (const item of row.item.automationGroup?.items ?? [row.item]) {
        const task = item.session;
        const group = taskInboxSection(task, {
          ...taskInboxSignalsFromRank(sessionPriorityRank(task.id, ctx), naturalPriorityRankForId(task.id, ctx)),
          following: item.scheduleInfo?.hasActiveFollowUp === true,
          // A teammate's task is listed only while it needs the user or runs (2026-11-18).
          teammate: taskTeammateId(task as RemoteSession) !== undefined,
        }, nowMs);
        if (!group) continue;
        let sourceLabel = row.sourceLabel;
        if (group === 'snoozed') {
          const until = taskSnoozeUntil(task);
          sourceLabel = Number.isFinite(until)
            ? new Date(until).toLocaleString(i18n.language)
            : i18n.t('devices.list.menu.inbox.indefinite');
        }
        groups.get(group)!.push({ ...row, key: `inbox:${task.deviceLinkDeviceId ?? ''}:${task.id}`, item,
          sourceLabel });
      }
    }
  }
  for (const [group, data] of groups) {
    data.sort((a, b) => a.kind === 'session' && b.kind === 'session'
      ? group === 'snoozed'
        ? taskSnoozeUntil(a.item.session) - taskSnoozeUntil(b.item.session)
        : compareSessionItemsByPriority(a.item, b.item, ctx)
      : 0);
    const key = `inbox-${group}`;
    sections.push({ key, title: i18n.t(`devices.list.menu.inbox.${group}`), count: data.length,
      data: collapsed.has(key) ? [] : data });
  }
  return sections;
}
