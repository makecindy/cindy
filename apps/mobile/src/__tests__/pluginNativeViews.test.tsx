// @vitest-environment jsdom
import { PluginNativeNotice, PluginNotice as PluginNoticeHost } from "@/plugins/PluginNotice.ios";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PluginDirectoryView } from "@/plugins/PluginDirectoryView.ios";
import { PluginMarketSection } from "@/plugins/PluginMarketSection";
import { PluginMarketDetailView as MarketDetailView } from "@/plugins/PluginMarketDetailView.ios";
import { PluginMarketDetailView as AndroidMarketDetailView } from "@/plugins/PluginMarketDetailView";
import { PluginDetailView } from "@/plugins/PluginDetailView.ios";
import { PluginDetailView as AndroidDetailView } from "@/plugins/PluginDetailView";
import { PluginTaskPickerView } from "@/plugins/PluginTaskPickerView.ios";
import { PluginTaskPickerView as AndroidTaskPickerView } from "@/plugins/PluginTaskPickerView";
import { pluginDetailModel } from "@/plugins/pluginDetailModel";
import { palettes } from "@/theme/tokens";
import { allocateConsentSheet, layoutConsentSheet } from "@/plugins/pluginConsentPresentation";
import { PluginManagementConfirmation } from "@/plugins/PluginManagementConfirmation.ios";
import { PluginManagementConfirmation as AndroidManagementConfirmation } from "@/plugins/PluginManagementConfirmation";
import { PluginModelPicker } from '@/plugins/PluginModelPicker';

const bridge = vi.hoisted(() => ({
  maker: { getCapabilities: async () => ({ availableModels: [], effortLevels: [], permissionModes: [] }) },
  props: new Map<string, any>(),
  ownerCurrent: true,
  keyboardVisible: false,
  fontScale: 1,
  mode: "light" as "light" | "dark",
}));
vi.mock("@/hooks/useReduceMotion", () => ({ useReduceMotionEnabled: () => false }));
// Metro resolves the iOS market rows inside the iOS directory; vitest needs the platform file named.
vi.mock("@/plugins/PluginMarketRows", () => import("@/plugins/PluginMarketRows.ios"));
vi.mock("@/session/useMobileKeyboardState", () => ({ useMobileKeyboardState: () => ({ visible: bridge.keyboardVisible }) }));
vi.mock("@expo/ui/swift-ui", async () => {
  const React = await import("react");
  const TextField = Object.assign(
    (p: any) => {
      if (p.testID) bridge.props.set(p.testID, p);
      return React.createElement(
        "div",
        { "data-native": "TextField", "data-testid": p.testID },
        p.children,
      );
    },
    { Placeholder: (p: any) => p.children },
  );
  const DisclosureLabel = (p: any) => p.children;
  const DisclosureGroup = Object.assign((p: any) => {
    if (p.testID) bridge.props.set(p.testID, p);
    const children = React.Children.toArray(p.children);
    return React.createElement("div", {
      "data-native": "DisclosureGroup", "data-testid": p.testID,
    }, p.label, children.filter((child: any) =>
      child.type === DisclosureLabel || p.isExpanded !== false));
  }, { Label: DisclosureLabel });
  return {
    TextField,
    DisclosureGroup,
    Background: Object.assign((p: any) => createElement("div", null, p.children), { Content: (p: any) => p.children }),
    useNativeState: (initial: string) =>
      React.useRef({
        value: initial,
        get() {
          return this.value;
        },
        set(value: string) {
          this.value = value;
        },
      }).current,
    Host: (p: any) => {
      React.useEffect(() => {
        p.onLayoutContent?.({ nativeEvent: { width: 390, height: 844 } });
      }, []);
      bridge.props.set("host", p);
      return createElement("main", null, p.children);
    },
    ...Object.fromEntries(
      [
        "Button",
        "Label",
        "ContentUnavailableView",
        "Circle",
        "Rectangle",
        "ZStack",
        "Divider",
        "HStack",
        "Image",
        "List",
        "Menu",
        "Picker",
        "ProgressView",
        "RNHostView",
        "ScrollView",
        "Section",
        "Spacer",
        "Text",
        "Toggle",
        "VStack",
      ].map((name) => [
        name,
        (p: any) => {
          if (p.testID) bridge.props.set(p.testID, p);
          return React.createElement(
            "div",
            { "data-native": name, "data-testid": p.testID },
            p.title,
            p.label,
            p.header ? React.createElement("header", null, p.header) : null,
            p.modifiers?.some((modifier: any) => modifier.accessibilityHidden === true) ? null : p.children,
          );
        },
      ]),
    ),
  };
});
vi.mock("@expo/ui/swift-ui/modifiers", () => ({
  Animation: { easeInOut: vi.fn(() => ({})) },
  animation: vi.fn(() => ({})),
  shapes: {
    capsule: () => "capsule",
    rectangle: () => "rectangle",
    roundedRectangle: (p: any) => p,
  },
  ...Object.fromEntries(
    [
      "accessibilityLabel",
      "accessibilityHidden",
      "clipped",
      "clipShape",
      "onGeometryChange",
      "rotationEffect",
      "autocorrectionDisabled",
      "textInputAutocapitalization",
      "textFieldStyle",
      "submitLabel",
      "onSubmit",
      "background",
      "buttonStyle",
      "buttonBorderShape",
      "onAppear",
      "contentShape",
      "controlSize",
      "disabled",
      "font",
      "fixedSize",
      "foregroundStyle",
      "frame",
      "lineLimit",
      "labelsHidden",
      "scaleEffect",
      "listRowBackground",
      "listRowInsets",
      "listRowSeparator",
      "listRowSeparatorTint",
      "listSectionSpacing",
      "listStyle",
      "padding",
      "pickerStyle",
      "refreshable",
      "scrollContentBackground",
      "scrollIndicators",
      "scrollDismissesKeyboard",
      "tag",
      "tint",
    ].map((name) => [name, (value: any) => ({ [name]: value })]),
  ),
}));
vi.mock("react-native", () => ({
  Platform: { OS: 'ios' },
  Alert: { alert: vi.fn() },
  PlatformColor: (name: string) => name,
  Keyboard: { addListener: () => ({ remove() {} }) },
  useWindowDimensions: () => ({ width: 390, height: 844, fontScale: bridge.fontScale }),
  Image: () => null,
  View: (p: any) => {
    if (p.testID) bridge.props.set(p.testID, p);
    return createElement(
      "div",
      { "data-testid": p.testID, "aria-hidden": p.accessibilityElementsHidden },
      p.children,
    );
  },
  Text: (p: any) => p.children,
  TextInput: () => null,
  ScrollView: (p: any) => { if (p.testID) bridge.props.set(p.testID, p); return createElement("div", { "data-testid": p.testID }, p.children); },
  Pressable: (p: any) => { if (p.testID) bridge.props.set(p.testID, p); return createElement("div", { "data-testid": p.testID }, p.children); },
  ActivityIndicator: () => null,
  AccessibilityInfo: {
    isReduceMotionEnabled: async () => false,
    addEventListener: () => ({ remove() {} }),
  },
  StyleSheet: { create: (s: any) => s },
}));
vi.mock("lucide-react-native", () =>
  Object.fromEntries(
    [
      "CircleAlert",
      "Info",
      "WifiOff",
      "Puzzle",
      "AppWindow",
      "Bot",
      "Cpu",
      "FileCode2",
      "FilePen",
      "FolderOpen",
      "FolderPlus",
      "Globe",
      "GraduationCap",
      "KeyRound",
      "LayoutTemplate",
      "Library",
      "MapPin",
      "Megaphone",
      "MessageCircleQuestion",
      "PanelLeft",
      "PanelRight",
      "Radio",
      "ShieldCheck",
      "Shield",
      "Smartphone",
      "Sparkles",
      "Terminal",
      "Wrench",
      "Check",
      "ChevronDown",
    ].map((name) => [name, () => createElement("i", { "data-permission-icon": name })]),
  ),
);
vi.mock("@/platform/chrome/NativeSwitch", () => ({ NativeSwitch: () => null }));
vi.mock("@/components/AppText", async () => {
  const native = await import("react-native");
  return {
    Text: native.Text,
    TextInput: native.TextInput,
    MAX_FONT_SIZE_MULTIPLIER: 1.2,
  };
});
vi.mock("@/components/MobilePrimitives", () => ({
  MainWindowActionButton: ({ action }: any) =>
    createElement(
      "button",
      { onClick: action.onPress, disabled: action.disabled || action.busy },
      action.label,
    ),
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en" } }),
}));
vi.mock("@/theme", async () => ({
  ...(await import("@/theme/tokens")),
  useTheme: () => ({ mode: bridge.mode, colors: palettes[bridge.mode] }),
  useThemedStyles: (factory: any) => factory(palettes[bridge.mode]),
}));
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0 }),
}));
vi.mock("@/session/SheetModal", () => ({ SheetModal: (p: any) => p.children }));
vi.mock("@/session/SheetSurface", () => ({
  SheetSurface: (p: any) => p.children,
}));
vi.mock("@/session/ComposerNativeRow", () => ({
  ComposerNativeRow: (p: any) => {
    bridge.props.set(p.testID, p);
    return createElement("div", null, p.title);
  },
}));
vi.mock("@/session/ComposerSheet", () => ({
  ComposerSheet: (p: any) => {
    bridge.props.set(p.testID ?? "plugins.taskPicker", p);
    return createElement(
      "div",
      { "data-native": "sheet", "data-testid": p.testID },
      p.nativeHeader,
      p.children,
      p.footer,
    );
  },
}));
vi.mock("@/session/ComposerNativeSection", () => ({
  ComposerNativeSection: (p: any) => p.children,
}));
vi.mock("@/auth/authOwnerGeneration", () => ({
  getMobileAuthOwner: () => "owner",
  isMobileAuthOwnerCurrent: () => bridge.ownerCurrent,
}));
vi.mock('@/device-link/useDeviceProviders', () => ({ useDeviceProviders: () => ({ providers: [], ready: true }) }));
vi.mock('@/device-link/useMobileMakerTransport', () => ({ useMobileMakerTransport: () => bridge.maker }));
// This native-view fixture has no directory transport or Expo runtime. Remote directory
// behavior is covered by remoteAgentCatalogsProviderShare and pluginModelPickerDraft.
vi.mock('@/session/useRemoteAgentCatalogs', () => ({ useRemoteAgentCatalogs: () => [] }));
vi.mock('@/session/ModelPickerSheet', () => ({ ModelPickerSheet: (props: unknown) => {
  bridge.props.set('plugin-model-picker', props);
  return null;
} }));
vi.mock("@/session/CompanionNativeContent.ios", () => ({
  CompanionNativeContent: (p: any) => p.children,
}));
vi.mock("@/platform/chrome/nativeGlassButtonStyle.ios", () => ({
  useNativeGlassButtonStyle: ({ prominent = false } = {}) => [
    { nativeButton: prominent ? "primary" : "secondary" },
  ],
}));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const roots: ReturnType<typeof createRoot>[] = [];
afterEach(() => {
  act(() => roots.splice(0).forEach((root) => root.unmount()));
  bridge.props.clear();
  bridge.mode = "light";
  bridge.ownerCurrent = true;
  bridge.keyboardVisible = false;
  bridge.fontScale = 1;
});
function mount(component: any, props: any) {
  const container = document.createElement("div");
  const root = createRoot(container);
  roots.push(root);
  act(() => root.render(createElement(component, props)));
  return {
    container,
    rerender: (props: any) =>
      act(() => root.render(createElement(component, props))),
  };
}
// New plugin picker wrapper: native sheets call onClose after a successful onSelect.
// Minimal input is one model click; the observable result must be one complete route,
// never a second cancellation. Existing native view tests do not cover this round trip. Tier: unit.
it('returns the complete Host model choice once when the native sheet closes after selecting', async () => {
  const onAnswer = vi.fn(async () => ({ handled: true, accepted: true }));
  mount(PluginModelPicker, { deviceId: 'execution-computer', onAnswer,
    request: { requestId: 'pick', ghostId: 'plugin', ghostName: 'Example', expiresAt: Date.now() + 90_000 } });
  await act(async () => {
    const props = bridge.props.get('plugin-model-picker');
    await props.unified.onSelect({ agent: 'codex', providerId: 'provider', modelId: 'model', effort: 'high', fast: 'ultrafast' });
    bridge.props.get('plugin-model-picker').onClose();
  });
  expect(onAnswer).toHaveBeenCalledExactlyOnceWith({ agentKind: 'codex', providerId: 'provider', model: 'model', effort: 'high', fastMode: 'ultrafast' });
});

it('returns cancellation from the native picker and ignores actions after owner revocation', async () => {
  const onAnswer = vi.fn(async () => ({ handled: true, accepted: true }));
  mount(PluginModelPicker, { deviceId: 'execution-computer', onAnswer,
    request: { requestId: 'pick', ghostId: 'plugin', ghostName: 'Example', expiresAt: Date.now() + 90_000 } });
  bridge.ownerCurrent = false;
  await act(async () => { bridge.props.get('plugin-model-picker').onClose(); });
  expect(onAnswer).not.toHaveBeenCalled();
  bridge.ownerCurrent = true;
  await act(async () => { bridge.props.get('plugin-model-picker').onClose(); });
  expect(onAnswer).toHaveBeenCalledExactlyOnceWith(null);
});

const row = {
  key: "mac:demo",
  host: { deviceId: "mac", deviceName: "Mac" },
  item: {
    ref: { collectionId: "plugins", kind: "plugin", id: "demo" },
    display: { title: "Demo" },
    revision: "1",
    actions: [{ id: "disable", label: "Disable" }],
  },
};
const directory = () => ({
  targets: [row.host],
  deviceId: "",
  onDeviceChange: vi.fn(),
  query: "",
  items: [row],
  loading: false,
  error: false,
  isOnline: () => true,
  onRefresh: vi.fn(),
  onOpen: vi.fn(),
  onDetail: vi.fn(),
  onConnectComputer: vi.fn(),
  segment: "installed" as const,
  onSegmentChange: vi.fn(),
  market: marketModel(),
});
function marketModel(patch: Record<string, unknown> = {}) {
  return {
    target: row.host, targets: [row.host], online: true, selectDevice: vi.fn(),
    filter: "official", filters: [{ value: "all" }, { value: "official", count: 1 }], setFilter: vi.fn(),
    searching: false, status: "ready", items: [] as any[], total: undefined, hasMore: false, loadingMore: false,
    refreshing: false, loadMore: vi.fn(), refresh: vi.fn(async () => {}),
    notices: { unavailable: false, organizationKey: null, unavailableCustomSources: [] },
    rowState: (): any => ({ kind: "idle" }), installBusy: false, canInstall: true, install: vi.fn(), checkResult: vi.fn(),
    detail: null, openDetail: vi.fn(), closeDetail: vi.fn(), retryDetail: vi.fn(), confirmation: null, ...patch,
  };
}
// Market segment (2026-11-25): native segmented Picker and SwiftUI market rows inside the same List.
it("switches to the native market segment and routes row taps to detail, install and progress", () => {
  const item = { pluginId: "market/demo", ghostId: "demo", name: "Market Demo", description: "From the market",
    publisherKind: "official", scope: "public", sourceType: "server", installState: "not-installed", icon: null };
  const market = marketModel({ items: [item] });
  const p = { ...directory(), market };
  mount(PluginDirectoryView, p);
  act(() => bridge.props.get("plugins.segment").onSelectionChange("market"));
  expect(p.onSegmentChange).toHaveBeenCalledWith("market");
  const { container, rerender } = mount(PluginDirectoryView, { ...p, segment: "market" });
  expect(container.querySelector('[data-testid="plugins.installedHeader"]')).toBeNull();
  expect(container.textContent).toContain("Market Demo");
  expect(container.textContent).toContain("plugins.market.filter.official");
  act(() => bridge.props.get("plugins.market.install.market/demo").onPress());
  expect(market.install).toHaveBeenCalledWith(item);
  act(() => bridge.props.get("plugins.market.row.market/demo").onPress());
  expect(market.openDetail).toHaveBeenCalledWith(item);
  bridge.props.clear();
  rerender({ ...p, segment: "market", market: { ...market, rowState: () => ({ kind: "waiting" }) } });
  expect(bridge.props.has("plugins.market.install.market/demo")).toBe(false);
  // The status is written under the name (as on Android); the spinner keeps the spoken label.
  expect(container.querySelector('[data-testid="plugins.market.row.market/demo"]')?.textContent).toContain("plugins.market.waiting");
  expect(bridge.props.get("plugins.market.progress.market/demo").modifiers).toContainEqual({ accessibilityLabel: "plugins.market.waiting" });
});
// iOS re-check (accessibility-large): the waiting row's trailing status squeezed a long name and the "Official"
// label wrapped onto two lines. At large sizes the status moves under the name and the label never wraps.
it("keeps market row names readable at accessibility sizes while waiting", () => {
  bridge.fontScale = 2;
  const item = { pluginId: "market/demo", ghostId: "demo", name: "Market Demo With A Long Name", description: "From the market",
    publisherKind: "official", scope: "public", sourceType: "server", installState: "not-installed", icon: null };
  const market = marketModel({ items: [item], rowState: () => ({ kind: "waiting" }) });
  const { container } = mount(PluginDirectoryView, { ...directory(), market, segment: "market" });
  const progress = container.querySelector('[data-testid="plugins.market.progress.market/demo"]')!;
  expect(progress.textContent).not.toContain("plugins.market.waiting");
  expect(bridge.props.get("plugins.market.progress.market/demo").modifiers).toContainEqual({ accessibilityLabel: "plugins.market.waiting" });
  expect(container.querySelector('[data-testid="plugins.market.row.market/demo"]')?.textContent).toContain("plugins.market.waiting");
  const badge = bridge.props.get("plugins.market.badge.market/demo");
  expect(badge.modifiers).toContainEqual({ lineLimit: 1 });
  expect(badge.modifiers).toContainEqual({ fixedSize: { horizontal: true, vertical: false } });
});
// Android re-check of d81200da: in German the "Benutzerdefiniert" label and the Install button left the name about
// 64 dp ("Demo / Long …"). On iOS a label that would take more than 40% of the measured text column goes under the
// name; a short label stays beside it. Minimal failing input: a 200 pt column and a 100 pt label. Tier: unit.
it("moves a long source label under the market row name on iOS", () => {
  const item = { pluginId: "custom:Team/demo", ghostId: "demo", name: "Demo Long Repository Tools", description: "From a market",
    publisherKind: null, scope: "public", sourceType: "git-market", sourceMarketName: "Team", installState: "not-installed", icon: null };
  const market = marketModel({ items: [item] });
  mount(PluginDirectoryView, { ...directory(), market, segment: "market" });
  const measure = (id: string, width: number) => act(() => {
    bridge.props.get(id).modifiers.find((m: any) => m.onGeometryChange).onGeometryChange({ width, height: 20 });
  });
  expect(bridge.props.has("plugins.market.titleRow.custom:Team/demo")).toBe(true);
  measure("plugins.market.text.custom:Team/demo", 200);
  const badge = bridge.props.get("plugins.market.badge.custom:Team/demo");
  bridge.props.clear();
  act(() => badge.modifiers.find((m: any) => m.onGeometryChange).onGeometryChange({ width: 100, height: 20 }));
  expect(bridge.props.has("plugins.market.titleStacked.custom:Team/demo")).toBe(true);
  expect(bridge.props.has("plugins.market.titleRow.custom:Team/demo")).toBe(false);
  const stackedBadge = bridge.props.get("plugins.market.badge.custom:Team/demo");
  bridge.props.clear();
  act(() => stackedBadge.modifiers.find((m: any) => m.onGeometryChange).onGeometryChange({ width: 60, height: 20 }));
  expect(bridge.props.has("plugins.market.titleRow.custom:Team/demo")).toBe(true);
  expect(bridge.props.has("plugins.market.titleStacked.custom:Team/demo")).toBe(false);
});
it("uses a scrolling native title row without a separator or sticky section header", () => {
  const p = directory();
  const { container } = mount(PluginDirectoryView, p);
  const list = container.querySelector('[data-testid="plugins.list"]')!;
  expect(
    list.querySelector('[data-testid="plugins.installedHeader"]')?.textContent,
  ).toContain("plugins.installed");
  expect(bridge.props.get("plugins.list").modifiers).toContainEqual({
    listStyle: "plain",
  });
  expect(bridge.props.get("plugins.installedHeader").modifiers).toContainEqual({
    listRowSeparator: "hidden",
  });
  expect(bridge.props.get("plugins.installedHeader").modifiers).toContainEqual({
    listRowInsets: { leading: 20, trailing: 20, top: 0, bottom: 0 },
  });
  expect(
    bridge.props
      .get("plugins.installedHeader")
      .modifiers.filter((m: any) => m.listRowInsets),
  ).toHaveLength(1);
  expect(list.querySelector("header")).toBeNull();
  for (const id of ["plugins.computer"])
    expect(list.querySelector('[data-testid="' + id + '"]')).not.toBeNull();
  expect(container.querySelector('[data-testid="plugins.filter"]')).toBeNull();
  act(() =>
    bridge.props.get("plugins.computer.options").onSelectionChange("mac"),
  );
  expect(p.onDeviceChange).toHaveBeenCalledWith("mac");
});
it("separates open from details", () => {
  const p = { ...directory(), query: "Demo" };
  mount(PluginDirectoryView, p);
  act(() => bridge.props.get("plugins.row.demo").onPress());
  expect(p.onOpen).toHaveBeenCalledWith(row);
  act(() => bridge.props.get("plugins.row.demo").onOptions());
  expect(p.onDetail).toHaveBeenCalledWith(row);
});
it("shows a truthful empty installed state", () => {
  const { container } = mount(PluginDirectoryView, {
    ...directory(),
    items: [],
  });
  expect(container.textContent).toContain("plugins.noPlugins");
});
it("shows Retry instead of Connect computer when the computer lookup fails", () => {
  const { container } = mount(PluginDirectoryView, {
    ...directory(),
    targets: [],
    items: [],
    error: true,
  });
  expect(container.textContent).toContain("plugins.listLoadFailed");
  expect(container.textContent).not.toContain("plugins.noComputer");
  expect(
    container.querySelector('[data-testid="plugins.retryList"]'),
  ).not.toBeNull();
});
it.each(["light", "dark"] as const)(
  "uses native controls and the application theme in %s",
  (mode) => {
    bridge.mode = mode;
    const change = vi.fn();
    const p = {
      row,
      enabled: true,
      online: true,
      busy: false,
      model: pluginDetailModel(
        row as any,
        { ...row.item, blocks: [] } as any,
        true,
        false,
        false,
      ),
      settingsOpen: false,

      onResolveStatus: vi.fn(),

      onEnabledChange: change,
      onOpen: vi.fn(),
      onNewTask: vi.fn(),
      onChooseTask: vi.fn(),
    };
    const { rerender } = mount(PluginDetailView, p);
    expect(bridge.props.get("host").colorScheme).toBe(mode);
    expect(bridge.props.get("plugins.enabled").isOn).toBe(true);
    act(() => bridge.props.get("plugins.enabled").onIsOnChange(false));
    expect(change).toHaveBeenCalledWith(false);
    rerender({ ...p, busy: true });
    expect(bridge.props.get("plugins.enabled").modifiers).toContainEqual({
      disabled: true,
    });
    rerender({ ...p, online: false });
    expect(bridge.props.get("plugins.enabled").modifiers).toContainEqual({
      disabled: true,
    });
  },
);
it("keeps task actions outside the scrolling detail, preserves the switch and old Host configuration guidance", () => {
  const p = {
    row,
    enabled: true,
    online: true,
    busy: false,
    settingsOpen: false,
    model: pluginDetailModel(
      row as any,
      {
        ...row.item,
        blocks: [{ id: "capabilities", data: { tasks: true } }],
      } as any,
      true,
      false,
      false,
    ),
    children: createElement("span", null, "Task preferences content"),
    onEnabledChange: vi.fn(),
    onOpen: vi.fn(),
    onNewTask: vi.fn(),
    onChooseTask: vi.fn(),

    onResolveStatus: vi.fn(),
  };
  const { container, rerender } = mount(PluginDetailView, p);
  expect(container.textContent).not.toContain("Task preferences content");
  expect(
    container
      .querySelector('[data-testid="plugins.newTask"]')
      ?.getAttribute("data-native"),
  ).toBe("Button");
  for (const id of ["plugins.newTask", "plugins.chooseTask"]) {
    expect(bridge.props.get(id).modifiers).toContainEqual({
      nativeButton: id === "plugins.newTask" ? "primary" : "secondary",
    });
  }
  expect(container.querySelector('[data-testid="plugins.tools"]')).toBeNull();
  expect(
    container.querySelector(
      '[data-testid="plugins.identity"] [data-testid="plugins.enabled"]',
    ),
  ).not.toBeNull();
  expect(
    container.querySelector(
      '[data-testid="plugins.detail"] [data-testid="plugins.newTask"]',
    ),
  ).toBeNull();
  expect(
    container.querySelector(
      '[data-testid="plugins.use"] [data-testid="plugins.newTask"]',
    ),
  ).not.toBeNull();
  expect(
    container.querySelector('[data-testid="plugins.computerSettings"]'),
  ).toBeNull();
  expect(
    container.querySelector('[data-testid="plugins.permissions"]'),
  ).toBeNull();
  expect(
    container.querySelector('[data-testid="plugins.metadata"]'),
  ).toBeNull();
  act(() => bridge.props.get("plugins.chooseTask").onPress());
  expect(p.onChooseTask).toHaveBeenCalledOnce();
  bridge.keyboardVisible = true;
  rerender(p);
  expect(container.querySelector('[data-testid="plugins.newTask"]')).toBeNull();
  bridge.keyboardVisible = false;
  rerender({ ...p, settingsContent: createElement("div", null, "Original settings form") });
  expect(container.querySelector('[data-testid="plugins.settingsCard"]')?.textContent).toContain("Original settings form");
  expect(container.querySelector('[data-testid="plugins.computerSettings"]')).toBeNull();
  rerender({ ...p, settingsOpen: true });
  expect(container.textContent).not.toContain("Task preferences content");
  expect(container.querySelector('[data-testid="plugins.newTask"]')).toBeNull();
});
it("uses the title switch to recover a disabled plugin without a duplicate enable button", () => {
  const p = {
    row,
    enabled: false,
    online: true,
    busy: false,
    settingsOpen: false,
    model: {
      ...pluginDetailModel(row as any, undefined, true, false, false),
      canUseTasks: false,
      status: "disabled",
      statusAction: "enable",
    },
    onEnabledChange: vi.fn(),
    onOpen: vi.fn(),
    onNewTask: vi.fn(),
    onChooseTask: vi.fn(),

    onResolveStatus: vi.fn(),
  };
  const { container } = mount(PluginDetailView, p);
  expect(container.querySelector('[data-testid="plugins.newTask"]')).toBeNull();
  expect(
    container.querySelector('[data-testid="plugins.chooseTask"]'),
  ).toBeNull();
  expect(
    container.querySelector('[data-testid="plugins.resolveStatus"]'),
  ).toBeNull();
  expect(
    container.querySelector(
      '[data-testid="plugins.identity"] [data-testid="plugins.enabled"]',
    ),
  ).not.toBeNull();
});

it.each([
  { loading: true, error: false, message: undefined },
  { loading: false, error: true, message: "plugins.listLoadFailed" },
  {
    loading: false,
    error: false,
    query: "missing",
    message: "plugins.noResults",
  },
  { loading: false, error: false, targets: [], message: "plugins.noComputer" },
])(
  "keeps empty, loading and failed-list messages mutually exclusive: %j",
  (state) => {
    const p = { ...directory(), items: [], ...state };
    const { container } = mount(PluginDirectoryView, p);
    expect(container.textContent).not.toContain("plugins.noPlugins");
    if (state.message) expect(container.textContent).toContain(state.message);
    if (state.error) {
      expect(container.textContent).not.toContain("plugins.noResults");
      act(() => bridge.props.get("plugins.retryList").onPress());
      expect(p.onRefresh).toHaveBeenCalledOnce();
    }
  },
);
it("retains rows and a subdued warning for partial list failures", () => {
  const { container } = mount(PluginDirectoryView, {
    ...directory(),
    error: true,
  });
  expect(container.textContent).toContain("Demo");
  expect(container.textContent).toContain("plugins.listUnavailable");
  expect(container.textContent).not.toContain("plugins.noPlugins");
  expect(
    container.querySelector('[data-testid="plugins.retryList"]'),
  ).toBeNull();
});

it("shows connect-computer when the computer lookup succeeds with no linked computers", () => {
  const p = { ...directory(), targets: [], items: [], error: false };
  const { container } = mount(PluginDirectoryView, p);
  expect(container.textContent).toContain("plugins.noComputer");
  expect(container.textContent).not.toContain("plugins.listLoadFailed");
  expect(
    container.querySelector('[data-testid="plugins.retryList"]'),
  ).toBeNull();
});

it("keeps the offline indicator ahead of long preview text so it stays visible", () => {
  const offlineRow = {
    ...row,
    item: {
      ...row.item,
      display: {
        title: "Demo",
        preview:
          "A very long preview that would otherwise hide connection status",
      },
    },
  };
  mount(PluginDirectoryView, {
    ...directory(),
    items: [offlineRow],
    isOnline: () => false,
  });
  expect(bridge.props.get("plugins.row.demo").subtitle).toMatch(
    /^plugins.notConnected · /,
  );
});

it("keeps the avatar's measured native root when its remote image arrives", () => {
  const p = {
    row, enabled: true, online: true, busy: false, settingsOpen: false,
    model: pluginDetailModel(row as any, undefined, true, false, false),
    onEnabledChange: vi.fn(), onOpen: vi.fn(), onNewTask: vi.fn(),
    onChooseTask: vi.fn(), onResolveStatus: vi.fn(),
  };
  const { container, rerender } = mount(PluginDetailView, p);
  const measuredRoot = () => container.querySelector(
    '[data-testid="plugins.identity"] [data-native="RNHostView"]',
  )?.firstElementChild;
  const originalRoot = measuredRoot();
  expect(originalRoot).toBeTruthy();
  rerender({ ...p, row: { ...row, item: { ...row.item, display: {
    ...row.item.display, avatar: { value: "data:image/png;base64,aGVsbG8=" },
  } } }, settingsContent: createElement("div", null, "Loaded original settings") });
  // RNHostView's native size observer stays attached to its first UIView.
  expect(measuredRoot()).toBe(originalRoot);
  rerender(p);
  expect(measuredRoot()).toBe(originalRoot);
});

it("renders real Host facts and hides unavailable information", () => {
  const p = {
    row,
    enabled: true,
    online: true,
    busy: false,
    settingsOpen: false,
    model: pluginDetailModel(
      row as any,
      {
        ...row.item,
        blocks: [
          {
            id: "capabilities",
            data: {
              tools: [{ name: "calendar_events", description: "Read events" }],
            },
          },
          { id: "about", fallbackMarkdown: "Full plugin introduction" },
          { id: "version", fallbackMarkdown: "2.3.0" },
        ],
      } as any,
      true,
      false,
      false,
    ),
    onEnabledChange: vi.fn(),
    onOpen: vi.fn(),
    onNewTask: vi.fn(),
    onChooseTask: vi.fn(),

    onResolveStatus: vi.fn(),
  };
  const { container, rerender } = mount(PluginDetailView, p);
  expect(
    container.querySelector('[data-testid="plugins.tools"]')?.textContent,
  ).toContain("calendar_events");
  expect(container.textContent).not.toContain("Read events");
  expect(
    container.querySelector('[data-testid="plugins.toolsDisclosure"]'),
  ).toBeNull();
  expect(
    container.querySelector(
      '[data-testid="plugins.tools"] [data-native="DisclosureGroup"]',
    ),
  ).toBeNull();
  expect(container.textContent).not.toContain("plugins.detail.taskHint");
  expect(
    container.querySelector(
      '[data-testid="plugins.tools"] [data-native="Divider"]',
    ),
  ).toBeNull();
  expect(
    container.querySelector('[data-testid="plugins.fact.version"]')?.textContent,
  ).toContain("2.3.0");
  expect(bridge.props.get("plugins.identity").modifiers).toContainEqual({
    listRowInsets: { leading: 20, trailing: 20, top: 8, bottom: 16 },
  });
  expect(bridge.props.get("plugins.enabled").modifiers).toContainEqual({
    scaleEffect: { x: 48 / 61, y: 24 / 28 },
  });
  expect(bridge.props.get("plugins.enabled").modifiers).toContainEqual({
    frame: { width: 56, height: 44 },
  });
  expect(
    container.querySelector('[data-testid="plugins.identity"]')?.textContent,
  ).toContain("Full plugin introduction");
  expect(container.textContent).not.toContain("plugins.detail.identifier");
  expect(
    container.querySelector('[data-testid="plugins.permissions"]'),
  ).toBeNull();
  expect(container.textContent).not.toContain(
    "plugins.detail.detailsUnavailable",
  );
  const manyTools = {
    ...p,
    model: {
      ...p.model,
      tools: [
        { name: "first_tool", description: "Hidden first description" },
        { name: "second_tool", description: "Hidden second description" },
        { name: "third_tool", description: "Hidden third description" },
      ],
    },
  };
  rerender(manyTools);
  expect(container.textContent).toContain("first_tool");
  expect(container.textContent).toContain("second_tool");
  expect(container.textContent).toContain("third_tool");
  act(() =>
    bridge.props.get("plugins.toolChipsFlow").onLayout({
      nativeEvent: { layout: { width: 334, height: 64 } },
    }),
  );
  expect(
    container.querySelector('[data-testid="plugins.toolsDisclosure"]'),
  ).toBeNull();
  act(() => {
    bridge.props.get("plugins.toolChipsFlow").onLayout({
      nativeEvent: { layout: { width: 200, height: 100 } },
    });
    bridge.props.get("plugins.toolChip.2").onLayout({
      nativeEvent: { layout: { y: 72, height: 28 } },
    });
  });
  expect(
    bridge.props.get("plugins.toolChip.2").accessibilityElementsHidden,
  ).toBe(true);
  expect(container.textContent).toContain("plugins.detail.showAll");
  act(() => bridge.props.get("plugins.toolsDisclosure").onPress());
  expect(container.textContent).toContain("third_tool");
  expect(container.textContent).toContain("plugins.detail.showLess");
  expect(
    bridge.props.get("plugins.toolChip.2").accessibilityElementsHidden,
  ).toBe(false);
  expect(container.textContent).not.toContain("Hidden third description");
  act(() => bridge.props.get("plugins.toolsDisclosure").onPress());
  expect(container.textContent).toContain("third_tool");
  act(() => bridge.props.get("plugins.toolsDisclosure").onPress());
  rerender({ ...manyTools, row: { ...p.row, key: "another-plugin" } });
  expect(container.textContent).toContain("third_tool");
  expect(container.textContent).toContain("plugins.detail.showAll");
  rerender({
    ...p,
    model: { ...p.model, tools: manyTools.model.tools.slice(0, 2) },
  });
  act(() =>
    bridge.props.get("plugins.toolChipsFlow").onLayout({
      nativeEvent: { layout: { width: 334, height: 28 } },
    }),
  );
  expect(
    container.querySelector('[data-testid="plugins.toolsDisclosure"]'),
  ).toBeNull();
  for (const empty of [undefined, []]) {
    rerender({ ...p, model: { ...p.model, version: undefined, tools: empty, permissions: empty } });
    expect(container.querySelector('[data-testid="plugins.tools"]')).toBeNull();
    expect(
      container.querySelector('[data-testid="plugins.permissions"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="plugins.metadata"]'),
    ).toBeNull();
  }
  rerender({
    ...p,
    model: {
      ...p.model,
      details: [
        { key: "author", title: "Author", value: " " },
        { key: "version", title: "Version", value: "v2.3.0" },
      ],
      permissions: [{ title: "Network", description: "Permission detail belongs only in the full PC view" }],
    },
  });
  expect(
    container.querySelector('[data-testid="plugins.fact.author"]'),
  ).toBeNull();
  expect(container.querySelector('[data-testid="plugins.fact.version"]')?.textContent).toContain("v2.3.0");
  expect(
    container.querySelector('[data-testid="plugins.permissions"]')?.textContent,
  ).toContain("Network");
  expect(container.textContent).not.toContain("Permission detail belongs only in the full PC view");
  expect(container.textContent).not.toContain("plugins.detail.noDescription");
  rerender({ ...p, model: { ...p.model, version: undefined, details: [], hasSettings: false } });
  expect(
    container.querySelector('[data-testid="plugins.metadata"]'),
  ).toBeNull();
});

function taskPickerProps() {
  return {
    deviceId: "mac",
    visible: true,
    query: "",
    rows: [
      {
        id: "calendar-task",
        title: "Calendar planning",
        preview: "Real task preview",
      },
      { id: "other-task", title: "Other work" },
    ] as any,
    loading: false,
    error: false,
    onChangeQuery: vi.fn(),
    onRetry: vi.fn(),
    onClose: vi.fn(),
    onSelect: vi.fn(),
  };
}
it.each(["light", "dark"] as const)(
  "uses native task search and rows in %s and navigates after sheet dismissal",
  (mode) => {
    bridge.mode = mode;
    const p = taskPickerProps();
    const { container, rerender } = mount(PluginTaskPickerView, p);
    expect(bridge.props.get("plugins.taskPicker").nativeContent).toBe(true);
    expect(bridge.props.get("plugins.taskPicker").nativeList).toBe(true);
    expect(bridge.props.get("plugins.taskSearch").modifiers).toContainEqual({
      textFieldStyle: "plain",
    });
    expect(
      container
        .querySelector('[data-testid="plugins.taskSearch"]')
        ?.getAttribute("data-native"),
    ).toBe("TextField");
    act(() => bridge.props.get("plugins.taskSearch").onTextChange("calendar"));
    expect(p.onChangeQuery).toHaveBeenCalledWith("calendar");
    rerender({ ...p, query: "calendar" });
    expect(container.textContent).toContain("Calendar planning");
    expect(container.textContent).not.toContain("Other work");
    act(() => bridge.props.get("plugins.clearTaskSearch").onPress());
    expect(p.onChangeQuery).toHaveBeenLastCalledWith("");
    act(() => bridge.props.get("plugins.task.calendar-task").onPress());
    expect(p.onClose).toHaveBeenCalledOnce();
    expect(p.onSelect).not.toHaveBeenCalled();
    rerender({ ...p, visible: false });
    act(() => bridge.props.get("plugins.taskPicker").onClosed());
    expect(p.onSelect).toHaveBeenCalledExactlyOnceWith("calendar-task");
    act(() => bridge.props.get("plugins.taskPicker").onClosed());
    expect(p.onSelect).toHaveBeenCalledOnce();
  },
);
it("distinguishes loading, retry, empty tasks and search results without selecting on dismissal", () => {
  const p = taskPickerProps();
  const { container, rerender } = mount(PluginTaskPickerView, {
    ...p,
    loading: true,
  });
  expect(
    container.querySelector('[data-testid="plugins.tasksLoading"]'),
  ).not.toBeNull();
  expect(container.textContent).not.toContain("Calendar planning");
  rerender({ ...p, error: true });
  act(() => bridge.props.get("plugins.retryTasks").onPress());
  expect(p.onRetry).toHaveBeenCalledOnce();
  rerender({ ...p, rows: [] });
  expect(container.textContent).toContain("plugins.noTasks");
  rerender({ ...p, query: "missing" });
  expect(container.textContent).toContain("plugins.noMatchingTasks");
  act(() => bridge.props.get("plugins.taskPicker").onClose());
  act(() => bridge.props.get("plugins.taskPicker").onClosed());
  expect(p.onSelect).not.toHaveBeenCalled();
});
it("drops a pending task selection if the owner or plugin changes during dismissal", () => {
  const p = taskPickerProps();
  const { rerender } = mount(PluginTaskPickerView, p);
  act(() => bridge.props.get("plugins.task.calendar-task").onPress());
  bridge.ownerCurrent = false;
  act(() => bridge.props.get("plugins.taskPicker").onClosed());
  expect(p.onSelect).not.toHaveBeenCalled();
  bridge.ownerCurrent = true;
  bridge.keyboardVisible = false;
  act(() => bridge.props.get("plugins.task.calendar-task").onPress());
  rerender({ ...p, deviceId: "other-computer" });
  act(() => bridge.props.get("plugins.taskPicker").onClosed());
  expect(p.onSelect).not.toHaveBeenCalled();
});

it("shows Android task search empty results and restores the matching tasks", () => {
  const p = taskPickerProps();
  const { container, rerender } = mount(AndroidTaskPickerView, {
    ...p,
    query: "missing",
  });
  expect(container.textContent).toContain("plugins.noMatchingTasks");
  expect(container.textContent).not.toContain("Calendar planning");
  rerender({ ...p, query: "Calendar" });
  expect(container.textContent).toContain("Calendar planning");
  expect(container.textContent).not.toContain("plugins.noMatchingTasks");
  rerender({ ...p, rows: [] });
  expect(container.textContent).toContain("plugins.noTasks");
});


it("expands full Host information on demand and resets when switching plugins", () => {
  const fullPath = "/Users/example/Library/Application Support/Cindy/owners/owner/plugins/taptap-maker";
  const contents = "Custom settings UI · Executable code · Local Node program · Tools";
  const p = {
    row, enabled: true, online: true, busy: false, settingsOpen: false,
    model: { ...pluginDetailModel(row as any, undefined, true, false, false),
      details: [
        { key: "version", title: "Version", value: "v2.1.22" },
        { key: "contents", title: "Contains", value: contents },
        { key: "location", title: "Install location", value: fullPath },
      ],
    },
    onEnabledChange: vi.fn(), onOpen: vi.fn(), onNewTask: vi.fn(),
    onChooseTask: vi.fn(), onResolveStatus: vi.fn(),
  };
  const { container, rerender } = mount(PluginDetailView, p);
  const fact = (key: string) => container.querySelector(`[data-testid="plugins.fact.${key}"]`)!;
  expect(fact("location").textContent).toContain("Install location");
  expect(fact("location").textContent).toContain("taptap-maker");
  expect(fact("location").textContent).not.toContain(fullPath);
  expect(fact("contents").textContent).toContain("Custom settings UI…");
  expect(fact("contents").textContent).not.toContain(contents);
  for (const key of ["contents", "location"]) {
    act(() => bridge.props.get(`plugins.fact.${key}.toggle`).onPress());
    const geometry = bridge.props.get(`plugins.fact.${key}.value`).modifiers.find((modifier: any) => modifier.onGeometryChange);
    act(() => geometry.onGeometryChange({ width: 350, height: 84 }));
    expect(bridge.props.get(`plugins.fact.${key}.content`).modifiers).toContainEqual({ frame: { height: 84, alignment: "topLeading" } });
    if (key === "contents") expect(fact("location").textContent).not.toContain(fullPath);
  }
  expect(fact("contents").textContent).toContain(contents);
  expect(fact("location").textContent).toContain(fullPath);
  act(() => bridge.props.get("plugins.fact.location.toggle").onPress());
  expect(bridge.props.get("plugins.fact.location.content").modifiers).toContainEqual({ frame: { height: 0, alignment: "topLeading" } });
  expect(fact("contents").textContent).toContain(contents);
  expect(fact("location").textContent).not.toContain(fullPath);
  rerender({ ...p, row: { ...row, key: "another-host:another-plugin" } });
  expect(fact("contents").textContent).not.toContain(contents);
  expect(fact("location").textContent).not.toContain(fullPath);
});

// 用户要求提示按阻断范围并存；生产原生详情入口验证，避免离线缓存被描述为当前配置事实。
it.each(["offline", "loadFailed", "loading"] as const)("does not show stale setup or runtime facts while %s", (status) => {
  const p = {
    row, enabled: true, online: status !== "offline", busy: false, settingsOpen: false,
    model: { ...pluginDetailModel(row as any, undefined, true, false, false), status,
      missing: ["token"], expired: ["account"], runtimeIssue: "fused" as const },
    onEnabledChange: vi.fn(), onOpen: vi.fn(), onNewTask: vi.fn(), onChooseTask: vi.fn(), onResolveStatus: vi.fn(),
  };
  const { container } = mount(PluginDetailView, p);
  expect(container.querySelector('[data-testid="plugins.configurationStatus"]')).toBeNull();
  expect(container.textContent).not.toContain("plugins.detail.runtimeFused");
  expect(Boolean(container.querySelector('[data-testid="plugins.loading"]'))).toBe(status === "loading");
  expect(container.textContent).not.toContain("plugins.detail.status.loading");
});
it("leaves unknown configuration to the original form without a second status or action", () => {
  const p = {
    row, enabled: false, online: true, busy: false, settingsOpen: false,
    model: { ...pluginDetailModel(row as any, undefined, true, false, false), status: "disabled" as const, statusAction: "enable" as const,
      configuration: { items: [{ id: "account", kind: "oauth" as const, label: "Account", state: "unknown" as const }], alternatives: [] } },
    settingsContent: createElement("span", null, "Original configuration"),
    onEnabledChange: vi.fn(), onOpen: vi.fn(), onNewTask: vi.fn(), onChooseTask: vi.fn(), onResolveStatus: vi.fn(),
  };
  const { container } = mount(PluginDetailView, p);
  expect(container.querySelector('[data-testid="plugins.status"]')).toBeNull();
  expect(container.querySelector('[data-testid="plugins.configurationStatus"]')).toBeNull();
  expect(container.textContent).toContain("Original configuration");
  expect(p.onResolveStatus).not.toHaveBeenCalled();
  expect(p.onEnabledChange).not.toHaveBeenCalled();
});
it("shows full consent facts in a separate sheet and rejects stale owner or request callbacks", () => {
  const state = { outcome: "confirmation", operationId: "operation", online: true, busy: false, receipt: { consent: {
    requestId: "request", origin: "custom-market", originLabel: "Verified source", initiator: "user",
    facts: { kind: "update", ghostId: "plugin-id", name: "Plugin", version: "2", previousVersion: "1", unchangedCount: 2, builtinOauthClientChanged: true,
      added: [{ key: "node", kind: "node", labelKey: "nodeRuntime", detailKey: "nodeRuntimeDetail", detail: "Full local access risk" }],
      removed: [{ key: "network", kind: "network", labelKey: "networkHost", detail: "Removed host access" }] },
  } } } as any;
  const controller = { getState: () => state, answer: vi.fn() } as any;
  const props = { state, controller, active: true, deviceName: "Mac" };
  const { container, rerender } = mount(PluginManagementConfirmation, props);
  expect(bridge.props.get("plugins.managementConfirmation").visible).toBe(true);
  // The custom market name is interpolated into the source line (pluginManagement.test.ts checks the text).
  for (const fact of ["Plugin · 2", "plugin-id", "plugins.notice.consentSource.customMarket", "Full local access risk", "Removed host access", "plugins.management.permissions.nodeRuntimeDetail", "plugins.management.oauthChanged"]) expect(container.textContent).toContain(fact);
  const allow = bridge.props.get("plugins.management.allow").onPress;
  state.online = false;
  rerender({ ...props, active: false });
  expect(bridge.props.get("plugins.managementConfirmation").visible).toBe(false);
  act(() => allow());
  expect(controller.answer).not.toHaveBeenCalled();
  state.online = true;
  rerender(props);
  expect(bridge.props.get("plugins.managementConfirmation").visible).toBe(true);
  expect(controller.answer).not.toHaveBeenCalled();
  bridge.ownerCurrent = false;
  act(() => allow());
  expect(controller.answer).not.toHaveBeenCalled();
  bridge.ownerCurrent = true;
  state.receipt.consent.requestId = "new-request";
  act(() => allow());
  expect(controller.answer).not.toHaveBeenCalled();
  state.receipt.consent.requestId = "request";
  act(() => bridge.props.get("plugins.management.reject").onPress());
  expect(controller.answer).toHaveBeenCalledWith(false);
  act(() => roots.pop()!.unmount());
  act(() => allow());
  expect(controller.answer).toHaveBeenCalledTimes(1);
});

it("constrains RN notice Hosts to the measured width and measures only their height", () => {
  const { container } = mount(PluginNoticeHost, { testID: "noticeSizing", title: "Read failed", detail: "A long settings read failure that must wrap", actions: [{ label: "Reload", onPress() {} }] });
  act(() => bridge.props.get("noticeSizing.layout").onLayout({ nativeEvent: { layout: { width: 350 } } }));
  expect(bridge.props.get("host").matchContents).toEqual({ vertical: true });
  expect(bridge.props.get("host").style.width).toBe(350);
  expect(container.textContent).toContain("Reload");
});


it.each([PluginDetailView, AndroidDetailView])("keeps task actions for pending setup without a redundant prompt beside the original form (%#)", (DetailView) => {
  const resource = { ...row.item, blocks: [{ id: "capabilities", primitive: "plugin-capabilities", fallbackMarkdown: "", data: { usage: {
    taskUsable: true, hasSettings: true, builtin: false, retired: false, approvalRequired: false,
    setup: { state: "required", missing: ["Account"], expired: [] },
  } } }] };
  const model = pluginDetailModel(row as any, resource as any, true, false, false);
  const p = { row, model, enabled: true, online: true, busy: false, settingsOpen: false,
    settingsContent: createElement("span", null, "Original account form"),
    onEnabledChange: vi.fn(), onOpen: vi.fn(), onNewTask: vi.fn(), onChooseTask: vi.fn(), onResolveStatus: vi.fn() };
  const { container, rerender } = mount(DetailView, p);
  expect(model.status).toBe("setupRequired");
  expect(model.missing).toEqual(["Account"]);
  expect(container.querySelector('[data-testid="plugins.configurationStatus"]')).toBeNull();
  expect(container.textContent).toContain("Original account form");
  for (const action of ["newTask", "chooseTask"]) expect(container.querySelector(`[data-testid="plugins.${action}"]`)).not.toBeNull();
  act(() => bridge.props.get("plugins.newTask").onPress());
  act(() => bridge.props.get("plugins.chooseTask").onPress());
  expect(p.onNewTask).toHaveBeenCalledOnce(); expect(p.onChooseTask).toHaveBeenCalledOnce();
  bridge.keyboardVisible = true; rerender(p);
  expect(container.querySelector('[data-testid="plugins.newTask"]')).toBeNull();
  bridge.keyboardVisible = false;
  rerender({ ...p, model: { ...model, missing: [], expired: ["Account"] } });
  expect(container.querySelector('[data-testid="plugins.configurationStatus"]')).toBeNull();
});

it.each([PluginDetailView, AndroidDetailView])("separates read/navigation recovery from pending write and task gates (%#)", (DetailView) => {
  const p = { row, enabled: true, online: false, busy: true, statusRecoveryBusy: false, settingsOpen: false,
    model: pluginDetailModel(row as any, undefined, false, false, false),
    onEnabledChange: vi.fn(), onOpen: vi.fn(), onNewTask: vi.fn(), onChooseTask: vi.fn(), onResolveStatus: vi.fn() };
  const { rerender } = mount(DetailView, p);
  const disabled = (id: string) => {
    const value = bridge.props.get(id);
    return value.disabled ?? value.modifiers?.find((m: any) => 'disabled' in m)?.disabled;
  };
  for (const online of [false, true]) {
    const model = pluginDetailModel(row as any, undefined, online, false, online);
    rerender({ ...p, online, model });
    expect(disabled("plugins.resolveStatus")).toBe(false);
    act(() => bridge.props.get("plugins.resolveStatus").onPress());
    rerender({ ...p, online, model, statusRecoveryBusy: true });
    expect(disabled("plugins.resolveStatus")).toBe(true);
  }
  expect(p.onResolveStatus).toHaveBeenCalledTimes(2);
  rerender({ ...p, online: true, model: { ...p.model, status: undefined, canUseTasks: true } });
  for (const id of ["plugins.newTask", "plugins.chooseTask"]) expect(disabled(id)).toBe(true);
});


it.each(["light", "dark"] as const)("pairs confirmation Allow background and custom label contrast in %s", (mode) => {
  bridge.mode = mode;
  const state = { outcome: "confirmation", online: true, busy: false, receipt: { consent: {
    requestId: "request", origin: "local-file", initiator: "user", facts: { kind: "install", ghostId: "qa", name: "QA", version: "1", permissions: [] },
  } } } as any;
  mount(PluginManagementConfirmation, { state, controller: { getState: () => state, answer: vi.fn() } as any, active: true, deviceName: "QA Mac" });
  const allow = bridge.props.get("plugins.management.allow");
  expect(allow.modifiers).toContainEqual({ tint: palettes[mode].cta });
  expect(allow.modifiers).toContainEqual({ foregroundStyle: palettes[mode].ctaText });
  expect(allow.children.props.modifiers).toContainEqual({ foregroundStyle: palettes[mode].ctaText });
  expect(palettes[mode].cta).not.toBe(palettes[mode].ctaText);
});


it("uses an identifiable native bordered recovery action without a second card", () => {
  const { container } = mount(PluginNativeNotice, { compact: true, testID: "compact", title: "Long recovery message", actions: [{ label: "Reload", testID: "reload", onPress: vi.fn() }] });
  expect(bridge.props.get("reload").modifiers).toContainEqual({ buttonStyle: "bordered" });
  expect(bridge.props.get("reload").modifiers).toContainEqual({ controlSize: "small" });
  const title = Array.from(container.querySelectorAll('[data-native="Text"]')).find((node) => node.textContent === "Long recovery message")!;
  expect(title).toBeTruthy();
});


it("keeps settings load failure compact with its semantic icon and standard reload action", () => {
  const onPress = vi.fn();
  const { container } = mount(PluginNativeNotice, { unavailable: true, testID: "loadFailure", title: "Could not load settings", detail: "Should not repeat", actions: [{ label: "Reload settings", testID: "reload", onPress }] });
  expect(container.querySelector('[data-native="ContentUnavailableView"]')).toBeNull();
  expect(container.textContent).toContain("Could not load settings");
  expect(bridge.props.get("loadFailure").modifiers).not.toContainEqual({ frame: { height: 180, maxWidth: Infinity } });
  expect(container.textContent).not.toContain("Should not repeat");
  expect(bridge.props.get("reload").label).toBe("Reload settings");
  expect(bridge.props.get("reload").children).toBeUndefined();
  act(() => bridge.props.get("reload").onPress());
  expect(onPress).toHaveBeenCalledOnce();
});


it.each(["light", "dark"] as const)("renders the actual top notice as a low-contrast status strip in %s and moves narrow actions below", (mode) => {
  bridge.mode = mode;
  const { container } = mount(PluginNativeNotice, { testID: "strip", title: "Computer offline", icon: "offline", actions: [{ label: "Connect computer", testID: "connect", onPress: vi.fn() }] });
  const modifiers = bridge.props.get("strip").modifiers;
  expect(modifiers).toContainEqual({ background: palettes[mode].surfaceChip });
  expect(modifiers).toContainEqual({ frame: { minHeight: 48, maxWidth: Infinity, alignment: "leading" } });
  const root = container.querySelector('[data-testid="strip"]')!;
  expect(root.querySelector('[data-testid="connect"]')?.parentElement?.getAttribute("data-native")).toBe("HStack");
  act(() => modifiers.find((modifier: any) => modifier.onGeometryChange).onGeometryChange({ width: 280, height: 52 }));
  expect(root.querySelector('[data-testid="connect"]')?.parentElement?.getAttribute("data-native")).toBe("VStack");
});


it.each([PluginDetailView, AndroidDetailView])("limits permission summaries to four, keeps icons, and resets expansion only for another target (%#)", (DetailView) => {
  const permissions = Array.from({ length: 5 }, (_, index) => ({ title: `Full permission title ${index + 1}`, kind: "network", labelKey: "networkHost", description: "Not part of summary" }));
  const p = { row, enabled: true, online: true, busy: false, settingsOpen: false,
    model: { ...pluginDetailModel(row as any, undefined, true, false, false), permissions: permissions.slice(0, 4) },
    onEnabledChange: vi.fn(), onOpen: vi.fn(), onNewTask: vi.fn(), onChooseTask: vi.fn(), onResolveStatus: vi.fn() };
  const { container, rerender } = mount(DetailView, p);
  const card = () => container.querySelector('[data-testid="plugins.permissions"]')!;
  expect(container.querySelector('[data-testid="plugins.permissionsDisclosure"]')).toBeNull();
  expect(card().querySelectorAll('[data-permission-icon="Globe"]')).toHaveLength(4);
  rerender({ ...p, model: { ...p.model, permissions } });
  expect(card().textContent).not.toContain("Full permission title 5");
  act(() => bridge.props.get("plugins.permissionsDisclosure").onPress());
  expect(card().textContent).toContain("Full permission title 5");
  expect(card().querySelectorAll('[data-permission-icon="Globe"]')).toHaveLength(5);
  expect(card().querySelector('[data-permission-icon="Shield"]')).toBeNull();
  expect(card().textContent).not.toContain("Not part of summary");
  rerender({ ...p, model: { ...p.model, permissions: permissions.map(item => ({ ...item })) } });
  expect(card().textContent).toContain("Full permission title 5");
  act(() => bridge.props.get("plugins.permissionsDisclosure").onPress());
  expect(card().textContent).not.toContain("Full permission title 5");
  act(() => bridge.props.get("plugins.permissionsDisclosure").onPress());
  rerender({ ...p, row: { ...row, key: "other-device:other-plugin" }, model: { ...p.model, permissions } });
  expect(card().textContent).not.toContain("Full permission title 5");
});

// The normal phone detail must expose recovery independently of its mutation gate
// on both native renderers; controller identity/replay behavior is covered by pluginsScreen.
it.each([PluginDetailView, AndroidDetailView])("keeps unknown-result recovery reachable while detail mutations are blocked (%#)", (DetailView) => {
  const onPress = vi.fn();
  const managementNotice = { title: "Result unconfirmed", actions: [{ label: "Check result", testID: "check-result", disabled: false, onPress }] };
  const p = { row, enabled: true, online: true, busy: true, settingsOpen: false,
    model: { ...pluginDetailModel(row as any, row.item as any, true, false, false), canUseTasks: true }, managementNotice,
    onEnabledChange: vi.fn(), onOpen: vi.fn(), onNewTask: vi.fn(), onChooseTask: vi.fn(), onResolveStatus: vi.fn() };
  const { container, rerender } = mount(DetailView, p);
  expect(container.textContent).toContain("Result unconfirmed");
  const disabled = (id: string) => {
    const value = bridge.props.get(id);
    return value.disabled ?? value.modifiers?.find((m: any) => 'disabled' in m)?.disabled;
  };
  expect(disabled("plugins.newTask")).toBe(true);
  expect(disabled("check-result")).toBe(false);
  act(() => bridge.props.get("check-result").onPress());
  expect(onPress).toHaveBeenCalledTimes(1);
  rerender({ ...p, managementNotice: undefined });
  expect(container.textContent).not.toContain("Result unconfirmed");
});

/* 测试价值（PR 评审：高风险权限在点「允许」前可见，2026-11-25）
 * - 生产入口与可观察结果：两端真实确认面板组件；观察固定段是否在滚动内容之外、紧挨按钮。
 * - 依据：维护者要求高风险权限在确认前可见；iOS 半高面板与 Android 矮屏都只保证按钮区可见。
 * - 缺口：此前 Node 权限说明只在可滚动的权限列表里。
 * - 最小失败输入：新装含 node:execute；对照组不含。tier: unit。
 */
// PR #12684 maintainer review: before allowing, a custom-market install names the target computer and the repository.
it.each([["iOS", PluginManagementConfirmation], ["Android", AndroidManagementConfirmation]] as const)(
  "%s shows the repository right after the computer line", (_platform, Sheet) => {
    const state = { outcome: "confirmation", online: true, busy: false, receipt: { consent: {
      requestId: "request", origin: "custom-market", originLabel: "Acme", initiator: "user",
      originSource: { kind: "git", repository: "github.com/acme/plugins" },
      facts: { kind: "install", ghostId: "runner", name: "Runner", version: "1", permissions: [] } } } } as any;
    const { container } = mount(Sheet, { state, controller: { getState: () => state, answer: vi.fn() } as any, active: true, deviceName: "Mac" });
    const text = container.textContent!;
    // Order (PR #12684 layout review): computer, marketplace, repository, then the explanations and the identifier.
    const device = text.indexOf("plugins.market.installTo"), origin = text.indexOf("plugins.notice.consentSource.customMarket");
    const repository = text.indexOf("plugins.notice.consentSource.repository");
    expect(device).toBeGreaterThanOrEqual(0);
    expect(origin).toBeGreaterThan(device);
    expect(repository).toBeGreaterThan(origin);
    expect(repository).toBeLessThan(text.indexOf("plugins.notice.sourceNotice.customMarket"));
    expect(repository).toBeLessThan(text.indexOf("runner"));
  });

/**
 * PR #12684 maintainer decision (older Host without repository identity), proposal pending confirmation:
 * - 依据：新装只能看到市场名时，手机无法说明允许的是哪个仓库；升级是已装插件，保留可允许并给出核实路径。
 * - 缺口：此前缺少 originSource 时确认面板照常可点「允许」，且不说明来源无法核实。
 * - 最小失败输入：custom-market 新装无 originSource；对照组为升级、带 originSource 的新装。tier: unit。
 */
describe("older Host without a repository identity", () => {
  const sheetProps = (consent: Record<string, unknown>, facts: Record<string, unknown>) => {
    const state = { outcome: "confirmation", online: true, busy: false, receipt: { consent: {
      requestId: "request", origin: "custom-market", originLabel: "Acme", initiator: "user", ...consent, facts } } } as any;
    return { state, controller: { getState: () => state, answer: vi.fn() } as any, active: true, deviceName: "Mac" };
  };
  const installFacts = { kind: "install", ghostId: "runner", name: "Runner", version: "1", permissions: [] };
  const updateFacts = { kind: "update", ghostId: "runner", name: "Runner", version: "2", previousVersion: "1", added: [], removed: [],
    unchangedCount: 1, builtinOauthClientChanged: false };
  const disabled = (id: string) => {
    const value = bridge.props.get(id);
    return value.disabled ?? value.modifiers?.find((m: any) => m && "disabled" in m)?.disabled;
  };
  it.each([["iOS", PluginManagementConfirmation], ["Android", AndroidManagementConfirmation]] as const)(
    "%s keeps Allow unavailable for a first install it cannot name the repository of", (_platform, Sheet) => {
      const p = sheetProps({}, installFacts);
      const { container } = mount(Sheet, p);
      expect(container.textContent).toContain("plugins.notice.consentSource.repositoryMissingInstall");
      expect(disabled("plugins.management.allow")).toBe(true);
      // Rejecting stays possible, so the waiting install can be closed from the phone.
      expect(disabled("plugins.management.reject")).toBe(false);
    });
  // Maintainer review 11:45: while an answer to this consent is in flight or written (answerHeld), neither button can be
  // tapped, so one consent request never gets two answers; both come back once it is known the answer was not written.
  it.each([["iOS", PluginManagementConfirmation], ["Android", AndroidManagementConfirmation]] as const)(
    "%s keeps both answers unavailable while an answer to this consent is held", (_platform, Sheet) => {
      const p = sheetProps({ origin: "market" }, installFacts);
      p.state.answerHeld = "request";
      mount(Sheet, p);
      expect(disabled("plugins.management.allow")).toBe(true);
      expect(disabled("plugins.management.reject")).toBe(true);
      p.state.answerHeld = null;
      mount(Sheet, p);
      expect(disabled("plugins.management.allow")).toBe(false);
      expect(disabled("plugins.management.reject")).toBe(false);
    });
  // Maintainer review 05:55 #3 (contract #12731): an update from a custom market without a source is not allowed
  // here either; Reject stays available and the line says how to continue on the computer.
  it.each([["iOS", PluginManagementConfirmation], ["Android", AndroidManagementConfirmation]] as const)(
    "%s keeps only Reject for an update without a source too", (_platform, Sheet) => {
      const { container } = mount(Sheet, sheetProps({}, updateFacts));
      expect(container.textContent).toContain("plugins.notice.consentSource.repositoryMissingUpdate");
      expect(disabled("plugins.management.allow")).toBe(true);
      expect(disabled("plugins.management.reject")).toBe(false);
    });
  // Contract V2.4b: the update comes from another source than the installed version; said without scrolling.
  it.each([["iOS", PluginManagementConfirmation], ["Android", AndroidManagementConfirmation]] as const)(
    "%s says when an update comes from another source than the installed version", (_platform, Sheet) => {
      const { container } = mount(Sheet, sheetProps({ originSource: { kind: "local", sourceId: "SourceA_0123456789abcd" },
        originSourceChanged: true }, updateFacts));
      const text = container.textContent!;
      // A local folder shows no repository, so the sentence does not ask to trust one (#12731 e2fbe72a).
      const line = text.indexOf("plugins.notice.consentSource.sourceChangedIsolated");
      expect(line).toBeGreaterThan(text.indexOf("plugins.notice.consentSource.localFolder"));
      expect(line).toBeLessThan(text.indexOf("plugins.management.versionChange"));
      expect(text).not.toContain("plugins.notice.consentSource.originSourceChanged");
    });
  // Maintainer review 05:55 #2: the consent names another source than the one chosen on the phone.
  it.each([["iOS", PluginManagementConfirmation], ["Android", AndroidManagementConfirmation]] as const)(
    "%s keeps only Reject when the consent names another source than the one chosen", (_platform, Sheet) => {
      const chosen = { kind: "local", sourceId: "SourceA_0123456789abcd" };
      const p = sheetProps({ originSource: { kind: "local", sourceId: "SourceB_0123456789abcd" } }, installFacts);
      p.state.expectedSource = chosen;
      const { container } = mount(Sheet, p);
      expect(container.textContent).toContain("plugins.notice.consentSource.sourceChanged");
      expect(disabled("plugins.management.allow")).toBe(true);
      expect(disabled("plugins.management.reject")).toBe(false);
    });
  it.each([["iOS", PluginManagementConfirmation], ["Android", AndroidManagementConfirmation]] as const)(
    "%s allows a first install whose repository the Host named", (_platform, Sheet) => {
      const { container } = mount(Sheet, sheetProps({ originSource: { kind: "git", repository: "github.com/acme/plugins" } }, installFacts));
      expect(container.textContent).not.toContain("repositoryMissing");
      expect(disabled("plugins.management.allow")).toBe(false);
    });
  const legacyItem = { pluginId: "custom:Acme/runner", ghostId: "runner", name: "Runner", description: "From Acme",
    scope: "public", sourceType: "git-market", sourceMarketName: "Acme", installState: "not-installed", icon: null,
    version: "1", releaseId: "runner@1" };
  it("iOS market row offers no install for it and says to install on the computer", () => {
    const market = marketModel({ items: [legacyItem], rowState: () => ({ kind: "sourceUnverified" }) });
    const { container } = mount(PluginDirectoryView, { ...directory(), market, segment: "market" });
    expect(disabled("plugins.market.install.custom:Acme/runner")).toBe(true);
    expect(container.textContent).toContain("plugins.market.sourceUnverifiedShort");
  });
  it("Android market row offers no install for it and says to install on the computer", () => {
    const market = marketModel({ items: [legacyItem], rowState: () => ({ kind: "sourceUnverified" }) });
    const { container } = mount(PluginMarketSection, { market, onConnectComputer: vi.fn() });
    expect(disabled("plugins.market.install.custom:Acme/runner")).toBe(true);
    expect(container.textContent).toContain("plugins.market.sourceUnverifiedShort");
  });
  it.each([["iOS", MarketDetailView], ["Android", AndroidMarketDetailView]] as const)(
    "%s market detail keeps Install unavailable with the full explanation", (_platform, Detail) => {
      const market = marketModel({ rowState: () => ({ kind: "sourceUnverified" }) });
      const { container } = mount(Detail, { market, detail: { item: legacyItem, target: row.host, loading: false, failed: false } });
      expect(disabled("plugins.market.detailInstall")).toBe(true);
      // The full note (not the short row text); this test's Android Text stand-in keeps no testID.
      expect(container.textContent).toMatch(/plugins\.market\.sourceUnverified(?!Short)/);
      // Android layout re-check: "After you tap Install…" does not apply while Install is unavailable.
      expect(container.textContent).not.toContain("plugins.market.securityBody");
    });
});

describe("pinned high-risk permission", () => {
  const consentState = (facts: any) => ({ outcome: "confirmation", online: true, busy: false, receipt: { consent: {
    requestId: "request", origin: "market", initiator: "user", facts } } }) as any;
  const installOf = (permissions: any[]) => ({ kind: "install", ghostId: "runner", name: "Runner", version: "1", permissions });
  const node = { key: "node:execute", kind: "node", labelKey: "nodeRuntime", detailKey: "nodeRuntimeDetail" };
  const notify = { key: "notify", kind: "notify", labelKey: "notify", detailKey: "notifyDetail" };
  const secret = { key: "node:secret:token:worker.cjs:run", kind: "node", labelKey: "nodeSecret", labelArgs: { name: "API token" },
    detailKey: "nodeSecretDetail", detail: "upload_with_token" };
  const background = { key: "agent:background", kind: "agent", labelKey: "agentBackground", detailKey: "agentBackgroundDetail" };
  const errand = { key: "agent:errand", kind: "agent", labelKey: "agentErrand", detailKey: "agentErrandDetail" };
  const secretOnlyUpdate = { kind: "update", ghostId: "runner", name: "Runner", version: "2", previousVersion: "1", added: [secret],
    removed: [], unchangedCount: 2, builtinOauthClientChanged: false };
  const props = (facts: any) => { const state = consentState(facts);
    return { state, controller: { getState: () => state, answer: vi.fn() } as any, active: true, deviceName: "Mac" }; };
  const methods = Array.from({ length: 16 }, (_, index) => `call_${index}`);
  const manyBindings = installOf([...Array.from({ length: 4 }, (_, index) => ({ key: `node:secret:t${index}:worker.cjs:all`, kind: "node",
    labelKey: "nodeSecret", labelArgs: { name: `Token ${index}` }, detailKey: "nodeSecretDetail", detail: methods.join("\n") })), node]);
  // [case, facts, short summary lines expected in the pinned area, full texts expected only in the scrolled list]
  const cases = [
    ["a first install with Node", installOf([notify, node]), ["plugins.management.permissions.nodeRuntime"],
      ["plugins.management.permissions.nodeRuntimeDetail"]],
    ["an update that only adds a credential binding", secretOnlyUpdate, ["plugins.management.permissions.nodeSecretOne"],
      ["plugins.management.permissions.nodeSecretDetail", "upload_with_token"]],
    // Maintainer review 04:09: a long, multi-line package-declared name stays out of the two-line summary.
    ["an update that adds one binding with a long multi-line name",
      { ...secretOnlyUpdate, added: [{ ...secret, labelArgs: { name: "Production deployment token\nfor the shared release pipeline\n(rotated weekly)" } }] },
      // (This stand-in translator drops arguments; the name itself is checked in pluginManagement.test.ts.)
      ["plugins.management.permissions.nodeSecretOne"], ["plugins.management.permissions.nodeSecretDetail", "upload_with_token"]],
    ["a first install without Node but with Agent high-risk items", installOf([errand, background, notify]),
      ["plugins.management.permissions.agentErrand", "plugins.management.permissions.agentBackground"],
      ["plugins.management.permissions.agentErrandDetail", "plugins.management.permissions.agentBackgroundDetail"]],
    ["four credential bindings with sixteen methods each", manyBindings,
      ["plugins.management.permissions.nodeSecretCount", "plugins.management.permissions.nodeRuntime"],
      // Credential names are interpolated (checked in pluginManagement.test.ts); here every method stays reachable.
      ["call_0", "call_15", "plugins.management.permissions.nodeRuntimeDetail"]],
  ] as const;

  it.each(cases)("iOS pins a bounded summary of %s beside the buttons; full details stay in the scrolled list", (_name, facts, summary, details) => {
    const { container } = mount(PluginManagementConfirmation, props(facts));
    const pinned = container.querySelector('[data-testid="plugins.management.highRisk"]')!;
    expect(pinned.parentElement!.querySelector('[data-testid="plugins.management.allow"]')).not.toBeNull();
    expect(pinned.textContent).toContain("plugins.management.highRiskTitle");
    for (const line of summary) expect(pinned.textContent).toContain(line);
    // A heading plus at most five lines, each capped to two lines.
    const texts = pinned.querySelectorAll('[data-native="Text"]');
    expect(texts.length).toBeLessThanOrEqual(6);
    for (const detail of details) {
      expect(pinned.textContent).not.toContain(detail);
      expect(container.textContent).toContain(detail);
    }
  });
  // iOS re-check of f22c9858: at the medium detent the list could not be scrolled to its end (the swipe expanded
  // the sheet). With high-risk items the sheet opens large; without them it keeps the default detents.
  it("iOS opens the confirmation large only when it has high-risk items", () => {
    mount(PluginManagementConfirmation, props(installOf([notify, node])));
    expect(bridge.props.get("plugins.managementConfirmation").largeOnly).toBe(true);
    mount(PluginManagementConfirmation, props(installOf([notify])));
    expect(bridge.props.get("plugins.managementConfirmation").largeOnly).toBe(false);
  });
  it("iOS shows no pinned text when nothing is high risk", () => {
    const { container } = mount(PluginManagementConfirmation, props(installOf([notify])));
    expect(container.querySelector('[data-testid="plugins.management.highRisk"]')).toBeNull();
  });
  it.each(cases)("Android pins a bounded summary of %s outside the scroll area; full details stay in the scrolled list", (_name, facts, summary, details) => {
    const { container } = mount(AndroidManagementConfirmation, props(facts));
    const sheet = container.querySelector('[data-testid="plugins.managementConfirmation"]')!;
    const scroll = sheet.firstElementChild!;
    const pinned = sheet.querySelector('[data-testid="plugins.management.highRisk"]')!;
    expect(scroll.contains(pinned)).toBe(false);
    const text = sheet.textContent!;
    expect(text.indexOf(pinned.textContent!)).toBeLessThan(text.indexOf("plugins.management.allow"));
    for (const line of summary) expect(pinned.textContent).toContain(line);
    for (const detail of details) {
      expect(pinned.textContent).not.toContain(detail);
      expect(scroll.textContent).toContain(detail);
    }
  });
  it("Android keeps the pinned area within its height bound for the largest permission list", () => {
    mount(AndroidManagementConfirmation, props(manyBindings));
    expect(bridge.props.get("plugins.management.highRiskScroll").style.maxHeight).toBeLessThanOrEqual(Math.floor(844 * 0.85 * 0.25));
  });
  // Android re-check of the pinned area: without a separator, a list title resting right above the summary read
  // as a repeat; the summary heading was smaller than the list's permission titles.
  it("iOS separates the pinned summary from the scrolled list and titles it like the list", () => {
    const { container } = mount(PluginManagementConfirmation, props(installOf([errand, background])));
    const pinned = container.querySelector('[data-testid="plugins.management.highRisk"]')!;
    expect(pinned.previousElementSibling?.getAttribute("data-native")).toBe("Divider");
    const heading = bridge.props.get("plugins.management.highRisk");
    const title = (Array.isArray(heading.children) ? heading.children.flat() : [heading.children]).filter(Boolean)[0];
    expect(title.props.modifiers).toContainEqual({ font: { textStyle: "subheadline", weight: "semibold" } });
  });
  it("Android separates the pinned summary from the scrolled list and titles it like the list", () => {
    mount(AndroidManagementConfirmation, props(installOf([errand, background])));
    const pinned = bridge.props.get("plugins.management.highRisk");
    expect(pinned.style).toMatchObject({ borderTopColor: palettes.light.border });
    expect("borderTopWidth" in pinned.style).toBe(true);
    const title = (Array.isArray(pinned.children) ? pinned.children.flat() : [pinned.children]).filter(Boolean)[0];
    expect(title.props.style).toMatchObject({ fontSize: 15, fontWeight: "600" });
  });
  // iOS / Android layout re-checks (3587f6ca, accessibility-large and English short screen): capped rows cut the end
  // of every line, and an unbounded summary pushed the computer and source out of view. Every line is shown in full,
  // in a fixed class order, and scrolls inside a bound computed from the measured identity block, heading and buttons.
  const resident = { key: "node:resident", kind: "node", labelKey: "nodeResident", detailKey: "nodeResidentDetail" };
  const allFive = installOf([resident, secret, node, background, errand]);
  const fiveLines = ["plugins.management.permissions.nodeRuntime", "plugins.management.permissions.nodeSecretOne",
    "plugins.management.permissions.nodeResident", "plugins.management.permissions.agentBackground", "plugins.management.permissions.agentErrand"];
  const geometry = (id: string, height: number) => act(() => {
    bridge.props.get(id).modifiers.find((m: any) => m.onGeometryChange).onGeometryChange({ width: 390, height });
  });
  // Layout re-checks (d81200da): one sharing rule for both platforms (`allocateConsentSheet`, its matrix is in
  // pluginManagement.test.ts). Here: the sheets feed it what they measure and use its result; the heading wraps and
  // says how many classes follow; a hint shows when lines are hidden; at large text the buttons stack, Allow first.
  it("iOS shows every pinned line in full and shares the sheet by the measured parts", () => {
    bridge.fontScale = 2.4;
    mount(PluginManagementConfirmation, props(allFive));
    const scroll = () => bridge.props.get("plugins.management.highRiskScroll");
    const lines = () => (Array.isArray(scroll().children.props.children) ? scroll().children.props.children : [scroll().children.props.children]).flat();
    expect(lines().map((line: any) => line.props.children)).toEqual(fiveLines);
    for (const line of lines()) expect(line.props.modifiers.some((m: any) => "lineLimit" in m)).toBe(false);
    expect(bridge.props.get("plugins.management.highRiskTitle").modifiers.some((m: any) => "lineLimit" in m)).toBe(false);
    expect(scroll().modifiers).toContainEqual({ scrollIndicators: "visible" });
    // The window (844 pt, no insets here) minus the sheet header at this text size, the fixed footer spacing and the buttons.
    const header = Math.ceil(64 * 2) + 10, chrome = 8 * 2 + 8 * 4 + 4 + 12;
    const height = () => scroll().modifiers.find((m: any) => m.frame)?.frame.height;
    expect(height()).toBe(Math.floor((844 - header - chrome) * 0.25)); // not measured yet: a conservative share
    geometry("plugins.management.identity", 360);
    geometry("plugins.management.actions", 96);
    geometry("plugins.management.highRiskTitle", 30);
    lines().forEach((line: any) => act(() => line.props.modifiers.find((m: any) => m.onGeometryChange).onGeometryChange({ width: 300, height: 40 })));
    const share = allocateConsentSheet({ available: 844 - header - chrome - 96, identity: 360, heading: 30, lines: [40, 40, 40, 40, 40], gap: 4 });
    expect(share).toMatchObject({ identity: 360, clipped: true });
    // The hint takes room too once it shows.
    geometry("plugins.management.highRiskMore", 20);
    const hinted = allocateConsentSheet({ available: 844 - header - chrome - 96 - 20 - 8, identity: 360, heading: 30, lines: [40, 40, 40, 40, 40], gap: 4 });
    expect(height()).toBe(hinted.summaryLines);
    expect(hinted.summaryLines).toBeGreaterThanOrEqual(2 * 40 + 4);
    expect(bridge.props.has("plugins.management.listMore")).toBe(false);
    // An identity block taller than its share: the list hint says to scroll up, and takes room from the summary.
    geometry("plugins.management.identity", 520);
    expect(bridge.props.has("plugins.management.listMore")).toBe(true);
    geometry("plugins.management.listMore", 20);
    const tall = layoutConsentSheet({ available: 844 - header - chrome - 96, identity: 520, heading: 30, lines: [40, 40, 40, 40, 40],
      gap: 4, summaryHint: 20, listHint: 20, hintGap: 8, listContent: 520 });
    expect(tall.listClipped).toBe(true);
    expect(height()).toBe(tall.summaryLines);
    // Large text: the buttons stack (a VStack), Allow first.
    const actions = bridge.props.get("plugins.management.actions");
    const order = (Array.isArray(actions.children) ? actions.children : [actions.children]).flat().map((child: any) => child.props.testID);
    expect(order).toEqual(["plugins.management.allow", "plugins.management.reject"]);
  });
  it("Android shows every pinned line in full and shares the sheet by the measured parts", () => {
    bridge.fontScale = 2;
    mount(AndroidManagementConfirmation, props(allFive));
    const scroll = () => bridge.props.get("plugins.management.highRiskScroll");
    const lines = () => (Array.isArray(scroll().children) ? scroll().children : [scroll().children]).flat().filter(Boolean);
    expect(lines().map((line: any) => line.props.children)).toEqual(fiveLines);
    for (const line of lines()) expect(line.props.numberOfLines).toBeUndefined();
    const heading = () => (bridge.props.get("plugins.management.highRisk").children as any[]).flat().find((child: any) => child?.props?.testID === "plugins.management.highRiskTitle");
    expect(heading().props.numberOfLines).toBeUndefined();
    expect(scroll().persistentScrollbar).toBe(true);
    const chrome = 20 * 2 + 12 + 12 * 2 + 4;
    // Before measuring: a conservative quarter of the sheet (85% of 844, minus its padding).
    expect(scroll().style).toMatchObject({ maxHeight: Math.floor((Math.floor(844 * 0.85) - chrome) * 0.25) });
    const layout = (id: string, height: number) => act(() => bridge.props.get(id).onLayout({ nativeEvent: { layout: { height } } }));
    layout("plugins.management.identity", 380);
    layout("plugins.management.actions", 104);
    act(() => heading().props.onLayout({ nativeEvent: { layout: { height: 30 } } }));
    lines().forEach((line: any) => act(() => line.props.onLayout({ nativeEvent: { layout: { height: 40 } } })));
    const available = Math.floor(844 * 0.85) - chrome - 104;
    expect(allocateConsentSheet({ available, identity: 380, heading: 30, lines: [40, 40, 40, 40, 40], gap: 4 })).toMatchObject({ identity: 380, clipped: true });
    const hint = (bridge.props.get("plugins.management.highRisk").children as any[]).flat().find((child: any) => child?.props?.testID === "plugins.management.highRiskMore");
    act(() => hint.props.onLayout({ nativeEvent: { layout: { height: 20 } } }));
    const hinted = allocateConsentSheet({ available: available - 20 - 4, identity: 380, heading: 30, lines: [40, 40, 40, 40, 40], gap: 4 });
    expect(scroll().style.maxHeight).toBe(hinted.summaryLines);
    expect(hinted.summaryLines).toBeGreaterThanOrEqual(2 * 40 + 4);
    // The list is longer than the room left to it: its hint shows and takes its own room from the summary's share.
    const listMore = () => (bridge.props.get("plugins.managementConfirmation").children as any[]).flat()
      .find((child: any) => child?.props?.testID === "plugins.management.listMore");
    expect(listMore()).toBeUndefined();
    act(() => bridge.props.get("plugins.management.list").onContentSizeChange(390, 1200));
    expect(listMore()).toBeDefined();
    act(() => listMore().props.onLayout({ nativeEvent: { layout: { height: 20 } } }));
    const withList = layoutConsentSheet({ available, identity: 380, heading: 30, lines: [40, 40, 40, 40, 40], gap: 4,
      summaryHint: 20, listHint: 20, hintGap: 4, listContent: 1200 - 12 });
    expect(withList.listClipped).toBe(true);
    expect(scroll().style.maxHeight).toBe(withList.summaryLines);
    expect(withList.summaryLines).toBeLessThan(hinted.summaryLines);
    // Scrolled to the end: the hint goes, the room stays (nothing jumps under the finger).
    act(() => bridge.props.get("plugins.management.list").onScroll({ nativeEvent: { contentOffset: { y: 900 },
      contentSize: { height: 1200 }, layoutMeasurement: { height: 300 } } }));
    expect(listMore()).toBeUndefined();
    expect(scroll().style.maxHeight).toBe(withList.summaryLines);
    // Large text: the buttons stack, Allow on top (column-reverse), labels wrapping.
    expect(bridge.props.get("plugins.management.actions").style).toContainEqual({ flexDirection: "column-reverse" });
  });
  it("Android shows no pinned area when nothing is high risk", () => {
    const { container } = mount(AndroidManagementConfirmation, props(installOf([notify])));
    expect(container.querySelector('[data-testid="plugins.management.highRisk"]')).toBeNull();
  });
});

/* 依据：三端展示同一份页面权限 facts；最小输入：ui purpose + app 工具列表；tier: unit。 */
it('renders UI capability purpose, unknown legacy source and complete Host permission details in the existing confirmation sheet', () => {
  const state = { outcome: 'confirmation', online: true, busy: false, receipt: { consent: {
    requestId: 'request', origin: 'local-file', initiator: 'user', purpose: 'ui-capability', trust: 'unverified',
    facts: { kind: 'install', ghostId: 'planner', name: 'Planner', version: '1', permissions: [
      { key: 'ui:pages', kind: 'panel', labelKey: 'mcpUi', detail: 'planner.html\napi.example.org\nsave_plan, open_plan' },
    ] },
  } } } as any;
  const { container } = mount(PluginManagementConfirmation, { state, controller: { getState: () => state, answer: vi.fn() } as any, active: true, deviceName: 'Mac' });
  for (const fact of ['plugins.uiApproval.purpose', 'mcpApps.source.unknown', 'planner.html', 'api.example.org', 'save_plan, open_plan'])
    expect(container.textContent).toContain(fact);
  expect(container.textContent).not.toContain('plugins.notice.taskCapability');
});

// Android simulator report (2026-11-25): system alerts show at most three buttons, so two sources and Cancel
// disappeared and the dialog could not be dismissed. The sheet must offer every source and every computer.
it("offers every market source and every computer in the Android choice sheet", () => {
  const filters = ["all", "official", "community", "organization", "custom"].map((value, index) => ({ value, count: index + 1 }));
  const targets = Array.from({ length: 5 }, (_, index) => ({ deviceId: `pc-${index}`, deviceName: `PC ${index}` }));
  const market = marketModel({ filters, targets, target: targets[0] });
  mount(PluginMarketSection, { market, onConnectComputer: vi.fn() });
  act(() => bridge.props.get("plugins.market.filter").onPress());
  for (const { value } of filters) expect(bridge.props.has(`plugins.market.filter.${value}`)).toBe(true);
  expect(bridge.props.get("plugins.market.filter.official").accessibilityState).toMatchObject({ selected: true });
  act(() => bridge.props.get("plugins.market.filter.custom").onPress());
  expect(market.setFilter).toHaveBeenCalledWith("custom");
  act(() => bridge.props.get("plugins.market.computer").onPress());
  for (const host of targets) expect(bridge.props.has(`plugins.market.computer.${host.deviceId}`)).toBe(true);
  act(() => bridge.props.get("plugins.market.computer.pc-4").onPress());
  expect(market.selectDevice).toHaveBeenCalledWith("pc-4");
});
