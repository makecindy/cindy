import { usesMacProtectionOverride } from '../../shared/macControlPermission.js';

/** The 27.3 privacy picker requires the user to select an app. A guide that
 * pauses the driver until a copy drag completes cannot observe that choice. */
export function getComputerPermissionGuideMode(options: {
  platform: NodeJS.Platform;
  systemVersion?: string;
  showGuide: boolean;
  appBundlePath: string | null;
}): 'driver' | 'settings' | 'drag' {
  if (options.platform !== 'darwin' || !options.showGuide || !options.appBundlePath) return 'driver';
  return usesMacProtectionOverride(options.platform, options.systemVersion) ? 'settings' : 'drag';
}
