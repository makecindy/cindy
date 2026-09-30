import { keyboardControlRegion, type WindowGeometry } from './windowGeometry';

/** Legacy custom panels float in roomy windows; navigation rails belong to the presenting page. */
export function modalLayout(window: WindowGeometry, keyboardHeight = 0) {
  const region = keyboardControlRegion(window, keyboardHeight);
  const floating = window.width >= 600 || window.width > window.height;
  if (!floating) return { floating, region };
  const margin = 20;
  const width = Math.min(560, Math.max(0, region.width - margin * 2));
  const height = Math.min(640, Math.max(0, region.height - margin * 2));
  return { floating, region: {
    x: region.x + (region.width - width) / 2,
    y: region.y + (region.height - height) / 2,
    width, height,
  } };
}
