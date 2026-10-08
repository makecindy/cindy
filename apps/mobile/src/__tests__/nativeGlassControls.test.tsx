// @vitest-environment jsdom
import { act, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { NativeChromeButton } from "../platform/chrome/NativeChromeButton.ios";
import { LoginNativeButton } from "../components/LoginNativeButton.ios";
import { ShareImageNativeButton } from "../session/ShareImageNativeButton.ios";
import { useNativeGlassButtonStyle } from "../platform/chrome/nativeGlassButtonStyle.ios";
import { NewTaskSelectionSheet } from "../session/NewTaskSelectionSheet.ios";
import { ContextSheetFooterButton, ContextSheetRow } from "../session/ContextSheet.ios";
import { PermissionGuideView } from "../remote-desktop/PermissionGuideView.ios";
import type { NewTaskSelectionSheetProps } from "../session/NewTaskSelectionSheet";

const state = vi.hoisted(() => ({ glass: true, mode: "light" }));
vi.mock("@/theme", () => ({
  navigationChrome: {
    target: 44,
    clear: {
      light: { foreground: "black", scrim: "light-scrim" },
      dark: { foreground: "white", scrim: "dark-scrim" },
    },
  },
  iconSize: { action: 20 },
  iconStroke: { regular: 2 },
  radius: { pill: 9999 },
  typeScale: { body: 16 },
  spacing: { md: 12 },
  textStyles: { caption: {} },
  useTheme: () => ({
    mode: state.mode,
    colors: {
      textPrimary: "primary",
      textSecondary: "secondary",
      cta: state.mode === "dark" ? "white" : "black",
      ctaText: state.mode === "dark" ? "black" : "white",
      destructive: "danger",
      surfaceElevated: "surface",
    },
  }),
}));
vi.mock("@/session/useLiquidGlassAvailable", () => ({
  useLiquidGlassAvailable: () => state.glass,
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("@/session/ComposerSheet", () => ({
  ComposerSheet: ({ children, footer }: any) => <div>{children}{footer}</div>,
}));
vi.mock("@/session/ComposerNativeRow", () => ({ ComposerNativeRow: () => null }));
vi.mock("@/session/ComposerNativeSection", () => ({
  ComposerNativeSection: ({ children }: any) => <div>{children}</div>,
}));
vi.mock("@/session/newSessionMessages", () => ({ newSessionText: (key: string) => key }));
vi.mock("@/components/AppText", () => ({ Text: ({ children }: any) => <span>{children}</span> }));
vi.mock("react-native", () => ({
  View: ({ children, style }: any) => <div data-rn-style={JSON.stringify(style)}>{children}</div>,
  Image: () => null,
}));
vi.mock("lucide-react-native", () => {
  const Icon = () => null;
  return {
    LogOut: Icon,
    Monitor: Icon,
    Search: Icon,
    Settings: Icon,
    UsersRound: Icon,
  };
});
vi.mock("@expo/ui", () => ({
  Host: ({ children }: any) => <div>{children}</div>,
}));
vi.mock("@expo/ui/swift-ui", () => {
  const Container = ({ children }: any) => <div>{children}</div>;
  return {
    HStack: ({ children, modifiers }: any) => <div data-hstack-style={JSON.stringify(modifiers)}>{children}</div>,
    VStack: Container,
    Spacer: () => null,
    RNHostView: Container,
    Text: ({ children, modifiers }: any) => <span data-text-style={JSON.stringify(modifiers)}>{children}</span>,
    Picker: Container,
    Toggle: () => null,
    Divider: () => null,
    LabeledContent: Container,
    Image: () => null,
    Label: ({ title, modifiers }: any) => (
      <span data-label-style={JSON.stringify(modifiers)}>{title}</span>
    ),
    ProgressView: ({ modifiers }: any) => <span role="progressbar" data-progress-style={JSON.stringify(modifiers)} />,
    Button: ({ children, label, onPress, testID, modifiers = [] }: any) => (
      <button
        data-testid={testID}
        data-button-style={JSON.stringify(modifiers)}
        disabled={modifiers.some((m: any) => m.name === "disabled" && m.value)}
        onClick={onPress}
      >
        {children ?? label}
      </button>
    ),
  };
});
vi.mock("@expo/ui/swift-ui/modifiers", () => {
  const names = [
    "background",
    "buttonBorderShape",
    "buttonStyle",
    "contentShape",
    "controlSize",
    "foregroundStyle",
    "frame",
    "glassEffect",
    "accessibilityElement",
    "accessibilityLabel",
    "accessibilityAddTraits",
    "disabled",
    "font",
    "labelStyle",
    "lineLimit",
    "tint",
    "pickerStyle",
    "tag",
    "listRowInsets",
    "fixedSize",
    "multilineTextAlignment",
    "padding",
  ];
  return {
    ...Object.fromEntries(
      names.map((name) => [name, (value: any) => ({ name, value })]),
    ),
    shapes: { circle: () => "circle", capsule: () => "capsule", roundedRectangle: () => "roundedRectangle", rectangle: () => "rectangle" },
  };
});
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const roots: ReturnType<typeof createRoot>[] = [];
afterEach(() => {
  act(() => roots.splice(0).forEach((root) => root.unmount()));
  state.glass = true;
  state.mode = "light";
});
function mount(children: ReactNode) {
  const host = document.createElement("div");
  const root = createRoot(host);
  roots.push(root);
  act(() => root.render(children));
  return host;
}

it.each(["light", "dark"])("keeps the context row label and hit area while toggling a sized trailing icon in %s", (mode) => {
  state.mode = mode;
  const onPress = vi.fn();
  function PlanRow() {
    const [selected, setSelected] = useState(false);
    return <ContextSheetRow
      icon={<span data-testid="plan-icon">icon</span>}
      label="Plan mode"
      onPress={() => { onPress(); setSelected((value) => !value); }}
      trailing={selected ? <span data-testid="plan-check">✓</span> : null}
      trailingSize={16}
    />;
  }
  const host = mount(<PlanRow />);
  const button = host.querySelector("button")!;
  expect(host.querySelector('[data-testid="plan-check"]')).toBeNull();
  act(() => button.click());
  expect(button.textContent).toContain("Plan mode");
  expect(host.querySelector('[data-testid="plan-icon"]')).not.toBeNull();
  const trailing = host.querySelector('[data-testid="plan-check"]')!.parentElement!;
  expect(JSON.parse(trailing.getAttribute("data-rn-style")!)).toMatchObject({ width: 16, height: 16 });
  expect(JSON.parse(host.querySelector("[data-hstack-style]")!.getAttribute("data-hstack-style")!))
    .toContainEqual({ name: "frame", value: expect.objectContaining({ minHeight: 44 }) });
  act(() => button.click());
  expect(button.textContent).toContain("Plan mode");
  expect(host.querySelector('[data-testid="plan-check"]')).toBeNull();
  expect(onPress).toHaveBeenCalledTimes(2);
});

it("lets custom trailing text keep its content size and preserves busy-row behavior", () => {
  const props = { icon: <span>icon</span>, label: "Model", onPress: vi.fn() };
  const host = mount(<ContextSheetRow {...props} trailing={<span data-testid="model-detail">A long model name</span>} />);
  const detail = host.querySelector('[data-testid="model-detail"]')!;
  expect(detail.textContent).toBe("A long model name");
  expect(detail.parentElement!.hasAttribute("data-rn-style")).toBe(false);
  const busyHost = mount(<ContextSheetRow {...props} busy trailing={<span>✓</span>} trailingSize={16} />);
  expect(busyHost.querySelector('[role="progressbar"]')).not.toBeNull();
  expect(busyHost.textContent).not.toContain("✓");
  expect(busyHost.querySelector("button")!.disabled).toBe(true);
});
it("prevents disabled glass actions", () => {
  const click = vi.fn();
  const host = mount(
    <NativeChromeButton
      label="disabled"
      testID="disabled"
      disabled
      onPress={click}
    />,
  );
  act(() =>
    (
      host.querySelector('[data-testid="disabled"]') as HTMLButtonElement
    ).click(),
  );
  expect(click).not.toHaveBeenCalled();
});
it.each(["light", "dark"])(
  "pairs the share label with the CTA foreground and disables activation in %s",
  (mode) => {
    state.mode = mode;
    const click = vi.fn();
    const host = mount(
      <ShareImageNativeButton label="Share image" disabled onPress={click}>
        <button>fallback</button>
      </ShareImageNativeButton>,
    );
    expect(host.querySelectorAll("button")).toHaveLength(1);
    const label = host.querySelector("[data-label-style]")!;
    expect(label.textContent).toBe("Share image");
    // Inherit the native button's Dynamic Type font instead of fixing its size.
    expect(
      JSON.parse(label.getAttribute("data-label-style")!),
    ).not.toContainEqual(expect.objectContaining({ name: "font" }));
    expect(JSON.parse(label.getAttribute("data-label-style")!)).toContainEqual({
      name: "foregroundStyle",
      value: mode === "dark" ? "black" : "white",
    });
    act(() => host.querySelector("button")!.click());
    expect(click).not.toHaveBeenCalled();
  },
);
it.each(["light", "dark"])(
  "keeps clear glass foreground/backing paired in %s",
  (mode) => {
    state.mode = mode;
    let modifiers: any[] = [];
    function Probe() {
      modifiers = useNativeGlassButtonStyle({ shape: "circle", clear: true });
      return null;
    }
    mount(<Probe />);
    expect(modifiers).toContainEqual({
      name: "foregroundStyle",
      value: mode === "light" ? "black" : "white",
    });
    expect(modifiers).toContainEqual({
      name: "background",
      value: `${mode}-scrim`,
    });
    expect(modifiers).toContainEqual({
      name: "frame",
      value: { width: 44, height: 44 },
    });
  },
);
it("keeps unsupported-glass controls native with bordered prominent styling", () => {
  state.glass = false;
  let modifiers: any[] = [];
  function Probe() {
    modifiers = useNativeGlassButtonStyle({ prominent: true });
    return null;
  }
  mount(<Probe />);
  expect(modifiers).toContainEqual({
    name: "buttonStyle",
    value: "borderedProminent",
  });
  expect(modifiers.some((m) => m.name === "glassEffect")).toBe(false);
});

it.each(["light", "dark"])(
  "blocks repeated login submissions while busy, then re-enables in %s",
  (mode) => {
    state.mode = mode;
    const click = vi.fn();
    const host = document.createElement("div");
    const root = createRoot(host);
    roots.push(root);
    const render = (busy: boolean) =>
      root.render(
        <LoginNativeButton
          label="Verify"
          onPress={click}
          busy={busy}
          width={540}
          height={80}
          fontSize={24}
          variant="primary"
        />,
      );
    act(() => render(true));
    expect(host.querySelector('[role="progressbar"]')).not.toBeNull();
    act(() => host.querySelector("button")!.click());
    expect(click).not.toHaveBeenCalled();
    act(() => render(false));
    expect(host.querySelector('[role="progressbar"]')).toBeNull();
    act(() => host.querySelector("button")!.click());
    expect(click).toHaveBeenCalledTimes(1);
  },
);

it("keeps provider artwork inside a native button and prevents disabled activation", () => {
  const click = vi.fn();
  const host = mount(
    <LoginNativeButton
      label="Provider"
      disabled
      onPress={click}
      width={80}
      height={80}
      fontSize={24}
      variant="circle"
    >
      <span data-brand="original" />
    </LoginNativeButton>,
  );
  expect(host.querySelectorAll("button")).toHaveLength(1);
  expect(host.querySelector('button [data-brand="original"]')).not.toBeNull();
  // A duplicate foreground closer to the native label would override this
  // disabled color even if the last modifier appears correct in a DOM mock.
  expect(JSON.parse(host.querySelector("button")!.getAttribute("data-button-style")!)
    .filter((modifier: any) => modifier.name === "foregroundStyle"))
    .toEqual([{ name: "foregroundStyle", value: "secondary" }]);
  act(() => host.querySelector("button")!.click());
  expect(click).not.toHaveBeenCalled();
});

it.each(["light", "dark"])("pairs prominent fill and foreground across native styles in %s", (mode) => {
  state.mode = mode;
  const foreground = mode === "dark" ? "black" : "white";
  const fill = mode === "dark" ? "white" : "black";
  for (const glass of [true, false]) {
    state.glass = glass;
    for (const options of [{}, { shape: "circle" as const }, { dimensions: { height: 44 } }]) {
      let modifiers: any[] = [];
      function Probe() {
        modifiers = useNativeGlassButtonStyle({ ...options, prominent: true });
        return null;
      }
      mount(<Probe />);
      if ("shape" in options || "dimensions" in options) {
        // Framed login controls own their label colors, including disabled ones.
        expect(modifiers.some((m) => m.name === "foregroundStyle")).toBe(false);
        expect(modifiers).toContainEqual(glass
          ? { name: "glassEffect", value: expect.objectContaining({ glass: expect.objectContaining({ tint: fill }) }) }
          : { name: "background", value: fill });
      } else {
        expect(modifiers).toContainEqual({ name: "foregroundStyle", value: foreground });
        expect(modifiers).toContainEqual({ name: "tint", value: fill });
      }
    }
  }
});

function directoryProps(overrides: Partial<NewTaskSelectionSheetProps> = {}): NewTaskSelectionSheetProps {
  return {
    page: "directory", busy: false, loading: false, error: null,
    devices: [], selectedDeviceId: "", workspaces: [], workspaceKind: "project", workingDir: "/project",
    path: "/project", parent: "/", drives: [], entries: [], showHidden: false,
    onClose: vi.fn(), onBack: vi.fn(), onDevice: vi.fn(), onDialogue: vi.fn(),
    onProject: vi.fn(), onBrowse: vi.fn(), onEnter: vi.fn(), onChoose: vi.fn(), onShowHidden: vi.fn(),
    ...overrides,
  };
}

it.each(["light", "dark"])("gives the current-folder label a contrasting color and keeps selection working in %s", (mode) => {
  state.mode = mode;
  const props = directoryProps();
  const host = mount(<NewTaskSelectionSheet {...props} />);
  const button = host.querySelector('[data-testid="newSession.remoteBrowseSelectCurrent"]')!;
  expect(JSON.parse(button.querySelector("[data-text-style]")!.getAttribute("data-text-style")!))
    .toContainEqual({ name: "foregroundStyle", value: mode === "dark" ? "black" : "white" });
  act(() => (button as HTMLButtonElement).click());
  expect(props.onChoose).toHaveBeenCalledExactlyOnceWith("/project");
});

it.each([{ busy: true }, { loading: true }, { error: "Unavailable" }, { path: "" }])("keeps unavailable folders unselectable: %j", (overrides) => {
  const props = directoryProps(overrides);
  const host = mount(<NewTaskSelectionSheet {...props} />);
  const button = host.querySelector('[data-testid="newSession.remoteBrowseSelectCurrent"]') as HTMLButtonElement;
  expect(button.disabled).toBe(true);
  act(() => button.click());
  expect(props.onChoose).not.toHaveBeenCalled();
});

it.each(["light", "dark"])("keeps footer text and loading indicator legible in %s", (mode) => {
  state.mode = mode;
  const foreground = mode === "dark" ? "black" : "white";
  const host = mount(<ContextSheetFooterButton label="Confirm" onPress={vi.fn()} />);
  expect(JSON.parse(host.querySelector("[data-text-style]")!.getAttribute("data-text-style")!))
    .toContainEqual({ name: "foregroundStyle", value: foreground });
  const busyHost = mount(<ContextSheetFooterButton label="Confirm" busy onPress={vi.fn()} />);
  expect(busyHost.textContent).not.toContain("Confirm");
  expect(JSON.parse(busyHost.querySelector('[role="progressbar"]')!.getAttribute("data-progress-style")!))
    .toContainEqual({ name: "tint", value: foreground });
  expect(busyHost.querySelector("button")!.disabled).toBe(true);
});

it.each(["light", "dark"])("pairs permission-guide primary labels without changing the secondary label in %s", (mode) => {
  state.mode = mode;
  for (const guideLabel of ["Open settings", undefined]) {
    const host = mount(<PermissionGuideView title="Permissions" intro="Enable access" rows={[]}
      guideLabel={guideLabel} pending={false} onGuide={vi.fn()} reconnectLabel="Reconnect" onReconnect={vi.fn()} />);
    const buttons = [...host.querySelectorAll("button")];
    buttons.forEach((button, index) => {
      const primary = !guideLabel || index === 0;
      expect(JSON.parse(button.querySelector("[data-text-style]")!.getAttribute("data-text-style")!))
        .toContainEqual({ name: "foregroundStyle", value: primary ? (mode === "dark" ? "black" : "white") : "primary" });
    });
  }
});
