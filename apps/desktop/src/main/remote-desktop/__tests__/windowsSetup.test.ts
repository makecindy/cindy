import { describe, expect, it, vi } from 'vitest';
import { WindowsDesktopSetup } from '../windowsSetup';
import type { WindowsDesktopSetupPhase } from '../../../shared/remoteDesktop';

describe('Windows setup lifetime', () => {
  it('keeps the real phase across page mounts and joins repeated clicks without another side effect', async () => {
    let progress!: (phase: WindowsDesktopSetupPhase) => void;
    let finish!: () => void;
    const configure = vi.fn((_enabled, update) => {
      progress = update;
      return new Promise<void>((resolve) => {
        finish = resolve;
      });
    });
    const stopDesktop = vi.fn();
    const service = new WindowsDesktopSetup({ configure, stopDesktop, now: () => 100 });
    const first = service.run(true);
    expect(service.read()).toMatchObject({ phase: 'preparing', startedAt: 100 });
    await Promise.resolve();
    progress('compilingHost');
    const secondPage = service.read();
    expect(secondPage).toMatchObject({ phase: 'compilingHost', error: null });
    expect(service.run(true)).toBe(first);
    await expect(service.run(false)).rejects.toThrow('DESKTOP_SETUP_BUSY');
    expect(configure).toHaveBeenCalledOnce();
    expect(stopDesktop).toHaveBeenCalledOnce();
    progress('authorizing');
    expect(service.read().revision).toBeGreaterThan(secondPage.revision);
    finish();
    await first;
    expect(service.read()).toMatchObject({ phase: null, error: null });
  });

  it('retains a failed preparation for a reopened page, unlocks retry and ignores old callbacks', async () => {
    let oldProgress!: (phase: WindowsDesktopSetupPhase) => void;
    const configure = vi
      .fn()
      .mockImplementationOnce(async (_enabled, update) => {
        oldProgress = update;
        throw new Error('DESKTOP_NATIVE_BUILD_FAILED');
      })
      .mockImplementationOnce(async (_enabled, update) => {
        update('authorizing');
        oldProgress('compilingInput');
        expect(service.read().phase).toBe('authorizing');
      });
    const service = new WindowsDesktopSetup({ configure, stopDesktop: vi.fn() });
    await expect(service.run(true)).rejects.toThrow('DESKTOP_NATIVE_BUILD_FAILED');
    expect(service.read()).toMatchObject({
      phase: null,
      error: 'prepare',
      failedEnabled: true,
    });
    await service.run(true);
    expect(service.read()).toMatchObject({ phase: null, error: null });
    expect(configure).toHaveBeenCalledTimes(2);
  });

  it('releases setup even when stopping the existing desktop fails', async () => {
    const stopDesktop = vi.fn().mockImplementationOnce(() => {
      throw new Error('stop failed');
    });
    const configure = vi.fn(async () => {});
    const service = new WindowsDesktopSetup({ configure, stopDesktop });
    await expect(service.run(true)).rejects.toThrow('stop failed');
    expect(service.read()).toMatchObject({ phase: null, error: 'setup', failedEnabled: true });
    await service.run(true);
    expect(configure).toHaveBeenCalledOnce();
  });

  it('keeps a failed uninstall directed at removal so retry cannot reinstall', async () => {
    const configure = vi.fn(async () => {
      throw new Error('ACL restore failed');
    });
    const service = new WindowsDesktopSetup({ configure, stopDesktop: vi.fn() });
    await expect(service.run(false)).rejects.toThrow('ACL restore failed');
    expect(service.read()).toMatchObject({
      phase: null,
      error: 'setup',
      failedEnabled: false,
    });
  });
});
