import { describe, expect, it } from "vitest";
import { retroDeckLayout } from "../retroDeckLayout";
import { KEY_CAPS, KEY_FN, RemoteKeyInput } from "../remoteKeyInput";
import {
  classicKeyboardRows,
  keyAt,
  keyRects,
  keyboardRows,
} from "../remoteKeyLayout";

const down = (code: string) => ({ kind: "key", code, down: true });
const up = (code: string) => ({ kind: "key", code, down: false });

describe("RemoteKeyInput", () => {
  it("keeps overlapping fingers independent while typing fast", () => {
    const input = new RemoteKeyInput();
    expect(input.press(1, "KeyA")).toEqual([down("KeyA")]);
    expect(input.press(2, "KeyB")).toEqual([down("KeyB")]);
    expect(input.release(1)).toEqual([up("KeyA")]);
    expect(input.release(2)).toEqual([up("KeyB")]);
  });

  it("does not send a modifier tapped alone, so Win or Alt opens no host menu", () => {
    const input = new RemoteKeyInput();
    expect(input.press(1, "MetaLeft")).toEqual([]);
    expect(input.release(1)).toEqual([]);
    expect(input.latch("MetaLeft")).toBe("once");
  });

  it("applies a tapped modifier to the next key only", () => {
    const input = new RemoteKeyInput();
    input.press(1, "MetaLeft");
    input.release(1);
    expect(input.press(2, "KeyC")).toEqual([down("MetaLeft"), down("KeyC")]);
    expect(input.release(2)).toEqual([up("KeyC"), up("MetaLeft")]);
    expect(input.latch("MetaLeft")).toBeNull();
    expect(input.press(3, "KeyC")).toEqual([down("KeyC")]);
  });

  it("locks on the second tap and clears on the third", () => {
    const input = new RemoteKeyInput();
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
    const input = new RemoteKeyInput();
    input.press("cmd", "MetaLeft");
    expect(input.press(1, "Tab")).toEqual([down("MetaLeft"), down("Tab")]);
    expect(input.release(1)).toEqual([up("Tab")]);
    expect(input.press(2, "Tab")).toEqual([down("Tab")]);
    expect(input.release(2)).toEqual([up("Tab")]);
    expect(input.release("cmd")).toEqual([up("MetaLeft")]);
    expect(input.latch("MetaLeft")).toBeNull();
  });

  it("maps the Fn layer locally and keeps the press's code through release", () => {
    const input = new RemoteKeyInput();
    input.press("fn", KEY_FN);
    expect(input.press(1, "Digit1")).toEqual([down("F1")]);
    expect(input.release("fn")).toEqual([]);
    expect(input.release(1)).toEqual([up("F1")]);
  });

  it("types capitals through Shift for letters only while Caps Lock is on", () => {
    const input = new RemoteKeyInput();
    input.press("caps", KEY_CAPS);
    input.release("caps");
    expect(input.uppercase()).toBe(true);
    expect(input.press(1, "KeyA")).toEqual([down("ShiftLeft"), down("KeyA")]);
    input.release(1);
    expect(input.press(2, "Digit1")).toEqual([down("Digit1")]);
  });

  it("lets go of a spent one-shot modifier before the next overlapping key", () => {
    const input = new RemoteKeyInput();
    input.press("m", "ShiftLeft");
    input.release("m");
    expect(input.press(1, "KeyA")).toEqual([down("ShiftLeft"), down("KeyA")]);
    // B arrives while A is still down: Shift is no longer wanted.
    expect(input.press(2, "KeyB")).toEqual([up("ShiftLeft"), down("KeyB")]);
    expect(input.release(1)).toEqual([up("KeyA")]);
    expect(input.release(2)).toEqual([up("KeyB")]);
  });

  it("keeps a modifier the user still holds across overlapping keys", () => {
    const input = new RemoteKeyInput();
    input.press("cmd", "MetaLeft");
    input.press(1, "Tab");
    expect(input.press(2, "KeyZ")).toEqual([down("KeyZ")]);
  });

  it("restores held modifiers after a shortcut released them", () => {
    const input = new RemoteKeyInput();
    input.press("cmd", "MetaLeft");
    input.press(1, "Tab");
    input.release(1);
    expect(input.resync()).toEqual([down("MetaLeft")]);
    // Tab again still reaches the host with Command held.
    expect(input.press(2, "Tab")).toEqual([down("Tab")]);
  });

  it("clears the host before a shortcut and restores it after", () => {
    const input = new RemoteKeyInput();
    input.press("shift", "ShiftLeft");
    input.press(1, "KeyA");
    input.release(1);
    expect(input.suspend()).toEqual([up("ShiftLeft")]);
    expect(input.resync()).toEqual([down("ShiftLeft")]);
  });

  it("does not type a still-held letter again after a shortcut", () => {
    const input = new RemoteKeyInput();
    input.press("shift", "ShiftLeft");
    input.press(1, "KeyA");
    expect(input.suspend()).toEqual([up("KeyA"), up("ShiftLeft")]);
    expect(input.resync()).toEqual([down("ShiftLeft")]);
    // Lifting the finger later must not send a stray key-up for a key the host already let go of.
    expect(input.release(1)).toEqual([]);
  });

  it("does not latch a modifier whose touch was cancelled", () => {
    const input = new RemoteKeyInput();
    input.press(1, "AltLeft");
    input.release(1, true);
    expect(input.latch("AltLeft")).toBeNull();
  });
});

describe("classic keyboard", () => {
  it("has only the typing keys, in five rows with printed words", () => {
    const rows = classicKeyboardRows("darwin");
    expect(rows).toHaveLength(5);
    expect(rows.flat().every((cell) => cell.legend !== undefined)).toBe(true);
    expect(rows.flat().some((cell) => cell.bare)).toBe(false);
    const rects = keyRects(rows, 600, 300, false);
    expect(rects[0].y).toBe(0);
    const last = rects[rects.length - 1];
    expect(last.y + last.height).toBeCloseTo(300, 3);
  });

  it("staggers its rows, ends them flush and stacks the arrow column", () => {
    const rects = keyRects(classicKeyboardRows("darwin"), 650, 300, false);
    const at = (id: string) => rects.find((rect) => rect.id === id)!;
    for (const id of ["Backspace", "Backslash", "Enter", "Slash", "ArrowRight"])
      expect(at(id).x + at(id).width).toBeCloseTo(650, 3);
    expect(at("KeyQ").x).toBeLessThan(at("KeyA").x);
    expect(at("KeyA").x).toBeLessThan(at("KeyZ").x);
    expect(at("ArrowUp").x).toBeCloseTo(at("ArrowDown").x, 0);
  });
});

describe("retro deck", () => {
  const safe = { top: 6, bottom: 20, left: 0, right: 0 };
  it("keeps keys near square and reserves the palm above the toolbar", () => {
    const { well, control } = retroDeckLayout(
      { width: 760, height: 490 },
      "macii",
      safe,
      60,
    );
    const keyWidth = (well.width - 12 - 12 * 5) / 13;
    const keyHeight = (well.height - 12 - 4 * 5) / 5;
    expect(keyHeight / keyWidth).toBeCloseTo(1, 1);
    expect(control.y).toBeCloseTo(well.y + well.height, 3);
    expect(control.y + control.height).toBe(490 - 20 - 60);
    expect(control.height).toBeGreaterThanOrEqual(52);
  });
  it("shrinks keys in a short window, keeping the control zone and system insets", () => {
    const { well, control } = retroDeckLayout(
      { width: 760, height: 300 },
      "powerbook",
      { ...safe, left: 80 },
      60,
    );
    expect(well.x).toBe(80);
    expect(control.height).toBe(52);
    expect(well.height).toBeGreaterThan(0);
  });
});

describe("keyboard bar", () => {
  it("fits between its neighbours at a fixed height, keys filling the rest", () => {
    const rows = keyboardRows("darwin", [
      { id: "Escape", code: "Escape", weight: 1 },
    ]);
    const rects = keyRects(rows, 400, 300, { height: 44, left: 44, right: 88 });
    const esc = rects[0];
    expect(esc.x).toBe(44);
    expect(esc.width).toBeCloseTo(268, 3);
    expect(esc.height).toBe(44);
    expect(rects[1].y).toBe(49);
    expect(rects[1].x).toBe(0);
    const last = rects[rects.length - 1];
    expect(last.y + last.height).toBeCloseTo(300, 3);
  });
});

describe("compact keyboard", () => {
  const strip = [{ id: "Escape", code: "Escape", weight: 1 }];
  const edge = (rects: ReturnType<typeof keyRects>, id: string) => {
    const rect = rects.find((item) => item.id === id)!;
    return rect.x + rect.width;
  };

  it("fits ten letters across a phone and keeps every row at the edge", () => {
    const rects = keyRects(keyboardRows("darwin", strip, true), 370, 276);
    for (const id of ["Digit0", "KeyP", "Backspace", "Enter"])
      expect(edge(rects, id)).toBeCloseTo(370, 3);
    expect(edge(rects, "KeyL")).toBeLessThan(370);
    expect(rects.find((item) => item.id === "KeyA")!.x).toBeGreaterThan(0);
    expect(rects.find((item) => item.id === "KeyQ")!.width).toBeGreaterThan(30);
  });

  it("puts every remaining host key on the symbol page", () => {
    const codes = keyboardRows("darwin", strip, true, true)
      .flat()
      .map((cell) => cell.code);
    for (const code of [
      "Backquote",
      "Minus",
      "Equal",
      "BracketLeft",
      "BracketRight",
      "Backslash",
      "Semicolon",
      "Quote",
      "Comma",
      "Period",
      "Slash",
      "ArrowUp",
      "ArrowDown",
      "ArrowLeft",
      "ArrowRight",
      "Insert",
    ])
      expect(codes).toContain(code);
  });
});

describe("keyRects", () => {
  const rows = keyboardRows("darwin", [
    { id: "Escape", code: "Escape", weight: 1 },
  ]);
  const rects = keyRects(rows, 700, 300);

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

  it("keeps group gaps inside the row width, with the last key at the edge", () => {
    const [esc, undo] = keyRects(
      [
        [
          { id: "a", weight: 1, bare: true },
          { id: "b", weight: 1, bare: true, groupGap: 1 },
        ],
      ],
      305,
      40,
    );
    expect(esc.width).toBeCloseTo(295 / 3, 3);
    expect(undo.x).toBeCloseTo(305 - 295 / 3, 3);
    expect(undo.x + undo.width).toBeCloseTo(305, 3);
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
    expect(keyAt(rects, a.x + 2, a.y + 2)?.id).toBe("KeyA");
    expect(keyAt(rects, s.x - 1, s.y + 2)?.id).toBe("KeyS");
  });

  it("orders the bottom modifiers for the host", () => {
    const ids = (platform: "darwin" | "win32") =>
      keyboardRows(platform, [])[5]
        .slice(0, 3)
        .map((cell) => cell.code);
    expect(ids("darwin")).toEqual(["ControlLeft", "AltLeft", "MetaLeft"]);
    expect(ids("win32")).toEqual(["ControlLeft", "MetaLeft", "AltLeft"]);
  });
});
