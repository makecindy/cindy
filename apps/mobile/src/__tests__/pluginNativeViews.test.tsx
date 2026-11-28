// @vitest-environment jsdom
import { PluginNativeNotice, PluginNotice as PluginNoticeHost } from "@/plugins/PluginNotice.ios";
import { act, createElement, useEffect, useImperativeHandle } from "react";
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
import { CONSENT_FADE_HEIGHT, planConsentSheet } from "@/plugins/pluginConsentPresentation";
import { declaredPluginConsent, pluginConsentAllowance } from "@/plugins/pluginConsentAllowance";
import { PluginManagementConfirmation } from "@/plugins/PluginManagementConfirmation.ios";
import { PluginManagementConfirmation as AndroidManagementConfirmation } from "@/plugins/PluginManagementConfirmation";
import { PluginModelPicker } from '@/plugins/PluginModelPicker';
import { usePluginPrompt } from "@/plugins/usePluginPrompt.ios";
import { PluginPendingChecksSheet } from "@/plugins/PluginPendingChecksSheet";

const bridge = vi.hoisted(() => ({
  maker: { getCapabilities: async () => ({ availableModels: [], effortLevels: [], permissionModes: [] }) },
  props: new Map<string, any>(),
  ownerCurrent: true,
  keyboardVisible: false,
  fontScale: 1,
  width: 390,
  height: 844,
  mode: "light" as "light" | "dark",
  /** `scrollTo` calls on a ScrollView, by its testID. */
  scrolledTo: [] as Array<[string | undefined, unknown]>,
  /** How many times a ScrollView with that testID was mounted (a new one starts at its top). */
  scrollMounts: new Map<string, number>(),
}));
vi.mock("@/hooks/useReduceMotion", () => ({ useReduceMotionEnabled: () => false }));
// Metro resolves the iOS market rows inside the iOS directory; vitest needs the platform file named.
vi.mock("@/plugins/PluginMarketRows", () => import("@/plugins/PluginMarketRows.ios"));
// The record panel only calls this on "Read again" (not pressed here); the real module needs the device link.
vi.mock("@/plugins/usePluginManagement", () => ({ retryPluginCheckReadback: () => {} }));
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
    // A view with a slot laid over it: both rendered in place (the slot after the base).
    Overlay: Object.assign((p: any) => {
      if (p.testID) bridge.props.set(p.testID, p);
      return React.createElement("div", { "data-native": "Overlay" }, p.children);
    }, { Content: (p: any) => React.createElement("div", { "data-native": "OverlayContent" }, p.children) }),
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
  // Scroll geometry observer: kept so a test can report geometry.
  useScrollGeometryChange: (callback: any) => ({ scrollGeometry: callback }),
  ...Object.fromEntries(
    [
      "accessibilityLabel",
      "accessibilityHidden",
      "accessibilityHint",
      "opacity",
      "layoutPriority",
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
      "id",
    ].map((name) => [name, (value: any) => ({ [name]: value })]),
  ),
}));
vi.mock("react-native", () => ({
  Platform: { OS: 'ios' },
  Alert: { alert: vi.fn() },
  PlatformColor: (name: string) => name,
  Keyboard: { addListener: () => ({ remove() {} }) },
  useWindowDimensions: () => ({ width: bridge.width, height: bridge.height, fontScale: bridge.fontScale }),
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
  // React 19 passes `ref` as a prop: the list's scrollTo calls are recorded.
  ScrollView: (p: any) => {
    useImperativeHandle(p.ref, () => ({ scrollTo: (to: unknown) => { bridge.scrolledTo.push([p.testID, to]); } }));
    useEffect(() => { if (p.testID) bridge.scrollMounts.set(p.testID, (bridge.scrollMounts.get(p.testID) ?? 0) + 1); }, []);
    if (p.testID) bridge.props.set(p.testID, p);
    return createElement("div", { "data-testid": p.testID }, p.children);
  },
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
  subscribeMobileAuthOwner: () => () => {},
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
  bridge.scrolledTo = [];
  bridge.scrollMounts.clear();
  bridge.mode = "light";
  bridge.width = 390;
  bridge.height = 844;
  bridge.ownerCurrent = true;
  bridge.keyboardVisible = false;
  bridge.fontScale = 1;
  bridge.width = 390;
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
/**
 * Reports one layout for every measured view of the consent sheet on screen, as a device does once it drew it (both
 * sheets): the identity block, the list's visible and content heights as given, every other measured view `other` high.
 */
/** The layout key a sheet's measured views carry (`consentLayoutKey`) for this consent at the mocked window and text size. */
const layoutKeyOf = (requestId: string) => `${requestId}|${bridge.width}x${bridge.height}@${bridge.fontScale}`;
/**
 * Whether the consent sheet's Allow can be pressed now (maintainer reviews 06:44, 08:37: Allow is its own control on both
 * sheets, drawn and unavailable until this consent is reviewed).
 */
function allowAvailable(): boolean {
  const allow = bridge.props.get("plugins.management.allow");
  if (!allow) return false;
  return !(allow.disabled ?? allow.modifiers?.find((m: any) => m && "disabled" in m)?.disabled);
}
/** iOS: press "Review source and permissions" (the reviewed list then shows the source and summary first). */
function reviewIOS() {
  act(() => bridge.props.get("plugins.management.review").onPress());
}
/**
 * `content: 0` leaves the list's content height unreported (on iOS that is the list's scroll geometry, its visible height
 * included). iOS: `visible` and `content` are the native list's scroll geometry, frames are global (the list at
 * `listTop`, 100 by default; its content root at `contentTop`); `innerContent` is the content root's own height. On iOS
 * these readings only lay the sheet out: none of them lets Allow answer (maintainer review 19:34), which the iOS cases
 * below check by reporting them in the orders a device can.
 */
/** Every view identity (`id` modifier) on the iOS sheet now: the list's, and those in its content and footer. */
function sheetViewIds(): Set<string> {
  const sheet = bridge.props.get("plugins.managementConfirmation");
  const ids = new Set<string>();
  const add = (modifiers: unknown) => { for (const m of Array.isArray(modifiers) ? modifiers : []) if (m && typeof m === "object" && "id" in m) ids.add(String((m as any).id)); };
  const walk = (node: any) => {
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (!node || typeof node !== "object" || !node.props) return;
    add(node.props.modifiers);
    walk(node.props.children);
  };
  add(sheet.nativeContentModifiers);
  walk(sheet.children);
  walk(sheet.footer);
  return ids;
}
/**
 * `renewedSince` (iOS): as on a device after a layout change, only views with a new identity (an `id` not in that set),
 * or inside one, report again; a view that kept its identity and its size reports nothing.
 */
function layOutSheet(heights: { identity: number; visible: number; content: number; other?: number; listTop?: number; contentTop?: number;
  innerContent?: number }, renewedSince?: Set<string>) {
  const sheet = bridge.props.get("plugins.managementConfirmation");
  const other = heights.other ?? 20;
  const listTop = heights.listTop ?? 100, contentTop = heights.contentTop ?? listTop;
  const calls: Array<() => void> = [];
  const renews = (modifiers: unknown) => !renewedSince
    || (Array.isArray(modifiers) && modifiers.some((m) => m && typeof m === "object" && "id" in m && !renewedSince.has(String((m as any).id))));
  const walk = (node: any, root = false, renewed = !renewedSince) => {
    if (Array.isArray(node)) { node.forEach((child) => walk(child, false, renewed)); return; }
    if (!node || typeof node !== "object" || !node.props) return;
    const p = node.props;
    renewed = renewed || renews(p.modifiers);
    if (!renewed) { walk(p.children, false, false); return; }
    const height = p.testID === "plugins.management.identity" ? heights.identity
      : p.testID === "plugins.management.list" ? heights.visible : root ? heights.innerContent ?? heights.content : other;
    const y = root ? contentTop : p.testID === "plugins.management.identity" ? contentTop + 8 : 0;
    if (typeof p.onLayout === "function") calls.push(() => p.onLayout({ nativeEvent: { layout: { height } } }));
    if (p.testID === "plugins.management.list" && typeof p.onContentSizeChange === "function" && heights.content > 0)
      calls.push(() => p.onContentSizeChange(390, heights.content));
    for (const modifier of Array.isArray(p.modifiers) ? p.modifiers : [])
      if (modifier?.onGeometryChange && !(root && heights.content <= 0 && heights.innerContent === undefined))
        calls.push(() => modifier.onGeometryChange({ x: 0, y, width: 390, height }));
    walk(p.children, false, renewed);
  };
  if (sheet.nativeContentModifiers) {
    // iOS: the list's own frame, its content root, then the footer.
    const listRenewed = renews(sheet.nativeContentModifiers);
    for (const modifier of listRenewed ? sheet.nativeContentModifiers : []) {
      if (modifier?.onGeometryChange) calls.push(() => modifier.onGeometryChange({ x: 0, y: listTop, width: 390, height: heights.visible }));
      if (modifier?.scrollGeometry && heights.content > 0)
        calls.push(() => modifier.scrollGeometry({ contentOffsetY: 0, containerHeight: heights.visible, contentHeight: heights.content }));
    }
    walk(sheet.children, true, listRenewed);
    walk(sheet.footer);
  } else walk(sheet.children);
  for (const call of calls) act(call);
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
    originSource: { kind: "git", repository: "github.com/acme/plugins" },
    facts: { kind: "update", ghostId: "plugin-id", name: "Plugin", version: "2", previousVersion: "1", unchangedCount: 2, builtinOauthClientChanged: true,
      added: [{ key: "node", kind: "node", labelKey: "nodeRuntime", detailKey: "nodeRuntimeDetail", detail: "Full local access risk" }],
      removed: [{ key: "network", kind: "network", labelKey: "networkHost", detail: "Removed host access" }] },
  } } } as any;
  const controller = { getState: () => state, answer: vi.fn() } as any;
  const props = { state, controller, active: true, deviceName: "Mac" };
  const { container, rerender } = mount(PluginManagementConfirmation, props);
  expect(bridge.props.get("plugins.managementConfirmation").visible).toBe(true);
  // The custom market name is interpolated into the source line (pluginManagement.test.ts checks the text).
  for (const fact of ["Plugin · v2", "plugin-id", "plugins.notice.consentSource.customMarket", "Full local access risk", "Removed host access", "plugins.management.permissions.nodeRuntimeDetail", "plugins.management.oauthChanged"]) expect(container.textContent).toContain(fact);
  // Reviewed first (maintainer review 19:34), so only the inactive guard can stop the press below.
  reviewIOS();
  const allow = bridge.props.get("plugins.management.allow").onPress;
  act(() => allow());
  expect(controller.answer, "control: active and reviewed, Allow answers").toHaveBeenCalledWith(true);
  controller.answer.mockClear();
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
  // The main button: on iOS "Review source and permissions" first (maintainer review 19:34), then Allow, in the same style.
  const allow = bridge.props.get("plugins.management.review");
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


// Dispatcher P-2 (iOS sixth reshoot): at AX5 the notice's "View" sat off screen or under the detail's task buttons, so the
// operation list could not be opened. A notice with `onPress` is one native button: a tap anywhere opens it, and its
// action shows as a label inside (no button within a button). Without it the notice is unchanged. Tier: unit/jsdom.
it("makes the whole notice one button when it opens something, with its action as a label inside", () => {
  const onPress = vi.fn();
  const { container } = mount(PluginNativeNotice, { testID: "holder", title: "Another operation is under way", onPress,
    actions: [{ label: "View", testID: "holder.view", onPress }] });
  const whole = bridge.props.get("holder");
  expect(container.querySelector('[data-testid="holder"]')?.getAttribute("data-native")).toBe("Button");
  expect(container.querySelector('[data-testid="holder"] [data-native="Button"]')).toBeNull();
  expect(container.querySelector('[data-testid="holder.view"]')?.textContent).toBe("View");
  act(() => whole.onPress());
  expect(onPress).toHaveBeenCalledOnce();
});

// Dispatcher U-1 (iOS eighth reshoot): at AX5 a tap at the left of the directory's notice row, under its icon, did
// nothing; the text and the right side opened the list. A plain SwiftUI button hit-tests only what it draws, and the
// compact notice draws no background. Its label now takes taps over its whole frame (padding included): the content
// shape comes after its padding and frame. Failed on c6efda5691 (no content shape). The tap itself is verified on a
// device. Tier: unit/jsdom.
it.each([true, false])("a notice that opens something takes taps over its whole row (compact: %s)", (compact) => {
  mount(PluginNativeNotice, { testID: "holder", title: "Another operation is under way", compact, onPress: vi.fn(),
    actions: [{ label: "View", testID: "holder.view", onPress: vi.fn() }] });
  const modifiers: any[] = bridge.props.get("holder.label").modifiers;
  const at = (name: string) => modifiers.findIndex((modifier) => modifier && name in modifier);
  expect(modifiers).toContainEqual({ contentShape: "rectangle" });
  expect(at("contentShape")).toBeGreaterThan(at("frame"));
  expect(at("contentShape")).toBeGreaterThan(at("padding"));
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
    // The sheet asks the controller whether this consent can be allowed (pluginConsentAllowance, dispatcher O-4); this
    // stand-in decides it from `state.expectedConsent` the same way the controller does.
    const consentAllowance = () => pluginConsentAllowance(state.expectedConsent ?? null, declaredPluginConsent(state.receipt.consent, "host"));
    return { state, controller: { getState: () => state, answer: vi.fn(), consentAllowance } as any, active: true, deviceName: "Mac" };
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
  it("iOS: a consent that turns reject-only after it was reviewed never answers Allow (a press before the native disabled state)", () => {
    const chosen = { kind: "local" as const, sourceId: "SourceA_0123456789abcd" };
    const p = sheetProps({ originSource: chosen }, installFacts);
    const expected = { kind: "install", deviceId: "host", pluginId: "custom:Acme/runner", ghostId: "runner", version: "1",
      releaseId: "runner@1", sourceType: "local-market", source: chosen };
    p.state.expectedConsent = expected;
    const { rerender } = mount(PluginManagementConfirmation, p);
    reviewIOS();
    expect(allowAvailable(), "reviewed: Allow is offered").toBe(true);
    // The same consent can no longer be allowed here (another source than the one chosen).
    p.state.expectedConsent = { ...expected, source: { kind: "local", sourceId: "SourceB_0123456789abcd" } };
    rerender({ ...p });
    act(() => bridge.props.get("plugins.management.allow").onPress());
    expect(p.controller.answer).not.toHaveBeenCalled();
    act(() => bridge.props.get("plugins.management.reject").onPress());
    expect(p.controller.answer).toHaveBeenCalledWith(false);
  });
  // Maintainer review 11:45: while an answer to this consent is in flight or written (answerHeld), neither button can be
  // tapped, so one consent request never gets two answers; both come back once it is known the answer was not written.
  it.each([["iOS", PluginManagementConfirmation], ["Android", AndroidManagementConfirmation]] as const)(
    "%s keeps both answers unavailable while an answer to this consent is held", (_platform, Sheet) => {
      const p = sheetProps({ origin: "market" }, installFacts);
      p.state.answerHeld = "request";
      mount(Sheet, p);
      // The main button: "Review source and permissions" first on both (maintainer reviews 19:34, 08:37).
      const main = "plugins.management.review";
      expect(disabled(main)).toBe(true);
      expect(disabled("plugins.management.reject")).toBe(true);
      p.state.answerHeld = null;
      mount(Sheet, p);
      expect(disabled(main)).toBe(false);
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
      const chosen = { kind: "local" as const, sourceId: "SourceA_0123456789abcd" };
      const p = sheetProps({ originSource: { kind: "local", sourceId: "SourceB_0123456789abcd" } }, installFacts);
      p.state.expectedConsent = { kind: "install", deviceId: "host", pluginId: "custom:Acme/runner", ghostId: "runner", version: "1",
        releaseId: "runner@1", sourceType: "local-market", source: chosen };
      const { container } = mount(Sheet, p);
      expect(container.textContent).toContain("plugins.notice.consentSource.sourceChanged");
      expect(disabled("plugins.management.allow")).toBe(true);
      expect(disabled("plugins.management.reject")).toBe(false);
    });
  it.each([["iOS", PluginManagementConfirmation], ["Android", AndroidManagementConfirmation]] as const)(
    "%s allows a first install whose repository the Host named", (_platform, Sheet) => {
      const { container } = mount(Sheet, sheetProps({ originSource: { kind: "git", repository: "github.com/acme/plugins" } }, installFacts));
      expect(container.textContent).not.toContain("repositoryMissing");
      expect(disabled("plugins.management.review")).toBe(false);
    });
  const legacyItem = { pluginId: "custom:Acme/runner", ghostId: "runner", name: "Runner", description: "From Acme",
    scope: "public", sourceType: "git-market", sourceMarketName: "Acme", installState: "not-installed", icon: null,
    version: "1", releaseId: "runner@1" };
  it("iOS market row offers no install for it and says to install on the computer", () => {
    const market = marketModel({ items: [legacyItem], rowState: () => ({ kind: "sourceUnverified" }) });
    const { container } = mount(PluginDirectoryView, { ...directory(), market, segment: "market" });
    expect(disabled("plugins.market.install.custom:Acme/runner")).toBe(true);
    expect(container.textContent).toContain("plugins.market.sourceUnverifiedShort");
    // Dispatcher P-4: the note takes every line it needs (German needs four at 1.3× beside Install on a small phone).
    const line = bridge.props.get("plugins.market.line.custom:Acme/runner");
    expect(line.modifiers.some((modifier: any) => modifier && "lineLimit" in modifier)).toBe(false);
    expect(line.modifiers).toContainEqual({ fixedSize: { horizontal: false, vertical: true } });
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

// Dispatcher S-1 / T (seventh reshoots): after a failed market detail read, Retry recovered on iOS but not, as captured,
// on Android (the capture script had tapped the banner's text, which also contains "Retry"; Android eighth reshoot).
// Both views' own Retry control reads the detail again (the same market.retryDetail; the page test covers what the read
// then shows), and it is unavailable only while that computer is offline. Existing behaviour on 5983ba71dd for both
// platforms. Tier: unit/jsdom.
it.each([["iOS", MarketDetailView], ["Android", AndroidMarketDetailView]] as const)(
  "%s market detail's own Retry reads the failed detail again", (_platform, Detail) => {
    const item = { pluginId: "market/demo", ghostId: "demo", name: "Market Demo", description: "From the market",
      publisherKind: "official", scope: "public", sourceType: "server", installState: "not-installed", icon: null };
    const market = marketModel();
    const failed = { item, target: row.host, loading: false, failed: true };
    const { rerender } = mount(Detail, { market, detail: failed });
    const retry = () => bridge.props.get("plugins.market.detailRetry");
    // Android: the Pressable's `disabled`; iOS: the SwiftUI button's `disabled` modifier.
    const unavailable = () => !!retry().disabled || (retry().modifiers ?? []).some((m: any) => m?.disabled === true);
    expect(unavailable()).toBe(false);
    act(() => retry().onPress());
    expect(market.retryDetail).toHaveBeenCalledOnce();
    rerender({ market: { ...market, online: false }, detail: failed });
    expect(unavailable()).toBe(true);
  });

// Dispatcher P-4 (iOS sixth reshoot): the market detail's source label beside the name showed "Tea…" and, at AX5, one
// letter per line. It never truncates or wraps; once it would take more than 40% of the title column it goes under the
// name, as in the market rows. Minimal failing input: a 120 pt label in a 200 pt column. Tier: unit/jsdom.
it("puts the iOS market detail's source label under the name when it would squeeze it, never cut", () => {
  const market = marketModel({ rowState: () => ({ kind: "idle" }) });
  const item = { ...marketModel().items[0], pluginId: "org:Team/sheets", name: "Demo Team Sheets", scope: "organization" };
  mount(MarketDetailView, { market, detail: { item, target: row.host, loading: false, failed: false } });
  const badge = bridge.props.get("plugins.market.detailBadge");
  expect(badge.modifiers).toContainEqual({ lineLimit: 1 });
  expect(badge.modifiers).toContainEqual({ fixedSize: { horizontal: true, vertical: false } });
  expect(bridge.props.has("plugins.market.detailTitleRow")).toBe(true);
  const widthOf = (modifiers: any[]) => modifiers.find((m: any) => m?.onGeometryChange).onGeometryChange;
  act(() => widthOf(badge.modifiers)({ width: 120, height: 20 }));
  act(() => widthOf(bridge.props.get("plugins.market.detailTitle").modifiers)({ width: 200, height: 60 }));
  expect(bridge.props.has("plugins.market.detailTitleStacked")).toBe(true);
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
    // Beside the main button (on iOS "Review source and permissions" first: maintainer review 19:34).
    expect(pinned.parentElement!.querySelector('[data-testid="plugins.management.review"]')).not.toBeNull();
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
  it.each(cases)("Android shows a bounded summary of %s in the scrolled list, ahead of the full details", (_name, facts, summary, details) => {
    const { container } = mount(AndroidManagementConfirmation, props(facts));
    const list = container.querySelector('[data-testid="plugins.management.list"]')!;
    const pinned = list.querySelector('[data-testid="plugins.management.highRisk"]')!;
    for (const line of summary) expect(pinned.textContent).toContain(line);
    for (const detail of details) {
      expect(pinned.textContent).not.toContain(detail);
      expect(list.textContent).toContain(detail);
    }
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
  it("Android separates the summary from the block above it and titles it like the list", () => {
    mount(AndroidManagementConfirmation, props(installOf([errand, background])));
    const pinned = bridge.props.get("plugins.management.highRisk");
    const style = Object.assign({}, ...[pinned.style].flat(3).filter(Boolean));
    expect(style).toMatchObject({ borderTopColor: palettes.light.border });
    expect("borderTopWidth" in style).toBe(true);
    const title = (Array.isArray(pinned.children) ? pinned.children.flat() : [pinned.children]).filter(Boolean)[0];
    expect(title.props.style).toMatchObject({ fontSize: 15, fontWeight: "600" });
  });
  // iOS layout re-checks (3587f6ca, accessibility-large and English short screen): capped rows cut the end
  // of every line, and an unbounded summary pushed the computer and source out of view. Every line is shown in full,
  // in a fixed class order, and scrolls inside a bound computed from the measured identity block, heading and buttons.
  const resident = { key: "node:resident", kind: "node", labelKey: "nodeResident", detailKey: "nodeResidentDetail" };
  const allFive = installOf([resident, secret, node, background, errand]);
  const fiveLines = ["plugins.management.permissions.nodeRuntime", "plugins.management.permissions.nodeSecretOne",
    "plugins.management.permissions.nodeResident", "plugins.management.permissions.agentBackground", "plugins.management.permissions.agentErrand"];
  const geometry = (id: string, height: number) => act(() => {
    bridge.props.get(id).modifiers.find((m: any) => m.onGeometryChange).onGeometryChange({ width: 390, height });
  });
  /* 测试价值（维护者 16:48 复审；iOS 两档排版）
   * - 生产入口与可观察结果：iOS 真实确认面板组件；观察渲染树里滚动容器的个数、摘要所在位置、分给摘要的高度。
   * - 依据：放得下「身份块 + 摘要标题 + 前两项」时摘要固定在按钮上方；放不下时只有一个滚动区（身份块 → 全部摘要 →
   *   完整说明），按钮固定在外；「继续滑动」提示浮在滚动区边缘，不占正文高度。
   * - 缺口：矮屏大字号时两条提示把摘要压到 0 高度，允许按钮仍可用。
   * - 最小失败输入：可分配 100、身份块 384、标题 40、五项 [36, 48, 40, 40, 48]。tier: unit。
   */
  const findIn = (node: any, testID: string): boolean => {
    if (!node || typeof node !== "object") return false;
    if (Array.isArray(node)) return node.some((child) => findIn(child, testID));
    if (node.props?.testID === testID) return true;
    return findIn(node.props?.children, testID);
  };
  const scrollCount = (node: any): number => {
    if (!node || typeof node !== "object") return 0;
    if (Array.isArray(node)) return node.reduce((sum: number, child: any) => sum + scrollCount(child), 0);
    const self = node.type?.name === "ScrollView" || node.props?.["data-native"] === "ScrollView" ? 1 : 0;
    return self + scrollCount(node.props?.children);
  };
  const reviewLines = [36, 48, 40, 40, 48];
  it("iOS pins the summary above the buttons when the identity block and two items fit", () => {
    bridge.fontScale = 1;
    mount(PluginManagementConfirmation, props(allFive));
    const scroll = () => bridge.props.get("plugins.management.highRiskScroll");
    const lines = () => (Array.isArray(scroll().children.props.children) ? scroll().children.props.children : [scroll().children.props.children]).flat();
    expect(lines().map((line: any) => line.props.children)).toEqual(fiveLines);
    for (const line of lines()) expect(line.props.modifiers.some((m: any) => "lineLimit" in m)).toBe(false);
    expect(bridge.props.get("plugins.management.highRiskTitle").modifiers.some((m: any) => "lineLimit" in m)).toBe(false);
    expect(scroll().modifiers).toContainEqual({ scrollIndicators: "visible" });
    const header = Math.ceil(64 * 1) + 10, chrome = 8 * 2 + 8 * 3 + 4 + 12;
    geometry("plugins.management.identity", 200);
    geometry("plugins.management.actions", 44);
    geometry("plugins.management.highRiskTitle", 20);
    lines().forEach((line: any) => act(() => line.props.modifiers.find((m: any) => m.onGeometryChange).onGeometryChange({ width: 300, height: 20 })));
    const plan = planConsentSheet({ available: 844 - header - chrome - 44, identity: 200, heading: 20, lines: [20, 20, 20, 20, 20], gap: 4 });
    expect(plan).toEqual({ mode: "regular", summaryLines: 5 * 20 + 4 * 4, clipped: false, guaranteed: 2 * 20 + 4 });
    expect(scroll().modifiers.find((m: any) => m.frame)?.frame.height).toBe(plan.mode === "regular" && plan.summaryLines);
    // Pinned: in the footer, with the buttons; no "keep scrolling" text takes room on iOS.
    const footer = bridge.props.get("plugins.managementConfirmation").footer;
    expect(findIn(footer, "plugins.management.highRisk")).toBe(true);
    expect(findIn(footer, "plugins.management.actions")).toBe(true);
    expect(bridge.props.has("plugins.management.listMore") || bridge.props.has("plugins.management.highRiskMore")).toBe(false);
  });
  it("iOS puts everything in one scrolled list above fixed buttons when they do not fit (maintainer's numbers)", () => {
    bridge.fontScale = 2.4;
    const { container } = mount(PluginManagementConfirmation, props(allFive));
    const header = Math.ceil(64 * 2) + 10, chrome = 8 * 2 + 8 * 3 + 4 + 12;
    // The buttons take what makes 100 pt of room for the rest.
    geometry("plugins.management.actions", 844 - header - chrome - 100);
    geometry("plugins.management.identity", 384);
    geometry("plugins.management.highRiskTitle", 40);
    const items = () => [...bridge.props.values()].filter((p: any) => fiveLines.includes(p.children));
    items().forEach((item: any, index: number) => act(() => item.modifiers.find((m: any) => m.onGeometryChange).onGeometryChange({ width: 300, height: reviewLines[index] })));
    const sheet = bridge.props.get("plugins.managementConfirmation");
    // Compact: the summary is in the list (children), not in the footer, and it has no scroll area of its own.
    expect(findIn(sheet.footer, "plugins.management.highRisk")).toBe(false);
    expect(findIn(sheet.children, "plugins.management.highRisk")).toBe(true);
    expect(findIn(sheet.footer, "plugins.management.actions")).toBe(true);
    expect(findIn(sheet.children, "plugins.management.highRiskScroll") || findIn(sheet.footer, "plugins.management.highRiskScroll")).toBe(false);
    // The source line and every high-risk item are there to read; the identity block comes first.
    expect(container.textContent).toContain("plugins.notice.consentSource.market");
    for (const line of fiveLines) expect(container.textContent).toContain(line);
    expect(findIn(sheet.children, "plugins.management.identity")).toBe(true);
  });
  /* 测试价值（维护者 16:35 第 2 条：iOS 紧凑档可以在关键授权信息出现前允许）
   * - 生产入口与可观察结果：两端真实确认面板组件；观察按钮（「查看来源和权限」/「允许」）、点下后滚动区内容的先后、
   *   回答是否发出。
   * - 依据：紧凑档的「允许」放在明确的查看步骤之后；查看后的列表从来源与本次高风险摘要开始，并回到顶部
   *   （iOS 换一个视图 id，Android scrollTo 0）。读屏用户按按钮顺序即可完成，不靠滚动位置。
   * - 最小失败输入：维护者的数字（可分配 100、身份块 384、标题 40、五项）下改前「允许」直接可点。tier: unit。
   */
  const customProps = (facts: any) => { const state = { outcome: "confirmation", online: true, busy: false, receipt: { consent: {
      requestId: "request", origin: "custom-market", originLabel: "Acme", initiator: "user",
      originSource: { kind: "git", repository: "github.com/acme/plugins" }, facts } } } as any;
    return { state, controller: { getState: () => state, answer: vi.fn() } as any, active: true, deviceName: "Mac" }; };
  const order = (root: HTMLElement) => [...root.querySelectorAll("[data-testid]")].map((node) => node.getAttribute("data-testid"));
  it.each([["the Cindy market", props], ["a custom market", customProps]] as const)(
    "iOS compact: Allow only after \"Review source and permissions\"; the reviewed list opens with the source and the summary (%s)", (_name, build) => {
      bridge.fontScale = 2.4;
      const sheetProps = build(allFive);
      const { container } = mount(PluginManagementConfirmation, sheetProps);
      const header = Math.ceil(64 * 2) + 10, chrome = 8 * 2 + 8 * 3 + 4 + 12;
      geometry("plugins.management.actions", 844 - header - chrome - 100);
      geometry("plugins.management.identity", 384);
      geometry("plugins.management.highRiskTitle", 40);
      const items = () => [...bridge.props.values()].filter((p: any) => fiveLines.includes(p.children));
      items().forEach((item: any, index: number) => act(() => item.modifiers.find((m: any) => m.onGeometryChange).onGeometryChange({ width: 300, height: reviewLines[index] })));
      const shown = (id: string) => container.querySelector(`[data-testid="${id}"]`) !== null;
      expect({ allow: allowAvailable(), review: shown("plugins.management.review") }).toEqual({ allow: false, review: true });
      reviewIOS();
      expect(sheetProps.controller.answer).not.toHaveBeenCalled();
      const ids = order(container);
      expect(ids.indexOf("plugins.management.reviewLead")).toBeGreaterThanOrEqual(0);
      expect(ids.indexOf("plugins.management.reviewLead")).toBeLessThan(ids.indexOf("plugins.management.highRisk"));
      expect(ids.indexOf("plugins.management.highRisk")).toBeLessThan(ids.indexOf("plugins.management.identity"));
      const lead = container.querySelector('[data-testid="plugins.management.reviewLead"]')!.textContent!;
      expect(lead).toContain(build === customProps ? "plugins.notice.consentSource.repository" : "plugins.notice.consentSource.market");
      // The reviewed list is a new view, so it opens at its top.
      expect(bridge.props.get("plugins.managementConfirmation").nativeContentModifiers).toContainEqual({ id: `plugins.management.reviewed:${layoutKeyOf("request")}` });
      act(() => bridge.props.get("plugins.management.allow").onPress());
      expect(sheetProps.controller.answer).toHaveBeenCalledWith(true);
    });
  it.each([["the Cindy market", props], ["a custom market", customProps]] as const)(
    "Android: Allow only after \"Review source and permissions\"; the reviewed list opens with the source and the summary (%s)", (_name, build) => {
      bridge.fontScale = 2;
      const sheetProps = build(allFive);
      const { container } = mount(AndroidManagementConfirmation, sheetProps);
      const shown = (id: string) => container.querySelector(`[data-testid="${id}"]`) !== null;
      expect({ allow: allowAvailable(), review: shown("plugins.management.review") }).toEqual({ allow: false, review: true });
      act(() => bridge.props.get("plugins.management.review").onPress());
      expect(sheetProps.controller.answer).not.toHaveBeenCalled();
      const ids = order(container);
      expect(ids.indexOf("plugins.management.reviewLead")).toBeGreaterThanOrEqual(0);
      expect(ids.indexOf("plugins.management.reviewLead")).toBeLessThan(ids.indexOf("plugins.management.highRisk"));
      expect(ids.indexOf("plugins.management.highRisk")).toBeLessThan(ids.indexOf("plugins.management.identity"));
      const lead = container.querySelector('[data-testid="plugins.management.reviewLead"]')!.textContent!;
      expect(lead).toContain(build === customProps ? "plugins.notice.consentSource.repository" : "plugins.notice.consentSource.market");
      act(() => bridge.props.get("plugins.management.allow").onPress());
      expect(sheetProps.controller.answer).toHaveBeenCalledWith(true);
    });
  /* 测试价值（调度 2026-11-26：两端一致）
   * - 生产入口与可观察结果：Android 真实确认面板组件；观察列表滚动区收到的 scrollTo。
   * - 依据：同一项操作里接连出现第二个确认、面板一直开着时，列表要从顶部开始（iOS 由新的视图 id 重置）。
   * - 最小失败输入：查看并允许第一个确认后，换成 requestId 不同的第二个确认；改前没有第二次回顶部。tier: unit。
   */
  it("Android: a second consent in the open sheet starts at the top of the list again", () => {
    bridge.fontScale = 1;
    const first = props(allFive);
    const { rerender } = mount(AndroidManagementConfirmation, first);
    const toTop = () => bridge.scrolledTo.filter(([id, to]) => id === "plugins.management.list" && (to as any)?.y === 0).length;
    const before = toTop();
    const second = props(allFive);
    second.state.receipt.consent.requestId = "request-2";
    rerender(second);
    expect(toTop()).toBe(before + 1);
    rerender(second);
    expect(toTop(), "the same consent drawn again does not move the list").toBe(before + 1);
  });
  /* 测试价值（维护者 08:37：Android 常规档的读数来自不同的 onLayout 事件，身份块和内容先到、视区后到时用混合尺寸直接允许；
   * 维护者 19:34：iOS 旧键迟到、位置先于偏移）
   * - 生产入口与可观察结果：两端真实确认面板组件；初开后按任意读数顺序报尺寸，按下初开时与当时的「允许」、主按钮。
   * - 依据：两端一律先查看：没有任何布局读数能让「允许」作答（JS 无法证明几个读数属于同一次原生布局）。
   * - 最小失败输入：Android 默认字号，身份块与内容先到、视区后到（同宽缩高），或窗口尺寸通知晚于布局；6b4814d12a 上读数能确认
   *   常规档时按「允许」作答。tier: unit。
   */
  const readOrders: Record<string, (rerender: (p: any) => void, p: any) => void> = {
    "nothing reported yet": () => {},
    "the identity block and the content before the viewport": () => {
      layOutSheet({ identity: 100, visible: 0, content: 400 });
      layOutSheet({ identity: 100, visible: 2000, content: 400 });
    },
    "the same width, a shorter height": () => {
      layOutSheet({ identity: 100, visible: 2000, content: 400 });
      layOutSheet({ identity: 100, visible: 230, content: 1200 });
    },
    "the layout before the window's size notice": (rerender, p) => {
      layOutSheet({ identity: 100, visible: 2000, content: 400 });
      bridge.width = 844; bridge.height = 390; rerender({ ...p });
      layOutSheet({ identity: 100, visible: 2000, content: 400 });
    },
  };
  for (const [platform, Sheet] of [["iOS", PluginManagementConfirmation], ["Android", AndroidManagementConfirmation]] as const)
    for (const [order, report] of Object.entries(readOrders))
      it(`${platform}, default text size, ${order}: no press on opening answers; the main button is "Review source and permissions"`, () => {
        bridge.fontScale = 1;
        const p = props(allFive);
        const { container, rerender } = mount(Sheet, p);
        const main = () => ({ review: container.querySelector('[data-testid="plugins.management.review"]') !== null, allow: allowAvailable() });
        expect(main(), "on opening, before anything is reported").toEqual({ review: true, allow: false });
        // The readings arrive first, in this order; then the taps: the callback from opening, and the one drawn now.
        const firstAllow = bridge.props.get("plugins.management.allow").onPress;
        report(rerender, p);
        act(() => firstAllow());
        act(() => bridge.props.get("plugins.management.allow").onPress());
        expect(p.controller.answer).not.toHaveBeenCalled();
        expect(main()).toEqual({ review: true, allow: false });
      });
  /* 测试价值（维护者 19:34：竖屏仍可能在来源未完整显示时作答；iOS 复拍 811ac92adc / b098aa578f / b2df9a9469：横屏直开官方来源，
   * 来源在渐隐里仍能作答）
   * - 生产入口与可观察结果：iOS 真实确认面板组件；首次展示时的主按钮，按下主按钮（含同一帧里连按）是否写出 answer(true)，
   *   查看后列表的先后与「允许」是否作答。
   * - 依据：iOS 的几何回调是各视图各自的异步事件（全局 frame、iOS 18 起才有的滚动几何），没有能把 frame 和偏移绑到同一次
   *   原生布局的标记，纠正回报可能在任意时刻之后才到；拿不到一致样本就从首次展示起提供查看。所以 iOS 一律先「查看来源和
   *   权限」，「允许」只在这次确认被查看过之后作答；布局读数只决定排版，不放行。
   * - 缺口：d696b656c2 上竖屏按读数判常规档，旧键迟到、位置先于偏移、纠正晚于 150 ms 时按「允许」写出。
   * - 最小失败输入：可视 270、渐隐 24、身份块 250（真实下缘距列表顶 258，应先查看），读数为 218（旧键迟到 / 位置先于偏移）；
   *   纠正（258）在按下之后才到；iOS 17（没有滚动几何）；以及横屏直开与转屏（视区 132.5、内容 1894.5、列表顶 52）。
   *   d696b656c2 上竖屏几格首屏是「允许」并写出。tier: unit。
   */
  const geometryOf = (id: string) => bridge.props.get(id).modifiers.find((m: any) => m.onGeometryChange).onGeometryChange;
  const scrollGeometryOf = () => bridge.props.get("plugins.managementConfirmation").nativeContentModifiers.find((m: any) => m.scrollGeometry)?.scrollGeometry;
  const reports: Record<string, (rerender: (p: any) => void, p: any) => void> = {
    "on first mount": () => {},
    // Every size in, reading that the whole identity block fits (8 + 210 + 24 ≤ 270).
    "with every size in, reading that it fits": () => layOutSheet({ identity: 210, visible: 270, content: 1200 }),
    "with a late report from the previous layout key (reading 218 where the truth is 258)": (rerender, p) => {
      layOutSheet({ identity: 250, visible: 270, content: 1200 });
      const late = geometryOf("plugins.management.identity");
      bridge.fontScale = 1.1; rerender({ ...p });
      layOutSheet({ identity: 250, visible: 270, content: 1200 });
      act(() => late({ x: 0, y: 68, width: 390, height: 250 }));
    },
    "with a scrolled frame before its offset": () => {
      layOutSheet({ identity: 250, visible: 270, content: 1200 });
      act(() => geometryOf("plugins.management.identity")({ x: 0, y: 68, width: 390, height: 250 }));
      act(() => scrollGeometryOf()({ contentOffsetY: 40, containerHeight: 270, contentHeight: 1200 }));
    },
    "with the offset before the scrolled frame": () => {
      layOutSheet({ identity: 250, visible: 270, content: 1200 });
      act(() => scrollGeometryOf()({ contentOffsetY: 40, containerHeight: 270, contentHeight: 1200 }));
      act(() => geometryOf("plugins.management.identity")({ x: 0, y: 68, width: 390, height: 250 }));
    },
    "on iOS 17 (no scroll geometry reported)": () => layOutSheet({ identity: 210, visible: 270, content: 0, innerContent: 1200 }),
    "opened in landscape (the official source under the fade)": (rerender, p) => {
      bridge.width = 667; bridge.height = 375; rerender({ ...p });
      layOutSheet({ identity: 96, visible: 132.5, content: 1894.5, listTop: 52 });
    },
    "opened in portrait, turned to landscape": (rerender, p) => {
      layOutSheet({ identity: 120, visible: 404.5, content: 1894.5 });
      const before = sheetViewIds();
      bridge.width = 667; bridge.height = 375; rerender({ ...p });
      layOutSheet({ identity: 40, visible: 132.5, content: 1894.5, listTop: 52 }, before);
    },
  };
  for (const build of [props, customProps])
    for (const [when, report] of Object.entries(reports))
      it(`iOS (${build === props ? "Cindy market" : "custom market"}) ${when}: the main button is "Review source and permissions", pressing it (twice in one frame too, and again at its place after the redraw) writes nothing; Allow, its own control, answers only after it`, () => {
        bridge.fontScale = 1;
        const p = build(allFive);
        const { container, rerender } = mount(PluginManagementConfirmation, p);
        const shown = (id: string) => container.querySelector(`[data-testid="${id}"]`) !== null;
        expect({ review: shown("plugins.management.review"), allow: allowAvailable() }, "from the first display").toEqual({ review: true, allow: false });
        report(rerender, p);
        // The correction arrives after any wait: nothing measured lets Allow answer.
        expect({ review: shown("plugins.management.review"), allow: allowAvailable() }).toEqual({ review: true, allow: false });
        const press = bridge.props.get("plugins.management.review").onPress;
        act(() => { press(); press(); });
        expect(p.controller.answer, "review only shows the source and permissions first").not.toHaveBeenCalled();
        // Maintainer review 06:44: the redrawn callback at the same place (the review button, now reviewed) answers nothing.
        act(() => bridge.props.get("plugins.management.reviewed").onPress());
        expect(p.controller.answer, "the review button's place after the redraw").not.toHaveBeenCalled();
        // Reviewed: the source and the high-risk summary come first, in a new list at its top; then Allow answers.
        const ids = order(container);
        expect(ids.indexOf("plugins.management.reviewLead")).toBeGreaterThanOrEqual(0);
        expect(ids.indexOf("plugins.management.reviewLead")).toBeLessThan(ids.indexOf("plugins.management.highRisk"));
        act(() => bridge.props.get("plugins.management.allow").onPress());
        expect(p.controller.answer).toHaveBeenCalledWith(true);
      });
  /* 测试价值（维护者 06:44：首击「查看」触发重绘后，立即调用原位置的新回调会作答；两端紧凑档都原位切换按钮）
   * - 生产入口与可观察结果：两端真实确认面板组件；按钮区的结构（哪个控件在哪一行），在原位置跨重绘连点、再点「允许」时
   *   是否写出 answer(true)、写出几次。
   * - 依据：「查看」与「允许」是两个控件，「允许」单独一行在「拒绝 | 查看」那一行上方；查看前后按钮区结构不变（只换可用状态），
   *   所以原位置的热区查看后仍是那个按钮（不可用），与「允许」不重叠；「拒绝」不动。只靠布局规则，不靠测量或计时。
   * - 最小失败输入：查看后在原位置用新回调再按一下；30bcf99f59 上写出允许。tier: unit。
   */
  const footerShape = (root: HTMLElement) => {
    const actions = root.querySelector('[data-testid="plugins.management.actions"]')!;
    return [...actions.querySelectorAll("[data-testid]")].map((node) => [node.getAttribute("data-testid"),
      node.parentElement?.closest("[data-testid]")?.getAttribute("data-testid")]);
  };
  const layouts = {
    "side by side": { width: 390, height: 844, fontScale: 1 },
    "stacked (large text)": { width: 375, height: 667, fontScale: 2 },
    "stacked (AX5)": { width: 375, height: 667, fontScale: 3.1 },
    "landscape, large text": { width: 844, height: 390, fontScale: 2 },
  } as const;
  for (const [platform, Sheet] of [["iOS", PluginManagementConfirmation], ["Android", AndroidManagementConfirmation]] as const)
    for (const [name, window] of Object.entries(layouts))
      it(`${platform} ${name}: taps at the review button's place, across redraws, stay pending; Allow is its own row above and answers once`, () => {
        Object.assign(bridge, window);
        const state = consentState(allFive);
        const answer = vi.fn(() => { state.answerHeld = state.receipt.consent.requestId; });
        const p = { state, controller: { getState: () => state, answer } as any, active: true, deviceName: "Mac" };
        const { container } = mount(Sheet, p);
        const slot = () => {
          const row = container.querySelector('[data-testid="plugins.management.answerRow"]')!;
          return [...row.children].map((node) => node.getAttribute("data-testid")!).find((id) => id !== "plugins.management.reject")!;
        };
        const press = (id: string) => act(() => bridge.props.get(id).onPress());
        expect(slot()).toBe("plugins.management.review");
        const before = footerShape(container);
        // Allow: its own control, outside the row of Reject and Review, and unavailable before the review.
        expect(before.find(([id]) => id === "plugins.management.allow")?.[1]).toBe("plugins.management.actions");
        expect(allowAvailable()).toBe(false);
        press("plugins.management.allow");
        expect(answer, "Allow before the review").not.toHaveBeenCalled();
        // The first tap reviews; every later tap at that place, each through the redrawn (new) callback, does nothing.
        press(slot());
        for (let tap = 0; tap < 3; tap++) press(slot());
        expect(slot()).toBe("plugins.management.reviewed");
        expect(answer, "taps at the review button's place after the redraw").not.toHaveBeenCalled();
        expect(state.outcome).toBe("confirmation");
        // The same controls in the same places: only which one is available changed (no layout moves them).
        expect(footerShape(container)).toEqual(before.map(([id, parent]) => [id === "plugins.management.review" ? "plugins.management.reviewed" : id, parent]));
        // Reject stayed where it was.
        expect(footerShape(container).findIndex(([id]) => id === "plugins.management.reject")).toBe(before.findIndex(([id]) => id === "plugins.management.reject"));
        // The other place: answers, once.
        expect(allowAvailable()).toBe(true);
        press("plugins.management.allow");
        press("plugins.management.allow");
        expect(answer).toHaveBeenCalledTimes(1);
        expect(answer).toHaveBeenCalledWith(true);
      });
  it("Android: reviewed, then the window size changes: still reviewed, Allow answers", () => {
    bridge.fontScale = 2;
    const p = props(allFive);
    const { rerender } = mount(AndroidManagementConfirmation, p);
    act(() => bridge.props.get("plugins.management.review").onPress());
    bridge.width = 844; bridge.height = 390;
    rerender({ ...p });
    expect(allowAvailable()).toBe(true);
    act(() => bridge.props.get("plugins.management.allow").onPress());
    expect(p.controller.answer).toHaveBeenCalledWith(true);
  });
  it.each([["iOS", PluginManagementConfirmation], ["Android", AndroidManagementConfirmation]] as const)(
    "%s: a consent that can only be rejected keeps Allow unavailable before and after the review; Reject answers", (platform, Sheet) => {
      bridge.fontScale = 2; bridge.width = 375; bridge.height = 667;
      const state = { ...consentState(allFive), expectedConsent: undefined } as any;
      const answer = vi.fn();
      const allowance = () => ({ allow: false, reason: "sourceMismatch" });
      const p = { state, controller: { getState: () => state, answer, consentAllowance: allowance } as any, active: true, deviceName: "Mac" };
      const { container } = mount(Sheet, p);
      const press = (id: string) => act(() => bridge.props.get(id).onPress());
      if (container.querySelector('[data-testid="plugins.management.review"]')) press("plugins.management.review");
      for (let tap = 0; tap < 3; tap++) press("plugins.management.allow");
      expect(allowAvailable()).toBe(false);
      expect(answer).not.toHaveBeenCalledWith(true);
      press("plugins.management.reject");
      expect(answer).toHaveBeenCalledWith(false);
    });
  it("Android keeps the buttons at the sheet's bottom edge: the sheet fills its maximum, the list takes the room above them", () => {
    bridge.fontScale = 2;
    const { container } = mount(AndroidManagementConfirmation, props(allFive));
    const flat = (style: any) => Object.assign({}, ...[style].flat(3).filter(Boolean));
    expect(flat(bridge.props.get("plugins.managementConfirmation").style).height).toBe("85%");
    // The list area grows into any spare height, and the buttons are the sheet's last child.
    expect(flat(bridge.props.get("plugins.management.listArea").style).flexGrow).toBe(1);
    const sheetNode = container.querySelector('[data-testid="plugins.managementConfirmation"]')!;
    expect(sheetNode.lastElementChild?.getAttribute("data-testid")).toBe("plugins.management.actions");
  });
  it("iOS: reviewed, then turned to landscape or a larger text size: still reviewed for that consent, the reviewed list drawn anew from its top", () => {
    bridge.fontScale = 1;
    const p = props(allFive);
    const { container, rerender } = mount(PluginManagementConfirmation, p);
    reviewIOS();
    const listId = () => bridge.props.get("plugins.managementConfirmation").nativeContentModifiers.find((m: any) => "id" in m)?.id;
    const before = listId();
    bridge.width = 667; bridge.height = 375; bridge.fontScale = 1.6;
    rerender({ ...p });
    const shown = (id: string) => container.querySelector(`[data-testid="${id}"]`) !== null;
    expect({ review: shown("plugins.management.review"), allow: allowAvailable() }).toEqual({ review: false, allow: true });
    expect(listId(), "a new reviewed list, from its top (the source first)").toBe(`plugins.management.reviewed:${layoutKeyOf("request")}`);
    expect(listId()).not.toBe(before);
    act(() => bridge.props.get("plugins.management.allow").onPress());
    expect(p.controller.answer).toHaveBeenCalledWith(true);
  });
  it.each([["iOS", PluginManagementConfirmation], ["Android", AndroidManagementConfirmation]] as const)(
    "%s: a second consent arriving in the same open sheet, with the same controller, needs its own review; the first consent's Allow callback answers nothing", (_platform, Sheet) => {
      bridge.fontScale = 1;
      const state = consentState(allFive);
      const answer = vi.fn();
      const p = { state, controller: { getState: () => state, answer } as any, active: true, deviceName: "Mac" };
      const { container, rerender } = mount(Sheet, p);
      act(() => bridge.props.get("plugins.management.review").onPress());
      const lateAllow = bridge.props.get("plugins.management.allow").onPress;
      // The next consent of the same operation, in the same sheet and the same controller.
      state.receipt = { consent: { ...state.receipt.consent, requestId: "request-2" } };
      rerender({ ...p });
      const shown = (id: string) => container.querySelector(`[data-testid="${id}"]`) !== null;
      expect({ review: shown("plugins.management.review"), allow: allowAvailable() }).toEqual({ review: true, allow: false });
      act(() => lateAllow());
      expect(answer, "the first consent's Allow, pressed after the switch").not.toHaveBeenCalled();
      act(() => bridge.props.get("plugins.management.review").onPress());
      act(() => bridge.props.get("plugins.management.allow").onPress());
      expect(answer).toHaveBeenCalledTimes(1);
    });
  it("iOS: a consent reviewed does not carry over to the next one; the reviewed sheet's late Allow cannot answer it", () => {
    bridge.fontScale = 1;
    const first = props(allFive);
    const { container, rerender } = mount(PluginManagementConfirmation, first);
    reviewIOS();
    const lateAllow = bridge.props.get("plugins.management.allow").onPress;
    const second = props(allFive);
    second.state.receipt.consent.requestId = "request-2";
    rerender(second);
    const shown = (id: string) => container.querySelector(`[data-testid="${id}"]`) !== null;
    expect({ review: shown("plugins.management.review"), allow: allowAvailable() }).toEqual({ review: true, allow: false });
    // The earlier sheet's Allow, pressed after the switch: it was for the first consent.
    second.controller.getState = () => second.state;
    act(() => lateAllow());
    expect(first.controller.answer).not.toHaveBeenCalled();
    expect(second.controller.answer).not.toHaveBeenCalled();
    reviewIOS();
    act(() => bridge.props.get("plugins.management.allow").onPress());
    expect(second.controller.answer).toHaveBeenCalledWith(true);
  });
  /* 测试价值（维护者 18:20：切到下一次确认时，固定高风险摘要仍停在上一条的滚动位置）
   * - 生产入口与可观察结果：两端真实确认面板组件；Android 观察主列表是否重建（新建的滚动区从顶部开始），iOS 观察主列表与
   *   固定摘要两个滚动区的视图标识。
   * - 依据：requestId 切换时滚动区从顶部开始；同一请求的普通重绘保留阅读位置。
   * - 最小失败输入：第一份确认之后直接切到第二份；改前 iOS 两个标识不变。tier: unit。
   */
  it("Android: the next consent gets a new list; redrawing the same consent keeps it", () => {
    bridge.fontScale = 1;
    const first = props(allFive);
    const { rerender } = mount(AndroidManagementConfirmation, first);
    const mounts = () => bridge.scrollMounts.get("plugins.management.list") ?? 0;
    const list = mounts();
    rerender({ ...first });
    expect(mounts(), "the same consent redrawn").toBe(list);
    const second = props(allFive);
    second.state.receipt.consent.requestId = "request-2";
    rerender(second);
    expect(mounts()).toBe(list + 1);
  });
  it("iOS: the next consent gives the list and the pinned summary new identities; redrawing the same consent keeps them", () => {
    bridge.fontScale = 1;
    const first = props(allFive);
    const { rerender } = mount(PluginManagementConfirmation, first);
    layOutSheet({ identity: 100, visible: 2000, content: 400 });
    const ids = () => [bridge.props.get("plugins.managementConfirmation").nativeContentModifiers,
      bridge.props.get("plugins.management.highRiskScroll").modifiers].map((modifiers: any[]) => modifiers.find((m: any) => "id" in m)?.id);
    const idsOf = (requestId: string) => [`plugins.management.list:${layoutKeyOf(requestId)}`, `plugins.management.highRiskScroll:${layoutKeyOf(requestId)}`];
    expect(ids()).toEqual(idsOf("request"));
    rerender({ ...first });
    expect(ids()).toEqual(idsOf("request"));
    const second = props(allFive);
    second.state.receipt.consent.requestId = "request-2";
    rerender(second);
    layOutSheet({ identity: 100, visible: 2000, content: 400 });
    expect(ids()).toEqual(idsOf("request-2"));
  });
  it("Android puts everything in one scroll area above fixed buttons, whatever fits", () => {
    bridge.fontScale = 1;
    const { container } = mount(AndroidManagementConfirmation, props(allFive));
    // One scroll area (the list) holding the identity block and the whole summary; the buttons sit outside it.
    expect(container.querySelector('[data-testid="plugins.management.list"] [data-testid="plugins.management.highRisk"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="plugins.management.list"] [data-testid="plugins.management.identity"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="plugins.management.list"] [data-testid="plugins.management.actions"]')).toBeNull();
    expect(container.querySelector('[data-testid="plugins.management.highRiskScroll"]')).toBeNull();
    expect(container.textContent).toContain("plugins.notice.consentSource.market");
    for (const line of fiveLines) expect(container.textContent).toContain(line);
  });
  /* 测试价值（调度要求 J-1、K-1、K-2、K-3；Android 与 iOS 复拍）
   * - 生产入口与可观察结果：两端真实确认面板组件（原生视图替身）；观察滚动区上的渐隐、文字节点、按钮排布、标题位置。
   * - 依据：「还能往下滚」只用不含文字、不占高度的渐隐表示，滚到底消失；Android 滚动条常显、iOS 由渐隐表示；按钮区
   *   取实际高度、滚动区弹性占满其余；宽度足够时按钮并排；紧凑档标题进入滚动区。
   * - 缺口：文字提示叠在正文上（Android 复拍）；iOS 静止时没有任何「可滚动」线索；按钮折行后按钮区压到正文；紧凑档
   *   首屏只剩部分插件名。
   * - 最小失败输入：五类高风险 + 大字号；列表内容高于可见高度；宽 800 的窗口。tier: unit。
   */
  it("Android marks more below with a text-free fade that takes no room and goes at the end", () => {
    bridge.fontScale = 2;
    const { container } = mount(AndroidManagementConfirmation, props(allFive));
    const list = () => bridge.props.get("plugins.management.list");
    expect(list().showsVerticalScrollIndicator).toBe(false);
    expect(list().accessibilityHint).toBe("plugins.management.scrollHint");
    act(() => list().onLayout({ nativeEvent: { layout: { height: 300 } } }));
    act(() => list().onContentSizeChange(390, 1200));
    const fade = () => container.querySelector('[data-testid="plugins.management.listFade"]');
    expect(fade()).not.toBeNull();
    // No text over the scroll area: the fade holds no text node at all, and it never catches touches.
    expect(fade()!.textContent).toBe("");
    expect(bridge.props.get("plugins.management.listFade")).toMatchObject({ pointerEvents: "none" });
    act(() => list().onScroll({ nativeEvent: { contentOffset: { y: 900 }, contentSize: { height: 1200 }, layoutMeasurement: { height: 300 } } }));
    expect(fade()).toBeNull();
  });
  // Dispatcher Q-1 (Android sixth reshoot): in dark mode the always-visible bar was #151515 on #1E1E1E, darker than the
  // sheet, so with too little shown for the fade it said nothing. Each scroll area draws its own thumb in the
  // `borderStrong` token, which stands out from the sheet in both modes; it moves with the scroll and takes no touches.
  // Minimal failing input: dark mode, list content 1200 in 300. Tier: unit/jsdom.
  it.each(["light", "dark"] as const)("Android shows a scroll thumb that stands out from the sheet in %s mode", (mode) => {
    bridge.mode = mode;
    bridge.fontScale = 2;
    mount(AndroidManagementConfirmation, props(allFive));
    const list = () => bridge.props.get("plugins.management.list");
    act(() => list().onLayout({ nativeEvent: { layout: { height: 300 } } }));
    act(() => list().onContentSizeChange(390, 1200));
    const thumb = () => Object.assign({}, ...[bridge.props.get("plugins.management.listThumb").style].flat(3).filter(Boolean));
    expect(thumb()).toMatchObject({ backgroundColor: palettes[mode].borderStrong, top: 0, height: 75 });
    expect(bridge.props.get("plugins.management.listThumb").pointerEvents).toBe("none");
    // Contrast against the sheet: a luminance gap, not a near match (the old bar was 0.004 apart in dark mode).
    const luminance = (hex: string) => { const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
      .map((v) => v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4); return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!; };
    const [a, b] = [luminance(palettes[mode].borderStrong), luminance(palettes[mode].surfaceElevated)];
    expect((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)).toBeGreaterThanOrEqual(3);
    act(() => list().onScroll({ nativeEvent: { contentOffset: { y: 900 }, contentSize: { height: 1200 }, layoutMeasurement: { height: 300 } } }));
    expect(thumb().top).toBe(225);
  });
  // Dispatcher S-3 (Android seventh reshoot): the record panel's thumb (x 1018-1025) lay over the right end of the
  // "Stop tracking" button. The scrolling content keeps the thumb's width and a gap free on its right; without
  // overflow it keeps its full width. The confirmation sheet's two areas use the same thumb. Failed on 5983ba71dd (no
  // right padding). Tier: unit/jsdom.
  const flatStyle = (style: any) => Object.assign({}, ...[style].flat(3).filter(Boolean));
  const thumbClear = (area: string, thumb: string) => {
    const content = flatStyle(bridge.props.get(area).contentContainerStyle), bar = flatStyle(bridge.props.get(thumb).style);
    expect(bar.right + bar.width).toBeLessThan(content.paddingRight ?? 0);
  };
  it.each([["plugins.management.list", "plugins.management.listThumb"]])(
    "Android keeps the scroll thumb off the content of %s", (area, thumb) => {
      bridge.fontScale = 2;
      mount(AndroidManagementConfirmation, props(allFive));
      expect(flatStyle(bridge.props.get(area).contentContainerStyle).paddingRight).toBeUndefined();
      act(() => bridge.props.get(area).onLayout({ nativeEvent: { layout: { height: 100 } } }));
      act(() => bridge.props.get(area).onContentSizeChange(390, 1200));
      thumbClear(area, thumb);
    });
  it("keeps the record panel's scroll thumb off its buttons", () => {
    const who = { name: "Demo", deviceId: "mac", deviceName: "Mac", pluginId: "market/demo", ghostId: "demo" };
    const lines = Array.from({ length: 6 }, (_, index) => ({ key: `line-${index}`, entry: "market-install" as const, who }));
    mount(PluginPendingChecksSheet, { visible: true, lines, conclusions: [], isOnline: () => true, canOpen: () => true,
      onDecide: () => true, onClose() {}, onOpenChecked() {}, onShowInstalled() {} });
    expect(flatStyle(bridge.props.get("plugins.checks.list").contentContainerStyle).paddingRight).toBeUndefined();
    act(() => bridge.props.get("plugins.checks.list").onLayout({ nativeEvent: { layout: { height: 200 } } }));
    act(() => bridge.props.get("plugins.checks.list").onContentSizeChange(390, 900));
    thumbClear("plugins.checks.list", "plugins.checks.listThumb");
  });
  it("Android gives the buttons their own height below the scroll area, which flexes into the rest (K-1)", () => {
    bridge.fontScale = 3;
    mount(AndroidManagementConfirmation, props(allFive));
    const flat = (style: any) => Object.assign({}, ...[style].flat(3).filter(Boolean));
    const actions = flat(bridge.props.get("plugins.management.actions").style);
    // In the normal flow (never laid over the list), so wrapped labels push the list up instead of covering it.
    expect(actions.position).toBeUndefined();
    const list = flat(bridge.props.get("plugins.management.list").style);
    expect(list.height).toBeUndefined();
    expect(list.maxHeight).toBeUndefined();
  });
  it.each([["iOS", PluginManagementConfirmation], ["Android", AndroidManagementConfirmation]] as const)(
    "%s keeps Allow and Reject side by side at large text when the window is wide enough (K-3)", (platform, Sheet) => {
      bridge.fontScale = 2.4;
      bridge.width = 800;
      const wide = mount(Sheet, props(allFive)).container;
      // The row of Reject and the review button (Allow has its own row above it: maintainer review 06:44).
      const kind = (root: HTMLElement) => root.querySelector('[data-testid="plugins.management.answerRow"]')!.getAttribute("data-native");
      if (platform === "Android") expect(bridge.props.get("plugins.management.answerRow").style).not.toContainEqual({ flexDirection: "column-reverse" });
      else expect(kind(wide)).toBe("HStack");
      bridge.width = 375;
      const narrow = mount(Sheet, props(allFive)).container;
      if (platform === "Android") expect(bridge.props.get("plugins.management.answerRow").style).toContainEqual({ flexDirection: "column-reverse" });
      else expect(kind(narrow)).toBe("VStack");
    });
  it("iOS compact moves the sheet title into the scrolled list and sizes the footer to its content (K-1, K-3)", () => {
    bridge.fontScale = 2.4;
    mount(PluginManagementConfirmation, props(allFive));
    const header = Math.ceil(64 * 2) + 10, chrome = 8 * 2 + 8 * 3 + 4 + 12;
    geometry("plugins.management.actions", 844 - header - chrome - 100);
    geometry("plugins.management.identity", 384);
    geometry("plugins.management.highRiskTitle", 40);
    const items = () => [...bridge.props.values()].filter((p: any) => fiveLines.includes(p.children));
    items().forEach((item: any, index: number) => act(() => item.modifiers.find((m: any) => m.onGeometryChange).onGeometryChange({ width: 300, height: reviewLines[index] })));
    const sheet = bridge.props.get("plugins.managementConfirmation");
    expect(sheet.title).toBe("");
    expect(findIn(sheet.children, "plugins.management.sheetTitle")).toBe(true);
    expect(sheet.footer.props.modifiers).toContainEqual({ fixedSize: { horizontal: false, vertical: true } });
  });
  it("iOS shows the fade while the list has more below and hides it at the end (K-2)", () => {
    mount(PluginManagementConfirmation, props(allFive));
    const sheet = () => bridge.props.get("plugins.managementConfirmation");
    const observe = (geometry: object) => act(() => sheet().nativeContentModifiers.find((m: any) => m.scrollGeometry).scrollGeometry(geometry));
    const shown = () => sheet().nativeContentOverlay.props.modifiers.find((m: any) => "opacity" in m).opacity;
    expect(shown()).toBe(0);
    observe({ contentOffsetY: 0, containerHeight: 400, contentHeight: 1200 });
    expect(shown()).toBe(1);
    observe({ contentOffsetY: 800, containerHeight: 400, contentHeight: 1200 });
    expect(shown()).toBe(0);
    expect(sheet().nativeContentOverlay.props.modifiers).toContainEqual({ accessibilityHidden: true });
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

/* 测试价值（调度要求 M-2：插件页提示在最大字号下按钮被裁）
 * - 生产入口与可观察结果：iOS 插件页提示（usePluginPrompt.ios，原生面板）；观察标题与说明是否在滚动内容里、按钮是否在
 *   固定页脚里且页脚取理想高度、单按钮与两按钮、确认动作的时机。
 * - 依据：与确认面板同一原则：按钮区按实测高度固定，说明在按钮上方滚动；系统 Alert 在 AX5 下裁掉按钮。
 * - 缺口：旧 Host 更新提示与卸载确认在 SE AX5 上按钮被裁。
 * - 最小失败输入：一条长说明的单按钮提示；一条破坏性确认。tier: unit。
 */
describe("iOS plugin prompts", () => {
  const findIn = (node: any, testID: string): boolean => {
    if (!node || typeof node !== "object") return false;
    if (Array.isArray(node)) return node.some((child) => findIn(child, testID));
    if (node.props?.testID === testID) return true;
    return findIn(node.props?.children, testID);
  };

  function Harness({ request, onResult }: { request: any; onResult(value: boolean): void }) {
    const prompt = usePluginPrompt();
    return createElement("div", null,
      createElement("button", { "data-testid": "open", onClick: () => { void prompt.confirm(request).then(onResult); } }), prompt.dialog);
  }
  it("puts the title and the message in the scrolled content and the buttons in a footer of its full height", async () => {
    const results: boolean[] = [];
    const { container } = mount(Harness, { request: { title: "Short title", message: "A long explanation. ".repeat(30), confirmLabel: "Got it" },
      onResult: (value: boolean) => results.push(value) });
    await act(async () => (container.querySelector('[data-testid="open"]') as HTMLButtonElement).click());
    const sheet = bridge.props.get("plugins.prompt");
    expect(sheet.visible).toBe(true);
    expect(sheet.title).toBe("");
    expect(findIn(sheet.children, "plugins.prompt.title")).toBe(true);
    expect(findIn(sheet.children, "plugins.prompt.message")).toBe(true);
    expect(findIn(sheet.footer, "plugins.prompt.actions")).toBe(true);
    expect(findIn(sheet.children, "plugins.prompt.actions")).toBe(false);
    expect(sheet.footer.props.modifiers).toContainEqual({ fixedSize: { horizontal: false, vertical: true } });
    expect(bridge.props.has("plugins.prompt.cancel")).toBe(false);
    await act(async () => bridge.props.get("plugins.prompt.confirm").onPress());
    expect(results).toEqual([true]);
  });
  it("runs onConfirm in the tap that confirms a destructive confirmation", async () => {
    const order: string[] = [];
    const { container } = mount(Harness, { request: { title: "Uninstall Demo?", message: "Removes it.", cancelLabel: "Cancel", confirmLabel: "Uninstall",
      destructive: true, onConfirm: () => order.push("confirm") }, onResult: () => order.push("settled") });
    await act(async () => (container.querySelector('[data-testid="open"]') as HTMLButtonElement).click());
    expect(bridge.props.has("plugins.prompt.cancel")).toBe(true);
    await act(async () => { bridge.props.get("plugins.prompt.confirm").onPress(); order.push("tap"); });
    expect(order).toEqual(["confirm", "tap", "settled"]);
  });
});
