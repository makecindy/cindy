import { describe, expect, it } from 'vitest';

import {
  isComputerPermissionReady,
  shouldStartComputerPermissionGuide,
} from '../computerPermissionFlow';

function status(
  accessibility: ComputerDriverPermissionState['accessibility'],
  screenRecording: ComputerDriverPermissionState['screenRecording'],
): ComputerDriverStatus {
  const granted = accessibility === 'granted' && screenRecording === 'granted';
  return {
    installed: true,
    executablePath: '/tmp/cua-driver',
    version: 'test',
    daemonRunning: true,
    installCommand: 'test',
    docsUrl: 'https://cua.ai/docs/cua-driver',
    permissionState: {
      platform: 'macos',
      required: true,
      status: granted ? 'granted' : 'missing',
      accessibility,
      screenRecording,
      screenRecordingCapturable: screenRecording,
      canGrant: true,
    },
  };
}

describe('computer permission flow', () => {
  it('skips onboarding when the preflight snapshot is already ready', () => {
    const ready = status('granted', 'granted');

    expect(isComputerPermissionReady(ready)).toBe(true);
    expect(shouldStartComputerPermissionGuide(true, ready)).toBe(false);
  });

  it('starts onboarding when either permission is still missing', () => {
    expect(shouldStartComputerPermissionGuide(
      true,
      status('missing', 'missing'),
    )).toBe(true);
    expect(shouldStartComputerPermissionGuide(
      true,
      status('granted', 'missing'),
    )).toBe(true);
  });

  it('never starts onboarding while disabling the feature', () => {
    expect(shouldStartComputerPermissionGuide(
      false,
      status('missing', 'missing'),
    )).toBe(false);
  });
});
