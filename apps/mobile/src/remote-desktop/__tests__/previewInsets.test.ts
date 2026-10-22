import { describe, expect, it } from "vitest";
import { spacing } from "@/theme/tokens";
import { previewViewportInsets } from "../previewInsets";

const base = {
  landscape: false,
  systemSideRail: false,
  toolbarOnLeft: false,
  paddingTop: 59,
  bottom: 0,
  safeBottom: 34,
  backHeight: 44,
  backLeft: 24,
  toolbar: { width: 0, height: 90 },
  sideRailWidth: 60,
};

describe("where a preview picture may be drawn", () => {
  it("portrait: below the status bar and the back button, above the toolbar", () => {
    const insets = previewViewportInsets({ ...base, bottom: 90 });
    expect(insets.top).toBe(59 + spacing.xs + 44 + spacing.sm);
    // That is the same line an open keyboard already keeps a desktop below.
    expect(insets.top).toBeGreaterThan(59 + spacing.xs + 44);
    expect(insets.bottom).toBe(90);
    expect([insets.left, insets.right]).toEqual([0, 0]);
  });

  it("immersive portrait: right below the top safe area, no row for the back button", () => {
    const insets = previewViewportInsets({
      ...base,
      immersive: true,
      bottom: 34,
    });
    expect(insets).toEqual({ top: 59, bottom: 34, left: 0, right: 0 });
    // Landscape and the iPad side rail ignore it.
    expect(
      previewViewportInsets({ ...base, immersive: true, landscape: true, paddingTop: 0 })
        .left,
    ).toBe(24 + 44 + spacing.sm);
  });

  it("portrait with the keyboard: the screen's own bottom inset is kept", () => {
    expect(previewViewportInsets({ ...base, bottom: 0 }).bottom).toBe(0);
  });

  it("landscape: clear of the back button column and of the toolbar rail", () => {
    const rail = { width: 72, height: 300 };
    const right = previewViewportInsets({
      ...base,
      landscape: true,
      paddingTop: 0,
      toolbar: rail,
    });
    expect(right.left).toBe(24 + 44 + spacing.sm);
    expect(right.right).toBe(72);
    expect(right.bottom).toBe(34);
    const left = previewViewportInsets({
      ...base,
      landscape: true,
      paddingTop: 0,
      toolbar: rail,
      toolbarOnLeft: true,
    });
    // One column holds both: it must clear whichever is wider.
    expect(left.left).toBe(Math.max(72, 24 + 44 + spacing.sm));
    expect(left.right).toBe(0);
  });

  it("an iPad side rail: one column on the right for both controls", () => {
    const insets = previewViewportInsets({
      ...base,
      landscape: true,
      systemSideRail: true,
    });
    expect(insets.right).toBe(60);
    expect(insets.left).toBe(0);
  });
});
