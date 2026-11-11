import type { LayoutRect } from "@/platform/windowGeometry";
import type { RetroDesktopSkin } from "./FoldDesktopSkin";

// Measured floors of the keyboard wells in the 1536×1024 deck sources.
const DECK_WELLS: Record<
  "classic" | "macii" | "powerbook" | "thinkpad",
  LayoutRect
> = {
  classic: {
    x: 58 / 1536,
    y: 179 / 1024,
    width: 1429 / 1536,
    height: 415 / 1024,
  },
  macii: {
    x: 48 / 1536,
    y: 169 / 1024,
    width: 1442 / 1536,
    height: 471 / 1024,
  },
  powerbook: {
    x: 71 / 1536,
    y: 148 / 1024,
    width: 1404 / 1536,
    height: 412 / 1024,
  },
  thinkpad: {
    x: 62 / 1536,
    y: 153 / 1024,
    width: 1420 / 1536,
    height: 440 / 1024,
  },
};
export function deckWell(skin: RetroDesktopSkin) {
  return skin === "macii" || skin === "powerbook" || skin === "thinkpad"
    ? DECK_WELLS[skin]
    : DECK_WELLS.classic;
}
export const CONTROL_ASPECT: Record<
  "classic" | "macii" | "powerbook" | "thinkpad",
  number
> = {
  classic: 346 / 214,
  macii: 385 / 223,
  powerbook: 256 / 292,
  thinkpad: 422 / 100,
};
export const DECK_RAIL = 44;
export const WELL_PADDING = 6;
const MIN_CONTROL_ZONE = 52;
const KEY_GAP = 5;
const CLASSIC_COLUMNS = 13;
const CLASSIC_ROWS = 5;

/**
 * Keys keep their square proportion: the well is as tall as the keys need, and
 * the palm rest takes what is left. Short windows shrink the keys, never the rail.
 */
export function retroDeckLayout(
  size: { width: number; height: number },
  skin: RetroDesktopSkin,
  safe: { top: number; bottom: number; left: number; right: number },
  reserve: number,
) {
  const source = deckWell(skin);
  const left = Math.max(safe.left, size.width * source.x);
  const right = Math.max(
    safe.right,
    size.width * (1 - source.x - source.width),
  );
  const top = DECK_RAIL + safe.top;
  const width = Math.max(0, size.width - left - right);
  const unit =
    (width - WELL_PADDING * 2 - KEY_GAP * (CLASSIC_COLUMNS - 1)) /
    CLASSIC_COLUMNS;
  const wanted =
    unit * CLASSIC_ROWS + KEY_GAP * (CLASSIC_ROWS - 1) + WELL_PADDING * 2;
  const bottomInset = safe.bottom + reserve;
  const available = size.height - top - bottomInset - MIN_CONTROL_ZONE;
  const height = Math.max(0, Math.min(wanted, available));
  const palmTop = top + height;
  return {
    well: { x: left, y: top, width, height },
    control: {
      y: palmTop,
      height: Math.max(0, size.height - bottomInset - palmTop),
    },
  };
}
