import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { app } from 'electron';

import type { CodexMicroGuardState } from '../../shared/codexMicroGuard.js';
import { desktopMakerLogger } from '../maker-host/logger-adapter.js';
import {
  createOverrideSettingsFile,
  type OverrideSettingsFile,
} from '../maker-host/override-settings-file.js';
import hookContents from './codexMicroGuardHook.cjs?raw';
import {
  listCodexMicroGuardProcesses,
  type CodexMicroGuardProcess,
} from './codexMicroGuardProcesses.js';
import {
  CodexMicroGuardManager,
  CodexMicroGuardStore,
  LaunchctlGuardCommandRunner,
  type GuardCommandRunner,
} from './codexMicroGuardCore.js';

interface CodexMicroGuardSettings {
  enabled: boolean;
}

interface CodexMicroGuardServiceOptions {
  platform?: NodeJS.Platform;
  supportPath?: string;
  settingsPath?: string;
  launchctlDomain?: string;
  runner?: GuardCommandRunner;
  hookContents?: string;
  heartbeatIntervalMs?: number;
  listProcesses?: () => Promise<CodexMicroGuardProcess[]>;
}

const log = desktopMakerLogger.child('codex-micro-guard');
const DEFAULT_SETTINGS: CodexMicroGuardSettings = { enabled: false };
const MAX_SETTINGS_BYTES = 8 * 1024;
const HEARTBEAT_INTERVAL_MS = 5_000;

export class CodexMicroGuardService {
  private readonly platform: NodeJS.Platform;
  private readonly store: CodexMicroGuardStore;
  private readonly manager: CodexMicroGuardManager;
  private readonly settingsStore: OverrideSettingsFile<CodexMicroGuardSettings>;
  private readonly hookContents: string;
  private readonly heartbeatIntervalMs: number;
  private readonly listeners = new Set<(state: CodexMicroGuardState) => void>();
  private initializePromise: Promise<void> | null = null;
  private mutation: Promise<void> = Promise.resolve();
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private active = false;
  private failed = false;
  private recoveryRequired = false;
  private disposed = false;
  private lastEmittedState: string | null = null;
  private readonly listProcesses: () => Promise<CodexMicroGuardProcess[]>;
  private restartProcesses: CodexMicroGuardProcess[] = [];

  constructor(options: CodexMicroGuardServiceOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.listProcesses = options.listProcesses ?? listCodexMicroGuardProcesses;
    const supportPath = options.supportPath ?? defaultSupportPath();
    this.store = new CodexMicroGuardStore(supportPath);
    this.manager = new CodexMicroGuardManager(
      this.store,
      options.runner ?? new LaunchctlGuardCommandRunner(),
      options.launchctlDomain ??
        (this.platform === 'darwin' ? `gui/${currentUid()}` : 'gui/unsupported'),
      crypto.randomUUID(),
    );
    this.hookContents = options.hookContents ?? hookContents;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS;
    const settingsPath =
      options.settingsPath ?? path.join(app.getPath('userData'), 'codex-micro-guard.json');
    this.settingsStore = createOverrideSettingsFile<CodexMicroGuardSettings>({
      filePath: () => settingsPath,
      defaults: DEFAULT_SETTINGS,
      normalize: normalizeSettings,
      log,
      label: 'Codex Micro guard',
      maxBytes: MAX_SETTINGS_BYTES,
      preserveUnreadableFile: true,
      logLoadedValue: false,
      logReadErrorDetails: false,
    });
  }

  initialize(): Promise<void> {
    if (!this.initializePromise) this.initializePromise = this.initializeInternal();
    return this.initializePromise;
  }

  async getState(): Promise<CodexMicroGuardState> {
    await this.initialize();
    await this.enqueue(() => this.refreshRestartRequired());
    return this.snapshot();
  }

  async setEnabled(enabled: boolean): Promise<CodexMicroGuardState> {
    await this.initialize();
    if (this.platform !== 'darwin') return this.snapshot();
    await this.enqueue(async () => {
      if (this.disposed) throw new Error('Codex Micro guard service is disposed');
      if (enabled) await this.enable();
      else await this.disable({ persistSetting: true });
    });
    return this.snapshot();
  }

  async recover(): Promise<CodexMicroGuardState> {
    await this.initialize();
    if (this.platform !== 'darwin') return this.snapshot();
    await this.enqueue(async () => {
      if (this.disposed) throw new Error('Codex Micro guard service is disposed');
      this.settingsStore.writePatch({ enabled: false });
      this.stopHeartbeat();
      this.active = false;
      this.restartProcesses = [];
      await this.manager.disable();
      this.failed = false;
      this.recoveryRequired = false;
      this.emitIfChanged();
    });
    return this.snapshot();
  }

  subscribe(listener: (state: CodexMicroGuardState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async dispose(): Promise<void> {
    await this.initialize();
    await this.enqueue(async () => {
      if (this.disposed) return;
      this.disposed = true;
      this.stopHeartbeat();
      this.restartProcesses = [];
      if (this.platform !== 'darwin') return;
      try {
        if (this.active || this.hasRecoveryState()) await this.manager.disable();
        this.active = false;
        this.recoveryRequired = false;
      } catch {
        this.active = false;
        this.recoveryRequired = true;
        log.warn('Codex Micro guard shutdown recovery failed');
      }
    });
    this.listeners.clear();
  }

  private async initializeInternal(): Promise<void> {
    if (this.platform !== 'darwin') return;
    const enabled = this.settingsStore.read().enabled;
    try {
      if (enabled) {
        await this.manager.enable(this.hookContents);
        // Restart hints belong only to an explicit toggle, not startup recovery.
        this.active = true;
        this.startHeartbeat();
      } else if (this.hasRecoveryState()) {
        // A previous Cindy process stopped during restoration. The hook is
        // already fail-open once its heartbeat expires; finish restoring the
        // launch environment before exposing the disabled state.
        await this.manager.disable();
      }
      this.failed = false;
      this.recoveryRequired = false;
    } catch {
      this.active = false;
      this.failed = true;
      this.recoveryRequired = this.hasRecoveryState();
      log.warn('Codex Micro guard initialization failed');
    }
    this.emitIfChanged();
  }

  private async enable(): Promise<void> {
    if (this.active && this.store.isFresh()) return;
    this.failed = false;
    this.recoveryRequired = false;
    let processes: CodexMicroGuardProcess[] = [];
    try {
      processes = await this.listProcesses();
    } catch {
      // Process detection is only a hint; it must not fail protection activation.
    }
    await this.manager.enable(this.hookContents);
    try {
      this.settingsStore.writePatch({ enabled: true });
    } catch (error) {
      try {
        await this.manager.disable();
      } catch {
        this.recoveryRequired = true;
      }
      throw error;
    }
    this.active = true;
    this.restartProcesses = processes;
    this.startHeartbeat();
    this.emitIfChanged();
  }

  private async disable(options: { persistSetting: boolean }): Promise<void> {
    if (options.persistSetting) this.settingsStore.writePatch({ enabled: false });
    this.stopHeartbeat();
    this.active = false;
    this.restartProcesses = [];
    try {
      await this.manager.disable();
      this.failed = false;
      this.recoveryRequired = false;
    } catch (error) {
      this.failed = true;
      this.recoveryRequired = true;
      this.emitIfChanged();
      throw error;
    }
    this.emitIfChanged();
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      void this.enqueue(async () => {
        if (!this.active || this.disposed) return;
        try {
          await this.manager.refreshHeartbeat();
        } catch {
          this.stopHeartbeat();
          this.active = false;
          this.failed = true;
          try {
            await this.manager.disable();
            this.recoveryRequired = false;
          } catch {
            this.recoveryRequired = true;
          }
          log.warn('Codex Micro guard heartbeat failed and protection was stopped');
        }
        await this.refreshRestartRequired();
        this.emitIfChanged();
      });
    }, this.heartbeatIntervalMs);
    this.heartbeatTimer.unref?.();
  }

  private stopHeartbeat(): void {
    if (!this.heartbeatTimer) return;
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  private hasRecoveryState(): boolean {
    try {
      return this.store.readState() !== null;
    } catch {
      return true;
    }
  }

  private async refreshRestartRequired(): Promise<void> {
    if (!this.active || this.disposed) {
      this.restartProcesses = [];
      return;
    }
    if (this.restartProcesses.length === 0) return;
    try {
      const processes = await this.listProcesses();
      // Only keep processes observed at activation. A later launch cannot
      // bring the hint back, even if the OS reuses the same PID.
      this.restartProcesses = this.restartProcesses.filter((previous) =>
        processes.some(
          (current) =>
            current.pid === previous.pid &&
            current.startedAt === previous.startedAt &&
            current.executable === previous.executable,
        ),
      );
    } catch {
      this.restartProcesses = [];
    }
  }

  private snapshot(): CodexMicroGuardState {
    if (this.platform !== 'darwin') {
      return { supported: false, enabled: false, status: 'unsupported' };
    }
    const enabled = this.settingsStore.read().enabled;
    let status: CodexMicroGuardState['status'];
    if (this.recoveryRequired) status = 'recovery-required';
    else if (this.failed) status = 'error';
    else if (!this.active || !this.store.isFresh()) status = 'disabled';
    else status = this.store.hasInterceptionReceipt() ? 'intercepted' : 'protecting';
    return {
      supported: true,
      enabled,
      status,
      restartRequired:
        (status === 'protecting' || status === 'intercepted') && this.restartProcesses.length > 0,
    };
  }

  private emitIfChanged(): void {
    const state = this.snapshot();
    const serialized = JSON.stringify(state);
    if (serialized === this.lastEmittedState) return;
    this.lastEmittedState = serialized;
    for (const listener of this.listeners) listener(state);
  }

  private async enqueue(operation: () => Promise<void>): Promise<void> {
    const next = this.mutation.then(operation, operation);
    this.mutation = next.catch(() => undefined);
    await next;
  }
}

function normalizeSettings(raw: unknown): CodexMicroGuardSettings {
  const enabled =
    raw && typeof raw === 'object' ? (raw as { enabled?: unknown }).enabled : undefined;
  return { enabled: typeof enabled === 'boolean' ? enabled : DEFAULT_SETTINGS.enabled };
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

export const __testing = { normalizeSettings, defaultSupportPath };
