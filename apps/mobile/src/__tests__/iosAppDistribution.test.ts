import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
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

  it('keeps StoreKit 2 authoritative and receipt lookup as a fallback', () => {
    const swift = readFileSync(
      resolve(
        process.cwd(),
        'modules/xdt-ios-app-distribution/ios/XdtIosAppDistributionModule.swift',
      ),
      'utf8',
    );
    const moduleConfig = readFileSync(
      resolve(process.cwd(), 'modules/xdt-ios-app-distribution/expo-module.config.json'),
      'utf8',
    );
    const endpointGate = readFileSync(
      resolve(process.cwd(), 'src/config/useStartupEndpointGate.ts'),
      'utf8',
    );
    const startupBundleCheck = readFileSync(
      resolve(process.cwd(), 'src/update/useBundleUpdatePrompt.ts'),
      'utf8',
    );
    const resumeUpdateCheck = readFileSync(
      resolve(process.cwd(), 'src/update/useResumeUpdateCheck.ts'),
      'utf8',
    );
    const settings = readFileSync(
      resolve(process.cwd(), 'app/settings.tsx'),
      'utf8',
    );

    expect(swift).toContain('try await AppTransaction.shared');
    expect(swift).toContain('case .verified(let transaction)');
    expect(swift).toContain('case .sandbox:');
    expect(swift).toContain('receiptName == "sandboxReceipt"');
    expect(moduleConfig).toContain('"platforms": ["apple"]');
    expect(moduleConfig).not.toContain('"android"');
    // The async StoreKit lookup must complete inside the endpoint gate, before
    // REVIEW_MODE is consumed by any update hook or settings screen.
    expect(endpointGate).toContain('resolveIsTestFlight: isTestFlightBuild');
    // Startup, settings, and resume must all consume the resolved TestFlight
    // state before deciding whether the full-package channel is available.
    for (const source of [startupBundleCheck, settings, resumeUpdateCheck]) {
      expect(source).toContain('isTestFlightBuild: IS_TESTFLIGHT_BUILD');
    }
  });
});
