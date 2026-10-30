import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NativeOtaBridge } from './nativeOtaRequestCoordinator';

const fixture = vi.hoisted(() => ({
  module: null as Partial<NativeOtaBridge> | null,
  endpoint: '',
  check: vi.fn(), fetch: vi.fn(), reload: vi.fn(), legacyOverride: vi.fn(),
  read: vi.fn(), write: vi.fn(),
}));
vi.mock('expo-modules-core', () => ({ requireOptionalNativeModule: () => fixture.module }));
vi.mock('expo-updates', () => ({
  updateId: 'u1', runtimeVersion: 'r1', isEmergencyLaunch: false,
  checkForUpdateAsync: fixture.check, fetchUpdateAsync: fixture.fetch,
  reloadAsync: fixture.reload, setUpdateURLAndRequestHeadersOverride: fixture.legacyOverride,
}));
vi.mock('@/config/env', () => ({ get OTA_SERVER_BASE_URL() { return fixture.endpoint; } }));
vi.mock('@react-native-async-storage/async-storage', () => ({ default: {
  getItem: fixture.read, setItem: fixture.write,
} }));

import { getNativeOtaBridge } from './nativeOtaBridge';
import { runSelfHostedOtaRequest } from './otaRequestCoordinator';

beforeEach(() => {
  vi.clearAllMocks();
  fixture.endpoint = '';
  fixture.module = {
    cindySelfHostOtaCapabilities: () => ({ version: 1, runtimeVersion: 'r1', available: true,
      updateUrl: 'https://native.example.invalid/manifest' }),
    cindyBeginSelfHostOtaRequest: vi.fn(() => 'request'),
    cindyFinishSelfHostOtaRequest: vi.fn(),
  };
  fixture.check.mockResolvedValue({ isAvailable: false });
});

describe('installed binary OTA capability routing', () => {
  it('uses native identity without a runtime endpoint or legacy JS journal', async () => {
    await runSelfHostedOtaRequest('canary', (client) => client.checkForUpdateAsync());
    expect(fixture.module?.cindyBeginSelfHostOtaRequest).toHaveBeenCalledWith('canary');
    expect(fixture.module?.cindyFinishSelfHostOtaRequest).toHaveBeenCalledWith('request');
    expect(fixture.check).toHaveBeenCalledOnce();
    expect(fixture.legacyOverride).not.toHaveBeenCalled();
    expect(fixture.read).not.toHaveBeenCalled();
    expect(fixture.write).not.toHaveBeenCalled();
  });

  it('never substitutes the mutable runtime endpoint for the native endpoint', async () => {
    fixture.endpoint = 'https://other.example.invalid';
    await runSelfHostedOtaRequest('beta', (client) => client.checkForUpdateAsync());
    expect(fixture.legacyOverride).not.toHaveBeenCalled();
    expect(fixture.module?.cindyBeginSelfHostOtaRequest).toHaveBeenCalledWith('beta');
  });

  it('does not silently downgrade an incomplete native installation to full URL override', async () => {
    delete fixture.module!.cindyFinishSelfHostOtaRequest;
    await expect(runSelfHostedOtaRequest('release', (client) => client.checkForUpdateAsync()))
      .rejects.toThrow('incomplete-native-ota-contract');
    expect(fixture.check).not.toHaveBeenCalled();
    expect(fixture.legacyOverride).not.toHaveBeenCalled();
  });

  it('leaves an old binary on the legacy path, including its endpoint prerequisite', async () => {
    fixture.module = null;
    expect(getNativeOtaBridge()).toBeNull();
    await expect(runSelfHostedOtaRequest('release', (client) => client.checkForUpdateAsync()))
      .rejects.toThrow('endpoint manifest missing mobileUpdateBaseUrl');
    expect(fixture.check).not.toHaveBeenCalled();
  });
});
