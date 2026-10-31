import { EventEmitter } from 'node:events';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TEST_CDN_BASE_URL } from '../../test/vitest/clientEndpointsFixture';

const originalPlatform = process.platform;
const originalArch = process.arch;
const netRequest = vi.hoisted(() => vi.fn());
const canaryRead = vi.hoisted(() => vi.fn(() => false));
const isBetaChannelEnabled = vi.hoisted(() => vi.fn(() => false));
const getClientEndpoint = vi.hoisted(() => vi.fn(() => TEST_CDN_BASE_URL));

vi.mock('electron', () => ({
  app: {
    isPackaged: true,
    getPath: vi.fn(() => '/tmp'),
  },
  net: { request: netRequest },
}));

vi.mock('../canaryFlagStore', () => ({
  read: canaryRead,
}));

vi.mock('../updateChannelStore', () => ({
  isBetaChannelEnabled,
}));

vi.mock('../clientEndpointsService', () => ({
  getClientEndpoint,
}));

vi.mock('../logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

function mockManifestResponse(body: string, onEnd?: () => void): void {
  const request = new EventEmitter() as EventEmitter & {
    abort: ReturnType<typeof vi.fn>;
    end: ReturnType<typeof vi.fn>;
  };
  request.abort = vi.fn();
  request.end = vi.fn(() => {
    const response = new EventEmitter() as EventEmitter & { statusCode: number };
    response.statusCode = 200;
    request.emit('response', response);
    response.emit('data', Buffer.from(body));
    onEnd?.();
    response.emit('end');
  });
  netRequest.mockReturnValueOnce(request);
}

const RELEASE_MANIFEST = JSON.stringify({
  app: { version: '0.0.65' },
});

const LINUX_BETA_MANIFEST = {
  app: {
    version: '0.0.66',
    installer: {
      file: 'app/linux-x64/cindy-0.0.66-amd64.deb',
      sha256: 'a'.repeat(64),
      size: 123,
    },
  },
};

function setRuntime(platform: NodeJS.Platform, arch: string): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  Object.defineProperty(process, 'arch', { value: arch, configurable: true });
}

describe('manifestService cache channel identity', () => {
  beforeEach(() => {
    netRequest.mockReset();
    canaryRead.mockReset();
    canaryRead.mockReturnValue(false);
    isBetaChannelEnabled.mockReset();
    isBetaChannelEnabled.mockReturnValue(false);
    getClientEndpoint.mockReset();
    getClientEndpoint.mockReturnValue(TEST_CDN_BASE_URL);
  });

  afterEach(async () => {
    const { clearCachedManifest } = await import('../manifestService');
    clearCachedManifest();
  });

  // Optional binary preparation observes metadata; it cannot change the result
  // of the application's update lookup, even if the observer fails. Tier: unit.
  it('isolates optional metadata observers and honors unsubscribe', async () => {
    const service = await import('../manifestService');
    const observer = vi.fn(() => { throw new Error('optional prefetch failed'); });
    const unsubscribe = service.onManifestFetched(observer);
    try {
      mockManifestResponse(RELEASE_MANIFEST);
      await expect(service.fetchManifest()).resolves.toMatchObject({ app: { version: '0.0.65' } });
      expect(observer).toHaveBeenCalledOnce();
      unsubscribe();
      mockManifestResponse(RELEASE_MANIFEST);
      await expect(service.fetchManifest()).resolves.toMatchObject({ app: { version: '0.0.65' } });
      expect(observer).toHaveBeenCalledOnce();
    } finally { unsubscribe(); }
  });

  it('discards a cached release manifest after the shared channel switches to beta', async () => {
    mockManifestResponse(RELEASE_MANIFEST);
    const service = await import('../manifestService');

    await expect(service.fetchManifest()).resolves.toMatchObject({ app: { version: '0.0.65' } });
    expect(service.getCachedManifest()).toMatchObject({ app: { version: '0.0.65' } });

    isBetaChannelEnabled.mockReturnValue(true);

    expect(service.getCachedManifest()).toBeNull();
    expect(netRequest.mock.calls[0]?.[0]).toContain('manifest-');
    expect(String(netRequest.mock.calls[0]?.[0])).not.toContain('-beta.json');
  });

  it('aborts an unread non-200 response before removing cancellation ownership', async () => {
    const request = Object.assign(new EventEmitter(), { end: vi.fn(), abort: vi.fn() });
    const response = Object.assign(new EventEmitter(), { statusCode: 404 });
    netRequest.mockReturnValueOnce(request);
    const controller = new AbortController();
    const service = await import('../manifestService');
    const pending = service.fetchManifest(1_000, controller.signal);
    request.emit('response', response);
    await expect(pending).resolves.toBeNull();
    expect(request.abort).toHaveBeenCalledTimes(1);
    controller.abort();
    expect(request.abort).toHaveBeenCalledTimes(1);
  });

  it('does not cache a fetch that finishes after the shared channel changes', async () => {
    mockManifestResponse(RELEASE_MANIFEST, () => {
      isBetaChannelEnabled.mockReturnValue(true);
    });
    const service = await import('../manifestService');

    await expect(service.fetchManifest()).resolves.toBeNull();
    expect(service.getCachedManifest()).toBeNull();
  });
});

describe('probeBetaManifest', () => {
  beforeEach(() => {
    netRequest.mockReset();
    canaryRead.mockReset();
    canaryRead.mockReturnValue(false);
    isBetaChannelEnabled.mockReset();
    isBetaChannelEnabled.mockReturnValue(false);
    getClientEndpoint.mockReset();
    getClientEndpoint.mockReturnValue(TEST_CDN_BASE_URL);
  });

  afterEach(async () => {
    setRuntime(originalPlatform, originalArch);
    const { clearCachedManifest } = await import('../manifestService');
    clearCachedManifest();
  });

  it('rejects an HTTP 200 body that is not a usable beta manifest', async () => {
    setRuntime('win32', 'x64');
    mockManifestResponse('<html>error</html>');
    const service = await import('../manifestService');
    await expect(service.probeBetaManifest()).resolves.toBe(false);
  });

  it('keeps accepting a parseable beta manifest outside Linux', async () => {
    setRuntime('win32', 'x64');
    mockManifestResponse(RELEASE_MANIFEST);
    const service = await import('../manifestService');
    await expect(service.probeBetaManifest()).resolves.toBe(true);
  });

  it('rejects a beta manifest whose app version is not valid SemVer', async () => {
    setRuntime('linux', 'x64');
    mockManifestResponse(
      JSON.stringify({
        ...LINUX_BETA_MANIFEST,
        app: { ...LINUX_BETA_MANIFEST.app, version: 'not-semver' },
      }),
    );
    const service = await import('../manifestService');

    await expect(service.probeBetaManifest()).resolves.toBe(false);
  });

  // Regression: ARM64 beta builds must reach the same real manifest probe and
  // .deb validation as x64, rather than failing before the request. Tier: unit.
  it.each(['x64', 'arm64'])('accepts a Linux %s beta manifest with a complete .deb installer', async (arch) => {
    setRuntime('linux', arch);
    mockManifestResponse(JSON.stringify({
      ...LINUX_BETA_MANIFEST,
      app: {
        ...LINUX_BETA_MANIFEST.app,
        installer: {
          ...LINUX_BETA_MANIFEST.app.installer,
          file: `app/linux-${arch}/cindy-0.0.66-${arch === 'x64' ? 'amd64' : 'arm64'}.deb`,
        },
      },
    }));
    const service = await import('../manifestService');

    await expect(service.probeBetaManifest()).resolves.toBe(true);
    expect(String(netRequest.mock.calls[0]?.[0])).toContain(`manifest-linux-${arch}-beta.json`);
  });

  it.each([
    ['a missing installer', { app: { version: '0.0.66' } }],
    [
      'a non-deb installer',
      {
        app: {
          ...LINUX_BETA_MANIFEST.app,
          installer: { ...LINUX_BETA_MANIFEST.app.installer, file: 'cindy.rpm' },
        },
      },
    ],
    [
      'a malformed SHA-256',
      {
        app: {
          ...LINUX_BETA_MANIFEST.app,
          installer: { ...LINUX_BETA_MANIFEST.app.installer, sha256: 'abc' },
        },
      },
    ],
    [
      'a zero installer size',
      {
        app: {
          ...LINUX_BETA_MANIFEST.app,
          installer: { ...LINUX_BETA_MANIFEST.app.installer, size: 0 },
        },
      },
    ],
    [
      'a non-numeric installer size',
      {
        app: {
          ...LINUX_BETA_MANIFEST.app,
          installer: { ...LINUX_BETA_MANIFEST.app.installer, size: '123' },
        },
      },
    ],
  ].flatMap(([reason, manifest]) => ['x64', 'arm64'].map((arch) => ({ arch, reason, manifest }))))(
    'rejects a Linux $arch beta manifest with $reason',
    async ({ arch, manifest }) => {
      setRuntime('linux', arch);
      mockManifestResponse(JSON.stringify(manifest));
      const service = await import('../manifestService');

      await expect(service.probeBetaManifest()).resolves.toBe(false);
      expect(netRequest).toHaveBeenCalledOnce();
    },
  );

  it('does not probe the beta channel on unsupported Linux architectures', async () => {
    setRuntime('linux', 'ia32');
    const service = await import('../manifestService');

    await expect(service.probeBetaManifest()).resolves.toBe(false);
    expect(netRequest).not.toHaveBeenCalled();
  });
});
