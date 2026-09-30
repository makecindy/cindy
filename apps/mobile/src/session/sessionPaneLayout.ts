import { safeWindowRect, windowDivision, type WindowGeometry } from '@/platform/windowGeometry';

/** Navigation consumes space only when the remaining conversation is comfortably usable. */
export function sessionPaneLayout(g: WindowGeometry) {
  const safe = safeWindowRect(g);
  const division = windowDivision(g);
  const splitAtFold = division?.axis === 'vertical' && division.first.width >= 240 && division.second.width >= 320;
  const persistent = !!splitAtFold || (!division && g.regularWidth && safe.width >= 760 && safe.height >= 480);
  const sidebarWidth = persistent ? (splitAtFold ? division!.first.width : Math.min(320, Math.round(safe.width * 0.34))) : 0;
  const sidebarGap = splitAtFold ? division!.second.x - safe.x - sidebarWidth : 0;
  const pane = { ...safe, x: safe.x + sidebarWidth + sidebarGap, width: safe.width - sidebarWidth - sidebarGap };
  return { persistent, sidebarWidth, sidebarGap, detail: pane };
}
