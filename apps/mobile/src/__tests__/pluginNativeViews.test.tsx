// @vitest-environment jsdom
import { PluginNativeNotice, PluginNotice as PluginNoticeHost } from "@/plugins/PluginNotice.ios";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { PluginDirectoryView } from "@/plugins/PluginDirectoryView.ios";
import { PluginDetailView } from "@/plugins/PluginDetailView.ios";
import { PluginDetailView as AndroidDetailView } from "@/plugins/PluginDetailView";
import { PluginTaskPickerView } from "@/plugins/PluginTaskPickerView.ios";
import { PluginTaskPickerView as AndroidTaskPickerView } from "@/plugins/PluginTaskPickerView";
import { pluginDetailModel } from "@/plugins/pluginDetailModel";
import { palettes } from "@/theme/tokens";
import { PluginManagementConfirmation } from "@/plugins/PluginManagementConfirmation.ios";
import { PluginModelPicker } from '@/plugins/PluginModelPicker';

const bridge = vi.hoisted(() => ({
  maker: { getCapabilities: async () => ({ availableModels: [], effortLevels: [], permissionModes: [] }) },
  props: new Map<string, any>(),
  ownerCurrent: true,
  keyboardVisible: false,
  mode: "light" as "light" | "dark",
}));
vi.mock("@/hooks/useReduceMotion", () => ({ useReduceMotionEnabled: () => false }));
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
  useWindowDimensions: () => ({ width: 390, height: 844, fontScale: 1 }),
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
  ScrollView: (p: any) => createElement("div", { "data-testid": p.testID }, p.children),
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
      "Sparkles",
      "Terminal",
      "Wrench",
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
  for (const fact of ["Plugin · 2", "plugin-id", "Verified source", "Full local access risk", "Removed host access", "plugins.management.permissions.nodeRuntimeDetail", "plugins.management.oauthChanged"]) expect(container.textContent).toContain(fact);
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

/* 依据：三端展示同一份页面权限 facts；最小输入：ui purpose + app 工具列表；tier: unit。 */
it('renders UI capability purpose, trust and complete Host permission details in the existing confirmation sheet', () => {
  const state = { outcome: 'confirmation', online: true, busy: false, receipt: { consent: {
    requestId: 'request', origin: 'local-file', initiator: 'user', purpose: 'ui-capability', trust: 'unverified',
    facts: { kind: 'install', ghostId: 'planner', name: 'Planner', version: '1', permissions: [
      { key: 'ui:pages', kind: 'panel', labelKey: 'mcpUi', detail: 'planner.html\napi.example.org\nsave_plan, open_plan' },
    ] },
  } } } as any;
  const { container } = mount(PluginManagementConfirmation, { state, controller: { getState: () => state, answer: vi.fn() } as any, active: true, deviceName: 'Mac' });
  for (const fact of ['plugins.uiApproval.purpose', 'plugins.management.trust.unverified', 'planner.html', 'api.example.org', 'save_plan, open_plan'])
    expect(container.textContent).toContain(fact);
  expect(container.textContent).not.toContain('plugins.notice.taskCapability');
});
