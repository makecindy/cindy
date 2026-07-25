/** Trusted, runtime-validated request shape for starting the macOS permission guide. */
export interface ComputerPermissionGrantRequest {
  showGuide: boolean;
  openedPaneUrl?: string;
}

export const MAC_ACCESSIBILITY_SETTINGS_URL =
  'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility';
export const MAC_SCREEN_RECORDING_SETTINGS_URL =
  'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture';

/** Only the two static System Settings targets used by the Computer Use UI are allowed. */
export function isComputerPermissionPaneUrl(value: unknown): value is string {
  return (
    value === MAC_ACCESSIBILITY_SETTINGS_URL
    || value === MAC_SCREEN_RECORDING_SETTINGS_URL
  );
}

/**
 * Parse the untrusted Renderer payload without accepting permission snapshots
 * or other fields that Main must derive itself.
 */
export function parseComputerPermissionGrantRequest(
  value: unknown,
): ComputerPermissionGrantRequest | null {
  if (value === undefined) return { showGuide: false };
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;

  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !['showGuide', 'openedPaneUrl'].includes(key))) {
    return null;
  }
  if (record.showGuide !== undefined && typeof record.showGuide !== 'boolean') return null;
  if (
    record.openedPaneUrl !== undefined
    && !isComputerPermissionPaneUrl(record.openedPaneUrl)
  ) {
    return null;
  }

  return {
    showGuide: record.showGuide === true,
    ...(typeof record.openedPaneUrl === 'string'
      ? { openedPaneUrl: record.openedPaneUrl }
      : {}),
  };
}
