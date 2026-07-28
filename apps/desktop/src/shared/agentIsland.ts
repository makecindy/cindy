import { BRAND_NAME } from '@cindy/maker-shared/branding';

export type AgentIslandSessionPhase = 'running' | 'needs-interaction' | 'completed' | 'error';

export type AgentIslandInteractionKind =
  | 'permission'
  | 'ask_user_question'
  | 'plan_review'
  | 'plugin_setup';
export type AgentIslandActivityLineKind = 'user' | 'assistant' | 'status' | 'tool';

/**
 * Compact terminal-style preview line shown inside the expanded island card.
 */
export interface AgentIslandActivityLine {
  id: string;
  kind: AgentIslandActivityLineKind;
  text: string;
}

/**
 * Renderer-facing session snapshot for the macOS Agent Island overlay.
 */
export interface AgentIslandSessionSnapshot {
  sessionId: string;
  title: string;
  projectName: string | null;
  detail: string;
  compactDetail: string;
  messagePreview: AgentIslandActivityLine | null;
  phase: AgentIslandSessionPhase;
  agentKind: 'claude-code' | 'codex' | string;
  interactionKind?: AgentIslandInteractionKind;
  permissionAction: AgentIslandPermissionActionSnapshot | null;
  attention: boolean;
  activityLines: AgentIslandActivityLine[];
  startedAt: number;
  lastActivityAt: number;
}

export interface AgentIslandPermissionActionSnapshot {
  requestId: string;
  canAllowForSession: boolean;
}

/**
 * 轻量 per-session 活动快照——桥接给 renderer 侧栏卡片(置顶卡片/列表)用,
 * 让卡片在任务执行中显示与灵动岛同源的逐步活动 + 等待交互态。只取卡片要的字段
 * (不含 activityLines 多行,控体积)。
 */
export interface AgentIslandSessionActivity {
  sessionId: string;
  phase: AgentIslandSessionPhase;
  compactDetail: string;
  interactionKind?: AgentIslandInteractionKind;
  attention: boolean;
}

export type AgentIslandDisplayMode = 'compact' | 'expanded';
export type AgentIslandNotchStatus = 'closed' | 'peek' | 'expanded';
export type AgentIslandDisplayPolicy = 'closed' | 'peek' | 'blocking' | 'transient' | 'manualExpanded';
export type AgentIslandDisplaySurface = 'collapsed' | 'sessionList' | 'interactionCard' | 'completionCard';
export type AgentIslandLayoutMode = 'compact' | 'normal';
export type AgentIslandPillStatus = 'idle' | AgentIslandSessionPhase;
export type AgentIslandMascotSkin =
  | 'cindy'
  | 'blackcat'
  | 'pululu'
  | 'tarara'
  | 'boli'
  | 'whitesnow'
  | 'annie'
  | 'chaku'
  | 'muffin'
  | 'erika';
export type AgentIslandSoundEvent = 'start' | 'attention' | 'complete' | 'error' | 'select';
export type AgentIslandDisplayTarget =
  | { mode: 'all' }
  | {
      mode: 'display';
      displayId: number;
      /** Best-effort identity used to remap Electron display ids after reboot. */
      displayName?: string;
      displayIndex?: number;
      displayInternal?: boolean;
      displayBounds?: {
        x: number;
        y: number;
        width: number;
        height: number;
      };
    };
export type AgentIslandSoundId =
  | 'none'
  | 'startup-chime'
  | 'ring-chime'
  | 'item-found'
  | 'gem-collect'
  | 'item-fanfare'
  | 'victory-fanfare'
  | 'error-buzz'
  | 'secret-chime';

export type AgentIslandSoundChoice =
  | { type: 'builtin'; id: AgentIslandSoundId }
  | { type: 'custom'; path: string; name: string };

export interface AgentIslandSoundSettings {
  enabled: boolean;
  sounds: Record<AgentIslandSoundEvent, AgentIslandSoundChoice>;
}

export interface AgentIslandDisplayOption {
  id: number;
  index: number;
  name: string;
  isPrimary: boolean;
  internal: boolean;
  bounds: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
}

/** 顺序即设置页「图标皮肤」列表的展示顺序。 */
export const AGENT_ISLAND_MASCOT_SKINS: readonly AgentIslandMascotSkin[] = [
  'cindy',
  'blackcat',
  'pululu',
  'tarara',
  'boli',
  'whitesnow',
  'annie',
  'chaku',
  'muffin',
  'erika',
] as const;

export const AGENT_ISLAND_SOUND_EVENTS: readonly AgentIslandSoundEvent[] = [
  'start',
  'attention',
  'complete',
  'error',
  'select',
] as const;

export const AGENT_ISLAND_SOUND_OPTIONS: readonly AgentIslandSoundId[] = [
  'none',
  'startup-chime',
  'ring-chime',
  'item-found',
  'gem-collect',
  'item-fanfare',
  'victory-fanfare',
  'error-buzz',
  'secret-chime',
] as const;

/**
 * 2026-07 内置音效改用中性命名后,旧持久化设置(main settings 与 renderer
 * localStorage)里仍可能存着老 ID;normalize 时映射到新 ID,避免用户已选音效被
 * 静默重置回默认值。
 */
const LEGACY_AGENT_ISLAND_SOUND_ID_ALIASES: Readonly<Record<string, AgentIslandSoundId>> = {
  'gameboy-startup': 'startup-chime',
  'sonic-ring': 'ring-chime',
  'pokemon-item-found': 'item-found',
  'zelda-rupee': 'gem-collect',
  'zelda-item-get': 'item-fanfare',
  'ff-victory': 'victory-fanfare',
  'mario-incorrect': 'error-buzz',
  'zelda-secret': 'secret-chime',
};

function resolveAgentIslandSoundId(value: unknown): AgentIslandSoundId | null {
  if (typeof value !== 'string') return null;
  if (isAgentIslandSoundId(value)) return value;
  return LEGACY_AGENT_ISLAND_SOUND_ID_ALIASES[value] ?? null;
}

export const DEFAULT_AGENT_ISLAND_SOUND_SETTINGS: AgentIslandSoundSettings = {
  enabled: true,
  sounds: {
    start: { type: 'builtin', id: 'startup-chime' },
    attention: { type: 'builtin', id: 'secret-chime' },
    complete: { type: 'builtin', id: 'gem-collect' },
    error: { type: 'builtin', id: 'error-buzz' },
    select: { type: 'builtin', id: 'none' },
  },
};

export const DEFAULT_AGENT_ISLAND_MASCOT_SKIN: AgentIslandMascotSkin = 'pululu';
export const DEFAULT_AGENT_ISLAND_DISPLAY_TARGET: AgentIslandDisplayTarget = { mode: 'all' };
export const AGENT_ISLAND_MIN_DARWIN_MAJOR = 23; // macOS 14 Sonoma.

export function isAgentIslandSupportedPlatform(
  platform: string | undefined,
  osRelease: string | null | undefined,
): boolean {
  if (platform !== 'darwin') return false;
  const darwinMajor = parseDarwinMajor(osRelease);
  return darwinMajor !== null && darwinMajor >= AGENT_ISLAND_MIN_DARWIN_MAJOR;
}

function parseDarwinMajor(osRelease: string | null | undefined): number | null {
  if (!osRelease) return null;
  const major = Number.parseInt(osRelease.split('.')[0] ?? '', 10);
  return Number.isFinite(major) ? major : null;
}

export function cloneAgentIslandSoundSettings(settings: AgentIslandSoundSettings): AgentIslandSoundSettings {
  return {
    enabled: settings.enabled,
    sounds: Object.fromEntries(
      AGENT_ISLAND_SOUND_EVENTS.map((event) => [
        event,
        { ...(settings.sounds[event] ?? DEFAULT_AGENT_ISLAND_SOUND_SETTINGS.sounds[event]) },
      ]),
    ) as Record<AgentIslandSoundEvent, AgentIslandSoundChoice>,
  };
}

export function isAgentIslandMascotSkin(value: unknown): value is AgentIslandMascotSkin {
  return typeof value === 'string' && (AGENT_ISLAND_MASCOT_SKINS as readonly string[]).includes(value);
}

export function isAgentIslandSoundId(value: unknown): value is AgentIslandSoundId {
  return typeof value === 'string' && (AGENT_ISLAND_SOUND_OPTIONS as readonly string[]).includes(value);
}

export function isAgentIslandSoundChoice(value: unknown): value is AgentIslandSoundChoice {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  if (record.type === 'builtin') {
    return isAgentIslandSoundId(record.id);
  }
  return record.type === 'custom'
    && typeof record.path === 'string'
    && record.path.trim().length > 0;
}

export function normalizeAgentIslandSoundChoice(
  raw: unknown,
  fallback: AgentIslandSoundChoice,
): AgentIslandSoundChoice {
  const bareId = resolveAgentIslandSoundId(raw);
  if (bareId !== null) {
    return { type: 'builtin', id: bareId };
  }
  if (typeof raw !== 'object' || raw === null) return { ...fallback };
  const record = raw as Record<string, unknown>;
  if (record.type === 'builtin') {
    const id = resolveAgentIslandSoundId(record.id);
    if (id !== null) return { type: 'builtin', id };
  }
  if (record.type === 'custom' && typeof record.path === 'string') {
    const path = record.path.trim();
    if (!path) return { ...fallback };
    const name = typeof record.name === 'string' && record.name.trim()
      ? record.name.trim()
      : fileNameFromPath(path);
    return { type: 'custom', path, name };
  }
  return { ...fallback };
}

export function isSilentAgentIslandSoundChoice(choice: AgentIslandSoundChoice): boolean {
  return choice.type === 'builtin' && choice.id === 'none';
}

export function isAgentIslandSoundEvent(value: unknown): value is AgentIslandSoundEvent {
  return typeof value === 'string' && (AGENT_ISLAND_SOUND_EVENTS as readonly string[]).includes(value);
}

export function cloneAgentIslandDisplayTarget(target: AgentIslandDisplayTarget): AgentIslandDisplayTarget {
  return target.mode === 'display'
    ? {
        mode: 'display',
        displayId: target.displayId,
        ...(typeof target.displayName === 'string' ? { displayName: target.displayName } : {}),
        ...(typeof target.displayIndex === 'number' ? { displayIndex: target.displayIndex } : {}),
        ...(typeof target.displayInternal === 'boolean' ? { displayInternal: target.displayInternal } : {}),
        ...(target.displayBounds ? { displayBounds: { ...target.displayBounds } } : {}),
      }
    : { mode: 'all' };
}

export function normalizeAgentIslandDisplayTarget(raw: unknown): AgentIslandDisplayTarget {
  if (typeof raw !== 'object' || raw === null) return cloneAgentIslandDisplayTarget(DEFAULT_AGENT_ISLAND_DISPLAY_TARGET);
  const record = raw as Record<string, unknown>;
  if (record.mode === 'display' && typeof record.displayId === 'number' && Number.isFinite(record.displayId)) {
    const rawBounds = record.displayBounds;
    const displayBounds = typeof rawBounds === 'object' && rawBounds !== null
      ? rawBounds as Record<string, unknown>
      : null;
    const hasBounds = displayBounds
      && typeof displayBounds.x === 'number'
      && typeof displayBounds.y === 'number'
      && typeof displayBounds.width === 'number'
      && typeof displayBounds.height === 'number';
    return cloneAgentIslandDisplayTarget({
      mode: 'display',
      displayId: record.displayId,
      ...(typeof record.displayName === 'string' && record.displayName.trim()
        ? { displayName: record.displayName.trim() }
        : {}),
      ...(typeof record.displayIndex === 'number' && Number.isFinite(record.displayIndex)
        ? { displayIndex: record.displayIndex }
        : {}),
      ...(typeof record.displayInternal === 'boolean'
        ? { displayInternal: record.displayInternal }
        : {}),
      ...(hasBounds
        ? {
            displayBounds: {
              x: displayBounds.x as number,
              y: displayBounds.y as number,
              width: displayBounds.width as number,
              height: displayBounds.height as number,
            },
          }
        : {}),
    });
  }
  if (record.mode === 'all') {
    return { mode: 'all' };
  }
  return cloneAgentIslandDisplayTarget(DEFAULT_AGENT_ISLAND_DISPLAY_TARGET);
}

/**
 * Normalizes persisted or IPC-provided Agent Island sound settings. Unknown
 * event/sound values are ignored so older clients can safely read newer data.
 */
export function normalizeAgentIslandSoundSettings(raw: unknown): AgentIslandSoundSettings {
  const fallback = cloneAgentIslandSoundSettings(DEFAULT_AGENT_ISLAND_SOUND_SETTINGS);
  if (typeof raw !== 'object' || raw === null) return fallback;
  const record = raw as Record<string, unknown>;
  const rawSounds = typeof record.sounds === 'object' && record.sounds !== null
    ? record.sounds as Record<string, unknown>
    : {};
  const sounds = { ...fallback.sounds };
  for (const event of AGENT_ISLAND_SOUND_EVENTS) {
    sounds[event] = normalizeAgentIslandSoundChoice(rawSounds[event], fallback.sounds[event]);
  }
  return {
    enabled: typeof record.enabled === 'boolean' ? record.enabled : fallback.enabled,
    sounds,
  };
}

function fileNameFromPath(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  const parts = normalized.split('/').filter(Boolean);
  return parts.at(-1) ?? filePath;
}

/**
 * Vibe-style priority summary for the closed/peek pill. The session list can be
 * long; this snapshot is the single product answer for what the notch should
 * represent while compact.
 */
export interface AgentIslandPillSnapshot {
  priorityId: string | null;
  priorityStatus: AgentIslandPillStatus;
  priorityMicroTitle: string;
  priorityCompactTitle: string;
  sessionCount: number;
  activeSessionCount: number;
  pendingInteractionCount: number;
  unreadCompletedCount: number;
  deferredRevealCount: number;
  attentionCount: number;
}

export function createEmptyAgentIslandPillSnapshot(): AgentIslandPillSnapshot {
  return {
    priorityId: null,
    priorityStatus: 'idle',
    priorityMicroTitle: '',
    priorityCompactTitle: '',
    sessionCount: 0,
    activeSessionCount: 0,
    pendingInteractionCount: 0,
    unreadCompletedCount: 0,
    deferredRevealCount: 0,
    attentionCount: 0,
  };
}

/**
 * User-visible strings rendered by the native macOS Agent Island helper.
 *
 * Main owns localization and sends concrete strings with every display state
 * so the Swift helper can stay renderer-agnostic.
 */
export interface AgentIslandStrings {
  appName: string;
  newConversationTitle: string;
  newConversationHint: string;
  muteSound: string;
  enableSound: string;
  settings: string;
  newMessage: string;
  review: string;
  needsInput: string;
  completed: string;
  error: string;
  input: string;
  done: string;
  running: string;
  updatingTasks: string;
  /** 等待交互摘要(按 interactionKind 出人话,替代过期 tool 状态行;文案与侧栏卡片 awaiting* 对齐)。 */
  awaitingPermission: string;
  awaitingQuestion: string;
  awaitingPlan: string;
  permissionPromptTitle: string;
  allowOnce: string;
  alwaysAllowForSession: string;
  deny: string;
}

export const DEFAULT_AGENT_ISLAND_STRINGS: AgentIslandStrings = {
  appName: BRAND_NAME,
  newConversationTitle: 'New Maker',
  newConversationHint: 'Start a new conversation',
  muteSound: 'Mute Agent Island',
  enableSound: 'Enable Agent Island sound',
  settings: 'Agent Island settings',
  newMessage: 'New message',
  review: 'Review',
  needsInput: 'Needs input',
  completed: 'Completed',
  error: 'Error',
  input: 'Input',
  done: 'Done',
  running: 'Running',
  updatingTasks: 'Updating tasks',
  awaitingPermission: 'Awaiting permission',
  awaitingQuestion: 'Awaiting your reply',
  awaitingPlan: 'Awaiting plan review',
  permissionPromptTitle: 'Confirm permission',
  allowOnce: 'Allow once',
  alwaysAllowForSession: 'Always allow',
  deny: 'Deny',
};

export const AGENT_ISLAND_MAX_EXPANDED_WIDTH = 640;
export const AGENT_ISLAND_MAX_RESIZABLE_WIDTH = 920;
export const AGENT_ISLAND_MIN_EXPANDED_WIDTH = 360;
export const AGENT_ISLAND_IDLE_EXPANDED_WIDTH = 340;
export const AGENT_ISLAND_COMPACT_IDLE_WIDTH = 210;
export const AGENT_ISLAND_COMPACT_MIN_WIDTH = 80;
export const AGENT_ISLAND_COMPACT_ACTIVE_WIDTH = 298;
export const AGENT_ISLAND_SIMULATED_NOTCH_WIDTH_RATIO = 0.14;
export const AGENT_ISLAND_SIMULATED_NOTCH_MIN_WIDTH = 160;
export const AGENT_ISLAND_SIMULATED_NOTCH_MAX_WIDTH = 240;
export const AGENT_ISLAND_COMPACT_SIMULATED_ACTIVE_EXTRA_WIDTH = 88;
export const AGENT_ISLAND_COMPACT_HARDWARE_IDLE_EXTRA_WIDTH = 64;
export const AGENT_ISLAND_COMPACT_HARDWARE_ACTIVE_EXTRA_WIDTH = 64;
export const AGENT_ISLAND_COMPACT_HARDWARE_HIDDEN_PULL_DISTANCE = 48;
// Compact count-badge metrics, kept in sync with `PillBadge` in
// `native/agent-island/macos-agent-island-helper.swift`. These describe the *nominal*
// width used to reserve carrier space — the native helper computes the same nominal
// value (it does not measure the font for layout), while the badge itself is still
// drawn by SwiftUI with the real font. The nominal value is an upper bound of what
// gets drawn, so reserved space is never short.
export const AGENT_ISLAND_COMPACT_BADGE_MIN_WIDTH = 22;
export const AGENT_ISLAND_COMPACT_BADGE_ACTIVE_TOTAL_MIN_WIDTH = 30;
export const AGENT_ISLAND_COMPACT_BADGE_CONTENT_INSET = 2;
export const AGENT_ISLAND_COMPACT_BADGE_TEXT_SPACING = 1;
/** Generous upper bound for one monospaced 10pt digit (real advance is ~6pt). */
export const AGENT_ISLAND_COMPACT_BADGE_CHAR_WIDTH_BOUND = 7;
/**
 * Per-segment rounding slack, mirroring `PillBadge.segmentRoundingSlack` in the Swift
 * helper (`ceil(measured + 1)` per `Text`). SwiftUI lays out and rounds every `Text`
 * run separately, so the slack is added once per segment — not once per badge. Dropping
 * it would make this estimate fall below the native width and let the badge get clipped
 * again; `agentIslandCompactBadgeWidth.test.ts` guards that.
 */
export const AGENT_ISLAND_COMPACT_BADGE_SEGMENT_ROUNDING_SLACK = 1;
/** Upper bound of the native `hardwareNotchSideInset` beside the badge. */
export const AGENT_ISLAND_COMPACT_HARDWARE_BADGE_RESERVED_INSET = 9;
export const AGENT_ISLAND_MAX_EXPANDED_HEIGHT = 560;
export const AGENT_ISLAND_SCREEN_EDGE_GUTTER = 112;
export const AGENT_ISLAND_CARRIER_COMPACT_INSET = 20;
export const AGENT_ISLAND_CARRIER_EXPANDED_INSET = 80;
export const AGENT_ISLAND_CLOSED_HEIGHT = 34;
export const AGENT_ISLAND_IDLE_EXPANDED_HEIGHT = 154;
export const AGENT_ISLAND_EXPANDED_MIN_HEIGHT = 176;
export const AGENT_ISLAND_EXPANDED_MEASURED_MIN_HEIGHT = 118;
export const AGENT_ISLAND_EXPANDED_FALLBACK_HEIGHT = 190;
export const AGENT_ISLAND_EXPANDED_LIST_MAX_VISIBLE_ROWS = 5;
export const AGENT_ISLAND_EXPANDED_LIST_ROW_HEIGHT = 90;
export const AGENT_ISLAND_EXPANDED_LIST_VERTICAL_CHROME = 60;
export const AGENT_ISLAND_EXPANDED_MEASURED_HEIGHT_OFFSET = 8;
export const AGENT_ISLAND_EXPANDED_HARDWARE_NOTCH_SIDE_WIDTH = 96;
export const AGENT_ISLAND_EXPANDED_HARDWARE_NOTCH_HORIZONTAL_PADDING = 36;

export interface AgentIslandScreenLayoutMetrics {
  hasNotch: boolean;
  notchWidth: number;
}

export function computeAgentIslandSimulatedNotchWidth(displayWidth: number): number {
  return Math.min(
    AGENT_ISLAND_SIMULATED_NOTCH_MAX_WIDTH,
    Math.max(AGENT_ISLAND_SIMULATED_NOTCH_MIN_WIDTH, displayWidth * AGENT_ISLAND_SIMULATED_NOTCH_WIDTH_RATIO),
  );
}

/**
 * Upper-bound width of the compact count badge the native helper draws, mirroring
 * `PillBadge.intrinsicWidth` in `macos-agent-island-helper.swift`.
 *
 * The carrier window sizes itself from this, so the native side can only ever clamp
 * the island *down* to its own exact measurement — never get clipped for lack of room.
 * That is why the per-character advance below is deliberately generous: the real
 * monospaced 10pt advance is ~6pt, and overestimating only leaves invisible slack
 * inside the carrier's transparent inset.
 */
export function getAgentIslandCompactBadgeWidth(input: {
  activeSessionCount: number;
  sessionCount: number;
}): number {
  const isActiveTotal = input.activeSessionCount > 0 && input.sessionCount > 1;
  const segments = isActiveTotal
    ? [`${input.activeSessionCount}`, '/', `${input.sessionCount}`]
    : [`${Math.max(1, input.sessionCount)}`];
  const segmentsWidth = segments.reduce(
    (total, segment) => total
      + segment.length * AGENT_ISLAND_COMPACT_BADGE_CHAR_WIDTH_BOUND
      + AGENT_ISLAND_COMPACT_BADGE_SEGMENT_ROUNDING_SLACK,
    0,
  );
  const spacing = AGENT_ISLAND_COMPACT_BADGE_TEXT_SPACING * Math.max(0, segments.length - 1);
  const minWidth = isActiveTotal
    ? AGENT_ISLAND_COMPACT_BADGE_ACTIVE_TOTAL_MIN_WIDTH
    : AGENT_ISLAND_COMPACT_BADGE_MIN_WIDTH;
  return Math.max(
    minWidth,
    segmentsWidth + spacing + AGENT_ISLAND_COMPACT_BADGE_CONTENT_INSET * 2,
  );
}

export function getAgentIslandDefaultContentWidth(input: {
  expanded: boolean;
  hasSession: boolean;
  displayWidth?: number;
  screenMetrics?: AgentIslandScreenLayoutMetrics | null;
  pillSnapshot?: Pick<AgentIslandPillSnapshot, 'activeSessionCount' | 'sessionCount'> | null;
}): number {
  if (input.expanded) {
    return input.hasSession ? AGENT_ISLAND_MAX_EXPANDED_WIDTH : AGENT_ISLAND_IDLE_EXPANDED_WIDTH;
  }
  const notchWidth = input.screenMetrics
    ? input.screenMetrics.notchWidth
    : (typeof input.displayWidth === 'number'
      ? computeAgentIslandSimulatedNotchWidth(input.displayWidth)
      : AGENT_ISLAND_COMPACT_IDLE_WIDTH);
  if (input.screenMetrics?.hasNotch) {
    const baseExtra = input.hasSession
      ? AGENT_ISLAND_COMPACT_HARDWARE_ACTIVE_EXTRA_WIDTH
      : AGENT_ISLAND_COMPACT_HARDWARE_IDLE_EXTRA_WIDTH;
    // Both notch sides are symmetric, so a wide badge costs twice its side width.
    const badgeExtra = input.hasSession && input.pillSnapshot
      ? (getAgentIslandCompactBadgeWidth(input.pillSnapshot)
        + AGENT_ISLAND_COMPACT_HARDWARE_BADGE_RESERVED_INSET) * 2
      : 0;
    return Math.max(
      AGENT_ISLAND_COMPACT_IDLE_WIDTH,
      notchWidth + Math.max(baseExtra, badgeExtra),
    );
  }
  if (typeof input.displayWidth === 'number' || input.screenMetrics) {
    return Math.max(
      AGENT_ISLAND_COMPACT_IDLE_WIDTH,
      notchWidth + (input.hasSession ? AGENT_ISLAND_COMPACT_SIMULATED_ACTIVE_EXTRA_WIDTH : 0),
    );
  }
  return input.hasSession ? AGENT_ISLAND_COMPACT_ACTIVE_WIDTH : AGENT_ISLAND_COMPACT_IDLE_WIDTH;
}

export function getAgentIslandMinimumContentWidth(input: {
  expanded: boolean;
  screenMetrics?: AgentIslandScreenLayoutMetrics | null;
}): number {
  if (input.expanded) {
    if (input.screenMetrics?.hasNotch) {
      return Math.max(
        AGENT_ISLAND_MIN_EXPANDED_WIDTH,
        input.screenMetrics.notchWidth
          + AGENT_ISLAND_EXPANDED_HARDWARE_NOTCH_SIDE_WIDTH * 2
          + AGENT_ISLAND_EXPANDED_HARDWARE_NOTCH_HORIZONTAL_PADDING,
      );
    }
    return AGENT_ISLAND_MIN_EXPANDED_WIDTH;
  }
  if (input.screenMetrics?.hasNotch) {
    return Math.max(1, input.screenMetrics.notchWidth);
  }
  return AGENT_ISLAND_COMPACT_MIN_WIDTH;
}

export function snapAgentIslandCompactHardwareContentWidth(input: {
  desiredWidth: number;
  clampedWidth: number;
  maxWidth: number;
  hasSession: boolean;
  screenMetrics?: AgentIslandScreenLayoutMetrics | null;
  pillSnapshot?: Pick<AgentIslandPillSnapshot, 'activeSessionCount' | 'sessionCount'> | null;
}): number {
  if (!input.screenMetrics?.hasNotch) {
    return input.clampedWidth;
  }
  const hiddenWidth = Math.min(input.maxWidth, Math.max(1, input.screenMetrics.notchWidth));
  // hidden/basic 的分类必须锚在与徽标无关的 basic 宽度上。否则计数一变多、basic 宽度被撑大后,
  // 用户此前停在 basic 的持久化宽度会突然落到 hidden 阈值以下,整个 compact 岛被收起。
  const baseBasicWidth = Math.min(
    input.maxWidth,
    Math.max(hiddenWidth, getAgentIslandDefaultContentWidth({
      expanded: false,
      hasSession: input.hasSession,
      screenMetrics: input.screenMetrics,
    })),
  );
  const basicWidth = Math.min(
    input.maxWidth,
    Math.max(hiddenWidth, getAgentIslandDefaultContentWidth({
      expanded: false,
      hasSession: input.hasSession,
      screenMetrics: input.screenMetrics,
      pillSnapshot: input.pillSnapshot,
    })),
  );
  const gap = baseBasicWidth - hiddenWidth;
  if (gap <= 8) {
    return hiddenWidth;
  }
  const hiddenThreshold = baseBasicWidth - Math.min(
    AGENT_ISLAND_COMPACT_HARDWARE_HIDDEN_PULL_DISTANCE,
    Math.max(24, gap * 0.5),
  );
  if (input.desiredWidth <= hiddenThreshold) {
    return hiddenWidth;
  }
  // 只有落在与徽标无关的 basic 吸附位及以下的宽度才升级到当前(可能更宽的)basic。
  // 用 basicWidth 判定会把介于两个吸附点之间的自由宽度(如旧 basic 264 与 11/12 的 306
  // 之间的 280)一并吞掉,再被 native 的持久化归一化改写成 264,永久覆盖用户偏好。
  if (input.desiredWidth <= baseBasicWidth) {
    return basicWidth;
  }
  return input.clampedWidth;
}

/**
 * Full display payload pushed from main to the native Agent Island helper.
 */
export interface AgentIslandDisplayState {
  visible: boolean;
  mode: AgentIslandDisplayMode;
  notchStatus: AgentIslandNotchStatus;
  displayPolicy: AgentIslandDisplayPolicy;
  displaySurface: AgentIslandDisplaySurface;
  layoutMode: AgentIslandLayoutMode;
  appFocused: boolean;
  smartSuppressed: boolean;
  shadowVisible: boolean;
  currentSessionId: string | null;
  expandedDisplayId: number | null;
  pillSnapshot: AgentIslandPillSnapshot;
  sessions: AgentIslandSessionSnapshot[];
  totalCount: number;
  measuredContentHeight: number;
  strings: AgentIslandStrings;
  soundSettings: AgentIslandSoundSettings;
  mascotSkin: AgentIslandMascotSkin;
  updatedAt: number;
}

export function createDefaultAgentIslandDisplayConfig(): Pick<
  AgentIslandDisplayState,
  'strings' | 'soundSettings' | 'mascotSkin'
> {
  return {
    strings: { ...DEFAULT_AGENT_ISLAND_STRINGS },
    soundSettings: cloneAgentIslandSoundSettings(DEFAULT_AGENT_ISLAND_SOUND_SETTINGS),
    mascotSkin: DEFAULT_AGENT_ISLAND_MASCOT_SKIN,
  };
}

export function computeAgentIslandContentHeight(input: {
  mode: AgentIslandDisplayMode;
  displaySurface: AgentIslandDisplaySurface;
  hasSession: boolean;
  totalCount: number;
  measuredContentHeight: number;
}): number {
  if (input.mode !== 'expanded') {
    return AGENT_ISLAND_CLOSED_HEIGHT;
  }
  if (!input.hasSession) return AGENT_ISLAND_IDLE_EXPANDED_HEIGHT;
  if (input.measuredContentHeight > 0) {
    return Math.min(
      AGENT_ISLAND_MAX_EXPANDED_HEIGHT,
      Math.max(
        AGENT_ISLAND_EXPANDED_MEASURED_MIN_HEIGHT,
        Math.ceil(input.measuredContentHeight + AGENT_ISLAND_EXPANDED_MEASURED_HEIGHT_OFFSET),
      ),
    );
  }
  if (input.displaySurface === 'sessionList' && input.totalCount > 1) {
    const visibleRows = Math.min(input.totalCount, AGENT_ISLAND_EXPANDED_LIST_MAX_VISIBLE_ROWS);
    return Math.max(
      AGENT_ISLAND_EXPANDED_MIN_HEIGHT,
      Math.min(
        AGENT_ISLAND_MAX_EXPANDED_HEIGHT,
        AGENT_ISLAND_EXPANDED_LIST_VERTICAL_CHROME
          + visibleRows * AGENT_ISLAND_EXPANDED_LIST_ROW_HEIGHT,
      ),
    );
  }
  return Math.max(
    AGENT_ISLAND_EXPANDED_MIN_HEIGHT,
    Math.min(AGENT_ISLAND_MAX_EXPANDED_HEIGHT, AGENT_ISLAND_EXPANDED_FALLBACK_HEIGHT),
  );
}

/** main → renderer:per-session 活动快照(侧栏卡片用)。 */
export const AGENT_ISLAND_SESSION_SNAPSHOTS_CHANNEL = 'agent-island:session-snapshots';
export const AGENT_ISLAND_SET_VISIBLE_SESSION_CHANNEL = 'agent-island:set-visible-session';
export const AGENT_ISLAND_SET_ENABLED_CHANNEL = 'agent-island:set-enabled';
export const AGENT_ISLAND_SET_SOUND_SETTINGS_CHANNEL = 'agent-island:set-sound-settings';
export const AGENT_ISLAND_SET_MASCOT_SKIN_CHANNEL = 'agent-island:set-mascot-skin';
export const AGENT_ISLAND_SET_DISPLAY_TARGET_CHANNEL = 'agent-island:set-display-target';
export const AGENT_ISLAND_GET_DISPLAY_OPTIONS_CHANNEL = 'agent-island:get-display-options';
export const AGENT_ISLAND_PREVIEW_SOUND_CHANNEL = 'agent-island:preview-sound';
export const AGENT_ISLAND_SELECT_SOUND_FILE_CHANNEL = 'agent-island:select-sound-file';
