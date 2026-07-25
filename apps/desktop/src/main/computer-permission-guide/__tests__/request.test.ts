import { describe, expect, it } from 'vitest';

import {
  MAC_ACCESSIBILITY_SETTINGS_URL,
  MAC_SCREEN_RECORDING_SETTINGS_URL,
  parseComputerPermissionGrantRequest,
} from '../request.js';

describe('Computer Use permission guide request', () => {
  it('accepts only the supported runtime-validated fields', () => {
    expect(parseComputerPermissionGrantRequest(undefined)).toEqual({
      showGuide: false,
    });
    expect(parseComputerPermissionGrantRequest({
      showGuide: true,
      openedPaneUrl: MAC_ACCESSIBILITY_SETTINGS_URL,
    })).toEqual({
      showGuide: true,
      openedPaneUrl: MAC_ACCESSIBILITY_SETTINGS_URL,
    });
    expect(parseComputerPermissionGrantRequest({
      showGuide: true,
      openedPaneUrl: MAC_SCREEN_RECORDING_SETTINGS_URL,
    })).toEqual({
      showGuide: true,
      openedPaneUrl: MAC_SCREEN_RECORDING_SETTINGS_URL,
    });
  });

  it('rejects forged permission snapshots and malformed values', () => {
    expect(parseComputerPermissionGrantRequest(null)).toBeNull();
    expect(parseComputerPermissionGrantRequest({ showGuide: 'yes' })).toBeNull();
    expect(parseComputerPermissionGrantRequest({
      showGuide: true,
      initialStatus: { permissionState: { status: 'granted' } },
    })).toBeNull();
    expect(parseComputerPermissionGrantRequest({
      showGuide: true,
      openedPaneUrl: 'https://attacker.example/',
    })).toBeNull();
  });
});
