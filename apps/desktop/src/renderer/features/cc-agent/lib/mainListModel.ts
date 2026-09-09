/**
 * mainListModel — 主列表混排模型(sidebar-redesign D 期)。
 * ---------------------------------------------------------------------------
 * 把「项目行 / 无项目对话 / 对话组」统一成一层顶层条目(MainListEntry),按同一
 * 口径排序——项目不再是特权层级,与散排对话按活动时间(或优先级)平级竞争位置
 * (docs/product-rules/sidebar-redesign-plan.md §2)。
 *
 * 本文件是纯函数(node 单测友好),渲染层(ProjectsSection)只消费产出的
 * 有序条目;这**有意推翻**了旧 DialogueSection「对话是 Projects 的同级固定段、
 * 固定显示在 Projects 之后」的裁决(设计文档 §9.1,2026-08-12 定稿)。
 *
 * 排序语义:
 *   - recency:顶层条目按组内最新活动倒序;项目 / 对话组内部同样按最近活动
 *     倒序,不沿用 groupSessions 的 active-first。
 *   - custom project order:项目行按 manualProjectOrder 连续排在前面;散排对话 /
 *     对话组排在项目之后,仍按当前 sortBy(recency / priority)。组内任务也走
 *     sortBy,不再把项目顺序和任务排序绑成同一档。
 *   - priority:等你处理(waiting)> 完成未读(unread)> 运行中 > 其余;同档内按
 *     recency。从完成未读切走时用离开时刻把它排到其余档最前;已读已完成任务
 *     之间与按时间排序同口径,浏览不改序(2026-08-17 用户裁决)。正在看的任务
 *     用 heldPriorityRanks 钉住打开时的档位。四档口径对齐 Codex 侧栏(waiting:0 / unread:1 /
 *     active:2 / idle:3,2026-08-13 用户裁决"参考 Codex"):此前三档把「等你
 *     回答」和「跑完没看」混在同一档,完成未读一多就把真正要回应的淹掉。
 */

import type { Session } from '@/lib/ccAgent.types';

import { LIVE_TASK_PRIORITY, liveTaskPriorityRank } from '../../../../shared/liveTaskPriority';
import type {
  FilterProjectOrder,
  FilterSortBy,
} from '../hooks/helpers/sidebarFilterCore';
import { normalizeManualProjectOrder } from '../hooks/helpers/sidebarFilterCore';
import {
  groupAutomationSidebarEntries,
  type AutomationScheduleSessionInfo,
  type SidebarSessionEntry,
} from './automationSidebarGrouping';
import { sessionActivityMs } from './dateSessionGrouping';
import type { BotGroupNode, ProjectNode } from './projectGrouping';

export type MainListEntry =
  | { kind: 'project'; project: ProjectNode }
  | { kind: 'dialogue-group'; sessions: Session[] }
  /** 一个伙伴名下的全部任务。与项目行并列 —— 项目是实体目录,伙伴名是用户起的。 */
  | { kind: 'bot-group'; bot: BotGroupNode }
  | SidebarSessionEntry;

/** 优先级排序的运行时上下文(组装层的运行中 / 需关注集合)。 */
export interface MainListPriorityContext {
  /**
   * 运行中档。组装层会把「刚发送、agent 还没 isRunning」的 starting 会话并进来,
   * 让新任务立刻排在运行中档顶,而不是先沉到其余档再跳上来。
   */
  runningSessionIds: ReadonlySet<string>;
  /** 需关注(等待确认 / 完成未读等 attention 通知)的 sessionIds。 */
  attentionSessionIds: ReadonlySet<string>;
  /**
   * attention 里「等你处理」的子集:等待回复 / 授权 / 计划审阅(awaiting)与
   * 出错未处理(error)。attentionSessionIds 减去它 = 完成未读(done)。
   * 可缺省(空集):此时全部 attention 落进 unread 档——排序仍然成立,只是
   * 少了 waiting 细分(老调用方 / 测试夹具零迁移成本)。
   */
  waitingSessionIds?: ReadonlySet<string>;
  /**
   * 正在看的任务打开时的档位。看的过程中 attention 被清掉后,自然档会掉到
   * 「其余」;这里钉住较差方向。只有从完成未读切走时才写 recentlyViewedAtMs。
   */
  heldPriorityRanks?: ReadonlyMap<string, number>;
  /**
   * 从完成未读切走的时刻(unix ms)。只给那一次回落写离开时间,让它排到其余档
   * 最前;已读已完成任务之间仍按 sessionActivityMs,浏览不改序。
   */
  recentlyViewedAtMs?: ReadonlyMap<string, number>;
}

const EMPTY_PRIORITY_CONTEXT: MainListPriorityContext = {
  runningSessionIds: new Set<string>(),
  attentionSessionIds: new Set<string>(),
};

/**
 * 单会话优先级权重(对齐 Codex 的 waiting:0 / unread:1 / active:2 / idle:3):
 * 等你处理 0 > 完成未读 1 > 运行中 2 > 其余 3。waiting 压过 unread:「要你回应
 * 才能继续」比「跑完了等你看」急;unread 压过 running:running 不需要你动手,
 * 而 unread 是已经可以处理的结果。
 */
export function naturalPriorityRankForId(
  sessionId: string,
  ctx: Pick<
    MainListPriorityContext,
    'runningSessionIds' | 'attentionSessionIds' | 'waitingSessionIds'
  >,
): number {
  const waiting = ctx.waitingSessionIds?.has(sessionId) === true;
  const unread = ctx.attentionSessionIds.has(sessionId) && !waiting;
  return liveTaskPriorityRank({
    waiting,
    unread,
    running: ctx.runningSessionIds.has(sessionId),
  });
}

export function sessionNaturalPriorityRank(
  session: Session,
  ctx: MainListPriorityContext,
): number {
  return naturalPriorityRankForId(session.id, ctx);
}

function viewedPriorityRank(natural: number, held: number | undefined): number {
  // 当前轮已经运行时,释放上一轮 unread / waiting 的 hold。否则看的过程中跑完后,
  // 旧 hold 会再次把任务抬回高档位,直到点击离开才突然重排。
  if (natural === LIVE_TASK_PRIORITY.running) return natural;
  return held === undefined ? natural : Math.min(natural, held);
}

export function sessionPriorityRank(session: Session, ctx: MainListPriorityContext): number {
  const natural = sessionNaturalPriorityRank(session, ctx);
  const held = ctx.heldPriorityRanks?.get(session.id);
  return viewedPriorityRank(natural, held);
}

export interface ViewedPriorityHoldState {
  prevViewedId?: string;
  heldPriorityRanks: Map<string, number>;
  recentlyViewedAtMs: Map<string, number>;
}

/**
 * 看的时候钉住打开时的档位。只有离开时仍钉着完成未读档,才写离开时刻——
 * 已读已完成任务之间跟按时间排序一样,浏览不改序。
 * 就地更新传入的 map,方便渲染层跨渲染保留。
 */
export function advanceViewedPriorityHold(
  state: ViewedPriorityHoldState,
  viewedSessionId: string | undefined,
  ctx: Pick<
    MainListPriorityContext,
    'runningSessionIds' | 'attentionSessionIds' | 'waitingSessionIds'
  >,
  nowMs: number,
): ViewedPriorityHoldState {
  if (state.prevViewedId && state.prevViewedId !== viewedSessionId) {
    if (state.heldPriorityRanks.get(state.prevViewedId) === LIVE_TASK_PRIORITY.unread) {
      state.recentlyViewedAtMs.set(state.prevViewedId, nowMs);
    }
    state.heldPriorityRanks.delete(state.prevViewedId);
  }
  if (viewedSessionId) {
    const natural = naturalPriorityRankForId(viewedSessionId, ctx);
    const held = state.heldPriorityRanks.get(viewedSessionId);
    state.heldPriorityRanks.set(viewedSessionId, viewedPriorityRank(natural, held));
  }
  state.prevViewedId = viewedSessionId;
  return state;
}

/**
 * 点击清点会先于路由更新清掉 attention。必须在那之前按当前档位钉住,
 * 否则首次 hold 只能读到 rest,刚打开的完成未读仍会立刻沉底。
 */
export function holdViewedPriorityRank(
  state: ViewedPriorityHoldState,
  sessionId: string,
  ctx: Pick<
    MainListPriorityContext,
    'runningSessionIds' | 'attentionSessionIds' | 'waitingSessionIds'
  >,
): void {
  const natural = naturalPriorityRankForId(sessionId, ctx);
  const held = state.heldPriorityRanks.get(sessionId);
  state.heldPriorityRanks.set(sessionId, viewedPriorityRank(natural, held));
}

export function sessionPriorityRecencyMs(session: Session, ctx: MainListPriorityContext): number {
  if (sessionNaturalPriorityRank(session, ctx) !== LIVE_TASK_PRIORITY.rest) {
    return sessionActivityMs(session);
  }
  const viewedAt = ctx.recentlyViewedAtMs?.get(session.id) ?? 0;
  return Math.max(sessionActivityMs(session), viewedAt);
}

export function getMainListEntrySessions(entry: MainListEntry): readonly Session[] {
  if (entry.kind === 'project') return entry.project.sessions;
  if (entry.kind === 'dialogue-group') return entry.sessions;
  if (entry.kind === 'bot-group') return entry.bot.sessions;
  if (entry.kind === 'automation-group') return entry.group.sessions;
  return [entry.session];
}

function entryActivityMs(entry: MainListEntry): number {
  const sessions = getMainListEntrySessions(entry);
  let max = 0;
  for (const s of sessions) {
    const ms = sessionActivityMs(s);
    if (ms > max) max = ms;
  }
  return max;
}

function entryPriorityRecencyMs(entry: MainListEntry, ctx: MainListPriorityContext): number {
  const sessions = getMainListEntrySessions(entry);
  let max = 0;
  for (const s of sessions) {
    const ms = sessionPriorityRecencyMs(s, ctx);
    if (ms > max) max = ms;
  }
  return max;
}

function entryPriorityRank(entry: MainListEntry, ctx: MainListPriorityContext): number {
  const sessions = getMainListEntrySessions(entry);
  let min: number = LIVE_TASK_PRIORITY.rest;
  for (const s of sessions) {
    const rank = sessionPriorityRank(s, ctx);
    if (rank < min) min = rank;
    if (min === LIVE_TASK_PRIORITY.waiting) break;
  }
  return min;
}

/**
 * 组内(项目 / 对话组)会话排序的唯一入口。
 *   - priority:分档 + 同档 recency
 *   - recency:一律按最近活动倒序
 * 自定义项目顺序只影响顶层项目行,组内仍走当前 sortBy。不得沿用 groupSessions 的
 * active-first 入参序——状态=全部时,刚归档的任务必须能排在陈旧活跃任务前面。
 */
export function sortSessionsForMainList(
  sessions: readonly Session[],
  sortBy: FilterSortBy,
  ctx: MainListPriorityContext = EMPTY_PRIORITY_CONTEXT,
): Session[] {
  if (sortBy === 'priority') {
    return sessions
      .slice()
      .sort(
        (a, b) =>
          sessionPriorityRank(a, ctx) - sessionPriorityRank(b, ctx) ||
          sessionPriorityRecencyMs(b, ctx) - sessionPriorityRecencyMs(a, ctx),
      );
  }
  return sessions.slice().sort((a, b) => sessionActivityMs(b) - sessionActivityMs(a));
}

export interface BuildMainListEntriesInput {
  /** 已过滤 / vendor 收窄后的可见项目(含各自 sessions)。 */
  projects: readonly ProjectNode[];
  /** 无项目归属(workspaceKind dialogue)的可见会话。 */
  dialogues: readonly Session[];
  /** 按伙伴分的组。平铺模式下与项目内会话一样摊成顶层条目。 */
  bots?: readonly BotGroupNode[];
  /** 未绑定目录的草稿。按设备分组时随条目进对应设备段。 */
  unclassified?: readonly Session[];
  /** 'project' = 项目行;'flat' = 项目内会话平铺为顶层条目。 */
  groupBy: 'project' | 'flat';
  /** true = 散排对话收进单个「对话组」条目。 */
  groupDialogue: boolean;
  sortBy: FilterSortBy;
  projectOrder?: FilterProjectOrder;
  manualProjectOrder: readonly string[];
  priorityContext?: MainListPriorityContext;
  notifications?: ReadonlySet<string>;
  scheduleSessionIndex?: ReadonlyMap<string, AutomationScheduleSessionInfo>;
}

const EMPTY_SESSION_ID_SET: ReadonlySet<string> = new Set<string>();

function buildFlatSessionEntries(
  sessions: readonly Session[],
  sortBy: FilterSortBy,
  priorityContext: MainListPriorityContext,
  notifications: ReadonlySet<string>,
  scheduleSessionIndex?: ReadonlyMap<string, AutomationScheduleSessionInfo>,
): SidebarSessionEntry[] {
  const sortedSessions = sortSessionsForMainList(sessions, sortBy, priorityContext);
  return groupAutomationSidebarEntries(sortedSessions, { notifications, scheduleSessionIndex });
}

/** 产出主列表的有序顶层条目。 */
export function buildMainListEntries({
  projects,
  dialogues,
  bots = [],
  unclassified = [],
  groupBy,
  groupDialogue,
  sortBy,
  projectOrder = 'activity',
  manualProjectOrder,
  priorityContext = EMPTY_PRIORITY_CONTEXT,
  notifications = EMPTY_SESSION_ID_SET,
  scheduleSessionIndex,
}: BuildMainListEntriesInput): MainListEntry[] {
  const ctx = priorityContext;
  const entries: MainListEntry[] = [];

  if (groupBy === 'flat') {
    const flatEntries = buildFlatSessionEntries(
      [
        ...projects.flatMap((project) => project.sessions),
        ...bots.flatMap((bot) => bot.sessions),
        ...dialogues,
        ...unclassified,
      ],
      sortBy,
      ctx,
      notifications,
      scheduleSessionIndex,
    );
    if (!groupDialogue) {
      entries.push(...flatEntries);
    } else {
      const dialogueSessionIds = new Set(dialogues.map((session) => session.id));
      const groupedDialogues: Session[] = [];
      for (const entry of flatEntries) {
        const sessions = getMainListEntrySessions(entry);
        if (sessions.every((session) => dialogueSessionIds.has(session.id))) {
          groupedDialogues.push(...sessions);
        } else {
          entries.push(entry);
        }
      }
      if (groupedDialogues.length > 0) {
        entries.push({
          kind: 'dialogue-group',
          sessions: sortSessionsForMainList(groupedDialogues, sortBy, ctx),
        });
      }
    }
    return sortMainListEntries(entries, sortBy, projectOrder, manualProjectOrder, ctx);
  }

  for (const project of projects) {
    entries.push({
      kind: 'project',
      project: { ...project, sessions: sortSessionsForMainList(project.sessions, sortBy, ctx) },
    });
  }

  for (const bot of bots) {
    entries.push({
      kind: 'bot-group',
      bot: { ...bot, sessions: sortSessionsForMainList(bot.sessions, sortBy, ctx) },
    });
  }

  if (groupDialogue) {
    if (dialogues.length > 0) {
      entries.push({
        kind: 'dialogue-group',
        sessions: sortSessionsForMainList(dialogues, sortBy, ctx),
      });
    }
  } else {
    entries.push(
      ...buildFlatSessionEntries(dialogues, sortBy, ctx, notifications, scheduleSessionIndex),
    );
  }

  entries.push(
    ...buildFlatSessionEntries(unclassified, sortBy, ctx, notifications, scheduleSessionIndex),
  );

  return sortMainListEntries(entries, sortBy, projectOrder, manualProjectOrder, ctx);
}

function compareEntriesBySortBy(
  a: MainListEntry,
  b: MainListEntry,
  sortBy: FilterSortBy,
  ctx: MainListPriorityContext,
): number {
  if (sortBy === 'priority') {
    return (
      entryPriorityRank(a, ctx) - entryPriorityRank(b, ctx) ||
      entryPriorityRecencyMs(b, ctx) - entryPriorityRecencyMs(a, ctx)
    );
  }
  return entryActivityMs(b) - entryActivityMs(a);
}

function sortMainListEntries(
  entries: readonly MainListEntry[],
  sortBy: FilterSortBy,
  projectOrder: FilterProjectOrder,
  manualProjectOrder: readonly string[],
  ctx: MainListPriorityContext,
): MainListEntry[] {
  if (projectOrder === 'custom') {
    // 自定义项目序:项目行按 manualProjectOrder;不在序的新项目由 normalize
    // 追加到已排序列之后。非项目条目排在项目之后,仍按当前任务排序。
    const projectKeys = entries
      .filter(
        (entry): entry is Extract<MainListEntry, { kind: 'project' }> => entry.kind === 'project',
      )
      .map((entry) => entry.project.projectKey);
    const normalized = normalizeManualProjectOrder(manualProjectOrder, projectKeys);
    const rank = new Map(normalized.map((key, index) => [key, index]));
    return entries.slice().sort((a, b) => {
      const aProject = a.kind === 'project';
      const bProject = b.kind === 'project';
      if (aProject !== bProject) return aProject ? -1 : 1;
      if (aProject && bProject) {
        return (
          (rank.get((a as Extract<MainListEntry, { kind: 'project' }>).project.projectKey) ??
            Number.MAX_SAFE_INTEGER) -
          (rank.get((b as Extract<MainListEntry, { kind: 'project' }>).project.projectKey) ??
            Number.MAX_SAFE_INTEGER)
        );
      }
      return compareEntriesBySortBy(a, b, sortBy, ctx);
    });
  }

  return entries.slice().sort((a, b) => compareEntriesBySortBy(a, b, sortBy, ctx));
}

/* ============================== 设备分组(E 期) ============================== */

/** 一个设备段:本机(deviceId null)或某台 device-link 被控设备。 */
export interface MainListDeviceSection {
  /** null = 本机。 */
  deviceId: string | null;
  entries: MainListEntry[];
}

function entryDeviceId(entry: MainListEntry): string | null {
  if (entry.kind === 'project') return entry.project.deviceLinkDeviceId ?? null;
  if (entry.kind === 'session') return entry.session.deviceLinkDeviceId ?? null;
  if (entry.kind === 'automation-group') {
    return entry.group.sessions[0]?.deviceLinkDeviceId ?? null;
  }
  // 伙伴组:同样按组内首条会话归属。伙伴本身不绑设备 —— 它的任务可以分布在
  // 本机与远端,设备切段只看会话自己在哪。
  if (entry.kind === 'bot-group') {
    return entry.bot.sessions[0]?.deviceLinkDeviceId ?? null;
  }
  // 对话组条目:按组内首条会话归属(散排对话在设备分组下由调用方按设备切分后
  // 再分别成组,这里只是兜底)。
  return entry.sessions[0]?.deviceLinkDeviceId ?? null;
}

/**
 * 把有序顶层条目切成设备段(E 期「按设备分组」):
 *   - 段顺序:本机在前,远程设备按 deviceOrder(设备切换栏同序);
 *     不在 deviceOrder 里的设备(断线缓存等)按段内最新活动排在其后。
 *   - 段内按当前 sortBy 重排(跨设备对话组拆开后,不能再沿用整组位置)。
 *   - 「对话归为一组」开启时,跨设备的对话组会被拆成每设备一组——调用方无需
 *     预切分,这里对 dialogue-group 条目按成员设备拆分。
 */
export function splitEntriesByDevice(
  entries: readonly MainListEntry[],
  deviceOrder: readonly string[],
  options: {
    sortBy?: FilterSortBy;
    projectOrder?: FilterProjectOrder;
    manualProjectOrder?: readonly string[];
    priorityContext?: MainListPriorityContext;
  } = {},
): MainListDeviceSection[] {
  // 先把跨设备对话组拆开(组内成员可能来自不同设备)。
  const flattened: MainListEntry[] = [];
  for (const entry of entries) {
    if (entry.kind !== 'dialogue-group') {
      flattened.push(entry);
      continue;
    }
    const byDevice = new Map<string | null, Session[]>();
    for (const s of entry.sessions) {
      const key = s.deviceLinkDeviceId ?? null;
      const list = byDevice.get(key);
      if (list) list.push(s);
      else byDevice.set(key, [s]);
    }
    for (const sessions of byDevice.values()) {
      flattened.push({ kind: 'dialogue-group', sessions });
    }
  }

  const sections = new Map<string | null, MainListEntry[]>();
  for (const entry of flattened) {
    const key = entryDeviceId(entry);
    const list = sections.get(key);
    if (list) list.push(entry);
    else sections.set(key, [entry]);
  }

  const orderedIds: Array<string | null> = [null, ...deviceOrder];
  const result: MainListDeviceSection[] = [];
  for (const id of orderedIds) {
    const sectionEntries = sections.get(id);
    if (sectionEntries && sectionEntries.length > 0) {
      result.push({
        deviceId: id,
        entries: sortSectionEntries(sectionEntries, options),
      });
      sections.delete(id);
    }
  }
  // 不在 deviceOrder 的残余设备(断线缓存):按段内最新活动追加。
  const rest = [...sections.entries()]
    .filter(([, sectionEntries]) => sectionEntries.length > 0)
    .map(([deviceId, sectionEntries]) => ({
      deviceId,
      entries: sortSectionEntries(sectionEntries, options),
    }))
    .sort(
      (a, b) =>
        Math.max(...b.entries.map(entryActivityMs)) - Math.max(...a.entries.map(entryActivityMs)),
    );
  result.push(...rest);
  return result;
}

function sortSectionEntries(
  entries: readonly MainListEntry[],
  options: {
    sortBy?: FilterSortBy;
    projectOrder?: FilterProjectOrder;
    manualProjectOrder?: readonly string[];
    priorityContext?: MainListPriorityContext;
  },
): MainListEntry[] {
  if (!options.sortBy) return [...entries];
  return sortMainListEntries(
    entries,
    options.sortBy,
    options.projectOrder ?? 'activity',
    options.manualProjectOrder ?? [],
    options.priorityContext ?? EMPTY_PRIORITY_CONTEXT,
  );
}
