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

  // The 27.3 permission sheet has an app details list, with no switch to point at.
  it.each([['27.2.1', true], ['27.3', false], ['28.0', false]])(
    'selects the appropriate grant flow on macOS %s', (systemVersion, useCoach) => {
      expect(shouldUseComputerPermissionGuide({
        platform: 'darwin', showGuide: true, appBundlePath: '/Applications/CuaDriver.app',
        systemVersion,
      })).toBe(useCoach);
    },
  );

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
