import { describe, expect, it } from "vitest";
import { FOLD_CAPS, FOLD_FN, FoldKeyInput } from "../foldKeyboardInput";
import {
  foldKeyAt,
  foldKeyRects,
  foldKeyboardRows,
} from "../foldKeyboardLayout";

const down = (code: string) => ({ kind: "key", code, down: true });
const up = (code: string) => ({ kind: "key", code, down: false });

describe("FoldKeyInput", () => {
  it("keeps overlapping fingers independent while typing fast", () => {
    const input = new FoldKeyInput();
    expect(input.press(1, "KeyA")).toEqual([down("KeyA")]);
    expect(input.press(2, "KeyB")).toEqual([down("KeyB")]);
    expect(input.release(1)).toEqual([up("KeyA")]);
    expect(input.release(2)).toEqual([up("KeyB")]);
  });

  it("does not send a modifier tapped alone, so Win or Alt opens no host menu", () => {
    const input = new FoldKeyInput();
    expect(input.press(1, "MetaLeft")).toEqual([]);
    expect(input.release(1)).toEqual([]);
    expect(input.latch("MetaLeft")).toBe("once");
  });

  it("applies a tapped modifier to the next key only", () => {
    const input = new FoldKeyInput();
    input.press(1, "MetaLeft");
    input.release(1);
    expect(input.press(2, "KeyC")).toEqual([down("MetaLeft"), down("KeyC")]);
    expect(input.release(2)).toEqual([up("KeyC"), up("MetaLeft")]);
    expect(input.latch("MetaLeft")).toBeNull();
    expect(input.press(3, "KeyC")).toEqual([down("KeyC")]);
  });

  it("locks on the second tap and clears on the third", () => {
    const input = new FoldKeyInput();
    const tap = () => {
      input.press("m", "ShiftLeft");
      input.release("m");
    };
    tap();
    tap();
    expect(input.latch("ShiftLeft")).toBe("locked");
    expect(input.press(1, "KeyA")).toEqual([down("ShiftLeft"), down("KeyA")]);
    input.release(1);
    expect(input.latch("ShiftLeft")).toBe("locked");
    tap();
    expect(input.latch("ShiftLeft")).toBeNull();
  });

  it("holds a modifier across repeated keys, as Command-Tab needs", () => {
    const input = new FoldKeyInput();
    input.press("cmd", "MetaLeft");
    expect(input.press(1, "Tab")).toEqual([down("MetaLeft"), down("Tab")]);
    expect(input.release(1)).toEqual([up("Tab")]);
    expect(input.press(2, "Tab")).toEqual([down("Tab")]);
    expect(input.release(2)).toEqual([up("Tab")]);
    expect(input.release("cmd")).toEqual([up("MetaLeft")]);
    expect(input.latch("MetaLeft")).toBeNull();
  });

  it("maps the Fn layer locally and keeps the press's code through release", () => {
    const input = new FoldKeyInput();
    input.press("fn", FOLD_FN);
    expect(input.press(1, "Digit1")).toEqual([down("F1")]);
    expect(input.release("fn")).toEqual([]);
    expect(input.release(1)).toEqual([up("F1")]);
  });

  it("types capitals through Shift for letters only while Caps Lock is on", () => {
    const input = new FoldKeyInput();
    input.press("caps", FOLD_CAPS);
    input.release("caps");
    expect(input.uppercase()).toBe(true);
    expect(input.press(1, "KeyA")).toEqual([down("ShiftLeft"), down("KeyA")]);
    input.release(1);
    expect(input.press(2, "Digit1")).toEqual([down("Digit1")]);
  });

  it("does not latch a modifier whose touch was cancelled", () => {
    const input = new FoldKeyInput();
    input.press(1, "AltLeft");
    input.release(1, true);
    expect(input.latch("AltLeft")).toBeNull();
  });
});

describe("foldKeyRects", () => {
  const rows = foldKeyboardRows("darwin", [
    { id: "Escape", code: "Escape", weight: 1 },
  ]);
  const rects = foldKeyRects(rows, 700, 300);

  it("fills the available width on every row", () => {
    for (const code of [
      "Backspace",
      "Backslash",
      "Enter",
      "ShiftRight",
      "ArrowRight",
    ]) {
      const rect = rects.find((item) => item.id === code)!;
      expect(rect.x + rect.width).toBeCloseTo(700, 3);
    }
  });

  it("stacks arrow up and down in one cell", () => {
    const upKey = rects.find((item) => item.id === "ArrowUp")!;
    const downKey = rects.find((item) => item.id === "ArrowDown")!;
    expect(downKey.x).toBe(upKey.x);
    expect(downKey.y).toBeGreaterThan(upKey.y + upKey.height - 0.01);
    expect(downKey.y + downKey.height).toBeCloseTo(300, 3);
  });

  it("finds the key under a finger, and the nearest key from a gap", () => {
    const a = rects.find((item) => item.id === "KeyA")!;
    const s = rects.find((item) => item.id === "KeyS")!;
    expect(foldKeyAt(rects, a.x + 2, a.y + 2)?.id).toBe("KeyA");
    expect(foldKeyAt(rects, s.x - 1, s.y + 2)?.id).toBe("KeyS");
  });

  it("orders the bottom modifiers for the host", () => {
    const ids = (platform: "darwin" | "win32") =>
      foldKeyboardRows(platform, [])[5]
        .slice(0, 3)
        .map((cell) => cell.code);
    expect(ids("darwin")).toEqual(["ControlLeft", "AltLeft", "MetaLeft"]);
    expect(ids("win32")).toEqual(["ControlLeft", "MetaLeft", "AltLeft"]);
  });
});
