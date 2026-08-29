import { describe, expect, it, vi } from 'vitest';

import type { BrowserControlRequest, BrowserControlResult } from '@cindy/browser-control-runtime';

import {
  annotateStatusData,
  isOwnLiveManagedBrowser,
  shouldPrepareCopiedLogins,
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

  it('relocates CDP when another instance occupies 18800 without a userDataDir', async () => {
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
    const wrapped = wrapRuntimeWithRealProfile(inner, {
      isEnabled: () => false,
      getRuntimeDir: () => '/Users/dash/Library/Application Support/Cindy-dev2/browser-runtime',
      applyConfig,
      pickCdpPort: async () => 18801,
    });
    const resultStart = await wrapped.call({ action: 'start' });
    expect(resultStart.ok).toBe(true);
    expect(started).toBe(1);
    expect(applyConfig).toHaveBeenCalledWith({ useRealProfile: false, cdpPort: 18801 });
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

  it('launches on a free CDP port when another Cindy already holds 18800', async () => {
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
    const wrapped = wrapRuntimeWithRealProfile(inner, {
      isEnabled: () => false,
      getRuntimeDir: () => '/Users/dash/Library/Application Support/Cindy-dev2/browser-runtime',
      applyConfig,
      pickCdpPort: async () => 18801,
    });
    const resultStart = await wrapped.call({ action: 'start' });
    expect(resultStart.ok).toBe(true);
    expect(started).toBe(1);
    expect(applyConfig).toHaveBeenCalledWith({ useRealProfile: false, cdpPort: 18801 });
  });

  it('snapshots into this runtime when leftover Chrome sits under ~/.xdt-maker', async () => {
    let started = 0;
    const inner = {
      async call(request: BrowserControlRequest): Promise<BrowserControlResult> {
        if (request.action === 'status') {
          return result('status', {
            running: true,
            userDataDir: '/Users/dash/.xdt-maker/browser-runtime/browser/Cindy-real/user-data',
          });
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
    });
    const startedResult = await wrapped.call({ action: 'start' });
    expect(startedResult.ok).toBe(true);
    expect(startedResult.errorCode).toBeUndefined();
    expect(started).toBe(1);
    expect(snapshot).toHaveBeenCalledOnce();
    expect(applyConfig).toHaveBeenCalledWith({
      useRealProfile: true,
      executablePath: '/chrome',
      cdpPort: 18801,
    });
  });

  it('starts Cindy-real by name after config swap so a stale default Cindy does not miss it', async () => {
    let startedProfile: string | undefined;
    const inner = {
      async call(request: BrowserControlRequest): Promise<BrowserControlResult> {
        if (request.action === 'status') {
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
    expect(withActiveBrowserProfile({ action: 'tabs', profile: 'Cindy' }, true).profile).toBe('Cindy');
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
