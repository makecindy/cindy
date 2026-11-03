import { describe, expect, it } from "vitest";
import {
  createTransferProgressMeter,
  formatTransferProgress,
  transferPercent,
} from "@/session/transferProgress";

describe("transfer progress", () => {
  it("omits speed until half a second of real samples exists", () => {
    let now = 0;
    const measure = createTransferProgressMeter(3000, () => now);
    expect(measure(0, 1000)).toEqual({
      loaded: 0,
      total: 1000,
      bytesPerSecond: null,
    });
    now = 300;
    expect(measure(100, 1000).bytesPerSecond).toBeNull();
    now = 1000;
    expect(measure(500, 1000).bytesPerSecond).toBe(500);
  });

  it("measures the recent window and restarts when bytes go backwards", () => {
    let now = 0;
    const measure = createTransferProgressMeter(1000, () => now);
    measure(0, 10_000);
    now = 1000;
    measure(1000, 10_000);
    now = 2000;
    // Old 0→1000 burst falls out of the window; rate reflects the last second only.
    expect(measure(5000, 10_000).bytesPerSecond).toBe(4000);
    now = 2100;
    expect(measure(10, 10_000).bytesPerSecond).toBeNull();
  });

  it("formats percent and speed, clamping the percent", () => {
    expect(transferPercent({ loaded: 999, total: 1000 })).toBe(99);
    expect(transferPercent({ loaded: 2000, total: 1000 })).toBe(100);
    expect(transferPercent({ loaded: 5, total: 0 })).toBe(0);
    expect(
      formatTransferProgress({
        loaded: 420,
        total: 1000,
        bytesPerSecond: null,
      }),
    ).toBe("42%");
    expect(
      formatTransferProgress({
        loaded: 420,
        total: 1000,
        bytesPerSecond: 2048,
      }),
    ).toMatch(/^42% · .+\/s$/);
  });
});
