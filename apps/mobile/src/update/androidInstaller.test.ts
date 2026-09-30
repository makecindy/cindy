import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const native = {
    isSupported: vi.fn(() => true),
    hasPermission: vi.fn(async () => true),
    requestPermission: vi.fn(async () => true),
    install: vi.fn(async () => undefined),
  };
  return {
    native,
    state: { currentState: 'active' },
    appStateListener: undefined as ((state: string) => void) | undefined,
    onProgress: undefined as ((data: { totalBytesWritten: number; totalBytesExpectedToWrite: number }) => void) | undefined,
    file: '',
    download: vi.fn<() => Promise<{ status: number } | undefined>>(),
    cancel: vi.fn(async () => undefined),
    remove: vi.fn(async () => undefined),
    unsubscribe: vi.fn(),
    browser: vi.fn(async () => undefined),
  };
});
vi.mock('react-native', () => ({
  Platform: { OS: 'android' },
  AppState: {
    get currentState() { return mocks.state.currentState; },
    addEventListener: (_name: string, callback: (state: string) => void) => {
      mocks.appStateListener = callback;
      return { remove: mocks.unsubscribe };
    },
  },
  Linking: { openURL: mocks.browser },
}));
vi.mock('expo-modules-core', () => ({ requireOptionalNativeModule: () => mocks.native }));
vi.mock('expo-file-system/legacy', () => ({
  cacheDirectory: 'file:///cache/',
  makeDirectoryAsync: vi.fn(async () => undefined),
  readDirectoryAsync: vi.fn(async () => []),
  getInfoAsync: vi.fn(),
  deleteAsync: mocks.remove,
  createDownloadResumable: (_url: string, file: string, _options: object, onProgress: typeof mocks.onProgress) => {
    mocks.file = file;
    mocks.onProgress = onProgress;
    return { downloadAsync: mocks.download, cancelAsync: mocks.cancel };
  },
}));
import { androidInstaller } from './androidInstaller';
const target = { installUrl: 'https://updates.example.invalid/app.apk', version: '1.2.3' };
const settle = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  mocks.state.currentState = 'active';
  mocks.download.mockResolvedValue({ status: 200 });
});
afterEach(async () => {
  androidInstaller.close();
  await settle();
  vi.useRealTimers();
});

describe('Android installer IO', () => {
  it('downloads to the private update cache and retains the APK for the system installer', async () => {
    androidInstaller.start(target);
    await settle();
    expect(mocks.file).toMatch(/^file:\/\/\/cache\/cindy-updates\/update-.*\.apk$/);
    expect(mocks.native.install).toHaveBeenCalledWith(mocks.file, target.version);
    expect(mocks.remove).not.toHaveBeenCalled();
    expect(androidInstaller.getSnapshot().phase).toBe('ready');
    mocks.onProgress!({ totalBytesWritten: 100, totalBytesExpectedToWrite: 100 });
    expect(vi.getTimerCount()).toBe(0);
    androidInstaller.close();
    expect(mocks.remove).not.toHaveBeenCalled();
  });

  it('HTTP failures never launch installation and remove partial bytes', async () => {
    mocks.download.mockResolvedValue({ status: 503 });
    androidInstaller.start(target);
    await settle();
    expect(mocks.native.install).not.toHaveBeenCalled();
    expect(mocks.remove).toHaveBeenCalledWith(mocks.file, { idempotent: true });
    expect(androidInstaller.getSnapshot().phase).toBe('error');
  });

  it('stalled downloads time out, cancel the native transfer and expose browser fallback', async () => {
    mocks.download.mockImplementation(() => new Promise(() => undefined));
    androidInstaller.start(target);
    await settle();
    expect(androidInstaller.getSnapshot().phase).toBe('downloading');
    await vi.advanceTimersByTimeAsync(90_000);
    expect(mocks.cancel).toHaveBeenCalled();
    expect(mocks.remove).toHaveBeenCalledWith(mocks.file, { idempotent: true });
    expect(androidInstaller.getSnapshot().phase).toBe('error');
    await androidInstaller.browser();
    expect(mocks.browser).toHaveBeenCalledWith(target.installUrl);
  });

  it('reports unknown length without fake percentages; progress keeps a live download running', async () => {
    mocks.download.mockImplementation(() => new Promise(() => undefined));
    androidInstaller.start(target);
    await settle();
    mocks.onProgress!({ totalBytesWritten: 20, totalBytesExpectedToWrite: -1 });
    expect(androidInstaller.getSnapshot().progress).toBeNull();
    await vi.advanceTimersByTimeAsync(60_000);
    mocks.onProgress!({ totalBytesWritten: 50, totalBytesExpectedToWrite: 100 });
    expect(androidInstaller.getSnapshot().progress).toBe(0.5);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(androidInstaller.getSnapshot().phase).toBe('downloading');
    androidInstaller.close();
    await settle();
    expect(mocks.native.install).not.toHaveBeenCalled();
    expect(mocks.remove).toHaveBeenCalledWith(mocks.file, { idempotent: true });
  });

  it('does not open installation over another app; resuming launches the downloaded update', async () => {
    mocks.state.currentState = 'background';
    androidInstaller.start(target);
    await settle();
    expect(mocks.native.install).not.toHaveBeenCalled();
    mocks.state.currentState = 'active';
    mocks.appStateListener!('active');
    await settle();
    expect(mocks.native.install).toHaveBeenCalledOnce();
    expect(mocks.unsubscribe).toHaveBeenCalledOnce();
  });

  it('cancelling a background handoff removes the listener and prevents later installation', async () => {
    mocks.state.currentState = 'background';
    androidInstaller.start(target);
    await settle();
    androidInstaller.close();
    await settle();
    expect(mocks.unsubscribe).toHaveBeenCalledOnce();
    expect(mocks.native.install).not.toHaveBeenCalled();
    expect(androidInstaller.getSnapshot().phase).toBe('idle');
  });
});
