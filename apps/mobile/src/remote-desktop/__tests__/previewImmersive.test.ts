import { describe, expect, it } from "vitest";
import {
  immersiveControlsTop,
  previewImmersiveEnabled,
} from "../previewImmersive";

const phone = {
  preview: true,
  ios: true,
  landscape: false,
  split: false,
  safeTop: 59,
  windowWidth: 402,
};

describe("when the preview goes immersive", () => {
  it("needs a preview, iOS, portrait and a camera cutout (top safe area >= 44pt)", () => {
    expect(previewImmersiveEnabled(phone)).toBe(true);
    expect(previewImmersiveEnabled({ ...phone, safeTop: 54, windowWidth: 393 })).toBe(true);
    expect(previewImmersiveEnabled({ ...phone, safeTop: 43 })).toBe(false);
    expect(previewImmersiveEnabled({ ...phone, safeTop: 24 })).toBe(false);
    for (const off of [
      { preview: false },
      { ios: false },
      { landscape: true },
      { split: true },
    ])
      expect(previewImmersiveEnabled({ ...phone, ...off })).toBe(false);
  });

  it("keeps the old layout where the group would sit under a notch", () => {
    // A ~210pt notch leaves (428 - 210) / 2 = 109pt at best, short of 16 + 2 x 44 + 8.
    for (const windowWidth of [375, 390, 414, 428])
      expect(previewImmersiveEnabled({ ...phone, safeTop: 47, windowWidth })).toBe(false);
    // The Dynamic Island (~126pt) leaves room on every island phone.
    for (const windowWidth of [393, 402, 430, 440])
      expect(previewImmersiveEnabled({ ...phone, safeTop: 59, windowWidth })).toBe(true);
  });

  it("centers a 44pt target in the top safe area", () => {
    expect(immersiveControlsTop(59)).toBe(7.5);
    expect(immersiveControlsTop(62)).toBe(9);
    expect(immersiveControlsTop(30)).toBe(0);
  });
});
