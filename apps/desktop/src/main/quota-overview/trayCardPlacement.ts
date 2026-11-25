import type { Rectangle } from 'electron';

/** Space between the tray icon's edge and the card, as Feishu's tray card leaves. */
export const TRAY_CARD_GAP = 4;

/**
 * Where the Windows tray card goes: centred on the icon and clear of it, above it when the icon
 * sits in the lower half of the screen (taskbar or its overflow flyout) and below it otherwise,
 * then kept inside the work area. Measured from the icon's edge, not its centre: a card 10px
 * from the centre of a 32px overflow cell covered the top of the icon.
 */
export function placeTrayCard({ anchor, area, width, height }: {
  anchor: Rectangle; area: Rectangle; width: number; height: number;
}): Rectangle {
  const clamp = (n: number, start: number, end: number) => Math.max(start, Math.min(n, end));
  const centreX = anchor.x + anchor.width / 2;
  const below = anchor.y + anchor.height / 2 < area.y + area.height / 2;
  return {
    x: Math.round(clamp(centreX - width / 2, area.x, area.x + area.width - width)),
    y: Math.round(clamp(below ? anchor.y + anchor.height + TRAY_CARD_GAP : anchor.y - height - TRAY_CARD_GAP,
      area.y, area.y + area.height - height)),
    width, height,
  };
}
