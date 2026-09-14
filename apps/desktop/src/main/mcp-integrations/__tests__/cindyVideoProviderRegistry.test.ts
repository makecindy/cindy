import { describe, expect, it, vi } from 'vitest';
import { createXaiVideoProvider, XAI_VIDEO_CATALOG_MODEL_ID } from '../../cindy-proxy-media/video/providers/xai.js';

const state = vi.hoisted(() => ({ baseUrl: '', createService: vi.fn(), createStorage: vi.fn() }));
vi.mock('../../model-access/effectiveEndpoint.js', () => ({ effectiveXdGatewayBaseUrl: () => state.baseUrl }));
vi.mock('../../cindy-proxy-media/service.js', () => ({ createCindyProxyMediaService: state.createService }));
vi.mock('../../cindy-media/generatedMedia.js', () => ({ createBlobImageStorage: state.createStorage, createBlobVideoStorage: state.createStorage }));
vi.mock('../../imageCacheStore.js', () => ({ resolveSafe: vi.fn() }));
vi.mock('../../secrets/providerSecretStore.js', () => ({ getProviderSecretStore: () => { throw new Error('Discovery must not read credentials'); } }));
vi.mock('../../appCapabilities.js', () => ({ getAppCapabilities: () => ({ canUseCindyGateway: false }) }));
vi.mock('../../logger.js', () => ({ createLogger: () => ({ warn: vi.fn() }) }));

import { getCindyVideoProviderRegistry } from '../cindyProxyMedia.js';

describe('video registry independent of Gateway image initialization', () => {
  it('supports guest third-party video and endpoint changes without initializing image clients or storage', () => {
    state.baseUrl = '';
    const guest = getCindyVideoProviderRegistry();
    expect(guest.hasAny()).toBe(false);
    guest.register(createXaiVideoProvider({
      hasOAuthLogin: () => true,
      getAccessToken: async () => 'test-token',
      getCredentialGeneration: () => 1,
      getOwnerScopeKey: () => 'guest',
      isOwnerBoundaryPending: () => false,
    }), 'xai');
    expect(getCindyVideoProviderRegistry()).toBe(guest);
    expect(guest.hasAlias(XAI_VIDEO_CATALOG_MODEL_ID, 'xai')).toBe(true);

    state.baseUrl = 'https://gateway.example.invalid';
    const configured = getCindyVideoProviderRegistry();
    expect(configured).not.toBe(guest);
    expect(configured.hasAlias('seedance-fast', 'xd')).toBe(true);
    expect(configured.collectAllAliases()[0]?.alias).toBe('seedance-fast');

    state.baseUrl = '';
    const signedOut = getCindyVideoProviderRegistry();
    expect(signedOut).not.toBe(configured);
    expect(signedOut.hasAny()).toBe(false);
    expect(state.createService).not.toHaveBeenCalled();
    expect(state.createStorage).not.toHaveBeenCalled();
  });
});
