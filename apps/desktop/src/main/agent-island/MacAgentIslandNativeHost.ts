import { app, type Rectangle } from 'electron';
import { execFile, spawn, type ChildProcessByStdio } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Readable, Writable } from 'node:stream';

import type { AgentIslandDisplayState, AgentIslandSoundChoice } from '../../shared/agentIsland.js';
import type { AgentIslandLayoutPreference } from './geometry.js';
import { createLogger } from '../logger.js';

const log = createLogger('agent-island:native');

const MAC_AGENT_ISLAND_HELPER_RESOURCE = path.join(
  'tools',
  'agent-island',
  'xdt-macos-agent-island-helper',
);
const MAC_AGENT_ISLAND_HELPER_SOURCE_RELATIVE = path.join(
  'native',
  'agent-island',
  'macos-agent-island-helper.swift',
);
const MAC_AGENT_ISLAND_RUNNING_GIF = 'running-agent.gif';
const MAC_AGENT_ISLAND_RUNNING_GIF_SOURCE_RELATIVE = path.join(
  'native',
  'agent-island',
  MAC_AGENT_ISLAND_RUNNING_GIF,
);
const MAC_AGENT_ISLAND_MASCOTS_DIR = 'mascots';
const MAC_AGENT_ISLAND_MASCOTS_SOURCE_RELATIVE = path.join(
  'native',
  'agent-island',
  MAC_AGENT_ISLAND_MASCOTS_DIR,
);
const MAC_AGENT_ISLAND_SOUNDS_DIR = 'sounds';
const MAC_AGENT_ISLAND_SOUNDS_SOURCE_RELATIVE = path.join(
  'native',
  'agent-island',
  MAC_AGENT_ISLAND_SOUNDS_DIR,
);
const HELPER_START_TIMEOUT_MS = 2_500;
const HELPER_RESTART_MAX_ATTEMPTS = 3;
const HELPER_RESTART_BASE_DELAY_MS = 1_000;
const HELPER_RESTART_MAX_DELAY_MS = 5_000;
const HELPER_RESTART_HEALTHY_RESET_MS = 30_000;

type NativeProcess = ChildProcessByStdio<Writable, Readable, Readable>;

export interface AgentIslandNativeFrame extends Rectangle {
  displayId: number;
  displayBounds: Rectangle;
  contentWidth?: number | null;
}

export interface AgentIslandNativeScreenMetrics {
  displayId: number;
  frame: Rectangle;
  hasNotch: boolean;
  notchWidth: number;
  topBarHeight: number;
  menuBarHeight: number;
  safeAreaTop: number;
  isMain: boolean;
  signature: string;
}

interface MacAgentIslandNativeHostOptions {
  onPointerZones: (zones: { menuBar: boolean; panel: boolean; displayId?: number | null }) => void;
  onExpand: (displayId?: number | null) => void;
  onFocusSession: (sessionId: string) => void;
  onOpenSettings: () => void;
  onNewMessage: () => void;
  onToggleSound: () => void;
  onPermissionAction: (action: {
    requestId: string;
    action: 'allow' | 'allowForSession' | 'deny';
  }) => void;
  onOutsideClick: () => void;
  onLayoutDragActive: (active: boolean) => void;
  onLayoutPreference: (preference: AgentIslandLayoutPreference) => void;
  onContentHeight: (height: number) => void;
  onScreenMetrics: (metrics: {
    screens: AgentIslandNativeScreenMetrics[];
    preferredDisplayId: number | null;
    forceRefresh: boolean;
  }) => void;
}

type NativePayload = {
  type?: unknown;
  message?: unknown;
  event?: unknown;
  forceRefresh?: unknown;
  hit?: unknown;
  mode?: unknown;
  fromMode?: unknown;
  toMode?: unknown;
  notchStatus?: unknown;
  fromNotchStatus?: unknown;
  toNotchStatus?: unknown;
  displayPolicy?: unknown;
  fromDisplayPolicy?: unknown;
  toDisplayPolicy?: unknown;
  side?: unknown;
  x?: unknown;
  y?: unknown;
  centerX?: unknown;
  startCenterX?: unknown;
  centerDelta?: unknown;
  frameX?: unknown;
  left?: unknown;
  right?: unknown;
  top?: unknown;
  bottom?: unknown;
  width?: unknown;
  height?: unknown;
  leftMouseDown?: unknown;
  menuBar?: unknown;
  panel?: unknown;
  sessionId?: unknown;
  requestId?: unknown;
  action?: unknown;
  active?: unknown;
  centerXRatio?: unknown;
  contentWidth?: unknown;
  expanded?: unknown;
  layoutWidth?: unknown;
  carrierWidth?: unknown;
  incomingCenterX?: unknown;
  panelCenterX?: unknown;
  panelFrameX?: unknown;
  panelWidth?: unknown;
  displayId?: unknown;
  soundId?: unknown;
  soundPath?: unknown;
  screens?: unknown;
  preferredDisplayId?: unknown;
};

type NativeUpdate = {
  type: 'update';
  state: AgentIslandDisplayState;
  frame?: AgentIslandNativeFrame;
  frames?: AgentIslandNativeFrame[];
  statesByDisplayId?: Record<string, AgentIslandDisplayState>;
};

/**
 * Spawns the macOS Swift/AppKit island renderer and speaks a newline-delimited
 * JSON protocol over stdio. Product state stays in TypeScript; the helper owns
 * the NSPanel, SwiftUI path, shadow and native hover tracking.
 */
export class MacAgentIslandNativeHost {
  private child: NativeProcess | null = null;
  private starting: Promise<boolean> | null = null;
  private ready = false;
  private stdoutBuffer = '';
  private pendingUpdate: NativeUpdate | null = null;
  private pendingSounds: AgentIslandSoundChoice[] = [];
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private restartHealthyTimer: ReturnType<typeof setTimeout> | null = null;
  private restartAttempts = 0;
  private permanentlyFailed = false;
  private lifecycleToken = 0;
  private helperBinaryPath: string | null = null;
  private helperBinaryPromise: Promise<string> | null = null;
  private readonly hoverZonesByDisplayId = new Map<number, { menuBar: boolean; panel: boolean }>();

  constructor(private readonly options: MacAgentIslandNativeHostOptions) {}

  get failed(): boolean {
    return this.permanentlyFailed;
  }

  publish(
    state: AgentIslandDisplayState,
    frameOrFrames: AgentIslandNativeFrame | AgentIslandNativeFrame[],
    statesByDisplayId?: Record<string, AgentIslandDisplayState>,
  ): boolean {
    if (this.permanentlyFailed) return false;
    const frames = Array.isArray(frameOrFrames) ? frameOrFrames : [frameOrFrames];
    this.pendingUpdate = {
      type: 'update',
      state,
      frame: frames[0],
      frames,
      statesByDisplayId,
    };
    if (this.ready && this.child) {
      this.flushPendingUpdate();
      return true;
    }
    if (this.restartTimer) return true;
    void this.ensureStarted();
    return true;
  }

  playSound(sound: AgentIslandSoundChoice): boolean {
    if (this.permanentlyFailed || (sound.type === 'builtin' && sound.id === 'none')) return false;
    if (this.ready && this.child) {
      this.sendSound(sound);
      return true;
    }
    this.pendingSounds.push(sound);
    if (this.restartTimer) return true;
    void this.ensureStarted();
    return true;
  }

  prepare(): void {
    if (this.permanentlyFailed) return;
    void this.resolveHelperBinary().catch((error) => {
      log.warn('native helper prewarm failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  stop(): void {
    this.permanentlyFailed = true;
    this.suspend();
  }

  /**
   * Temporarily tears down the helper when Agent Island is disabled.
   * Unlike stop(), this keeps the host reusable so a later publish can respawn.
   */
  suspend(): void {
    this.lifecycleToken += 1;
    this.clearRestartTimer();
    this.clearRestartHealthyTimer();
    this.restartAttempts = 0;
    this.pendingUpdate = null;
    this.pendingSounds.splice(0, this.pendingSounds.length);
    this.stdoutBuffer = '';
    this.clearPointerZones();
    const child = this.child;
    this.child = null;
    this.ready = false;
    this.starting = null;
    if (!child || child.killed) return;
    try {
      child.stdin.write(`${JSON.stringify({ type: 'shutdown' })}\n`);
    } catch {
      // ignore, the process may already be gone
    }
    child.kill();
  }

  private async ensureStarted(): Promise<boolean> {
    if (this.ready && this.child) return true;
    if (this.starting) return this.starting;
    this.starting = this.startChildProcess()
      .finally(() => {
        this.starting = null;
      });
    return this.starting;
  }

  private async startChildProcess(): Promise<boolean> {
    const lifecycleToken = this.lifecycleToken;
    let binary: string;
    try {
      binary = await this.resolveHelperBinary();
    } catch (error) {
      this.permanentlyFailed = true;
      log.warn('native helper could not be prepared; Agent Island will remain hidden', {
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
    if (this.lifecycleToken !== lifecycleToken || this.permanentlyFailed) {
      return false;
    }
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const child = spawn(binary, [], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          XDT_AGENT_ISLAND_ASSET_DIR: path.dirname(binary),
        },
      });
      if (this.lifecycleToken !== lifecycleToken || this.permanentlyFailed) {
        if (!child.killed) child.kill();
        resolve(false);
        return;
      }
      this.child = child;
      this.ready = false;
      this.stdoutBuffer = '';
      this.clearPointerZones();

      let startTimer: ReturnType<typeof setTimeout> | null = null;
      const settle = (ok: boolean): void => {
        if (settled) return;
        settled = true;
        if (startTimer) clearTimeout(startTimer);
        if (!ok && this.child === child) {
          this.child = null;
          this.ready = false;
          if (!child.killed) child.kill();
        }
        resolve(ok);
      };

      startTimer = setTimeout(() => {
        if (this.lifecycleToken !== lifecycleToken || this.permanentlyFailed) {
          settle(false);
          return;
        }
        log.warn('native helper did not become ready in time');
        settle(false);
        this.scheduleRestart(null, null);
      }, HELPER_START_TIMEOUT_MS);

      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        this.stdoutBuffer += chunk;
        let newlineIndex = this.stdoutBuffer.indexOf('\n');
        while (newlineIndex >= 0) {
          const line = this.stdoutBuffer.slice(0, newlineIndex).trim();
          this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
          if (line) {
            this.handlePayloadLine(line, child, settle);
          }
          newlineIndex = this.stdoutBuffer.indexOf('\n');
        }
      });

      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => {
        const text = chunk.trim();
        if (text) log.debug('native helper stderr', { text });
      });

      child.stdin.on('error', (error) => {
        const wasCurrentChild = this.child === child;
        if (wasCurrentChild) {
          this.child = null;
          this.ready = false;
          this.clearRestartHealthyTimer();
          this.clearPointerZones();
          if (!child.killed) child.kill();
        }
        log.warn('native helper stdin error', { error: error.message });
        if (!settled) {
          settle(false);
        }
        if (wasCurrentChild && this.pendingUpdate && !this.permanentlyFailed) {
          this.scheduleRestart(null, null);
        }
      });

      child.on('error', (error) => {
        const wasCurrentChild = this.child === child;
        if (wasCurrentChild) {
          this.child = null;
          this.ready = false;
          this.clearRestartHealthyTimer();
          this.clearPointerZones();
        }
        log.warn('native helper process error', { error: error.message });
        if (!settled) {
          settle(false);
        }
        if (wasCurrentChild && this.pendingUpdate && !this.permanentlyFailed) {
          this.scheduleRestart(null, null);
        }
      });

      child.on('exit', (code, signal) => {
        const wasCurrentChild = this.child === child;
        if (wasCurrentChild) {
          this.child = null;
          this.ready = false;
          this.clearRestartHealthyTimer();
          this.clearPointerZones();
        }
        if (!settled) {
          settle(false);
          if (wasCurrentChild && this.pendingUpdate && !this.permanentlyFailed) {
            this.scheduleRestart(code, signal);
          }
          return;
        }
        log.debug('native helper exited', { code, signal });
        if (wasCurrentChild && this.pendingUpdate && !this.permanentlyFailed) {
          this.scheduleRestart(code, signal);
        }
      });
    });
  }

  private resolveHelperBinary(): Promise<string> {
    if (this.helperBinaryPath) return Promise.resolve(this.helperBinaryPath);
    if (this.helperBinaryPromise) return this.helperBinaryPromise;
    this.helperBinaryPromise = resolveMacAgentIslandHelperBinary()
      .then((binaryPath) => {
        this.helperBinaryPath = binaryPath;
        return binaryPath;
      })
      .finally(() => {
        this.helperBinaryPromise = null;
      });
    return this.helperBinaryPromise;
  }

  private handlePayloadLine(
    line: string,
    child: NativeProcess,
    settle: (ok: boolean) => void,
  ): void {
    let payload: NativePayload;
    try {
      payload = JSON.parse(line) as NativePayload;
    } catch {
      log.debug('native helper emitted non-json line', { line });
      return;
    }

    if (payload.type === 'ready') {
      if (this.child !== child) return;
      this.ready = true;
      this.armRestartHealthyReset(child);
      settle(true);
      this.flushPendingUpdate();
      this.flushPendingSounds();
      log.info('native helper ready');
      return;
    }

    if (payload.type === 'error') {
      const message = typeof payload.message === 'string'
        ? payload.message
        : 'Native agent island helper failed.';
      log.warn('native helper error', { message });
      if (!this.ready) settle(false);
      return;
    }

    if (payload.type === 'debug' && this.child === child) {
      log.debug('native helper debug', {
        event: typeof payload.event === 'string' ? payload.event : undefined,
        hit: typeof payload.hit === 'string' ? payload.hit : undefined,
        mode: typeof payload.mode === 'string' ? payload.mode : undefined,
        fromMode: typeof payload.fromMode === 'string' ? payload.fromMode : undefined,
        toMode: typeof payload.toMode === 'string' ? payload.toMode : undefined,
        notchStatus: typeof payload.notchStatus === 'string' ? payload.notchStatus : undefined,
        fromNotchStatus: typeof payload.fromNotchStatus === 'string' ? payload.fromNotchStatus : undefined,
        toNotchStatus: typeof payload.toNotchStatus === 'string' ? payload.toNotchStatus : undefined,
        displayPolicy: typeof payload.displayPolicy === 'string' ? payload.displayPolicy : undefined,
        fromDisplayPolicy: typeof payload.fromDisplayPolicy === 'string' ? payload.fromDisplayPolicy : undefined,
        toDisplayPolicy: typeof payload.toDisplayPolicy === 'string' ? payload.toDisplayPolicy : undefined,
        side: typeof payload.side === 'string' ? payload.side : undefined,
        x: typeof payload.x === 'number' ? payload.x : undefined,
        y: typeof payload.y === 'number' ? payload.y : undefined,
        centerX: typeof payload.centerX === 'number' ? payload.centerX : undefined,
        startCenterX: typeof payload.startCenterX === 'number' ? payload.startCenterX : undefined,
        centerDelta: typeof payload.centerDelta === 'number' ? payload.centerDelta : undefined,
        frameX: typeof payload.frameX === 'number' ? payload.frameX : undefined,
        left: typeof payload.left === 'number' ? payload.left : undefined,
        right: typeof payload.right === 'number' ? payload.right : undefined,
        top: typeof payload.top === 'number' ? payload.top : undefined,
        bottom: typeof payload.bottom === 'number' ? payload.bottom : undefined,
        width: typeof payload.width === 'number' ? payload.width : undefined,
        height: typeof payload.height === 'number' ? payload.height : undefined,
        contentWidth: typeof payload.contentWidth === 'number' ? payload.contentWidth : undefined,
        expanded: typeof payload.expanded === 'boolean' ? payload.expanded : undefined,
        layoutWidth: typeof payload.layoutWidth === 'number' ? payload.layoutWidth : undefined,
        carrierWidth: typeof payload.carrierWidth === 'number' ? payload.carrierWidth : undefined,
        incomingCenterX: typeof payload.incomingCenterX === 'number' ? payload.incomingCenterX : undefined,
        panelCenterX: typeof payload.panelCenterX === 'number' ? payload.panelCenterX : undefined,
        panelFrameX: typeof payload.panelFrameX === 'number' ? payload.panelFrameX : undefined,
        panelWidth: typeof payload.panelWidth === 'number' ? payload.panelWidth : undefined,
        leftMouseDown: typeof payload.leftMouseDown === 'boolean' ? payload.leftMouseDown : undefined,
        displayId: typeof payload.displayId === 'number' ? payload.displayId : undefined,
      });
      return;
    }

    if (payload.type === 'hover' && this.child === child) {
      const zones = {
        menuBar: payload.menuBar === true,
        panel: payload.panel === true,
      };
      if (typeof payload.displayId === 'number' && Number.isFinite(payload.displayId)) {
        this.hoverZonesByDisplayId.set(payload.displayId, zones);
        this.options.onPointerZones(this.aggregatePointerZones());
      } else {
        this.options.onPointerZones(zones);
      }
      return;
    }

    if (payload.type === 'expand' && this.child === child) {
      this.options.onExpand(typeof payload.displayId === 'number' ? payload.displayId : null);
      return;
    }

    if (payload.type === 'focus-session' && this.child === child && typeof payload.sessionId === 'string') {
      this.options.onFocusSession(payload.sessionId);
      return;
    }

    if (
      payload.type === 'permission-action'
      && this.child === child
      && typeof payload.requestId === 'string'
      && isAgentIslandPermissionAction(payload.action)
    ) {
      this.options.onPermissionAction({
        requestId: payload.requestId,
        action: payload.action,
      });
      return;
    }

    if (payload.type === 'open-settings' && this.child === child) {
      this.options.onOpenSettings();
      return;
    }

    if (payload.type === 'new-message' && this.child === child) {
      this.options.onNewMessage();
      return;
    }

    if (payload.type === 'toggle-sound' && this.child === child) {
      this.options.onToggleSound();
      return;
    }

    if (payload.type === 'outside-click' && this.child === child) {
      this.options.onOutsideClick();
      return;
    }

    if (payload.type === 'drag' && this.child === child && typeof payload.active === 'boolean') {
      this.options.onLayoutDragActive(payload.active);
      return;
    }

    if (payload.type === 'layout' && this.child === child) {
      const preference: AgentIslandLayoutPreference = {};
      if (typeof payload.displayId === 'number' && Number.isFinite(payload.displayId)) {
        preference.displayId = payload.displayId;
      }
      if (typeof payload.centerXRatio === 'number' && Number.isFinite(payload.centerXRatio)) {
        preference.centerXRatio = payload.centerXRatio;
      }
      if (typeof payload.contentWidth === 'number' && Number.isFinite(payload.contentWidth)) {
        if (payload.expanded === true) {
          preference.expandedContentWidth = payload.contentWidth;
        } else {
          preference.compactContentWidth = payload.contentWidth;
        }
      }
      this.options.onLayoutPreference(preference);
      return;
    }

    if (payload.type === 'content-height' && this.child === child) {
      if (typeof payload.height === 'number' && Number.isFinite(payload.height)) {
        this.options.onContentHeight(payload.height);
      }
      return;
    }

    if (payload.type === 'screen-metrics' && this.child === child) {
      this.options.onScreenMetrics({
        screens: parseNativeScreenMetrics(payload.screens),
        preferredDisplayId: typeof payload.preferredDisplayId === 'number'
          ? payload.preferredDisplayId
          : null,
        forceRefresh: payload.forceRefresh === true,
      });
    }
  }

  private flushPendingUpdate(): void {
    if (!this.ready || !this.child || !this.pendingUpdate) return;
    try {
      this.child.stdin.write(`${JSON.stringify(this.pendingUpdate)}\n`);
    } catch (error) {
      log.warn('failed to send native helper update', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private flushPendingSounds(): void {
    if (!this.ready || !this.child || this.pendingSounds.length === 0) return;
    const sounds = this.pendingSounds.splice(0, this.pendingSounds.length);
    for (const sound of sounds) {
      this.sendSound(sound);
    }
  }

  private sendSound(sound: AgentIslandSoundChoice): void {
    if (!this.ready || !this.child) return;
    const payload = sound.type === 'custom'
      ? { type: 'play-sound', soundPath: sound.path }
      : { type: 'play-sound', soundId: sound.id };
    try {
      this.child.stdin.write(`${JSON.stringify(payload)}\n`);
    } catch (error) {
      log.warn('failed to send native helper sound command', {
        sound: sound.type === 'custom' ? sound.path : sound.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private scheduleRestart(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.restartTimer || this.permanentlyFailed) return;
    if (this.restartAttempts >= HELPER_RESTART_MAX_ATTEMPTS) {
      this.permanentlyFailed = true;
      log.warn('native helper restart limit reached; Agent Island will remain hidden', { code, signal });
      return;
    }
    this.restartAttempts += 1;
    const delayMs = Math.min(
      HELPER_RESTART_BASE_DELAY_MS * (2 ** (this.restartAttempts - 1)),
      HELPER_RESTART_MAX_DELAY_MS,
    );
    log.warn('native helper exited unexpectedly; scheduling restart', {
      attempt: this.restartAttempts,
      code,
      signal,
      delayMs,
    });
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (this.ready || this.child || this.permanentlyFailed) return;
      void this.ensureStarted();
    }, delayMs);
  }

  private clearRestartTimer(): void {
    if (!this.restartTimer) return;
    clearTimeout(this.restartTimer);
    this.restartTimer = null;
  }

  private armRestartHealthyReset(child: NativeProcess): void {
    this.clearRestartHealthyTimer();
    this.restartHealthyTimer = setTimeout(() => {
      this.restartHealthyTimer = null;
      if (this.child !== child || !this.ready) return;
      this.restartAttempts = 0;
    }, HELPER_RESTART_HEALTHY_RESET_MS);
  }

  private clearRestartHealthyTimer(): void {
    if (!this.restartHealthyTimer) return;
    clearTimeout(this.restartHealthyTimer);
    this.restartHealthyTimer = null;
  }

  private clearPointerZones(): void {
    if (this.hoverZonesByDisplayId.size > 0) {
      this.hoverZonesByDisplayId.clear();
    }
    this.options.onPointerZones({ menuBar: false, panel: false, displayId: null });
  }

  private aggregatePointerZones(): { menuBar: boolean; panel: boolean; displayId: number | null } {
    let menuBar = false;
    let panel = false;
    let displayId: number | null = null;
    for (const zones of this.hoverZonesByDisplayId.values()) {
      menuBar = menuBar || zones.menuBar;
      panel = panel || zones.panel;
    }
    for (const [candidateDisplayId, zones] of this.hoverZonesByDisplayId.entries()) {
      if (zones.panel) {
        displayId = candidateDisplayId;
        break;
      }
      if (displayId === null && zones.menuBar) {
        displayId = candidateDisplayId;
      }
    }
    return { menuBar, panel, displayId };
  }
}

function parseNativeScreenMetrics(input: unknown): AgentIslandNativeScreenMetrics[] {
  if (!Array.isArray(input)) return [];
  const metrics: AgentIslandNativeScreenMetrics[] = [];
  for (const item of input) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const frame = parseNativeRectangle(record.frame);
    if (
      typeof record.displayId !== 'number'
      || !Number.isFinite(record.displayId)
      || !frame
      || typeof record.hasNotch !== 'boolean'
      || typeof record.notchWidth !== 'number'
      || !Number.isFinite(record.notchWidth)
      || typeof record.topBarHeight !== 'number'
      || !Number.isFinite(record.topBarHeight)
      || typeof record.menuBarHeight !== 'number'
      || !Number.isFinite(record.menuBarHeight)
      || typeof record.safeAreaTop !== 'number'
      || !Number.isFinite(record.safeAreaTop)
      || typeof record.isMain !== 'boolean'
      || typeof record.signature !== 'string'
    ) {
      continue;
    }
    metrics.push({
      displayId: record.displayId,
      frame,
      hasNotch: record.hasNotch,
      notchWidth: record.notchWidth,
      topBarHeight: record.topBarHeight,
      menuBarHeight: record.menuBarHeight,
      safeAreaTop: record.safeAreaTop,
      isMain: record.isMain,
      signature: record.signature,
    });
  }
  return metrics;
}

function isAgentIslandPermissionAction(value: unknown): value is 'allow' | 'allowForSession' | 'deny' {
  return value === 'allow' || value === 'allowForSession' || value === 'deny';
}

function parseNativeRectangle(input: unknown): Rectangle | null {
  if (!input || typeof input !== 'object') return null;
  const record = input as Record<string, unknown>;
  if (
    typeof record.x !== 'number'
    || !Number.isFinite(record.x)
    || typeof record.y !== 'number'
    || !Number.isFinite(record.y)
    || typeof record.width !== 'number'
    || !Number.isFinite(record.width)
    || typeof record.height !== 'number'
    || !Number.isFinite(record.height)
  ) {
    return null;
  }
  return {
    x: record.x,
    y: record.y,
    width: record.width,
    height: record.height,
  };
}

async function resolveMacAgentIslandHelperBinary(): Promise<string> {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, MAC_AGENT_ISLAND_HELPER_RESOURCE);
  }
  await buildDevMacAgentIslandHelper();
  return getMacAgentIslandHelperDevBinary();
}

async function buildDevMacAgentIslandHelper(): Promise<void> {
  const source = resolveDevMacAgentIslandHelperSource();
  const binary = getMacAgentIslandHelperDevBinary();
  if (!fs.existsSync(source)) {
    throw new Error(`Agent Island helper source missing at ${source}`);
  }
  const sourceHash = fileSha256(source);
  const hashFile = getMacAgentIslandHelperDevHashFile();
  copyDevMacAgentIslandAssets();
  if (
    fs.existsSync(binary)
    && fs.existsSync(hashFile)
    && fs.readFileSync(hashFile, 'utf8').trim() === sourceHash
  ) {
    return;
  }
  fs.mkdirSync(path.dirname(binary), { recursive: true });
  await execFilePromise('swiftc', [source, '-O', '-o', binary], 20_000);
  fs.chmodSync(binary, 0o755);
  fs.writeFileSync(hashFile, `${sourceHash}\n`, 'utf8');
  log.info('built dev macOS agent island helper', { path: binary });
}

function resolveDevMacAgentIslandHelperSource(): string {
  const appPathSource = path.join(app.getAppPath(), MAC_AGENT_ISLAND_HELPER_SOURCE_RELATIVE);
  if (fs.existsSync(appPathSource)) return appPathSource;
  return path.join(__dirname, '..', '..', MAC_AGENT_ISLAND_HELPER_SOURCE_RELATIVE);
}

function resolveDevMacAgentIslandRunningGifSource(): string {
  const appPathSource = path.join(app.getAppPath(), MAC_AGENT_ISLAND_RUNNING_GIF_SOURCE_RELATIVE);
  if (fs.existsSync(appPathSource)) return appPathSource;
  return path.join(__dirname, '..', '..', MAC_AGENT_ISLAND_RUNNING_GIF_SOURCE_RELATIVE);
}

function resolveDevMacAgentIslandMascotsSource(): string {
  const appPathSource = path.join(app.getAppPath(), MAC_AGENT_ISLAND_MASCOTS_SOURCE_RELATIVE);
  if (fs.existsSync(appPathSource)) return appPathSource;
  return path.join(__dirname, '..', '..', MAC_AGENT_ISLAND_MASCOTS_SOURCE_RELATIVE);
}

function resolveDevMacAgentIslandSoundsSource(): string {
  const appPathSource = path.join(app.getAppPath(), MAC_AGENT_ISLAND_SOUNDS_SOURCE_RELATIVE);
  if (fs.existsSync(appPathSource)) return appPathSource;
  return path.join(__dirname, '..', '..', MAC_AGENT_ISLAND_SOUNDS_SOURCE_RELATIVE);
}

function getMacAgentIslandHelperDevBinary(): string {
  return path.join(app.getPath('userData'), 'agent-island', 'xdt-macos-agent-island-helper');
}

function getMacAgentIslandHelperDevHashFile(): string {
  return `${getMacAgentIslandHelperDevBinary()}.sha256`;
}

function fileSha256(filePath: string): string {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function copyDevMacAgentIslandAssets(): void {
  const source = resolveDevMacAgentIslandRunningGifSource();
  if (!fs.existsSync(source)) {
    throw new Error(`Agent Island running GIF missing at ${source}`);
  }
  const dest = path.join(path.dirname(getMacAgentIslandHelperDevBinary()), MAC_AGENT_ISLAND_RUNNING_GIF);
  copyFileIfChanged(source, dest);
  copyDirectory(resolveDevMacAgentIslandMascotsSource(), path.join(path.dirname(getMacAgentIslandHelperDevBinary()), MAC_AGENT_ISLAND_MASCOTS_DIR));
  copyDirectory(resolveDevMacAgentIslandSoundsSource(), path.join(path.dirname(getMacAgentIslandHelperDevBinary()), MAC_AGENT_ISLAND_SOUNDS_DIR));
}

function copyDirectory(sourceDir: string, destDir: string): void {
  if (!fs.existsSync(sourceDir)) {
    throw new Error(`Agent Island asset directory missing at ${sourceDir}`);
  }
  fs.mkdirSync(destDir, { recursive: true });
  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    const source = path.join(sourceDir, entry.name);
    const dest = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      copyDirectory(source, dest);
      continue;
    }
    if (!entry.isFile()) continue;
    copyFileIfChanged(source, dest);
  }
}

function copyFileIfChanged(source: string, dest: string): void {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (fs.existsSync(dest)) {
    const sourceStat = fs.statSync(source);
    const destStat = fs.statSync(dest);
    if (destStat.mtimeMs >= sourceStat.mtimeMs && destStat.size === sourceStat.size) {
      return;
    }
  }
  fs.copyFileSync(source, dest);
}

function execFilePromise(file: string, args: string[], timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = execFile(file, args, { timeout: timeoutMs }, (error, _stdout, stderr) => {
      if (error) {
        const message = stderr?.trim()
          ? `${error.message}: ${stderr.trim()}`
          : error.message;
        reject(new Error(message));
        return;
      }
      resolve();
    });
    child.on('error', reject);
  });
}
