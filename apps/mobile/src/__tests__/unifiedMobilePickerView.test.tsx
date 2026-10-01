// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { UnifiedModelPickerView } from "@/session/UnifiedModelPickerView";
const virtualList = vi.hoisted(() => ({ scrollToOffset: vi.fn() }));
vi.mock("react-native", async () => {
  const { createElement: el, useImperativeHandle } = await import("react");
  const View = ({ children }: any) => el("div", null, children);
  return {
    Platform: { OS: "android" },
    View,
    ScrollView: View,
    FlatList: ({
      ref,
      data,
      renderItem,
      ListHeaderComponent,
      ListEmptyComponent,
    }: any) => {
      useImperativeHandle(
        ref,
        () => ({ scrollToOffset: virtualList.scrollToOffset }),
        [],
      );
      return el(
        "div",
        null,
        ListHeaderComponent,
        data.length
          ? data.map((item: any, index: number) =>
              el("div", { key: item.key }, renderItem({ item, index })),
            )
          : ListEmptyComponent,
      );
    },
    Pressable: ({ children, onPress, disabled }: any) =>
      el("button", { onClick: onPress, disabled }, children),
    StyleSheet: { create: (styles: any) => styles, hairlineWidth: 1 },
    useWindowDimensions: () => ({ height: 800 }),
  };
});
vi.mock("@/components/AppText", async () => {
  const { createElement: el } = await import("react");
  return {
    Text: ({ children }: any) => el("span", null, children),
    TextInput: () => null,
  };
});
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 40, bottom: 20 }),
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("lucide-react-native", () =>
  Object.fromEntries(
    [
      "Brain",
      "Star",
      "SlidersHorizontal",
      "Check",
      "Zap",
      "LayoutGrid",
      "Search",
      "X",
      "ChevronDown",
      "ChevronRight",
      "ChevronsUpDown",
    ].map((key) => [key, () => null]),
  ),
);
vi.mock("@/platform/chrome", () => ({
  NativePullDownMenu: ({ children }: any) => children,
  NativeSwitch: () => null,
  usesNativePullDownMenu: () => true,
}));
vi.mock("@/components/MobileAgentMark", () => ({
  MobileAgentMark: () => null,
}));
vi.mock("@/session/MobileProviderMark", () => ({
  MobileModelIconMark: () => null,
  MobileProviderMark: () => null,
}));
vi.mock("@/session/SheetModal", () => ({
  SheetModal: ({ children }: any) => children,
}));
vi.mock("@/session/SheetSurface", () => ({
  SheetSurface: ({ children, renderScrollContent }: any) =>
    renderScrollContent ? renderScrollContent({}) : children,
}));
vi.mock("@/session/sessionAgentSwitch", () => ({
  mobileAgentLabel: (agent: string) => agent,
}));
vi.mock("@/theme", async () => ({
  ...(await import("@/theme/tokens")),
  useTheme: () => ({ colors: {} }),
  useThemedStyles: (factory: any) => factory({}),
}));
let root: ReturnType<typeof createRoot>;
let host: HTMLDivElement;
beforeEach(() => {
  virtualList.scrollToOffset.mockClear();
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div");
  root = createRoot(host);
});
afterEach(() => act(() => root.unmount()));
it.each([null, "2d · 70%"])(
  "keeps both account identities visible with quota %s",
  async (quotaLabel) => {
    const rows = ["first@example.com", "second@example.com"].map(
      (subtitle) => ({
        key: subtitle,
        subtitle,
        quotaLabel,
        entry: { displayName: "Same Model" },
        config: { agent: "codex" },
        providerMark: {},
      }),
    );
    await act(async () =>
      root.render(
        createElement(UnifiedModelPickerView, {
          visible: true,
          groups: [{ key: "favorites", title: "Favorites", rows }],
          filters: [],
        } as any),
      ),
    );
    for (const row of rows) expect(host.textContent).toContain(row.subtitle);
    if (quotaLabel) expect(host.textContent).toContain(quotaLabel);
  },
);
it.each(["query", "filter"])(
  "returns to the first result when %s changes after scrolling",
  async (field) => {
    const props = {
      visible: true,
      groups: [],
      filters: [],
      query: "",
      filter: "all",
      emptyHint: "No results",
    };
    await act(async () =>
      root.render(createElement(UnifiedModelPickerView, props as any)),
    );
    virtualList.scrollToOffset.mockClear();
    await act(async () =>
      root.render(
        createElement(UnifiedModelPickerView, {
          ...props,
          [field]: "changed",
        } as any),
      ),
    );
    expect(virtualList.scrollToOffset).toHaveBeenCalledWith({
      offset: 0,
      animated: false,
    });
    expect(host.textContent).toContain("No results");
  },
);
