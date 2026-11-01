import { FOLD_CAPS, FOLD_FN } from "./foldKeyboardInput";

export type FoldKeyCell = {
  id: string;
  /** Host key code; absent on function-row actions. */
  code?: string;
  weight: number;
  /** Second legend on keys that type a symbol with Shift. */
  shifted?: string;
  legend?: string;
  /** Arrow up and down share one cell, each half its height. */
  half?: "top" | "bottom";
  /** Function-row controls sit directly on the deck, without a keycap. */
  bare?: boolean;
  /** Empty width before this key, in key units, separating groups. */
  groupGap?: number;
};
export type FoldKeyRect = FoldKeyCell & {
  x: number;
  y: number;
  width: number;
  height: number;
};
export type FoldHostPlatform = string | undefined;

const GAP = 5;
const FUNCTION_ROW_HEIGHT = 0.74;

const letters = (keys: string) =>
  [...keys].map((key) => ({
    id: `Key${key}`,
    code: `Key${key}`,
    weight: 1,
    legend: key,
  }));
const symbol = (code: string, legend: string, shifted: string) => ({
  id: code,
  code,
  weight: 1,
  legend,
  shifted,
});

function bottomModifiers(platform: FoldHostPlatform) {
  const mac = platform === "darwin";
  const left = mac
    ? ["ControlLeft", "AltLeft", "MetaLeft"]
    : ["ControlLeft", "MetaLeft", "AltLeft"];
  const right = mac ? ["MetaLeft", "AltLeft"] : ["AltLeft", "ControlLeft"];
  return { left, right };
}

export function foldKeyboardRows(
  platform: FoldHostPlatform,
  functionRow: FoldKeyCell[],
): FoldKeyCell[][] {
  const { left, right } = bottomModifiers(platform);
  return [
    functionRow,
    [
      symbol("Backquote", "`", "~"),
      ...[..."1234567890"].map((key, index) =>
        symbol(`Digit${key}`, key, "!@#$%^&*()"[index]),
      ),
      symbol("Minus", "-", "_"),
      symbol("Equal", "=", "+"),
      { id: "Backspace", code: "Backspace", weight: 2 },
    ],
    [
      { id: "Tab", code: "Tab", weight: 1.5 },
      ...letters("QWERTYUIOP"),
      symbol("BracketLeft", "[", "{"),
      symbol("BracketRight", "]", "}"),
      { ...symbol("Backslash", "\\", "|"), weight: 1.5 },
    ],
    [
      { id: FOLD_CAPS, code: FOLD_CAPS, weight: 1.75 },
      ...letters("ASDFGHJKL"),
      symbol("Semicolon", ";", ":"),
      symbol("Quote", "'", '"'),
      { id: "Enter", code: "Enter", weight: 2.25 },
    ],
    [
      { id: "ShiftLeft", code: "ShiftLeft", weight: 2.25 },
      ...letters("ZXCVBNM"),
      symbol("Comma", ",", "<"),
      symbol("Period", ".", ">"),
      symbol("Slash", "/", "?"),
      { id: "ShiftRight", code: "ShiftLeft", weight: 2.75 },
    ],
    [
      { id: `${left[0]}.left`, code: left[0], weight: 1.25 },
      { id: `${left[1]}.left`, code: left[1], weight: 1.25 },
      { id: `${left[2]}.left`, code: left[2], weight: 1.5 },
      { id: "Space", code: "Space", weight: 5.75 },
      { id: `${right[0]}.right`, code: right[0], weight: 1.25 },
      { id: `${right[1]}.right`, code: right[1], weight: 1 },
      { id: "ArrowLeft", code: "ArrowLeft", weight: 1 },
      { id: "ArrowUp", code: "ArrowUp", weight: 1, half: "top" },
      { id: "ArrowDown", code: "ArrowDown", weight: 1, half: "bottom" },
      { id: "ArrowRight", code: "ArrowRight", weight: 1 },
    ],
  ];
}

export const FOLD_ESCAPE: FoldKeyCell = {
  id: "Escape",
  code: "Escape",
  weight: 1,
  bare: true,
};
export const FOLD_FN_CELL: FoldKeyCell = {
  id: FOLD_FN,
  code: FOLD_FN,
  weight: 1,
  bare: true,
  groupGap: 0.6,
};

/**
 * One geometry for drawing and hit-testing: Android reports a later finger
 * against the view under the first one, so a key cannot find its own touches.
 */
export function foldKeyRects(
  rows: FoldKeyCell[][],
  width: number,
  height: number,
): FoldKeyRect[] {
  const units = rows.length - 1 + FUNCTION_ROW_HEIGHT;
  const rowHeight = Math.max(0, height - GAP * (rows.length - 1)) / units;
  const rects: FoldKeyRect[] = [];
  let y = 0;
  rows.forEach((row, rowIndex) => {
    const currentHeight =
      rowIndex === 0 ? rowHeight * FUNCTION_ROW_HEIGHT : rowHeight;
    const slots = row.filter((cell) => cell.half !== "bottom");
    const total = slots.reduce(
      (sum, cell) => sum + cell.weight + (cell.groupGap ?? 0),
      0,
    );
    const unit = Math.max(0, width - GAP * (slots.length - 1)) / total;
    let x = 0;
    for (const cell of slots) {
      x += (cell.groupGap ?? 0) * unit;
      const cellWidth = cell.weight * unit;
      if (cell.half === "top") {
        const lower = row.find((other) => other.half === "bottom")!;
        const half = (currentHeight - GAP / 2) / 2;
        rects.push({ ...cell, x, y, width: cellWidth, height: half });
        rects.push({
          ...lower,
          x,
          y: y + half + GAP / 2,
          width: cellWidth,
          height: half,
        });
      } else {
        rects.push({ ...cell, x, y, width: cellWidth, height: currentHeight });
      }
      x += cellWidth + GAP;
    }
    y += currentHeight + GAP;
  });
  return rects;
}

/** The nearest key wins, so the gaps between keys never swallow a press. */
export function foldKeyAt(rects: FoldKeyRect[], x: number, y: number) {
  let best: FoldKeyRect | null = null;
  let bestDistance = Infinity;
  for (const rect of rects) {
    const dx = Math.max(rect.x - x, 0, x - rect.x - rect.width);
    const dy = Math.max(rect.y - y, 0, y - rect.y - rect.height);
    const distance = dx * dx + dy * dy;
    if (distance < bestDistance) {
      best = rect;
      bestDistance = distance;
    }
  }
  return best;
}
