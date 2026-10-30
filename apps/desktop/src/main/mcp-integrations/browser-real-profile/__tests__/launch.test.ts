import { describe, expect, it, vi } from 'vitest';

import type { BrowserControlRequest, BrowserControlResult } from '@cindy/browser-control-runtime';

import {
  annotateStatusData,
  isOwnLiveManagedBrowser,
  shouldPrepareCopiedLogins,
  shouldStopRememberedLeftover,
  withActiveBrowserProfile,
  wrapRuntimeWithRealProfile,
} from '../launch.js';
import { RealProfileError, type InstalledChromium } from '../types.js';

function result(
  action: BrowserControlRequest['action'],
  data: unknown,
  ok = true,
): BrowserControlResult {
  return { ok, action, status: ok ? 200 : 500, data };
}

function fakeInner(state: { running: boolean; headless?: boolean; starts: number }) {
  return {
    async call(request: BrowserControlRequest): Promise<BrowserControlResult> {
      if (request.action === 'status') {
        return result('status', { running: state.running, headless: state.headless === true });
      }
      if (request.action === 'start') {
        state.starts += 1;
        state.running = true;
        return result('start', { running: true });
      }
      if (request.action === 'open') {
        state.running = true;
        return result('open', { running: true });
      }
      if (request.action === 'stop') {
        state.running = false;
        return result('stop', { stopped: true });
      }
      return result(request.action, {});
    },
  };
}

const chrome: InstalledChromium = {
  kind: 'chrome',
  executablePath: '/chrome',
  userDataDir: '/src',
};

const pick18800 = async () => 18800;

describe('wrapRuntimeWithRealProfile', () => {
  it.each(['start', 'open'] as const)(
    'reports optional copy warnings on %s and status, then clears them on retry',
    async (action) => {
      const state = { running: false, starts: 0 };
      const warnings = [{ database: 'Login Data' as const, reason: 'locked' as const }];
      const snapshotResult = {
        destDir: '/runtime/browser/Cindy-real/user-data',
        sourceKind: 'chrome' as const,
        sourceProfile: 'Default',
        filesCopied: ['Cookies'],
      };
      const snapshot = vi
        .fn()
        .mockResolvedValueOnce({ ...snapshotResult, warnings })
        .mockResolvedValue(snapshotResult);
      const wrapped = wrapRuntimeWithRealProfile(fakeInner(state), {
        isEnabled: () => true,
        getRuntimeDir: () => '/runtime',
        applyConfig: vi.fn(),
        resolveSource: () => chrome,
        snapshot,
        cleanup: vi.fn(),
        pickCdpPort: pick18800,
      });
      const launched = await wrapped.call({ action });
      expect(launched.ok).toBe(true);
      expect(launched.message).toContain('Login Data (database is locked by another process)');
      expect(launched.message).toContain('continue the task without notifying the user');
      expect(launched.data).toMatchObject({ realProfile: { warnings, applied: true } });
      expect((await wrapped.call({ action: 'status' })).data).toMatchObject({
        realProfile: { warnings },
      });

      await wrapped.call({ action: 'stop' });
      expect((await wrapped.call({ action: 'status' })).data).toMatchObject({
        realProfile: { applied: true, warnings },
      });
      const retried = await wrapped.call({ action: 'start' });
      expect(retried.message).toBeUndefined();
      expect(JSON.stringify((await wrapped.call({ action: 'status' })).data)).not.toContain(
        'warnings',
      );
    },
  );

  it.each([
    ['start', 'failure'],
    ['start', 'throw'],
    ['open', 'failure'],
    ['open', 'throw'],
  ] as const)('does not publish snapshot state when %s ends with %s', async (action, outcome) => {
    const warnings = [{ database: 'Login Data' as const, reason: 'locked' as const }];
    let fail = true;
    const wrapped = wrapRuntimeWithRealProfile(
      {
        async call(request) {
          if (request.action === 'status') return result('status', { running: false });
          if (fail && outcome === 'throw') throw new Error('browser launch failed');
          return result(request.action, {}, !fail);
        },
      },
      {
        isEnabled: () => true,
        getRuntimeDir: () => '/runtime',
        applyConfig: vi.fn(),
        resolveSource: () => chrome,
        snapshot: vi.fn().mockResolvedValue({
          destDir: '/runtime/browser/Cindy-real/user-data',
          sourceKind: 'chrome',
          sourceProfile: 'Default',
          filesCopied: ['Cookies'],
          warnings,
        }),
        cleanup: vi.fn(),
        pickCdpPort: pick18800,
      },
    );
    if (outcome === 'throw') {
      await expect(wrapped.call({ action })).rejects.toThrow('browser launch failed');
    } else {
      expect((await wrapped.call({ action })).ok).toBe(false);
    }
    expect((await wrapped.call({ action: 'status' })).data).toMatchObject({
      realProfile: { applied: false, source: null },
    });
    expect(JSON.stringify((await wrapped.call({ action: 'status' })).data)).not.toContain(
      'warnings',
    );
    fail = false;
    expect((await wrapped.call({ action })).data).toMatchObject({
      realProfile: { applied: true, warnings },
    });
  });

  it.each(['open', 'tabs', 'snapshot'] as const)(
    'publishes snapshot state when %s fails after the managed browser is already live',
    async (action) => {
      const warnings = [{ database: 'Login Data' as const, reason: 'locked' as const }];
      let live = false;
      const snapshot = vi.fn().mockResolvedValue({
        destDir: '/runtime/browser/Cindy-real/user-data',
        sourceKind: 'chrome',
        sourceProfile: 'Default',
        filesCopied: ['Cookies'],
        warnings,
      });
      const wrapped = wrapRuntimeWithRealProfile(
        {
          async call(request) {
            if (request.action === 'status') {
              return result(
                'status',
                live
                  ? {
                      running: true,
                      pid: 4321,
                      userDataDir: '/runtime/browser/Cindy-real/user-data',
                    }
                  : { running: false },
              );
            }
            if (request.action === action) {
              live = true;
              return result(request.action, {}, false);
            }
            return result(request.action, {});
          },
        },
        {
          isEnabled: () => true,
          getRuntimeDir: () => '/runtime',
          applyConfig: vi.fn(),
          resolveSource: () => chrome,
          snapshot,
          cleanup: vi.fn(),
          pickCdpPort: pick18800,
        },
      );
      expect((await wrapped.call({ action })).ok).toBe(false);
      expect((await wrapped.call({ action: 'status' })).data).toMatchObject({
        realProfile: { applied: true, source: 'chrome', warnings },
      });
      expect((await wrapped.call({ action: 'start' })).ok).toBe(true);
      expect(snapshot).toHaveBeenCalledOnce();
    },
  );

  it.each(['open', 'tabs'] as const)(
    'publishes snapshot state when %s throws after the managed browser is already live',
    async (action) => {
      const warnings = [{ database: 'Web Data' as const, reason: 'copy-failed' as const }];
      let live = false;
      const snapshot = vi.fn().mockResolvedValue({
        destDir: '/runtime/browser/Cindy-real/user-data',
        sourceKind: 'chrome',
        sourceProfile: 'Default',
        filesCopied: ['Cookies'],
        warnings,
      });
      const wrapped = wrapRuntimeWithRealProfile(
        {
          async call(request) {
            if (request.action === 'status') {
              return result(
                'status',
                live
                  ? {
                      running: true,
                      pid: 4321,
                      userDataDir: '/runtime/browser/Cindy-real/user-data',
                    }
                  : { running: false },
              );
            }
            if (request.action === action) {
              live = true;
              throw new Error('page action failed');
            }
            return result(request.action, {});
          },
        },
        {
          isEnabled: () => true,
          getRuntimeDir: () => '/runtime',
          applyConfig: vi.fn(),
          resolveSource: () => chrome,
          snapshot,
          cleanup: vi.fn(),
          pickCdpPort: pick18800,
        },
      );
      await expect(wrapped.call({ action })).rejects.toThrow('page action failed');
      expect((await wrapped.call({ action: 'status' })).data).toMatchObject({
        realProfile: { applied: true, source: 'chrome', warnings },
      });
      expect((await wrapped.call({ action: 'start' })).ok).toBe(true);
      expect(snapshot).toHaveBeenCalledOnce();
    },
  );

  it('keeps snapshot state when stop returns ok but the managed browser is still live', async () => {
    const warnings = [{ database: 'Login Data' as const, reason: 'locked' as const }];
    let live = false;
    const snapshot = vi.fn().mockResolvedValue({
      destDir: '/runtime/browser/Cindy-real/user-data',
      sourceKind: 'chrome',
      sourceProfile: 'Default',
      filesCopied: ['Cookies'],
      warnings,
    });
    const wrapped = wrapRuntimeWithRealProfile(
      {
        async call(request) {
          if (request.action === 'status') {
            return result(
              'status',
              live
                ? {
                    running: true,
                    pid: 4321,
                    userDataDir: '/runtime/browser/Cindy-real/user-data',
                  }
                : { running: false },
            );
          }
          if (request.action === 'start') {
            live = true;
            return result('start', {});
          }
          if (request.action === 'stop') {
            return result('stop', { stopped: true });
          }
          return result(request.action, {});
        },
      },
      {
        isEnabled: () => true,
        getRuntimeDir: () => '/runtime',
        applyConfig: vi.fn(),
        resolveSource: () => chrome,
        snapshot,
        cleanup: vi.fn(),
        pickCdpPort: pick18800,
      },
    );
    expect((await wrapped.call({ action: 'start' })).ok).toBe(true);
    expect((await wrapped.call({ action: 'stop' })).ok).toBe(true);
    expect((await wrapped.call({ action: 'status' })).data).toMatchObject({
      realProfile: { applied: true, source: 'chrome', warnings },
    });
    expect((await wrapped.call({ action: 'start' })).ok).toBe(true);
    expect(snapshot).toHaveBeenCalledOnce();
    live = false;
    expect((await wrapped.call({ action: 'status' })).data).toMatchObject({
      realProfile: { applied: true, source: 'chrome', warnings },
    });
  });

  it('keeps snapshot state when stop fails while the managed browser is still live', async () => {
    const warnings = [{ database: 'Web Data' as const, reason: 'copy-failed' as const }];
    let live = false;
    const snapshot = vi.fn().mockResolvedValue({
      destDir: '/runtime/browser/Cindy-real/user-data',
      sourceKind: 'chrome',
      sourceProfile: 'Default',
      filesCopied: ['Cookies'],
      warnings,
    });
    const wrapped = wrapRuntimeWithRealProfile(
      {
        async call(request) {
          if (request.action === 'status') {
            return result(
              'status',
              live
                ? {
                    running: true,
                    pid: 4321,
                    userDataDir: '/runtime/browser/Cindy-real/user-data',
                  }
                : { running: false },
            );
          }
          if (request.action === 'start') {
            live = true;
            return result('start', {});
          }
          if (request.action === 'stop') {
            return result('stop', { stopped: false }, false);
          }
          return result(request.action, {});
        },
      },
      {
        isEnabled: () => true,
        getRuntimeDir: () => '/runtime',
        applyConfig: vi.fn(),
        resolveSource: () => chrome,
        snapshot,
        cleanup: vi.fn(),
        pickCdpPort: pick18800,
      },
    );
    expect((await wrapped.call({ action: 'start' })).ok).toBe(true);
    expect((await wrapped.call({ action: 'stop' })).ok).toBe(false);
    expect((await wrapped.call({ action: 'status' })).data).toMatchObject({
      realProfile: { applied: true, source: 'chrome', warnings },
    });
  });

  it('clears optional warnings after a later cookie copy failure and when disabled', async () => {
    let enabled = true;
    const snapshot = vi
      .fn()
      .mockResolvedValueOnce({
        destDir: '/runtime/browser/Cindy-real/user-data',
        sourceKind: 'chrome',
        sourceProfile: 'Default',
        filesCopied: ['Cookies'],
        warnings: [{ database: 'Web Data', reason: 'copy-failed' }],
      })
      .mockRejectedValue(new RealProfileError('PROFILE_LOCKED', 'Cookie database is locked'));
    const wrapped = wrapRuntimeWithRealProfile(fakeInner({ running: false, starts: 0 }), {
      isEnabled: () => enabled,
      getRuntimeDir: () => '/runtime',
      applyConfig: vi.fn(),
      resolveSource: () => chrome,
      snapshot,
      cleanup: vi.fn(),
      pickCdpPort: pick18800,
    });
    expect((await wrapped.call({ action: 'start' })).ok).toBe(true);
    enabled = false;
    expect(JSON.stringify((await wrapped.call({ action: 'status' })).data)).not.toContain(
      'warnings',
    );
    enabled = true;
    expect((await wrapped.call({ action: 'start' })).ok).toBe(false);
    expect(JSON.stringify((await wrapped.call({ action: 'status' })).data)).not.toContain(
      'warnings',
    );
  });

  it('retains warnings when reopening the live browser without resnapshotting', async () => {
    let running = false;
    const snapshot = vi.fn().mockResolvedValue({
      destDir: '/runtime/browser/Cindy-real/user-data',
      sourceKind: 'chrome',
      sourceProfile: 'Default',
      filesCopied: ['Cookies'],
      warnings: [{ database: 'Login Data', reason: 'locked' }],
    });
    const wrapped = wrapRuntimeWithRealProfile(
      {
        async call(request) {
          if (request.action === 'status')
            return result(
              'status',
              running
                ? { running: true, pid: 1234, userDataDir: '/runtime/browser/Cindy-real/user-data' }
                : { running: false },
            );
          running = true;
          return result(request.action, {});
        },
      },
      {
        isEnabled: () => true,
        getRuntimeDir: () => '/runtime',
        applyConfig: vi.fn(),
        resolveSource: () => chrome,
        snapshot,
        cleanup: vi.fn(),
        pickCdpPort: pick18800,
      },
    );
    await wrapped.call({ action: 'start' });
    expect((await wrapped.call({ action: 'start' })).message).toContain('Login Data');
    expect((await wrapped.call({ action: 'navigate' })).message).toBeUndefined();
    expect(snapshot).toHaveBeenCalledOnce();
  });

  it('snapshots then starts when consent is on and the browser is stopped', async () => {
    const inner = fakeInner({ running: false, starts: 0 });
    const applyConfig = vi.fn();
    const snapshot = vi.fn(async () => ({
      destDir: '/runtime/browser/Cindy-real/user-data',
      sourceKind: 'chrome' as const,
      sourceProfile: 'Default',
      filesCopied: ['Local State'],
    }));
    const wrapped = wrapRuntimeWithRealProfile(inner, {
      isEnabled: () => true,
      getRuntimeDir: () => '/runtime',
      applyConfig,
      resolveSource: () => chrome,
      snapshot,
      cleanup: vi.fn(),
      platform: 'darwin',
      pickCdpPort: pick18800,
    });

    const started = await wrapped.call({ action: 'start' });
    expect(started.ok).toBe(true);
    expect(snapshot).toHaveBeenCalledOnce();
    expect(applyConfig).toHaveBeenCalledWith({
      useRealProfile: true,
      executablePath: '/chrome',
      cdpPort: 18800,
    });

    const status = await wrapped.call({ action: 'status' });
    expect(status.data).toMatchObject({
      realProfile: { enabled: true, applied: true, source: 'chrome' },
    });
  });

  it('does not overlay while this instance already launched the managed browser', async () => {
    const inner = {
      async call(request: BrowserControlRequest): Promise<BrowserControlResult> {
        if (request.action === 'status') {
          return result('status', {
            running: true,
            pid: 1234,
            userDataDir: '/runtime/browser/Cindy/user-data',
          });
        }
        if (request.action === 'start') {
          return result('start', { running: true });
        }
        return result(request.action, {});
      },
    };
    const snapshot = vi.fn();
    const applyConfig = vi.fn();
    const wrapped = wrapRuntimeWithRealProfile(inner, {
      isEnabled: () => true,
      getRuntimeDir: () => '/runtime',
      applyConfig,
      resolveSource: () => chrome,
      snapshot,
      cleanup: vi.fn(),
    });
    await wrapped.call({ action: 'start' });
    expect(snapshot).not.toHaveBeenCalled();
    expect(applyConfig).not.toHaveBeenCalled();
  });

  it('does not resnapshot while the managed process exists but CDP is unavailable', async () => {
    const inner = {
      async call(request: BrowserControlRequest): Promise<BrowserControlResult> {
        if (request.action === 'status') {
          return result('status', {
            running: false,
            pid: 1234,
            userDataDir: '/runtime/browser/Cindy-real/user-data',
          });
        }
        return result(request.action, {});
      },
    };
    const snapshot = vi.fn();
    const wrapped = wrapRuntimeWithRealProfile(inner, {
      isEnabled: () => true,
      getRuntimeDir: () => '/runtime',
      applyConfig: vi.fn(),
      resolveSource: () => chrome,
      snapshot,
      cleanup: vi.fn(),
    });

    await wrapped.call({ action: 'start' });

    expect(snapshot).not.toHaveBeenCalled();
  });

  it('keeps the isolated Cindy profile on the fixed CDP port', async () => {
    let started = 0;
    const inner = {
      async call(request: BrowserControlRequest): Promise<BrowserControlResult> {
        if (request.action === 'status') {
          return result('status', { running: true });
        }
        if (request.action === 'start') {
          started += 1;
          return result('start', { running: true });
        }
        return result(request.action, {});
      },
    };
    const applyConfig = vi.fn();
    const pickCdpPort = vi.fn(async () => 18801);
    const wrapped = wrapRuntimeWithRealProfile(inner, {
      isEnabled: () => false,
      getRuntimeDir: () => '/Users/dash/Library/Application Support/Cindy-dev2/browser-runtime',
      applyConfig,
      pickCdpPort,
    });
    const resultStart = await wrapped.call({ action: 'start' });
    expect(resultStart.ok).toBe(true);
    expect(started).toBe(1);
    expect(pickCdpPort).not.toHaveBeenCalled();
    expect(applyConfig).toHaveBeenCalledWith({ useRealProfile: false, cdpPort: 18800 });
  });

  it('cleans the snapshot and does not start a signed-out session on copy failure', async () => {
    const innerState = { running: false, starts: 0 };
    const inner = fakeInner(innerState);
    const wrapped = wrapRuntimeWithRealProfile(inner, {
      isEnabled: () => true,
      getRuntimeDir: () => '/runtime',
      applyConfig: vi.fn(),
      resolveSource: () => chrome,
      snapshot: async () => {
        throw new RealProfileError('NO_AUTH_DB', 'missing cookies');
      },
      cleanup: vi.fn(),
      pickCdpPort: pick18800,
    });
    const started = await wrapped.call({ action: 'start' });
    expect(started.ok).toBe(false);
    expect(started.message).toMatch(/missing cookies/);
    expect(started.data).toEqual({ reason: 'NO_AUTH_DB' });
    expect(innerState.starts).toBe(0);
  });

  it('preserves the App-Bound Encryption reason without starting Chrome', async () => {
    const innerState = { running: false, starts: 0 };
    const inner = fakeInner(innerState);
    const wrapped = wrapRuntimeWithRealProfile(inner, {
      isEnabled: () => true,
      getRuntimeDir: () => '/runtime',
      applyConfig: vi.fn(),
      resolveSource: () => chrome,
      snapshot: async () => {
        throw new RealProfileError(
          'APP_BOUND_ENCRYPTION_UNSUPPORTED',
          'unsupported app-bound cookies',
        );
      },
      cleanup: vi.fn(),
      pickCdpPort: pick18800,
    });

    const started = await wrapped.call({ action: 'start' });

    expect(started).toMatchObject({
      ok: false,
      errorCode: 'BROWSER_RUNTIME_ACTION_FAILED',
      data: { reason: 'APP_BOUND_ENCRYPTION_UNSUPPORTED' },
    });
    expect(innerState.starts).toBe(0);
  });

  it('rejects headless real-profile launches', async () => {
    const inner = fakeInner({ running: false, headless: true, starts: 0 });
    const wrapped = wrapRuntimeWithRealProfile(inner, {
      isEnabled: () => true,
      getRuntimeDir: () => '/runtime',
      applyConfig: vi.fn(),
      resolveSource: () => chrome,
      snapshot: vi.fn(),
      cleanup: vi.fn(),
      pickCdpPort: pick18800,
    });
    const started = await wrapped.call({ action: 'start' });
    expect(started.ok).toBe(false);
    expect(started.message).toMatch(/headless/i);
  });

  it('deletes the snapshot store when consent is off', async () => {
    const inner = fakeInner({ running: false, starts: 0 });
    const cleanup = vi.fn();
    const applyConfig = vi.fn();
    const wrapped = wrapRuntimeWithRealProfile(inner, {
      isEnabled: () => false,
      getRuntimeDir: () => '/runtime',
      applyConfig,
      cleanup,
      snapshot: vi.fn(),
      resolveSource: () => chrome,
      pickCdpPort: pick18800,
    });
    const started = await wrapped.call({ action: 'start' });
    expect(started.ok).toBe(true);
    expect(cleanup).toHaveBeenCalledWith('/runtime');
    expect(applyConfig).toHaveBeenCalledWith({ useRealProfile: false, cdpPort: 18800 });
  });

  it('does not relocate isolated Cindy when leftover Chrome sits on 18800', async () => {
    let started = 0;
    const inner = {
      async call(request: BrowserControlRequest): Promise<BrowserControlResult> {
        if (request.action === 'status') {
          return result('status', {
            running: true,
            userDataDir: '/Users/dash/.xdt-maker/browser-runtime/browser/Cindy/user-data',
          });
        }
        if (request.action === 'start') {
          started += 1;
          return result('start', { running: true });
        }
        return result(request.action, {});
      },
    };
    const applyConfig = vi.fn();
    const pickCdpPort = vi.fn(async () => 18801);
    const wrapped = wrapRuntimeWithRealProfile(inner, {
      isEnabled: () => false,
      getRuntimeDir: () => '/Users/dash/Library/Application Support/Cindy-dev2/browser-runtime',
      applyConfig,
      pickCdpPort,
    });
    const resultStart = await wrapped.call({ action: 'start' });
    expect(resultStart.ok).toBe(true);
    expect(started).toBe(1);
    expect(pickCdpPort).not.toHaveBeenCalled();
    expect(applyConfig).toHaveBeenCalledWith({ useRealProfile: false, cdpPort: 18800 });
  });

  it('snapshots into this runtime when leftover Chrome sits under ~/.xdt-maker', async () => {
    let started = 0;
    let stops = 0;
    const inner = {
      async call(request: BrowserControlRequest): Promise<BrowserControlResult> {
        if (request.action === 'status') {
          return result('status', {
            running: true,
            userDataDir: '/Users/dash/.xdt-maker/browser-runtime/browser/Cindy-real/user-data',
          });
        }
        if (request.action === 'stop') {
          stops += 1;
          return result('stop', { stopped: true });
        }
        if (request.action === 'start') {
          started += 1;
          return result('start', { running: true });
        }
        return result(request.action, {});
      },
    };
    const snapshot = vi.fn(async () => ({
      destDir: '/runtime/browser/Cindy-real/user-data',
      sourceKind: 'chrome' as const,
      sourceProfile: 'Default',
      filesCopied: ['Local State'],
    }));
    const applyConfig = vi.fn();
    const wrapped = wrapRuntimeWithRealProfile(inner, {
      isEnabled: () => true,
      getRuntimeDir: () => '/runtime',
      applyConfig,
      resolveSource: () => chrome,
      snapshot,
      cleanup: vi.fn(),
      platform: 'darwin',
      pickCdpPort: async () => 18801,
      readRememberedCdpPort: () => null,
    });
    const startedResult = await wrapped.call({ action: 'start' });
    expect(startedResult.ok).toBe(true);
    expect(startedResult.errorCode).toBeUndefined();
    expect(started).toBe(1);
    expect(stops).toBe(0);
    expect(snapshot).toHaveBeenCalledOnce();
    expect(applyConfig).toHaveBeenCalledWith({
      useRealProfile: true,
      executablePath: '/chrome',
      cdpPort: 18801,
    });
  });

  it('starts Cindy-real by name after config swap so a stale default Cindy does not miss it', async () => {
    let startedProfile: string | undefined;
    let statusProfile: string | undefined;
    const inner = {
      async call(request: BrowserControlRequest): Promise<BrowserControlResult> {
        if (request.action === 'status') {
          statusProfile = request.profile;
          return result('status', { running: false });
        }
        if (request.action === 'start') {
          startedProfile = request.profile;
          if (request.profile !== 'Cindy-real') {
            return {
              ok: false,
              action: 'start',
              errorCode: 'BROWSER_RUNTIME_ACTION_FAILED',
              message: 'Profile "Cindy" not found. Available profiles: Cindy-real',
            };
          }
          return result('start', { running: true });
        }
        return result(request.action, {});
      },
    };
    const wrapped = wrapRuntimeWithRealProfile(inner, {
      isEnabled: () => true,
      getRuntimeDir: () => '/runtime',
      applyConfig: vi.fn(),
      resolveSource: () => chrome,
      snapshot: vi.fn(async () => ({
        destDir: '/runtime/browser/Cindy-real/user-data',
        sourceKind: 'chrome' as const,
        sourceProfile: 'Default',
        filesCopied: ['Local State'],
      })),
      cleanup: vi.fn(),
      platform: 'darwin',
      pickCdpPort: pick18800,
    });
    const started = await wrapped.call({ action: 'start' });
    expect(started.ok).toBe(true);
    expect(statusProfile).toBe('Cindy-real');
    expect(startedProfile).toBe('Cindy-real');
  });

  it('snapshots before open so implicit ensureBrowserAvailable does not skip the copy', async () => {
    let opened = 0;
    const inner = {
      async call(request: BrowserControlRequest): Promise<BrowserControlResult> {
        if (request.action === 'status') {
          return result('status', { running: false });
        }
        if (request.action === 'open') {
          opened += 1;
          return result('open', { running: true });
        }
        return result(request.action, {});
      },
    };
    const snapshot = vi.fn(async () => ({
      destDir: '/runtime/browser/Cindy-real/user-data',
      sourceKind: 'chrome' as const,
      sourceProfile: 'Default',
      filesCopied: ['Local State'],
    }));
    const applyConfig = vi.fn();
    const wrapped = wrapRuntimeWithRealProfile(inner, {
      isEnabled: () => true,
      getRuntimeDir: () => '/runtime',
      applyConfig,
      resolveSource: () => chrome,
      snapshot,
      cleanup: vi.fn(),
      platform: 'darwin',
      pickCdpPort: pick18800,
    });
    const openedResult = await wrapped.call({ action: 'open', url: 'https://example.com' });
    expect(openedResult.ok).toBe(true);
    expect(opened).toBe(1);
    expect(snapshot).toHaveBeenCalledOnce();
    expect(applyConfig).toHaveBeenCalledWith({
      useRealProfile: true,
      executablePath: '/chrome',
      cdpPort: 18800,
    });
  });

  it('does not snapshot status or a consent-off open', async () => {
    const snapshot = vi.fn();
    const cleanup = vi.fn();
    const applyConfig = vi.fn();
    const inner = fakeInner({ running: false, starts: 0 });
    const wrappedOn = wrapRuntimeWithRealProfile(inner, {
      isEnabled: () => true,
      getRuntimeDir: () => '/runtime',
      applyConfig,
      resolveSource: () => chrome,
      snapshot,
      cleanup,
      pickCdpPort: pick18800,
    });
    await wrappedOn.call({ action: 'status' });
    expect(snapshot).not.toHaveBeenCalled();
    expect(applyConfig).not.toHaveBeenCalled();

    const wrappedOff = wrapRuntimeWithRealProfile(inner, {
      isEnabled: () => false,
      getRuntimeDir: () => '/runtime',
      applyConfig,
      snapshot,
      cleanup,
      pickCdpPort: pick18800,
    });
    await wrappedOff.call({ action: 'open', url: 'https://example.com' });
    expect(snapshot).not.toHaveBeenCalled();
    expect(cleanup).not.toHaveBeenCalled();
    expect(applyConfig).not.toHaveBeenCalled();
  });

  it('stops a remembered Cindy-real leftover before snapshotting after a crash', async () => {
    const innerState = { running: true, starts: 0, stops: 0 };
    const requests: BrowserControlRequest[] = [];
    const inner = {
      async call(request: BrowserControlRequest): Promise<BrowserControlResult> {
        requests.push(request);
        if (request.action === 'status') {
          return result('status', { running: innerState.running });
        }
        if (request.action === 'stop') {
          innerState.stops += 1;
          innerState.running = false;
          return result('stop', { stopped: true });
        }
        if (request.action === 'start') {
          innerState.starts += 1;
          return result('start', { running: true });
        }
        return result(request.action, {});
      },
    };
    const snapshot = vi.fn(async () => ({
      destDir: '/runtime/browser/Cindy-real/user-data',
      sourceKind: 'chrome' as const,
      sourceProfile: 'Default',
      filesCopied: ['Local State'],
    }));
    const applyConfig = vi.fn();
    const wrapped = wrapRuntimeWithRealProfile(inner, {
      isEnabled: () => true,
      getRuntimeDir: () => '/runtime',
      applyConfig,
      resolveSource: () => chrome,
      snapshot,
      cleanup: vi.fn(),
      platform: 'darwin',
      pickCdpPort: pick18800,
      readRememberedCdpPort: () => 18801,
    });
    const started = await wrapped.call({ action: 'start' });
    expect(started.ok).toBe(true);
    expect(requests.slice(0, 2)).toEqual([
      { action: 'status', profile: 'Cindy-real' },
      { action: 'stop', profile: 'Cindy-real' },
    ]);
    expect(innerState.stops).toBe(1);
    expect(innerState.starts).toBe(1);
    expect(snapshot).toHaveBeenCalledOnce();
    expect(applyConfig).toHaveBeenCalledWith({
      useRealProfile: true,
      executablePath: '/chrome',
      cdpPort: 18800,
    });
  });

  it('does not snapshot when a remembered leftover cannot be stopped', async () => {
    const inner = {
      async call(request: BrowserControlRequest): Promise<BrowserControlResult> {
        if (request.action === 'status') {
          return result('status', { running: true });
        }
        if (request.action === 'stop') {
          return result('stop', { stopped: false });
        }
        return result(request.action, {});
      },
    };
    const snapshot = vi.fn();
    const wrapped = wrapRuntimeWithRealProfile(inner, {
      isEnabled: () => true,
      getRuntimeDir: () => '/runtime',
      applyConfig: vi.fn(),
      resolveSource: () => chrome,
      snapshot,
      cleanup: vi.fn(),
      pickCdpPort: pick18800,
      readRememberedCdpPort: () => 18801,
    });
    const started = await wrapped.call({ action: 'start' });
    expect(started.ok).toBe(false);
    expect(started.message).toMatch(/stop/i);
    expect(snapshot).not.toHaveBeenCalled();
  });

  it('discards an in-flight snapshot when consent is revoked before apply', async () => {
    let enabled = true;
    let startedProfile: string | undefined;
    const inner = {
      async call(request: BrowserControlRequest): Promise<BrowserControlResult> {
        if (request.action === 'status') {
          return result('status', { running: false });
        }
        if (request.action === 'start') {
          startedProfile = request.profile;
          return result('start', { running: true });
        }
        return result(request.action, {});
      },
    };
    const snapshot = vi.fn(async () => {
      enabled = false;
      return {
        destDir: '/runtime/browser/Cindy-real/user-data',
        sourceKind: 'chrome' as const,
        sourceProfile: 'Default',
        filesCopied: ['Local State'],
      };
    });
    const cleanup = vi.fn();
    const applyConfig = vi.fn();
    const wrapped = wrapRuntimeWithRealProfile(inner, {
      isEnabled: () => enabled,
      getRuntimeDir: () => '/runtime',
      applyConfig,
      resolveSource: () => chrome,
      snapshot,
      cleanup,
      platform: 'darwin',
      pickCdpPort: pick18800,
    });
    const started = await wrapped.call({ action: 'start' });
    expect(started.ok).toBe(true);
    expect(snapshot).toHaveBeenCalledOnce();
    expect(cleanup).toHaveBeenCalledWith('/runtime');
    expect(applyConfig).toHaveBeenCalledWith({ useRealProfile: false, cdpPort: 18800 });
    expect(applyConfig).not.toHaveBeenCalledWith(expect.objectContaining({ useRealProfile: true }));
    expect(startedProfile).toBe('Cindy');
  });
});

describe('shouldStopRememberedLeftover', () => {
  it('stops only a consent-on leftover on a remembered Cindy-real port', () => {
    expect(
      shouldStopRememberedLeftover({
        enabled: true,
        running: true,
        ownLive: false,
        rememberedCdpPort: 18801,
      }),
    ).toBe(true);
    expect(
      shouldStopRememberedLeftover({
        enabled: true,
        running: true,
        ownLive: true,
        rememberedCdpPort: 18801,
      }),
    ).toBe(false);
    expect(
      shouldStopRememberedLeftover({
        enabled: true,
        running: true,
        ownLive: false,
        rememberedCdpPort: null,
      }),
    ).toBe(false);
    expect(
      shouldStopRememberedLeftover({
        enabled: false,
        running: true,
        ownLive: false,
        rememberedCdpPort: 18801,
      }),
    ).toBe(false);
  });
});

describe('shouldPrepareCopiedLogins', () => {
  it('gates every consent-on action except status and stop', () => {
    expect(shouldPrepareCopiedLogins('start', false)).toBe(true);
    expect(shouldPrepareCopiedLogins('open', false)).toBe(false);
    expect(shouldPrepareCopiedLogins('open', true)).toBe(true);
    expect(shouldPrepareCopiedLogins('tabs', true)).toBe(true);
    expect(shouldPrepareCopiedLogins('status', true)).toBe(false);
    expect(shouldPrepareCopiedLogins('stop', true)).toBe(false);
  });
});

describe('withActiveBrowserProfile', () => {
  it('pins Cindy-real when consent is on and leaves an explicit profile alone', () => {
    expect(withActiveBrowserProfile({ action: 'start' }, true).profile).toBe('Cindy-real');
    expect(withActiveBrowserProfile({ action: 'start' }, false).profile).toBe('Cindy');
    expect(withActiveBrowserProfile({ action: 'tabs', profile: 'Cindy' }, true).profile).toBe(
      'Cindy',
    );
  });
});

describe('isOwnLiveManagedBrowser', () => {
  it('requires a live pid under this runtime, not just a running CDP port', () => {
    const runtimeDir = '/runtime';
    expect(isOwnLiveManagedBrowser({ running: true }, runtimeDir)).toBe(false);
    expect(
      isOwnLiveManagedBrowser(
        { running: true, userDataDir: '/runtime/browser/Cindy/user-data' },
        runtimeDir,
      ),
    ).toBe(false);
    expect(
      isOwnLiveManagedBrowser(
        { running: true, pid: 99, userDataDir: '/elsewhere/Cindy/user-data' },
        runtimeDir,
      ),
    ).toBe(false);
    expect(
      isOwnLiveManagedBrowser(
        { running: true, pid: 99, userDataDir: '/runtime/browser/Cindy/user-data' },
        runtimeDir,
      ),
    ).toBe(true);
  });
});

describe('annotateStatusData', () => {
  it('adds the boolean hint and never forwards a snapshot path', () => {
    expect(
      annotateStatusData(
        { running: true, realProfilePath: '/secret' },
        { enabled: true, applied: true, source: 'chrome' },
      ),
    ).toEqual({
      running: true,
      realProfile: { enabled: true, applied: true, source: 'chrome' },
    });
  });
});
