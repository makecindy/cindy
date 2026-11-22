import { usesMacProtectionOverride } from '../../shared/macControlPermission.js';

/**
 * Keeps the native permission guide on the path where macOS can drag the
 * installed CuaDriver app bundle. CLI-only installs must retain the legacy
 * grant flow because pausing their permission probe would dead-end it.
 */
export function shouldUseComputerPermissionGuide(options: {
  platform: NodeJS.Platform;
  showGuide: boolean;
  appBundlePath: string | null;
  systemVersion?: string;
}): boolean {
  return (
    options.platform === 'darwin'
    // The 27.3 consent sheet has no switch to observe. Use the driver's
    // system grant flow and the existing live permission checks instead.
    && !usesMacProtectionOverride(options.platform, options.systemVersion)
    && options.showGuide
    && options.appBundlePath !== null
  );
}
