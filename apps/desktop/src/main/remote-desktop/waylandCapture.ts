/** PipeWire selects one surface interactively; it does not enumerate monitors. */
export const WAYLAND_DISPLAY_ID = 'wayland-portal';
export function isWaylandDesktop(
  platform: string,
  env: Record<string, string | undefined>,
): boolean {
  return (
    platform === 'linux' && (env.XDG_SESSION_TYPE === 'wayland' || Boolean(env.WAYLAND_DISPLAY))
  );
}

/** Electron picks Ozone Wayland only when XDG_SESSION_TYPE=wayland, unless
 * --ozone-platform overrides it. Launched from a shell that lacks that variable
 * inside a Wayland compositor, it runs on XWayland, whose X11 root window holds
 * no desktop pixels: remote viewers see black frames with only the pointer.
 * Returns the Wayland-session signals seen while Electron runs on X11.
 */
export function xwaylandSessionEvidence(
  ozonePlatform: string,
  env: Record<string, string | undefined>,
  runtimeDirEntries: readonly string[],
): string[] {
  if (ozonePlatform !== 'x11') return [];
  return [
    ...(env.XDG_SESSION_TYPE === 'wayland' ? ['XDG_SESSION_TYPE=wayland'] : []),
    ...(env.WAYLAND_DISPLAY ? ['WAYLAND_DISPLAY set'] : []),
    ...runtimeDirEntries
      .filter((name) => /^wayland-\d+$/.test(name))
      .map((name) => `socket ${name}`),
  ];
}

/** Do not guess a physical monitor from an empty display_id or an array position. */
export function selectPortalSource<T extends { id: string }>(sources: readonly T[]): T | null {
  return sources.length === 1 && sources[0].id.startsWith('screen:') ? sources[0] : null;
}

/** Native screencopy covers the union of all outputs, including gaps between
 * monitors. Preserve that aspect ratio in the lease: video contains its pixels
 * inside this box while the JPEG backing layer fills it.
 */
export function waylandDesktopSize(
  displays: readonly { bounds: { x: number; y: number; width: number; height: number } }[],
): { width: number; height: number } {
  const bounds = displays.map((display) => display.bounds);
  if (!bounds.length) return { width: 1280, height: 720 };
  return {
    width: Math.max(...bounds.map((b) => b.x + b.width)) - Math.min(...bounds.map((b) => b.x)),
    height: Math.max(...bounds.map((b) => b.y + b.height)) - Math.min(...bounds.map((b) => b.y)),
  };
}
