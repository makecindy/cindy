import type { LayoutRect } from "@/platform/windowGeometry";
import type { RetroDesktopSkin } from "./FoldDesktopSkin";

// Measured floors of the keyboard wells in the 1536×1024 deck sources.
const DECK_WELLS: Record<
  "classic" | "macii" | "powerbook" | "thinkpad" | "iceblue",
  LayoutRect
> = {
  iceblue: {
    x: 171 / 1536,
    y: 171 / 1024,
    width: 1192 / 1536,
    height: 451 / 1024,
  },
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
type DeckArt = keyof typeof DECK_WELLS;
const CONTROL_ASPECT: Record<DeckArt, number> = {
  iceblue: 1288 / 955,
  classic: 346 / 214,
  macii: 385 / 223,
  powerbook: 256 / 292,
  thinkpad: 422 / 100,
};
export const DECK_RAIL = 44;
const MIN_CONTROL_ZONE = 52;
const CLASSIC_COLUMNS = 13;
const CLASSIC_ROWS = 5;

function controlImageSize(
  deck: DeckArt,
  wellWidth: number,
  palmHeight: number,
) {
  const sourceAspect = CONTROL_ASPECT[deck];
  const available = Math.max(0, palmHeight - (deck === "iceblue" ? 16 : 8));
  if (deck === "classic" || deck === "macii") {
    // Aim for one third of the keyboard. A short palmrest may widen the
    // inset surface to 2:1, with its rim still scaled by height.
    const width = Math.min(wellWidth / 3, available * 2);
    return {
      width,
      height: Math.min(available, width / sourceAspect),
      sourceAspect,
    };
  }
  const maxHeight =
    deck === "iceblue"
      ? Math.min(120, wellWidth / sourceAspect)
      : deck === "thinkpad"
        ? 24
        : 56;
  const height = Math.min(available, maxHeight);
  return { width: height * sourceAspect, height, sourceAspect };
}

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
  const deck =
    skin === "compact" || skin === "edge" || skin === "macbook"
      ? "classic"
      : skin;
  const source = DECK_WELLS[deck];
  const left = Math.max(safe.left, size.width * source.x);
  const right = Math.max(
    safe.right,
    size.width * (1 - source.x - source.width),
  );
  const top = DECK_RAIL + safe.top;
  const width = Math.max(0, size.width - left - right);
  // Island keys show aluminum between caps; sculpted desktop keys have tighter valleys.
  const keyGap =
    skin === "macbook" ? 3 : deck === "classic" || deck === "macii" ? 2.5 : 2;
  const wellPadding = 4;
  const unit =
    (width - wellPadding * 2 - keyGap * (CLASSIC_COLUMNS - 1)) /
    CLASSIC_COLUMNS;
  const wanted =
    unit * CLASSIC_ROWS + keyGap * (CLASSIC_ROWS - 1) + wellPadding * 2;
  const bottomInset = safe.bottom + reserve;
  const available = size.height - top - bottomInset - MIN_CONTROL_ZONE;
  const height = Math.max(0, Math.min(wanted, available));
  const palmTop = top + height;
  const palmHeight = Math.max(0, size.height - bottomInset - palmTop);
  return {
    deck,
    sourceWell: source,
    keyGap,
    wellPadding,
    well: { x: left, y: top, width, height },
    control: { y: palmTop, height: palmHeight },
    controlImage: controlImageSize(deck, width, palmHeight),
  };
}
