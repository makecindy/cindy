import {
  comboToElectronAccelerator,
} from '../../shared/appShortcuts.js';
import {
  isDualModifierSnapshot,
  type AppshotShortcut,
  type AppshotShortcutPreferences,
} from '../../shared/appshots.js';
import { AppshotShortcutStore } from './shortcutStore.js';

export type AppshotShortcutFallbackReason =
  | 'codex-running'
  | 'registration-conflict'
  | 'input-monitoring';

export interface AppshotShortcutState {
  preferences: AppshotShortcutPreferences;
  configured: AppshotShortcut;
  active: AppshotShortcut | null;
  fallbackReason?: AppshotShortcutFallbackReason;
}

export interface AppshotShortcutServiceDeps {
  store: AppshotShortcutStore;
  globalShortcut: {
    register(accelerator: string, callback: () => void): boolean;
    unregister(accelerator: string): void;
  };
  retainMacModifierKeySnapshots: (
    owner: string,
    subscriber: (keys: readonly string[]) => void,
  ) => Promise<() => void>;
  capture: () => Promise<unknown>;
  getRunningBundleIds: () => ReadonlySet<string>;
  onStateChanged?: (state: AppshotShortcutState) => void;
  onCaptureFailure?: (code: 'capture-failed') => void;
  platform?: NodeJS.Platform;
}

function copyShortcut(shortcut: AppshotShortcut): AppshotShortcut {
  return shortcut.kind === 'dual-modifier'
    ? { ...shortcut }
    : { kind: 'accelerator', combo: { ...shortcut.combo } };
}

function copyState(state: AppshotShortcutState): AppshotShortcutState {
  return {
    preferences: { preferred: copyShortcut(state.preferences.preferred), fallback: copyShortcut(state.preferences.fallback) },
    configured: copyShortcut(state.configured),
    active: state.active ? copyShortcut(state.active) : null,
    ...(state.fallbackReason ? { fallbackReason: state.fallbackReason } : {}),
  };
}

/** Registers the one effective Appshot shortcut and swaps to the fallback for Codex conflicts. */
export class AppshotShortcutService {
  private started = false;
  private generation = 0;
  private registeredAccelerator: string | null = null;
  private releaseNativeSnapshots: (() => void) | null = null;
  private dualModifierPressed = false;
  private currentState: AppshotShortcutState;

  constructor(private readonly deps: AppshotShortcutServiceDeps) {
    const preferences = deps.store.get();
    this.currentState = { preferences, configured: preferences.preferred, active: null };
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    await this.reconcile(++this.generation);
  }

  stop(): void {
    this.generation += 1;
    this.started = false;
    this.deactivate();
    this.currentState = { ...this.currentState, active: null };
    this.publish();
  }

  state(): AppshotShortcutState {
    return copyState(this.currentState);
  }

  async setPreferences(value: unknown): Promise<AppshotShortcutState> {
    const preferences = this.deps.store.set(value);
    const operation = ++this.generation;
    this.deactivate();
    this.currentState = { preferences, configured: preferences.preferred, active: null };
    if (this.started) await this.reconcile(operation, preferences);
    else this.publish();
    return this.state();
  }

  async reset(): Promise<AppshotShortcutState> {
    const preferences = this.deps.store.reset();
    const operation = ++this.generation;
    this.deactivate();
    this.currentState = { preferences, configured: preferences.preferred, active: null };
    if (this.started) await this.reconcile(operation, preferences);
    else this.publish();
    return this.state();
  }

  async refreshConflicts(): Promise<void> {
    if (!this.started) return;
    await this.reconcile(++this.generation);
  }

  private async reconcile(
    operation: number,
    suppliedPreferences?: AppshotShortcutPreferences,
  ): Promise<void> {
    if (!this.isCurrent(operation)) return;
    this.deactivate();
    const preferences = suppliedPreferences ?? this.deps.store.get();
    const codexRunning = preferences.preferred.kind === 'dual-modifier'
      && this.deps.getRunningBundleIds().has('com.openai.codex');
    const primary = codexRunning ? preferences.fallback : preferences.preferred;
    const primaryActivation = await this.activate(primary);
    if (!this.isCurrent(operation)) {
      primaryActivation?.release();
      return;
    }
    if (primaryActivation) {
      this.install(primaryActivation);
      this.currentState = {
        preferences,
        configured: preferences.preferred,
        active: primary,
        ...(codexRunning ? { fallbackReason: 'codex-running' as const } : {}),
      };
      this.publish();
      return;
    }

    const fallbackReason: AppshotShortcutFallbackReason = primary.kind === 'dual-modifier'
      ? 'input-monitoring'
      : 'registration-conflict';
    const fallbackActivation = !codexRunning && primary !== preferences.fallback
      ? await this.activate(preferences.fallback)
      : null;
    if (!this.isCurrent(operation)) {
      fallbackActivation?.release();
      return;
    }
    if (fallbackActivation) {
      this.install(fallbackActivation);
      this.currentState = {
        preferences,
        configured: preferences.preferred,
        active: preferences.fallback,
        fallbackReason,
      };
    } else {
      this.currentState = {
        preferences,
        configured: preferences.preferred,
        active: null,
        fallbackReason: codexRunning ? 'codex-running' : fallbackReason,
      };
    }
    this.publish();
  }

  private isCurrent(operation: number): boolean {
    return this.started && operation === this.generation;
  }

  private async activate(shortcut: AppshotShortcut): Promise<{ release: () => void; accelerator?: string } | null> {
    if (shortcut.kind === 'dual-modifier') {
      if ((this.deps.platform ?? process.platform) !== 'darwin') return null;
      try {
        const release = await this.deps.retainMacModifierKeySnapshots(
          'appshots-shortcut-service',
          (keys) => this.handleNativeKeys(shortcut, keys),
        );
        return { release };
      } catch {
        return null;
      }
    }
    const accelerator = comboToElectronAccelerator(shortcut.combo, this.deps.platform ?? process.platform);
    if (!accelerator || !this.deps.globalShortcut.register(accelerator, () => this.capture())) return null;
    return {
      accelerator,
      release: () => this.deps.globalShortcut.unregister(accelerator),
    };
  }

  private install(activation: { release: () => void; accelerator?: string }): void {
    if (activation.accelerator) this.registeredAccelerator = activation.accelerator;
    else this.releaseNativeSnapshots = activation.release;
  }

  private deactivate(): void {
    if (this.registeredAccelerator) this.deps.globalShortcut.unregister(this.registeredAccelerator);
    this.registeredAccelerator = null;
    this.releaseNativeSnapshots?.();
    this.releaseNativeSnapshots = null;
    this.dualModifierPressed = false;
  }

  private handleNativeKeys(shortcut: Extract<AppshotShortcut, { kind: 'dual-modifier' }>, keys: readonly string[]): void {
    const matching = isDualModifierSnapshot(keys, shortcut.modifier);
    if (matching && !this.dualModifierPressed) this.capture();
    this.dualModifierPressed = matching;
  }

  private capture(): void {
    void this.deps.capture().catch(() => this.deps.onCaptureFailure?.('capture-failed'));
  }

  private publish(): void {
    this.deps.onStateChanged?.(this.state());
  }
}
