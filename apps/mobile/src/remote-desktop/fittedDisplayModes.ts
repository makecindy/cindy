import type { RemoteDesktopDisplayMode } from "@cindy/device-link";

type Size = { width: number; height: number };

/** Resize the fitted desktop without offering modes from the physical monitor. */
export function fittedDisplayModes(
  fitted: Size,
  current: Size,
): RemoteDesktopDisplayMode[] {
  const modes = new Map<string, RemoteDesktopDisplayMode>();
  const add = ({ width, height }: Size) => {
    if (
      ![width, height].every(
        (size) => Number.isInteger(size) && size >= 320 && size <= 2560,
      )
    )
      return;
    const id = `fitted:${width}x${height}`;
    modes.set(id, {
      id,
      width,
      height,
      current: width === current.width && height === current.height,
    });
  };
  for (const edge of [960, 1280, 1600, 1920, 2560]) {
    const scale = edge / Math.max(fitted.width, fitted.height);
    add({
      width: Math.round((fitted.width * scale) / 2) * 2,
      height: Math.round((fitted.height * scale) / 2) * 2,
    });
  }
  add(current);
  return [...modes.values()].sort((a, b) => a.width - b.width);
}
