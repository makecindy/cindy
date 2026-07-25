import { describe, expect, it } from 'vitest';

import { shouldUseComputerPermissionGuide } from '../computerPermissionGuideEligibility.js';

describe('shouldUseComputerPermissionGuide', () => {
  it('uses the guide when macOS has the CuaDriver app bundle', () => {
    expect(shouldUseComputerPermissionGuide({
      platform: 'darwin',
      showGuide: true,
      appBundlePath: '/Applications/CuaDriver.app',
    })).toBe(true);
  });

  it('keeps CLI-only macOS installs on the legacy grant flow', () => {
    expect(shouldUseComputerPermissionGuide({
      platform: 'darwin',
      showGuide: true,
      appBundlePath: null,
    })).toBe(false);
  });

  it('does not show the macOS guide on other platforms or without an explicit request', () => {
    expect(shouldUseComputerPermissionGuide({
      platform: 'win32',
      showGuide: true,
      appBundlePath: 'C:\\CuaDriver.app',
    })).toBe(false);
    expect(shouldUseComputerPermissionGuide({
      platform: 'darwin',
      showGuide: false,
      appBundlePath: '/Applications/CuaDriver.app',
    })).toBe(false);
  });
});
