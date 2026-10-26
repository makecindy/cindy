// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { act } from "react";
import { expect, it, vi } from "vitest";
import { ImmersiveGlassSurface } from "../ImmersiveGlassSurface.ios";

const state = vi.hoisted(() => ({ glass: false }));
vi.mock("react-native", async () => {
  const { createElement } = await import("react");
  return {
    View: () => createElement("div", { "data-testid": "plain" }),
    StyleSheet: { absoluteFill: {} },
  };
});
vi.mock("expo-glass-effect", async () => {
  const { createElement } = await import("react");
  return { GlassView: () => createElement("div", { "data-testid": "glass" }) };
});
vi.mock("@/session/useLiquidGlassAvailable", () => ({
  useLiquidGlassAvailable: () => state.glass,
}));
vi.mock("@/theme", () => ({
  radius: { pill: 999 },
  navigationChrome: { clear: { dark: { scrim: "rgba(0,0,0,0.35)" }, light: { scrim: "rgba(255,255,255,0.35)" } } },
  useTheme: () => ({ mode: "dark", colors: { surfaceElevated: "#222" } }),
}));

function render() {
  const host = document.createElement("div");
  const root = createRoot(host);
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  act(() => root.render(createElement(ImmersiveGlassSurface)));
  const html = host.innerHTML;
  act(() => root.unmount());
  return html;
}

it("falls back to the plain backing when liquid glass is unavailable", () => {
  state.glass = false;
  expect(render()).toContain('data-testid="plain"');
  state.glass = true;
  expect(render()).toContain('data-testid="glass"');
});

it("the .ios file never imports itself under its bare name (Metro resolves that to .ios.tsx)", () => {
  const source = readFileSync(
    resolve(process.cwd(), "src/remote-desktop/ImmersiveGlassSurface.ios.tsx"),
    "utf8",
  );
  expect(source).not.toMatch(/from\s+["']\.\/ImmersiveGlassSurface["']/);
});
