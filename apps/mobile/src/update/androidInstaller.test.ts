import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  native: { isSupported: vi.fn(() => true), hasPermission: vi.fn(async () => true),
    requestPermission: vi.fn(async () => true), install: vi.fn(async (_file: string, _version: string) => undefined) },
  state: { currentState: 'active' },
  appStateListener: undefined as ((state: string) => void) | undefined,
  onProgress: undefined as ((data: { bytesWritten: number; totalBytes: number }) => void) | undefined,
  file: '', resumeData: undefined as string | undefined,
  files: new Map<string, number>(),
  modified: new Map<string, number>(),
  network: { type: 'WIFI', isConnected: true, isInternetReachable: true },
  networkListener: undefined as ((state: { type: string; isConnected: boolean; isInternetReachable: boolean }) => void) | undefined,
  networkUnsubscribe: vi.fn(),
  download: vi.fn<() => Promise<object | null>>(),
  resolveDownload: undefined as ((value: object | null) => void) | undefined,
  rejectDownload: undefined as ((error: Error) => void) | undefined,
  cancel: vi.fn(), release: vi.fn(), unsubscribe: vi.fn(), browser: vi.fn(async () => undefined),
  remove: vi.fn(async (file: string) => { mocks.files.delete(file); }),
}));
vi.mock('react-native', () => ({
  Platform: { OS: 'android' },
  AppState: { get currentState() { return mocks.state.currentState; },
    addEventListener: (_name: string, callback: (state: string) => void) => {
      mocks.appStateListener = callback; return { remove: mocks.unsubscribe };
    } },
  Linking: { openURL: mocks.browser },
}));
vi.mock('expo-modules-core', () => ({ requireOptionalNativeModule: () => mocks.native }));
vi.mock('expo-network', () => ({
  NetworkStateType: { WIFI: 'WIFI' },
  getNetworkStateAsync: vi.fn(async () => mocks.network),
  addNetworkStateListener: (listener: typeof mocks.networkListener) => {
    mocks.networkListener = listener;
    return { remove: mocks.networkUnsubscribe };
  },
}));
vi.mock('expo-file-system/legacy', () => ({
  cacheDirectory: 'file:///cache/', makeDirectoryAsync: vi.fn(async () => undefined),
  readDirectoryAsync: vi.fn(async () => [...mocks.files.keys()].map((file) => file.split('/').at(-1))),
  getInfoAsync: vi.fn(async (file: string) => mocks.files.has(file)
    ? { exists: true, isDirectory: false, size: mocks.files.get(file), modificationTime: mocks.modified.get(file) ?? Date.now() / 1000 }
    : { exists: false }),
  deleteAsync: mocks.remove,
  moveAsync: vi.fn(async ({ from, to }: { from: string; to: string }) => {
    mocks.files.set(to, mocks.files.get(from) ?? 0); mocks.files.delete(from);
  }),
  copyAsync: vi.fn(async ({ from, to }: { from: string; to: string }) => {
    mocks.files.set(to, mocks.files.get(from) ?? 0);
  }),
}));
vi.mock('expo-file-system', () => ({
  File: class { constructor(public uri: string) {} },
  DownloadTask: class {
    constructor(_url: string, file: { uri: string }, options: { onProgress: typeof mocks.onProgress }) {
      mocks.file = file.uri; mocks.onProgress = options.onProgress; mocks.resumeData = undefined;
    }
    static fromSavable(saved: { url: string; fileUri: string; resumeData: string }, options: { onProgress: typeof mocks.onProgress }) {
      const task = new this(saved.url, { uri: saved.fileUri }, options);
      mocks.resumeData = saved.resumeData; return task;
    }
    downloadAsync = mocks.download;
    resumeAsync = mocks.download;
    state = 'active';
    pauseAsync = mocks.cancel;
    release = mocks.release;
  },
}));
import { androidInstaller } from './androidInstaller';
const target = { installUrl: 'https://updates.example.invalid/app.apk', version: '1.2.3' };
const settle = async () => { for (let i = 0; i < 80; i++) await Promise.resolve(); };
const pending = () => mocks.download.mockImplementation(() => new Promise((resolve, reject) => { mocks.resolveDownload = resolve; mocks.rejectDownload = reject; }));
beforeEach(() => {
  vi.useFakeTimers(); vi.clearAllMocks(); mocks.files.clear(); mocks.modified.clear();
  mocks.state.currentState = 'active'; mocks.rejectDownload = undefined; mocks.resolveDownload = undefined;
  mocks.network = { type: 'WIFI', isConnected: true, isInternetReachable: true };
  mocks.networkListener = undefined;
  mocks.download.mockResolvedValue({});
  mocks.cancel.mockImplementation(async () => mocks.resolveDownload?.(null));
});
afterEach(async () => { androidInstaller.close(); await settle(); vi.useRealTimers(); });

// Unit regression: the public installer previously deleted partial APKs on failure.
// Seed on-disk bytes (including a previous process's file) and observe the resume
// offset and installation through start/retry, not just storage helper calls.
describe('Android installer IO', () => {
  // PR #6977: startActivity resolves before Android opens its URI. A new target
  // must reclaim the old download cache while preserving that installer's bytes.
  it('keeps a recent installer handoff readable while reclaiming an obsolete ready package', async () => {
    androidInstaller.start(target); await settle();
    const handedOff = mocks.native.install.mock.calls[0][0];
    const cached = [...mocks.files.keys()].find((file) => file.includes('update-ready-'))!;
    androidInstaller.start({ ...target, version: '3.0.1' }, { automatic: true }); await settle();
    expect(mocks.files.has(cached)).toBe(false);
    expect(mocks.files.has(handedOff)).toBe(true);
    mocks.modified.set(handedOff, Date.now() / 1000 - 86401);
    androidInstaller.start({ ...target, version: '3.0.2' }, { automatic: true }); await settle();
    expect(mocks.files.has(handedOff)).toBe(false);
  });
  // Unit: automatic start previously prompted before download and retained obsolete
  // APKs for 24h. Seed a fresh old package on cellular and drive real network events.
  it('cleans obsolete packages immediately on cellular, downloads on Wi-Fi, and only then offers installation', async () => {
    const old = `file:///cache/cindy-updates/update-ready-${'a'.repeat(64)}.apk`;
    const unrelated = 'file:///cache/cindy-updates/user.apk';
    mocks.files.set(old, 500); mocks.files.set(unrelated, 200);
    mocks.network.type = 'CELLULAR';
    androidInstaller.start({ ...target, version: '2.0.1' }, { automatic: true }); await settle();
    expect(mocks.files.has(old)).toBe(false);
    expect(mocks.files.has(unrelated)).toBe(true);
    expect(mocks.download).not.toHaveBeenCalled();
    expect(androidInstaller.getSnapshot().silent).toBe(true);
    mocks.networkListener!({ ...mocks.network, type: 'WIFI' }); await settle();
    expect(androidInstaller.getSnapshot().phase).toBe('ready');
    expect(androidInstaller.getSnapshot().silent).not.toBe(true);
    expect(mocks.native.install).not.toHaveBeenCalled();
    expect(mocks.native.hasPermission).not.toHaveBeenCalled();
    androidInstaller.retry(); await settle();
    expect(mocks.native.install).toHaveBeenCalledOnce();
    expect(mocks.networkUnsubscribe).toHaveBeenCalledOnce();
  });

  it('pauses when Wi-Fi disappears and resumes the partial only when Wi-Fi returns', async () => {
    pending();
    androidInstaller.start({ ...target, version: '2.0.2' }, { automatic: true }); await settle();
    mocks.files.set(mocks.file, 256);
    mocks.networkListener!({ ...mocks.network, type: 'CELLULAR' }); await settle();
    expect(mocks.cancel).toHaveBeenCalledOnce();
    expect(mocks.download).toHaveBeenCalledOnce();
    expect(androidInstaller.getSnapshot().silent).toBe(true);
    mocks.download.mockResolvedValue({});
    mocks.networkListener!({ ...mocks.network, type: 'WIFI' }); await settle();
    expect(mocks.resumeData).toBe('256');
    expect(androidInstaller.getSnapshot().phase).toBe('ready');
    expect(mocks.native.install).not.toHaveBeenCalled();
  });

  it('lets a manual update take over while automatic download waits for Wi-Fi', async () => {
    mocks.network.type = 'CELLULAR';
    const next = { ...target, version: '2.0.3' };
    androidInstaller.start(next, { automatic: true }); await settle();
    androidInstaller.start(next); await settle();
    expect(mocks.download).toHaveBeenCalledOnce();
    expect(mocks.native.install).toHaveBeenCalledOnce();
    expect(mocks.networkUnsubscribe).toHaveBeenCalledOnce();
  });

  it('reuses a completed automatic APK after dismissal even without Wi-Fi', async () => {
    const next = { ...target, version: '2.0.4' };
    androidInstaller.start(next, { automatic: true }); await settle();
    const cached = [...mocks.files.keys()][0];
    androidInstaller.close(); await settle();
    mocks.network.type = 'CELLULAR';
    androidInstaller.start(next); await settle();
    expect(mocks.download).toHaveBeenCalledOnce();
    expect(mocks.files.has(cached)).toBe(true);
    expect(mocks.native.install).toHaveBeenCalledWith(expect.stringMatching(/\/update-[0-9]+-[a-z0-9]+\.apk$/), next.version);
  });

  it('retains the downloaded APK for the system installer', async () => {
    androidInstaller.start(target); await settle();
    expect(mocks.file).toMatch(/^file:\/\/\/cache\/cindy-updates\/update-resume-[a-f0-9]{64}\.apk$/);
    expect(mocks.native.install).toHaveBeenCalledWith(expect.stringMatching(/\/update-[0-9]+-[a-z0-9]+\.apk$/), target.version);
    expect(androidInstaller.getSnapshot().phase).toBe('ready');
    expect(mocks.remove).not.toHaveBeenCalled();
    expect(mocks.release).toHaveBeenCalledOnce();
    mocks.onProgress!({ bytesWritten: 100, totalBytes: 100 });
    expect(androidInstaller.getSnapshot().phase).toBe('ready');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('never overwrites a completed file held by the system installer', async () => {
    androidInstaller.start(target); await settle();
    const handedOff = mocks.native.install.mock.calls[0][0];
    expect(mocks.files.has(handedOff)).toBe(true);
    androidInstaller.close(); await settle();
    androidInstaller.start(target); await settle();
    expect(mocks.resumeData).toBeUndefined();
    expect(mocks.files.has(handedOff)).toBe(true);
    expect(mocks.native.install.mock.calls[1][0]).not.toBe(handedOff);
    expect(mocks.download).toHaveBeenCalledOnce();
  });

  it('retains interrupted bytes and resumes from disk on retry', async () => {
    pending(); androidInstaller.start(target); await settle();
    mocks.files.set(mocks.file, 256);
    mocks.rejectDownload!(new Error('connection lost')); await settle();
    expect(androidInstaller.getSnapshot().phase).toBe('error');
    expect(mocks.native.install).not.toHaveBeenCalled();
    expect(mocks.remove).not.toHaveBeenCalled();
    mocks.download.mockResolvedValue({}); androidInstaller.retry(); await settle();
    expect(mocks.resumeData).toBe('256');
    expect(androidInstaller.getSnapshot().phase).toBe('ready');
  });

  it('cancels stalled transfers but keeps their bytes available for retry', async () => {
    pending(); androidInstaller.start(target); await settle();
    mocks.files.set(mocks.file, 128);
    await vi.advanceTimersByTimeAsync(90_000); await settle();
    expect(mocks.cancel).toHaveBeenCalledOnce();
    expect(mocks.remove).not.toHaveBeenCalled();
    expect(androidInstaller.getSnapshot().phase).toBe('error');
    await androidInstaller.browser();
    expect(mocks.browser).toHaveBeenCalledWith(target.installUrl);
  });

  it('reopens with persisted bytes and never shares them with another release', async () => {
    pending(); androidInstaller.start(target); await settle();
    const original = mocks.file; mocks.files.set(original, 512);
    androidInstaller.close(); await settle();
    mocks.download.mockResolvedValue({}); androidInstaller.start(target); await settle();
    expect(mocks.file).toBe(original); expect(mocks.resumeData).toBe('512');
    androidInstaller.close(); await settle();
    androidInstaller.start({ ...target, version: '1.2.4' }); await settle();
    expect(mocks.file).not.toBe(original); expect(mocks.resumeData).toBeUndefined();
  });

  it('waits for a cancelled native writer before immediately reopening', async () => {
    pending(); androidInstaller.start(target); await settle();
    mocks.cancel.mockImplementation(async () => undefined);
    androidInstaller.close(); androidInstaller.start(target); await settle();
    expect(mocks.download).toHaveBeenCalledTimes(1);
    mocks.files.set(mocks.file, 333);
    mocks.download.mockResolvedValue({}); mocks.rejectDownload!(new Error('cancelled')); await settle();
    expect(mocks.download).toHaveBeenCalledTimes(2);
    expect(mocks.resumeData).toBe('333');
    expect(androidInstaller.getSnapshot().phase).toBe('ready');
  });

  it('retries an unsatisfiable range from zero once', async () => {
    pending(); androidInstaller.start(target); await settle();
    mocks.files.set(mocks.file, 99); androidInstaller.close(); await settle();
    mocks.download.mockRejectedValueOnce(new Error('HTTP 416')).mockResolvedValueOnce({});
    androidInstaller.start(target); await settle();
    expect(mocks.remove).toHaveBeenCalledWith(mocks.file, { idempotent: true });
    expect(mocks.resumeData).toBeUndefined();
    expect(androidInstaller.getSnapshot().phase).toBe('ready');
  });

  it('HTTP failures never launch installation or discard the previous partial', async () => {
    pending(); androidInstaller.start(target); await settle();
    mocks.files.set(mocks.file, 256);
    mocks.rejectDownload!(new Error('connection lost')); await settle();
    mocks.download.mockRejectedValue(new Error('HTTP 503'));
    androidInstaller.retry(); await settle();
    expect(mocks.files.get(mocks.file)).toBe(256);
    expect(mocks.native.install).not.toHaveBeenCalled();
    expect(mocks.remove).not.toHaveBeenCalled();
    expect(androidInstaller.getSnapshot().phase).toBe('error');
  });

  it('reports unknown length without fake percentages and refreshes the stall timer', async () => {
    pending(); androidInstaller.start(target); await settle();
    mocks.onProgress!({ bytesWritten: 20, totalBytes: -1 });
    expect(androidInstaller.getSnapshot().progress).toBeNull();
    await vi.advanceTimersByTimeAsync(60_000);
    mocks.onProgress!({ bytesWritten: 50, totalBytes: 100 });
    expect(androidInstaller.getSnapshot().progress).toBe(0.5);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(androidInstaller.getSnapshot().phase).toBe('downloading');
    androidInstaller.close(); await settle();
    expect(mocks.native.install).not.toHaveBeenCalled();
    expect(mocks.remove).not.toHaveBeenCalled();
  });

  it('waits for rejected APK deletion before a reopened update can reuse the cache', async () => {
    let finishRemoval!: () => void;
    mocks.remove.mockImplementationOnce(async (file) => { mocks.files.delete(file); }); // Rejected handoff.
    mocks.remove.mockImplementationOnce(async (file) => { // Invalid reusable cache.
      await new Promise<void>((resolve) => { finishRemoval = resolve; });
      mocks.files.delete(file);
    });
    mocks.native.install.mockRejectedValueOnce(new Error('invalid APK'));
    androidInstaller.start(target); await settle();
    androidInstaller.close(); androidInstaller.start(target); await settle();
    expect(mocks.download).toHaveBeenCalledOnce();
    finishRemoval(); await settle();
    expect(mocks.download).toHaveBeenCalledTimes(2);
    expect(androidInstaller.getSnapshot().phase).toBe('ready');
    const installed = mocks.native.install.mock.calls[1][0];
    expect(mocks.files.has(installed)).toBe(true);
  });

  it('waits for the foreground before opening installation', async () => {
    mocks.state.currentState = 'background'; androidInstaller.start(target); await settle();
    expect(mocks.native.install).not.toHaveBeenCalled();
    mocks.state.currentState = 'active'; mocks.appStateListener!('active'); await settle();
    expect(mocks.native.install).toHaveBeenCalledOnce();
    expect(mocks.unsubscribe).toHaveBeenCalledOnce();
  });

  it('cancelling a background handoff prevents later installation', async () => {
    mocks.state.currentState = 'background'; androidInstaller.start(target); await settle();
    androidInstaller.close(); await settle();
    expect(mocks.unsubscribe).toHaveBeenCalledOnce();
    expect(mocks.native.install).not.toHaveBeenCalled();
    expect(androidInstaller.getSnapshot().phase).toBe('idle');
  });
});
