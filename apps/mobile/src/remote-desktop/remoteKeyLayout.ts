import { KEY_CAPS, KEY_FN } from "./remoteKeyInput";

export type KeyCell = {
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
  /** Empty width after this key, in key units. */
  trailingGap?: number;
  /** Non-typing keys use the quieter key treatment. */
  control?: boolean;
};
export type KeyRect = KeyCell & {
  x: number;
  y: number;
  width: number;
  height: number;
};
/** The top row's fixed height and the width its bar neighbours reserve. */
export type KeyStrip = { height?: number; left?: number; right?: number };
export type HostPlatform = string | undefined;

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

function bottomModifiers(platform: HostPlatform) {
  const mac = platform === "darwin";
  const left = mac
    ? ["ControlLeft", "AltLeft", "MetaLeft"]
    : ["ControlLeft", "MetaLeft", "AltLeft"];
  const right = mac ? ["MetaLeft", "AltLeft"] : ["AltLeft", "ControlLeft"];
  return { left, right };
}

const DIGIT_SYMBOLS = "!@#$%^&*()";
const digitRow = () =>
  [..."1234567890"].map((key, index) =>
    symbol(`Digit${key}`, key, DIGIT_SYMBOLS[index]),
  );
const control = (code: string, weight: number): KeyCell => ({
  id: code,
  code,
  weight,
  control: true,
});

/**
 * Vintage machines had only the typing keys, with printed words instead of icons.
 * Everything else stays one tap away through the toolbar's keyboard.
 */
export function classicKeyboardRows(platform: HostPlatform): KeyCell[][] {
  const mac = platform === "darwin";
  const key = (code: string, legend: string, weight = 1): KeyCell => ({
    id: code,
    code,
    weight,
    legend,
  });
  const meta = mac ? "⌘" : platform === "win32" ? "Win" : "Super";
  return [
    [
      key("Escape", "Esc", 1.25),
      ...[..."1234567890"].map((digit) => key(`Digit${digit}`, digit)),
      key("Backspace", "⌫", 1.75),
    ],
    [
      key("Tab", "Tab", 1.5),
      ...letters("QWERTYUIOP"),
      key("Backslash", "\\", 1.5),
    ],
    [
      key(KEY_CAPS, "Caps", 1.75),
      ...letters("ASDFGHJKL"),
      key("Enter", mac ? "Return" : "Enter", 2.25),
    ],
    [
      key("ShiftLeft", "Shift", 2),
      ...letters("ZXCVBNM"),
      key("Comma", ","),
      key("Period", "."),
      key("ArrowUp", "↑"),
      key("Slash", "/"),
    ],
    [
      key("ControlLeft", "Ctrl", 1.25),
      key("AltLeft", mac ? "Option" : "Alt", 1.25),
      key("MetaLeft", meta, 1.5),
      key("Space", "", 6),
      key("ArrowLeft", "←"),
      key("ArrowDown", "↓"),
      key("ArrowRight", "→"),
    ],
  ];
}

/** Phone width cannot fit a laptop's 15 columns, so symbols move to a second page. */
export const KEY_PAGE = "page";
function compactRows(
  platform: HostPlatform,
  functionRow: KeyCell[],
  symbols: boolean,
): KeyCell[][] {
  const { left } = bottomModifiers(platform);
  const bottom: KeyCell[] = [
    ...left.map((code) => ({ ...control(code, 1.2), id: `${code}.left` })),
    {
      id: KEY_PAGE,
      weight: 1.2,
      legend: symbols ? "abc" : "#+=",
      control: true,
    },
    { id: "Space", code: "Space", weight: 3 },
    control("Enter", 2),
  ];
  if (symbols)
    return [
      functionRow,
      digitRow(),
      [
        symbol("Backquote", "`", "~"),
        symbol("Minus", "-", "_"),
        symbol("Equal", "=", "+"),
        symbol("BracketLeft", "[", "{"),
        symbol("BracketRight", "]", "}"),
        symbol("Backslash", "\\", "|"),
      ],
      [
        symbol("Semicolon", ";", ":"),
        symbol("Quote", "'", '"'),
        symbol("Comma", ",", "<"),
        symbol("Period", ".", ">"),
        symbol("Slash", "/", "?"),
        { id: "Insert", code: "Insert", weight: 1, legend: "Ins" },
      ],
      [
        control("ShiftLeft", 1.5),
        control("ArrowLeft", 1),
        control("ArrowUp", 1),
        control("ArrowDown", 1),
        control("ArrowRight", 1),
        control("Backspace", 1.5),
      ],
      bottom,
    ];
  const middle = letters("ASDFGHJKL");
  return [
    functionRow,
    digitRow(),
    letters("QWERTYUIOP"),
    [
      { ...middle[0], groupGap: 0.5 },
      ...middle.slice(1, -1),
      { ...middle[middle.length - 1], trailingGap: 0.5 },
    ],
    [
      control("ShiftLeft", 1.5),
      ...letters("ZXCVBNM"),
      control("Backspace", 1.5),
    ],
    bottom,
  ];
}

export function keyboardRows(
  platform: HostPlatform,
  functionRow: KeyCell[],
  compact = false,
  symbols = false,
): KeyCell[][] {
  if (compact) return compactRows(platform, functionRow, symbols);
  const { left, right } = bottomModifiers(platform);
  return [
    functionRow,
    [
      symbol("Backquote", "`", "~"),
      ...digitRow(),
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
      { id: KEY_CAPS, code: KEY_CAPS, weight: 1.75 },
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

export const ESCAPE_CELL: KeyCell = {
  id: "Escape",
  code: "Escape",
  weight: 1,
  bare: true,
};
export const FN_CELL: KeyCell = {
  id: KEY_FN,
  code: KEY_FN,
  weight: 1,
  bare: true,
  groupGap: 0.6,
};

/**
 * One geometry for drawing and hit-testing: Android reports a later finger
 * against the view under the first one, so a key cannot find its own touches.
 */
export function keyRects(
  rows: KeyCell[][],
  width: number,
  height: number,
  strip: KeyStrip | false = {},
): KeyRect[] {
  const fixedStrip = strip && strip.height !== undefined ? strip.height : null;
  const typingRows = strip ? rows.length - 1 : rows.length;
  const units =
    typingRows + (strip && fixedStrip === null ? FUNCTION_ROW_HEIGHT : 0);
  const rowHeight =
    Math.max(0, height - GAP * (rows.length - 1) - (fixedStrip ?? 0)) /
    Math.max(1, units);
  const rects: KeyRect[] = [];
  let y = 0;
  rows.forEach((row, rowIndex) => {
    const isStrip = strip && rowIndex === 0;
    const currentHeight = isStrip
      ? (fixedStrip ?? rowHeight * FUNCTION_ROW_HEIGHT)
      : rowHeight;
    const left = isStrip ? (strip.left ?? 0) : 0;
    const right = isStrip ? (strip.right ?? 0) : 0;
    const slots = row.filter((cell) => cell.half !== "bottom");
    const total = slots.reduce(
      (sum, cell) =>
        sum + cell.weight + (cell.groupGap ?? 0) + (cell.trailingGap ?? 0),
      0,
    );
    // A wide key spans the gaps it covers, keeping columns aligned across rows.
    const unit = Math.max(0, width - left - right - GAP * (total - 1)) / total;
    const span = (weight: number) => weight * unit + (weight - 1) * GAP;
    const skip = (weight: number) => weight * (unit + GAP);
    let x = left;
    for (const cell of slots) {
      x += skip(cell.groupGap ?? 0);
      const cellWidth = span(cell.weight);
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
      x += cellWidth + skip(cell.trailingGap ?? 0) + GAP;
    }
    y += currentHeight + GAP;
  });
  return rects;
}

/** The nearest key wins, so the gaps between keys never swallow a press. */
export function keyAt(rects: KeyRect[], x: number, y: number) {
  let best: KeyRect | null = null;
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
