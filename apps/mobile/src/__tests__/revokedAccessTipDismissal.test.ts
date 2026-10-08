import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// DESIGN.md §4 Dialog & Modal「Closing affordance」:模态提示点背景不关闭,只能用 × 或系统返回。
function revokedAccessTipSource(): string {
  const source = readFileSync(
    resolve(process.cwd(), "src/session/HomeSurface.tsx"),
    "utf8",
  ).replace(/\r\n/g, "\n");
  const start = source.indexOf("function RevokedAccessTip(");
  const end = source.indexOf("\n}\n", start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe("revoked access tip dismissal", () => {
  it("does not close when the backdrop is tapped", () => {
    const tip = revokedAccessTipSource();
    expect(tip).toContain(
      '<View style={styles.revokedTipBackdrop} testID="home.revokedTip.backdrop">',
    );
    expect(tip).not.toMatch(/<Pressable[^>]*revokedTipBackdrop/);
  });

  it("still closes through the × button and system Back", () => {
    const tip = revokedAccessTipSource();
    expect(tip).toMatch(/<Modal[^>]*onRequestClose=\{onClose\}/);
    expect(tip).toMatch(
      /accessibilityLabel=\{t\('devices\.list\.a11y\.close'\)\}[\s\S]*?onPress=\{onClose\}/,
    );
  });
});
