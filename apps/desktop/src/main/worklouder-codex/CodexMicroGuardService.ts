import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { app } from 'electron';

import type { CodexMicroGuardState } from '../../shared/codexMicroGuard.js';
import { desktopMakerLogger } from '../maker-host/logger-adapter.js';
import {
  CodexMicroGuardManager,
  CodexMicroGuardStore,
  LaunchctlGuardCommandRunner,
  type GuardCommandRunner,
} from './codexMicroGuardCore.js';

interface CodexMicroGuardServiceOptions {
  platform?: NodeJS.Platform;
  supportPath?: string;
  launchctlDomain?: string;
  runner?: GuardCommandRunner;
  environment?: NodeJS.ProcessEnv;
}

const log = desktopMakerLogger.child('codex-micro-guard');

/**
 * Cleanup-only while Codex protection is suspended (#5985). Legacy preferences
 * stay on disk, but neither startup nor IPC can reactivate global injection.
 */
export class CodexMicroGuardService {
  private readonly platform: NodeJS.Platform;
  private readonly manager: CodexMicroGuardManager;
  private readonly listeners = new Set<(state: CodexMicroGuardState) => void>();
  private initializePromise: Promise<void> | null = null;
  private mutation: Promise<void> = Promise.resolve();
  private recoveryRequired = false;
  private disposed = false;

  constructor(options: CodexMicroGuardServiceOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.manager = new CodexMicroGuardManager(
      new CodexMicroGuardStore(options.supportPath ?? defaultSupportPath()),
      options.runner ?? new LaunchctlGuardCommandRunner(),
      options.launchctlDomain ??
        (this.platform === 'darwin' ? `gui/${currentUid()}` : 'gui/unsupported'),
      options.environment ?? process.env,
    );
  }

  initialize(): Promise<void> {
    if (!this.initializePromise) {
      this.initializePromise =
        this.platform === 'darwin' ? this.cleanup().catch(() => undefined) : Promise.resolve();
    }
    return this.initializePromise;
  }

  async getState(): Promise<CodexMicroGuardState> {
    await this.initialize();
    await this.mutation;
    return this.snapshot();
  }

  // Keep the existing IPC contract, including stale renderer requests, without
  // interpreting any preference as permission to resume the retired injection.
  async setEnabled(enabled: boolean): Promise<CodexMicroGuardState> {
    return enabled ? this.getState() : this.recover();
  }

  async recover(): Promise<CodexMicroGuardState> {
    await this.initialize();
    if (this.platform !== 'darwin') return this.snapshot();
    const next = this.mutation.then(async () => {
      if (this.disposed) throw new Error('Codex Micro guard service is disposed');
      await this.cleanup();
    });
    this.mutation = next.catch(() => undefined);
    await next;
    return this.snapshot();
  }

  subscribe(listener: (state: CodexMicroGuardState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async dispose(): Promise<void> {
    await this.initialize();
    await this.mutation;
    if (this.disposed) return;
    this.disposed = true;
    // Retry incomplete restoration on a normal exit as well as on next startup.
    if (this.platform === 'darwin') {
      await this.cleanup().catch(() => undefined);
    }
    this.listeners.clear();
  }

  private async cleanup(): Promise<void> {
    try {
      await this.manager.recover();
      this.recoveryRequired = false;
    } catch (error) {
      this.recoveryRequired = true;
      log.warn('Codex Micro guard legacy environment recovery failed');
      throw error;
    } finally {
      const state = this.snapshot();
      for (const listener of this.listeners) listener(state);
    }
  }

  private snapshot(): CodexMicroGuardState {
    if (this.platform !== 'darwin') {
      return { supported: false, enabled: false, status: 'unsupported' };
    }
    return {
      supported: true,
      enabled: false,
      status: this.recoveryRequired ? 'recovery-required' : 'paused',
      restartRequired: false,
    };
  }
}

function defaultSupportPath(): string {
  const identity = crypto
    .createHash('sha256')
    .update(app.getPath('userData'))
    .digest('hex')
    .slice(0, 12);
  return path.join(os.homedir(), 'Library', 'CindyCodexMicroGuard', identity);
}

function currentUid(): number {
  if (typeof process.getuid !== 'function') throw new Error('macOS user id is unavailable');
  return process.getuid();
}
