// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PreviewTabEntry } from "../PreviewTabEntry";

const fixture = vi.hoisted(() => ({
  tabs: [] as Array<{
    sessionId: string;
    pluginName: string;
    title: string;
    ref?: string;
  }>,
  focused: true,
  push: vi.fn(),
  alert: vi.fn(),
  active: [] as boolean[],
}));
vi.mock("react-native", async () => {
  const { createElement } = await import("react");
  const view = (tag: string) => (p: any) =>
    createElement(
      tag,
      {
        onClick: p.onPress,
        "aria-label": p.accessibilityLabel,
        "data-testid": p.testID,
      },
      typeof p.children === "function" ? p.children({ pressed: false }) : p.children,
    );
  return {
    Alert: { alert: fixture.alert },
    View: view("div"),
    Pressable: view("button"),
    StyleSheet: { create: (s: unknown) => s, hairlineWidth: 1 },
  };
});
vi.mock("@/components/AppText", () => ({
  Text: (p: any) => createElement("span", {}, p.children),
}));
vi.mock("expo-router", () => ({ useIsFocused: () => fixture.focused }));
vi.mock("lucide-react-native", () => ({
  ChevronRight: () => null,
  MonitorSmartphone: () => null,
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) =>
      values ? `${key}:${JSON.stringify(values)}` : key,
  }),
}));
vi.mock("@/theme", async () => {
  const tokens = await import("@/theme/tokens");
  return {
    ...tokens,
    useTheme: () => ({ colors: tokens.lightColors, mode: "light" }),
    useThemedStyles: (make: any) => make(tokens.lightColors),
  };
});
vi.mock("@/utils/useGuardedPush", () => ({ useGuardedPush: () => fixture.push }));
vi.mock("../usePreviewTabs", () => ({
  usePreviewTabs: (options: { active: boolean }) => {
    fixture.active.push(options.active);
    return fixture.tabs;
  },
}));

let root: Root;
let host: HTMLDivElement;
const render = () =>
  act(() =>
    root.render(
      createElement(PreviewTabEntry, {
        deviceId: "pc",
        deviceName: "My Mac",
        sessionId: "s1",
      }),
    ),
  );
const entry = () =>
  host.querySelector<HTMLButtonElement>('[data-testid="session.previewEntry"]');
beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  fixture.tabs = [];
  fixture.focused = true;
  fixture.active = [];
  host = document.createElement("div");
  root = createRoot(host);
});
afterEach(() => act(() => root.unmount()));

describe("preview entry strip", () => {
  it("renders nothing without a listed preview", () => {
    render();
    expect(entry()).toBeNull();
    expect(host.textContent).toBe("");
  });

  it("opens the only preview directly, by task and plugin, never by grant", () => {
    fixture.tabs = [{ sessionId: "s1", pluginName: "Baguette", title: "Sim" }];
    render();
    expect(host.textContent).toContain("remoteDesktop.previewEntry");
    expect(host.textContent).toContain("Baguette · Sim");
    act(() => entry()!.click());
    expect(fixture.push).toHaveBeenCalledWith({
      pathname: "/devices/desktop/[deviceId]",
      params: {
        deviceId: "pc",
        deviceName: "My Mac",
        previewSession: "s1",
        previewPlugin: "Baguette",
        previewTitle: "Sim",
      },
    });
    expect(fixture.alert).not.toHaveBeenCalled();
  });

  it("names the tab by its stable ref in the route when the computer gave one", () => {
    fixture.tabs = [
      { sessionId: "s1", pluginName: "Baguette", title: "Sim", ref: "tab_1-B" },
    ];
    render();
    act(() => entry()!.click());
    expect(fixture.push.mock.calls[0][0].params).toEqual({
      deviceId: "pc",
      deviceName: "My Mac",
      previewSession: "s1",
      previewPlugin: "Baguette",
      previewTitle: "Sim",
      previewRef: "tab_1-B",
    });
  });

  it("offers a choice when the task has several previews", () => {
    fixture.tabs = [
      { sessionId: "s1", pluginName: "Baguette", title: "Sim" },
      { sessionId: "s1", pluginName: "Maker", title: "" },
    ];
    render();
    expect(host.textContent).toContain('remoteDesktop.previewEntryMany:{"count":2}');
    act(() => entry()!.click());
    expect(fixture.push).not.toHaveBeenCalled();
    const [title, , buttons] = fixture.alert.mock.calls[0];
    expect(title).toBe("remoteDesktop.previewEntryChoose");
    expect(buttons.map((b: any) => b.text)).toEqual([
      "Baguette · Sim",
      "Maker",
      "remoteDesktop.close",
    ]);
    buttons[1].onPress();
    expect(fixture.push.mock.calls[0][0].params).toMatchObject({
      previewPlugin: "Maker",
    });
  });

  it("only watches while the page is focused", () => {
    fixture.focused = false;
    render();
    expect(fixture.active.every((value) => value === false)).toBe(true);
  });
});
