import { describe, expect, it } from "vitest";

import { compareIOSSimulatorRgbaImages } from "./visual-diff.js";

describe("compareIOSSimulatorRgbaImages", () => {
  it("counts thresholded changed pixels and reports bounded metrics", () => {
    const baseline = new Uint8Array([0, 0, 0, 255, 10, 10, 10, 255]);
    const current = new Uint8Array([5, 5, 5, 255, 40, 10, 10, 255]);
    expect(
      compareIOSSimulatorRgbaImages(
        { width: 2, height: 1, data: baseline },
        { width: 2, height: 1, data: current },
        { threshold: 8 },
      ),
    ).toEqual({
      width: 2,
      height: 1,
      comparedPixels: 2,
      differentPixels: 1,
      differenceRatio: 0.5,
      meanAbsoluteError: 5.625,
      maxAbsoluteError: 30,
      threshold: 8,
    });
  });

  it("rejects mismatched dimensions and malformed RGBA buffers", () => {
    expect(() =>
      compareIOSSimulatorRgbaImages(
        { width: 1, height: 1, data: new Uint8Array(4) },
        { width: 2, height: 1, data: new Uint8Array(8) },
      ),
    ).toThrowError(expect.objectContaining({ code: "INVALID_ARGUMENT" }));
    expect(() =>
      compareIOSSimulatorRgbaImages(
        { width: 1, height: 1, data: new Uint8Array(3) },
        { width: 1, height: 1, data: new Uint8Array(4) },
      ),
    ).toThrowError(expect.objectContaining({ code: "INVALID_ARGUMENT" }));
  });
});
