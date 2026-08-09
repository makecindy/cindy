import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_APPSHOT_SHORTCUT_PREFERENCES,
  type AppshotShortcutPreferences,
} from '../../../shared/appshots.js';
import {
  AppshotShortcutStore,
  createAppshotShortcutStore,
} from '../shortcutStore.js';
import { AppshotShortcutService } from '../shortcutService.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function createMemoryStore(initial?: string): {
  store: AppshotShortcutStore;
  files: Map<string, string>;
} {
  const files = new Map<string, string>();
  if (initial) files.set('/userData/appshots-shortcuts.v1.json', initial);
  return {
    files,
    store: new AppshotShortcutStore({
      getFilePath: () => '/userData/appshots-shortcuts.v1.json',
      readFile: (filePath) => {
        const value = files.get(filePath);
        if (value === undefined) throw new Error('ENOENT');
        return value;
      },
      writeFileAtomic: (filePath, value) => files.set(filePath, value),
      removeFile: (filePath) => { files.delete(filePath); },
    }),
  };
}

function createHarness(options: {
  preferences?: AppshotShortcutPreferences;
  runningBundleIds?: Set<string>;
  register?: (accelerator: string) => boolean;
  retain?: (owner: string, subscriber: (keys: readonly string[]) => void) => Promise<() => void>;
  omitPlatform?: boolean;
  platform?: 'darwin' | 'linux';
} = {}) {
  const memory = createMemoryStore(
    options.preferences ? JSON.stringify({ version: 1, preferences: options.preferences }) : undefined,
  );
  const registered = new Map<string, () => void>();
  let keySubscriber: ((keys: readonly string[]) => void) | undefined;
  const capture = vi.fn(async () => undefined);
  const stateChanged = vi.fn();
  const captureFailure = vi.fn();
  const globalShortcut = {
    register: vi.fn((accelerator: string, callback: () => void) => {
      if (options.register?.(accelerator) === false) return false;
      registered.set(accelerator, callback);
      return true;
    }),
    unregister: vi.fn((accelerator: string) => { registered.delete(accelerator); }),
  };
  const retain = vi.fn(options.retain ?? (async (_owner, subscriber) => {
    keySubscriber = subscriber;
    return () => { keySubscriber = undefined; };
  }));
  const runningBundleIds = options.runningBundleIds ?? new Set<string>();
  const service = new AppshotShortcutService({
    store: memory.store,
    globalShortcut,
    retainMacModifierKeySnapshots: retain,
    capture,
    getRunningBundleIds: () => runningBundleIds,
    onStateChanged: stateChanged,
    onCaptureFailure: captureFailure,
    platform: options.platform ?? (options.omitPlatform === true ? undefined : 'darwin'),
  });
  return {
    service,
    files: memory.files,
    globalShortcut,
    registered,
    retain,
    capture,
    captureFailure,
    stateChanged,
    runningBundleIds,
    emitKeys: (keys: readonly string[]) => keySubscriber?.(keys),
  };
}

describe('Appshot shortcut preferences', () => {
  it('keeps defaults code-owned until a user customizes them, and reset removes the override', () => {
    const { store, files } = createMemoryStore();

    expect(store.get()).toEqual(DEFAULT_APPSHOT_SHORTCUT_PREFERENCES);
    expect(files.size).toBe(0);

    const customized = store.set({
      preferred: { kind: 'dual-modifier', modifier: 'option' },
      fallback: { kind: 'accelerator', combo: { code: 'F16', meta: false, ctrl: false, alt: false, shift: false } },
    });
    expect(customized.preferred).toEqual({ kind: 'dual-modifier', modifier: 'option' });
    expect(files.size).toBe(1);

    expect(store.reset()).toEqual(DEFAULT_APPSHOT_SHORTCUT_PREFERENCES);
    expect(files.size).toBe(0);
  });

  it('rejects duplicate shortcuts and system-reserved conventional combinations', () => {
    const { store } = createMemoryStore();
    expect(() => store.set({
      preferred: { kind: 'dual-modifier', modifier: 'command' },
      fallback: { kind: 'dual-modifier', modifier: 'command' },
    })).toThrow('different');
    expect(() => store.set({
      preferred: { kind: 'dual-modifier', modifier: 'command' },
      fallback: { kind: 'accelerator', combo: { code: 'KeyC', meta: true, ctrl: false, alt: false, shift: false } },
    })).toThrow('reserved');
  });

  it.each([
    ['duplicate', {
      version: 1,
      preferences: {
        preferred: { kind: 'dual-modifier', modifier: 'command' },
        fallback: { kind: 'dual-modifier', modifier: 'command' },
      },
    }],
    ['reserved', {
      version: 1,
      preferences: {
        preferred: { kind: 'dual-modifier', modifier: 'command' },
        fallback: { kind: 'accelerator', combo: { code: 'KeyC', meta: true, ctrl: false, alt: false, shift: false } },
      },
    }],
    ['missing fields', {
      version: 1,
      preferences: { preferred: { kind: 'dual-modifier', modifier: 'option' } },
    }],
  ])('fails safe to code defaults for %s stored preferences', (_label, stored) => {
    const { store } = createMemoryStore(JSON.stringify(stored));
    expect(store.get()).toEqual(DEFAULT_APPSHOT_SHORTCUT_PREFERENCES);
  });

  it('keeps the previous persisted preferences when an atomic write fails', () => {
    const previous = JSON.stringify({ version: 1, preferences: DEFAULT_APPSHOT_SHORTCUT_PREFERENCES });
    const { store, files } = createMemoryStore(previous);
    const original = files.get('/userData/appshots-shortcuts.v1.json');
    const failingStore = new AppshotShortcutStore({
      getFilePath: () => '/userData/appshots-shortcuts.v1.json',
      readFile: (filePath) => files.get(filePath) as string,
      writeFileAtomic: () => { throw new Error('disk full'); },
      removeFile: (filePath) => { files.delete(filePath); },
    });

    expect(() => failingStore.set({
      preferred: { kind: 'dual-modifier', modifier: 'option' },
      fallback: { kind: 'accelerator', combo: { code: 'F16', meta: false, ctrl: false, alt: false, shift: false } },
    })).toThrow('disk full');
    expect(files.get('/userData/appshots-shortcuts.v1.json')).toBe(original);
    expect(store.get()).toEqual(DEFAULT_APPSHOT_SHORTCUT_PREFERENCES);
  });

  it('creates the production store parent and publishes the preferences file with mode 0600', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-appshot-shortcut-store-'));
    temporaryDirectories.push(root);
    const userData = path.join(root, 'nested', 'profile');
    const store = createAppshotShortcutStore(userData);
    store.set({
      preferred: { kind: 'dual-modifier', modifier: 'option' },
      fallback: { kind: 'accelerator', combo: { code: 'F16', meta: false, ctrl: false, alt: false, shift: false } },
    });

    const filePath = path.join(userData, 'appshots-shortcuts.v1.json');
    expect(fs.existsSync(filePath)).toBe(true);
    expect(fs.statSync(filePath).mode & 0o777).toBe(0o600);
  });
});

describe('AppshotShortcutService', () => {
  it('activates the preferred dual-modifier shortcut on darwin even when platform is not injected', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    const harness = createHarness({ omitPlatform: true });

    await harness.service.start();

    expect(harness.retain).toHaveBeenCalledWith('appshots-shortcut-service', expect.any(Function));
    expect(harness.service.state()).toMatchObject({
      configured: DEFAULT_APPSHOT_SHORTCUT_PREFERENCES.preferred,
      active: DEFAULT_APPSHOT_SHORTCUT_PREFERENCES.preferred,
    });
    expect(harness.service.state()).not.toHaveProperty('fallbackReason');
  });

  it('activates the default preferred shortcut and only captures on a dual-modifier rising edge', async () => {
    const harness = createHarness();

    await harness.service.start();
    expect(harness.service.state()).toMatchObject({
      configured: DEFAULT_APPSHOT_SHORTCUT_PREFERENCES.preferred,
      active: DEFAULT_APPSHOT_SHORTCUT_PREFERENCES.preferred,
    });

    harness.emitKeys(['MetaLeft', 'MetaRight']);
    harness.emitKeys(['MetaLeft', 'MetaRight']);
    await Promise.resolve();
    expect(harness.capture).toHaveBeenCalledTimes(1);
    harness.emitKeys([]);
    harness.emitKeys(['MetaLeft', 'MetaRight']);
    await Promise.resolve();
    expect(harness.capture).toHaveBeenCalledTimes(2);
  });

  it('uses fallback while Codex is running and restores the preferred shortcut when it exits', async () => {
    const harness = createHarness({ runningBundleIds: new Set(['com.openai.codex']) });

    await harness.service.start();
    expect(harness.service.state()).toMatchObject({
      active: DEFAULT_APPSHOT_SHORTCUT_PREFERENCES.fallback,
      fallbackReason: 'codex-running',
    });

    harness.runningBundleIds.clear();
    await harness.service.refreshConflicts();
    expect(harness.service.state()).toMatchObject({
      active: DEFAULT_APPSHOT_SHORTCUT_PREFERENCES.preferred,
    });
    expect(harness.service.state()).not.toHaveProperty('fallbackReason');
  });

  it('does not re-register shortcuts when the Codex conflict state is unchanged', async () => {
    const harness = createHarness({ runningBundleIds: new Set(['com.openai.codex']) });

    await harness.service.start();
    const registerCount = harness.globalShortcut.register.mock.calls.length;

    await harness.service.refreshConflicts();
    expect(harness.globalShortcut.register.mock.calls.length).toBe(registerCount);
    expect(harness.retain).not.toHaveBeenCalled();

    harness.runningBundleIds.clear();
    await harness.service.refreshConflicts();
    expect(harness.retain).toHaveBeenCalledWith('appshots-shortcut-service', expect.any(Function));
  });

  it('does not register any shortcut on non-macOS platforms', async () => {
    const harness = createHarness({ platform: 'linux' });

    await harness.service.start();

    expect(harness.service.state()).toMatchObject({ active: null });
    expect(harness.service.state()).not.toHaveProperty('fallbackReason');
    expect(harness.globalShortcut.register).not.toHaveBeenCalled();
    expect(harness.retain).not.toHaveBeenCalled();
  });

  it('falls back after conventional preferred registration fails and disables global capture when both fail', async () => {
    const conventional: AppshotShortcutPreferences = {
      preferred: { kind: 'accelerator', combo: { code: 'F16', meta: false, ctrl: false, alt: false, shift: false } },
      fallback: { kind: 'accelerator', combo: { code: 'F17', meta: false, ctrl: false, alt: false, shift: false } },
    };
    const fallbackHarness = createHarness({
      preferences: conventional,
      register: (accelerator) => accelerator !== 'F16',
    });
    await fallbackHarness.service.start();
    expect(fallbackHarness.service.state()).toMatchObject({
      active: conventional.fallback,
      fallbackReason: 'registration-conflict',
    });

    const noShortcutHarness = createHarness({ preferences: conventional, register: () => false });
    await noShortcutHarness.service.start();
    expect(noShortcutHarness.service.state()).toMatchObject({
      active: null,
      fallbackReason: 'registration-conflict',
    });
  });

  it('persists user preferences across service reload and does not disable manual coordinator capture', async () => {
    const harness = createHarness();
    const customized: AppshotShortcutPreferences = {
      preferred: { kind: 'dual-modifier', modifier: 'option' },
      fallback: { kind: 'accelerator', combo: { code: 'F16', meta: false, ctrl: false, alt: false, shift: false } },
    };

    await harness.service.setPreferences(customized);
    const reloaded = new AppshotShortcutStore({
      getFilePath: () => '/userData/appshots-shortcuts.v1.json',
      readFile: (filePath) => harness.files.get(filePath) ?? (() => { throw new Error('ENOENT'); })(),
      writeFileAtomic: (filePath, value) => harness.files.set(filePath, value),
      removeFile: (filePath) => { harness.files.delete(filePath); },
    });
    expect(reloaded.get()).toEqual(customized);

    await harness.capture();
    expect(harness.capture).toHaveBeenCalledTimes(1);
  });

  it('reports only a stable capture failure code', async () => {
    const harness = createHarness();
    harness.capture.mockRejectedValueOnce(new Error('/private/secret details'));
    await harness.service.start();

    harness.emitKeys(['MetaLeft', 'MetaRight']);
    await Promise.resolve();
    await Promise.resolve();
    expect(harness.captureFailure).toHaveBeenCalledWith('capture-failed');
  });

  it('releases a stale refresh activation without overwriting the newer conflict state', async () => {
    const firstRetain = deferred<() => void>();
    const releaseFirst = vi.fn();
    const harness = createHarness({ retain: vi.fn(() => firstRetain.promise) });

    const starting = harness.service.start();
    harness.runningBundleIds.add('com.openai.codex');
    await harness.service.refreshConflicts();
    const broadcastsAfterNewRefresh = harness.stateChanged.mock.calls.length;
    firstRetain.resolve(releaseFirst);
    await starting;

    expect(releaseFirst).toHaveBeenCalledTimes(1);
    expect(harness.service.state()).toMatchObject({
      active: DEFAULT_APPSHOT_SHORTCUT_PREFERENCES.fallback,
      fallbackReason: 'codex-running',
    });
    expect(harness.stateChanged).toHaveBeenCalledTimes(broadcastsAfterNewRefresh);
  });

  it('does not let an old refresh overwrite preferences set while activation was pending', async () => {
    const oldRetain = deferred<() => void>();
    const releaseOld = vi.fn();
    const harness = createHarness({ retain: vi.fn(() => oldRetain.promise) });
    const starting = harness.service.start();
    const next: AppshotShortcutPreferences = {
      preferred: { kind: 'accelerator', combo: { code: 'F16', meta: false, ctrl: false, alt: false, shift: false } },
      fallback: { kind: 'accelerator', combo: { code: 'F17', meta: false, ctrl: false, alt: false, shift: false } },
    };

    await harness.service.setPreferences(next);
    oldRetain.resolve(releaseOld);
    await starting;

    expect(releaseOld).toHaveBeenCalledTimes(1);
    expect(harness.service.state()).toMatchObject({ preferences: next, configured: next.preferred, active: next.preferred });
  });

  it('releases a start that resolves after stop without reviving state or broadcasting', async () => {
    const pendingRetain = deferred<() => void>();
    const releasePending = vi.fn();
    const harness = createHarness({ retain: vi.fn(() => pendingRetain.promise) });
    const starting = harness.service.start();

    harness.service.stop();
    const broadcastsAfterStop = harness.stateChanged.mock.calls.length;
    pendingRetain.resolve(releasePending);
    await starting;

    expect(releasePending).toHaveBeenCalledTimes(1);
    expect(harness.service.state().active).toBeNull();
    expect(harness.stateChanged).toHaveBeenCalledTimes(broadcastsAfterStop);
  });
});
