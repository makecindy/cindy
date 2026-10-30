import { createElement } from "react";
import { renderToStaticMarkup as render } from "react-dom/server";
import { expect, it, vi } from "vitest";
import {
  MobileProviderMark,
  MobileModelIconMark,
} from "@/session/MobileProviderMark";

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
  Path: (props: any) => createElement("path", props),
}));
vi.mock("@/theme", () => ({
  useTheme: () => ({ colors: { textSecondary: "currentColor" } }),
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
