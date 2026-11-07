import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { app, BrowserWindow } from 'electron';

import type { AgentIslandCompanionSnapshot, AgentIslandPillSnapshot } from '../../shared/agentIsland.js';
import { createLogger } from '../logger.js';

const log = createLogger('agent-island:live-activity');
const requireNative = createRequire(__filename);

/** Matches `AGENT_ACTIVITY_ADDON_RELATIVE_PATH` in native/agent-island/live-activity/build.mjs. */
const ADDON_RELATIVE_PATH = 'tools/agent-island/cindy-agent-activity.node';
/** ActivityKit for Mac apps shipped in macOS 27.3; Darwin and macOS versions match since 26. */
const MIN_DARWIN_VERSION: readonly [number, number] = [27, 3];
const MIN_NATIVE_INTERVAL_MS = 1000;
const START_RETRY_MS = 15_000;
/** How long the system's "Live Activities allowed" answer is reused before asking again. */
const SYSTEM_STATUS_TTL_MS = 30_000;
/** ActivityKit caps a content update at 4 KB; the island's companion thumbnails stay under 2 KB. */
const MAX_COMPANION_JPEG_LENGTH = 2048;

/**
 * Content of Cindy's single Live Activity, shown in the macOS Dynamic Island (menu bar
 * Live Activity area on Macs without one). Mirrors `CindyAgentActivityAttributes.ContentState`.
 */
export interface AgentIslandLiveActivityState {
  status: 'running' | 'attention' | 'completed';
  runningCount: number;
  attentionCount: number;
  title: string;
  detail: string;
  /** The rest of the work, e.g. "2 more tasks running"; empty when the title says it all. */
  summary: string;
  /**
   * Unread finished tasks and their label. Not shown by the widget (extra keys are ignored
   * natively); they let an alert fire for each newly finished task even while others still run.
   */
  completedCount: number;
  completedLabel: string;
  /** The companion the surfaced task speaks for, while it needs the user or has replied. */
  companion?: AgentIslandLiveActivityCompanion;
  mascot: string;
}

/** Mirrors `CindyAgentActivityAttributes.Companion`. */
export interface AgentIslandLiveActivityCompanion {
  hue: string;
  glyph: string;
  glyphIsInitial: boolean;
  imageJpeg?: string;
}

export interface AgentIslandLiveActivityStrings {
  needsInput: string;
  running: string;
  completed: string;
  error: string;
  runningCount: (count: number) => string;
  alsoRunningCount: (count: number) => string;
  waitingCount: (count: number) => string;
}

/**
 * Projects the island's pill snapshot onto the Live Activity: what waits on the user
 * first, then running work, then unread results; nothing left means no activity.
 * `companion` is the identity of the task the pill surfaces (its title already names
 * the companion); it replaces the mascot once that task needs the user or has replied.
 */
export function agentIslandLiveActivityStateFromPill(
  pill: AgentIslandPillSnapshot,
  mascot: string,
  strings: AgentIslandLiveActivityStrings,
  companion?: AgentIslandCompanionSnapshot,
): AgentIslandLiveActivityState | null {
  const state = liveActivityStatusFromPill(pill, mascot, strings);
  if (!state || state.status === 'running' || !companion) return state;
  const imageJpeg = companion.imageJpeg && companion.imageJpeg.length <= MAX_COMPANION_JPEG_LENGTH
    ? companion.imageJpeg
    : undefined;
  return {
    ...state,
    companion: {
      hue: companion.hue,
      glyph: companion.glyph,
      glyphIsInitial: companion.glyphIsInitial,
      ...(imageJpeg ? { imageJpeg } : {}),
    },
  };
}

function liveActivityStatusFromPill(
  pill: AgentIslandPillSnapshot,
  mascot: string,
  strings: AgentIslandLiveActivityStrings,
): AgentIslandLiveActivityState | null {
  const running = pill.runningSessionCount;
  const waiting = pill.pendingInteractionCount;
  const completedLabel = pill.priorityStatus === 'error' ? strings.error : strings.completed;
  const base = {
    runningCount: running,
    attentionCount: waiting,
    title: pill.priorityCompactTitle,
    mascot,
    completedCount: pill.unreadCompletedCount,
    completedLabel,
  };
  if (waiting > 0) {
    const summary = running > 0
      ? strings.alsoRunningCount(running)
      : waiting > 1 ? strings.waitingCount(waiting) : '';
    return { ...base, status: 'attention', detail: strings.needsInput, summary };
  }
  if (running > 0) {
    return { ...base, status: 'running', detail: strings.running, summary: running > 1 ? strings.runningCount(running) : '' };
  }
  if (pill.unreadCompletedCount > 0) {
    // Unread results include failures; say so rather than "completed".
    const detail = pill.priorityStatus === 'error' ? strings.error : strings.completed;
    return { ...base, status: 'completed', detail, summary: '' };
  }
  return null;
}

/**
 * Briefly expands the activity when something new needs the user: another task asks
 * for input, or work finished. Count drops and progress updates stay quiet.
 */
function alertFor(
  previous: AgentIslandLiveActivityState | null,
  next: AgentIslandLiveActivityState,
): { title: string; body: string } | undefined {
  const asksMore = next.attentionCount > (previous?.attentionCount ?? 0);
  const finished = next.status === 'completed' && previous !== null && previous.status !== 'completed';
  // Another task finishing while others still run keeps the summary status unchanged.
  const finishedMore = previous !== null && next.completedCount > previous.completedCount;
  if (!asksMore && !finished && !finishedMore) return undefined;
  if (finishedMore && next.status !== 'completed' && next.status !== 'attention') {
    return { title: next.title, body: next.completedLabel };
  }
  return { title: next.title, body: next.summary ? `${next.detail} · ${next.summary}` : next.detail };
}

interface NativeAgentActivity {
  apply(command: string): string;
}

interface NativeReply {
  ok?: boolean;
  result?: string;
  error?: string;
  /** `status` only: the user allows Cindy's Live Activities in System Settings. */
  enabled?: boolean;
}

export interface AgentIslandLiveActivityDeps {
  platform: NodeJS.Platform;
  darwinRelease: string;
  load: () => NativeAgentActivity | null;
  now: () => number;
  appName: string;
  /** A Cindy window is on screen, so ActivityKit would accept a start right now. */
  hasVisibleWindow: () => boolean;
}

function defaultLoad(): NativeAgentActivity | null {
  const base = app.isPackaged ? process.resourcesPath : path.join(app.getAppPath(), 'resources');
  const addon = path.join(base, ADDON_RELATIVE_PATH);
  if (!fs.existsSync(addon)) return null;
  return requireNative(addon) as NativeAgentActivity;
}

function darwinAtLeast(release: string, [major, minor]: readonly [number, number]): boolean {
  const [releaseMajor = 0, releaseMinor = 0] = release.split('.').map((part) => Number.parseInt(part, 10) || 0);
  return releaseMajor > major || (releaseMajor === major && releaseMinor >= minor);
}

function sameState(a: AgentIslandLiveActivityState | null, b: AgentIslandLiveActivityState | null): boolean {
  if (a === null || b === null) return a === b;
  return a.status === b.status
    && a.runningCount === b.runningCount
    && a.attentionCount === b.attentionCount
    && a.title === b.title
    && a.detail === b.detail
    && a.summary === b.summary
    && a.completedCount === b.completedCount
    && a.completedLabel === b.completedLabel
    && a.companion?.hue === b.companion?.hue
    && a.companion?.glyph === b.companion?.glyph
    && a.companion?.glyphIsInitial === b.companion?.glyphIsInitial
    && a.companion?.imageJpeg === b.companion?.imageJpeg
    && a.mascot === b.mascot;
}

/**
 * Keeps at most one Cindy Live Activity in step with the island state. ActivityKit only
 * accepts a start from the app process while it has a visible window (`visibility`), and
 * later updates from the background, so a refused start waits for the next window focus
 * or a short retry instead of failing the feature. Native calls are coalesced to one per
 * second, keeping only the latest state.
 */
export class AgentIslandLiveActivity {
  private readonly deps: AgentIslandLiveActivityDeps;
  private native: NativeAgentActivity | null | undefined;
  private enabled = true;
  private desired: AgentIslandLiveActivityState | null = null;
  /** What ActivityKit shows now; `undefined` until the first native call. */
  private applied: AgentIslandLiveActivityState | null | undefined;
  private active = false;
  private lastNativeAt = Number.NEGATIVE_INFINITY;
  private retryAfter = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** The last start was refused for a reason a window cannot fix (not `visibility`). */
  private startBlocked = false;
  private systemAllowed = false;
  private systemCheckedAt = Number.NEGATIVE_INFINITY;

  constructor(deps: Partial<AgentIslandLiveActivityDeps> = {}) {
    this.deps = {
      platform: process.platform,
      darwinRelease: os.release(),
      load: defaultLoad,
      now: Date.now,
      appName: 'Cindy',
      hasVisibleWindow: () => BrowserWindow.getAllWindows().some((window) => window.isVisible() && !window.isMinimized()),
      ...deps,
    };
  }

  /** The OS supports Live Activities and this build ships the addon. */
  isSupported(): boolean {
    return this.loadNative() !== null;
  }

  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    this.schedule();
  }

  sync(state: AgentIslandLiveActivityState | null): void {
    if (sameState(this.desired, state)) return;
    this.desired = state;
    this.schedule();
  }

  /**
   * Whether task alerts reach the user through the Live Activity, so the OS notification
   * for the same event can be skipped (like Agent Notch does). Only while the user allows
   * it in System Settings and it is showing, or a visible window would let it start;
   * otherwise the notification is the only alert and must still be sent.
   */
  ownsAlerts(): boolean {
    const native = this.loadNative();
    if (!native || !this.enabled || this.startBlocked) return false;
    const now = this.deps.now();
    if (now - this.systemCheckedAt >= SYSTEM_STATUS_TTL_MS) {
      this.systemCheckedAt = now;
      try {
        const reply = JSON.parse(native.apply(JSON.stringify({ action: 'status' }))) as NativeReply;
        this.systemAllowed = reply.ok === true && reply.enabled === true;
      } catch (error) {
        log.warn('Live Activity status check failed', error);
        this.systemAllowed = false;
      }
    }
    return this.systemAllowed && (this.active || this.deps.hasVisibleWindow());
  }

  /** A Cindy window became visible: a start refused for `visibility` can succeed now. */
  notifyWindowVisible(): void {
    if (this.active || this.retryAfter === 0) return;
    this.retryAfter = 0;
    // Replace the pending back-off timer so the retry happens now.
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.schedule();
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    // Quitting: let ActivityKit confirm the end so the system island does not keep a stale task.
    if (this.native && (this.active || this.applied === undefined)) this.call({ action: 'end', wait: true });
    this.active = false;
  }

  private target(): AgentIslandLiveActivityState | null {
    return this.enabled ? this.desired : null;
  }

  private loadNative(): NativeAgentActivity | null {
    if (this.native !== undefined) return this.native;
    this.native = null;
    if (this.deps.platform !== 'darwin' || !darwinAtLeast(this.deps.darwinRelease, MIN_DARWIN_VERSION)) {
      return null;
    }
    try {
      this.native = this.deps.load();
    } catch (error) {
      log.warn('Live Activity addon failed to load', error);
    }
    return this.native;
  }

  private schedule(): void {
    if (this.timer) return;
    const native = this.loadNative();
    if (!native) return;
    const now = this.deps.now();
    const wait = Math.max(0, this.lastNativeAt + MIN_NATIVE_INTERVAL_MS - now, this.retryAfter - now);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, wait);
    this.timer.unref?.();
  }

  private flush(): void {
    const target = this.target();
    if (this.applied !== undefined && sameState(this.applied, target) && (target === null || this.active)) return;
    if (this.applied === undefined) {
      // Clears activities a previous run left behind after a crash or forced quit.
      this.call({ action: 'end' });
      this.applied = null;
    }
    if (target === null) {
      if (this.active) {
        this.call({ action: 'end' });
        this.active = false;
      }
      this.applied = null;
      return;
    }
    // Only an update can alert; a fresh start already shows up on its own.
    const alert = this.active ? alertFor(this.applied ?? null, target) : undefined;
    const reply = this.call({ action: 'sync', appName: this.deps.appName, state: target, alert });
    if (reply?.ok) {
      if (reply.result === 'started') log.info('Live Activity started');
      this.active = true;
      this.applied = target;
      this.retryAfter = 0;
      this.startBlocked = false;
      return;
    }
    this.active = false;
    this.applied = null;
    this.startBlocked = !String(reply?.error ?? '').includes('visibility');
    this.retryAfter = this.deps.now() + START_RETRY_MS;
    log.info('Live Activity start deferred', { reason: reply?.error ?? 'unknown' });
    this.schedule();
  }

  private call(command: Record<string, unknown>): NativeReply | null {
    if (!this.native) return null;
    this.lastNativeAt = this.deps.now();
    try {
      return JSON.parse(this.native.apply(JSON.stringify(command))) as NativeReply;
    } catch (error) {
      log.warn('Live Activity native call failed', { action: command.action, error });
      return null;
    }
  }
}
