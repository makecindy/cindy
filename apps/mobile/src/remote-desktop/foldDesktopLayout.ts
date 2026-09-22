import { controlRegion, windowDivision, type WindowGeometry } from '@/platform/windowGeometry';

/** Both media layers receive this same rect. Software keyboard occlusion never changes the lease. */
export function foldDesktopLayout(g: WindowGeometry, keyboardBottom: number, panelHeight: number, keyboard: boolean) {
  const split = windowDivision(g);
  if (!split || split.first.width < 160 || split.second.width < 160 || split.first.height < 160 || split.second.height < 160) return null;
  const bottom = g.height - Math.max(0, keyboardBottom);
  let controls = controlRegion(g);
  controls = { ...controls, height: Math.max(0, Math.min(controls.height, bottom - controls.y)) };
  // A tall system keyboard may cover the lower half. Keep custom controls above
  // the fold in that case, and fit the video above those controls in the same region.
  if (keyboard && controls.height < 140 && split.axis === 'horizontal') {
    controls = { ...split.first, height: Math.max(0, Math.min(split.first.height, bottom - split.first.y)) };
  }
  const panel = keyboard ? Math.min(Math.max(0, panelHeight), controls.height) : 0;
  const panelTop = controls.y + controls.height - panel;
  const overlappingColumns = controls.x < split.first.x + split.first.width && controls.x + controls.width > split.first.x;
  const mediaBottom = keyboard && overlappingColumns ? Math.min(bottom, panelTop) : bottom;
  const media = { ...split.first, height: Math.max(1, Math.min(split.first.height, mediaBottom - split.first.y)) };
  return { media, controls };
}
