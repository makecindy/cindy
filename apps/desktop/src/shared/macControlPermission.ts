/** On macOS 27.3 the Accessibility privacy URL opens an app details list.
 * Darwin and product versions match for this release family. */
export function usesMacProtectionOverride(platform?: string, version?: string): boolean {
  if (platform !== 'darwin' || !version) return false;
  const [major, minor] = version.split('.').map(Number);
  return major > 27 || (major === 27 && minor >= 3);
}

/** Both Main and a sandboxed preload can identify their own app from the executable.
 * In a preload it is a nested Electron Helper.app, not the bundle listed in Settings. */
export function macPermissionAppPath(platform: string, executable: string): string | undefined {
  if (platform !== 'darwin') return undefined;
  return /^(.+?\.app)\/Contents\/(?:Frameworks\/[^/]+\.app\/Contents\/)?MacOS\/[^/]+$/.exec(executable)?.[1];
}
