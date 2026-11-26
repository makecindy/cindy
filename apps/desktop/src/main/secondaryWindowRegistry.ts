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
  reportedSessionIds: ReadonlySet<string>;
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
   * - `navigate`: 副窗承载该会话但对话当前未在前台展示（后台分屏栏或文件页聊天栏已折叠），
   *   聚焦后需要向该副窗发送 `deep-link:navigate` 以切到对话视图。
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
      const explicitDevice = normalizeDeviceId(params.get('device'));
      const deviceId =
        explicitDevice ??
        (bootFallback?.bootSession === sessionId ? bootFallback.bootDeviceId : null);
      const workerSessionId = params.get('worker')?.trim() || null;
      return { kind: 'session', sessionId, workerSessionId, deviceId };
    }
    if (restSegments.length === 2 && (restSegments[0] === 'files' || restSegments[0] === 'orca')) {
      const sessionId = safeDecodeSegment(restSegments[1] ?? '').trim();
      if (!sessionId) return null;
      const explicitDevice = normalizeDeviceId(params.get('device'));
      const deviceId =
        explicitDevice ??
        (bootFallback?.bootSession === sessionId ? bootFallback.bootDeviceId : null);
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
      return { kind: 'companion', deviceId, botId, sessionId: sessionId || null };
    }
    if (
      restSegments.length === 1 ||
      (restSegments.length === 3 && (restSegments[1] === 'session' || restSegments[1] === 'history'))
    ) {
      const botId = safeDecodeSegment(restSegments[0] ?? '').trim();
      if (!botId || NON_BOT_SEGMENTS.has(botId)) return null;
      const sessionId = restSegments.length === 3 ? safeDecodeSegment(restSegments[2] ?? '').trim() : '';
      return { kind: 'companion', deviceId: null, botId, sessionId: sessionId || null };
    }
  }

  return null;
}

function parseBootTarget(boot: SecondaryWindowBootInfo): SecondaryWindowUrlTarget | null {
  const trimmed = boot.bootSession.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('/bots/')) {
    const queryIdx = trimmed.indexOf('?');
    const routePath = queryIdx >= 0 ? trimmed.slice(0, queryIdx) : trimmed;
    const routeSearch = queryIdx >= 0 ? trimmed.slice(queryIdx + 1) : '';
    return parseRouteTarget(routePath, routeSearch);
  }
  return {
    kind: 'session',
    sessionId: trimmed,
    workerSessionId: null,
    deviceId: normalizeDeviceId(boot.bootDeviceId),
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
    reportedSessionIds: new Set(),
    pendingBootGroupDelivery: null,
  });
  win.on?.('focus', () => {
    const meta = secondaryWindowMeta.get(win);
    if (meta) meta.lastFocusedOrder = ++windowOrderSequence;
  });
  win.webContents?.on?.('did-navigate', () => {
    const meta = secondaryWindowMeta.get(win);
    if (meta) meta.reportedSessionIds = new Set();
  });
  // SecondaryWindowBootGate 位于 MainLayout 之内；一旦页面内导航离开 /cc-agent/boot
  // 落到目标群聊路由，MainLayout 的 onDeepLinkNavigate 必然已挂载，可安全补发消息定位。
  win.webContents?.on?.('did-navigate-in-page', () => {
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
  const normalized = new Set<string>();
  if (typeof sessionIds === 'string') {
    const trimmed = sessionIds.trim();
    if (trimmed) normalized.add(trimmed);
  } else if (Array.isArray(sessionIds)) {
    for (const value of sessionIds) {
      if (typeof value !== 'string') continue;
      const trimmed = value.trim();
      if (trimmed) normalized.add(trimmed);
    }
  }
  meta.reportedSessionIds = normalized;
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
  const targetCompanionDeviceId = normalizeDeviceId(target.companion?.deviceId);

  const candidates: RankedWindowCandidate<SecondaryWindowSessionMatch>[] = [];

  for (const win of secondaryWindows) {
    if (win.isDestroyed()) continue;
    const meta = secondaryWindowMeta.get(win);
    const { target: urlTarget, isBooting } = parseSecondaryWindowUrlTarget(readWindowUrl(win), meta);

    let matchKind: SecondaryWindowSessionMatch['matchKind'] | null = null;
    if (urlTarget?.kind === 'session') {
      const sameSession =
        urlTarget.sessionId === sessionId || urlTarget.workerSessionId === sessionId;
      if (sameSession && isDeviceCompatible(urlTarget.deviceId, targetDeviceId)) {
        if (isBooting) {
          matchKind = 'booting';
        } else if (urlTarget.isFilesView && !meta?.reportedSessionIds.has(sessionId)) {
          // 文件浏览页聊天栏折叠时 WorkdirBrowseRoute 会上报 null；仅聚焦会让对话继续隐藏，
          // 需要发送会话导航切回对话视图。聊天栏展开时 reportedSessionIds 含该会话，保持 direct。
          matchKind = 'navigate';
        } else {
          matchKind = 'direct';
        }
      }
    } else if (urlTarget?.kind === 'companion') {
      const matchesBySession =
        urlTarget.sessionId === sessionId && isDeviceCompatible(urlTarget.deviceId, targetDeviceId);
      const matchesByCompanion =
        targetCompanionBotId !== null &&
        urlTarget.botId === targetCompanionBotId &&
        normalizeDeviceId(urlTarget.deviceId) === targetCompanionDeviceId;
      if (matchesBySession || matchesByCompanion) {
        matchKind = isBooting ? 'booting' : 'direct';
      }
    }

    if (!matchKind && meta?.reportedSessionIds.has(sessionId)) {
      const urlDevice = urlTarget?.kind === 'session' ? urlTarget.deviceId : null;
      if (isDeviceCompatible(urlDevice, targetDeviceId)) {
        matchKind = 'navigate';
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
