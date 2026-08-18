import { EventEmitter } from 'node:events';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TEST_CDN_BASE_URL } from '../../test/vitest/clientEndpointsFixture';

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
    const { clearCachedManifest } = await import('../manifestService');
    clearCachedManifest();
  });

  it('rejects an HTTP 200 body that is not a usable beta manifest', async () => {
    mockManifestResponse('<html>error</html>');
    const service = await import('../manifestService');
    await expect(service.probeBetaManifest()).resolves.toBe(false);
  });

  it('accepts a parseable beta manifest', async () => {
    mockManifestResponse(RELEASE_MANIFEST);
    const service = await import('../manifestService');
    await expect(service.probeBetaManifest()).resolves.toBe(true);
  });
});
