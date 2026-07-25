import { describe, expect, it } from 'vitest';

import {
  getComputerPermissionSwitchChecked,
  isComputerPermissionPreflightInconclusive,
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

  it('does not start onboarding when passive preflight is inconclusive', () => {
    const missing = status('missing', 'missing');
    const unknown: ComputerDriverStatus = {
      ...missing,
      permissionState: {
        ...missing.permissionState!,
        status: 'unknown',
      },
    };

    expect(isComputerPermissionReady(null)).toBe(false);
    expect(isComputerPermissionReady(unknown)).toBe(false);
    expect(isComputerPermissionPreflightInconclusive(unknown)).toBe(true);
    expect(isComputerPermissionPreflightInconclusive(missing)).toBe(false);
    expect(isComputerPermissionPreflightInconclusive(null)).toBe(false);
    expect(shouldStartComputerPermissionGuide(true, unknown)).toBe(false);
    expect(shouldStartComputerPermissionGuide(true, null)).toBe(false);
  });

  it('treats a loaded status without platform permissions as ready', () => {
    const { permissionState: _permissionState, ...withoutPermissionState } =
      status('granted', 'granted');

    expect(isComputerPermissionReady(withoutPermissionState)).toBe(true);
  });

  it('never starts onboarding while disabling the feature', () => {
    expect(shouldStartComputerPermissionGuide(
      false,
      status('missing', 'missing'),
    )).toBe(false);
  });

  it('keeps persisted opt-in visible independently from runtime readiness', () => {
    expect(getComputerPermissionSwitchChecked(true, false, false)).toBe(true);
    expect(getComputerPermissionSwitchChecked(false, false, true)).toBe(false);
    expect(getComputerPermissionSwitchChecked(false, true, true)).toBe(true);
    expect(getComputerPermissionSwitchChecked(true, true, false)).toBe(false);
  });
});
