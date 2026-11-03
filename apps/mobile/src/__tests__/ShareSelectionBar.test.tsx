// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { ShareSelectionBar } from "@/session/ShareSelectionBar";

const state = vi.hoisted(() => ({ fontScale: 1, layout: undefined as any }));
vi.mock("react-native", () => ({
  useWindowDimensions: () => ({ width: 1000, fontScale: state.fontScale }),
  StyleSheet: { create: (styles: any) => styles, hairlineWidth: 1 },
  View: ({ children, testID, onLayout, style }: any) => {
    if (testID === "session.shareImage.bar") state.layout = onLayout;
    return (
      <div
        data-testid={testID}
        data-direction={
          Object.assign({}, ...[style].flat().filter(Boolean)).flexDirection
        }
      >
        {children}
      </div>
    );
  },
  Pressable: ({ children }: any) => <button>{children}</button>,
}));
vi.mock("@/theme", () => ({
  useTheme: () => ({ colors: {} }),
  useThemedStyles: (factory: any) => factory({}),
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("lucide-react-native", () => ({ Share: () => null, X: () => null }));
vi.mock("@/components/AppText", () => ({
  Text: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));
vi.mock("@/session/HomeHeaderGlassButton", () => ({
  HomeHeaderGlassButton: () => null,
}));
vi.mock("@/session/ShareImageNativeButton", () => ({
  ShareImageNativeButton: ({ children }: { children: ReactNode }) => (
    <>{children}</>
  ),
}));

it("uses panel width and responds to resizing and larger fonts", async () => {
  const host = document.createElement("div");
  const root = createRoot(host);
  const render = () =>
    root.render(
      <ShareSelectionBar count={1} onCancel={() => {}} onShare={() => {}} />,
    );
  try {
    await act(render);
    const bar = () =>
      host.querySelector('[data-testid="session.shareImage.bar"]')!;
    await act(() => state.layout({ nativeEvent: { layout: { width: 320 } } }));
    expect(bar().getAttribute("data-direction")).toBe("column");
    await act(() => state.layout({ nativeEvent: { layout: { width: 500 } } }));
    expect(bar().getAttribute("data-direction")).toBe("row");
    state.fontScale = 1.5;
    await act(render);
    expect(bar().getAttribute("data-direction")).toBe("column");
  } finally {
    await act(() => root.unmount());
    state.fontScale = 1;
  }
});
