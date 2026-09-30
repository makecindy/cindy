import { describe, expect, it, vi } from 'vitest';
import { AndroidInstallController, isDirectApkUrl, type AndroidInstallIO } from './androidInstallController';

const target = { version: '1.2.3', installUrl: 'https://updates.example.invalid/app.apk' };
const file = 'file:///cache/cindy-updates/update-1-abc.apk';
const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function setup(overrides: Partial<AndroidInstallIO> = {}) {
  const io = {
    supported: vi.fn(() => true),
    hasPermission: vi.fn(async () => false),
    requestPermission: vi.fn(async () => true),
    download: vi.fn(async () => file),
    install: vi.fn(async () => undefined),
    remove: vi.fn(async () => undefined),
    openBrowser: vi.fn(async () => undefined),
    ...overrides,
  };
  return { io, controller: new AndroidInstallController(io) };
}

describe('Android in-app installation', () => {
  it('explains the permission before opening settings; only the explicit action requests it', async () => {
    const { controller, io } = setup();
    expect(controller.start(target)).toBe(true);
    await settle();
    expect(controller.getSnapshot().phase).toBe('permission-required');
    expect(io.requestPermission).not.toHaveBeenCalled();
    expect(io.download).not.toHaveBeenCalled();
    controller.retry();
    await settle();
    expect(io.requestPermission).toHaveBeenCalledOnce();
    expect(io.install).toHaveBeenCalledWith(file, target.version, expect.any(AbortSignal));
    expect(controller.getSnapshot().phase).toBe('ready');
    controller.close();
    expect(io.remove).not.toHaveBeenCalled(); // Android still owns the handoff.
  });

  it('already-authorized users download directly and installer cancellation can reuse the APK', async () => {
    const { controller, io } = setup({ hasPermission: vi.fn(async () => true) });
    controller.start(target);
    await settle();
    expect(io.requestPermission).not.toHaveBeenCalled();
    expect(controller.getSnapshot().phase).toBe('ready');
    controller.retry();
    await settle();
    expect(io.download).toHaveBeenCalledOnce();
    expect(io.install).toHaveBeenCalledTimes(2);
  });

  it('denial never downloads or reopens settings automatically, and the browser remains usable', async () => {
    const { controller, io } = setup({ requestPermission: vi.fn(async () => false) });
    controller.start(target);
    await settle();
    controller.retry();
    await settle();
    expect(controller.getSnapshot().phase).toBe('permission-denied');
    expect(io.download).not.toHaveBeenCalled();
    expect(io.openBrowser).not.toHaveBeenCalled();
    await controller.browser();
    expect(io.openBrowser).toHaveBeenCalledWith(target.installUrl);
    expect(controller.getSnapshot().phase).toBe('idle');
  });

  it('allows browser download before granting permission', async () => {
    const { controller, io } = setup();
    controller.start(target);
    await settle();
    await controller.browser();
    expect(io.requestPermission).not.toHaveBeenCalled();
    expect(io.openBrowser).toHaveBeenCalledOnce();
  });

  it('closing while settings are open prevents a late grant from starting a download', async () => {
    const permission = deferred<boolean>();
    const { controller, io } = setup({ requestPermission: vi.fn(() => permission.promise) });
    controller.start(target);
    await settle();
    controller.retry();
    await settle();
    controller.close();
    permission.resolve(true);
    await settle();
    expect(io.download).not.toHaveBeenCalled();
    expect(controller.getSnapshot().phase).toBe('idle');
    controller.start(target);
    await settle();
    expect(controller.getSnapshot().phase).toBe('permission-required');
  });

  it('deduplicates startup/settings/forced-gate clicks and ignores cancelled download callbacks', async () => {
    const downloaded = deferred<string>();
    let signal!: AbortSignal;
    let progress!: (value: number | null) => void;
    const { controller, io } = setup({
      hasPermission: vi.fn(async () => true),
      download: vi.fn((_url, s, p) => { signal = s; progress = p; return downloaded.promise; }),
    });
    controller.start(target);
    controller.start(target);
    await settle();
    controller.retry();
    expect(io.download).toHaveBeenCalledOnce();
    progress(0.4);
    expect(controller.getSnapshot().progress).toBe(0.4);
    controller.close();
    expect(signal.aborted).toBe(true);
    progress(0.8);
    downloaded.resolve(file);
    await settle();
    expect(controller.getSnapshot().phase).toBe('idle');
    expect(io.install).not.toHaveBeenCalled();
    expect(io.remove).toHaveBeenCalledWith(file);
  });

  it('an immediate restart after cancellation is not swallowed or overwritten by the old download', async () => {
    const old = deferred<string>();
    const download = vi.fn().mockImplementationOnce(() => old.promise).mockResolvedValue(file);
    const { controller, io } = setup({ hasPermission: vi.fn(async () => true), download });
    controller.start(target);
    await settle();
    controller.close();
    controller.start(target);
    await settle();
    expect(controller.getSnapshot().phase).toBe('ready');
    old.resolve('file:///cache/cindy-updates/old.apk');
    await settle();
    expect(controller.getSnapshot().phase).toBe('ready');
    expect(io.install).toHaveBeenCalledOnce();
    expect(io.remove).toHaveBeenCalledWith('file:///cache/cindy-updates/old.apk');
  });

  it('a download failure offers retry and browser fallback without unhandled rejections', async () => {
    const download = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(file);
    const { controller, io } = setup({ hasPermission: vi.fn(async () => true), download });
    controller.start(target);
    await settle();
    expect(controller.getSnapshot().phase).toBe('error');
    controller.retry();
    await settle();
    expect(io.install).toHaveBeenCalledOnce();
    expect(controller.getSnapshot().phase).toBe('ready');
  });

  it('a rejected APK handoff removes the unusable file and retries with a new download', async () => {
    const install = vi.fn().mockRejectedValueOnce(new Error('invalid APK')).mockResolvedValue(undefined);
    const { controller, io } = setup({ hasPermission: vi.fn(async () => true), install });
    controller.start(target);
    await settle();
    expect(controller.getSnapshot().phase).toBe('error');
    expect(io.remove).toHaveBeenCalledWith(file);
    controller.retry();
    await settle();
    expect(io.download).toHaveBeenCalledTimes(2);
    expect(controller.getSnapshot().phase).toBe('ready');
  });

  it('settings and browser launch failures leave a retryable state', async () => {
    const { controller } = setup({
      requestPermission: vi.fn(async () => { throw new Error('settings unavailable'); }),
      openBrowser: vi.fn(async () => { throw new Error('browser unavailable'); }),
    });
    controller.start(target);
    await settle();
    controller.retry();
    await settle();
    expect(controller.getSnapshot().phase).toBe('error');
    await controller.browser();
    expect(controller.getSnapshot().phase).toBe('error');
  });

  it('a revoked permission is explained again before retrying installation', async () => {
    const hasPermission = vi.fn().mockResolvedValueOnce(true).mockResolvedValue(false);
    const { controller, io } = setup({ hasPermission });
    controller.start(target);
    await settle();
    controller.retry();
    await settle();
    expect(controller.getSnapshot().phase).toBe('permission-required');
    expect(io.requestPermission).not.toHaveBeenCalled();
    expect(io.install).toHaveBeenCalledOnce();
  });

  it('old binaries and non-APK links retain the original browser route', () => {
    expect(setup({ supported: () => false }).controller.start(target)).toBe(false);
    for (const installUrl of ['https://example.invalid/install', 'http://example.invalid/app.apk', 'file:///app.apk']) {
      expect(setup().controller.start({ ...target, installUrl })).toBe(false);
    }
    expect(isDirectApkUrl('https://example.invalid/app.apk?token=example')).toBe(true);
    expect(isDirectApkUrl('https://user:pass@example.invalid/app.apk')).toBe(false);
  });
});
