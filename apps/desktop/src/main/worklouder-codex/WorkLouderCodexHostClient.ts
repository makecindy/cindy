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
  private lastStatus: 'connected' | 'not-detected' | 'error' | null = null;
  private disposed = false;
  private unavailableLogged = false;
  private disposePromise: Promise<void> | null = null;
  private finishDispose: (() => void) | null = null;
  private disposeTimer: ReturnType<typeof setTimeout> | null = null;
  private agentKeyPressHandler: ((slot: number) => void) | null = null;
  private deviceActivityHandler: (() => void) | null = null;
  private hidInputHandler: ((event: WorkLouderCodexHidEvent) => void) | null = null;
  private joystickInputHandler: ((event: WorkLouderCodexJoystickEvent) => void) | null = null;
  private deviceStateHandler: ((device: WorkLouderCodexDeviceState) => void) | null = null;
  private connectionReasonHandler: ((reason: WorkLouderCodexConnectionReason) => void) | null =
    null;
  private connectionStatusHandler: ((status: WorkLouderCodexConnectionStatus) => void) | null =
    null;
  private connectionStatus: WorkLouderCodexConnectionStatus = 'connecting';
  private connectionReason: WorkLouderCodexConnectionReason = null;
  private wantsHidInput = false;

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

  private updateHidListeningIntent(): void {
    this.wantsHidInput =
      this.agentKeyPressHandler !== null ||
      this.hidInputHandler !== null ||
      this.joystickInputHandler !== null;
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

  update(frame: WorkLouderCodexLightingFrame): void {
    if (this.disposed) return;
    this.latestFrame = frame;
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
    if (this.child) return this.child;
    const sdk = this.deps.resolveSdk();
    if (!sdk) {
      this.updateConnectionReason('sdk-unavailable');
      this.updateConnectionStatus('unavailable');
      if (!this.unavailableLogged) {
        this.unavailableLogged = true;
        this.deps.log.info('Codex Micro lighting unavailable: official Work Louder SDK not found');
      }
      return null;
    }
    let child: WorkLouderCodexChildLike | null = null;
    try {
      this.updateConnectionReason(null);
      this.updateConnectionStatus('connecting');
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
      this.startConnectWatchdog(startedChild);
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
      this.updateConnectionReason('connection-failed');
      this.updateConnectionStatus('error');
      this.scheduleRestart();
      return null;
    }
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
    if (message.kind === 'activity') {
      this.deviceActivityHandler?.();
      return;
    }
    if (message.kind !== 'state') return;
    this.clearConnectWatchdog();
    this.updateConnectionReason(message.reason ?? null);
    if (message.status === this.lastStatus) return;
    this.lastStatus = message.status;
    this.updateConnectionStatus(message.status);
    if (message.status === 'connected') {
      this.consecutiveCrashes = 0;
      this.deps.log.info('Codex Micro lighting connected');
    } else if (message.status === 'not-detected') {
      this.deps.log.debug('Codex Micro lighting device not detected');
    } else {
      this.deps.log.warn('Codex Micro lighting host could not apply the current frame');
    }
  }

  private handleExit(child: WorkLouderCodexChildLike, code: number): void {
    if (this.child !== child) return;
    this.clearConnectWatchdog();
    this.child = null;
    this.lastStatus = null;
    if (this.disposed) {
      this.completeDispose(child);
      return;
    }
    this.deps.log.warn('Codex Micro lighting host exited', { code });
    if (this.connectionReason !== 'connection-timeout') {
      this.updateConnectionReason('connection-failed');
    }
    this.updateConnectionStatus('error');
    this.scheduleRestart();
  }

  private scheduleRestart(): void {
    if (
      this.restartTimer ||
      (!this.latestFrame && !this.wantsHidInput) ||
      (this.latestFrame &&
        isWorkLouderCodexLightingFrameOff(this.latestFrame) &&
        !this.wantsHidInput)
    ) {
      return;
    }
    this.consecutiveCrashes += 1;
    if (this.consecutiveCrashes > 5) {
      this.deps.log.error('Codex Micro lighting host repeatedly crashed; disabled until restart');
      return;
    }
    const delayMs = Math.min(10_000, 500 * 2 ** (this.consecutiveCrashes - 1));
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      const frame = this.latestFrame;
      if (this.disposed) return;
      if (this.wantsHidInput) this.requestHidListening();
      if (frame) this.update(frame);
    }, delayMs);
    this.restartTimer.unref?.();
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

  private completeDispose(child: WorkLouderCodexChildLike): void {
    this.clearConnectWatchdog();
    if (this.disposeTimer) {
      clearTimeout(this.disposeTimer);
      this.disposeTimer = null;
    }
    if (this.child === child) {
      try {
        child.kill();
      } catch {
        // The utility process may already have exited after acknowledging stop.
      }
      this.child = null;
    }
    const finish = this.finishDispose;
    this.finishDispose = null;
    finish?.();
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
}
