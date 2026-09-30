// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { frame } from "@expo/ui/swift-ui/modifiers";
import {
  RemoteDesktopPanel,
  RemoteDesktopToolbar,
} from "../RemoteDesktopChrome.ios";

const state = vi.hoisted(() => ({
  presentation: null as any,
  glass: true,
  safe: { top: 0, bottom: 21, left: 62, right: 0 },
}));
vi.mock("react-native", async () => {
  const { createElement } = await import("react");
  const View = ({ children, testID, style }: any) =>
    createElement("div", { "data-testid": testID, style }, children);
  return {
    View,
    ScrollView: View,
    useWindowDimensions: () => ({ width: 874, height: 402 }),
  };
});
vi.mock("@expo/ui", async () => ({
  Host: (await import("react-native")).View,
}));
vi.mock("@/components/AppText", async () => ({
  Text: (await import("react-native")).View,
}));
vi.mock("../RemoteDesktopPanelButton", () => ({
  RemoteDesktopPanelButton: ({ label, onPress }: any) => (
    <button onClick={onPress}>{label}</button>
  ),
}));
vi.mock("@expo/ui/swift-ui", async () => {
  const { createElement } = await import("react");
  const View = (await import("react-native")).View;
  const presentation = (kind: string) => (props: any) => {
    state.presentation = { ...props, kind };
    return props.isPresented ? createElement(View, null, props.children) : null;
  };
  return {
    HStack: View,
    VStack: View,
    Group: View,
    Spacer: () => null,
    Text: View,
    RNHostView: View,
    Button: ({ children, label, onPress, testID, modifiers = [] }: any) =>
      createElement(
        "button",
        {
          onClick: onPress,
          "data-testid": testID,
          "aria-label": label,
          disabled: modifiers.some(
            (m: any) => m.name === "disabled" && m.value,
          ),
        },
        children,
      ),
    BottomSheet: presentation("sheet"),
    Popover: Object.assign(presentation("popover"), {
      Trigger: () => null,
      Content: View,
    }),
  };
});
vi.mock("@expo/ui/swift-ui/modifiers", () =>
  Object.fromEntries(
    [
      "accessibilityAddTraits",
      "accessibilityElement",
      "accessibilityLabel",
      "background",
      "buttonBorderShape",
      "buttonStyle",
      "contentShape",
      "disabled",
      "font",
      "foregroundStyle",
      "frame",
      "glassEffect",
      "labelStyle",
      "onGeometryChange",
      "padding",
      "presentationDetents",
      "presentationDragIndicator",
    ]
      .map((name) => [name, vi.fn((value: unknown) => ({ name, value }))])
      .concat([
        ["shapes", { capsule: vi.fn(), circle: vi.fn(), rectangle: vi.fn() }],
      ] as any),
  ),
);
vi.mock("lucide-react-native", () => ({
  ArrowLeft: () => null,
  ArrowRight: () => null,
  Menu: () => null,
  Keyboard: () => null,
  SlidersHorizontal: () => null,
}));
vi.mock("../RemoteDesktopIcons", () => ({
  AllWindowsIcon: () => null,
  ShowDesktopIcon: () => null,
  WorkspaceLeftIcon: () => <span data-icon="workspace-left" />,
  WorkspaceRightIcon: () => <span data-icon="workspace-right" />,
  OmarchyMenuIcon: () => <span data-icon="omarchy" />,
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => state.safe,
}));
vi.mock("@/theme", () => ({
  navigationChrome: { target: 44, clear: { dark: { foreground: '#FFFFFF', scrim: 'rgba(0, 0, 0, 0.35)', selected: 'rgba(255, 255, 255, 0.18)' }, light: { foreground: '#000000', scrim: 'rgba(255, 255, 255, 0.35)', selected: 'rgba(0, 0, 0, 0.10)' } } },
  iconSize: { action: 24 },
  typeScale: { body: 16, caption: 12 },
  lineHeight: { body: 22, caption: 18 },
  iconStroke: { regular: 2 },
  fontWeight: { semibold: "600" },
  spacing: { xs: 4, sm: 8, md: 12, lg: 16, xl: 24 },
  useTheme: () => ({
    mode: "dark",
    colors: {
      textPrimary: "#fff",
      textSecondary: "#aaa",
      surfaceElevated: "#222",
      surfaceChip: "#333",
    },
  }),
}));
vi.mock("@/session/useLiquidGlassAvailable", () => ({
  useLiquidGlassAvailable: () => state.glass,
}));

function mount(element: ReactNode) {
  const host = document.createElement("div");
  const root = createRoot(host);
  act(() => root.render(element));
  return {
    host,
    render: (next: ReactNode) => act(() => root.render(next)),
    close: () => act(() => root.unmount()),
  };
}

it("keeps operations usable without control, with compact landscape order", () => {
  const operations = vi.fn();
  const desktop = vi.fn();
  const v = mount(
    <RemoteDesktopToolbar
      landscape
      canControl={false}
      keyboard={false}
      operations={false}
      onWindows={vi.fn()}
      onDesktop={desktop}
      onKeyboard={vi.fn()}
      onOperations={operations}
    />,
  );
  const buttons = [...v.host.querySelectorAll("button")];
  expect(buttons.map((b) => b.dataset.testid)).toEqual([
    "remoteDesktop.operations",
    "remoteDesktop.keyboard",
    "remoteDesktop.showDesktop",
    "remoteDesktop.allWindows",
  ]);
  act(() => {
    buttons[0].click();
    buttons[2].click();
  });
  expect(operations).toHaveBeenCalledOnce();
  expect(desktop).not.toHaveBeenCalled();
  v.close();
});

it.each([false, true])(
  "shows Omarchy desktop navigation with five accessible targets (landscape=%s)",
  (landscape) => {
    const left = vi.fn(),
      right = vi.fn(),
      menu = vi.fn();
    const props = {
      landscape,
      canControl: true,
      keyboard: false,
      operations: false,
      onWindows: vi.fn(),
      onDesktop: vi.fn(),
      onKeyboard: vi.fn(),
      onOperations: vi.fn(),
      onWorkspaceLeft: left,
      onWorkspaceRight: right,
      onOmarchyMenu: menu,
    };
    const v = mount(<RemoteDesktopToolbar {...props} />);
    for (const icon of ["workspace-left", "workspace-right", "omarchy"])
      expect(v.host.querySelector(`[data-icon="${icon}"]`)).not.toBeNull();
    for (const key of ["workspaceLeft", "workspaceRight", "omarchyMenu"])
      act(() =>
        v.host
          .querySelector<HTMLButtonElement>(
            `[data-testid="remoteDesktop.${key}"]`,
          )!
          .click(),
      );
    expect(left).toHaveBeenCalledOnce();
    expect(right).toHaveBeenCalledOnce();
    expect(menu).toHaveBeenCalledOnce();
    expect(v.host.querySelectorAll("button")).toHaveLength(5);
    const surface = v.host.firstElementChild as HTMLElement;
    expect(landscape ? surface.style.height : surface.style.width).toBe(
      "220px",
    );
    expect(
      v.host.querySelector('[data-testid="remoteDesktop.showDesktop"]'),
    ).toBeNull();
    v.render(<RemoteDesktopToolbar {...props} canControl={false} />);
    for (const key of ["workspaceLeft", "workspaceRight", "omarchyMenu"])
      expect(
        v.host.querySelector<HTMLButtonElement>(
          `[data-testid="remoteDesktop.${key}"]`,
        )!.disabled,
      ).toBe(true);
    v.close();
  },
);

it.each([false, true])(
  "keeps one hosted surface while navigating and updating the header (landscape=%s)",
  (landscape) => {
    const props = {
      landscape,
      visible: true,
      topInset: 0,
      title: "Settings",
      caption: "Computer",
      onClose: vi.fn(),
    };
    const v = mount(
      <RemoteDesktopPanel {...props} page="controls">
        <span>Controls</span>
      </RemoteDesktopPanel>,
    );
    let root = v.host.querySelector(
      '[data-testid="remoteDesktop.panelContentRoot"]',
    );
    expect(root).not.toBeNull();
    const presentation = v.host.firstElementChild;
    const scroll = v.host.querySelector(
      '[data-testid="remoteDesktop.panelScroll"]',
    );
    for (const page of ["display", "security", "controls"]) {
      v.render(
        <RemoteDesktopPanel
          {...props}
          page={page}
          onBack={page === "controls" ? undefined : vi.fn()}
        >
          <span>{page}</span>
        </RemoteDesktopPanel>,
      );
      const next = v.host.querySelector(
        '[data-testid="remoteDesktop.panelContentRoot"]',
      );
      expect(next).toBe(root);
      root = next;
      expect(root?.textContent).toContain(page);
      expect(v.host.firstElementChild).toBe(presentation);
      expect(state.presentation.isPresented).toBe(true);
      expect(props.onClose).not.toHaveBeenCalled();
    }
    expect(
      v.host.querySelector('[data-testid="remoteDesktop.panelScroll"]'),
    ).not.toBe(scroll);
    v.close();
  },
);

it("switches presentation on rotation and routes system dismissal to the owner", () => {
  const onClose = vi.fn();
  const props = {
    topInset: 0,
    title: "Operations",
    caption: "Computer",
    onClose,
    children: <span>Settings</span>,
  };
  const v = mount(<RemoteDesktopPanel {...props} visible landscape={false} />);
  expect(state.presentation.kind).toBe("sheet");
  expect(v.host.textContent).toContain("Settings");
  v.render(<RemoteDesktopPanel {...props} visible landscape />);
  expect(state.presentation.kind).toBe("popover");
  act(() => state.presentation.onIsPresentedChange(false));
  expect(onClose).toHaveBeenCalledOnce();
  v.render(<RemoteDesktopPanel {...props} visible={false} landscape />);
  expect(v.host.textContent).not.toContain("Settings");
  v.close();
});

it("anchors the popover to the centered rail and opens inward after either rotation", () => {
  const props = {
    landscape: true,
    visible: true,
    topInset: 0,
    title: "Operations",
    caption: "Computer",
    onClose: vi.fn(),
    children: <span>Controls</span>,
  };
  const v = mount(<RemoteDesktopPanel {...props} />);
  for (const islandRight of [false, true, false]) {
    state.safe = { top: 0, bottom: 21, left: 62, right: 62 };
    v.render(<RemoteDesktopPanel {...props} toolbarOnLeft={islandRight} />);
    const anchor = v.host.firstElementChild as HTMLElement;
    expect(anchor.style.top).toBe("102.5px");
    expect(anchor.style.left).toBe(islandRight ? "16px" : "");
    expect(anchor.style.right).toBe(islandRight ? "" : "16px");
    expect(state.presentation.attachmentAnchor).toBe(
      islandRight ? "trailing" : "leading",
    );
    expect(state.presentation.arrowEdge).toBe(
      islandRight ? "leading" : "trailing",
    );
  }
  v.render(<RemoteDesktopPanel {...props} toolbarActionCount={5} />);
  expect((v.host.firstElementChild as HTMLElement).style.top).toBe("80.5px");
  v.close();
});

it("offers a useful ideal popover height without forcing that height on a smaller presentation", () => {
  vi.mocked(frame).mockClear();
  state.safe = { top: 0, bottom: 21, left: 62, right: 0 };
  const v = mount(
    <RemoteDesktopPanel landscape topInset={0} title="Operations" caption="Computer" onClose={vi.fn()}>
      <span>Controls</span>
    </RemoteDesktopPanel>,
  );
  const frames = vi.mocked(frame).mock.calls.map(([value]) => value);
  // The RN scroll view has no intrinsic preferred height. Only a maximum
  // collapses it; a fixed height instead overflows the system popover bounds.
  expect(frames).toContainEqual({ minHeight: 44, idealHeight: 365, maxHeight: 365 });
  expect(frames.filter((value) => value.height !== undefined)).toEqual([
    { width: 44, height: 44 },
  ]);
  expect(v.host.textContent).toContain("Controls");
  v.close();
});
