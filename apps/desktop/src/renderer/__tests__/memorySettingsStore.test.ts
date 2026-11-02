import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

function createStorage(initial?: boolean): Storage {
  const values = new Map<string, string>();
  if (initial !== undefined) {
    values.set('memorySettings.makerEnabled', initial ? 'true' : 'false');
  }
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => Array.from(values.keys())[index] ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, value),
  };
}

describe('memorySettingsStore', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('defaults to enabled when no renderer value exists', async () => {
    vi.stubGlobal('localStorage', createStorage());
    const { getMakerMemoryEnabled } = await import('@/lib/memorySettingsStore');

    expect(getMakerMemoryEnabled()).toBe(true);
  });

  it('keeps a user toggle in memory when localStorage is unavailable', async () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    });
    const { getMakerMemoryEnabled, setMakerMemoryEnabled } =
      await import('@/lib/memorySettingsStore');

    expect(getMakerMemoryEnabled()).toBe(true);
    setMakerMemoryEnabled(false);
    expect(getMakerMemoryEnabled()).toBe(false);
  });

  it('migrates a legacy false marker before syncing the new main default', async () => {
    vi.stubGlobal('localStorage', createStorage(false));
    const preserveLegacy = vi.fn().mockResolvedValue({
      maker: false,
      claudeCode: true,
      codex: true,
    });
    vi.stubGlobal('window', {
      electronAPI: {
        maker: {
          memoryGetSettings: vi.fn().mockResolvedValue({
            maker: true,
            claudeCode: true,
            codex: true,
          }),
          memoryPreserveLegacyMakerDisabled: preserveLegacy,
        },
      },
    });
    const { bootstrapMemorySettingsFromMain, getMakerMemoryEnabled, setMemorySettingsOwner } =
      await import('@/lib/memorySettingsStore');
    setMemorySettingsOwner('cloud-user');

    await bootstrapMemorySettingsFromMain();

    expect(preserveLegacy).toHaveBeenCalledOnce();
    expect(preserveLegacy).toHaveBeenCalledWith(false);
    expect(getMakerMemoryEnabled()).toBe(false);
  });

  it('does not migrate native opt-outs when the legacy renderer marker is absent', async () => {
    vi.stubGlobal('localStorage', createStorage());
    const preserveLegacy = vi.fn().mockResolvedValue({
      maker: true,
      claudeCode: false,
      codex: false,
    });
    vi.stubGlobal('window', {
      electronAPI: {
        maker: {
          memoryGetSettings: vi.fn().mockResolvedValue({
            maker: true,
            claudeCode: false,
            codex: false,
          }),
          memoryPreserveLegacyMakerDisabled: preserveLegacy,
        },
      },
    });
    const { bootstrapMemorySettingsFromMain, getMakerMemoryEnabled, setMemorySettingsOwner } =
      await import('@/lib/memorySettingsStore');
    setMemorySettingsOwner('cloud-user');

    await bootstrapMemorySettingsFromMain();

    expect(preserveLegacy).toHaveBeenCalledWith(null);
    expect(getMakerMemoryEnabled()).toBe(true);
  });

  it('does not import the legacy cloud setting into local mode', async () => {
    vi.stubGlobal('localStorage', createStorage(false));
    vi.stubGlobal('window', {
      electronAPI: {
        maker: {
          memoryGetSettings: vi.fn().mockResolvedValue({
            maker: true,
            claudeCode: true,
            codex: true,
          }),
          memoryPreserveLegacyMakerDisabled: vi.fn(),
        },
      },
    });
    const { bootstrapMemorySettingsFromMain, getMakerMemoryEnabled, setMemorySettingsOwner } =
      await import('@/lib/memorySettingsStore');
    setMemorySettingsOwner('local-v1');

    await bootstrapMemorySettingsFromMain();

    expect(getMakerMemoryEnabled()).toBe(true);
    expect(window.electronAPI.maker.memoryPreserveLegacyMakerDisabled).not.toHaveBeenCalled();
  });

  it('persists a legacy renderer opt-in before native opt-out migration can run', async () => {
    const storage = createStorage(true);
    vi.stubGlobal('localStorage', storage);
    const preserveLegacy = vi.fn().mockResolvedValue({
      maker: true,
      claudeCode: false,
      codex: true,
    });
    vi.stubGlobal('window', {
      electronAPI: {
        maker: {
          memoryGetSettings: vi.fn().mockResolvedValue({
            maker: true,
            claudeCode: false,
            codex: true,
          }),
          memoryPreserveLegacyMakerDisabled: preserveLegacy,
        },
      },
    });
    const { bootstrapMemorySettingsFromMain, getMakerMemoryEnabled, setMemorySettingsOwner } =
      await import('@/lib/memorySettingsStore');
    setMemorySettingsOwner('cloud-user');

    await bootstrapMemorySettingsFromMain();

    expect(preserveLegacy).toHaveBeenCalledWith(true);
    expect(getMakerMemoryEnabled()).toBe(true);
    expect(storage.getItem('memorySettings.makerLegacyMigrationV1')).toBe('1');
  });

  it('does not recreate a Maker override after the legacy migration is complete', async () => {
    const storage = createStorage(true);
    storage.setItem('memorySettings.makerLegacyMigrationV1', '1');
    vi.stubGlobal('localStorage', storage);
    const preserveLegacy = vi.fn();
    vi.stubGlobal('window', {
      electronAPI: {
        maker: {
          memoryGetSettings: vi.fn().mockResolvedValue({
            maker: true,
            claudeCode: true,
            codex: true,
          }),
          memoryPreserveLegacyMakerDisabled: preserveLegacy,
        },
      },
    });
    const { bootstrapMemorySettingsFromMain, setMemorySettingsOwner } =
      await import('@/lib/memorySettingsStore');
    setMemorySettingsOwner('cloud-user');

    await bootstrapMemorySettingsFromMain();

    expect(preserveLegacy).not.toHaveBeenCalled();
  });

  it('syncs a persisted Maker opt-out before the main view can create sessions', async () => {
    vi.stubGlobal('localStorage', createStorage());
    const preserveLegacy = vi.fn();
    vi.stubGlobal('window', {
      electronAPI: {
        maker: {
          memoryGetSettings: vi.fn().mockResolvedValue({
            maker: false,
            claudeCode: true,
            codex: true,
          }),
          memoryPreserveLegacyMakerDisabled: preserveLegacy,
        },
      },
    });
    const { bootstrapMemorySettingsFromMain, getMakerMemoryEnabled, setMemorySettingsOwner } =
      await import('@/lib/memorySettingsStore');
    setMemorySettingsOwner('cloud-user');

    await bootstrapMemorySettingsFromMain();

    expect(preserveLegacy).not.toHaveBeenCalled();
    expect(getMakerMemoryEnabled()).toBe(false);
  });

  it('does not overwrite a user write that happens while bootstrap is pending', async () => {
    vi.stubGlobal('localStorage', createStorage(true));
    let resolveSettings!: (settings: {
      maker: boolean;
      claudeCode: boolean;
      codex: boolean;
    }) => void;
    const settingsPromise = new Promise<{
      maker: boolean;
      claudeCode: boolean;
      codex: boolean;
    }>((resolve) => {
      resolveSettings = resolve;
    });
    vi.stubGlobal('window', {
      electronAPI: {
        maker: {
          memoryGetSettings: vi.fn(() => settingsPromise),
          memoryPreserveLegacyMakerDisabled: vi.fn(),
        },
      },
    });
    const { bootstrapMemorySettingsFromMain, getMakerMemoryEnabled, setMakerMemoryEnabled } =
      await import('@/lib/memorySettingsStore');

    const bootstrap = bootstrapMemorySettingsFromMain();
    setMakerMemoryEnabled(false);
    resolveSettings({ maker: true, claudeCode: true, codex: true });
    await bootstrap;

    expect(getMakerMemoryEnabled()).toBe(false);
  });

  it('does not reject when legacy migration persistence fails', async () => {
    vi.stubGlobal('localStorage', createStorage(false));
    vi.stubGlobal('window', {
      electronAPI: {
        maker: {
          memoryGetSettings: vi.fn().mockResolvedValue({
            maker: true,
            claudeCode: false,
            codex: true,
          }),
          memoryPreserveLegacyMakerDisabled: vi
            .fn()
            .mockRejectedValue(Object.assign(new Error('disk full'), { code: 'INTERNAL' })),
        },
      },
    });
    const { bootstrapMemorySettingsFromMain, getMakerMemoryEnabled, setMemorySettingsOwner } =
      await import('@/lib/memorySettingsStore');
    setMemorySettingsOwner('cloud-user');

    await expect(bootstrapMemorySettingsFromMain()).resolves.toBeUndefined();
    expect(getMakerMemoryEnabled()).toBe(false);
  });

  it('does not send migration IPC from a stale owner bootstrap', async () => {
    const storage = createStorage();
    storage.setItem('memorySettings.makerLegacyMigrationV1.owner-b', '1');
    storage.setItem('memorySettings.makerEnabled.owner-b', 'true');
    vi.stubGlobal('localStorage', storage);
    let resolveOwnerA!: (settings: {
      maker: boolean;
      claudeCode: boolean;
      codex: boolean;
    }) => void;
    let resolveOwnerB!: (settings: {
      maker: boolean;
      claudeCode: boolean;
      codex: boolean;
    }) => void;
    const ownerASettings = new Promise<{
      maker: boolean;
      claudeCode: boolean;
      codex: boolean;
    }>((resolve) => {
      resolveOwnerA = resolve;
    });
    const ownerBSettings = new Promise<{
      maker: boolean;
      claudeCode: boolean;
      codex: boolean;
    }>((resolve) => {
      resolveOwnerB = resolve;
    });
    // Main preserves the current true setting for legacy=null; it does not disable B.
    const preserveLegacy = vi.fn().mockResolvedValue({
      maker: true,
      claudeCode: true,
      codex: true,
    });
    vi.stubGlobal('window', {
      electronAPI: {
        maker: {
          memoryGetSettings: vi
            .fn()
            .mockReturnValueOnce(ownerASettings)
            .mockReturnValueOnce(ownerBSettings),
          memoryPreserveLegacyMakerDisabled: preserveLegacy,
        },
      },
    });
    const {
      bootstrapMemorySettingsFromMain,
      getMakerMemoryEnabled,
      setMemorySettingsOwner,
    } = await import('@/lib/memorySettingsStore');

    // Controlled IPC timing checks the owner boundary, not real Electron reachability.
    setMemorySettingsOwner('owner-a');
    const staleBootstrap = bootstrapMemorySettingsFromMain();
    setMemorySettingsOwner('owner-b');
    const currentBootstrap = bootstrapMemorySettingsFromMain();
    resolveOwnerB({ maker: true, claudeCode: true, codex: true });
    await currentBootstrap;
    resolveOwnerA({ maker: true, claudeCode: true, codex: true });
    await staleBootstrap;

    // A stale read must not issue migration IPC against the new owner's Main profile.
    expect(preserveLegacy).not.toHaveBeenCalled();
    expect(getMakerMemoryEnabled()).toBe(true);
    expect(storage.getItem('memorySettings.makerEnabled.owner-b')).toBe('true');
  });
});
