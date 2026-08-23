import { messageContentToPreview } from './messageNormalize.js';
import { stripTrailingPathSeparators } from './pathText.js';
import { presentationText, type PresentationLocalizer } from './presentationLocalization.js';
import { isSyntheticTriggerText } from './syntheticTrigger.js';
import type { RemoteSchedule, RemoteScheduleRun, RemoteScheduleRunStatus } from './scheduleTypes.js';
import { toMillis } from './scheduleModel.js';
import { sessionCollaborationLabel, sessionWorktreeLabel } from './sessionIdentity.js';
import { isDefaultDraftSessionTitle } from './sessionTitle.js';
import { getSessionListCollapseView } from './sessionListCollapse.js';
import { collapseWorktreeDirForGrouping } from './worktreePaths.js';

export interface RemoteSessionListSessionLike {
  _count?: { messages?: number } | null;
  agentKind: 'cc' | 'codex' | string;
  createdAt: string;
  effort?: string | null;
  fastMode?: boolean;
  id: string;
  model: string;
  orcaRole?: 'lead' | 'worker' | string | null;
  permissionMode?: string | null;
  pinnedAt?: string | null;
  source?: string | null;
  status: 'active' | 'archived' | 'deleted' | string;
  title: string;
  updatedAt: string;
  userId?: string;
  userSendAt?: string | null;
  workspaceKind?: 'project' | 'dialogue' | string | null;
  workingDir: string | null;
  worktreePath?: string | null;
  // device-link 会话列表(local-db:sessions:list)带的最近一条 user/assistant 消息纯文本预览,
  // 由桌面 sessionToCamel 产出(已处理 clearedAt / rewind / 角色过滤);idle 会话直接显示,
  // 无需 load 完整消息。sessionRowMessagePreview 会读取它。
  preview?: string | null;
}

export interface RemoteSessionListMessageLike {
  agentMeta?: Record<string, unknown> | null;
  clientId?: string | null;
  content?: unknown;
  createdAt?: string;
  id?: string | null;
  role: string;
  sessionId?: string;
  toolUseId?: string | null;
}

export type RemoteSessionListSession = RemoteSessionListSessionLike;
export type RemoteSessionListMessage = RemoteSessionListMessageLike;

export type RemoteSessionLiveActivityPhase = 'running' | 'needs-interaction' | 'completed' | 'error';

export interface RemoteSessionLiveActivity {
  sessionId: string;
  phase: RemoteSessionLiveActivityPhase;
  compactDetail: string;
  interactionKind?: string;
  attention?: boolean;
}

type RemoteSession = RemoteSessionListSessionLike;
type RemoteMessage = RemoteSessionListMessageLike;

export interface RemoteSessionListItem {
  session: RemoteSession;
  title: string;
  subtitle: string;
  detail: string;
  messagePreview?: string | null;
  liveActivity?: RemoteSessionLiveActivity | null;
  lastActivityAt: string;
  pendingInteractionCount: number;
  scheduleInfo: RemoteSessionScheduleInfo | null;
  worktreeLabel?: string | null;
  automationGroup?: RemoteAutomationSessionGroup;
}

export interface RemoteAutomationSessionGroup {
  key: string;
  /**
   * 不含 scopeKey 前缀的组键(`schedule:<id>` 或 `fallback:...`)。跳转「自动化任务作用域」页时
   * 用它做过滤条件 —— 目标页是单设备上下文,不需要 key 里的设备前缀。
   */
  baseKey: string;
  title: string;
  sessionIds: string[];
  sessionCount: number;
  primarySessionId: string;
  children: RemoteAutomationGroupChild[];
  /**
   * 组内每次运行的完整列表项(与 children 摘要同序)。首页 / 项目作用域页展开组时直接用它渲染
   * 与普通会话行同构的子行(HomeSessionRow),不用再从摘要字段拼装。子项自身不含 automationGroup。
   */
  items: RemoteSessionListItem[];
}

export interface RemoteAutomationGroupChild {
  sessionId: string;
  title: string;
  subtitle: string;
  detail: string;
  pendingInteractionCount: number;
  running: boolean;
  unreadCount: number;
}

export interface RemoteSessionScheduleInfo {
  scheduleId: string;
  scheduleName: string;
  scheduleStatus?: RemoteSchedule['status'];
  /** 同一会话的所有已知 schedule 绑定都已 paused / expired 时为 true；缺失按 false。 */
  allSchedulesStopped?: boolean;
  unreadRunIds: string[];
  unreadCount: number;
  running: boolean;
  latestRunAt: number;
}

export interface RemoteSessionSection {
  key: string;
  title: string;
  data: RemoteSessionListItem[];
}

export interface RemoteSessionOverview {
  active: number;
  all: number;
  archived: number;
  automation: number;
  pinned: number;
  projectCount: number;
  runningAutomation: number;
  waiting: number;
}

export interface RemoteSessionListContext {
  detail: string;
  hint: string;
  resultCount: number;
  rowCount: number;
  title: string;
}

export type RemoteSessionStatusFilter = 'active' | 'waiting' | 'automation' | 'archived' | 'all';

export interface RemoteSessionListOptions {
  statusFilter?: RemoteSessionStatusFilter;
  messagePreviewIndex?: ReadonlyMap<string, string>;
  liveActivityIndex?: ReadonlyMap<string, RemoteSessionLiveActivity>;
  pendingInteractionIndex?: ReadonlyMap<string, number>;
  searchQuery?: string;
  scheduleIndex?: ReadonlyMap<string, RemoteSessionScheduleInfo>;
  /**
   * 是否把同一自动化任务的多次运行折叠成一个 automationGroup 行(默认 true)。
   * 设备详情页需要折叠 + 展开;但项目作用域的精简页用 HomeSessionRow 渲染、无展开 UI,
   * 折叠会让被计入「查看全部 N 条」的其余 run 无法点开,故那里传 false 让每个 run 各自成行。
   */
  groupAutomations?: boolean;
  /**
   * 「尚未起名」任务的显示文案(已解析的 i18n 值)。不传则回落 workingDir → 「未命名任务」;
   * 共享层刻意不兜中文串,见 {@link remoteSessionDisplayTitle}。
   */
  unnamedLabel?: string;
}

export function buildRemoteSessionSections(
  sessions: readonly RemoteSession[],
  now = Date.now(),
  options: RemoteSessionListOptions = {},
): RemoteSessionSection[] {
  const statusFilter = options.statusFilter ?? 'all';
  const groupAutomations = options.groupAutomations ?? true;
  const query = normalizeSearchQuery(options.searchQuery);
  const items = [...sessions]
    .filter((session) => matchesStatusFilter(session, statusFilter, options))
    .filter((session) => matchesSearchQuery(session, query, {
      messagePreviewIndex: options.messagePreviewIndex,
      liveActivityIndex: options.liveActivityIndex,
      pendingInteractionIndex: options.pendingInteractionIndex,
      scheduleIndex: options.scheduleIndex,
      unnamedLabel: options.unnamedLabel,
    }))
    .sort(compareSessions)
    .map((session) => toRemoteSessionListItem(
      session,
      now,
      options.scheduleIndex,
      options.pendingInteractionIndex?.get(session.id) ?? 0,
      options.messagePreviewIndex?.get(session.id) ?? sessionRowMessagePreview(session),
      options.liveActivityIndex?.get(session.id) ?? null,
      options.unnamedLabel,
    ));

  const pinned = items.filter((item) => !!item.session.pinnedAt);
  const rest = items.filter((item) => !item.session.pinnedAt);
  const sections: RemoteSessionSection[] = [];

  if (pinned.length > 0) {
    sections.push({ key: 'pinned', title: '置顶', data: pinned });
  }

  sections.push(...buildProjectSections(rest, now, groupAutomations));

  return sections;
}

export function summarizeRemoteSessionOverview(
  sessions: readonly RemoteSession[],
  pendingInteractionIndex: ReadonlyMap<string, number>,
  scheduleIndex: ReadonlyMap<string, RemoteSessionScheduleInfo>,
): RemoteSessionOverview {
  let active = 0;
  let archived = 0;
  let automation = 0;
  let pinned = 0;
  let waiting = 0;
  const projects = new Set<string>();

  for (const session of sessions) {
    if (session.status === 'deleted') continue;
    if (session.status === 'active') active += 1;
    if (session.status === 'archived') archived += 1;
    if (session.pinnedAt) pinned += 1;
    // 与 buildProjectSections 同一把折叠口径:worktree 会话算进它所属主仓,
    // 否则概览里的项目数会比列表里的项目分区多出来。
    if (session.workingDir) projects.add(collapseWorktreeDirForGrouping(session.workingDir));
    if ((pendingInteractionIndex.get(session.id) ?? 0) > 0) waiting += 1;
    if (isAutomationSession(session, scheduleIndex)) automation += 1;
  }

  return {
    active,
    all: sessions.filter((session) => session.status !== 'deleted').length,
    archived,
    automation,
    pinned,
    projectCount: projects.size,
    runningAutomation: [...scheduleIndex.values()].filter((item) => item.running).length,
    waiting,
  };
}

export function remoteSessionFilterLabel(
  value: RemoteSessionStatusFilter,
  overview: RemoteSessionOverview,
  label = remoteSessionFilterBaseLabel(value),
): string {
  if (value === 'active') return `${label} ${overview.active}`;
  if (value === 'waiting') return `${label} ${overview.waiting}`;
  if (value === 'automation') return `${label} ${overview.automation}`;
  if (value === 'archived') return `${label} ${overview.archived}`;
  return `${label} ${overview.all}`;
}

export function remoteSessionFilterBaseLabel(value: RemoteSessionStatusFilter): string {
  if (value === 'active') return '活跃';
  if (value === 'waiting') return '待处理';
  if (value === 'automation') return '自动化';
  if (value === 'archived') return '归档';
  return '全部';
}

export function remoteSessionControlsSummary(
  statusFilter: RemoteSessionStatusFilter,
  overview: RemoteSessionOverview,
): string {
  return `${remoteSessionFilterLabel(statusFilter, overview)} · 项目分组`;
}

export function buildRemoteSessionListContext({
  overview,
  searchQuery,
  sections,
  statusFilter,
}: {
  overview: RemoteSessionOverview;
  searchQuery: string;
  sections: readonly RemoteSessionSection[];
  statusFilter: RemoteSessionStatusFilter;
}): RemoteSessionListContext {
  const normalizedQuery = normalizeSearchQuery(searchQuery);
  const rowCount = sections.reduce((sum, section) => sum + section.data.length, 0);
  const resultCount = sections.reduce((sum, section) =>
    sum + section.data.reduce((sectionSum, item) => sectionSum + (item.automationGroup?.sessionCount ?? 1), 0), 0);
  const resultCopy = resultCount > 0
    ? `${resultCount} 个${normalizedQuery ? '匹配' : ''}任务`
    : normalizedQuery
      ? '没有匹配任务'
      : '当前筛选无结果';
  const rowCopy = rowCount > 0 && rowCount !== resultCount ? ` · ${rowCount} 行` : '';
  return {
    detail: `${resultCopy}${rowCopy} · ${remoteSessionFilterLabel(statusFilter, overview)} · 项目分组`,
    hint: remoteSessionListHint(statusFilter, normalizedQuery),
    resultCount,
    rowCount,
    title: normalizedQuery ? '搜索结果' : remoteSessionListTitle(statusFilter),
  };
}

export function remoteSessionOverviewCopy(overview: RemoteSessionOverview): string {
  const parts = [
    overview.pinned > 0 ? `${overview.pinned} 个置顶` : null,
    overview.projectCount > 0 ? `${overview.projectCount} 个项目` : null,
    overview.runningAutomation > 0 ? `${overview.runningAutomation} 个自动化执行中` : null,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(' · ') : '当前电脑暂无可汇总的任务活动。';
}

export function deviceSessionEmptyState(
  statusFilter: RemoteSessionStatusFilter,
  searchQuery: string,
): { title: string; copy: string } {
  if (searchQuery.trim()) {
    return {
      title: '没有匹配的任务',
      copy: '换一个标题、项目路径、模型或消息关键词再试。',
    };
  }
  if (statusFilter === 'waiting') {
    return {
      title: '没有待处理请求',
      copy: '权限确认、计划审阅和问题选择会在这里集中出现。',
    };
  }
  if (statusFilter === 'automation') {
    return {
      title: '没有自动化生成的任务',
      copy: '自动化运行后，对应任务会聚合到这里。',
    };
  }
  if (statusFilter === 'archived') {
    return {
      title: '没有归档任务',
      copy: '长按任务可以批量归档或删除。',
    };
  }
  return {
    title: '这台电脑暂无活动任务',
    copy: '先在桌面端创建或继续一个任务，手机端会把它镜像到这里。',
  };
}

function remoteSessionListTitle(statusFilter: RemoteSessionStatusFilter): string {
  if (statusFilter === 'active') return '活跃任务';
  if (statusFilter === 'waiting') return '待处理任务';
  if (statusFilter === 'automation') return '自动化生成的任务';
  if (statusFilter === 'archived') return '归档任务';
  return '全部任务';
}

function remoteSessionListHint(statusFilter: RemoteSessionStatusFilter, searchQuery: string): string {
  if (searchQuery) return '搜索范围包含标题、项目路径、模型、自动化名称和消息预览。';
  if (statusFilter === 'waiting') return '这里集中显示需要在手机端确认的权限、计划和问题。';
  if (statusFilter === 'automation') return '自动化生成的任务会按计划聚合，展开后可以进入单次运行。';
  if (statusFilter === 'archived') return '长按归档任务可进入批量选择，然后恢复或删除。';
  if (statusFilter === 'all') return '活跃、归档和自动化生成的任务会一起显示，适合快速查找。';
  return '点开任务继续控制，长按任务进入批量选择。';
}

function buildProjectSections(
  items: readonly RemoteSessionListItem[],
  now: number,
  groupAutomations = true,
): RemoteSessionSection[] {
  const dialogue = groupAutomationListItems(items.filter((item) => isDialogueSession(item.session)), now, groupAutomations);
  const sections: RemoteSessionSection[] = [];
  if (dialogue.length > 0) {
    sections.push({ key: 'dialogue', title: '对话', data: dialogue });
  }

  const projectGroups = new Map<string, RemoteSessionListItem[]>();
  for (const item of items) {
    if (isDialogueSession(item.session)) continue;
    // worktree 会话按 base repo 归组(与首页 projectGroupKey、桌面侧栏同一口径),
    // 否则每个 worktree 会单独成一个随机名分区。
    const key = item.session.workingDir ? collapseWorktreeDirForGrouping(item.session.workingDir) : 'unknown';
    const list = projectGroups.get(key) ?? [];
    list.push(item);
    projectGroups.set(key, list);
  }
  for (const [workingDir, data] of [...projectGroups].sort(([a], [b]) => a.localeCompare(b))) {
    sections.push({
      key: `project:${workingDir}`,
      title: projectTitle(workingDir),
      data: groupAutomationListItems(data, now, groupAutomations),
    });
  }
  return sections;
}

/**
 * 远程会话在列表 / 菜单上应显示的标题。
 *
 * 「尚未起名」的哨兵**直接用调用方给的本地化兜底、不回落 workingDir**:回落会把完整
 * 工作目录路径当标题显示,与 desktop 侧的「未命名任务」不一致(PR #1031 review P1)。
 * 哨兵本身是 locale-independent 的英文字面量(见 ./sessionTitle.ts),原样显示会露出
 * "New Maker"。
 *
 * `unnamedLabel` 由调用方传入已解析的 i18n 文案(mobile 支持 en / ja / ko,本模块不能
 * 导出中文 UI 串),与 desktop 的 `getSessionDisplayTitle(session, unnamedLabel)` 同款
 * 签名。
 *
 * 空标题(非哨兵)保持既有兜底链 workingDir → 「未命名任务」不变。
 */
export function remoteSessionDisplayTitle(session: RemoteSession, unnamedLabel?: string): string {
  if (isDefaultDraftSessionTitle(session.title)) {
    // 调用方给了**已解析的 i18n 文案**就用它;没给则按「无标题」走既有兜底链
    // (workingDir → '未命名任务'),即本 PR 之前的行为 —— 但无论如何都不把英文哨兵
    // 原样显示出去。刻意不在共享层兜一个中文串:mobile 支持 en / ja / ko,那会让未接
    // i18n 的调用方悄悄显示中文(PR #1031 review P1)。
    return unnamedLabel || session.workingDir || '未命名任务';
  }
  return automationDisplayTitle(session) || session.workingDir || '未命名任务';
}

export function toRemoteSessionListItem(
  session: RemoteSession,
  now = Date.now(),
  scheduleIndex?: ReadonlyMap<string, RemoteSessionScheduleInfo>,
  pendingInteractionCount = 0,
  messagePreview: string | null = null,
  liveActivity: RemoteSessionLiveActivity | null = null,
  /** 「尚未起名」任务的显示文案,由调用方传已解析的 i18n 值(见 remoteSessionDisplayTitle)。 */
  unnamedLabel?: string,
): RemoteSessionListItem {
  const lastActivityAt = session.userSendAt ?? session.updatedAt ?? session.createdAt;
  const scheduleInfo = scheduleIndex?.get(session.id) ?? fallbackScheduleInfo(session);
  const worktreeLabel = sessionWorktreeLabel(session);
  return {
    session,
    title: remoteSessionDisplayTitle(session, unnamedLabel),
    subtitle: [
      sessionCollaborationLabel(session),
      worktreeLabel,
      agentLabel(session.agentKind),
      session.model,
      isDialogueSession(session) ? 'dialogue' : null,
    ].filter(Boolean).join(' · '),
    detail: [
      sessionStatusLabel(session.status),
      relativeTime(lastActivityAt, now),
      scheduleInfo?.running ? '自动化执行中' : null,
      scheduleInfo && scheduleInfo.unreadCount > 0 ? `${scheduleInfo.unreadCount} 个自动化未读` : null,
      pendingInteractionCount > 0 ? `等待处理 ${pendingInteractionCount} 个` : null,
      messageCountLabel(session._count?.messages),
    ].filter(Boolean).join(' · '),
    messagePreview,
    liveActivity,
    lastActivityAt,
    pendingInteractionCount,
    scheduleInfo,
    worktreeLabel,
  };
}

export interface RemoteSessionPreviewCollapseView {
  visibleItems: RemoteSessionListItem[];
  hiddenCount: number;
  totalCount: number;
}

/**
 * 手机端「组内子列表」(首页项目组 / 自动化组展开)的折叠视图,与桌面侧栏项目组同一套
 * getSessionListCollapseView 策略:默认只显示前 limit 条,豁免以下条目不折叠 ——
 *   1. 最近 24h 内有活动(lastActivityAt 落在 SESSION_LIST_COLLAPSE_RECENT_WINDOW_MS 窗口内);
 *   2. 需关注:等待处理的交互(pendingInteractionCount)、自动化未读 run(scheduleInfo.unreadCount)、
 *      live activity 标记 attention 或处于 needs-interaction / error;
 *   3. 正在执行中:scheduleInfo.running、live activity running,或宿主注入的 isSessionRunning
 *      (手机端 remoteSessionStore 的运行态,数据层拿不到所以走回调)。
 * 桌面的 isActiveEntry(当前打开的会话)在手机首页无对应概念,恒为 false。
 */
export function getRemoteSessionPreviewCollapse(
  items: readonly RemoteSessionListItem[],
  options: {
    limit: number;
    nowMs?: number;
    isSessionRunning?: (sessionId: string) => boolean;
  },
): RemoteSessionPreviewCollapseView {
  const { visibleEntries, hiddenCount, totalCount } = getSessionListCollapseView({
    entries: items,
    minVisibleCount: options.limit,
    nowMs: options.nowMs ?? Date.now(),
    getActivityMs: (item) => toMillis(item.lastActivityAt),
    showAll: false,
    disableCollapse: false,
    isFiltering: false,
    isActiveEntry: () => false,
    hasAttentionEntry: (item) => remoteSessionListItemExemptFromCollapse(item, options.isSessionRunning),
  });
  return { visibleItems: [...visibleEntries], hiddenCount, totalCount };
}

/**
 * 需关注或运行中即豁免。自动化组行必须下钻组内每次 run 再判一遍:组行虽聚合了
 * pendingInteractionCount(求和)与 scheduleInfo.running/unread(merge),但 liveActivity
 * 只来自 primary、isSessionRunning 回调也只会被喂 primary 的 session.id —— 非 primary
 * 的 run 正在宿主 store 里 streaming(或带 live attention)时,只看组行本身会漏判,
 * 整组可能被错误折叠。
 */
function remoteSessionListItemExemptFromCollapse(
  item: RemoteSessionListItem,
  isSessionRunning?: (sessionId: string) => boolean,
): boolean {
  if (remoteSessionListItemNeedsAttention(item) || remoteSessionListItemIsRunning(item, isSessionRunning)) {
    return true;
  }
  return (item.automationGroup?.items ?? []).some((member) =>
    remoteSessionListItemNeedsAttention(member) || remoteSessionListItemIsRunning(member, isSessionRunning));
}

/** 需关注:等待处理交互 / 自动化未读 run / live activity 请求关注。 */
function remoteSessionListItemNeedsAttention(item: RemoteSessionListItem): boolean {
  if (item.pendingInteractionCount > 0) return true;
  if ((item.scheduleInfo?.unreadCount ?? 0) > 0) return true;
  const live = item.liveActivity;
  return !!live && (live.attention === true || live.phase === 'needs-interaction' || live.phase === 'error');
}

function remoteSessionListItemIsRunning(
  item: RemoteSessionListItem,
  isSessionRunning?: (sessionId: string) => boolean,
): boolean {
  if (item.scheduleInfo?.running) return true;
  if (item.liveActivity?.phase === 'running') return true;
  return isSessionRunning?.(item.session.id) === true;
}

export function buildRemoteSessionCardPreview(
  item: RemoteSessionListItem,
  options: { running?: boolean; localizer?: PresentationLocalizer } = {},
): string | null {
  // 等待交互优先于一切:此时 compactDetail 往往是过期的 tool 状态行(典型
  // 'ask_user_question running...'),和"在等你"的语义打架。与桌面卡片 awaitingText
  // 同一策略与文案:按 interactionKind 出人话,不透传原始状态行。
  const live = item.liveActivity;
  const awaiting = item.pendingInteractionCount > 0
    || (live != null && isActiveLiveActivity(live) && live.phase === 'needs-interaction');
  if (awaiting) {
    const kind = live?.interactionKind;
    if (kind === 'permission') {
      return presentationText(
        options.localizer,
        'devices.presentation.sessionList.preview.permission',
        '等待授权',
      );
    }
    if (kind === 'plan_review') {
      return presentationText(
        options.localizer,
        'devices.presentation.sessionList.preview.planReview',
        '等待计划审阅',
      );
    }
    if (kind === 'ask_user_question') {
      return presentationText(
        options.localizer,
        'devices.presentation.sessionList.preview.answer',
        '等待你的回复',
      );
    }
    return presentationText(
      options.localizer,
      'devices.presentation.sessionList.preview.attention',
      '等待你处理',
    );
  }
  if (options.running === true) {
    if (live && isActiveLiveActivity(live)) {
      const text = normalizeInlinePreview(live.compactDetail);
      if (text) return text;
    }
    return item.scheduleInfo?.running || item.session.source === 'scheduler'
      ? presentationText(
          options.localizer,
          'devices.presentation.sessionList.preview.automationRunning',
          '自动化执行中',
        )
      : presentationText(
          options.localizer,
          'devices.presentation.sessionList.preview.running',
          '运行中',
        );
  }
  // idle:展示最近一条消息预览。messagePreview 来自已 load 的消息(打开过的会话),
  // 或由首页构建时回退到 device-link 带的 session.preview(见 buildMobileHomePresentation /
  // sessionRowMessagePreview)。真正零消息的会话返回 null(行不显示预览,符合预期)。
  return normalizeInlinePreview(item.messagePreview ?? '');
}

export function buildSessionScheduleIndex(
  schedules: readonly RemoteSchedule[],
  runsBySchedule: ReadonlyMap<string, readonly RemoteScheduleRun[]>,
): Map<string, RemoteSessionScheduleInfo> {
  const schedulesById = new Map(schedules.map((schedule) => [schedule.id, schedule]));
  const scheduleIdsBySession = new Map<string, Set<string>>();
  const index = new Map<string, RemoteSessionScheduleInfo>();
  const recordScheduleBinding = (sessionId: string, scheduleId: string) => {
    const scheduleIds = scheduleIdsBySession.get(sessionId) ?? new Set<string>();
    scheduleIds.add(scheduleId);
    scheduleIdsBySession.set(sessionId, scheduleIds);
  };
  for (const schedule of schedules) {
    if (!schedule.targetSessionId) continue;
    recordScheduleBinding(schedule.targetSessionId, schedule.id);
    if (!index.has(schedule.targetSessionId)) {
      index.set(schedule.targetSessionId, {
        scheduleId: schedule.id,
        scheduleName: schedule.name || schedule.id,
        scheduleStatus: schedule.status,
        allSchedulesStopped: false,
        unreadRunIds: [],
        unreadCount: 0,
        running: false,
        latestRunAt: 0,
      });
    }
  }
  for (const [scheduleId, runs] of runsBySchedule) {
    const schedule = schedulesById.get(scheduleId);
    for (const run of runs) {
      if (!run.sessionId) continue;
      // targetSessionId 是当前持久绑定的权威来源。schedule 改绑后，历史 run 仍保留旧
      // sessionId；继续把它们算作当前绑定会污染旧会话的聚合状态与未读信息。
      if (schedule?.targetSessionId && run.sessionId !== schedule.targetSessionId) continue;
      recordScheduleBinding(run.sessionId, scheduleId);
      const firedAt = toMillis(run.firedAt);
      const existing = index.get(run.sessionId);
      const unreadRunIds = existing ? [...existing.unreadRunIds] : [];
      if (isUnreadRunStatus(run.status) && !run.readAt) unreadRunIds.push(run.id);
      const running = (existing?.running ?? false) || run.status === 'running';
      const isLatest = !existing || firedAt >= existing.latestRunAt;
      index.set(run.sessionId, {
        scheduleId: isLatest ? scheduleId : existing.scheduleId,
        scheduleName: isLatest ? (schedule?.name || scheduleId) : existing.scheduleName,
        scheduleStatus: isLatest ? schedule?.status : existing.scheduleStatus,
        allSchedulesStopped: false,
        unreadRunIds,
        unreadCount: unreadRunIds.length,
        running,
        latestRunAt: Math.max(existing?.latestRunAt ?? 0, firedAt),
      });
    }
  }
  for (const [sessionId, info] of index) {
    const scheduleIds = scheduleIdsBySession.get(sessionId) ?? new Set<string>();
    const allSchedulesStopped = scheduleIds.size > 0 && Array.from(scheduleIds).every((scheduleId) => {
      const status = schedulesById.get(scheduleId)?.status;
      return status === 'paused' || status === 'expired';
    });
    index.set(sessionId, { ...info, allSchedulesStopped });
  }
  return index;
}

export function buildSessionMessagePreviewIndex(
  sessionIds: readonly string[],
  getMessages: (sessionId: string) => readonly RemoteMessage[],
): Map<string, string> {
  const index = new Map<string, string>();
  for (const sessionId of sessionIds) {
    const preview = latestSearchableMessagePreview(getMessages(sessionId));
    if (preview) index.set(sessionId, preview);
  }
  return index;
}

function matchesStatusFilter(
  session: RemoteSession,
  filter: RemoteSessionStatusFilter,
  options: RemoteSessionListOptions = {},
): boolean {
  if (filter === 'all') return session.status !== 'deleted';
  if (filter === 'waiting') {
    return session.status !== 'deleted' && (options.pendingInteractionIndex?.get(session.id) ?? 0) > 0;
  }
  if (filter === 'automation') {
    return session.status !== 'deleted' && isAutomationSession(session, options.scheduleIndex);
  }
  return session.status === filter;
}

export function matchesSearchQuery(
  session: RemoteSession,
  query: string,
  options: {
    messagePreviewIndex?: ReadonlyMap<string, string>;
    liveActivityIndex?: ReadonlyMap<string, RemoteSessionLiveActivity>;
    pendingInteractionIndex?: ReadonlyMap<string, number>;
    scheduleIndex?: ReadonlyMap<string, RemoteSessionScheduleInfo>;
    unnamedLabel?: string;
  } = {},
): boolean {
  if (!query) return true;
  const scheduleInfo = options.scheduleIndex?.get(session.id) ?? fallbackScheduleInfo(session);
  const haystack = [
    // 与列表展示**同源到函数级**:行上显示的就是 remoteSessionDisplayTitle 的结果
    // (见 toRemoteSessionListItem),haystack 直接调同一个函数。放原始 title 会两头错位
    // —— 搜界面上看得见的兜底文案一条都搜不到,搜内部哨兵 "New Maker" 反而命中一堆
    // 不显示这个词的行(PR #1031 review P1)。副作用:`[Schedule] ` 这个**不显示**的
    // 内部前缀不再可搜,自动化任务名另有 scheduleInfo.scheduleName 那条覆盖。
    remoteSessionDisplayTitle(session, options.unnamedLabel),
    session.workingDir,
    session.model,
    session.agentKind,
    session.status,
    session.orcaRole,
    session.worktreePath,
    sessionWorktreeLabel(session),
    scheduleInfo?.scheduleName,
    // automationDisplayTitle 不单列:非自动化会话它就等于原始 title(哨兵会从这条漏回
    // haystack),自动化会话的剥前缀标题已由上面的 remoteSessionDisplayTitle 覆盖。
    sessionCollaborationLabel(session),
    (options.pendingInteractionIndex?.get(session.id) ?? 0) > 0 ? '等待处理 waiting attention pending' : null,
    sessionRowMessagePreview(session),
    options.messagePreviewIndex?.get(session.id),
    options.liveActivityIndex?.get(session.id)?.compactDetail,
  ].filter(Boolean).join(' ').toLowerCase();
  return haystack.includes(query);
}

function isActiveLiveActivity(activity: RemoteSessionLiveActivity): boolean {
  return activity.phase === 'running' || activity.phase === 'needs-interaction';
}

function normalizeInlinePreview(value: string): string | null {
  const text = value.replace(/\s+/g, ' ').trim();
  return text.length > 0 ? text : null;
}

function compareSessions(a: RemoteSession, b: RemoteSession): number {
  const pinnedDiff = Number(!!b.pinnedAt) - Number(!!a.pinnedAt);
  if (pinnedDiff !== 0) return pinnedDiff;
  return lastActivity(b).localeCompare(lastActivity(a));
}

function normalizeSearchQuery(value: string | undefined): string {
  return value?.trim().toLowerCase() ?? '';
}

function isDialogueSession(session: RemoteSession): boolean {
  return session.workspaceKind === 'dialogue' || !session.workingDir;
}

function lastActivity(session: RemoteSession): string {
  return session.userSendAt ?? session.updatedAt ?? session.createdAt;
}

function projectTitle(workingDir: string): string {
  const trimmed = stripTrailingPathSeparators(workingDir);
  const parts = trimmed.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || workingDir;
}

const SCHEDULE_PREFIX = '[Schedule] ';

function isAutomationGeneratedSession(session: RemoteSession): boolean {
  return session.source === 'scheduler' || session.title.startsWith(SCHEDULE_PREFIX);
}

function isAutomationSession(
  session: RemoteSession,
  scheduleIndex?: ReadonlyMap<string, RemoteSessionScheduleInfo>,
): boolean {
  return isAutomationGeneratedSession(session) || !!scheduleIndex?.get(session.id);
}

function automationDisplayTitle(session: RemoteSession): string {
  if (!isAutomationGeneratedSession(session)) return session.title || '';
  return session.title.startsWith(SCHEDULE_PREFIX)
    ? session.title.slice(SCHEDULE_PREFIX.length)
    : session.title || '';
}

function fallbackScheduleInfo(session: RemoteSession): RemoteSessionScheduleInfo | null {
  if (!isAutomationGeneratedSession(session)) return null;
  const title = automationDisplayTitle(session) || '自动化';
  return {
    scheduleId: '',
    scheduleName: title,
    allSchedulesStopped: false,
    unreadRunIds: [],
    unreadCount: 0,
    running: false,
    latestRunAt: 0,
  };
}

/**
 * 把同一自动化任务的多次运行折叠成一个 automationGroup 行(顺序保持输入顺序,组行出现在
 * 组内第一条所在位置)。设备详情页由 buildRemoteSessionSections 内部调用;首页多设备聚合列表
 * (buildMobileHomePresentation)直接调用,并传 scopeKey 按设备隔离分组 —— scheduleId 是
 * 桌面端本地 cuid 不会跨设备相撞,但 legacy fallback 键(无 run 记录的 [Schedule] 标题会话)
 * 只含 workingDir + 标题,两台电脑跑同名任务同路径时若不加 scope 会被错并成一组。
 */
export function groupAutomationListItems(
  items: readonly RemoteSessionListItem[],
  now: number,
  enabled = true,
  scopeKey?: (item: RemoteSessionListItem) => string | null | undefined,
): RemoteSessionListItem[] {
  // 关闭折叠时每个 run 各自成行(项目作用域精简页用,详见 RemoteSessionListOptions.groupAutomations)。
  if (!enabled) return [...items];
  const groups = new Map<string, RemoteSessionListItem[]>();
  const itemGroupKeys = new Map<string, string>();
  for (const item of items) {
    const baseKey = automationGroupKey(item);
    const key = baseKey && scopeKey ? `${scopeKey(item) ?? ''}|${baseKey}` : baseKey;
    if (!key) continue;
    const group = groups.get(key) ?? [];
    group.push(item);
    groups.set(key, group);
    itemGroupKeys.set(item.session.id, key);
  }

  const emitted = new Set<string>();
  const next: RemoteSessionListItem[] = [];
  for (const item of items) {
    const key = itemGroupKeys.get(item.session.id);
    const group = key ? groups.get(key) : undefined;
    if (!key || !group || group.length <= 1) {
      next.push(item);
      continue;
    }
    if (emitted.has(key)) continue;
    emitted.add(key);
    next.push(toAutomationGroupListItem(key, group, now));
  }
  return next;
}

/**
 * 单条列表项的自动化组键(不含 scopeKey 前缀):`schedule:<id>`,或无 run 记录的 legacy 会话
 * 兜底 `fallback:...`。导出给「自动化任务作用域」页用同一算法反查某任务的全部运行。
 */
export function automationGroupKey(item: RemoteSessionListItem): string | null {
  if (!isAutomationGeneratedSession(item.session)) return null;
  const scheduleInfo = item.scheduleInfo;
  if (scheduleInfo?.scheduleId) return `schedule:${scheduleInfo.scheduleId}`;
  const workspace = item.session.workspaceKind ?? 'project';
  const dir = item.session.workingDir ?? '__no_working_dir__';
  return `fallback:${workspace}:${dir}:${item.title}`;
}

function toAutomationGroupListItem(
  key: string,
  group: readonly RemoteSessionListItem[],
  now: number,
): RemoteSessionListItem {
  const primary = pickAutomationPrimaryItem(group);
  const scheduleInfo = mergeScheduleInfo(group);
  const sessionIds = group.map((item) => item.session.id);
  const pendingInteractionCount = group.reduce((sum, item) => sum + item.pendingInteractionCount, 0);
  // 组行的活动时间取组内最新一条,不跟随 primary —— primary 可能是较旧的未读 / 运行中 run,
  // 用它的时间会让上游(首页项目卡 latestActivityAt、日期分桶、行右侧时间)把整组排成旧活动。
  const latestActivityAt = group.reduce(
    (latest, item) => (item.lastActivityAt.localeCompare(latest) > 0 ? item.lastActivityAt : latest),
    primary.lastActivityAt,
  );
  return {
    ...primary,
    lastActivityAt: latestActivityAt,
    title: scheduleInfo?.scheduleName ?? primary.title,
    subtitle: [
      '自动化',
      `${group.length} 个任务`,
      primary.worktreeLabel,
      agentLabel(primary.session.agentKind),
      primary.session.model,
    ].filter(Boolean).join(' · '),
    detail: [
      `${group.length} 个任务`,
      relativeTime(latestActivityAt, now),
      scheduleInfo?.running ? '自动化执行中' : null,
      scheduleInfo && scheduleInfo.unreadCount > 0 ? `${scheduleInfo.unreadCount} 个自动化未读` : null,
      pendingInteractionCount > 0 ? `等待处理 ${pendingInteractionCount} 个` : null,
    ].filter(Boolean).join(' · '),
    pendingInteractionCount,
    scheduleInfo,
    automationGroup: {
      key,
      baseKey: automationGroupKey(primary) ?? key,
      title: scheduleInfo?.scheduleName ?? primary.title,
      sessionIds,
      sessionCount: group.length,
      primarySessionId: primary.session.id,
      children: group.map((item) => ({
        sessionId: item.session.id,
        title: item.title,
        subtitle: item.subtitle,
        detail: item.detail,
        pendingInteractionCount: item.pendingInteractionCount,
        running: !!item.scheduleInfo?.running,
        unreadCount: item.scheduleInfo?.unreadCount ?? 0,
      })),
      items: [...group],
    },
  };
}

/**
 * 组的 primary(收起组"点行直开"的目标,也是组行的图标 / 预览来源):
 * 待处理交互 > 运行中 > 有未读 > 最新。待处理交互最优先 —— 它在等用户行动才能推进,
 * 组行的红点也来自它,点行必须落在这条上,否则用户要的确认被藏进展开列表。
 */
function pickAutomationPrimaryItem(group: readonly RemoteSessionListItem[]): RemoteSessionListItem {
  return group.find((item) => item.pendingInteractionCount > 0)
    ?? group.find((item) => item.scheduleInfo?.running)
    ?? group.find((item) => (item.scheduleInfo?.unreadCount ?? 0) > 0)
    ?? group[0];
}

function mergeScheduleInfo(group: readonly RemoteSessionListItem[]): RemoteSessionScheduleInfo | null {
  const primary = pickAutomationPrimaryItem(group);
  const base = primary.scheduleInfo;
  if (!base) return null;
  const unreadRunIds = Array.from(new Set(group.flatMap((item) => item.scheduleInfo?.unreadRunIds ?? [])));
  return {
    ...base,
    allSchedulesStopped: group.every((item) => item.scheduleInfo?.allSchedulesStopped === true),
    unreadRunIds,
    unreadCount: unreadRunIds.length,
    running: group.some((item) => item.scheduleInfo?.running),
    latestRunAt: Math.max(...group.map((item) => item.scheduleInfo?.latestRunAt ?? 0)),
  };
}

function isUnreadRunStatus(status: RemoteScheduleRunStatus): boolean {
  return status === 'success' || status === 'failed' || status === 'aborted' || status === 'interrupted';
}

function agentLabel(agentKind: RemoteSession['agentKind']): string {
  return agentKind === 'codex' ? 'Codex' : agentKind === 'pi' ? 'Pi' : 'Claude Code';
}

function sessionStatusLabel(status: RemoteSession['status']): string {
  if (status === 'active') return '活跃';
  if (status === 'archived') return '已归档';
  return '已删除';
}

function messageCountLabel(count: number | undefined): string | null {
  if (typeof count !== 'number') return null;
  return `${count} 条消息`;
}

function latestSearchableMessagePreview(messages: readonly RemoteMessage[]): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!isSearchablePreviewMessage(message)) continue;
    const preview = contentToSessionPreview(message.content);
    if (preview) return preview;
  }
  return null;
}

function isSearchablePreviewMessage(message: RemoteMessage): boolean {
  // silent-stop 自动续跑注入的「继续」(agentMeta.autoResume,桌面 main 守卫落库):
  // 消息流渲染成「已自动继续」分隔卡,预览同样不能把它当用户消息展示——按文本
  // 过滤不可行(用户真发「继续」是合法消息),只认落库标记。
  if (message.role === 'user' && message.agentMeta?.autoResume === true) return false;
  return message.role === 'user'
    || message.role === 'assistant'
    || message.role === 'system'
    || message.role === 'ask_user'
    || message.role === 'plan_review';
}

export function sessionRowMessagePreview(session: RemoteSession): string | null {
  const record = session as RemoteSession & {
    lastMessagePreview?: unknown;
    lastMessageText?: unknown;
    lastMessageContent?: unknown;
    messagePreview?: unknown;
  };
  // device-link 的 session.preview 已是桌面 extractMessagePreview 提炼好的纯文本(首页 idle
  // 行主来源),直接用(只折叠空白)。绝不能再过 contentToSessionPreview —— 否则用户消息正文
  // 恰好是 JSON 形(如 {"error":"login failed"})时会被当结构化内容解析、丢失原文。
  if (typeof record.preview === 'string') {
    const text = normalizeInlinePreview(record.preview);
    if (text) return text;
  }
  // 其余字段可能是原始 content(含结构化 JSON / 图片附件),仍走 contentToSessionPreview 提炼。
  for (const value of [
    record.lastMessagePreview,
    record.lastMessageText,
    record.messagePreview,
    record.lastMessageContent,
  ]) {
    const preview = contentToSessionPreview(value);
    if (preview) return preview;
  }
  return null;
}

function contentToSessionPreview(content: unknown): string {
  const preview = rawContentToSessionPreview(content);
  // 合成 UI 指令行(桌面「失败后继续」等隐藏续跑 prompt)不进预览:返回空让调用方
  // 落到上一条可见消息(latestSearchableMessagePreview 的倒序循环靠 falsy 跳过)。
  // structuredContentPreview 拼接时 text 恒在最前,startsWith 判定对拼接结果同样成立。
  return isSyntheticTriggerText(preview) ? '' : preview;
}

function rawContentToSessionPreview(content: unknown): string {
  const structured = structuredContentPreview(content);
  if (structured) return structured;
  if (typeof content === 'string') {
    const text = content.trim();
    const parsed = parseStructuredJsonString(text);
    if (parsed.didParse) {
      const parsedStructured = structuredContentPreview(parsed.value);
      if (parsedStructured) return parsedStructured;
      const parsedPreview = messageContentToPreview(parsed.value).trim();
      if (parsedPreview && !looksLikeSerializedJson(parsedPreview)) return parsedPreview;
      return parsedPreview ? '结构化内容' : '';
    }
    return text;
  }
  return messageContentToPreview(content).trim();
}

function parseStructuredJsonString(value: string): { didParse: boolean; value: unknown } {
  if (!looksLikeSerializedJson(value)) return { didParse: false, value };
  try {
    return { didParse: true, value: JSON.parse(value) };
  } catch {
    return { didParse: false, value };
  }
}

function looksLikeSerializedJson(value: string): boolean {
  const first = value.trimStart()[0];
  return first === '{' || first === '[';
}

function structuredContentPreview(content: unknown): string | null {
  if (Array.isArray(content)) {
    const parts = content.map(structuredContentPreview).filter(Boolean);
    return parts.length > 0 ? parts.join(' · ') : null;
  }
  if (!content || typeof content !== 'object') return null;

  const record = content as Record<string, unknown>;
  const text = typeof record.text === 'string' ? record.text.trim() : '';
  const images = summarizeContentRefs(record.images, '图片');
  const files = summarizeContentRefs(record.files ?? record.attachments, '附件');
  const media = summarizeContentRefs(record.media, '媒体');
  const parts = [text, images, files, media].filter((part): part is string => !!part);
  return parts.length > 0 ? parts.join(' · ') : null;
}

function summarizeContentRefs(value: unknown, label: string): string | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const first = value[0];
  const name = contentRefName(first);
  const more = value.length > 1 ? ` +${value.length - 1}` : '';
  return name ? `${label} ${name}${more}` : `${label} ${value.length}`;
}

function contentRefName(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  for (const key of ['name', 'originalName', 'fileName', 'path', 'url']) {
    const item = record[key];
    if (typeof item === 'string' && item.trim()) return item.trim().split('/').pop() ?? item.trim();
  }
  return null;
}

function relativeTime(iso: string, now: number): string {
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return '最近活动时间未知';
  const diffMinutes = Math.max(0, Math.floor((now - ts) / 60_000));
  if (diffMinutes < 1) return '刚刚';
  if (diffMinutes < 60) return `${diffMinutes} 分钟前`;
  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours} 小时前`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 7) return `${diffDays} 天前`;
  return new Date(ts).toLocaleDateString();
}

export function formatRemoteSessionSidebarTime(iso: string | undefined, now = Date.now()): string {
  if (!iso) return '';
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return '';

  const diffMs = Math.max(0, now - ts);
  const minuteMs = 60_000;
  const hourMs = 60 * minuteMs;
  const dayMs = 24 * hourMs;
  const weekMs = 7 * dayMs;
  const monthMs = 30 * dayMs;
  const yearMs = 365 * dayMs;

  if (diffMs < minuteMs) return '刚刚';
  if (diffMs < hourMs) return `${Math.max(1, Math.floor(diffMs / minuteMs))} 分钟`;
  if (diffMs < dayMs) return `${Math.max(1, Math.floor(diffMs / hourMs))} 小时`;
  if (diffMs < weekMs) return `${Math.max(1, Math.floor(diffMs / dayMs))} 天`;
  if (diffMs < monthMs) return `${Math.max(1, Math.floor(diffMs / weekMs))} 周`;
  if (diffMs < yearMs) return `${Math.max(1, Math.floor(diffMs / monthMs))} 月`;
  return `${Math.max(1, Math.floor(diffMs / yearMs))} 年`;
}
