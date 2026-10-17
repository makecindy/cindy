import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_APPEARANCE_SETTINGS,
  type AppearanceSettings,
  type WallpaperDownloadProgress,
  WALLPAPER_DOWNLOAD_PROGRESS_CHANNEL,
} from '../../shared/appearanceSettings';

const mocks = vi.hoisted(() => ({
  listeners: new Map<string, Set<(event: unknown, payload: unknown) => void>>(),
  expose: vi.fn(),
  sendSync: vi.fn(),
  invoke: vi.fn(),
}));
vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: mocks.expose },
  ipcRenderer: {
    sendSync: mocks.sendSync,
    invoke: mocks.invoke,
    on: (channel: string, listener: (event: unknown, payload: unknown) => void) => {
      if (!mocks.listeners.has(channel)) mocks.listeners.set(channel, new Set());
      mocks.listeners.get(channel)!.add(listener);
    },
    removeListener: (channel: string, listener: (event: unknown, payload: unknown) => void) =>
      mocks.listeners.get(channel)?.delete(listener),
  },
}));

function emit(settings: AppearanceSettings) {
  for (const listener of mocks.listeners.get('appearance-settings:changed') ?? [])
    listener({ sender: 'must not cross the bridge' }, settings);
}

afterEach(() => vi.unstubAllGlobals());
describe.each(['sidebar', 'resource', 'ghost-panel'])('%s appearance startup', (kind) => {
  let bridge: {
    getSync(): AppearanceSettings | null;
    onChanged(callback: (settings: AppearanceSettings) => void): () => void;
    ensureWallpaperImage?: (id: string) => Promise<string | null>;
    ensureWallpaperVideo?: (id: string) => Promise<string | null>;
    onWallpaperDownloadProgress: (
      callback: (progress: WallpaperDownloadProgress) => void,
    ) => () => void;
  };
  beforeEach(async () => {
    vi.resetModules();
    mocks.listeners.clear();
    mocks.expose.mockClear();
    mocks.invoke.mockReset().mockResolvedValue('cached-media-url');
    mocks.sendSync.mockImplementation((channel) =>
      channel === 'appearance-settings:get-sync' ? DEFAULT_APPEARANCE_SETTINGS : null,
    );
    vi.stubGlobal('window', { location: { search: '?ghostPanelWindow=fixture' } });
    if (kind === 'sidebar') await import('../sidebarWindowPreload');
    else if (kind === 'resource') await import('../resourceUsagePreload');
    else await import('../ghostPanelWindowPreload');
    bridge = mocks.expose.mock.calls.at(-1)![1].appearanceSettings;
  });

  it('reads the latest wallpaper when broadcasts precede lazy renderer startup', () => {
    const latest = { ...DEFAULT_APPEARANCE_SETTINGS, wallpaperId: 'cindy-dream' as const };
    expect(bridge.getSync()).toEqual(DEFAULT_APPEARANCE_SETTINGS);
    emit({ ...latest, wallpaperId: 'cindy-window' });
    emit(latest);
    expect(bridge.getSync()).toEqual(latest);
    // Settings remain read-only; only app-content hosts can request official media.
    expect(Object.keys(bridge).sort()).toEqual([
      'ensureWallpaperImage',
      'ensureWallpaperVideo',
      'getSync',
      'onChanged',
      'onWallpaperDownloadProgress',
    ]);
  });

  it('exposes only fixed official-media requests to wallpaper-capable hosts', async () => {
    await expect(bridge.ensureWallpaperImage!('cindy-window')).resolves.toBe('cached-media-url');
    await expect(bridge.ensureWallpaperVideo!('cindy-dream')).resolves.toBe('cached-media-url');
    expect(mocks.invoke.mock.calls).toEqual([
      ['appearance-settings:ensure-wallpaper-image', 'cindy-window'],
      ['appearance-settings:ensure-wallpaper-video', 'cindy-dream'],
    ]);
  });

  it('replays updates between the initial render read and effect subscription', () => {
    bridge.getSync();
    const latest = {
      ...DEFAULT_APPEARANCE_SETTINGS,
      wallpaperId: 'custom' as const,
      customWallpaperUrl: `cindy-media://client-wallpaper/${'b'.repeat(64)}.webp`,
    };
    emit(latest);
    const callback = vi.fn();
    const off = bridge.onChanged(callback);
    expect(callback.mock.calls).toEqual([[latest]]);
    emit(DEFAULT_APPEARANCE_SETTINGS);
    expect(callback.mock.calls).toEqual([[latest], [DEFAULT_APPEARANCE_SETTINGS]]);
    off();
  });

  it('forwards only progress data and removes the listener when unsubscribed', () => {
    const callback = vi.fn();
    const unsubscribe = bridge.onWallpaperDownloadProgress(callback);
    const progress = { wallpaperId: 'cindy-window', kind: 'image', loaded: 123, total: 456 };
    const emitProgress = () => {
      for (const listener of mocks.listeners.get(WALLPAPER_DOWNLOAD_PROGRESS_CHANNEL) ?? []) {
        listener({ sender: 'must not cross the bridge' }, progress);
      }
    };
    emitProgress();
    expect(callback.mock.calls).toEqual([[progress]]);
    unsubscribe();
    emitProgress();
    expect(callback).toHaveBeenCalledOnce();
    expect(mocks.listeners.get(WALLPAPER_DOWNLOAD_PROGRESS_CHANNEL)?.size).toBe(0);
  });

  it('keeps the cache current after unsubscribe and replays removal on remount', () => {
    const latest = { ...DEFAULT_APPEARANCE_SETTINGS, wallpaperId: 'cindy-studio' as const };
    emit(latest);
    const first = vi.fn();
    bridge.onChanged(first)();
    emit(DEFAULT_APPEARANCE_SETTINGS);
    expect(first.mock.calls).toEqual([[latest]]);
    const remount = vi.fn();
    bridge.onChanged(remount)();
    expect(remount.mock.calls).toEqual([[DEFAULT_APPEARANCE_SETTINGS]]);
  });
});

it('keeps the default appearance snapshot free of download or mutation capabilities', async () => {
  const { createAppearanceSnapshotBridge } = await import('../appearanceSnapshot');
  expect(Object.keys(createAppearanceSnapshotBridge()).sort()).toEqual(['getSync', 'onChanged']);
});
