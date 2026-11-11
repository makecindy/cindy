import { beforeEach, describe, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => ({
  available: true,
  getDistributionInfo: vi.fn(),
}));

vi.mock('expo-modules-core', () => ({
  requireOptionalNativeModule: () =>
    native.available ? { getDistributionInfo: native.getDistributionInfo } : null,
}));

beforeEach(() => {
  vi.resetModules();
  native.available = true;
  native.getDistributionInfo.mockReset();
});

describe('iOS app distribution Expo module', () => {
  it('exposes a StoreKit sandbox result as TestFlight to JavaScript', async () => {
    native.getDistributionInfo.mockResolvedValue({
      environment: 'sandbox',
      isTestFlight: true,
      source: 'storekit2',
      verification: 'verified',
    });
    const distribution = await import('../../modules/xdt-ios-app-distribution/src/index');

    await expect(distribution.getIosAppDistributionInfo()).resolves.toEqual({
      environment: 'sandbox',
      isTestFlight: true,
      source: 'storekit2',
      verification: 'verified',
    });
    await expect(distribution.isIosTestFlightBuild()).resolves.toBe(true);
  });

  it('fails closed to unknown when native code is absent or returns a malformed payload', async () => {
    native.available = false;
    let distribution = await import('../../modules/xdt-ios-app-distribution/src/index');
    await expect(distribution.getIosAppDistributionInfo()).resolves.toEqual({
      environment: 'unknown',
      isTestFlight: false,
      source: 'unavailable',
      verification: 'unavailable',
    });

    vi.resetModules();
    native.available = true;
    native.getDistributionInfo.mockResolvedValue({
      environment: 'production',
      isTestFlight: true,
      source: 'unexpected',
      verification: 'verified',
    });
    distribution = await import('../../modules/xdt-ios-app-distribution/src/index');
    await expect(distribution.isIosTestFlightBuild()).resolves.toBe(false);
  });
});
