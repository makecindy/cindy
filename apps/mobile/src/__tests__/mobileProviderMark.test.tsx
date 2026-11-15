import { createElement } from "react";
import { renderToStaticMarkup as render } from "react-dom/server";
import { expect, it, vi } from "vitest";
import {
  MobileProviderMark,
  MobileModelIconMark,
} from "@/session/MobileProviderMark";

const themeState = vi.hoisted(() => ({ mode: "light" as "light" | "dark" }));

// User request 2026-10-29. Unit: no existing test renders the real mobile provider
// mark. The regression is source-host identity combined with theme color.
vi.mock("react-native", () => ({
  View: ({ children }: any) => createElement("div", null, children),
  StyleSheet: { create: (styles: unknown) => styles },
}));
vi.mock("@/components/AppText", () => ({
  Text: ({ children }: any) => createElement("span", null, children),
}));
vi.mock("react-native-svg", () => ({
  default: ({ children, ...props }: any) =>
    createElement("svg", props, children),
  G: ({ children, ...props }: any) => createElement("g", props, children),
  Defs: ({ children }: any) => createElement("defs", null, children),
  LinearGradient: ({ children, ...props }: any) => createElement("linearGradient", props, children),
  Stop: (props: any) => createElement("stop", props),
  Path: (props: any) => createElement("path", props),
}));
vi.mock("@/theme", () => ({
  useTheme: () => ({ mode: themeState.mode, colors: { textSecondary: "currentColor" } }),
  useThemedStyles: (factory: any) => factory({ textSecondary: "currentColor" }),
}));
vi.mock("@/session/RemoteSourceMark", () => ({
  RemoteSourceMark: ({ children }: any) =>
    createElement("div", { "data-remote": true }, children),
}));

// These marks are stateless; render the real components without a DOM environment.
const firstPath = (markup: string) => markup.match(/<path d="([^"]+)"/)?.[1];

// Unit: provider ID alone cannot distinguish personal and XD organization.
it("uses the original XD paths with the supplied theme color and keeps the remote badge", () => {
  const xd = render(
    <MobileProviderMark
      providerId="xd"
      name="Cindy AI · 心动"
      logoKind="xd"
      color="white"
      remote
    />,
  );
  const paths = xd.match(/<path\b[^>]*>/g) ?? [];
  expect(paths.length).toBe(3);
  expect(paths.every((p) => p.includes('fill="white"'))).toBe(true);
  expect(xd).toContain('data-remote="true"');
  const personal = render(
    <MobileProviderMark
      providerId="xd"
      name="Cindy AI · 个人"
      logoKind="cindy"
    />,
  );
  expect(firstPath(personal)).toBeTruthy();
  expect(firstPath(personal)).not.toBe(firstPath(xd));
  expect(personal).not.toContain("<img");
});
it("preserves explicit model brands instead of overriding them with the organization", () => {
  const xd = render(
    <MobileModelIconMark providerId="xd" name="Cindy AI" logoKind="xd" />,
  );
  const claude = render(
    <MobileModelIconMark
      providerId="xd"
      name="Cindy AI"
      logoKind="xd"
      icon="claude"
    />,
  );
  expect(firstPath(claude)).toBeTruthy();
  expect(firstPath(claude)).not.toBe(firstPath(xd));
  const cindy = render(
    <MobileModelIconMark
      providerId="xd"
      name="Cindy AI"
      logoKind="xd"
      icon="cindy"
    />,
  );
  const fallback = render(
    <MobileProviderMark providerId="xd" name="Cindy AI" />,
  );
  expect(firstPath(cindy)).toBeTruthy();
  expect(firstPath(fallback)).toBe(firstPath(cindy));
});

// Unit: the real Mobile mark must switch palette and keep distinct SVG paint
// servers when multiple providers are visible; prior tests covered monochrome only.
it("renders independent spectrum marks and follows the active light/dark theme", () => {
  const pair = <>
    <MobileProviderMark name="Enterprise" providerId="byok-test" logoKind="openai-spectrum" remote />
    <MobileModelIconMark name="Enterprise" providerId="byok-test" logoKind="openai-spectrum" />
  </>;
  themeState.mode = "light";
  const light = render(pair);
  const ids = [...light.matchAll(/<linearGradient id="([^"]+)"/g)].map(match => match[1]);
  expect(ids).toHaveLength(2);
  expect(new Set(ids).size).toBe(2);
  for (const id of ids) expect(light).toContain(`fill="url(#${id})"`);
  expect(light).toContain('data-remote="true"');
  themeState.mode = "dark";
  const dark = render(pair);
  expect(dark.match(/stop-color="[^"]+"/g)).not.toEqual(light.match(/stop-color="[^"]+"/g));
  expect(dark.match(/opacity="[^"]+"/g)).not.toEqual(light.match(/opacity="[^"]+"/g));
  themeState.mode = "light";
});
