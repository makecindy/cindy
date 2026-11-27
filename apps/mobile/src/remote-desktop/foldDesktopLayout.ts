import { controlRegion, windowDivision, type WindowGeometry } from '@/platform/windowGeometry';

/** Tabletop controls are portrait-only. A landscape fold keeps the ordinary desktop. */
export function foldDesktopRegion(g: WindowGeometry) {
  if (g.width >= g.height) return null;
  const split = windowDivision(g);
  return split?.axis === 'horizontal' && split.first.width >= 160 && split.second.width >= 160
    && split.first.height >= 160 && split.second.height >= 160 ? split : null;
}

/** Physical artwork reaches the window edges; safe regions constrain controls only. */
export function foldDesktopHardware(g: WindowGeometry) {
  const split = foldDesktopRegion(g);
  const seam = split
    ? (split.first.y + split.first.height + split.second.y) / 2
    : 0;
  return {
    media: { x: 0, y: 0, width: g.width, height: seam },
    controls: { x: 0, y: seam, width: g.width, height: g.height - seam },
  };
}

/** Both media layers receive this same rect. Software keyboard occlusion never changes the lease. */
export function foldDesktopLayout(g: WindowGeometry, keyboardBottom: number, panelHeight: number, keyboard: boolean) {
  const split = foldDesktopRegion(g);
  if (!split) return null;
  const bottom = g.height - Math.max(0, keyboardBottom);
  let controls = controlRegion(g);
  controls = { ...controls, height: Math.max(0, Math.min(controls.height, bottom - controls.y)) };
  // Keyboard controls belong to the lower screen, including the compact toolbar
  // above the system keyboard. Never move them into the video region.
  const panel = keyboard ? Math.min(Math.max(0, panelHeight), controls.height) : 0;
  const panelTop = controls.y + controls.height - panel;
  const overlappingColumns = controls.x < split.first.x + split.first.width && controls.x + controls.width > split.first.x;
  const mediaBottom = keyboard && overlappingColumns ? Math.min(bottom, panelTop) : bottom;
  const media = { ...split.first, height: Math.max(1, Math.min(split.first.height, mediaBottom - split.first.y)) };
  return { media, controls };
}
