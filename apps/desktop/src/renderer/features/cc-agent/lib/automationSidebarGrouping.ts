import type { Session } from '@/lib/ccAgent.types';
import type { Schedule } from '@cindy/maker-scheduler';
import type { FailedScheduleRunSnapshot } from '../../scheduler/lib/failedScheduleDismissal';

import {
  getAutomationSessionDisplayTitle,
  isAutomationGeneratedSession,
} from './scheduledSessionGrouping';
import { normalizeWorkingDir } from './projectGrouping';
import { isTeammateTaskSession } from '../../../../shared/sessionSource';
import { sessionActivityMs } from './dateSessionGrouping';
import {
  getSessionListCollapseView,
  SESSION_LIST_COLLAPSE_MIN_VISIBLE_COUNT,
} from './sessionListCollapse';

export interface AutomationScheduleSessionInfo {
  scheduleId: string;
  scheduleName: string;
  scheduleStatus?: Schedule['status'];
  scheduleSource?: Schedule['source'];
  nextFireAt?: number;
  workingDir?: string;
  projectConfigId?: string;
  unreadRunIds: string[];
  hasUnreadRun: boolean;
  /**
   * unreadRunIds 里未成功结局(`failed` / `interrupted`)的子集。
   * `aborted` 生而已读,不算未读失败。
   */
  unreadFailedRunIds: string[];
  /** 存在失败/中断历史；不随已读变化，用于保留失败提示。 */
  hasFailedRun?: boolean;
  /** 最近一次失败/中断的身份，不随已读变化；关闭提示只针对这次历史快照。 */
  latestFailedRun?: FailedScheduleRunSnapshot;
  /** 该 session 上最近一次未读失败/中断 run，供单次重试或继续操作使用。 */
  latestUnreadFailedRunId?: string;
  /**
   * 是否至少有一个未读失败 run —— 侧栏右侧据此涂红,而不是和成功完成一样涂绿。
   */
  hasUnreadFailedRun: boolean;
}

export function unreadSuccessScheduleRunIds(
  info: Pick<AutomationScheduleSessionInfo, 'unreadRunIds' | 'unreadFailedRunIds'>,
): string[] {
  if (info.unreadFailedRunIds.length === 0) return info.unreadRunIds;
  const failed = new Set(info.unreadFailedRunIds);
  return info.unreadRunIds.filter((id) => !failed.has(id));
}

export interface AutomationSessionGroup {
  id: string;
  /** 追加设备作用域前的分组 id；仅用于继承旧版持久化偏好。 */
  legacyId?: string;
  scheduleId?: string;
  scheduleStatus?: Schedule['status'];
  scheduleSource?: Schedule['source'];
  nextFireAt?: number;
  workingDir?: string;
  projectConfigId?: string;
  /** 远程设备上的自动化分组（组键已按设备作用域隔离，组内会话同属这台设备）。 */
  deviceLinkDeviceId?: string;
  /**
   * 伙伴例行任务分组（同一伙伴同一条规则）。规则由伙伴例行任务引擎管理，不是 schedule：
   * 组头只提供标为已读，运行与编辑去伙伴设置的「例行任务」页。
   */
  teammateRoutine?: { botId: string; routineId: string };
  title: string;
  sessions: Session[];
  attentionSessionIds: string[];
}

export type SidebarSessionEntry =
  | { kind: 'session'; session: Session }
  | { kind: 'automation-group'; group: AutomationSessionGroup };

/**
 * 条目的"最近活动"时间戳(ms):会话取自身;自动化分组取组内最新一条。
 * 供 getSessionListCollapseView 的「最近 24h 内不折叠」豁免使用。
 */
export function getEntryActivityMs(entry: SidebarSessionEntry): number {
  if (entry.kind === 'session') return sessionActivityMs(entry.session);
  return entry.group.sessions.reduce((max, s) => Math.max(max, sessionActivityMs(s)), 0);
}

export type AutomationScheduleAction =
  'run' | 'edit' | 'toggle-pause' | 'delete' | 'mark-read' | 'archive-all';

interface ScopedAutomationGroupKey {
  key: string;
  legacyKey?: string;
}

function fallbackAutomationGroupKey(session: Session): ScopedAutomationGroupKey {
  const workspace = session.workspaceKind ?? 'project';
  const dir = normalizeWorkingDir(session.projectDir ?? session.workingDir) ?? '__no_working_dir__';
  const title = getAutomationSessionDisplayTitle(session).trim() || session.id;
  return scopeAutomationGroupKey(`fallback:${workspace}:${dir}:${title}`, session);
}

function scopeAutomationGroupKey(key: string, session: Session): ScopedAutomationGroupKey {
  const deviceId = session.deviceLinkDeviceId?.trim();
  return deviceId ? { key: `${key}:device:${deviceId}`, legacyKey: key } : { key };
}

/** 伙伴例行任务 Session 的规则归属；旧主机不带 routineId 时为 null（维持平铺）。 */
function teammateRoutineOf(session: Session): { botId: string; routineId: string } | null {
  if (!isTeammateTaskSession(session) || session.orcaRole === 'worker') return null;
  const companion = session.companion;
  if (companion?.role !== 'routine' || !companion.routineId) return null;
  return { botId: companion.id, routineId: companion.routineId };
}

export function getAutomationSidebarGroupInfo(
  session: Session,
  scheduleSessionIndex?: ReadonlyMap<string, AutomationScheduleSessionInfo>,
): {
  key: string;
  legacyKey?: string;
  title: string;
  scheduleId?: string;
  scheduleStatus?: Schedule['status'];
  scheduleSource?: Schedule['source'];
  nextFireAt?: number;
  workingDir?: string;
  projectConfigId?: string;
  teammateRoutine?: { botId: string; routineId: string };
} | null {
  const teammateRoutine = teammateRoutineOf(session);
  if (teammateRoutine) {
    return {
      ...scopeAutomationGroupKey(
        `routine:${teammateRoutine.botId}:${teammateRoutine.routineId}`,
        session,
      ),
      // 例行任务 Session 以规则名为标题（「每次新建任务」时各次同名）。
      title: session.title,
      teammateRoutine,
    };
  }
  if (!isAutomationGeneratedSession(session)) return null;

  const indexed = scheduleSessionIndex?.get(session.id);
  if (indexed) {
    const scopedKey = scopeAutomationGroupKey(`schedule:${indexed.scheduleId}`, session);
    return {
      ...scopedKey,
      scheduleId: indexed.scheduleId,
      scheduleStatus: indexed.scheduleStatus,
      scheduleSource: indexed.scheduleSource,
      nextFireAt: indexed.nextFireAt,
      workingDir: indexed.workingDir,
      projectConfigId: indexed.projectConfigId,
      title: indexed.scheduleName,
    };
  }

  const fallbackKey = fallbackAutomationGroupKey(session);
  return {
    ...fallbackKey,
    title: getAutomationSessionDisplayTitle(session),
  };
}

export function groupAutomationSidebarEntries(
  sessions: readonly Session[],
  options: {
    notifications: ReadonlySet<string>;
    scheduleSessionIndex?: ReadonlyMap<string, AutomationScheduleSessionInfo>;
  },
): SidebarSessionEntry[] {
  const groups = new Map<string, AutomationSessionGroup>();
  const sessionGroupKey = new Map<string, string>();

  for (const session of sessions) {
    const groupInfo = getAutomationSidebarGroupInfo(session, options.scheduleSessionIndex);
    if (!groupInfo) continue;

    const existing = groups.get(groupInfo.key);
    if (existing) {
      existing.sessions.push(session);
      if (options.notifications.has(session.id)) existing.attentionSessionIds.push(session.id);
      if (existing.nextFireAt == null && groupInfo.nextFireAt != null) {
        existing.nextFireAt = groupInfo.nextFireAt;
      }
    } else {
      groups.set(groupInfo.key, {
        id: groupInfo.key,
        legacyId: groupInfo.legacyKey,
        scheduleId: groupInfo.scheduleId,
        scheduleStatus: groupInfo.scheduleStatus,
        scheduleSource: groupInfo.scheduleSource,
        nextFireAt: groupInfo.nextFireAt,
        workingDir: groupInfo.workingDir,
        projectConfigId: groupInfo.projectConfigId,
        ...(session.deviceLinkDeviceId ? { deviceLinkDeviceId: session.deviceLinkDeviceId } : {}),
        ...(groupInfo.teammateRoutine ? { teammateRoutine: groupInfo.teammateRoutine } : {}),
        title: groupInfo.title,
        sessions: [session],
        attentionSessionIds: options.notifications.has(session.id) ? [session.id] : [],
      });
    }
    sessionGroupKey.set(session.id, groupInfo.key);
  }

  const emittedGroups = new Set<string>();
  const entries: SidebarSessionEntry[] = [];

  for (const session of sessions) {
    const groupKey = sessionGroupKey.get(session.id);
    const group = groupKey ? groups.get(groupKey) : undefined;
    if (!group || group.sessions.length <= 1) {
      entries.push({ kind: 'session', session });
      continue;
    }
    if (emittedGroups.has(group.id)) continue;
    emittedGroups.add(group.id);
    entries.push({ kind: 'automation-group', group });
  }

  return entries;
}

export interface AutomationGroupChildView {
  /** 组头底下实际要渲染的子运行(收起 / 展开 / 冻结三态统一出口)。 */
  visibleSessions: Session[];
  /** 收起态是否还有被折叠的子运行 —— 决定是否显示「显示全部 N 个」。 */
  isOverflowing: boolean;
  /** 组内子运行总数(「显示全部 N 个」里的 N)。 */
  totalCount: number;
  /** 收起态被折叠隐藏的子运行数量。 */
  hiddenCount: number;
}

export interface AutomationGroupChildViewOptions {
  notifications: ReadonlySet<string>;
  runningSessionIds?: ReadonlySet<string>;
  showAll: boolean;
  /** 组头实际打开的任务，仅在收起态从未读子行中排除；展开态仍列出。 */
  headerSessionId?: string;
  activeSessionId?: string;
  frozenVisibleSessionIds?: readonly string[] | null;
  /** 传入当前时间 ms 即启用「最近 24h 内有活动不折叠」豁免(和普通对话一致);不传走纯硬上限。 */
  nowMs?: number;
  /** 展开组内的历史列表默认展示条数，默认 5（和普通对话一致）。 */
  minVisibleCount?: number;
  /** 轴 1(文件夹开/关)的收起态。收起时只渲染 collapsedAttentionSessionIds 命中的运行。 */
  collapsed?: boolean;
  /**
   * 收起态仍要保留可见的非静默未读、错误告警与待回复运行 id。错误来源是
   * `sidebar/projectCollapsedAttention.ts` 的 `resolveCollapsedAttention().errorSessionIds`
   * —— 与组头红点、项目折叠头红点同一份判据;待回复由组件按本地/远程活动补入。
   */
  collapsedAttentionSessionIds?: ReadonlySet<string>;
  /**
   * 展开态折叠的追加豁免集合(只影响折叠),语义同 SessionEntryList 的同名 prop:
   * 父层把 device-link 远程活动镜像并进来,保证项目行 / 对话组 / 设备段头聚合灯
   * 为之点亮的远程子运行不会藏在「显示全部」后(review P2)。
   */
  foldExemptSessionIds?: ReadonlySet<string>;
}

/**
 * 计算自动化分组组头底下要展示哪些子运行。
 *
 * 展开态列出全部运行，包含组头代表的那条，并复用普通任务列表的前 N 条、
 * 最近 24h、未读／运行中和当前任务豁免；冻结布局和「显示全部」也保留它。
 * 只有收起态排除组头实际代表的任务，避免未读子行与组头重复。
 *
 * 收起态仍展示全部非静默未读及待处理运行，不受前 N 条上限影响。
 * 组件把未读、远程 completed、错误和待回复统一传入 collapsedAttentionSessionIds；
 * 静默成功不产生未读，已读且无待处理状态的历史仍隐藏。
 * 收起态不套 24h / active 豁免，避免普通历史或当前打开的已读运行撑开列表。
 */
export function getAutomationGroupChildView(
  group: AutomationSessionGroup,
  options: AutomationGroupChildViewOptions,
): AutomationGroupChildView {
  const allRuns = group.sessions;
  const withoutOverflow = (visibleSessions: Session[]): AutomationGroupChildView => ({
    visibleSessions,
    isOverflowing: false,
    totalCount: allRuns.length,
    hiddenCount: 0,
  });

  // 收起态先于冻结布局和 showAll，只显示未读及待处理运行。
  if (options.collapsed) {
    const attentionIds = options.collapsedAttentionSessionIds;
    const visibleSessions = attentionIds?.size
      ? allRuns.filter((session) => session.id !== options.headerSessionId && attentionIds.has(session.id))
      : [];
    return {
      visibleSessions,
      isOverflowing: false,
      totalCount: visibleSessions.length,
      hiddenCount: 0,
    };
  }

  // 展开:全量子运行。
  if (options.showAll) return withoutOverflow(allRuns);

  // 冻结:用户在收起态点进某条子运行后,锁定点击瞬间的可见布局,避免列表跳动。
  if (options.frozenVisibleSessionIds) {
    const byId = new Map(allRuns.map((session) => [session.id, session]));
    const frozenSessions = options.frozenVisibleSessionIds
      .map((sessionId) => byId.get(sessionId))
      .filter((session): session is Session => Boolean(session));
    // 冻结只固定已点选布局，不能藏住后来变为运行/未读的本地或远程子运行。
    const visibleIds = new Set(frozenSessions.map((session) => session.id));
    const visibleSessions = [
      ...frozenSessions,
      ...allRuns.filter((session) => !visibleIds.has(session.id) &&
        (options.notifications.has(session.id) ||
          options.runningSessionIds?.has(session.id) ||
          options.foldExemptSessionIds?.has(session.id))),
    ];
    const hiddenCount = allRuns.length - visibleSessions.length;
    return { visibleSessions, isOverflowing: hiddenCount > 0, totalCount: allRuns.length, hiddenCount };
  }

  // 默认展开态：全部运行套用普通任务同款折叠，包含组头代表的任务。
  const view = getSessionListCollapseView({
    entries: allRuns,
    minVisibleCount: options.minVisibleCount ?? SESSION_LIST_COLLAPSE_MIN_VISIBLE_COUNT,
    showAll: false,
    disableCollapse: false,
    isFiltering: false,
    nowMs: options.nowMs,
    getActivityMs: sessionActivityMs,
    isActiveEntry: (session) => session.id === options.activeSessionId,
    hasAttentionEntry: (session) =>
      options.notifications.has(session.id) ||
      (options.runningSessionIds?.has(session.id) ?? false) ||
      (options.foldExemptSessionIds?.has(session.id) ?? false),
  });
  return {
    visibleSessions: [...view.visibleEntries],
    isOverflowing: view.isOverflowing,
    totalCount: allRuns.length,
    hiddenCount: view.hiddenCount,
  };
}

/** 仅取组头底下要渲染的子运行列表(组件需要溢出信息时用 getAutomationGroupChildView)。 */
export function getVisibleAutomationGroupSessions(
  group: AutomationSessionGroup,
  options: AutomationGroupChildViewOptions,
): Session[] {
  return getAutomationGroupChildView(group, options).visibleSessions;
}

/**
 * 组内「最新一条」运行:按 sessionActivityMs 的换手时间及旧数据回退降序取首。
 * 侧栏组头(折叠态)用它作为整组的代表 —— 状态、running/loading、点击打开目标都跟这条一致
 * (「组头 = 最新一条运行的代理」)。group.sessions 恒非空(分组至少 2 条),返回可能仍为
 * undefined 仅为类型安全兜底。
 */
export function getAutomationGroupLatestSession(
  group: AutomationSessionGroup,
): Session | undefined {
  let latest: Session | undefined;
  let latestMs = -Infinity;
  for (const session of group.sessions) {
    const ms = sessionActivityMs(session);
    if (ms > latestMs) {
      latestMs = ms;
      latest = session;
    }
  }
  return latest;
}

export function getAutomationGroupPrimarySession(
  group: AutomationSessionGroup,
  notifications: ReadonlySet<string>,
  options: {
    runningSessionIds?: ReadonlySet<string>;
    preferredSessionId?: string | null;
  } = {},
): Session | undefined {
  const { runningSessionIds, preferredSessionId } = options;
  if (runningSessionIds) {
    const running = group.sessions.find((session) => runningSessionIds.has(session.id));
    if (running) return running;
  }
  if (preferredSessionId) {
    const preferred = group.sessions.find((session) => session.id === preferredSessionId);
    if (preferred) return preferred;
  }
  const attentionSessions = group.sessions.filter((session) => notifications.has(session.id));
  return attentionSessions[0] ?? group.sessions[0];
}
