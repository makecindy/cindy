import { describe, expect, it } from "vitest";
import {
  USER_BUBBLE_PRESETS,
  bubbleHueColor,
  contrastRatio,
  parseUserBubblePreference,
  resolveUserBubbleColors,
  type UserBubblePreference,
} from "../userBubbleAppearance";

function luminance(hex: string) {
  const rgb = [1, 3, 5]
    .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
}
describe("personal message bubble appearance", () => {
  it("leaves default theme values alone and rejects malformed storage values", () => {
    expect(resolveUserBubbleColors("default", "dark")).toBeNull();
    for (const value of [
      null,
      {},
      "unknown",
      "#fff",
      "#000000;url(x)",
      "#zzzzzz",
    ]) {
      expect(parseUserBubblePreference(value)).toBe("default");
    }
    expect(parseUserBubblePreference("#AbCdEf")).toBe("#abcdef");
  });
  it("keeps every preset and extreme custom color readable in both modes", () => {
    for (const mode of ["light", "dark"] as const) {
      for (const preference of [
        ...USER_BUBBLE_PRESETS.slice(1),
        "#000000",
        "#ffffff",
        "#ff0000",
        "#00ff00",
        "#0000ff",
      ] as const) {
        const colors = resolveUserBubbleColors(preference, mode)!;
        const a = luminance(colors.background);
        const b = luminance(colors.foreground);
        expect(
          (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05),
        ).toBeGreaterThanOrEqual(7);
      }
    }
  });
  it("keeps every text role drawn in the bubble readable, tinting only as far as needed", () => {
    // Body, secondary and inline-code text of the mobile themes (light / dark).
    const roles = {
      light: ["#0F0F0F", "#4D4D4A", "#686864"],
      dark: ["#EDEDED", "#BDBDBD", "#999999"],
    } as const;
    const custom: UserBubblePreference[] = [
      "#000000",
      "#ffffff",
      "#ff0000",
      "#00ff00",
      "#0000ff",
      ...Array.from(
        { length: 36 },
        (_, i) => bubbleHueColor(i * 10) as `#${string}`,
      ),
    ];
    for (const mode of ["light", "dark"] as const) {
      for (const preference of [...USER_BUBBLE_PRESETS.slice(1), ...custom]) {
        const { background } = resolveUserBubbleColors(
          preference,
          mode,
          roles[mode],
        )!;
        for (const role of roles[mode]) {
          expect(contrastRatio(background, role)).toBeGreaterThanOrEqual(4.5);
        }
      }
    }
    // A color that already reads well keeps its full tint.
    expect(resolveUserBubbleColors("sage", "light", roles.light)).toEqual(
      resolveUserBubbleColors("sage", "light"),
    );
  });
});
