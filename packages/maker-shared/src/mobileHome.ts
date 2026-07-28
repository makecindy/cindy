import {
  groupAutomationListItems,
  sessionRowMessagePreview,
  toRemoteSessionListItem,
  type RemoteSessionLiveActivity,
  type RemoteSessionListItem,
  type RemoteSessionListSessionLike,
  type RemoteSessionScheduleInfo,
  type RemoteSessionStatusFilter,
} from './sessionList.js';
import { stripTrailingPathSeparators } from './pathText.js';
import { collapseWorktreeDirForGrouping } from './worktreePaths.js';

export const MOBILE_HOME_ALL_DEVICES = 'all';

export interface MobileHomeDeviceLike {
  canOpen?: boolean;
  deviceId: string;
  name: string;
  state?: string;
  /** 设备状态明细(deviceList statusDetail,带 lastSeen 相对时间等),noDevice 引导态展示用。 */
  statusDetail?: string;
  statusLabel?: string;
}

export interface MobileHomeSessionLike extends RemoteSessionListSessionLike {
  deviceLinkDeviceId?: string | null;
  deviceLinkDeviceName?: string | null;
  // 展示用规范设备 id(设备归并结果)。deviceLinkDeviceId 保持物理路由 key 不变,归并只体现在此字段。
  canonicalDeviceId?: string | null;
}

export interface MobileHomeDeviceFilterItem {
  available: boolean;
  deviceId: string | null;
  id: string;
  label: string;
  selected: boolean;
  sessionCount: number;
  state: string;
  statusLabel: string;
  waitingCount: number;
}

export interface MobileHomeProjectGroup {
  deviceId: string | null;
  deviceName: string;
  key: string;
  latestActivityAt: string;
  pendingInteractionCount: number;
  sessionCount: number;
  sessions: RemoteSessionListItem[];
  subtitle: string;
  title: string;
  workingDir: string;
}

export interface MobileHomeOverview {
  all: number;
  chats: number;
  devices: number;
  pinned: number;
  projects: number;
  waiting: number;
}

/**
 * 首页空态的语义分类,供客户端按场景选择渲染形态:
 * - noDevice 是「首次使用 / 产品模式说明」级空态(手机版当前仅远程访问电脑端 Cindy),
 *   客户端应渲染带连接指引的引导态(细分场景见 MobileHomeNoDeviceReason),而非普通一句话空态;
 * - 其余分类都是常规筛选/搜索空态,一句话说明即可。
 */
export type MobileHomeEmptyKind = 'search' | 'noDevice' | 'waiting' | 'automation' | 'archived' | 'noSession';

/**
 * noDevice 空态的细分场景 —— 按「离目标还差什么」给不同引导,优先挑最可行动的:
 * - firstRun:账号下没有任何桌面设备 → 完整产品说明 + 三步连接指引;
 * - accessRevoked:有设备但撤销了这台手机的访问 → 指名设备,引导重试访问 / 电脑端重新允许;
 * - remoteDisabled:电脑在线但未开远程控制 → 只差设置开关一步,给精确路径;
 * - offline:有绑定过的设备但都不在线 → 引导打开电脑上的 Cindy。
 * 多设备状态混合时按 accessRevoked > remoteDisabled > offline 的优先级归类
 * (撤销是用户显式动作需正面回应;「在线只差开关」比「先去开机」更可行动)。
 */
export type MobileHomeNoDeviceReason = 'firstRun' | 'accessRevoked' | 'remoteDisabled' | 'offline';

/** noDevice 空态的设备上下文,供引导态指名道姓地展示设备与状态。 */
export interface MobileHomeNoDeviceContext {
  reason: MobileHomeNoDeviceReason;
  /** 归类到该 reason 的设备(名字 + 状态说明),firstRun 恒为空。 */
  devices: Array<{ deviceId: string; name: string; statusDetail: string }>;
}

export interface MobileHomePresentation {
  chats: RemoteSessionListItem[];
  deviceFilters: MobileHomeDeviceFilterItem[];
  emptyCopy: string;
  emptyKind: MobileHomeEmptyKind;
  /** emptyKind === 'noDevice' 时的细分场景;其余空态为 null。 */
  emptyNoDevice: MobileHomeNoDeviceContext | null;
  emptyTitle: string;
  overview: MobileHomeOverview;
  pinned: RemoteSessionListItem[];
  primaryDevice: MobileHomeDeviceFilterItem | null;
  projects: MobileHomeProjectGroup[];
  selectedDeviceId: string | null;
}

export interface MobileHomeOptions {
  devices?: readonly MobileHomeDeviceLike[];
  messagePreviewIndex?: ReadonlyMap<string, string>;
  liveActivityIndex?: ReadonlyMap<string, RemoteSessionLiveActivity>;
  now?: number;
  pendingInteractionIndex?: ReadonlyMap<string, number>;
  scheduleIndex?: ReadonlyMap<string, RemoteSessionScheduleInfo>;
  searchQuery?: string;
  selectedDeviceId?: string | null;
  sessions: readonly MobileHomeSessionLike[];
  statusFilter?: RemoteSessionStatusFilter;
}

export function buildMobileHomePresentation({
  devices = [],
  messagePreviewIndex,
  liveActivityIndex,
  now = Date.now(),
  pendingInteractionIndex,
  scheduleIndex,
  searchQuery = '',
  selectedDeviceId = null,
  sessions,
  statusFilter = 'active',
}: MobileHomeOptions): MobileHomePresentation {
  // 设备身份归一化在管线源头对每个会话算出 canonicalDeviceId(写入字段,不改 deviceLinkDeviceId):
  // 后续设备筛选统计、matchesSelectedDevice 过滤、项目分组、概览、卡片 deviceId 全部按 canonicalDeviceId
  // 判断,保证「首页卡片 / 设备筛选 / 跳转参数」的设备维度一致;deviceLinkDeviceId 保持物理路由 key,
  // openSession / applySessionPatch 仍按它路由,不受归并影响。
  const deviceIdentity = buildDeviceIdentity(
    devices,
    sessions.map((session) => ({ deviceId: session.deviceLinkDeviceId, name: session.deviceLinkDeviceName })),
  );
  const normalizedSessions = sessions.map((session) => canonicalizeSessionDevice(session, deviceIdentity));
  const deviceFilters = buildDeviceFilters(devices, normalizedSessions, pendingInteractionIndex, selectedDeviceId);
  const normalizedSelectedDeviceId = normalizeSelectedDeviceId(deviceFilters, selectedDeviceId);
  const query = normalizeSearchQuery(searchQuery);
  const filteredSessions = normalizedSessions
    .filter((session) => matchesSelectedDevice(session, normalizedSelectedDeviceId))
    .filter((session) => matchesStatusFilter(session, statusFilter, pendingInteractionIndex, scheduleIndex))
    .filter((session) => matchesSearchQuery(
      session,
      query,
      messagePreviewIndex,
      liveActivityIndex,
      pendingInteractionIndex,
      scheduleIndex,
    ))
    .sort(compareSessionsByStatusThenActivityDesc);
  const items = filteredSessions.map((session) => toRemoteSessionListItem(
    session,
    now,
    scheduleIndex,
    pendingInteractionIndex?.get(session.id) ?? 0,
    // 已 load 的消息预览优先;未打开的 idle 会话回退到 device-link 带的 session.preview
    // (sessionRowMessagePreview 读取),与 buildRemoteSessionSections 同一套兜底。
    messagePreviewIndex?.get(session.id) ?? sessionRowMessagePreview(session),
    liveActivityIndex?.get(session.id) ?? null,
  ));
  const pinned = items.filter((item) => !!item.session.pinnedAt);
  const rest = items.filter((item) => !item.session.pinnedAt);
  // 同一自动化任务的多次运行折叠成一个组行(与设备详情页 buildRemoteSessionSections 同一套折叠,
  // 置顶行不参与,口径一致)。首页是多设备聚合列表,scopeKey 按维度隔离分组:
  // - chats(dialogue)按展示设备隔离 —— 防止 legacy fallback 键(仅 workingDir + 标题,无
  //   scheduleId)把两台电脑上的同名任务错并成一组;
  // - 项目侧直接用项目分桶键(设备 + 归一化路径,与 buildProjectGroups 同一把键)—— 任务改过
  //   项目目录后 run 分布在多个 workingDir 时各项目内各自成组,原项目不丢行、计数不漂移。
  const chats = groupAutomationListItems(
    rest.filter((item) => isDialogueSession(item.session)),
    now,
    true,
    (item) => sessionDeviceKey(item.session as MobileHomeSessionLike),
  );
  const projects = buildProjectGroups(
    groupAutomationListItems(
      rest.filter((item) => !isDialogueSession(item.session)),
      now,
      true,
      (item) => projectGroupKey(item.session),
    ),
    devices,
  );
  const overview = summarizeHomeOverview(normalizedSessions, projects, pendingInteractionIndex, normalizedSelectedDeviceId);
  const primaryDevice = pickPrimaryDevice(deviceFilters, normalizedSelectedDeviceId);
  const empty = mobileHomeEmptyState({
    deviceCount: deviceFilters.filter((item) => item.deviceId && item.available).length,
    devices,
    searchQuery,
    statusFilter,
  });

  return {
    chats,
    deviceFilters: markSelectedFilter(deviceFilters, normalizedSelectedDeviceId),
    emptyCopy: empty.copy,
    emptyKind: empty.kind,
    emptyNoDevice: empty.noDevice,
    emptyTitle: empty.title,
    overview,
    pinned,
    primaryDevice,
    projects,
    selectedDeviceId: normalizedSelectedDeviceId,
  };
}

function buildDeviceFilters(
  devices: readonly MobileHomeDeviceLike[],
  sessions: readonly MobileHomeSessionLike[],
  pendingInteractionIndex: ReadonlyMap<string, number> | undefined,
  selectedDeviceId: string | null,
): MobileHomeDeviceFilterItem[] {
  const deviceById = new Map<string, MobileHomeDeviceLike>();
  for (const device of devices) deviceById.set(device.deviceId, device);
  const statsByDevice = new Map<string, { sessionCount: number; waitingCount: number }>();
  for (const session of sessions) {
    const deviceId = sessionDeviceKey(session);
    if (!deviceId || session.status === 'deleted') continue;
    const stats = statsByDevice.get(deviceId) ?? { sessionCount: 0, waitingCount: 0 };
    stats.sessionCount += 1;
    if ((pendingInteractionIndex?.get(session.id) ?? 0) > 0) stats.waitingCount += 1;
    statsByDevice.set(deviceId, stats);
  }

  const allWaitingCount = [...statsByDevice.values()].reduce((sum, item) => sum + item.waitingCount, 0);
  const filters: MobileHomeDeviceFilterItem[] = [{
    available: true,
    deviceId: null,
    id: MOBILE_HOME_ALL_DEVICES,
    label: 'All',
    selected: selectedDeviceId === null || selectedDeviceId === MOBILE_HOME_ALL_DEVICES,
    sessionCount: [...statsByDevice.values()].reduce((sum, item) => sum + item.sessionCount, 0),
    state: 'ready',
    statusLabel: allWaitingCount > 0 ? `${allWaitingCount} 待处理` : '全部电脑',
    waitingCount: allWaitingCount,
  }];

  for (const device of devices) {
    const stats = statsByDevice.get(device.deviceId) ?? { sessionCount: 0, waitingCount: 0 };
    filters.push({
      available: device.canOpen !== false,
      deviceId: device.deviceId,
      id: device.deviceId,
      label: device.name,
      selected: selectedDeviceId === device.deviceId,
      sessionCount: stats.sessionCount,
      state: device.state ?? 'unknown',
      statusLabel: stats.waitingCount > 0 ? `${stats.waitingCount} 待处理` : (device.statusLabel ?? ''),
      waitingCount: stats.waitingCount,
    });
  }

  for (const session of sessions) {
    const deviceId = sessionDeviceKey(session);
    if (!deviceId || deviceById.has(deviceId) || filters.some((item) => item.deviceId === deviceId)) continue;
    const stats = statsByDevice.get(deviceId) ?? { sessionCount: 0, waitingCount: 0 };
    filters.push({
      available: true,
      deviceId,
      id: deviceId,
      label: session.deviceLinkDeviceName || deviceId,
      selected: selectedDeviceId === deviceId,
      sessionCount: stats.sessionCount,
      state: 'ready',
      statusLabel: stats.waitingCount > 0 ? `${stats.waitingCount} 待处理` : '已同步',
      waitingCount: stats.waitingCount,
    });
  }

  return filters;
}

function normalizeSelectedDeviceId(
  filters: readonly MobileHomeDeviceFilterItem[],
  selectedDeviceId: string | null | undefined,
): string | null {
  if (!selectedDeviceId || selectedDeviceId === MOBILE_HOME_ALL_DEVICES) return null;
  return filters.some((item) => item.deviceId === selectedDeviceId) ? selectedDeviceId : null;
}

function markSelectedFilter(
  filters: readonly MobileHomeDeviceFilterItem[],
  selectedDeviceId: string | null,
): MobileHomeDeviceFilterItem[] {
  return filters.map((filter) => ({
    ...filter,
    selected: selectedDeviceId ? filter.deviceId === selectedDeviceId : filter.deviceId === null,
  }));
}

function pickPrimaryDevice(
  filters: readonly MobileHomeDeviceFilterItem[],
  selectedDeviceId: string | null,
): MobileHomeDeviceFilterItem | null {
  if (selectedDeviceId) return filters.find((item) => item.deviceId === selectedDeviceId && item.available) ?? null;
  return filters.find((item) => item.deviceId && item.available) ?? null;
}

function buildProjectGroups(
  items: readonly RemoteSessionListItem[],
  devices: readonly MobileHomeDeviceLike[],
): MobileHomeProjectGroup[] {
  const deviceNames = new Map(devices.map((device) => [device.deviceId, device.name]));
  const grouped = new Map<string, RemoteSessionListItem[]>();
  for (const item of items) {
    // item.session.deviceLinkDeviceId 已在入口 canonicalizeSessionDevice 归一化,这里直接用。
    const key = projectGroupKey(item.session);
    const list = grouped.get(key) ?? [];
    list.push(item);
    grouped.set(key, list);
  }

  return [...grouped.entries()]
    .map(([key, group]) => {
      const first = group[0];
      const firstSession = first.session as MobileHomeSessionLike;
      const deviceId = sessionDeviceKey(firstSession) ?? null;
      const workingDir = normalizeProjectWorkingDir(firstSession.workingDir);
      const deviceName = firstSession.deviceLinkDeviceName
        ?? (deviceId ? deviceNames.get(deviceId) : null)
        ?? '未知电脑';
      return {
        deviceId,
        deviceName,
        key,
        // 用列表项的 lastActivityAt 而非 item.session 的时间:自动化组行的 session 是
        // primary(可能是较旧的未读 run),但其 lastActivityAt 已被共享层修正为组内最新。
        latestActivityAt: group.reduce((latest, item) =>
          item.lastActivityAt.localeCompare(latest) > 0 ? item.lastActivityAt : latest,
        first.lastActivityAt),
        pendingInteractionCount: group.reduce((sum, item) => sum + item.pendingInteractionCount, 0),
        sessionCount: group.reduce((sum, item) => sum + (item.automationGroup?.sessionCount ?? 1), 0),
        sessions: group,
        subtitle: [deviceName, workingDir].filter(Boolean).join(' · '),
        title: projectTitle(workingDir),
        workingDir,
      };
    })
    .sort((a, b) => b.latestActivityAt.localeCompare(a.latestActivityAt));
}

function projectGroupKey(session: RemoteSessionListSessionLike): string {
  // 分组用 canonicalDeviceId(设备归并结果),只补空值兜底 + workingDir 归一化(去尾斜杠 / Windows 大小写)。
  const deviceId = sessionDeviceKey(session as MobileHomeSessionLike)?.trim() || '__unknown_device__';
  return `device:${encodeURIComponent(deviceId)}:${normalizePathKey(session.workingDir ?? '__unknown_project__')}`;
}

/**
 * 首页设备身份索引。device-link 历史会话可能带着旧 deviceId;当它的设备名在当前设备列表里唯一
 * 匹配到一台设备时,把会话认领到该设备的当前 deviceId,避免同一台电脑的会话被旧 / 新 deviceId 拆开。
 * 设备名不唯一(重名或匹配不到当前设备)时保留原始 deviceId,绝不按名字合并 —— 否则两台同名的
 * 离线 / 历史设备会被错并成一台,破坏按设备维度的分组与筛选(per-device 分组保证)。
 */
export interface DeviceIdentityIndex {
  knownDeviceIds: ReadonlySet<string>;
  uniqueDeviceIdByName: ReadonlyMap<string, string>;
}

export function buildDeviceIdentity(
  devices: readonly MobileHomeDeviceLike[],
  // 待归一的会话 / shard 身份(deviceLinkDeviceId + 名),用于判断 stale 侧是否也无歧义 —— 只有当某设备名
  // 在 stale 侧也不重复时才认领,避免把「两台同名的旧 / 离线设备」一起并到同一台当前设备。
  rawIdentities: readonly { deviceId?: string | null; name?: string | null }[] = [],
): DeviceIdentityIndex {
  const knownDeviceIds = new Set<string>();
  const deviceIdsByName = new Map<string, string[]>();
  for (const device of devices) {
    const deviceId = device.deviceId.trim();
    if (!deviceId) continue;
    knownDeviceIds.add(deviceId);
    const name = normalizeDeviceNameKey(device.name);
    if (!name) continue;
    const ids = deviceIdsByName.get(name) ?? [];
    ids.push(deviceId);
    deviceIdsByName.set(name, ids);
  }

  // stale 侧(deviceId 不在当前设备列表)每个设备名对应的不同 deviceId 集合。
  const staleIdsByName = new Map<string, Set<string>>();
  for (const raw of rawIdentities) {
    const deviceId = raw.deviceId?.trim();
    if (!deviceId || knownDeviceIds.has(deviceId)) continue;
    const name = normalizeDeviceNameKey(raw.name);
    if (!name) continue;
    const ids = staleIdsByName.get(name) ?? new Set<string>();
    ids.add(deviceId);
    staleIdsByName.set(name, ids);
  }

  const uniqueDeviceIdByName = new Map<string, string>();
  for (const [name, ids] of deviceIdsByName) {
    if (ids.length !== 1) continue; // 当前设备侧该名字必须唯一
    if ((staleIdsByName.get(name)?.size ?? 0) > 1) continue; // stale 侧同名歧义 → 保守不认领
    uniqueDeviceIdByName.set(name, ids[0]);
  }
  return { knownDeviceIds, uniqueDeviceIdByName };
}

/**
 * 计算会话的「展示用规范设备 id」并写入 canonicalDeviceId 字段 —— 关键:**不改写 deviceLinkDeviceId**。
 * deviceLinkDeviceId 在 mobile 端同时是物理路由 key(openSession / applySessionPatch 按它路由到 store
 * shard),一旦改写就会把乐观补丁路由到不存在的 shard、丢失更新。所以设备归并只影响展示维度(分组 /
 * 筛选 / 概览 / 卡片 deviceId),用独立的 canonicalDeviceId 表达;路由仍走原始 deviceLinkDeviceId。
 */
function canonicalizeSessionDevice(
  session: MobileHomeSessionLike,
  identity: DeviceIdentityIndex,
): MobileHomeSessionLike {
  return {
    ...session,
    canonicalDeviceId: resolveCanonicalDeviceId(session.deviceLinkDeviceId, session.deviceLinkDeviceName, identity),
  };
}

/**
 * 设备身份归一化的核心:给 (deviceId, deviceName) 解析出「展示用规范 deviceId」。首页 mobileHome 与
 * mobile 端 remoteSessionStore 复用同一套语义,保证首页项目卡与设备详情页对『会话属于哪台设备』判断一致。
 * - 已知 deviceId:规整两端空白后保留;
 * - 未知 deviceId 但设备名唯一匹配当前某台设备:认领为该当前 deviceId(修复 re-link 后旧会话被拆开);
 * - 其它(名字不唯一 / 匹配不到 / 无名):保留原始 deviceId,不做按名合并 —— 否则两台同名的离线 / 历史
 *   设备会被错并成一台。空 deviceId(null / undefined / 纯空白)原样返回,由下游 `?? / ||` 兜底。
 */
export function resolveCanonicalDeviceId(
  rawDeviceId: string | null | undefined,
  deviceName: string | null | undefined,
  { knownDeviceIds, uniqueDeviceIdByName }: DeviceIdentityIndex,
): string | null | undefined {
  const raw = rawDeviceId?.trim() ?? '';
  if (raw && !knownDeviceIds.has(raw)) {
    const name = normalizeDeviceNameKey(deviceName);
    const claimed = name ? uniqueDeviceIdByName.get(name) : undefined;
    if (claimed) return claimed;
  }
  return raw || rawDeviceId;
}

/** 展示维度用的设备 key:优先 canonicalDeviceId(归一化结果),回退物理 deviceLinkDeviceId。 */
function sessionDeviceKey(session: MobileHomeSessionLike): string | null | undefined {
  return session.canonicalDeviceId ?? session.deviceLinkDeviceId;
}

function normalizeDeviceNameKey(value: string | null | undefined): string {
  const trimmed = (value ?? '').trim();
  // placeholder 名(unknown / no,与 deviceIdentityStore.isPlaceholderDeviceName 对齐)不参与设备身份匹配:
  // 否则多台未命名设备会因同为 placeholder 被错误归并。返回空 → buildDeviceIdentity / 认领会跳过它。
  const lower = trimmed.toLowerCase();
  return lower === 'unknown' || lower === 'no' ? '' : trimmed;
}

function summarizeHomeOverview(
  sessions: readonly MobileHomeSessionLike[],
  projects: readonly MobileHomeProjectGroup[],
  pendingInteractionIndex: ReadonlyMap<string, number> | undefined,
  selectedDeviceId: string | null,
): MobileHomeOverview {
  const scoped = sessions.filter((session) =>
    session.status !== 'deleted' && matchesSelectedDevice(session, selectedDeviceId));
  const chats = scoped.filter(isDialogueSession).length;
  const pinned = scoped.filter((session) => !!session.pinnedAt).length;
  const waiting = scoped.filter((session) => (pendingInteractionIndex?.get(session.id) ?? 0) > 0).length;
  const devices = new Set(scoped.map((session) => sessionDeviceKey(session)).filter(Boolean)).size;
  return {
    all: scoped.length,
    chats,
    devices,
    pinned,
    projects: projects.length,
    waiting,
  };
}

function matchesSelectedDevice(session: MobileHomeSessionLike, selectedDeviceId: string | null): boolean {
  return !selectedDeviceId || sessionDeviceKey(session) === selectedDeviceId;
}

function matchesStatusFilter(
  session: MobileHomeSessionLike,
  filter: RemoteSessionStatusFilter,
  pendingInteractionIndex: ReadonlyMap<string, number> | undefined,
  scheduleIndex: ReadonlyMap<string, RemoteSessionScheduleInfo> | undefined,
): boolean {
  if (filter === 'all') return session.status !== 'deleted';
  if (filter === 'waiting') {
    return session.status !== 'deleted' && (pendingInteractionIndex?.get(session.id) ?? 0) > 0;
  }
  if (filter === 'automation') {
    return session.status !== 'deleted' && isAutomationSession(session, scheduleIndex);
  }
  return session.status === filter;
}

function matchesSearchQuery(
  session: MobileHomeSessionLike,
  query: string,
  messagePreviewIndex: ReadonlyMap<string, string> | undefined,
  liveActivityIndex: ReadonlyMap<string, RemoteSessionLiveActivity> | undefined,
  pendingInteractionIndex: ReadonlyMap<string, number> | undefined,
  scheduleIndex: ReadonlyMap<string, RemoteSessionScheduleInfo> | undefined,
): boolean {
  if (!query) return true;
  const scheduleInfo = scheduleIndex?.get(session.id) ?? fallbackScheduleInfo(session);
  const haystack = [
    session.title,
    session.workingDir,
    session.model,
    session.agentKind,
    session.status,
    session.workspaceKind,
    session.worktreePath,
    session.deviceLinkDeviceName,
    scheduleInfo?.scheduleName,
    (pendingInteractionIndex?.get(session.id) ?? 0) > 0 ? '等待处理 waiting pending attention' : null,
    // 与首页展示同源:idle 行显示的是 messagePreviewIndex ?? sessionRowMessagePreview(session),
    // 搜索 haystack 必须纳入同一兜底,否则搜可见预览文字会把未打开的 idle 会话漏掉。
    messagePreviewIndex?.get(session.id) ?? sessionRowMessagePreview(session),
    liveActivityIndex?.get(session.id)?.compactDetail,
  ].filter(Boolean).join(' ').toLowerCase();
  return haystack.includes(query);
}

function compareSessionsByStatusThenActivityDesc(a: MobileHomeSessionLike, b: MobileHomeSessionLike): number {
  const statusDiff = sessionStatusRank(a.status) - sessionStatusRank(b.status);
  if (statusDiff !== 0) return statusDiff;
  return lastActivityTime(b).localeCompare(lastActivityTime(a));
}

function sessionStatusRank(status: string): number {
  if (status === 'active') return 0;
  if (status === 'archived') return 1;
  return 2;
}

function isDialogueSession(session: RemoteSessionListSessionLike): boolean {
  return session.workspaceKind === 'dialogue' || !session.workingDir;
}

function isAutomationSession(
  session: RemoteSessionListSessionLike,
  scheduleIndex: ReadonlyMap<string, RemoteSessionScheduleInfo> | undefined,
): boolean {
  return session.source === 'scheduler' || session.title.startsWith('[Schedule] ') || !!scheduleIndex?.get(session.id);
}

function fallbackScheduleInfo(session: RemoteSessionListSessionLike): RemoteSessionScheduleInfo | null {
  if (session.source !== 'scheduler' && !session.title.startsWith('[Schedule] ')) return null;
  const title = session.title.startsWith('[Schedule] ') ? session.title.slice('[Schedule] '.length) : session.title;
  return {
    latestRunAt: 0,
    running: false,
    scheduleId: '',
    scheduleName: title || '自动化任务',
    allSchedulesStopped: false,
    unreadCount: 0,
    unreadRunIds: [],
  };
}

function normalizeSearchQuery(value: string): string {
  return value.trim().toLowerCase();
}

function normalizePathKey(value: string): string {
  const normalized = normalizeProjectWorkingDir(value);
  if (isWindowsStylePath(normalized)) return normalized.replaceAll('\\', '/').toLowerCase();
  return normalized;
}

function normalizeProjectWorkingDir(value: string | null | undefined): string {
  const trimmed = (value ?? '').trim();
  // 去掉结尾的 / 与 \\(用线性回扫,不用 /[\\/]+$/ 正则 —— 后者无起始锚,
  // 在「大量斜杠 + 末尾非斜杠」输入下会 O(N²) 回溯,触发 polynomial ReDoS,CodeQL js/polynomial-redos)。
  let end = trimmed.length;
  while (end > 0 && (trimmed[end - 1] === '/' || trimmed[end - 1] === '\\')) end -= 1;
  // Windows 盘符根(C:\ / c:/)要保留根分隔符:去到只剩 "X:" 时,盘符根本身就是根目录,
  // 去掉分隔符会得到 drive-relative 的 "C:"(语义变成"当前盘的当前目录"),还会丢掉 Windows
  // 路径特征让 isWindowsStylePath 认不出,导致 C:\ 与 c:/ 无法归一、盘符根会话仍拆成重复卡。
  // 此时把紧跟 "X:" 的第一个分隔符保留下来。
  if (end === 2 && trimmed.length > 2 && trimmed[1] === ':' && isAsciiLetter(trimmed[0])) end = 3;
  // 全是斜杠时(end === 0)保留 trim 后原值,与旧 `replace(...) || value` 语义一致。
  const withoutTrailingSeparators = end > 0 ? trimmed.slice(0, end) : trimmed;
  // worktree 会话折叠到 base repo(与桌面侧栏 normalizeWorkingDirForGrouping 同一口径):
  // 不折叠的话每个 worktree 都会变成一个独立「项目」,标题是随机 worktree 名(serene-lovelace
  // 之类),Slack / 定时任务这类自动建 worktree 的会话尤其明显。worktree 身份仍由会话行与
  // 会话菜单的 worktreePath 单独展示,信息不丢。
  return collapseWorktreeDirForGrouping(withoutTrailingSeparators);
}

function isAsciiLetter(ch: string): boolean {
  return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z');
}

function isWindowsStylePath(value: string): boolean {
  // 盘符路径(C:\ / C:/)、UNC(反斜杠 \\Server 或正斜杠 //Server 两种上报形式)、或任何含反斜杠的路径都算
  // Windows 风格 —— 统一转 / 并小写化。正斜杠 UNC 也纳入,否则 \\Server\Share 与 //Server/Share 会拆卡。
  return /^[a-z]:[\\/]/i.test(value) || value.startsWith('\\\\') || value.startsWith('//') || value.includes('\\');
}

/**
 * 判断某会话的工作目录是否归属于给定项目的 workingDir —— 与首页项目分组(projectGroupKey)
 * 用**同一套归一化语义**(去尾斜杠、null 归一为 __unknown_project__),保证设备详情页按项目
 * 过滤的结果和首页分组一致。调用方需自行确保 deviceId 维度已对齐(同一台设备内比较)。
 */
export function sessionMatchesProjectDir(
  sessionWorkingDir: string | null | undefined,
  projectWorkingDir: string | null | undefined,
): boolean {
  return normalizePathKey(sessionWorkingDir ?? '__unknown_project__')
    === normalizePathKey(projectWorkingDir ?? '__unknown_project__');
}

function projectTitle(workingDir: string): string {
  const trimmed = stripTrailingPathSeparators(workingDir);
  const parts = trimmed.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || workingDir || '未分类项目';
}

function lastActivityTime(session: RemoteSessionListSessionLike): string {
  return session.userSendAt ?? session.updatedAt ?? session.createdAt;
}

function mobileHomeEmptyState({
  deviceCount,
  devices,
  searchQuery,
  statusFilter,
}: {
  deviceCount: number;
  devices: readonly MobileHomeDeviceLike[];
  searchQuery: string;
  statusFilter: RemoteSessionStatusFilter;
}): { kind: MobileHomeEmptyKind; noDevice: MobileHomeNoDeviceContext | null; title: string; copy: string } {
  if (searchQuery.trim()) {
    return {
      kind: 'search',
      noDevice: null,
      title: '没有匹配结果',
      copy: '换一个项目名、对话标题、电脑名或消息关键词再试。',
    };
  }
  if (deviceCount === 0) {
    // 首次使用 / 连接受阻的产品模式说明:手机版当前定位是电脑端 Cindy 的远程入口,而非独立客户端。
    // 客户端按 emptyKind=noDevice + reason 渲染对应引导(连接步骤 / 精确开关 / 重试访问 + 云端预告)。
    const noDevice = classifyNoDevice(devices);
    return { kind: 'noDevice', noDevice, ...noDeviceEmptyText(noDevice) };
  }
  if (statusFilter === 'waiting') {
    return {
      kind: 'waiting',
      noDevice: null,
      title: '没有待处理请求',
      copy: '权限确认、计划审阅和问题选择会在这里集中出现。',
    };
  }
  if (statusFilter === 'automation') {
    return {
      kind: 'automation',
      noDevice: null,
      title: '没有自动化会话',
      copy: '自动化任务运行后，对应会话会按项目聚合到这里。',
    };
  }
  if (statusFilter === 'archived') {
    return {
      kind: 'archived',
      noDevice: null,
      title: '没有归档会话',
      copy: '切到全部或活跃筛选，继续查看当前项目和对话。',
    };
  }
  return {
    kind: 'noSession',
    noDevice: null,
    title: '还没有会话',
    copy: '先在桌面端创建或继续一个会话，手机端会直接显示对应项目和对话。',
  };
}

/**
 * 无可用设备时的场景归类。按 accessRevoked > remoteDisabled > offline 优先挑最可行动的
 * 一类设备作引导对象(撤销需正面回应;「在线只差开关」比「先去开机」更近一步);
 * 完全没有设备则是 firstRun。
 */
function classifyNoDevice(devices: readonly MobileHomeDeviceLike[]): MobileHomeNoDeviceContext {
  const byReason = (state: string): MobileHomeNoDeviceContext['devices'] => devices
    .filter((device) => device.state === state)
    .map((device) => ({
      deviceId: device.deviceId,
      name: device.name,
      statusDetail: device.statusDetail ?? device.statusLabel ?? '',
    }));
  const revoked = byReason('access_revoked');
  if (revoked.length > 0) return { reason: 'accessRevoked', devices: revoked };
  const remoteDisabled = byReason('remote_disabled');
  if (remoteDisabled.length > 0) return { reason: 'remoteDisabled', devices: remoteDisabled };
  if (devices.length > 0) {
    // 剩余不可用设备统一按 offline 引导(含 unknown 等边缘态,「去电脑上打开 Cindy」总是对的下一步)。
    return {
      reason: 'offline',
      devices: devices.map((device) => ({
        deviceId: device.deviceId,
        name: device.name,
        statusDetail: device.statusDetail ?? device.statusLabel ?? '',
      })),
    };
  }
  return { reason: 'firstRun', devices: [] };
}

/** 「A」/「A」和「B」/「A」等 N 台:引导文案里的设备称呼。 */
function joinDeviceNames(devices: MobileHomeNoDeviceContext['devices']): string {
  const names = devices.map((device) => `「${device.name}」`);
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]}和${names[1]}`;
  return `${names[0]}等 ${names.length} 台电脑`;
}

function noDeviceEmptyText(context: MobileHomeNoDeviceContext): { title: string; copy: string } {
  switch (context.reason) {
    case 'accessRevoked':
      return {
        title: '访问权限已被撤销',
        copy: `${joinDeviceNames(context.devices)}撤销了这台手机的远程访问。可以重试申请，或在电脑上重新允许后自动恢复。`,
      };
    case 'remoteDisabled':
      return {
        title: '在电脑上允许远程控制',
        copy: `${joinDeviceNames(context.devices)}已经在线，还差最后一步：在电脑上打开允许手机控制的开关。`,
      };
    case 'offline':
      return {
        title: '打开电脑上的 Cindy',
        copy: '连接过的电脑现在都不在线。在电脑上打开 Cindy 并保持登录，手机会自动连上。',
      };
    default:
      return {
        title: '连接你电脑上的 Cindy',
        copy: '目前 Cindy 都运行在你的电脑上，手机版通过远程访问来让你使用电脑上的 Agent。',
      };
  }
}
