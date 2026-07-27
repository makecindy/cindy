/**
 * Keeps the native permission guide on the path where macOS can drag the
 * installed CuaDriver app bundle. CLI-only installs must retain the legacy
 * grant flow because pausing their permission probe would dead-end it.
 */
export function shouldUseComputerPermissionGuide(options: {
  platform: NodeJS.Platform;
  showGuide: boolean;
  appBundlePath: string | null;
}): boolean {
  return (
    options.platform === 'darwin'
    && options.showGuide
    && options.appBundlePath !== null
  );
}
