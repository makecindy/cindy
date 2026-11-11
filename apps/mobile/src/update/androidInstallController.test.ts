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
    waitForForeground: vi.fn(async () => undefined),
    install: vi.fn(async () => undefined),
    remove: vi.fn(async () => undefined),
    openBrowser: vi.fn(async () => undefined),
    ...overrides,
  };
  return { io, controller: new AndroidInstallController(io) };
}

describe('Android in-app installation', () => {
  // PR #6977 discussion_r4359353797 (unit): the previous Later fix also
  // suppressed Cancel. Drive manual close -> automatic rediscovery -> stale
  // resolve/reject; existing tests only reopened manually, bypassing suppression.
  it.each(['downloading', 'installing'] as const)('Cancel during %s still allows automatic rediscovery', async (phase) => {
    const oldDownload = deferred<string>();
    const oldInstall = deferred<void>();
    let oldSignal!: AbortSignal;
    let waitingDownload = phase === 'downloading';
    const { controller, io } = setup({
      hasPermission: vi.fn(async () => true),
      download: vi.fn(async (_url: string, signal: AbortSignal) => {
        if (waitingDownload) {
          waitingDownload = false;
          oldSignal = signal;
          return oldDownload.promise;
        }
        return file;
      }),
      install: vi.fn(async (_file: string, _version: string, signal: AbortSignal) => {
        oldSignal = signal;
        return oldInstall.promise;
      }),
    });
    controller.start(target); await settle();
    expect(controller.getSnapshot().phase).toBe(phase);
    controller.close();
    expect(oldSignal.aborted).toBe(true);
    controller.start(target, { automatic: true }); await settle();
    expect(controller.getSnapshot().phase).toBe('ready');
    if (phase === 'downloading') oldDownload.resolve(file);
    else oldInstall.reject(new Error('cancelled old install'));
    await settle();
    expect(controller.getSnapshot().phase).toBe('ready');
    expect(io.install).toHaveBeenCalledTimes(phase === 'installing' ? 1 : 0);
  });

  it('replacing a ready target does not count as choosing Later', async () => {
    const { controller } = setup();
    const newer = { ...target, version: '1.2.4' };
    controller.start(target, { automatic: true }); await settle();
    controller.start(newer, { automatic: true }); await settle();
    controller.start(target, { automatic: true }); await settle();
    expect(controller.getSnapshot()).toMatchObject({ phase: 'ready', target });
  });

  // PR #6977: permission/denial cards also expose Later. Existing dismissal
  // coverage only closed ready; the same target must stay suppressed here too.
  it.each([false, true])('remembers Later from the permission card (denied=%s)', async (denied) => {
    const { controller } = setup({ requestPermission: vi.fn(async () => false) });
    controller.start(target, { automatic: true }); await settle();
    controller.retry(); await settle();
    if (denied) { controller.retry(); await settle(); }
    expect(controller.getSnapshot().phase).toBe(denied ? 'permission-denied' : 'permission-required');
    controller.close();
    controller.start(target, { automatic: true }); await settle();
    expect(controller.getSnapshot().phase).toBe('idle');
    controller.start(target); await settle();
    expect(controller.getSnapshot().phase).toBe('permission-required');
  });
  // Unit: automatic discovery must download before prompting, without asking for
  // install permission. Existing manual-entry tests do not exercise this ordering.
  it('offers a completed automatic download only in the foreground, then asks for permission on tap', async () => {
    const foreground = deferred<void>();
    const { controller, io } = setup({ waitForForeground: () => foreground.promise });
    controller.start(target, { automatic: true });
    await settle();
    expect(controller.getSnapshot()).toMatchObject({ silent: true, phase: 'downloading' });
    expect(io.hasPermission).not.toHaveBeenCalled();
    expect(io.install).not.toHaveBeenCalled();
    foreground.resolve(); await settle();
    expect(controller.getSnapshot()).toMatchObject({ phase: 'ready', progress: 1 });
    expect(controller.getSnapshot().silent).not.toBe(true);
    controller.retry(); await settle();
    expect(controller.getSnapshot().phase).toBe('permission-required');
    controller.retry(); await settle();
    expect(io.install).toHaveBeenCalledOnce();
    expect(io.download).toHaveBeenCalledOnce();
  });

  it('keeps automatic failures quiet and allows a later discovery to retry', async () => {
    const { controller } = setup({ download: vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(file) });
    controller.start(target, { automatic: true }); await settle();
    expect(controller.getSnapshot().phase).toBe('idle');
    controller.start(target, { automatic: true }); await settle();
    expect(controller.getSnapshot().phase).toBe('ready');
    controller.close();
    controller.start(target, { automatic: true }); await settle();
    expect(controller.getSnapshot().phase).toBe('idle');
    controller.start({ ...target, version: '1.2.4' }, { automatic: true }); await settle();
    expect(controller.getSnapshot().target?.version).toBe('1.2.4');
  });

  it('replaces a silent obsolete target and ignores its late completion', async () => {
    const old = deferred<string>();
    const { controller, io } = setup({ download: vi.fn().mockImplementationOnce(() => old.promise).mockResolvedValue(file) });
    controller.start(target, { automatic: true }); await settle();
    controller.start({ ...target, version: '1.2.4' }, { automatic: true }); await settle();
    old.resolve('old.apk'); await settle();
    expect(controller.getSnapshot()).toMatchObject({ phase: 'ready', target: { version: '1.2.4' } });
    expect(io.install).not.toHaveBeenCalled();
  });

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

  it('a discovered update waits on the offer card before downloading', async () => {
    const { controller, io } = setup({ hasPermission: vi.fn(async () => true) });
    controller.start({ ...target, releaseNotes: 'Notes' }, { confirm: true });
    await settle();
    expect(controller.getSnapshot()).toMatchObject({ phase: 'offer', target: { releaseNotes: 'Notes' } });
    expect(io.download).not.toHaveBeenCalled();
    controller.retry();
    await settle();
    expect(io.download).toHaveBeenCalledOnce();
    expect(controller.getSnapshot().phase).toBe('ready');
  });

  it('without permission the offer explains it first, and granting continues straight to the download', async () => {
    const { controller, io } = setup();
    controller.start(target, { confirm: true });
    await settle();
    expect(controller.getSnapshot().phase).toBe('permission-required');
    expect(io.requestPermission).not.toHaveBeenCalled();
    controller.retry();
    await settle();
    expect(io.requestPermission).toHaveBeenCalledOnce();
    expect(io.download).toHaveBeenCalledOnce();
    expect(controller.getSnapshot().phase).toBe('ready');
  });

  it('dismissing an offer forgets it; the next discovery asks again', async () => {
    const { controller, io } = setup({ hasPermission: vi.fn(async () => true) });
    controller.start(target, { confirm: true });
    await settle();
    controller.close();
    expect(controller.getSnapshot().phase).toBe('idle');
    controller.start(target, { confirm: true });
    await settle();
    expect(controller.getSnapshot().phase).toBe('offer');
    expect(io.download).not.toHaveBeenCalled();
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
    expect(io.remove).not.toHaveBeenCalled(); // The completed target cache remains reusable.
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
    expect(io.remove).not.toHaveBeenCalled(); // The downloader cleans obsolete targets.
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
