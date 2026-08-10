import {
  isWorkLouderCodexHostMessage,
  isWorkLouderCodexLightingFrameOff,
  type WorkLouderCodexHostRequest,
  type WorkLouderCodexLightingFrame,
} from './protocol.js';
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
  private consecutiveCrashes = 0;
  private lastStatus: 'connected' | 'not-detected' | 'error' | null = null;
  private disposed = false;
  private unavailableLogged = false;
  private disposePromise: Promise<void> | null = null;
  private finishDispose: (() => void) | null = null;
  private disposeTimer: ReturnType<typeof setTimeout> | null = null;
  private agentKeyPressHandler: ((slot: number) => void) | null = null;

  constructor(private readonly deps: WorkLouderCodexHostClientDeps) {}

  setAgentKeyPressHandler(handler: ((slot: number) => void) | null): void {
    this.agentKeyPressHandler = handler;
  }

  update(frame: WorkLouderCodexLightingFrame): void {
    if (this.disposed) return;
    this.latestFrame = frame;
    if (isWorkLouderCodexLightingFrameOff(frame) && this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    if (!this.child && isWorkLouderCodexLightingFrameOff(frame)) return;
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
      if (!this.unavailableLogged) {
        this.unavailableLogged = true;
        this.deps.log.info('Codex Micro lighting unavailable: official Work Louder SDK not found');
      }
      return null;
    }
    let child: WorkLouderCodexChildLike | null = null;
    try {
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
      this.scheduleRestart();
      return null;
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
    if (message.kind === 'agent-key') {
      this.agentKeyPressHandler?.(message.slot);
      return;
    }
    if (message.status === this.lastStatus) return;
    this.lastStatus = message.status;
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
    this.child = null;
    this.lastStatus = null;
    if (this.disposed) {
      this.completeDispose(child);
      return;
    }
    this.deps.log.warn('Codex Micro lighting host exited', { code });
    this.scheduleRestart();
  }

  private scheduleRestart(): void {
    if (
      this.restartTimer ||
      !this.latestFrame ||
      isWorkLouderCodexLightingFrameOff(this.latestFrame)
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
      if (frame && !this.disposed) this.update(frame);
    }, delayMs);
    this.restartTimer.unref?.();
  }

  private completeDispose(child: WorkLouderCodexChildLike): void {
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
}
