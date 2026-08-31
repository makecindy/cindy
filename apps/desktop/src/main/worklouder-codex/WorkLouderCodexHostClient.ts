import {
  isWorkLouderCodexHostMessage,
  isWorkLouderCodexLightingFrameOff,
  parseWorkLouderCodexAgentKeyPress,
  type WorkLouderCodexHidEvent,
  type WorkLouderCodexHostRequest,
  type WorkLouderCodexJoystickEvent,
  type WorkLouderCodexLightingFrame,
} from './protocol.js';
import type {
  WorkLouderCodexConnectionReason,
  WorkLouderCodexConnectionStatus,
  WorkLouderCodexDeviceState,
} from '../../shared/workLouderCodex.js';
import type { WorkLouderCodexLightingSink } from './WorkLouderCodexLightingController.js';

const MAX_CONSECUTIVE_CRASHES = 5;

export interface WorkLouderCodexChildLike {
  postMessage(message: unknown): void;
  on(event: 'message', listener: (message: unknown) => void): void;
  on(event: 'exit', listener: (code: number) => void): void;
  on(
    event: 'error',
    listener: (type: string | Error, location?: string, report?: string) => void,
  ): void;
  kill(): boolean;
}

export interface WorkLouderCodexLoggerLike {
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

export interface WorkLouderSdkLocation {
  entry: string;
  source: 'cindy-package' | 'openai-app';
}

export interface WorkLouderCodexHostClientDeps {
  resolveSdk(): WorkLouderSdkLocation | null;
  fork(sdkEntry: string): WorkLouderCodexChildLike;
  log: WorkLouderCodexLoggerLike;
  connectTimeoutMs?: number;
  disposeTimeoutMs?: number;
  /** How long a connection must stay up before the crash budget resets. */
  stableConnectionMs?: number;
}

/**
 * Lazy main-process proxy for the Work Louder utility process. The native HID
 * SDK is never loaded into Electron main and an idle Cindy never forks it.
 */
export class WorkLouderCodexHostClient implements WorkLouderCodexLightingSink {
  private child: WorkLouderCodexChildLike | null = null;
  private latestFrame: WorkLouderCodexLightingFrame | null = null;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private connectWatchdogTimer: ReturnType<typeof setTimeout> | null = null;
  private consecutiveCrashes = 0;
  private stableConnectionTimer: ReturnType<typeof setTimeout> | null = null;
  private lastStatus: 'connected' | 'not-detected' | 'error' | null = null;
  private recyclingChild = false;
  private disposed = false;
  private unavailableLogged = false;
  private disposePromise: Promise<void> | null = null;
  private finishDispose: (() => void) | null = null;
  private disposeTimer: ReturnType<typeof setTimeout> | null = null;
  private disconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private agentKeyPressHandler: ((slot: number) => void) | null = null;
  private deviceActivityHandler: (() => void) | null = null;
  private hidInputHandler: ((event: WorkLouderCodexHidEvent) => void) | null = null;
  private joystickInputHandler: ((event: WorkLouderCodexJoystickEvent) => void) | null = null;
  private deviceStateHandler: ((device: WorkLouderCodexDeviceState) => void) | null = null;
  private connectionReasonHandler: ((reason: WorkLouderCodexConnectionReason) => void) | null =
    null;
  private connectionStatusHandler: ((status: WorkLouderCodexConnectionStatus) => void) | null =
    null;
  private presenceHandler:
    | ((
        present: boolean,
        identity?: {
          deviceType: 'codex-micro' | 'creator-micro-2';
          isUsbConnection: boolean;
        },
      ) => void)
    | null = null;
  private connectionStatus: WorkLouderCodexConnectionStatus = 'connecting';
  private connectionReason: WorkLouderCodexConnectionReason = null;
  private wantsHidInput = false;
  private deviceEnabled = true;
  private wantsPresence = false;
  /** Permission failures are user-actionable; stop automatic recovery until an explicit retry or toggle. */
  private permissionBlocked = false;
  /** True while the current host is stopping so re-enable cannot talk to it. */
  private hostStopping = false;

  constructor(private readonly deps: WorkLouderCodexHostClientDeps) {}

  setAgentKeyPressHandler(handler: ((slot: number) => void) | null): void {
    this.agentKeyPressHandler = handler;
    this.updateHidListeningIntent();
  }

  setHidInputHandler(handler: ((event: WorkLouderCodexHidEvent) => void) | null): void {
    this.hidInputHandler = handler;
    this.updateHidListeningIntent();
  }

  setJoystickInputHandler(handler: ((event: WorkLouderCodexJoystickEvent) => void) | null): void {
    this.joystickInputHandler = handler;
    this.updateHidListeningIntent();
  }

  setDeviceStateHandler(handler: ((device: WorkLouderCodexDeviceState) => void) | null): void {
    this.deviceStateHandler = handler;
  }

  setConnectionReasonHandler(
    handler: ((reason: WorkLouderCodexConnectionReason) => void) | null,
  ): void {
    this.connectionReasonHandler = handler;
    handler?.(this.connectionReason);
  }

  setDeviceEnabled(enabled: boolean): void {
    if (this.deviceEnabled === enabled) return;
    this.deviceEnabled = enabled;
    this.permissionBlocked = false;
    if (enabled) {
      this.updateHidListeningIntent();
      if (this.latestFrame) this.update(this.latestFrame);
      return;
    }
    this.disconnectHost();
  }

  private updateHidListeningIntent(): void {
    this.wantsHidInput =
      this.deviceEnabled &&
      (this.agentKeyPressHandler !== null ||
        this.hidInputHandler !== null ||
        this.joystickInputHandler !== null);
    if (this.wantsHidInput) this.requestHidListening();
  }

  setDeviceActivityHandler(handler: (() => void) | null): void {
    this.deviceActivityHandler = handler;
  }

  setConnectionStatusHandler(
    handler: ((status: WorkLouderCodexConnectionStatus) => void) | null,
  ): void {
    this.connectionStatusHandler = handler;
    handler?.(this.connectionStatus);
  }

  setPresenceHandler(
    handler:
      | ((
          present: boolean,
          identity?: {
            deviceType: 'codex-micro' | 'creator-micro-2';
            isUsbConnection: boolean;
          },
        ) => void)
      | null,
  ): void {
    this.presenceHandler = handler;
  }

  update(frame: WorkLouderCodexLightingFrame): void {
    if (this.disposed) return;
    this.latestFrame = frame;
    if (!this.deviceEnabled) return;
    if (isWorkLouderCodexLightingFrameOff(frame) && this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    if (!this.child && isWorkLouderCodexLightingFrameOff(frame) && !this.wantsHidInput) return;
    const child = this.ensureChild();
    if (!child) return;
    const request: WorkLouderCodexHostRequest = { kind: 'apply', frame };
    try {
      child.postMessage(request);
    } catch (error) {
      this.deps.log.warn('failed to send lighting frame to host', {
        error: error instanceof Error ? error.message : String(error),
      });
      try {
        child.kill();
      } catch {
        // A failed message channel commonly means the child already exited.
      }
      this.handleExit(child, 1);
    }
  }

  dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    this.disposed = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    this.clearConnectWatchdog();
    const child = this.child;
    if (!child) return Promise.resolve();

    this.disposePromise = new Promise<void>((resolve) => {
      this.finishDispose = resolve;
      this.disposeTimer = setTimeout(
        () => this.completeDispose(child),
        this.deps.disposeTimeoutMs ?? 1_000,
      );
      this.disposeTimer.unref?.();
      const request: WorkLouderCodexHostRequest = { kind: 'stop' };
      try {
        child.postMessage(request);
      } catch {
        this.completeDispose(child);
      }
    });
    return this.disposePromise;
  }

  private ensureChild(): WorkLouderCodexChildLike | null {
    if (this.hostStopping) return null;
    // A scheduled recycle owns recovery; work/presence callers must not
    // recreate the host early and bypass its exponential backoff.
    if (this.restartTimer) return null;
    if (this.permissionBlocked) return null;
    if (this.isCrashBudgetExhausted()) return null;
    if (!this.deviceEnabled && !this.wantsPresence) return null;
    if (this.child) return this.child;
    const sdk = this.deps.resolveSdk();
    if (!sdk) {
      if (this.deviceEnabled) {
        this.updateConnectionReason('sdk-unavailable');
        this.updateConnectionStatus('unavailable');
      }
      if (!this.unavailableLogged) {
        this.unavailableLogged = true;
        this.deps.log.info('Codex Micro lighting unavailable: official Work Louder SDK not found');
      }
      return null;
    }
    let child: WorkLouderCodexChildLike | null = null;
    try {
      this.updateConnectionReason(null);
      if (this.deviceEnabled) this.updateConnectionStatus('connecting');
      const startedChild = this.deps.fork(sdk.entry);
      child = startedChild;
      this.child = startedChild;
      startedChild.on('message', (message) => this.handleMessage(startedChild, message));
      startedChild.on('exit', (code) => this.handleExit(startedChild, code));
      startedChild.on('error', (type) => {
        this.deps.log.warn('Codex Micro lighting host error', {
          type: type instanceof Error ? type.name : type,
        });
      });
      const initRequest: WorkLouderCodexHostRequest = { kind: 'init', sdkEntry: sdk.entry };
      startedChild.postMessage(initRequest);
      if (this.deviceEnabled) this.startConnectWatchdog(startedChild);
      this.deps.log.info('Codex Micro lighting host started', { sdkSource: sdk.source });
      return startedChild;
    } catch (error) {
      if (child) {
        try {
          child.kill();
        } catch {
          // Startup already failed; teardown is best effort.
        }
        if (this.child === child) this.child = null;
      }
      this.deps.log.warn('failed to start Codex Micro lighting host', {
        error: error instanceof Error ? error.message : String(error),
      });
      if (this.deviceEnabled) {
        this.updateConnectionReason('connection-failed');
        this.updateConnectionStatus('error');
        this.scheduleRestart();
      }
      return null;
    }
  }

  /**
   * Ask the host to re-check the device.
   *
   * Used while something is showing connection state: the SDK never reports a
   * disconnect, so an unplugged device otherwise keeps reading as connected
   * until the next lighting write.
   *
   * Reuses the running host only — probing must not spin one up on its own,
   * or merely opening settings would start the process on a machine that has
   * no such keyboard.
   */
  probe(): void {
    if (this.disposed || this.permissionBlocked) return;
    if (!this.deviceEnabled) {
      this.discoverPresence();
      return;
    }
    // A background probe is observational only. If the host is gone, either
    // the restart backoff or the crash budget owns recovery; do not recreate
    // it indirectly through requestHidListening/update.
    if (!this.child || this.restartTimer) return;
    try {
      const request: WorkLouderCodexHostRequest = { kind: 'probe' };
      this.child.postMessage(request);
    } catch (error) {
      this.deps.log.debug('failed to probe the Work Louder host', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Clear a permission breaker only for an explicit recovery signal.
   *
   * Background connection polling must stay observational: repeatedly
   * recreating a host while macOS still denies HID access is the restart storm
   * this client is designed to prevent. The settings toggle and system unlock
   * paths call this method when a permission change may have happened.
   */
  retryPermission(): void {
    if (this.disposed || !this.permissionBlocked) return;
    this.permissionBlocked = false;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    this.restartHost();
  }

  private requestHidListening(): void {
    if (this.disposed || !this.wantsHidInput) return;
    const child = this.ensureChild();
    if (!child) return;
    try {
      const request: WorkLouderCodexHostRequest = { kind: 'listen' };
      child.postMessage(request);
    } catch (error) {
      this.deps.log.warn('failed to start Work Louder HID listening', {
        error: error instanceof Error ? error.message : String(error),
      });
      try {
        child.kill();
      } catch {
        // A failed message channel commonly means the child already exited.
      }
      this.handleExit(child, 1);
    }
  }

  private handleMessage(child: WorkLouderCodexChildLike, message: unknown): void {
    if (this.child !== child || !isWorkLouderCodexHostMessage(message)) return;
    if (message.kind === 'stopped') {
      this.completeDispose(child);
      return;
    }
    if (message.kind === 'log') {
      this.deps.log[message.level](`[host] ${message.message}`);
      return;
    }
    if (message.kind === 'hid') {
      this.clearConnectWatchdog();
      this.hidInputHandler?.(message.event);
      const slot = parseWorkLouderCodexAgentKeyPress(message.event);
      if (slot !== null) {
        this.deps.log.debug('Codex Micro Agent key pressed', { slot });
        this.agentKeyPressHandler?.(slot);
      }
      return;
    }
    if (message.kind === 'joystick') {
      this.clearConnectWatchdog();
      this.joystickInputHandler?.(message.event);
      return;
    }
    if (message.kind === 'device') {
      this.clearConnectWatchdog();
      this.deviceStateHandler?.(message.device);
      return;
    }
    if (message.kind === 'presence') {
      this.clearConnectWatchdog();
      this.armStableConnection();
      this.presenceHandler?.(
        message.present,
        message.present && message.deviceType
          ? {
              deviceType: message.deviceType,
              isUsbConnection: message.isUsbConnection === true,
            }
          : undefined,
      );
      return;
    }
    if (message.kind === 'activity') {
      this.deviceActivityHandler?.();
      return;
    }
    if (message.kind !== 'state') return;
    this.clearConnectWatchdog();
    if (this.permissionBlocked && message.status === 'connected') return;
    this.updateConnectionReason(message.reason ?? null);
    const permissionRequired =
      message.status === 'error' && message.reason === 'permission-required';
    if (permissionRequired) this.permissionBlocked = true;
    const previousStatus = this.lastStatus;
    const statusChanged = message.status !== this.lastStatus;
    if (statusChanged) {
      this.lastStatus = message.status;
      this.updateConnectionStatus(message.status);
    }
    // Permission errors own teardown even when a previous connection error
    // already published the same coarse `error` status. The breaker must not
    // leave a permission-blocked child alive and unable to honor retry.
    if (permissionRequired) {
      this.stopHostAfterPermission(child);
      return;
    }
    if (!statusChanged) return;
    if (message.status === 'connected') {
      this.armStableConnection();
      this.deps.log.info('Codex Micro lighting connected');
      return;
    }
    if (message.status === 'not-detected') {
      this.deps.log.debug('Codex Micro lighting device not detected');
    } else {
      this.deps.log.warn('Codex Micro lighting host could not apply the current frame');
    }
    // Pairing / USB re-enumeration leaves the native SDK handle alive but
    // unusable. ChatGPT recovers by opening a fresh transport; we do the same
    // by recycling the utility process once the live session drops.
    if (previousStatus === 'connected') this.recycleStaleHost(child);
  }

  private stopHostAfterPermission(child: WorkLouderCodexChildLike): void {
    if (this.disposed || this.child !== child) return;
    this.clearConnectWatchdog();
    this.clearStableConnection();
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    this.deps.log.warn(
      'Codex Micro lighting paused because HID permission is required; retry after permission changes',
    );
    try {
      child.kill();
    } catch {
      // Permission failure owns the stop; the host may already have exited.
    }
    this.handleExit(child, 0);
  }

  private recycleStaleHost(child: WorkLouderCodexChildLike): void {
    if (this.disposed || this.recyclingChild || this.child !== child) return;
    this.recyclingChild = true;
    this.clearConnectWatchdog();
    this.clearStableConnection();
    this.deps.log.info('Codex Micro lighting host recycled after the device dropped');
    try {
      child.kill();
    } catch {
      // Recycle owns recovery even if the native host already disappeared.
    }
    this.handleExit(child, 0);
  }

  private handleExit(child: WorkLouderCodexChildLike, code: number): void {
    if (this.child !== child) return;
    const recycled = this.recyclingChild;
    this.recyclingChild = false;
    this.clearConnectWatchdog();
    this.clearStableConnection();
    this.child = null;
    this.hostStopping = false;
    this.lastStatus = null;
    if (this.disposed) {
      this.completeDispose(child);
      return;
    }
    if (!this.deviceEnabled) {
      this.updateConnectionReason(null);
      this.updateConnectionStatus('disabled');
      if (this.wantsPresence) this.scheduleRestart();
      return;
    }
    if (this.permissionBlocked) {
      this.updateConnectionReason('permission-required');
      this.updateConnectionStatus('error');
      return;
    }
    if (recycled) {
      this.scheduleRestart();
      return;
    }
    this.deps.log.warn('Codex Micro lighting host exited', { code });
    if (this.connectionReason !== 'connection-timeout') {
      this.updateConnectionReason('connection-failed');
    }
    this.updateConnectionStatus('error');
    this.scheduleRestart();
  }

  private restartHost(): void {
    if (this.disposed || !this.deviceEnabled) return;
    if (this.wantsHidInput) this.requestHidListening();
    if (this.latestFrame) this.update(this.latestFrame);
  }

  private scheduleRestart(): void {
    if (this.restartTimer || this.permissionBlocked || !this.shouldRestartHost()) return;
    this.consecutiveCrashes += 1;
    if (this.isCrashBudgetExhausted()) {
      this.deps.log.error('Codex Micro lighting host repeatedly crashed; disabled until restart');
      return;
    }
    const delayMs = Math.min(10_000, 500 * 2 ** (this.consecutiveCrashes - 1));
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (this.disposed || !this.shouldRestartHost()) return;
      if (!this.deviceEnabled) {
        this.discoverPresence();
        return;
      }
      if (this.wantsHidInput) this.requestHidListening();
      if (this.latestFrame) this.update(this.latestFrame);
    }, delayMs);
    this.restartTimer.unref?.();
  }

  private isCrashBudgetExhausted(): boolean {
    return this.consecutiveCrashes > MAX_CONSECUTIVE_CRASHES;
  }

  private shouldRestartHost(): boolean {
    if (this.disposed) return false;
    if (!this.deviceEnabled) return this.wantsPresence;
    return (
      this.wantsHidInput ||
      Boolean(this.latestFrame && !isWorkLouderCodexLightingFrameOff(this.latestFrame))
    );
  }

  private startConnectWatchdog(child: WorkLouderCodexChildLike): void {
    this.clearConnectWatchdog();
    this.connectWatchdogTimer = setTimeout(() => {
      this.connectWatchdogTimer = null;
      if (this.child !== child || this.disposed) return;
      this.deps.log.warn('Codex Micro lighting host connection timed out');
      this.updateConnectionReason('connection-timeout');
      this.updateConnectionStatus('error');
      try {
        child.kill();
      } catch {
        // The watchdog owns recovery even if the native host already disappeared.
      }
      this.handleExit(child, 1);
    }, this.deps.connectTimeoutMs ?? 5_000);
    this.connectWatchdogTimer.unref?.();
  }

  private clearConnectWatchdog(): void {
    if (!this.connectWatchdogTimer) return;
    clearTimeout(this.connectWatchdogTimer);
    this.connectWatchdogTimer = null;
  }

  private armStableConnection(): void {
    if (this.stableConnectionTimer) return;
    this.stableConnectionTimer = setTimeout(() => {
      this.stableConnectionTimer = null;
      this.consecutiveCrashes = 0;
    }, this.deps.stableConnectionMs ?? 10_000);
    this.stableConnectionTimer.unref?.();
  }

  private clearStableConnection(): void {
    if (!this.stableConnectionTimer) return;
    clearTimeout(this.stableConnectionTimer);
    this.stableConnectionTimer = null;
  }

  private completeDispose(child: WorkLouderCodexChildLike): void {
    this.clearConnectWatchdog();
    this.clearStableConnection();
    if (this.disposeTimer) {
      clearTimeout(this.disposeTimer);
      this.disposeTimer = null;
    }
    if (this.disconnectTimer) {
      clearTimeout(this.disconnectTimer);
      this.disconnectTimer = null;
    }
    const owned = this.child === child;
    if (owned) {
      try {
        child.kill();
      } catch {
        // The utility process may already have exited after acknowledging stop.
      }
      this.child = null;
      this.hostStopping = false;
    }
    const finish = this.finishDispose;
    this.finishDispose = null;
    finish?.();
    if (this.disposed || !owned || this.child) return;
    if (this.deviceEnabled) this.restartHost();
    else if (this.wantsPresence) this.discoverPresence();
  }

  private updateConnectionStatus(status: WorkLouderCodexConnectionStatus): void {
    if (status === this.connectionStatus) return;
    this.connectionStatus = status;
    this.connectionStatusHandler?.(status);
  }

  private updateConnectionReason(reason: WorkLouderCodexConnectionReason): void {
    if (reason === this.connectionReason) return;
    this.connectionReason = reason;
    this.connectionReasonHandler?.(reason);
  }

  private disconnectHost(): void {
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    this.clearConnectWatchdog();
    this.clearStableConnection();
    const child = this.child;
    if (child) {
      this.hostStopping = true;
      if (this.disconnectTimer) {
        clearTimeout(this.disconnectTimer);
        this.disconnectTimer = null;
      }
      this.disconnectTimer = setTimeout(
        () => this.completeDispose(child),
        this.deps.disposeTimeoutMs ?? 1_000,
      );
      this.disconnectTimer.unref?.();
      try {
        child.postMessage({ kind: 'stop' } satisfies WorkLouderCodexHostRequest);
      } catch {
        this.completeDispose(child);
      }
    }
    this.lastStatus = null;
    this.consecutiveCrashes = 0;
    this.permissionBlocked = false;
    this.updateConnectionReason(null);
    this.updateConnectionStatus('disabled');
  }

  private discoverPresence(): void {
    this.wantsPresence = true;
    const child = this.ensureChild();
    if (!child) return;
    try {
      const request: WorkLouderCodexHostRequest = { kind: 'discover' };
      child.postMessage(request);
    } catch (error) {
      this.deps.log.debug('failed to discover Work Louder presence', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
