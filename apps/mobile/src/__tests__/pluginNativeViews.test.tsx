// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { PluginDirectoryView } from "@/plugins/PluginDirectoryView.ios";
import { PluginDetailView } from "@/plugins/PluginDetailView.ios";
import { PluginTaskPickerView } from "@/plugins/PluginTaskPickerView.ios";
import { PluginTaskPickerView as AndroidTaskPickerView } from "@/plugins/PluginTaskPickerView";
import { pluginDetailModel } from "@/plugins/pluginDetailModel";
import { palettes } from "@/theme/tokens";

const bridge = vi.hoisted(() => ({
  props: new Map<string, any>(),
  ownerCurrent: true,
  mode: "light" as "light" | "dark",
}));
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
  return {
    TextField,
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
        "Circle",
        "DisclosureGroup",
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
            name === "DisclosureGroup" && p.isExpanded === false
              ? null
              : p.children,
          );
        },
      ]),
    ),
  };
});
vi.mock("@expo/ui/swift-ui/modifiers", () => ({
  shapes: {
    capsule: () => "capsule",
    rectangle: () => "rectangle",
    roundedRectangle: (p: any) => p,
  },
  ...Object.fromEntries(
    [
      "accessibilityLabel",
      "autocorrectionDisabled",
      "textInputAutocapitalization",
      "textFieldStyle",
      "submitLabel",
      "onSubmit",
      "background",
      "buttonStyle",
      "contentShape",
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
  PlatformColor: (name: string) => name,
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
  Pressable: (p: any) => p.children,
  ActivityIndicator: () => null,
  StyleSheet: { create: (s: any) => s },
}));
vi.mock("lucide-react-native", () => ({
  Puzzle: () => null,
  Wrench: () => null,
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
    bridge.props.set("plugins.taskPicker", p);
    return createElement(
      "div",
      { "data-native": "sheet", "data-testid": p.testID },
      p.nativeHeader,
      p.children,
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
      onSettings: vi.fn(),
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
it("groups use buttons under a heading, puts the switch beside the title and guides configuration to PC", () => {
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
    onSettings: vi.fn(),
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
      nativeButton: "secondary",
    });
  }
  expect(container.querySelector('[data-testid="plugins.tools"]')).toBeNull();
  expect(
    container.querySelector(
      '[data-testid="plugins.identity"] [data-testid="plugins.enabled"]',
    ),
  ).not.toBeNull();
  expect(
    container.querySelector('[data-testid="plugins.useHeading"]')?.textContent,
  ).toBe("plugins.detail.useItIn");
  expect(
    container.querySelector('[data-testid="plugins.computerSettings"]'),
  ).not.toBeNull();
  expect(
    container.querySelector('[data-testid="plugins.permissions"]'),
  ).toBeNull();
  expect(
    container.querySelector('[data-testid="plugins.metadata"]'),
  ).not.toBeNull();
  act(() => bridge.props.get("plugins.chooseTask").onPress());
  expect(p.onChooseTask).toHaveBeenCalledOnce();
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
    onSettings: vi.fn(),
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
    onSettings: vi.fn(),
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
    container.querySelectorAll(
      '[data-testid="plugins.metadata"] [data-native="Divider"]',
    ),
  ).toHaveLength(1);
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
  expect(
    container.querySelector('[data-testid="plugins.metadata"]')?.textContent,
  ).toContain("2.3.0");
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
    rerender({ ...p, model: { ...p.model, tools: empty, permissions: empty } });
    expect(container.querySelector('[data-testid="plugins.tools"]')).toBeNull();
    expect(
      container.querySelector('[data-testid="plugins.permissions"]'),
    ).toBeNull();
    expect(container.textContent).toContain("v2.3.0");
  }
  rerender({
    ...p,
    model: {
      ...p.model,
      details: [
        { key: "author", title: "Author", value: " " },
        { key: "version", title: "Version", value: "v2.3.0" },
      ],
      permissions: [{ title: "Network", description: "" }],
    },
  });
  expect(
    container.querySelector('[data-testid="plugins.fact.author"]'),
  ).toBeNull();
  expect(
    container.querySelector('[data-testid="plugins.fact.version"]')
      ?.textContent,
  ).toContain("v2.3.0");
  expect(
    container.querySelector('[data-testid="plugins.permissions"]')?.textContent,
  ).toContain("Network");
  expect(container.textContent).not.toContain("plugins.detail.noDescription");
  rerender({ ...p, model: { ...p.model, details: [], hasSettings: false } });
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
