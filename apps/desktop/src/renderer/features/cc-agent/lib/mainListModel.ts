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
 *   - priority:等你处理(waiting)> 完成未读(unread)> 运行中 > 其余;同档内按
 *     recency。四档口径对齐 Codex 侧栏的优先级排序(waiting:0 / unread:1 /
 *     active:2 / idle:3,2026-08-13 用户裁决"参考 Codex"):此前三档把「等你
 *     回答」和「跑完没看」混在同一档,完成未读一多就把真正要回应的淹掉。
 *   - manual:项目行按 manualProjectOrder;散排对话与对话组不进手动顺序,
 *     排在项目之后按 recency。组内仍按最近活动(设计文档 §9.3)。
 */

import type { Session } from '@/lib/ccAgent.types';

import type { FilterSortBy } from '../hooks/helpers/sidebarFilterCore';
import { normalizeManualProjectOrder } from '../hooks/helpers/sidebarFilterCore';
import { sessionActivityMs } from './dateSessionGrouping';
import type { ProjectNode } from './projectGrouping';

export type MainListEntry =
  | { kind: 'project'; project: ProjectNode }
  | { kind: 'dialogue-group'; sessions: Session[] }
  | { kind: 'session'; session: Session };

/** 优先级排序的运行时上下文(组装层的运行中 / 需关注集合)。 */
export interface MainListPriorityContext {
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
export function sessionPriorityRank(session: Session, ctx: MainListPriorityContext): number {
  if (ctx.attentionSessionIds.has(session.id)) {
    return ctx.waitingSessionIds?.has(session.id) ? 0 : 1;
  }
  if (ctx.runningSessionIds.has(session.id)) return 2;
  return 3;
}

function entryActivityMs(entry: MainListEntry): number {
  if (entry.kind === 'session') return sessionActivityMs(entry.session);
  const sessions = entry.kind === 'project' ? entry.project.sessions : entry.sessions;
  let max = 0;
  for (const s of sessions) {
    const ms = sessionActivityMs(s);
    if (ms > max) max = ms;
  }
  return max;
}

function entryPriorityRank(entry: MainListEntry, ctx: MainListPriorityContext): number {
  if (entry.kind === 'session') return sessionPriorityRank(entry.session, ctx);
  const sessions = entry.kind === 'project' ? entry.project.sessions : entry.sessions;
  let min = 3;
  for (const s of sessions) {
    const rank = sessionPriorityRank(s, ctx);
    if (rank < min) min = rank;
    if (min === 0) break;
  }
  return min;
}

/**
 * 组内(项目 / 对话组)会话排序的唯一入口。
 *   - priority:分档 + 同档 recency
 *   - recency / manual:一律按最近活动倒序
 * 手动排序只影响顶层项目行,组内仍走 recency。不得沿用 groupSessions 的
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
          sessionActivityMs(b) - sessionActivityMs(a),
      );
  }
  return sessions.slice().sort((a, b) => sessionActivityMs(b) - sessionActivityMs(a));
}

export interface BuildMainListEntriesInput {
  /** 已过滤 / vendor 收窄后的可见项目(含各自 sessions)。 */
  projects: readonly ProjectNode[];
  /** 无项目归属(workspaceKind dialogue)的可见会话。 */
  dialogues: readonly Session[];
  /** 未绑定目录的草稿。按设备分组时随条目进对应设备段。 */
  unclassified?: readonly Session[];
  /** 'project' = 项目行;'flat' = 项目内会话平铺为顶层条目。 */
  groupBy: 'project' | 'flat';
  /** true = 散排对话收进单个「对话组」条目。 */
  groupDialogue: boolean;
  sortBy: FilterSortBy;
  manualProjectOrder: readonly string[];
  priorityContext?: MainListPriorityContext;
}

/** 产出主列表的有序顶层条目。 */
export function buildMainListEntries({
  projects,
  dialogues,
  unclassified = [],
  groupBy,
  groupDialogue,
  sortBy,
  manualProjectOrder,
  priorityContext = EMPTY_PRIORITY_CONTEXT,
}: BuildMainListEntriesInput): MainListEntry[] {
  const ctx = priorityContext;
  const entries: MainListEntry[] = [];

  if (groupBy === 'project') {
    for (const project of projects) {
      entries.push({
        kind: 'project',
        project: { ...project, sessions: sortSessionsForMainList(project.sessions, sortBy, ctx) },
      });
    }
  } else {
    for (const project of projects) {
      for (const session of project.sessions) entries.push({ kind: 'session', session });
    }
  }

  if (groupDialogue) {
    if (dialogues.length > 0) {
      entries.push({
        kind: 'dialogue-group',
        sessions: sortSessionsForMainList(dialogues, sortBy, ctx),
      });
    }
  } else {
    for (const session of dialogues) entries.push({ kind: 'session', session });
  }

  for (const session of unclassified) entries.push({ kind: 'session', session });

  return sortMainListEntries(entries, sortBy, manualProjectOrder, ctx);
}

function sortMainListEntries(
  entries: readonly MainListEntry[],
  sortBy: FilterSortBy,
  manualProjectOrder: readonly string[],
  ctx: MainListPriorityContext,
): MainListEntry[] {
  if (sortBy === 'manual') {
    // 手动:项目行按 manualProjectOrder;不在序的新项目由 normalize 追加到已排
    // 序列之后(沿用重设计前的既有语义;rank 兜底的 MAX_SAFE_INTEGER 只是防御,
    // normalize 后不会真的触发)。非项目条目(散排对话 / 对话组)排在项目之后按
    // recency。
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
      return entryActivityMs(b) - entryActivityMs(a);
    });
  }

  if (sortBy === 'priority') {
    return entries
      .slice()
      .sort(
        (a, b) =>
          entryPriorityRank(a, ctx) - entryPriorityRank(b, ctx) ||
          entryActivityMs(b) - entryActivityMs(a),
      );
  }
  // recency(默认):最近活动倒序。
  return entries.slice().sort((a, b) => entryActivityMs(b) - entryActivityMs(a));
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
    manualProjectOrder?: readonly string[];
    priorityContext?: MainListPriorityContext;
  },
): MainListEntry[] {
  if (!options.sortBy) return [...entries];
  return sortMainListEntries(
    entries,
    options.sortBy,
    options.manualProjectOrder ?? [],
    options.priorityContext ?? EMPTY_PRIORITY_CONTEXT,
  );
}
