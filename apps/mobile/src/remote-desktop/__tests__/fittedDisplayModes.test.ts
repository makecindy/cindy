import { describe, expect, it } from "vitest";
import { fittedDisplayModes } from "../fittedDisplayModes";

describe("fittedDisplayModes", () => {
  it.each([
    { width: 986, height: 1920 },
    { width: 1920, height: 986 },
    { width: 320, height: 1920 },
  ])("offers bounded same-ratio sizes for $width × $height", (fitted) => {
    const modes = fittedDisplayModes(fitted, fitted);
    expect(modes.length).toBeGreaterThan(1);
    expect(modes.filter((mode) => mode.current)).toEqual([
      expect.objectContaining(fitted),
    ]);
    expect(new Set(modes.map((mode) => mode.id)).size).toBe(modes.length);
    for (const mode of modes) {
      expect(mode.native).toBeUndefined();
      for (const size of [mode.width, mode.height]) {
        expect(size).toBeGreaterThanOrEqual(320);
        expect(size).toBeLessThanOrEqual(2560);
      }
      expect(
        Math.abs(mode.width / mode.height / (fitted.width / fitted.height) - 1),
      ).toBeLessThan(0.003);
    }
    const next = modes.find((mode) => !mode.current)!;
    expect(fittedDisplayModes(fitted, next).map((mode) => mode.id)).toEqual(
      modes.map((mode) => mode.id),
    );
    expect(
      fittedDisplayModes(fitted, next).filter((mode) => mode.current),
    ).toEqual([{ ...next, current: true }]);
  });
});
