/**
 * secondaryWindowRegistry —— 追踪「在新窗口打开 / 拖出窗口」的副窗口及其当前承载的任务或消息。
 *
 * 独立成零运行时 Electron 依赖的小模块，供 secondary-windows.ts 登记生命周期、
 * agent-island/service.ts 在灵动岛点击时优先定位已有副窗口，避免把重型窗口创建依赖
 * 拉进纯主进程服务与单测。
 */

import type { BrowserWindow } from 'electron';

export interface SecondaryWindowBootInfo {
  bootSession: string;
  bootDeviceId: string | null;
}

interface SecondaryWindowMeta extends SecondaryWindowBootInfo {
  createdOrder: number;
  lastFocusedOrder: number;
  /** 最近一次主帧导航观察到的 hash pathname（不含 query），用于在路由变更时清理旧可见会话。 */
  lastObservedHashPath: string | null;
  reportedSessionIds: ReadonlySet<string>;
  /** true 表示上报来自数组载荷（分屏多栏或 Orca Worker 面板），false 表示单会话字符串上报。 */
  reportedMultiSession: boolean;
  /** 上报发生时窗口所在的 hash pathname，与当前路由不一致时视为过期。 */
  reportedAtHashPath: string | null;
  /** 群聊副窗尚在 /cc-agent/boot 启动期间收到的消息定位，落到目标群聊路由后立即补发。 */
  pendingBootGroupDelivery: {
    groupId: string;
    conversationKind: 'group' | 'direct';
    deliver: (win: BrowserWindow) => void;
  } | null;
}

export type SecondaryWindowUrlTarget =
  | {
      kind: 'session';
      sessionId: string;
      workerSessionId: string | null;
      deviceId: string | null;
      /** true 表示停在 /cc-agent/files/:sessionId 文件浏览页，聊天栏可能已折叠。 */
      isFilesView?: boolean;
    }
  | {
      kind: 'companion';
      botId: string;
      deviceId: string | null;
      sessionId: string | null;
      /** true 表示停在带 ?settings=1 的伙伴设置页/抽屉，需导航切回对话。 */
      isSettingsView?: boolean;
    }
  | {
      kind: 'group';
      groupId: string;
      conversationKind: 'group' | 'direct';
    };

export interface SecondaryWindowSessionMatchTarget {
  sessionId: string;
  deviceId?: string | null;
  companion?: { botId: string; deviceId?: string | null } | null;
}

export interface SecondaryWindowGroupMatchTarget {
  groupId: string;
  conversationKind?: 'group' | 'direct';
}

export interface SecondaryWindowSessionMatch {
  window: BrowserWindow;
  /**
   * - `direct`: 副窗当前主视图已直接展示该会话对话（无需再发导航）。
   * - `booting`: 副窗尚在 `/cc-agent/boot` 网关启动中，将由 boot gate 自行落地。
   * - `navigate`: 副窗承载该会话但对话当前未在前台展示（后台分屏栏、文件页聊天栏已折叠或伙伴设置页 `?settings=1`），
   *   聚焦后需要向该副窗发送 `deep-link:navigate` 以切回对话视图。
   */
  matchKind: 'direct' | 'booting' | 'navigate';
}

export interface SecondaryWindowGroupMatch {
  window: BrowserWindow;
  isBooting: boolean;
}

const NON_SESSION_CC_AGENT_SEGMENTS = new Set([
  'boot',
  'files',
  'new',
  'new-dialogue',
  'scheduled',
  'orca',
]);

const NON_BOT_SEGMENTS = new Set(['list', 'roster', 'market', 'groups', 'remote']);

const secondaryWindows = new Set<BrowserWindow>();
const secondaryWindowMeta = new WeakMap<BrowserWindow, SecondaryWindowMeta>();
let windowOrderSequence = 0;

function safeDecodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function normalizeDeviceId(deviceId: string | null | undefined): string | null {
  const trimmed = typeof deviceId === 'string' ? deviceId.trim() : '';
  return trimmed || null;
}

function normalizeCompanionDeviceId(deviceId: string | null | undefined): string | null {
  const normalized = normalizeDeviceId(deviceId);
  return normalized === 'local' ? null : normalized;
}

function resolveBootDeviceFallback(
  bootFallback: SecondaryWindowBootInfo | undefined,
  sessionId: string,
  workerSessionId: string | null,
): string | null {
  if (!bootFallback) return null;
  const bootSession = bootFallback.bootSession.trim();
  if (!bootSession) return null;
  const matchesBootSession =
    bootSession === sessionId || (workerSessionId !== null && bootSession === workerSessionId);
  if (!matchesBootSession) return null;
  // 明确知道是从本机任务启动的副窗时标记为 'local'，避免被其它设备的同 ID 远程任务误命中。
  return normalizeDeviceId(bootFallback.bootDeviceId) ?? 'local';
}

function extractNormalizedHashPath(rawUrl: string): string | null {
  const trimmedUrl = typeof rawUrl === 'string' ? rawUrl.trim() : '';
  if (!trimmedUrl || trimmedUrl === 'about:blank') return null;
  try {
    const parsed = new URL(trimmedUrl);
    const rawHash = parsed.hash.startsWith('#') ? parsed.hash.slice(1) : parsed.hash;
    const queryIdx = rawHash.indexOf('?');
    const rawHashPath = queryIdx >= 0 ? rawHash.slice(0, queryIdx) : rawHash;
    return rawHashPath.replace(/\/+$/, '') || '/';
  } catch {
    return null;
  }
}

function clearReportedSessions(meta: SecondaryWindowMeta): void {
  meta.reportedSessionIds = new Set();
  meta.reportedMultiSession = false;
  meta.reportedAtHashPath = null;
}

function isDeviceCompatible(
  windowDeviceId: string | null,
  targetDeviceId?: string | null,
): boolean {
  const normalizedWindow = normalizeDeviceId(windowDeviceId);
  const normalizedTarget = normalizeDeviceId(targetDeviceId);
  if (!normalizedWindow) return true;
  if (!normalizedTarget) return normalizedWindow === 'local';
  return normalizedWindow === normalizedTarget;
}

function parseRouteTarget(
  rawPath: string,
  rawSearch = '',
  bootFallback?: SecondaryWindowBootInfo,
): SecondaryWindowUrlTarget | null {
  const trimmedPath = rawPath.trim();
  if (!trimmedPath) return null;
  const normalizedPath = (trimmedPath.startsWith('/') ? trimmedPath : `/${trimmedPath}`).replace(
    /\/+$/,
    '',
  );
  if (!normalizedPath) return null;

  const params = new URLSearchParams(rawSearch);

  if (normalizedPath.startsWith('/cc-agent/')) {
    const restSegments = normalizedPath.slice('/cc-agent/'.length).split('/');
    if (restSegments.length === 1) {
      const sessionId = safeDecodeSegment(restSegments[0] ?? '').trim();
      if (!sessionId || NON_SESSION_CC_AGENT_SEGMENTS.has(sessionId)) return null;
      const workerSessionId = params.get('worker')?.trim() || null;
      const explicitDevice = normalizeDeviceId(params.get('device'));
      const deviceId =
        explicitDevice ?? resolveBootDeviceFallback(bootFallback, sessionId, workerSessionId);
      return { kind: 'session', sessionId, workerSessionId, deviceId };
    }
    if (restSegments.length === 2 && (restSegments[0] === 'files' || restSegments[0] === 'orca')) {
      const sessionId = safeDecodeSegment(restSegments[1] ?? '').trim();
      if (!sessionId) return null;
      const explicitDevice = normalizeDeviceId(params.get('device'));
      const deviceId = explicitDevice ?? resolveBootDeviceFallback(bootFallback, sessionId, null);
      return {
        kind: 'session',
        sessionId,
        workerSessionId: null,
        deviceId,
        ...(restSegments[0] === 'files' ? { isFilesView: true } : {}),
      };
    }
    return null;
  }

  if (normalizedPath.startsWith('/bots/')) {
    const restSegments = normalizedPath.slice('/bots/'.length).split('/');
    if (restSegments[0] === 'groups' && restSegments.length === 2) {
      const groupId = safeDecodeSegment(restSegments[1] ?? '').trim();
      if (!groupId) return null;
      const conversationKind = params.get('conversationKind') === 'direct' ? 'direct' : 'group';
      return { kind: 'group', groupId, conversationKind };
    }
    if (
      restSegments[0] === 'remote' &&
      (restSegments.length === 3 ||
        (restSegments.length === 5 && (restSegments[3] === 'session' || restSegments[3] === 'history')))
    ) {
      const deviceId = safeDecodeSegment(restSegments[1] ?? '').trim();
      const botId = safeDecodeSegment(restSegments[2] ?? '').trim();
      const sessionId = restSegments.length === 5 ? safeDecodeSegment(restSegments[4] ?? '').trim() : '';
      if (!deviceId || !botId) return null;
      const isSettingsView = params.get('settings') === '1';
      return {
        kind: 'companion',
        deviceId,
        botId,
        sessionId: sessionId || null,
        ...(isSettingsView ? { isSettingsView: true } : {}),
      };
    }
    if (
      restSegments.length === 1 ||
      (restSegments.length === 3 && (restSegments[1] === 'session' || restSegments[1] === 'history'))
    ) {
      const botId = safeDecodeSegment(restSegments[0] ?? '').trim();
      if (!botId || NON_BOT_SEGMENTS.has(botId)) return null;
      const sessionId = restSegments.length === 3 ? safeDecodeSegment(restSegments[2] ?? '').trim() : '';
      const isSettingsView = params.get('settings') === '1';
      return {
        kind: 'companion',
        deviceId: null,
        botId,
        sessionId: sessionId || null,
        ...(isSettingsView ? { isSettingsView: true } : {}),
      };
    }
  }

  return null;
}

function parseBootTarget(boot: SecondaryWindowBootInfo): SecondaryWindowUrlTarget | null {
  const trimmed = boot.bootSession.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('/bots/') || trimmed.startsWith('/cc-agent/')) {
    const queryIdx = trimmed.indexOf('?');
    const routePath = queryIdx >= 0 ? trimmed.slice(0, queryIdx) : trimmed;
    const routeSearch = queryIdx >= 0 ? trimmed.slice(queryIdx + 1) : '';
    return parseRouteTarget(routePath, routeSearch, boot);
  }
  return {
    kind: 'session',
    sessionId: trimmed,
    workerSessionId: null,
    deviceId: normalizeDeviceId(boot.bootDeviceId) ?? 'local',
  };
}

/**
 * 解析副窗口当前 URL 所指向的任务 / 伙伴 / 群聊目标。
 * 窗口尚在冷加载或 `/cc-agent/boot` 网关阶段时，从启动参数回推目标并标记 `isBooting`。
 */
export function parseSecondaryWindowUrlTarget(
  rawUrl: string,
  bootFallback?: SecondaryWindowBootInfo,
): { target: SecondaryWindowUrlTarget | null; isBooting: boolean } {
  const trimmedUrl = typeof rawUrl === 'string' ? rawUrl.trim() : '';
  if (!trimmedUrl || trimmedUrl === 'about:blank') {
    return {
      target: bootFallback ? parseBootTarget(bootFallback) : null,
      isBooting: Boolean(bootFallback),
    };
  }
  try {
    const parsed = new URL(trimmedUrl);
    const rawHash = parsed.hash.startsWith('#') ? parsed.hash.slice(1) : parsed.hash;
    const queryIdx = rawHash.indexOf('?');
    const rawHashPath = queryIdx >= 0 ? rawHash.slice(0, queryIdx) : rawHash;
    const rawHashSearch = queryIdx >= 0 ? rawHash.slice(queryIdx + 1) : '';
    const normalizedHashPath = rawHashPath.replace(/\/+$/, '') || '/';

    const urlBootSession = parsed.searchParams.get('bootSession')?.trim() ?? '';
    const urlBootDevice = normalizeDeviceId(parsed.searchParams.get('bootDevice'));
    const effectiveBoot: SecondaryWindowBootInfo | undefined = urlBootSession
      ? { bootSession: urlBootSession, bootDeviceId: urlBootDevice }
      : bootFallback;

    if (normalizedHashPath === '/cc-agent/boot' || (normalizedHashPath === '/' && effectiveBoot)) {
      return {
        target: effectiveBoot ? parseBootTarget(effectiveBoot) : null,
        isBooting: true,
      };
    }

    return {
      target: parseRouteTarget(normalizedHashPath, rawHashSearch, effectiveBoot),
      isBooting: false,
    };
  } catch {
    return { target: null, isBooting: false };
  }
}

export function registerSecondaryAppWindow(
  win: BrowserWindow,
  bootInfo: SecondaryWindowBootInfo,
): void {
  const order = ++windowOrderSequence;
  secondaryWindows.add(win);
  secondaryWindowMeta.set(win, {
    createdOrder: order,
    lastFocusedOrder: order,
    bootSession: bootInfo.bootSession,
    bootDeviceId: normalizeDeviceId(bootInfo.bootDeviceId),
    lastObservedHashPath: extractNormalizedHashPath(readWindowUrl(win)),
    reportedSessionIds: new Set(),
    reportedMultiSession: false,
    reportedAtHashPath: null,
    pendingBootGroupDelivery: null,
  });
  win.on?.('focus', () => {
    const meta = secondaryWindowMeta.get(win);
    if (meta) meta.lastFocusedOrder = ++windowOrderSequence;
  });
  win.webContents?.on?.('did-navigate', () => {
    const meta = secondaryWindowMeta.get(win);
    if (!meta) return;
    clearReportedSessions(meta);
    meta.lastObservedHashPath = extractNormalizedHashPath(readWindowUrl(win));
  });
  // SecondaryWindowBootGate 位于 MainLayout 之内；一旦页面内导航离开 /cc-agent/boot
  // 落到目标群聊路由，MainLayout 的 onDeepLinkNavigate 必然已挂载，可安全补发消息定位。
  // 同时仅在主帧路由 pathname 实际切换时清掉上一路由的可见会话缓存（切文件 tab 仅变 query 则保留）。
  win.webContents?.on?.('did-navigate-in-page', (_event?: unknown, _url?: unknown, isMainFrame?: unknown) => {
    if (isMainFrame === false) return;
    const meta = secondaryWindowMeta.get(win);
    if (meta) {
      const nextHashPath = extractNormalizedHashPath(readWindowUrl(win));
      if (nextHashPath !== meta.lastObservedHashPath) {
        clearReportedSessions(meta);
        meta.lastObservedHashPath = nextHashPath;
      }
    }
    flushPendingBootGroupDelivery(win);
  });
  win.once?.('closed', () => {
    unregisterSecondaryAppWindow(win);
  });
}

function flushPendingBootGroupDelivery(win: BrowserWindow): void {
  if (win.isDestroyed()) return;
  const meta = secondaryWindowMeta.get(win);
  const pending = meta?.pendingBootGroupDelivery;
  if (!meta || !pending) return;
  const { target, isBooting } = parseSecondaryWindowUrlTarget(readWindowUrl(win), meta);
  if (isBooting) return;
  meta.pendingBootGroupDelivery = null;
  if (
    target?.kind === 'group' &&
    target.groupId === pending.groupId &&
    target.conversationKind === pending.conversationKind
  ) {
    pending.deliver(win);
  }
}

/**
 * 群聊副窗口仍在启动网关（`/cc-agent/boot`）时暂存本次消息/线程定位，待落到目标群聊后补发。
 * 若调用瞬间窗口其实已离开启动态且命中目标群聊，则立即投递；仅保留最新一次点击。
 */
export function queueSecondaryWindowBootGroupNavigation(
  win: BrowserWindow,
  target: SecondaryWindowGroupMatchTarget,
  deliver: (win: BrowserWindow) => void,
): void {
  if (!isSecondaryAppWindow(win)) return;
  const meta = secondaryWindowMeta.get(win);
  if (!meta) return;
  const groupId = target.groupId.trim();
  if (!groupId) return;
  const conversationKind = target.conversationKind ?? 'group';
  meta.pendingBootGroupDelivery = { groupId, conversationKind, deliver };
  flushPendingBootGroupDelivery(win);
}

export function unregisterSecondaryAppWindow(win: BrowserWindow): void {
  secondaryWindows.delete(win);
  secondaryWindowMeta.delete(win);
}

/**
 * 是不是通过 secondary-windows 开出来的会话副窗口。
 *
 * 给 main 侧那些「只想放行承载应用外壳(router / MainLayout)的窗口」的闸用：副窗口跑的是
 * 同一套路由,设置页在里面照样打得开;而 appContentWindows 那个 WeakSet 还包含右侧栏、
 * Ghost 面板 —— 它们不承载路由,不该拿到这类能力。
 */
export function isSecondaryAppWindow(win: BrowserWindow | null | undefined): boolean {
  return Boolean(win && !win.isDestroyed() && secondaryWindows.has(win));
}

export function getSecondaryAppWindows(): ReadonlySet<BrowserWindow> {
  return secondaryWindows;
}

/**
 * 同步某扇副窗口当前在 renderer 中实际可见的会话集合（含分屏多栏与 Orca Worker 面板）。
 * 即使窗口当前未聚焦也要记录，供用户从其它应用点击灵动岛时找回对应的副窗口。
 */
export function updateSecondaryWindowVisibleSessions(
  win: BrowserWindow,
  sessionIds: string | readonly string[] | null,
): void {
  if (!isSecondaryAppWindow(win)) return;
  const meta = secondaryWindowMeta.get(win);
  if (!meta) return;
  const currentUrl = readWindowUrl(win);
  const currentHashPath = extractNormalizedHashPath(currentUrl);
  const { target: urlTarget, isBooting } = parseSecondaryWindowUrlTarget(currentUrl, meta);
  meta.lastObservedHashPath = currentHashPath;

  const isArrayPayload = Array.isArray(sessionIds);
  const normalized = new Set<string>();
  if (typeof sessionIds === 'string') {
    const trimmed = sessionIds.trim();
    if (trimmed) normalized.add(trimmed);
  } else if (isArrayPayload) {
    for (const value of sessionIds) {
      if (typeof value !== 'string') continue;
      const trimmed = value.trim();
      if (trimmed) normalized.add(trimmed);
    }
  }

  if (normalized.size === 0 || isBooting || !urlTarget) {
    clearReportedSessions(meta);
    return;
  }

  if (isArrayPayload) {
    // 数组载荷仅来自主内容区的分屏树或 Orca 协同面板；文件页与伙伴设置页不承载分屏，
    // 普通任务/Orca 路由下的数组必须包含当前 URL 主会话，避免切走后的迟到上报污染注册表。
    const arrayValidForRoute =
      (urlTarget.kind === 'session' &&
        !urlTarget.isFilesView &&
        normalized.has(urlTarget.sessionId)) ||
      urlTarget.kind === 'group' ||
      (urlTarget.kind === 'companion' && !urlTarget.isSettingsView);
    if (!arrayValidForRoute) {
      if (meta.reportedAtHashPath !== currentHashPath) clearReportedSessions(meta);
      return;
    }
  } else {
    // 单会话字符串载荷只允许确认当前路由自身所指会话（如文件页聊天栏展开、或远程伙伴
    // 路由未含 sessionId 时上报自身主会话）；拦住离开 Orca Lead 后 OrcaWorkerPanel
    // 卸载 cleanup 补发的旧 leadSessionId。
    const singleSession = [...normalized][0]!;
    const singleValidForRoute =
      (urlTarget.kind === 'session' &&
        (singleSession === urlTarget.sessionId || singleSession === urlTarget.workerSessionId)) ||
      (urlTarget.kind === 'companion' &&
        !urlTarget.isSettingsView &&
        (urlTarget.sessionId === null || urlTarget.sessionId === singleSession));
    if (!singleValidForRoute) {
      if (meta.reportedAtHashPath !== currentHashPath) clearReportedSessions(meta);
      return;
    }
  }

  meta.reportedSessionIds = normalized;
  meta.reportedMultiSession = isArrayPayload;
  meta.reportedAtHashPath = currentHashPath;
}

interface RankedWindowCandidate<T> {
  result: T;
  focused: boolean;
  minimized: boolean;
  directMatch: boolean;
  lastFocusedOrder: number;
}

function pickBestCandidate<T>(candidates: RankedWindowCandidate<T>[]): T | null {
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => {
    if (a.focused !== b.focused) return a.focused ? -1 : 1;
    if (a.minimized !== b.minimized) return a.minimized ? 1 : -1;
    if (a.directMatch !== b.directMatch) return a.directMatch ? -1 : 1;
    return b.lastFocusedOrder - a.lastFocusedOrder;
  });
  return candidates[0]!.result;
}

function readWindowUrl(win: BrowserWindow): string {
  try {
    return typeof win.webContents?.getURL === 'function' ? win.webContents.getURL() : '';
  } catch {
    return '';
  }
}

function safeIsFocused(win: BrowserWindow): boolean {
  try {
    return typeof win.isFocused === 'function' && win.isFocused();
  } catch {
    return false;
  }
}

function safeIsMinimized(win: BrowserWindow): boolean {
  try {
    return typeof win.isMinimized === 'function' && win.isMinimized();
  } catch {
    return false;
  }
}

/**
 * 查找当前已经承载目标任务或伙伴对话的副窗口（优先当前聚焦、非最小化、直接命中、最近聚焦）。
 */
export function findSecondaryWindowForSession(
  target: SecondaryWindowSessionMatchTarget,
): SecondaryWindowSessionMatch | null {
  const sessionId = target.sessionId.trim();
  if (!sessionId) return null;
  const targetDeviceId = normalizeDeviceId(target.deviceId);
  const targetCompanionBotId = target.companion?.botId?.trim() || null;
  const targetCompanionDeviceId = normalizeCompanionDeviceId(target.companion?.deviceId);

  const candidates: RankedWindowCandidate<SecondaryWindowSessionMatch>[] = [];

  for (const win of secondaryWindows) {
    if (win.isDestroyed()) continue;
    const meta = secondaryWindowMeta.get(win);
    const currentUrl = readWindowUrl(win);
    const currentHashPath = extractNormalizedHashPath(currentUrl);
    const { target: urlTarget, isBooting } = parseSecondaryWindowUrlTarget(currentUrl, meta);
    const hasFreshReportedSessions = Boolean(
      meta &&
        meta.reportedSessionIds.size > 0 &&
        meta.reportedAtHashPath !== null &&
        meta.reportedAtHashPath === currentHashPath,
    );

    let matchKind: SecondaryWindowSessionMatch['matchKind'] | null = null;
    if (urlTarget?.kind === 'session') {
      const sameSession =
        urlTarget.sessionId === sessionId || urlTarget.workerSessionId === sessionId;
      if (sameSession && isDeviceCompatible(urlTarget.deviceId, targetDeviceId)) {
        if (isBooting) {
          matchKind = 'booting';
        } else if (
          urlTarget.isFilesView &&
          !(hasFreshReportedSessions && meta?.reportedSessionIds.has(sessionId))
        ) {
          // 文件浏览页聊天栏折叠时 WorkdirBrowseRoute 会上报 null；仅聚焦会让对话继续隐藏，
          // 需要发送会话导航切回对话视图。聊天栏展开时 reportedSessionIds 含该会话，保持 direct。
          matchKind = 'navigate';
        } else {
          matchKind = 'direct';
        }
      }
    } else if (urlTarget?.kind === 'companion') {
      const companionDevice = normalizeDeviceId(urlTarget.deviceId) ?? 'local';
      const matchesBySession =
        urlTarget.sessionId === sessionId && isDeviceCompatible(companionDevice, targetDeviceId);
      // 仅在 URL 未显式锁定另一条会话（如 /bots/:botId 或 /bots/remote/:device/:botId）时，
      // 才按伙伴身份命中，避免把停在旧会话/历史会话的副窗误判为当前主会话。
      const matchesByCompanion =
        urlTarget.sessionId === null &&
        targetCompanionBotId !== null &&
        urlTarget.botId === targetCompanionBotId &&
        normalizeCompanionDeviceId(urlTarget.deviceId) === targetCompanionDeviceId;
      if (matchesBySession || matchesByCompanion) {
        if (isBooting) {
          matchKind = 'booting';
        } else if (urlTarget.isSettingsView) {
          // 副窗停在伙伴设置页 (?settings=1) 时，唤起并强制切回对话视图。
          matchKind = 'navigate';
        } else {
          matchKind = 'direct';
        }
      }
    }

    const canHostAuxiliarySessions =
      !isBooting &&
      urlTarget !== null &&
      !(urlTarget.kind === 'session' && urlTarget.isFilesView) &&
      !(urlTarget.kind === 'companion' && urlTarget.isSettingsView);

    if (
      !matchKind &&
      canHostAuxiliarySessions &&
      hasFreshReportedSessions &&
      meta?.reportedSessionIds.has(sessionId)
    ) {
      const reportedCompatibleWithUrl =
        urlTarget.kind === 'session'
          ? meta.reportedMultiSession && meta.reportedSessionIds.has(urlTarget.sessionId)
          : urlTarget.kind === 'group'
            ? meta.reportedMultiSession
            : meta.reportedMultiSession || urlTarget.sessionId === null;
      const auxiliaryDevice =
        urlTarget.kind === 'session'
          ? urlTarget.deviceId
          : urlTarget.kind === 'companion' && !meta.reportedMultiSession
            ? (normalizeDeviceId(urlTarget.deviceId) ?? 'local')
            : null;
      if (reportedCompatibleWithUrl && isDeviceCompatible(auxiliaryDevice, targetDeviceId)) {
        matchKind =
          urlTarget.kind === 'companion' && !meta.reportedMultiSession ? 'direct' : 'navigate';
      }
    }

    if (!matchKind) continue;
    candidates.push({
      result: { window: win, matchKind },
      focused: safeIsFocused(win),
      minimized: safeIsMinimized(win),
      directMatch: matchKind !== 'navigate',
      lastFocusedOrder: meta?.lastFocusedOrder ?? 0,
    });
  }

  return pickBestCandidate(candidates);
}

/**
 * 查找当前已经承载目标群聊或私聊的副窗口。
 */
export function findSecondaryWindowForGroupChat(
  target: SecondaryWindowGroupMatchTarget,
): SecondaryWindowGroupMatch | null {
  const groupId = target.groupId.trim();
  if (!groupId) return null;
  const expectedKind = target.conversationKind ?? 'group';

  const candidates: RankedWindowCandidate<SecondaryWindowGroupMatch>[] = [];

  for (const win of secondaryWindows) {
    if (win.isDestroyed()) continue;
    const meta = secondaryWindowMeta.get(win);
    const { target: urlTarget, isBooting } = parseSecondaryWindowUrlTarget(readWindowUrl(win), meta);
    if (
      urlTarget?.kind !== 'group' ||
      urlTarget.groupId !== groupId ||
      urlTarget.conversationKind !== expectedKind
    ) {
      continue;
    }
    candidates.push({
      result: { window: win, isBooting },
      focused: safeIsFocused(win),
      minimized: safeIsMinimized(win),
      directMatch: true,
      lastFocusedOrder: meta?.lastFocusedOrder ?? 0,
    });
  }

  return pickBestCandidate(candidates);
}
