import type { Session } from '@/lib/ccAgent.types';
import type { Schedule } from '@cindy/maker-scheduler';

import {
  getAutomationSessionDisplayTitle,
  isAutomationGeneratedSession,
} from './scheduledSessionGrouping';
import { normalizeWorkingDir } from './projectGrouping';
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
   * unreadRunIds 里是否至少有一个非成功结局(`failed` / `aborted` / `interrupted`)
   * 的 run —— 侧栏右侧状态指示器据此把 failed schedule 涂成红点(urgent),
   * 而不是和成功完成一样涂绿。
   */
  hasUnreadFailedRun: boolean;
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

export type AutomationScheduleAction = 'run' | 'edit' | 'toggle-pause' | 'delete';

interface ScopedAutomationGroupKey {
  key: string;
  legacyKey?: string;
}

function fallbackAutomationGroupKey(session: Session): ScopedAutomationGroupKey {
  const workspace = session.workspaceKind ?? 'project';
  const dir = normalizeWorkingDir(session.workingDir) ?? '__no_working_dir__';
  const title = getAutomationSessionDisplayTitle(session).trim() || session.id;
  return scopeAutomationGroupKey(`fallback:${workspace}:${dir}:${title}`, session);
}

function scopeAutomationGroupKey(key: string, session: Session): ScopedAutomationGroupKey {
  const deviceId = session.deviceLinkDeviceId?.trim();
  return deviceId ? { key: `${key}:device:${deviceId}`, legacyKey: key } : { key };
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
} | null {
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
  activeSessionId?: string;
  frozenVisibleSessionIds?: readonly string[] | null;
  /** 传入当前时间 ms 即启用「最近 24h 内有活动不折叠」豁免(和普通对话一致);不传走纯硬上限。 */
  nowMs?: number;
  /** 收起态默认展示条数,默认 5(和普通对话一致)。 */
  minVisibleCount?: number;
  /** 轴 1(文件夹开/关)的收起态。收起时只渲染 alertSessionIds 命中的运行,见下方 ⚠️。 */
  collapsed?: boolean;
  /**
   * 收起态仍要保留可见的**未处理告警**运行 id,来源是
   * `sidebar/projectCollapsedAttention.ts` 的 `resolveCollapsedAttention().errorSessionIds`
   * —— 与组头红点、项目折叠头红点同一份判据。
   */
  alertSessionIds?: ReadonlySet<string>;
}

/**
 * 计算自动化分组组头底下要展示哪些子运行。
 *
 * 展开态(showAll=false 且无冻结快照)复用与普通对话列表同源的
 * `getSessionListCollapseView`:默认前 N 条(默认 5)+ 传入 nowMs 时豁免最近 24h 内
 * 有活动的运行 + 需关注(未读)/运行中 + 当前打开的运行始终可见,超出由「显示全部」一次
 * 展开。**全部运行(含被组头代表的最新一条)都参与折叠并各自成行**,让最新未读也单独可见,
 * 与「显示全部」一致;组头点击打开哪条由组件单独算(getAutomationGroupPrimarySession),
 * 与列表行是"两个入口指向同一 session",不互斥。
 *
 * ⚠️ 收起态(options.collapsed)**不是空列表**:组内带未处理告警的运行会被提上来单独
 * 成行。原因是「组头只代表最新一条」+「收起时子行整片不渲染」叠起来会藏掉告警 ——
 * 项目折叠头按全部子任务汇总出红点,用户展开项目却在任何一行上都看不到它
 * (实测:一条被 App 重启打断、turn 从未收尾的定时任务运行)。告警行与组头红点同源
 * (alertSessionIds ← resolveCollapsedAttention),所以不可能出现「汇总说有、列表没有」。
 * 这也是折叠上限里「需关注的条目始终显示」那条不变量本来就该覆盖的路径。
 * 收起态刻意不套 24h / active 豁免:此时列表的语义是"只列要你处理的",
 * 把非告警运行放进来会让收起形同失效。
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

  // 收起:只提告警行。必须排在 frozen 之前 —— 冻结快照是展开态"前 N 条"防跳动用的,
  // 收起态套上去会把非告警运行一起带回来。也必须排在下方的 showAll 短路之前:
  // showAll 是两套列表共用的轴 2 状态,漏排会让收起态点过的「显示全部」把展开态
  // 直接渲染成整组历史(见 AutomationSessionGroupItem 切折叠时的复位注释)。
  if (options.collapsed) {
    const alertIds = options.alertSessionIds;
    const alertRuns = alertIds?.size ? allRuns.filter((session) => alertIds.has(session.id)) : [];
    const limit = options.showAll
      ? alertRuns.length
      : Math.max(0, options.minVisibleCount ?? SESSION_LIST_COLLAPSE_MIN_VISIBLE_COUNT);
    const visibleSessions = alertRuns.slice(0, limit);
    return {
      visibleSessions,
      isOverflowing: alertRuns.length > visibleSessions.length,
      // 收起态的「显示全部 N 个」N = 告警行总数(此时列表语义就是告警,不是整组)。
      totalCount: alertRuns.length,
      hiddenCount: alertRuns.length - visibleSessions.length,
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
    return withoutOverflow(frozenSessions);
  }

  // 默认展开态:全部运行套用普通对话同款折叠,每条(含被组头代表的最新一条)各自成行。
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
      (options.runningSessionIds?.has(session.id) ?? false),
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
 * 组内「最新一条」运行:按 sessionActivityMs(updatedAt / userSendAt 取较新)降序取首。
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
