import { describe, expect, it, vi } from "vitest";
import {
  createPreviewViewportReporter,
  previewPictureArea,
} from "../previewViewport";

describe("the picture area", () => {
  it("is the window less the insets, rounded, and null when the host would refuse it", () => {
    expect(
      previewPictureArea({
        windowWidth: 402,
        windowHeight: 874,
        insets: { top: 62, bottom: 34, left: 0, right: 0 },
      }),
    ).toEqual({ width: 402, height: 778 });
    expect(
      previewPictureArea({
        windowWidth: 0,
        windowHeight: 0,
        insets: { top: 0, bottom: 0, left: 0, right: 0 },
      }),
    ).toBeNull();
    expect(
      previewPictureArea({
        windowWidth: 402.4,
        windowHeight: 874,
        insets: { top: 62.2, bottom: 34, left: 0, right: 0 },
      }),
    ).toEqual({ width: 402, height: 778 });
  });
});

describe("the viewport reporter", () => {
  const a = { width: 402, height: 778 };
  const b = { width: 778, height: 402 };

  it("debounces, skips what the host has, and retries after a refusal", async () => {
    vi.useFakeTimers();
    try {
      const send = vi.fn<(v: typeof a) => Promise<unknown>>(async () => {});
      const reporter = createPreviewViewportReporter(send, 300);
      reporter.start(a, true);
      reporter.update(a);
      await vi.advanceTimersByTimeAsync(1000);
      expect(send).not.toHaveBeenCalled();
      reporter.update(b);
      reporter.update(a);
      reporter.update(b);
      await vi.advanceTimersByTimeAsync(299);
      expect(send).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(send).toHaveBeenCalledExactlyOnceWith(b);
      reporter.update(b);
      await vi.advanceTimersByTimeAsync(1000);
      expect(send).toHaveBeenCalledTimes(1);
      send.mockRejectedValueOnce(new Error("busy"));
      reporter.update(a);
      await vi.advanceTimersByTimeAsync(300);
      reporter.update(a);
      await vi.advanceTimersByTimeAsync(300);
      expect(send.mock.calls.map(([v]) => v)).toEqual([b, a, a]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("sends nothing without support, and nothing after stop or a new lease with the same area", async () => {
    vi.useFakeTimers();
    try {
      const send = vi.fn(async () => {});
      const reporter = createPreviewViewportReporter(send, 300);
      reporter.start(null, false);
      reporter.update(b);
      await vi.advanceTimersByTimeAsync(1000);
      expect(send).not.toHaveBeenCalled();
      reporter.start(a, true);
      reporter.update(b);
      reporter.stop();
      await vi.advanceTimersByTimeAsync(1000);
      expect(send).not.toHaveBeenCalled();
      // A reconnect carries the current area in previewStart: nothing more to say.
      reporter.start(b, true);
      await vi.advanceTimersByTimeAsync(1000);
      expect(send).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
