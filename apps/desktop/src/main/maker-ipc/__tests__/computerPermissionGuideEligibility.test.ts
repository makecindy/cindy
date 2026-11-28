import { describe, expect, it } from 'vitest';

import { getComputerPermissionGuideMode } from '../computerPermissionGuideEligibility.js';

describe('getComputerPermissionGuideMode', () => {
  it('uses the guide when macOS has the CuaDriver app bundle', () => {
    expect(getComputerPermissionGuideMode({
      platform: 'darwin',
      showGuide: true,
      appBundlePath: '/Applications/CuaDriver.app',
    })).toBe('drag');
  });

  // The 27.3 picker cannot complete a copy drag. Pausing the driver here
  // strands a real installation even after the user enables access in Settings.
  it.each([['27.2.1', 'drag'], ['27.3', 'settings'], ['27.10.0', 'settings'], ['28.0', 'settings']])(
    'selects the working authorization flow on macOS %s', (systemVersion, expected) => {
      expect(getComputerPermissionGuideMode({
        platform: 'darwin', systemVersion, showGuide: true, appBundlePath: '/Applications/CuaDriver.app',
      })).toBe(expected);
    },
  );

  it('keeps CLI-only macOS installs on the legacy grant flow', () => {
    expect(getComputerPermissionGuideMode({
      platform: 'darwin',
      showGuide: true,
      appBundlePath: null,
    })).toBe('driver');
  });

  it('does not show the macOS guide on other platforms or without an explicit request', () => {
    expect(getComputerPermissionGuideMode({
      platform: 'win32',
      showGuide: true,
      appBundlePath: 'C:\\CuaDriver.app',
    })).toBe('driver');
    expect(getComputerPermissionGuideMode({
      platform: 'darwin',
      showGuide: false,
      appBundlePath: '/Applications/CuaDriver.app',
    })).toBe('driver');
  });
});
