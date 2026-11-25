// @vitest-environment jsdom
import { act, createElement, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PluginUiEnablePrompt } from "@/plugins/PluginUiEnablePrompt";
import { DeviceLinkError, sharedTaskHostPeer, providerShareHostPeer } from "@cindy/device-link";
import PluginsScreen from "@/plugins/PluginsScreen";
import { pluginConsentPresentation } from "@/plugins/pluginConsentPresentation";
import { usePluginManagement, __retainedForTests } from "@/plugins/usePluginManagement";
import { __testing as slotTesting, pluginManagementSlotFor } from "@/plugins/pluginManagementSlot";
import { createPluginPromptReads } from "@/plugins/pluginPromptReads";

const fixture = vi.hoisted(() => ({
  props: new Map<string, any>(),
  originalSettingsMounts: 0,
  appStateListeners: new Set<(state: string) => void>(),
  promptReads: null as ReturnType<typeof createPluginPromptReads> | null,
  realManagement: false,
  accountGeneration: 0,
  wire: vi.fn(),
  subscribe: vi.fn(async () => {}),
  unsubscribe: vi.fn(async () => {}),
  resourceListeners: new Set<(device: string, payload: any) => void>(),
  management: { state: null, controller: null } as any,
  marketManagement: { state: null, controller: null } as any,
  marketRead: vi.fn(),
  devicesRefresh: vi.fn(),
  enabled: true,
  online: true,
  focused: true,
  owner: true,
  invoke: vi.fn(),
  read: vi.fn(),
  refresh: vi.fn(),
  alert: vi.fn(),
  push: vi.fn(),
  blocks: [] as any[],
  stubTaskSettings: false,
  extraRows: [] as any[],
  extraDevices: [] as any[],
  offlineDevices: new Set<string>(),
  devicesFailed: false,
  devicesAbsent: false,
  listHasRows: true,
  platform: "ios",
  width: 390,
  storage: new Map<string, string>(),
  getStored: vi.fn(),
  setStored: vi.fn(),
}));
vi.mock("@/plugins/usePluginManagement", async (importOriginal) => {
  const actual = await importOriginal<any>();
  return ({
  __retainedForTests: actual.__retainedForTests,
  usePluginManagement: (...args: any[]) => {
    // The market's install controller is keyed "plugin-market:<attempt>"; keep it apart from the detail's.
    if (String(args[3] ?? "").startsWith("plugin-market")) {
      fixture.props.set("marketManagementScope", args);
      return fixture.realManagement ? actual.usePluginManagement(...args) : fixture.marketManagement;
    }
    fixture.props.set("managementScope", args);
    const result = fixture.realManagement ? actual.usePluginManagement(...args) : fixture.management;
    fixture.props.set("observedManagement", result);
    return result;
  },
});
});
vi.mock("@/plugins/PluginPromptReadsContext", () => ({ usePluginPromptReads: () => fixture.promptReads }));
vi.mock("expo-crypto", () => ({ randomUUID: () => "screen-operation" }));
vi.mock("@/plugins/PluginOriginalSettings", () => ({
  PluginOriginalSettings: (p: any) => {
    fixture.props.set("originalSettings", p);
    useEffect(() => { fixture.originalSettingsMounts += 1; }, []);
    return null;
  },
}));
vi.mock("@/device-link/useDeviceProviders", () => ({
  useDeviceProviders: () => ({ providers: [], ready: true, loading: false }),
}));
vi.mock("@/device-link/useMobileMakerTransport", () => ({
  useMobileMakerTransport: () => ({ getCapabilities: async () => null }),
}));
vi.mock("@/session/useRemoteAgentCatalogs", () => ({
  useRemoteAgentCatalogs: () => [{ deviceId: "share:abc", name: "Shared", providers: [] }],
}));
vi.mock("@/session/ModelPickerSheet", () => ({
  ModelPickerSheet: (p: any) => { fixture.props.set("taskModelPicker", p); return null; },
}));
vi.mock("@/session/permissionPresentation", () => ({
  permissionPresentation: (mode: string) => ({ label: mode }),
}));
vi.mock("@/plugins/pluginManagementClient", async (importOriginal) => {
  const actual = await importOriginal<any>();
  return { ...actual, createPluginManagementClient: (...args: any[]) => fixture.realManagement
    ? actual.createPluginManagementClient(...args) : ({ detail: fixture.marketRead }) };
});
vi.mock("@/plugins/PluginManagementMenu", () => ({
  PluginManagementMenu: () => null,
}));
vi.mock("@/plugins/PluginManagementConfirmation", () => ({ PluginManagementConfirmation: (p: any) => { fixture.props.set("confirmation", p); return null; } }));
vi.mock("@/plugins/PluginNotice", () => ({ PluginNotice: (p: any) => { fixture.props.set(p.testID ?? "notice", p); return createElement("span", null, p.title); } }));
vi.mock("react-native", async () => {
  const React = await import("react");
  const view = ({ children }: any) =>
    React.createElement("div", null, children);
  return {
    AppState: { currentState: "active", addEventListener: (_event: string, listener: (state: string) => void) => {
      fixture.appStateListeners.add(listener); return { remove: () => fixture.appStateListeners.delete(listener) };
    } },
    ActivityIndicator: view,
    Alert: { alert: fixture.alert },
    BackHandler: { addEventListener: () => ({ remove() {} }) },
    Image: view,
    Pressable: (p: any) => {
      if (p.accessibilityLabel) fixture.props.set("pressable." + p.accessibilityLabel, p);
      return React.createElement("button", { onClick: p.onPress, disabled: p.disabled }, p.children);
    },
    RefreshControl: view,
    ScrollView: view,
    View: view,
    Platform: {
      get OS() {
        return fixture.platform;
      },
    },
    StyleSheet: { create: (s: any) => s, hairlineWidth: 1 },
    useWindowDimensions: () => ({ width: fixture.width }),
  };
});
vi.mock("react-native-safe-area-context", async () => ({
  SafeAreaView: ({ children }: any) => createElement("div", null, children),
}));
vi.mock("expo-router", () => ({
  Stack: {
    Screen: (p: any) => {
      fixture.props.set("stack", p.options);
      return null;
    },
  },
  useIsFocused: () => fixture.focused,
  useLocalSearchParams: () => ({}),
  useRouter: () => ({ push: fixture.push }),
}));
vi.mock("@/utils/backGuard", () => ({ goBackGuarded: vi.fn() }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en" } }),
}));
vi.mock("lucide-react-native", () =>
  Object.fromEntries(
    [
      "ChevronDown",
      "ChevronRight",
      "Info",
      "Monitor",
      "Puzzle",
      "Search",
      "Plus",
    ].map((key) => [key, () => null]),
  ),
);
vi.mock("@/components/AppText", () => ({
  Text: ({ children }: any) => createElement("span", null, children),
  TextInput: () => null,
}));
vi.mock("@/auth/AuthContext", () => ({
  useAuth: () => ({ accountGeneration: fixture.accountGeneration, apiFetch: vi.fn() }),
}));
vi.mock("@/auth/authOwnerGeneration", () => ({
  subscribeMobileAuthOwner: () => () => {},
  getMobileAuthOwner: () => ({ accountKey: "demo" }),
  isMobileAuthOwnerCurrent: () => fixture.owner,
}));
function resourceListener(listener: (device: string, payload: any) => void) {
  fixture.resourceListeners.add(listener);
  return () => { fixture.resourceListeners.delete(listener); };
}
vi.mock("@/device-link/DeviceLinkContext", () => ({
  useDeviceLink: () => ({ invoke: fixture.wire, subscribe: fixture.subscribe, unsubscribe: fixture.unsubscribe,
    onRemoteResourceChanged: resourceListener,
  }),
}));
vi.mock("@/device-link/useDeviceManagement", () => ({
  useDeviceManagement: () => ({
    error: fixture.devicesFailed ? "throttled" : null,
    loading: false,
    devices:
      fixture.devicesFailed || fixture.devicesAbsent
        ? []
        : [
            {
              deviceId: "mac",
              name: "Mac",
              platform: "darwin",
              remoteControlEnabled: true,
            },
            ...fixture.extraDevices,
          ],
    refresh: () => fixture.devicesRefresh(),
  }),
}));
const row = () => ({
  key: "mac:plugin",
  host: { deviceId: "mac", deviceName: "Mac" },
  item: {
    ref: { collectionId: "plugins", kind: "plugin", id: "demo" },
    revision: "1",
    display: { title: "Demo" },
    actions: [{ id: fixture.enabled ? "disable" : "enable", label: "Enabled" }],
  },
});
vi.mock("@/device-link/remoteResources", () => ({
  getRemoteResource: (...args: any[]) => fixture.read(...args),
  isRemoteResourcesUnsupported: () => false,
}));
vi.mock("@/session/useRemoteResourceList", () => ({
  useRemoteResourceList: () => ({
    items:
      fixture.devicesFailed || fixture.devicesAbsent || !fixture.listHasRows
        ? []
        : [...fixture.extraRows, row()],
    error: fixture.devicesFailed || fixture.devicesAbsent ? "noHosts" : null,
    loading: false,
    isOnline: (host: any) => fixture.online && !fixture.offlineDevices.has(host?.deviceId),
    refresh: fixture.refresh,
  }),
}));
vi.mock("@/theme", async () => {
  const tokens = await import("@/theme/tokens");
  return {
    ...tokens,
    useTheme: () => ({ colors: tokens.lightColors }),
    useThemedStyles: (factory: any) => factory(tokens.lightColors),
  };
});
vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: (...args: any[]) => fixture.getStored(...args),
    setItem: (...args: any[]) => fixture.setStored(...args),
  },
}));
vi.mock("@/platform/chrome/SimpleStackHeader", () => ({
  simpleScreenSafeAreaEdges: () => [],
  SimpleStackHeader: (p: any) => {
    fixture.props.set("header", p);
    return null;
  },
}));
vi.mock("@/platform/chrome/NativeSwitch", () => ({
  NativeSwitch: (p: any) => {
    fixture.props.set("switch", p);
    return null;
  },
}));
vi.mock("@/plugins/PluginDirectoryView", () => ({
  PluginDirectoryView: (p: any) => {
    fixture.props.set("directory", p);
    return null;
  },
}));
vi.mock("@/plugins/PluginDetailView", () => ({
  PluginDetailView: (p: any) => {
    fixture.props.set("detail", p);
    return createElement("div", null, p.settingsContent);
  },
}));
vi.mock("@/plugins/PluginTaskPicker", () => ({
  PluginTaskPicker: (p: any) => {
    fixture.props.set("taskPicker", p);
    return null;
  },
}));
vi.mock("@/session/FileBrowserSegmentedControl", () => ({
  FileBrowserSegmentedControl: (p: any) => {
    fixture.props.set("segment", p);
    return null;
  },
}));
// The Android market choice sheet (same as pluginNativeViews): render content without native presentation.
vi.mock("@/session/SheetModal", () => ({ SheetModal: (p: any) => p.children }));
vi.mock("@/session/SheetSurface", () => ({ SheetSurface: (p: any) => p.children }));
vi.mock("@/plugins/PluginPage", () => ({ PluginPage: () => null }));
// The real form, except where a test only needs what the screen hands it (the management slot): `stubTaskSettings`.
vi.mock("@/plugins/PluginTaskSettings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/plugins/PluginTaskSettings")>();
  return { PluginTaskSettings: (p: any) => {
    fixture.props.set("taskSettings", p);
    return fixture.stubTaskSettings ? null : createElement(actual.PluginTaskSettings, p);
  } };
});
vi.mock("@/plugins/PluginReadmePage", () => ({ PluginReadmePage: () => null }));
vi.mock("@/plugins/pluginClient", () => ({
  invokePlugin: (...args: any[]) => fixture.invoke(...args),
}));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: ReturnType<typeof createRoot>;
let element: HTMLDivElement;
beforeEach(() => {
  // The page slot and retained controllers live per account in modules; every test starts with none.
  slotTesting.reset();
  __retainedForTests?.clear();
  fixture.props.clear();
  fixture.originalSettingsMounts = 0;
  fixture.realManagement = false;
  fixture.promptReads = null;
  fixture.accountGeneration = 0;
  fixture.wire.mockReset();
  fixture.management = { state: null, controller: null };
  fixture.marketManagement = { state: null, controller: null };
  fixture.marketRead.mockReset();
  fixture.storage.clear();
  fixture.getStored
    .mockReset()
    .mockImplementation(
      async (key: string) => fixture.storage.get(key) ?? null,
    );
  fixture.setStored
    .mockReset()
    .mockImplementation(async (key: string, value: string) => {
      fixture.storage.set(key, value);
    });
  fixture.blocks = [];
  fixture.stubTaskSettings = false;
  fixture.extraRows = [];
  fixture.extraDevices = [];
  fixture.offlineDevices.clear();
  fixture.devicesFailed = false;
  fixture.devicesAbsent = false;
  fixture.listHasRows = true;
  fixture.push.mockClear();
  fixture.enabled = true;
  fixture.online = true;
  fixture.focused = true;
  fixture.owner = true;
  fixture.platform = "ios";
  fixture.width = 390;
  fixture.invoke
    .mockReset()
    .mockImplementation(async (_invoke, _device, _plugin, action) => {
      fixture.enabled = action === "enable";
    });
  fixture.read.mockReset().mockImplementation(async () => ({
    ...row().item,
    blocks: fixture.blocks,
  }));
  fixture.refresh.mockReset().mockResolvedValue(undefined);
  fixture.alert.mockClear();
  element = document.createElement("div");
  root = createRoot(element);
});
afterEach(() => act(() => root.unmount()));
async function openDetail() {
  await act(async () => root.render(createElement(PluginsScreen)));
  await act(async () => fixture.props.get("directory").onDetail(row()));
}
it("reads selected plugin details when its computer comes online", async () => {
  fixture.online = false;
  fixture.blocks = [
    {
      id: "capabilities",
      primitive: "plugin-capabilities",
      data: { tools: [{ name: "restored_tool" }] },
    },
  ];
  await openDetail();
  expect(fixture.read).not.toHaveBeenCalled();
  expect(fixture.props.get("detail").model.status).toBe("offline");
  fixture.online = true;
  await act(async () => root.render(createElement(PluginsScreen)));
  expect(fixture.read).toHaveBeenCalledTimes(1);
  expect(fixture.props.get("detail").model.tools).toEqual([
    { name: "restored_tool", description: "" },
  ]);
  await act(async () => root.render(createElement(PluginsScreen)));
  expect(fixture.read).toHaveBeenCalledTimes(1);
});
it("uses UIKit search to filter and clear without replaying JS text into native input", async () => {
  await act(async () => root.render(createElement(PluginsScreen)));
  const search = fixture.props.get("stack").headerSearchBarOptions;
  expect(search).toMatchObject({
    placement: "stacked",
    hideWhenScrolling: false,
  });
  const setText = vi.fn();
  search.ref.current = { setText };
  expect(setText).toHaveBeenCalledWith("");
  setText.mockClear();
  await act(async () =>
    search.onChangeText({ nativeEvent: { text: "No match" } }),
  );
  expect(fixture.props.get("directory").items).toEqual([]);
  expect(setText).not.toHaveBeenCalled();
  await act(async () => search.onChangeText({ nativeEvent: { text: "Demo" } }));
  expect(fixture.props.get("directory").items).toHaveLength(1);
  await act(async () => fixture.props.get("directory").onDetail(row()));
  expect(fixture.props.get("stack").headerSearchBarOptions).toBeUndefined();
  search.ref.current = null;
  act(() => fixture.props.get("header").onBack());
  const restored = fixture.props.get("stack").headerSearchBarOptions;
  restored.ref.current = { setText };
  expect(setText).toHaveBeenLastCalledWith("Demo");
  await act(async () => restored.onCancelButtonPress());
  expect(fixture.props.get("directory").query).toBe("");
});
it("keeps details open and reflects confirmed off/on host states", async () => {
  await openDetail();
  expect(fixture.props.get("detail").enabled).toBe(true);
  await act(async () => fixture.props.get("detail").onEnabledChange(false));
  expect(fixture.invoke).toHaveBeenLastCalledWith(
    expect.anything(),
    "mac",
    "demo",
    "disable",
  );
  expect(fixture.props.get("detail")).toMatchObject({
    enabled: false,
    busy: false,
  });
  await act(async () => fixture.props.get("detail").onEnabledChange(true));
  expect(fixture.props.get("detail")).toMatchObject({
    enabled: true,
    busy: false,
  });
  expect(fixture.refresh).toHaveBeenCalledTimes(2);
});
it("refreshes existing details after its computer reconnects", async () => {
  await openDetail();
  fixture.online = false;
  await act(async () => root.render(createElement(PluginsScreen)));
  expect(fixture.props.get("detail").model.status).toBe("offline");
  fixture.enabled = false;
  fixture.online = true;
  await act(async () => root.render(createElement(PluginsScreen)));
  expect(fixture.read).toHaveBeenCalledTimes(2);
  expect(fixture.props.get("detail")).toMatchObject({
    enabled: false,
    model: { status: "disabled", canUseTasks: false },
  });
  await act(async () => root.render(createElement(PluginsScreen)));
  expect(fixture.read).toHaveBeenCalledTimes(2);
  expect(fixture.invoke).not.toHaveBeenCalled();
});
it("retries failed details on reconnect without replaying writes", async () => {
  fixture.read.mockRejectedValueOnce(new Error("disconnected"));
  await openDetail();
  expect(fixture.props.get("detail").model.status).toBe("loadFailed");
  fixture.online = false;
  await act(async () => root.render(createElement(PluginsScreen)));
  fixture.online = true;
  await act(async () => root.render(createElement(PluginsScreen)));
  expect(fixture.read).toHaveBeenCalledTimes(2);
  expect(fixture.props.get("detail").model.canUseTasks).toBe(true);
  expect(fixture.invoke).not.toHaveBeenCalled();
});
it("ignores a pre-disconnect read that settles after the reconnect read", async () => {
  let finishOldRead!: (resource: any) => void;
  const stale = row().item;
  fixture.read.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishOldRead = resolve;
      }),
  );
  await openDetail();
  expect(fixture.props.get("detail").busy).toBe(true);
  fixture.online = false;
  await act(async () => root.render(createElement(PluginsScreen)));
  fixture.enabled = false;
  fixture.online = true;
  await act(async () => root.render(createElement(PluginsScreen)));
  expect(fixture.read).toHaveBeenCalledTimes(2);
  expect(fixture.props.get("detail").enabled).toBe(false);
  await act(async () => finishOldRead(stale));
  expect(fixture.props.get("detail")).toMatchObject({
    enabled: false,
    busy: false,
    model: { status: "disabled" },
  });
});
it("marks details unconfirmed when a successful state change cannot be read back", async () => {
  await openDetail();
  fixture.read.mockRejectedValueOnce(new Error("read unavailable"));
  await act(async () => fixture.props.get("detail").onEnabledChange(false));
  expect(fixture.enabled).toBe(false);
  expect(fixture.props.get("detail")).toMatchObject({
    busy: false,
    model: {
      status: "loadFailed",
      statusAction: "retry",
      canUseTasks: false,
      canToggle: false,
    },
  });
  expect(fixture.alert).not.toHaveBeenCalled();
  await act(async () => fixture.props.get("detail").onNewTask());
  await act(async () => fixture.props.get("detail").onChooseTask());
  await act(async () => fixture.props.get("detail").onEnabledChange(false));
  expect(fixture.push).not.toHaveBeenCalled();
  expect(fixture.invoke).toHaveBeenCalledTimes(1);
  await act(async () => fixture.props.get("detail").onResolveStatus());
  expect(fixture.props.get("detail")).toMatchObject({
    enabled: false,
    model: { status: "disabled" },
  });
  expect(fixture.invoke).toHaveBeenCalledTimes(1);
});
it.each(["reconnect", "return"])(
  "confirms a pending state change after %s without an overlapping automatic read",
  async (event) => {
    await openDetail();
    let finishWrite!: () => void;
    fixture.invoke.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishWrite = () => {
            fixture.enabled = false;
            resolve();
          };
        }),
    );
    act(() => fixture.props.get("detail").onEnabledChange(false));
    if (event === "reconnect") fixture.online = false;
    else fixture.focused = false;
    await act(async () => root.render(createElement(PluginsScreen)));
    fixture.online = true;
    fixture.focused = true;
    await act(async () => root.render(createElement(PluginsScreen)));
    expect(fixture.read).toHaveBeenCalledTimes(1);
    await act(async () => finishWrite());
    expect(fixture.read).toHaveBeenCalledTimes(2);
    expect(fixture.invoke).toHaveBeenCalledTimes(1);
    expect(fixture.props.get("detail")).toMatchObject({
      enabled: false,
      busy: false,
      model: { status: "disabled", canUseTasks: false },
    });
    await act(async () => root.render(createElement(PluginsScreen)));
    expect(fixture.read).toHaveBeenCalledTimes(2);
  },
);
it.each(["reconnect", "return"])(
  "confirms Host state when the write reply fails after %s",
  async (event) => {
    await openDetail();
    let failReply!: () => void;
    fixture.invoke.mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, reject) => {
          failReply = () => {
            fixture.enabled = false;
            reject(new Error("reply timed out after Host applied the action"));
          };
        }),
    );
    act(() => fixture.props.get("detail").onEnabledChange(false));
    if (event === "reconnect") fixture.online = false;
    else fixture.focused = false;
    await act(async () => root.render(createElement(PluginsScreen)));
    fixture.online = true;
    fixture.focused = true;
    await act(async () => root.render(createElement(PluginsScreen)));
    expect(fixture.read).toHaveBeenCalledTimes(1);
    await act(async () => failReply());
    expect(fixture.read).toHaveBeenCalledTimes(2);
    expect(fixture.props.get("detail")).toMatchObject({
      enabled: false,
      busy: false,
      model: { status: "disabled", canUseTasks: false },
    });
    expect(fixture.invoke).toHaveBeenCalledTimes(1);
    expect(fixture.alert).toHaveBeenCalledWith("plugins.actionFailed", undefined, [{ text: "plugins.gotIt" }]);
  },
);
it("offers only a read retry when both the write reply and confirmation read fail", async () => {
  await openDetail();
  fixture.invoke.mockImplementationOnce(async () => {
    fixture.enabled = false;
    throw new Error("reply timed out");
  });
  fixture.read.mockRejectedValueOnce(new Error("read unavailable"));
  await act(async () => fixture.props.get("detail").onEnabledChange(false));
  expect(fixture.props.get("detail").model).toMatchObject({
    status: "loadFailed",
    statusAction: "retry",
    canUseTasks: false,
    canToggle: false,
  });
  await act(async () => fixture.props.get("detail").onResolveStatus());
  expect(fixture.props.get("detail").enabled).toBe(false);
  expect(fixture.invoke).toHaveBeenCalledTimes(1);
});
it("locks duplicate taps, and a rejected write keeps the previous state without replay", async () => {
  await openDetail();
  let reject!: (error: Error) => void;
  fixture.invoke.mockImplementation(
    () =>
      new Promise((_resolve, fail) => {
        reject = fail;
      }),
  );
  act(() => {
    fixture.props.get("detail").onEnabledChange(false);
    fixture.props.get("detail").onEnabledChange(false);
  });
  expect(fixture.invoke).toHaveBeenCalledTimes(1);
  expect(fixture.props.get("detail").busy).toBe(true);
  await act(async () => reject(new Error("offline")));
  expect(fixture.props.get("detail")).toMatchObject({
    enabled: true,
    busy: false,
  });
  expect(fixture.alert).toHaveBeenCalledWith("plugins.actionFailed", undefined, [{ text: "plugins.gotIt" }]);
  expect(fixture.invoke).toHaveBeenCalledTimes(1);
});
it("does not change a plugin when its computer is offline", async () => {
  fixture.online = false;
  await openDetail();
  await act(async () => fixture.props.get("detail").onEnabledChange(false));
  expect(fixture.invoke).not.toHaveBeenCalled();
  expect(fixture.read).not.toHaveBeenCalled();
});
it("opens cached details for an offline row without sending a read or an action", async () => {
  fixture.online = false;
  await act(async () => root.render(createElement(PluginsScreen)));
  await act(async () => fixture.props.get("directory").onOpen(row()));
  const detail = fixture.props.get("detail");
  expect(detail.model).toMatchObject({
    status: "offline",
    statusAction: "connect",
    canUseTasks: false,
    canToggle: false,
  });
  expect(detail.busy).toBe(false);
  expect(fixture.read).not.toHaveBeenCalled();
  expect(fixture.invoke).not.toHaveBeenCalled();
  expect(fixture.alert).not.toHaveBeenCalled();
});
it("waits for the initial detail read before allowing a state change", async () => {
  let resolve!: (resource: any) => void;
  fixture.read.mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  await openDetail();
  expect(fixture.props.get("detail").busy).toBe(true);
  await act(async () => fixture.props.get("detail").onEnabledChange(false));
  expect(fixture.invoke).not.toHaveBeenCalled();
  await act(async () => resolve({ ...row().item, blocks: fixture.blocks }));
  expect(fixture.props.get("detail").busy).toBe(false);
});
it("does not reopen details after the user has returned to the list", async () => {
  await openDetail();
  let resolve!: () => void;
  fixture.invoke.mockImplementation(
    () =>
      new Promise<void>((done) => {
        resolve = done;
      }),
  );
  act(() => fixture.props.get("detail").onEnabledChange(false));
  act(() => fixture.props.get("header").onBack());
  fixture.props.delete("detail");
  await act(async () => resolve());
  expect(fixture.props.has("detail")).toBe(false);
});
it("keeps the same confirmed switch behavior on Android", async () => {
  fixture.platform = "android";
  // The directory's RN row is not needed to exercise this via a native mock. It is
  // rendered before the platform switch, then details re-render on Android.
  fixture.platform = "ios";
  await openDetail();
  fixture.platform = "android";
  await act(async () => fixture.props.get("detail").onEnabledChange(false));
  expect(fixture.props.get("detail")).toMatchObject({
    enabled: false,
    busy: false,
  });
});
it("keeps plugin task preferences on PC instead of mounting a mobile form", async () => {
  fixture.blocks = [{ id: "capabilities", data: { tasks: true } }];
  await openDetail();
  expect(fixture.props.get("detail").children).toBeUndefined();
  expect(fixture.props.get("detail").settingsOpen).toBe(false);
  expect(fixture.props.get("detail").row.item.ref.id).toBe("demo");
});
it("guards both task callbacks offline and disabled, including stale native callbacks", async () => {
  fixture.online = false;
  await openDetail();
  act(() => fixture.props.get("detail").onNewTask());
  act(() => fixture.props.get("detail").onChooseTask());
  expect(fixture.push).not.toHaveBeenCalled();
  expect(fixture.props.get("detail").model.canUseTasks).toBe(false);
  fixture.online = true;
  fixture.enabled = false;
  await act(async () => fixture.props.get("directory").onDetail(row()));
  act(() => fixture.props.get("detail").onNewTask());
  expect(fixture.push).not.toHaveBeenCalled();
  await act(async () => fixture.props.get("detail").onResolveStatus());
  expect(fixture.props.get("detail").model.canUseTasks).toBe(true);
});
it("shows a recoverable detail read failure and retries reads without issuing writes", async () => {
  fixture.read.mockRejectedValueOnce(new Error("disconnected"));
  await openDetail();
  expect(fixture.props.get("detail").model).toMatchObject({
    status: "loadFailed",
    statusAction: "retry",
  });
  await act(async () => fixture.props.get("detail").onResolveStatus());
  expect(fixture.props.get("detail").model.canUseTasks).toBe(true);
  expect(fixture.invoke).not.toHaveBeenCalled();
});

it("records a task usage entry but never a details-only visit", async () => {
  await openDetail();
  expect(fixture.setStored).not.toHaveBeenCalled();
  await act(async () => fixture.props.get("detail").onNewTask());
  expect(fixture.setStored).toHaveBeenCalledWith(
    "cindy.pluginRecent.v1.demo",
    JSON.stringify(["mac:plugin"]),
  );
});
it("really moves a used plugin above an earlier row and restores that order on remount", async () => {
  fixture.extraRows = [
    {
      ...row(),
      key: "mac:earlier",
      item: {
        ...row().item,
        ref: { ...row().item.ref, id: "earlier" },
        display: { title: "Earlier" },
      },
    },
  ];
  await act(async () => root.render(createElement(PluginsScreen)));
  expect(fixture.props.get("directory").items.map((i: any) => i.key)).toEqual([
    "mac:earlier",
    "mac:plugin",
  ]);
  await act(async () => fixture.props.get("directory").onDetail(row()));
  act(() => fixture.props.get("header").onBack());
  expect(fixture.props.get("directory").items[0].key).toBe("mac:earlier");
  await act(async () => fixture.props.get("directory").onDetail(row()));
  await act(async () => fixture.props.get("detail").onNewTask());
  act(() => fixture.props.get("header").onBack());
  expect(fixture.props.get("directory").items.map((i: any) => i.key)).toEqual([
    "mac:plugin",
    "mac:earlier",
  ]);
  act(() => root.render(null));
  await act(async () => root.render(createElement(PluginsScreen)));
  expect(fixture.props.get("directory").items[0].key).toBe("mac:plugin");
});

it("shows a failed computer lookup as an error, suppressing misleading sort notices", async () => {
  fixture.devicesFailed = true;
  await act(async () => root.render(createElement(PluginsScreen)));
  expect(fixture.props.get("directory")).toMatchObject({
    targets: [],
    error: true,
    loading: false,
  });
});
it("keeps the shared no-host message as an empty state when the computer lookup succeeds", async () => {
  fixture.devicesAbsent = true;
  await act(async () => root.render(createElement(PluginsScreen)));
  expect(fixture.props.get("directory")).toMatchObject({
    targets: [],
    items: [],
    error: false,
    loading: false,
  });
});

it("guides setup to PC without opening configuration or creating a task", async () => {
  fixture.blocks = [
    {
      id: "capabilities",
      data: {
        usage: {
          taskUsable: true,
          hasSettings: true,
          approvalRequired: false,
          builtin: false,
          retired: false,
          setup: {
            state: "required",
            missing: ["Calendar account"],
            expired: [],
          },
        },
      },
    },
  ];
  await openDetail();
  const detail = fixture.props.get("detail");
  expect(detail.model.status).toBe("setupRequired");
  expect(detail.model.canUseTasks).toBe(true);
  expect(detail.children).toBeUndefined();
  await act(async () => detail.onResolveStatus());
  expect(fixture.alert).toHaveBeenCalledWith("plugins.detail.computerSettings", undefined, [{ text: "plugins.gotIt" }]);
  expect(fixture.push).not.toHaveBeenCalled();
  expect(fixture.invoke).not.toHaveBeenCalled();
});

it("records recent use when choosing an existing task", async () => {
  await openDetail();
  await act(async () => fixture.props.get("detail").onChooseTask());
  await act(async () =>
    fixture.props.get("taskPicker").onSelect("existing-task"),
  );
  expect(fixture.push).toHaveBeenCalledWith(
    expect.objectContaining({
      pathname: "/sessions/[sessionId]",
      params: expect.objectContaining({
        sessionId: "existing-task",
        deviceId: "mac",
      }),
    }),
  );
  expect(fixture.setStored).toHaveBeenCalledWith(
    "cindy.pluginRecent.v1.demo",
    JSON.stringify(["mac:plugin"]),
  );
});

// Management UI integration: the real screen must bind actions to the selected Host/instance,
// discard late native confirmations and expose only negotiated original-settings support.
// Existing controller tests cover wire validation; these unit cases cover the missing UI wiring.
function managedScreen() {
  const plugin = {
    instanceKey: "demo",
    namespace: null,
    enabled: true,
    manifest: { id: "demo", name: "Demo", version: "1" },
    approval: {
      state: "approved",
      revision: "12345678-1234-4123-8123-123456789abc",
    },
  };
  const market = {
    pluginId: "market/demo",
    ghostId: "demo",
    namespace: null,
    name: "Demo",
    releaseId: "r2",
    version: "2",
    sourceType: "server",
    installState: "update-available",
    manifest: { ...plugin.manifest, version: "2" },
  };
  const snapshot = {
    version: 1,
    settingsPage: true,
    ghosts: [plugin],
    market: { items: [market], unavailableCustomSourceNames: [] },
  };
  // A stand-in operation is over at once: it gives back the page slot it was handed (as the real controller does).
  const settleHold = async (...args: any[]) => { args.find((arg) => arg && typeof arg.onSettled === "function")?.onSettled(); };
  const controller = {
    uninstall: vi.fn(settleHold),
    install: vi.fn(settleHold),
    refresh: vi.fn().mockResolvedValue(undefined),
    getState: () => fixture.management.state,
  };
  fixture.management = {
    state: {
      capability: "supported",
      snapshot,
      online: true,
      busy: false,
      outcome: "idle",
    },
    controller,
  };
  fixture.marketRead.mockResolvedValue(market);
  return { plugin, market, snapshot, controller };
}
it("binds update and uninstall to the selected physical installation", async () => {
  const { plugin, market, controller } = managedScreen();
  await openDetail();
  const menu = fixture.props.get("header").rightToolbar.props;
  expect(menu.nativeToolbar).toBe(true);
  expect(fixture.props.get("header").right).toBeUndefined();
  expect(menu.actions.map((a: any) => a.id)).toEqual(["update", "uninstall"]);
  // The computer's label for the action ("Update to v{{version}}").
  expect(menu.actions[0].title).toBe("plugins.management.updateTo");
  await act(async () => menu.onAction("update"));
  expect(controller.install).toHaveBeenCalledWith(market, plugin, expect.objectContaining({ guard: expect.any(Function) }));
  await act(async () => menu.onAction("uninstall"));
  const buttons = fixture.alert.mock.calls.at(-1)![2];
  expect(controller.uninstall).not.toHaveBeenCalled();
  await act(async () => buttons[1].onPress());
  expect(controller.uninstall).toHaveBeenCalledWith(plugin, expect.objectContaining({ guard: expect.any(Function) }));
  expect(fixture.props.get("managementScope")[0]).toBe("mac");
});
// Preflight can fail before an operation ID exists; the removed status strip must not swallow that failure.
it.each(["update", "uninstall"])("reports %s preflight failure without an operation ID", async (action) => {
  const { controller } = managedScreen();
  controller[action === "update" ? "install" : "uninstall"].mockImplementation(async () => {
    fixture.management.state = { ...fixture.management.state, outcome: "failed", operationId: null, errorCode: "PLUGIN_INSTALL_CHANGED" };
  });
  await openDetail();
  await act(async () => fixture.props.get("header").rightToolbar.props.onAction(action));
  if (action === "uninstall") await act(async () => fixture.alert.mock.calls.at(-1)![2][1].onPress());
  expect(fixture.alert).toHaveBeenCalledWith("plugins.notice.title.managementFailed", undefined, [{ text: "plugins.gotIt" }]);
});
it("discards an uninstall confirmation after navigating to another plugin", async () => {
  const { controller } = managedScreen();
  await openDetail();
  act(() => fixture.props.get("header").rightToolbar.props.onAction("uninstall"));
  const confirm = fixture.alert.mock.calls.at(-1)![2][1].onPress;
  await act(async () =>
    fixture.props
      .get("directory")
      .onDetail({
        ...row(),
        key: "mac:other",
        item: { ...row().item, ref: { ...row().item.ref, id: "other" } },
      }),
  );
  await act(async () => confirm());
  expect(controller.uninstall).not.toHaveBeenCalled();
});
it("requires an explicit review when the release changed before installing", async () => {
  const { market, controller } = managedScreen();
  fixture.marketRead.mockResolvedValue({ ...market, releaseId: "r3" });
  await openDetail();
  await act(async () =>
    fixture.props.get("header").rightToolbar.props.onAction("update"),
  );
  expect(controller.install).not.toHaveBeenCalled();
  expect(controller.refresh).toHaveBeenCalled();
  expect(fixture.alert).toHaveBeenCalledWith(
    "plugins.management.releaseChanged", undefined, [{ text: "plugins.gotIt" }],
  );
});
it("mounts original settings with Host approval and retains the old-Host fallback", async () => {
  const { snapshot } = managedScreen();
  fixture.blocks = [
    {
      id: "capabilities",
      primitive: "plugin-capabilities",
      data: {
        usage: {
          taskUsable: true,
          hasSettings: true,
          approvalRequired: false,
          builtin: false,
          retired: false,
          setup: { state: "ready", missing: [], expired: [] },
          configuration: { items: [], alternatives: [] },
        },
      },
    },
  ];
  await openDetail();
  expect(fixture.props.get("originalSettings").identity).toEqual({
    deviceId: "mac",
    instanceId: "demo",
    expectedInstalledApproval: "approved:12345678-1234-4123-8123-123456789abc",
  });
  snapshot.settingsPage = false;
  await act(async () => root.render(createElement(PluginsScreen)));
  expect(fixture.props.get("detail").settingsContent).toBeUndefined();
});
// PR #10879: the remote model component had no production caller. Exercise the real
// screen and Host settings component; only transport/catalog and picker visuals are leaves.
// Minimum input: a task-capable Host and one shared model. tier: unit.
it.each([
  { tasks: true, remoteRoutes: true },
  { tasks: true, remoteRoutes: false },
  { tasks: false, remoteRoutes: false },
])("opens and saves the Host task model with tasks=$tasks remoteRoutes=$remoteRoutes", async ({ tasks, remoteRoutes }) => {
  managedScreen();
  fixture.blocks = [{ id: "capabilities", primitive: "plugin-capabilities", data: { tasks } }];
  const preferences = { revision: "tasks-1", config: {}, permissionModes: ["ask"],
    defaultPermissionMode: "ask", ...(remoteRoutes ? { remoteRoutes: true } : {}) };
  fixture.invoke.mockImplementation(async (_invoke, device, plugin, action, input) => {
    expect([device, plugin]).toEqual(["mac", "demo"]);
    if (action === "task-settings:get") return preferences;
    if (action === "task-settings:set") return { ...preferences, revision: "tasks-2", config: input.model };
  });
  await openDetail();
  const modelButton = [...element.querySelectorAll("button")].find(button => button.textContent?.includes("plugins.taskModel"));
  if (!tasks) {
    expect(modelButton).toBeUndefined();
    expect(fixture.invoke).not.toHaveBeenCalled();
    return;
  }
  expect(modelButton).toBeDefined();
  await act(async () => modelButton!.click());
  const picker = fixture.props.get("taskModelPicker");
  expect(picker.visible).toBe(true);
  if (remoteRoutes) expect(picker.unified.remote.hostDeviceId).toBe("mac");
  else expect(picker.unified.remote).toBeUndefined();
  const choice = { agent: "codex", providerId: remoteRoutes ? "shared-provider" : "host-provider",
    modelId: remoteRoutes ? "shared-model" : "host-model", effort: "high", fast: false };
  await act(async () => picker.unified.onSelect(choice, remoteRoutes ? { deviceId: "share:abc" } : undefined));
  expect(fixture.invoke).toHaveBeenCalledWith(expect.any(Function), "mac", "demo", "task-settings:set", {
    expectedRevision: "tasks-1",
    model: { agentKind: "codex", providerId: choice.providerId, model: choice.modelId,
      ...(remoteRoutes ? { agentDeviceId: "share:abc" } : {}), effort: "high", fastMode: false },
  });
  expect(fixture.props.get("taskModelPicker").visible).toBe(false);
  if (remoteRoutes) expect(element.textContent).toContain("plugins.remoteQuickAnswerHint");
  const originalMounts = fixture.originalSettingsMounts;
  fixture.management.state.online = false;
  await act(async () => root.render(createElement(PluginsScreen)));
  expect(element.textContent).not.toContain("plugins.taskModel");
  expect(fixture.originalSettingsMounts).toBe(originalMounts);
  fixture.management.state.online = true;
  await act(async () => root.render(createElement(PluginsScreen)));
  expect(element.textContent).toContain("plugins.taskModel");
  expect(fixture.originalSettingsMounts).toBe(originalMounts);
  fixture.online = false;
  await act(async () => root.render(createElement(PluginsScreen)));
  expect(element.textContent).not.toContain("plugins.taskModel");
  const calls = fixture.invoke.mock.calls.length;
  expect(await picker.unified.onSelect({ agent: "codex", providerId: "shared-provider",
    modelId: "shared-model", effort: "high", fast: false }, { deviceId: "share:abc" })).toBe(false);
  expect(fixture.invoke).toHaveBeenCalledTimes(calls);
});
// Production screen → hook → controller → client. Transport and visual leaves remain isolated.
/**
 * The transport stand-in follows the production order (DeviceLinkContext.invoke → sendInvoke → client.invoke; see
 * plugin-mobile-implementation.md and the contract test in historyViewProvider.test.tsx): `preSend` runs at entry,
 * the request may then wait (queue, reconnect), and `preSend` runs again right before the first socket write, where
 * `onRequestWritten` runs. A reply that never comes after the write is a transport timeout marked `inFlight`.
 */
async function transportSend<T>(options: any, write: () => T | Promise<T>, queue?: () => Promise<void> | undefined): Promise<T> {
  options?.preSend?.();
  const queued = queue?.();
  if (queued) await queued;
  options?.preSend?.();
  // The first socket write of this request: from here on a lost reply is an unknown outcome.
  options?.onRequestWritten?.();
  try { return await write(); }
  catch (error) {
    if (!/\[TIMEOUT\]/.test(String((error as Error)?.message))) throw error;
    const timeout = new DeviceLinkError("INVOKE_TIMEOUT", "no reply within the timeout after first socket write");
    timeout.inFlight = true;
    throw timeout;
  }
}
function realManagementHost() {
  const { plugin, market, snapshot } = managedScreen();
  Object.assign(plugin.manifest, { schemaVersion: 3 });
  Object.assign(market, { description: null, author: null, scope: "public", organizationId: null,
    defaultInstall: false, publishedAt: "", icon: null, enabled: true, sourceMarketName: null });
  Object.assign(market.manifest, { schemaVersion: 3 });
  Object.assign(snapshot.market, { unavailableReason: null, customSourceNames: [] });
  fixture.realManagement = true;
  fixture.wire.mockImplementation(async (_host, channel, args, options) => transportSend(options, () => {
    if (channel.endsWith(":manifest")) return { collections: [{ id: "plugins", actions: [{ id: "management:snapshot" }] }] };
    const request = args[0];
    if (request.actionId === "management:snapshot") return { result: snapshot };
    if (request.actionId === "management:market-detail") return { result: market };
    throw new Error("Unexpected action " + request.actionId);
  }));
  return { plugin, market, snapshot };
}
// Codex review (c656f8da): on a wide screen the market stays beside an installed detail. While an update read its
// market detail, the market could start an install, and both reached begin with two consent sheets.
it("holds the management slot while an update reads its market detail, so the market cannot install beside it", async () => {
  const { snapshot, market } = realManagementHost();
  fixture.width = 900;
  const other = { ...marketItem("other", "Other"), pluginId: "market/other" };
  let releaseDetail!: () => void;
  const held = new Promise<void>((resolve) => { releaseDetail = resolve; });
  let holdUpdateDetail = true;
  fixture.wire.mockImplementation(async (_host: string, channel: string, args: any[], options: any) => {
    options?.preSend?.(); options?.onRequestWritten?.();
    if (channel.endsWith(":manifest")) return { collections: [{ id: "plugins", actions: [{ id: "management:snapshot" }] }] };
    const request = args[0];
    if (request.actionId === "management:snapshot") {
      if (request.input?.read === "capabilities") return { result: { catalogPaging: true } };
      if (request.input?.read === "catalog") return { result: marketPage([other]) };
      return { result: snapshot };
    }
    if (request.actionId === "management:market-detail") {
      if (request.input?.pluginId === market.pluginId && holdUpdateDetail) { holdUpdateDetail = false; await held; }
      return { result: request.input?.pluginId === market.pluginId ? market : { ...other, manifest: { schemaVersion: 3, id: "other", name: "Other", version: "1" } } };
    }
    if (request.actionId === "management:begin") return { result: { operationId: request.input.operationId, phase: "running" } };
    if (request.actionId === "management:operation") return { result: { operationId: request.input.operationId, phase: "running" } };
    throw new Error("Unexpected action " + request.actionId);
  });
  await openDetail();
  await act(async () => fixture.props.get("directory").onSegmentChange("market"));
  await settle(14);
  expect(shownMarket().items.map((item: any) => item.pluginId)).toEqual(["market/other"]);
  await act(async () => { void fixture.props.get("header").rightToolbar.props.onAction("update"); });
  await settle(6);
  expect(holdUpdateDetail).toBe(false);
  // The update is still reading its detail: the market offers no install and a press sends nothing.
  expect(shownMarket()).toMatchObject({ canInstall: false });
  await act(async () => shownMarket().install(shownMarket().items[0]));
  await settle(14);
  const begins = () => fixture.wire.mock.calls.map((call) => call[2]?.[0]).filter((request) => request?.actionId === "management:begin");
  expect(begins()).toHaveLength(0);
  await act(async () => { releaseDetail(); });
  await settle(14);
  // Only the update reaches begin.
  expect(begins().map((request) => request.input.pluginId)).toEqual([market.pluginId]);
});
/* 测试价值（维护者 15:37 复审第 1、2 条；调度要求的结构性收口）
 * - 生产入口与可观察结果：真实 PluginsScreen、真实 PluginTaskSettings 表单、真实 usePluginMarket 与管理
 *   client / controller，只替换设备互联的传输；观察写向 Host 的请求（market-detail、begin、开关、task-settings:set）
 *   与各入口显示是否可用。
 * - 依据：页面只有一个同步占用（pluginManagementSlot.ts）：按下即 tryAcquire，只有持有者的凭据能释放，卸载 / 重新
 *   挂载不释放也不重置；各入口的「不可用」只是它的投影。
 * - 缺口：入口各自用渲染态、ref 或表单本地锁判断；同一次渲染的两个回调、重新挂载的表单都能再写一次。
 * - 最小失败输入：任务设置保存挂起时换详情再保存（第二笔写出）；同一个 act 里先后交付市场安装与页面批准（两条
 *   begin）。tier: unit；每个用例只渲染一次页面，传输为同步替身。
 */
describe("one page slot for every entry (real components, three ways of delivering the second press)", () => {
  const entries = ["market install", "update", "uninstall", "enable switch", "page approval", "task settings"] as const;
  type Entry = typeof entries[number];
  /** Which entry a request written to the Host belongs to. */
  const owner = (request: string): Entry => request === "market-detail:other" || request === "begin:install:market/other" ? "market install"
    : request === "market-detail:update" || request === "begin:install:market/demo" ? "update"
      : request === "begin:uninstall" ? "uninstall" : request === "begin:approve-ui" ? "page approval"
        : request === "switch" ? "enable switch" : "task settings";
  async function screen() {
    const { plugin, snapshot, market } = realManagementHost();
    Object.assign(plugin.manifest, { tools: [{ name: "open" }], mcpApps: { ui: { resources: [{ uri: "ui://form", file: "ui/form.html" }], tools: { open: { resourceUri: "ui://form" } } } } });
    Object.assign(snapshot, { uiCapabilityApproval: true });
    // A second installed plugin, to switch the detail away and back (remounting the detail, its form and controller).
    const second = { ...plugin, instanceKey: "demo-b", manifest: { ...plugin.manifest, id: "demo-b", name: "Demo B" } };
    snapshot.ghosts.push(second as any);
    fixture.extraRows = [{ ...row(), key: "mac:plugin-b", item: { ...row().item, ref: { collectionId: "plugins", kind: "plugin", id: "demo-b" }, display: { title: "Demo B" } } }];
    fixture.blocks = [{ id: "capabilities", primitive: "plugin-capabilities", data: { tasks: true } }];
    fixture.width = 900;
    const other = { ...marketItem("other", "Other"), pluginId: "market/other" };
    // Every first request of an entry waits here until `release`; afterwards operations end at once (cancelled).
    let holding = true;
    const gates: Array<() => void> = [];
    const held = () => holding ? new Promise<void>((resolve) => { gates.push(resolve); }) : Promise.resolve();
    const writes: string[] = [];
    const preferences = { revision: "tasks-1", config: {}, permissionModes: ["ask"], defaultPermissionMode: "ask" };
    fixture.wire.mockImplementation(async (_host: string, channel: string, args: any[], options: any) => {
      options?.preSend?.(); options?.onRequestWritten?.();
      if (channel.endsWith(":manifest")) return { collections: [{ id: "plugins", actions: [{ id: "management:snapshot" }] }] };
      const request = args[0];
      if (request.actionId === "management:snapshot") {
        if (request.input?.read === "capabilities") return { result: { catalogPaging: true } };
        if (request.input?.read === "catalog") return { result: marketPage([other]) };
        return { result: snapshot };
      }
      if (request.actionId === "management:market-detail") {
        const isOther = request.input?.pluginId === other.pluginId;
        writes.push(isOther ? "market-detail:other" : "market-detail:update");
        await held();
        return { result: isOther ? { ...other, manifest: { schemaVersion: 3, id: "other", name: "Other", version: "1" } } : market };
      }
      if (request.actionId === "management:begin") {
        writes.push(`begin:${request.input.kind}${request.input.kind === "install" ? ":" + request.input.pluginId : ""}`);
        await held();
        return { result: { operationId: request.input.operationId, phase: "cancelled" } };
      }
      if (request.actionId === "management:operation") return { result: { operationId: request.input.operationId, phase: "cancelled" } };
      if (request.actionId === "management:cancel") return { result: { operationId: request.input.operationId, phase: "cancelled" } };
      throw new Error("Unexpected action " + request.actionId);
    });
    fixture.invoke.mockImplementation(async (_invoke: unknown, _device: string, _plugin: string, action: string) => {
      if (action === "task-settings:get") return preferences;
      if (action === "task-settings:set") { writes.push("task-settings"); await held(); return preferences; }
      writes.push("switch"); await held(); return {};
    });
    const openOn = async (id: "demo" | "demo-b") => {
      const target = id === "demo" ? row() : fixture.extraRows[0];
      await act(async () => fixture.props.get("directory").onDetail(target));
      await settle(8);
    };
    await openDetail();
    await settle(8);
    await act(async () => fixture.props.get("directory").onSegmentChange("market"));
    await settle(14);
    const menu = (id: string) => fixture.props.get("header").rightToolbar.props.actions.find((action: any) => action.id === id);
    const approval = () => fixture.props.get("detail").uiApprovalNotice?.actions?.[0];
    const modelButton = () => [...element.querySelectorAll("button")].find((button) => button.textContent?.includes("plugins.taskModel"));
    const available: Record<Entry, () => boolean> = {
      "market install": () => shownMarket().canInstall === true,
      update: () => !!menu("update") && !menu("update").disabled,
      uninstall: () => !!menu("uninstall") && !menu("uninstall").disabled,
      "enable switch": () => fixture.props.get("detail").busy === false,
      "page approval": () => approval()?.disabled === false,
      "task settings": () => !!modelButton() && !(modelButton() as HTMLButtonElement).disabled,
    };
    const choice = { agent: "codex", providerId: "host-provider", modelId: "host-model", effort: "high", fast: false };
    /** What a press does, bound to the current render (it may be delivered later, from a stale render). */
    const press = async (entry: Entry): Promise<() => void> => {
      if (entry === "market install") { const m = shownMarket(); return () => { void m.install(m.items[0]); }; }
      if (entry === "update" || entry === "uninstall") {
        const toolbar = fixture.props.get("header").rightToolbar.props;
        return () => {
          const alerts = fixture.alert.mock.calls.length;
          void toolbar.onAction(entry);
          // The uninstall alert's destructive button, pressed right away.
          if (entry === "uninstall" && fixture.alert.mock.calls.length > alerts) void fixture.alert.mock.calls.at(-1)![2][1].onPress();
        };
      }
      if (entry === "enable switch") { const detail = fixture.props.get("detail"); return () => { void detail.onEnabledChange(false); }; }
      if (entry === "page approval") { const action = approval(); return () => { action?.onPress(); }; }
      // Task settings: open the model picker (sends nothing); choosing saves.
      const button = modelButton();
      if (!button) return () => {};
      await act(async () => button.click());
      const picker = fixture.props.get("taskModelPicker");
      return () => { void picker.unified.onSelect(choice, undefined); };
    };
    const release = async () => {
      holding = false;
      await act(async () => { gates.splice(0).forEach((open) => open()); });
      await settle(20);
    };
    /** The holder's views go away and come back: another plugin's detail and back, narrow and wide again. */
    const remount = async () => {
      await openOn("demo-b");
      fixture.width = 400;
      await act(async () => root.render(createElement(PluginsScreen)));
      fixture.width = 900;
      await act(async () => root.render(createElement(PluginsScreen)));
      await openOn("demo");
      await act(async () => fixture.props.get("directory").onSegmentChange("installed"));
      await act(async () => fixture.props.get("directory").onSegmentChange("market"));
      await settle(14);
    };
    /** The whole plugins page goes away and is opened again (no selection, the installed list). */
    const pageAgain = async () => {
      await act(async () => root.render(createElement("div")));
      await settle(6);
      fixture.props.delete("plugins.slotHolder");
      await act(async () => root.render(createElement(PluginsScreen)));
      await settle(14);
    };
    /** Lets only the oldest held request through (for example a preparation read, so the write behind it waits). */
    const step = async () => { await act(async () => { gates.shift()?.(); }); await settle(14); };
    return { available, press, release, remount, writes, openOn, pageAgain, step };
  }
  const pairs = entries.flatMap((first) => entries.map((second) => [first, second] as const));
  const third = (first: Entry, second: Entry) => entries.find((entry) => entry !== first && entry !== second)!;
  const ownersAfter = (writes: string[], from: number) => [...new Set(writes.slice(from).map(owner))];
  it.each(pairs.filter(([first, second]) => first !== second))(
    "① while %s is in flight, %s pressed (fresh or stale) sends nothing", async (first, second) => {
      const s = await screen();
      for (const entry of [first, second]) expect(s.available[entry](), `${entry} before`).toBe(true);
      const stale = await s.press(second);
      (await s.press(first))();
      await settle(10);
      expect(s.available[second](), `${second} while ${first}`).toBe(false);
      expect(s.available[third(first, second)](), `third entry while ${first}`).toBe(false);
      const sent = s.writes.length;
      await act(async () => stale());
      await act(async () => (await s.press(second))());
      await settle(10);
      expect(ownersAfter(s.writes, sent)).toEqual([]);
      expect(ownersAfter(s.writes, 0)).toEqual([first]);
      await s.release();
      expect(s.available[third(first, second)](), `third entry after ${first}`).toBe(true);
    });
  it.each(pairs)("② %s and %s pressed in the same act: only the first starts", async (first, second) => {
    const s = await screen();
    const a = await s.press(first), b = await s.press(second);
    await act(async () => { a(); b(); });
    await settle(10);
    expect(ownersAfter(s.writes, 0)).toEqual([first]);
    // Pressed twice: still one request of its own.
    if (first === second) expect(s.writes.filter((write) => owner(write) === first && !write.startsWith("market-detail")).length
      + s.writes.filter((write) => write.startsWith("market-detail")).length).toBe(1);
    await s.release();
  });
  it.each(pairs)("③ %s in flight, its views mounted again, then %s pressed: nothing sent", async (first, second) => {
    const s = await screen();
    (await s.press(first))();
    await settle(10);
    const sent = s.writes.length;
    await s.remount();
    expect(s.available[second](), `${second} after remounting`).toBe(false);
    await act(async () => (await s.press(second))());
    await settle(10);
    expect(ownersAfter(s.writes, sent)).toEqual([]);
    await s.release();
    expect(s.available[third(first, second === first ? third(first, first) : second)]()).toBe(true);
  });
  // Dispatcher request G: each of the six entries, with its request in flight, survives the whole page going away: the
  // page says which plugin on which computer holds the slot and goes to it; nothing is sent again; once the request
  // settles, the notice goes and the entries come back. (After the app process restarts, nothing is kept: the slot and
  // the operation are in memory only, and the installed state shows the result; see plugin-mobile-implementation.md.)
  it.each(entries.map((entry) => [entry] as const))("keeps %s findable and checkable after the whole page is opened again", async (entry) => {
    const s = await screen();
    (await s.press(entry))();
    await settle(10);
    // A market install's own detail read goes through: it is then handed to its controller and waits on begin.
    if (entry === "market install") await s.step();
    const sent = s.writes.length;
    await s.pageAgain();
    const notice = fixture.props.get("plugins.slotHolder");
    expect(notice, "a notice names the holder").toBeDefined();
    expect(notice.title).toBe("plugins.slot.holder");
    await act(async () => notice.actions[0].onPress());
    await settle(14);
    // Gone to it: the market (install) or the plugin's detail; nothing was sent again.
    if (entry === "market install") expect(shownMarket().installBusy).toBe(true);
    else expect(fixture.props.get("detail")?.row?.item?.ref?.id).toBe("demo");
    expect(s.writes.slice(sent)).toEqual([]);
    await s.release();
    fixture.props.delete("plugins.slotHolder");
    await act(async () => root.render(createElement(PluginsScreen)));
    expect(fixture.props.has("plugins.slotHolder")).toBe(false);
    expect(pluginManagementSlotFor().holder()).toBeNull();
  });
  // The maintainer's own steps: plugin A's task settings save is in flight; switch to plugin B and save there.
  it("keeps a second task settings save from another plugin's form while the first is in flight", async () => {
    const s = await screen();
    (await s.press("task settings"))();
    await settle(10);
    await s.openOn("demo-b");
    expect(s.available["task settings"]()).toBe(false);
    await act(async () => (await s.press("task settings"))());
    await settle(10);
    expect(s.writes.filter((write) => write === "task settings" || write === "task-settings")).toEqual(["task-settings"]);
    // The market stays unavailable until the first save is over, then comes back.
    expect(shownMarket().canInstall).toBe(false);
    await s.release();
    expect(shownMarket().canInstall).toBe(true);
  });
});
/* 测试价值（调度要求：释放路径逐条列出并测；规则表见 plugin-mobile-implementation.md）
 * - 生产入口与可观察结果：真实 PluginsScreen + 管理 client / controller（传输替身），从已装详情的「更新」进入；
 *   观察页面占用的持有者。
 * - 依据：占用只由持有者释放；结束、失败、拒绝、预检拒绝都释放；断线转入「结果待确认」时，自动查询还能得到结果或
 *   结果仍在界面上可核实时保持，离开且再无自动进展时放开；离开页面时操作跟到结束再释放；换账号时释放。
 * - 缺口：漏释放会永久锁死其它入口；提前释放会让第二项在第一项结束前写出。
 * - 最小失败输入：每条路径各一次。tier: unit。
 */
describe("page slot release paths", () => {
  const holder = () => pluginManagementSlotFor().holder();
  async function updateScreen(host: { begin?: (request: any) => unknown; operation?: (request: any) => unknown; answer?: (request: any) => unknown;
    detail?: () => unknown; cancel?: (request: any) => unknown; refuseCancel?: () => boolean }) {
    const { snapshot, market } = realManagementHost();
    fixture.width = 900;
    const requests: string[] = [], asked: string[] = [];
    fixture.wire.mockImplementation(async (_host: string, channel: string, args: any[], options: any) => {
      if (args?.[0]?.actionId) asked.push(args[0].actionId);
      // Refused before its first write (no write receipt): never written.
      if (args?.[0]?.actionId === "management:cancel" && host.refuseCancel?.()) throw new Error("refused before the first write");
      return transportSend(options, async () => {
      if (channel.endsWith(":manifest")) return { collections: [{ id: "plugins", actions: [{ id: "management:snapshot" }] }] };
      const request = args[0];
      requests.push(request.actionId);
      if (request.actionId === "management:snapshot") return { result: snapshot };
      if (request.actionId === "management:market-detail") return { result: host.detail ? host.detail() : market };
      const respond = request.actionId === "management:begin" ? host.begin : request.actionId === "management:operation" ? host.operation
        : request.actionId === "management:answer" ? host.answer : request.actionId === "management:cancel" ? host.cancel : undefined;
      if (!respond) throw new Error("Unexpected action " + request.actionId);
      return { result: await respond(request) };
      });
    });
    fixture.extraRows = [{ ...row(), key: "mac:plugin-b", item: { ...row().item, ref: { collectionId: "plugins", kind: "plugin", id: "demo-b" }, display: { title: "Demo B" } } }];
    await openDetail();
    await settle(8);
    const update = async () => { await act(async () => { void fixture.props.get("header").rightToolbar.props.onAction("update"); }); await settle(14); };
    /** Leave this detail for another plugin's (the update's view goes away). */
    const leave = async () => { await act(async () => fixture.props.get("directory").onDetail(fixture.extraRows[0])); await settle(14); };
    const writes = () => asked.filter((id) => !["management:snapshot", "management:market-detail"].includes(id));
    return { update, requests, market, leave, writes };
  }
  const receiptOf = (request: any, phase: string, extra: Record<string, unknown> = {}) => ({ operationId: request.input.operationId, phase, ...extra });
  it("releases it when the update succeeds", async () => {
    const s = await updateScreen({ begin: (request) => receiptOf(request, "succeeded") });
    await s.update();
    expect(holder()).toBeNull();
  });
  it("releases it when the update fails on the computer", async () => {
    const s = await updateScreen({ begin: (request) => receiptOf(request, "failed", { errorCode: "PACKAGE_CHANGED" }) });
    await s.update();
    expect(holder()).toBeNull();
  });
  it("releases it when the person rejects the confirmation", async () => {
    const s = await updateScreen({ begin: (request) => ({ ...demoConsent(request), consent: { ...demoConsent(request).consent, facts: {
      kind: "update", ghostId: "demo", name: "Demo", version: "2", previousVersion: "1", added: [], removed: [], unchangedCount: 0, builtinOauthClientChanged: false } } }),
      answer: (request) => receiptOf(request, "cancelled") });
    await s.update();
    expect(holder()).toMatchObject({ entry: "update" });
    await act(async () => { await fixture.props.get("observedManagement").controller.answer(false); });
    await settle(14);
    expect(holder()).toBeNull();
  });
  it("releases it at once when the preflight read refuses the update, sending nothing", async () => {
    const s = await updateScreen({ detail: () => ({ ...realManagementHost().market, releaseId: "r3" }) });
    await s.update();
    expect(s.requests).not.toContain("management:begin");
    expect(holder()).toBeNull();
  });
  it("keeps it while an unknown result can still settle by itself, and releases it when it does", async () => {
    let settled = false;
    const s = await updateScreen({
      begin: () => { throw new Error("[TIMEOUT] remote invoke timed out"); },
      operation: (request) => receiptOf(request, settled ? "succeeded" : "running"),
    });
    await s.update();
    expect(fixture.props.get("observedManagement").state.outcome).toBe("unknown");
    expect(holder()).toMatchObject({ entry: "update" });
    settled = true;
    await act(async () => { await fixture.props.get("observedManagement").controller.reconcile(); });
    await settle(14);
    expect(holder()).toBeNull();
  });
  it("keeps it while a stopped unknown result is shown, and lets it go once that view is gone", async () => {
    const s = await updateScreen({
      begin: () => { throw new Error("[TIMEOUT] remote invoke timed out"); },
      operation: () => { throw new Error("[INVALID_RESPONSE] nonsense"); },
    });
    await s.update();
    await act(async () => { await fixture.props.get("observedManagement").controller.reconcile(); });
    await settle(14);
    expect(fixture.props.get("observedManagement").controller.lookupsStopped()).toBe(true);
    // Still shown: "Check result" is right there, so the slot stays with it.
    expect(holder()).toMatchObject({ entry: "update" });
    await act(async () => root.render(createElement("div")));
    await settle(6);
    expect(holder()).toBeNull();
  });
  it("follows an update to its end after the page is left, then releases it", async () => {
    let finish!: () => void;
    const s = await updateScreen({ begin: (request) => new Promise((resolve) => { finish = () => resolve(receiptOf(request, "succeeded")); }) });
    await s.update();
    expect(s.requests).toContain("management:begin");
    await act(async () => root.render(createElement("div")));
    await settle(6);
    // Left the page: the operation is still under way and keeps the slot.
    expect(holder()).toMatchObject({ entry: "update" });
    await act(async () => { finish(); });
    await settle(14);
    expect(holder()).toBeNull();
  });
  const updateConsent = (request: any) => ({ ...demoConsent(request), consent: { ...demoConsent(request).consent, facts: {
    kind: "update", ghostId: "demo", name: "Demo", version: "2", previousVersion: "1", added: [], removed: [], unchangedCount: 0, builtinOauthClientChanged: false } } });
  // Maintainer review 17:43 (the three cases he ran), on the real screen and its retained controller. Each asserts every
  // management request asked for, in order, and when the slot goes.
  it("17:43 a: leaving an unanswered consent asks for one cancel; refused before writing, it lets go, nothing more", async () => {
    const s = await updateScreen({ begin: updateConsent, refuseCancel: () => true });
    await s.update();
    await s.leave();
    expect(s.writes()).toEqual(["management:begin", "management:cancel"]);
    expect(holder()).toBeNull();
  });
  it("17:43 b: a written cancel whose reply is lost is only looked up afterwards, never asked for again", async () => {
    let cancelled = false;
    const s = await updateScreen({ begin: updateConsent,
      cancel: () => { cancelled = true; throw new Error("[TIMEOUT] remote invoke timed out"); },
      operation: () => { throw new Error("[INVALID_RESPONSE] nonsense"); } });
    await s.update();
    const controller = fixture.props.get("observedManagement").controller;
    await s.leave();
    expect(cancelled).toBe(true);
    expect(holder()).toMatchObject({ entry: "update" });
    await act(async () => { await controller.reconcile(); });
    await settle(14);
    expect(s.writes()).toEqual(["management:begin", "management:cancel", "management:operation"]);
    expect(holder()).toBeNull();
  });
  it("17:43 c: an update whose Allow was written is never cancelled by leaving, even after its lookups stopped", async () => {
    const s = await updateScreen({ begin: updateConsent,
      answer: () => { throw new Error("[TIMEOUT] remote invoke timed out"); },
      operation: () => { throw new Error("[INVALID_RESPONSE] nonsense"); } });
    await s.update();
    await act(async () => { await fixture.props.get("observedManagement").controller.answer(true); });
    await settle(14);
    await act(async () => { await fixture.props.get("observedManagement").controller.reconcile(); });
    await settle(14);
    await s.leave();
    expect(s.writes()).toEqual(["management:begin", "management:answer", "management:operation"]);
    expect(holder()).toBeNull();
  });
  // Switching accounts: covered with the real account owner in pluginManagement.test.ts ("page management slot").
  // Self-check (same method as the maintainer: production client / controller, another order of events): leaving an
  // unanswered confirmation for another plugin's detail cancels it, as leaving always did, and the slot stays with it
  // until that cancel is over; nothing else starts meanwhile.
  it("cancels an unanswered confirmation left for another plugin's detail, and keeps the slot until the cancel settles", async () => {
    let finishCancel!: () => void;
    const s = await updateScreen({ begin: (request) => ({ ...demoConsent(request), consent: { ...demoConsent(request).consent, facts: {
      kind: "update", ghostId: "demo", name: "Demo", version: "2", previousVersion: "1", added: [], removed: [], unchangedCount: 0, builtinOauthClientChanged: false } } }) });
    fixture.extraRows = [{ ...row(), key: "mac:plugin-b", item: { ...row().item, ref: { collectionId: "plugins", kind: "plugin", id: "demo-b" }, display: { title: "Demo B" } } }];
    const wire = fixture.wire.getMockImplementation()!;
    fixture.wire.mockImplementation(async (host: string, channel: string, args: any[], options: any) => {
      if (args?.[0]?.actionId === "management:cancel") {
        s.requests.push("management:cancel");
        options?.preSend?.(); options?.onRequestWritten?.();
        await new Promise<void>((resolve) => { finishCancel = resolve; });
        return { result: { operationId: args[0].input.operationId, phase: "cancelled" } };
      }
      return wire(host, channel, args, options);
    });
    await s.update();
    expect(fixture.props.get("observedManagement").state.outcome).toBe("confirmation");
    await act(async () => fixture.props.get("directory").onDetail(fixture.extraRows[0]));
    await settle(10);
    expect(s.requests).toContain("management:cancel");
    expect(holder()).toMatchObject({ entry: "update" });
    await act(async () => { finishCancel(); });
    await settle(14);
    expect(holder()).toBeNull();
    expect(s.requests.filter((request) => request === "management:begin")).toHaveLength(1);
  });
});
// Codex review of b93ba486: on a wide screen the market sits beside an installed detail. While a market install was
// still in its preflight, the installed detail's page approval stayed available, so two controllers could each reach a
// confirmation. Every installed-detail entry that starts a management operation shares the one slot.
// Minimal failing input: one held market preflight; the page-approval action, the toggle and the menu while it waits.
it("keeps every installed-detail management entry unavailable while a market install is preparing", async () => {
  const { plugin, snapshot } = realManagementHost();
  Object.assign(plugin.manifest, { tools: [{ name: "open" }], mcpApps: { ui: { resources: [{ uri: "ui://form", file: "ui/form.html" }], tools: { open: { resourceUri: "ui://form" } } } } });
  Object.assign(snapshot, { uiCapabilityApproval: true });
  fixture.width = 900;
  const other = { ...marketItem("other", "Other"), pluginId: "market/other" };
  let releaseDetail!: () => void;
  const held = new Promise<void>((resolve) => { releaseDetail = resolve; });
  let holding = false;
  fixture.wire.mockImplementation(async (_host: string, channel: string, args: any[], options: any) => {
    options?.preSend?.(); options?.onRequestWritten?.();
    if (channel.endsWith(":manifest")) return { collections: [{ id: "plugins", actions: [{ id: "management:snapshot" }] }] };
    const request = args[0];
    if (request.actionId === "management:snapshot") {
      if (request.input?.read === "capabilities") return { result: { catalogPaging: true } };
      if (request.input?.read === "catalog") return { result: marketPage([other]) };
      return { result: snapshot };
    }
    if (request.actionId === "management:market-detail") {
      if (holding) await held;
      return { result: { ...other, manifest: { schemaVersion: 3, id: "other", name: "Other", version: "1" } } };
    }
    throw new Error("Unexpected action " + request.actionId);
  });
  await openDetail();
  await act(async () => fixture.props.get("directory").onSegmentChange("market"));
  await settle(14);
  const approval = () => fixture.props.get("detail").uiApprovalNotice?.actions?.[0];
  expect(approval()).toMatchObject({ testID: "plugins.uiApproval.enable", disabled: false });
  expect(fixture.props.get("detail").busy).toBe(false);
  holding = true;
  await act(async () => { void shownMarket().install(shownMarket().items[0]); });
  await settle(6);
  expect(shownMarket()).toMatchObject({ installBusy: true });
  expect(approval()).toMatchObject({ disabled: true });
  expect(fixture.props.get("detail").busy).toBe(true);
  for (const action of fixture.props.get("header").rightToolbar.props.actions) expect(action.disabled).toBe(true);
  await act(async () => { releaseDetail(); });
  await settle(14);
});
// Codex review of b93ba486: with the market beside an installed detail, an uninstall there refreshed only the installed
// list; the market kept the computer's old pages (which, excluding installed plugins, lack the removed one) and old
// counts. A successful operation in the installed detail, or a burst of `plugins` change notifications from that
// computer, makes its market lists and counts read again (one read per burst). Minimal failing input: one uninstall;
// three notifications in a row. Tier: unit (jsdom, in-memory Host).
describe("market cache after plugin changes on the computer", () => {
  const setup = () => {
    const { snapshot } = realManagementHost();
    fixture.width = 900;
    const other = { ...marketItem("other", "Other"), pluginId: "market/other" };
    const reads = { pages: 0, counts: 0 };
    fixture.wire.mockImplementation(async (_host: string, channel: string, args: any[], options: any) => {
      options?.preSend?.(); options?.onRequestWritten?.();
      if (channel.endsWith(":manifest")) return { collections: [{ id: "plugins", actions: [{ id: "management:snapshot" }] }] };
      const request = args[0];
      if (request.actionId === "management:snapshot") {
        if (request.input?.read === "capabilities") return { result: { catalogPaging: true } };
        if (request.input?.read === "catalog") {
          if (request.input.query?.counts) reads.counts += 1; else reads.pages += 1;
          return { result: marketPage([other]) };
        }
        return { result: snapshot };
      }
      if (request.actionId === "management:begin") return { result: { operationId: request.input.operationId, phase: "succeeded" } };
      throw new Error("Unexpected action " + request.actionId);
    });
    return reads;
  };
  const showBoth = async () => {
    await openDetail();
    await act(async () => fixture.props.get("directory").onSegmentChange("market"));
    await settle(14);
  };
  it("reads the market of that computer again after an uninstall in the installed detail", async () => {
    const reads = setup();
    await showBoth();
    const before = { ...reads };
    expect(before.pages).toBeGreaterThan(0);
    await act(async () => fixture.props.get("header").rightToolbar.props.onAction("uninstall"));
    await act(async () => fixture.alert.mock.calls.at(-1)![2][1].onPress());
    await settle(14);
    expect(reads.pages).toBe(before.pages + 1);
    expect(reads.counts).toBe(before.counts + 1);
  });
  it("reads it again once for a burst of plugin change notifications from that computer", async () => {
    const reads = setup();
    await showBoth();
    const before = { ...reads };
    // The coalescing window runs on fake timers (no real waiting).
    vi.useFakeTimers();
    try {
      await act(async () => {
        for (let i = 0; i < 3; i++) fixture.resourceListeners.forEach((listener) => listener("mac", { collectionId: "plugins" }));
        fixture.resourceListeners.forEach((listener) => listener("mac", { collectionId: "sessions" }));
        await vi.advanceTimersByTimeAsync(600);
      });
    } finally { vi.useRealTimers(); }
    await settle(14);
    expect(reads.pages).toBe(before.pages + 1);
    expect(reads.counts).toBe(before.counts + 1);
  });
});
// Maintainer review 05:55 #3: an installed custom-market plugin's update. The preflight tells a source the computer did
// not name (refresh or update there) apart from a source that really changed; neither reaches begin.
describe("installed custom-market update and its source", () => {
  const sourceA = { kind: "git", repository: "github.com/acme/market", sourceId: "SourceA_0123456789abcd" };
  const sourceB = { kind: "git", repository: "github.com/acme/market", sourceId: "SourceB_0123456789abcd" };
  const run = async (screenRead: unknown, controllerRead: unknown) => {
    const { snapshot, market } = realManagementHost();
    Object.assign(market, { pluginId: "custom:Team/demo", sourceType: "git-market", sourceMarketName: "Team", sourceIdentity: sourceA });
    Object.assign(snapshot.market, { customSourceNames: ["Team"] });
    let reads = 0;
    const readHost = fixture.wire.getMockImplementation()!;
    fixture.wire.mockImplementation(async (...args: any[]) => {
      const request = args[2]?.[0];
      if (request?.actionId === "management:market-detail") {
        args[3]?.preSend?.(); args[3]?.onRequestWritten?.();
        // The screen's preflight read, then the controller's last read before begin.
        const source = ++reads === 1 ? screenRead : controllerRead;
        const { sourceIdentity: _a, ...rest } = market as any;
        return { result: { ...rest, ...(source ? { sourceIdentity: source } : {}) } };
      }
      if (request?.actionId === "management:begin") throw new Error("begin must not be sent");
      return readHost(...args);
    });
    await openDetail();
    await act(async () => fixture.props.get("header").rightToolbar.props.onAction("update"));
    await settle(14);
    expect(fixture.wire.mock.calls.some((call) => call[2]?.[0]?.actionId === "management:begin")).toBe(false);
    // Android layout re-check: the alert's button is localized (RN's default "OK" showed in English).
    for (const call of fixture.alert.mock.calls) expect(call[2]).toEqual([{ text: "plugins.gotIt" }]);
    return fixture.alert.mock.calls.map((call) => call[0]);
  };
  it.each([
    ["the detail names no source", undefined, undefined, "plugins.management.sourceUnverified"],
    ["the detail names another source", sourceB, sourceB, "plugins.management.sourceChanged"],
    ["the controller's last read names another source", sourceA, sourceB, "plugins.management.sourceChanged"],
    ["the controller's last read names no source", sourceA, undefined, "plugins.management.sourceUnverified"],
  ])("stops before begin when %s", async (_name, screenRead, controllerRead, message) => {
    expect(await run(screenRead, controllerRead)).toContain(message);
  });
});
it("rejects a delayed native menu after changing selection through the real hook", async () => {
  realManagementHost();
  await openDetail();
  const menu = fixture.props.get("header").rightToolbar.props;
  await act(async () => fixture.props.get("directory").onDetail({ ...row(), key: "mac:other",
    item: { ...row().item, ref: { ...row().item.ref, id: "other" } } }));
  await act(async () => menu.onAction("uninstall"));
  expect(fixture.alert).not.toHaveBeenCalled();
  expect(fixture.wire.mock.calls.some((call) => call[2]?.[0]?.actionId === "management:begin")).toBe(false);
});
it("keeps a successful write unconfirmed when production snapshot readback fails", async () => {
  realManagementHost();
  const readHost = fixture.wire.getMockImplementation()!;
  let completed = false;
  fixture.wire.mockImplementation(async (...args) => {
    const request = args[2]?.[0];
    if (request?.actionId === "management:begin") {
      args[3]?.preSend?.(); args[3]?.onRequestWritten?.();
      completed = true;
      return { result: { operationId: request.input.operationId, phase: "succeeded" } };
    }
    if (completed && request?.actionId === "management:snapshot") throw new Error("READ_FAILED");
    return readHost(...args);
  });
  await openDetail();
  await act(async () => fixture.props.get("header").rightToolbar.props.onAction("uninstall"));
  await act(async () => fixture.alert.mock.calls.at(-1)![2][1].onPress());
  expect(completed).toBe(true);
  expect(fixture.read).toHaveBeenCalledTimes(1);
  expect(fixture.props.get("detail").row.item.ref.id).toBe("demo");
  expect(fixture.props.get("header").rightToolbar.props.actions.every((action: any) => action.disabled)).toBe(true);
});

it("isolates Host and selection changes during render before effects publish new facts", async () => {
  const { plugin } = realManagementHost();
  const renders: any[] = [];
  function Probe({ host, selection }: { host: string; selection: string }) {
    const binding = usePluginManagement(host, true, true, selection);
    renders.push({ host, selection, ...binding });
    return null;
  }
  await act(async () => root.render(createElement(Probe, { host: "mac", selection: "same-instance" })));
  const oldController = renders.at(-1).controller;
  const start = renders.length;
  await act(async () => root.render(createElement(Probe, { host: "other-mac", selection: "same-instance" })));
  expect(renders[start]).toMatchObject({ state: null, controller: null });
  await act(async () => oldController.uninstall(plugin));
  expect(fixture.wire.mock.calls.some((call) => call[2]?.[0]?.actionId === "management:begin")).toBe(false);
  const next = renders.length;
  await act(async () => root.render(createElement(Probe, { host: "other-mac", selection: "other-instance" })));
  expect(renders[next]).toMatchObject({ state: null, controller: null });
  const account = renders.length;
  fixture.accountGeneration += 1;
  await act(async () => root.render(createElement(Probe, { host: "other-mac", selection: "other-instance" })));
  expect(renders[account]).toMatchObject({ state: null, controller: null });
});


it.each(["required", "unknown"] as const)("allows %s configuration plugins to start and choose tasks without claiming configuration is ready", async (assessment) => {
  fixture.blocks = [{ id: "capabilities", data: { usage: {
    taskUsable: true, hasSettings: true, approvalRequired: false, builtin: false, retired: false,
    setup: { state: assessment, missing: ["Account"], expired: [] },
  } } }];
  await openDetail();
  const detail = fixture.props.get("detail");
  expect(detail.model.status).toBe(assessment === "unknown" ? "setupUnknown" : "setupRequired");
  expect(detail.model.missing).toEqual(["Account"]);
  await act(async () => detail.onNewTask());
  expect(fixture.push).toHaveBeenCalledWith(expect.objectContaining({ pathname: "/sessions/new" }));
  await act(async () => detail.onChooseTask());
  await act(async () => fixture.props.get("taskPicker").onSelect("pending-setup-task"));
  expect(fixture.push).toHaveBeenCalledWith(expect.objectContaining({ pathname: "/sessions/[sessionId]", params: expect.objectContaining({ sessionId: "pending-setup-task" }) }));
});

it("keeps recovery navigation and reads available during pending management while retaining local locks", async () => {
  fixture.management = { state: { outcome: "unknown", busy: false, capability: "supported", online: false, snapshot: null }, controller: null };
  fixture.online = false;
  await openDetail();
  expect(fixture.props.get("detail")).toMatchObject({ busy: true, statusRecoveryBusy: false });
  act(() => fixture.props.get("detail").onResolveStatus());
  expect(fixture.push).toHaveBeenCalledWith("/devices/manage");
  fixture.management.state.outcome = "running";
  fixture.online = true;
  fixture.read.mockRejectedValueOnce(new Error("READ_FAILED"));
  await act(async () => root.render(createElement(PluginsScreen)));
  expect(fixture.props.get("detail")).toMatchObject({ busy: true, statusRecoveryBusy: false, model: { status: "loadFailed" } });
  let finish!: (resource: any) => void;
  fixture.read.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  act(() => fixture.props.get("detail").onResolveStatus());
  expect(fixture.props.get("detail")).toMatchObject({ busy: true, statusRecoveryBusy: true });
  await act(async () => finish({ ...row().item, blocks: [] }));
  expect(fixture.props.get("detail")).toMatchObject({ busy: true, statusRecoveryBusy: false });
  expect(fixture.invoke).not.toHaveBeenCalled();
  fixture.management = { state: null, controller: null };
  await act(async () => root.render(createElement(PluginsScreen)));
  let reject!: (error: Error) => void;
  fixture.invoke.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
  act(() => fixture.props.get("detail").onEnabledChange(false));
  expect(fixture.props.get("detail")).toMatchObject({ busy: true, statusRecoveryBusy: true });
  await act(async () => reject(new Error("WRITE_FAILED")));
});


it("silently reads uncertain configuration once without clearing the detail or replacing its form identity", async () => {
  fixture.blocks = [{ id: "capabilities", primitive: "plugin-capabilities", data: { usage: { taskUsable: true, hasSettings: true, builtin: false, retired: false, approvalRequired: false, setup: { state: "unknown", missing: [], expired: [] } } } }];
  await openDetail();
  expect(fixture.read).toHaveBeenCalledTimes(2);
  expect(fixture.props.get("detail")).toMatchObject({ model: { status: "setupUnknown" }, busy: false });
  await act(async () => root.render(createElement(PluginsScreen)));
  expect(fixture.read).toHaveBeenCalledTimes(2);
  expect(fixture.alert).not.toHaveBeenCalled();
  expect(fixture.invoke).not.toHaveBeenCalled();
});


it("reports a failed management operation once without a permanent refresh card", async () => {
  fixture.management = { state: { outcome: "failed", operationId: "failed-once", busy: false, capability: "supported", online: true, snapshot: null }, controller: null };
  await openDetail();
  expect(fixture.alert).toHaveBeenCalledWith("plugins.notice.title.managementFailed", undefined, [{ text: "plugins.gotIt" }]);
  await act(async () => root.render(createElement(PluginsScreen)));
  expect(fixture.alert).toHaveBeenCalledTimes(1);
  expect(fixture.invoke).not.toHaveBeenCalled();
});


it.each(["ios", "android"])("removes only the %s plugin-list plus while retaining device selection and detail management", async (platform) => {
  fixture.platform = platform;
  managedScreen();
  await act(async () => root.render(createElement(PluginsScreen)));
  expect(fixture.props.get("header").right).toBeUndefined();
  expect(fixture.props.get("header").rightToolbar).toBeUndefined();
  if (platform === "ios") {
    expect(fixture.props.get("directory").targets).toBeDefined();
    await act(async () => fixture.props.get("directory").onDetail(row()));
  } else await act(async () => fixture.props.get("pressable.plugins.detailsFor").onPress());
  const header = fixture.props.get("header");
  const menu = platform === "ios" ? header.rightToolbar : header.right;
  expect(menu.props.actions.some((action: any) => action.id === "uninstall")).toBe(true);
});

// #12575: the roster can include a computer that yielded no list and no error.
it("only shows the Android empty directory after the selected computer replies", async () => {
  fixture.platform = "android";
  fixture.online = false;
  fixture.listHasRows = false;
  await act(async () => root.render(createElement(PluginsScreen)));
  const selectComputer = [...element.querySelectorAll("button")].find(
    (button) => button.textContent === "plugins.allComputers",
  );
  await act(async () => selectComputer!.click());
  await act(async () => fixture.alert.mock.lastCall![2][1].onPress());
  expect(element.textContent).toContain("Mac");
  expect(element.textContent).toContain("plugins.listLoadFailed");
  expect(element.textContent).not.toContain("plugins.noPlugins");

  fixture.online = true;
  await act(async () => root.render(createElement(PluginsScreen)));
  expect(element.textContent).toContain("plugins.noPlugins");
  expect(element.textContent).not.toContain("plugins.listLoadFailed");
});

it("refreshes an unknown management result using its original operation without replaying the write", async () => {
  realManagementHost();
  fixture.width = 900;
  const readHost = fixture.wire.getMockImplementation()!;
  fixture.wire.mockImplementation(async (...args) => {
    const request = args[2]?.[0];
    // Written, then the connection was lost before the reply.
    if (request?.actionId === "management:begin") { args[3]?.onRequestWritten?.(); throw new Error("CONNECTION_LOST"); }
    if (request?.actionId === "management:operation") return { result: { operationId: request.input.operationId, phase: "running" } };
    return readHost(...args);
  });
  await openDetail();
  await act(async () => fixture.props.get("header").rightToolbar.props.onAction("uninstall"));
  await act(async () => fixture.alert.mock.calls.at(-1)![2][1].onPress());
  expect(fixture.props.get("detail").busy).toBe(true);
  await act(async () => fixture.props.get("directory").onRefresh());
  const requests = fixture.wire.mock.calls.map((call) => call[2]?.[0]);
  expect(requests.filter((request) => request?.actionId === "management:begin")).toHaveLength(1);
  expect(requests.filter((request) => request?.actionId === "management:operation").map((request) => request.input.operationId)).toEqual(["screen-operation"]);
});

// Narrow detail hides the directory refresh. Recovery must remain reachable while
// mutations/settings are blocked, and query the same operation rather than replay it.
it("checks an unknown operation from the phone detail and restores actions", async () => {
  realManagementHost();
  const readHost = fixture.wire.getMockImplementation()!;
  fixture.wire.mockImplementation(async (...args) => {
    const request = args[2]?.[0];
    // Written, then the connection was lost before the reply.
    if (request?.actionId === "management:begin") { args[3]?.onRequestWritten?.(); throw new Error("CONNECTION_LOST"); }
    if (request?.actionId === "management:operation") return { result: { operationId: request.input.operationId, phase: "succeeded" } };
    return readHost(...args);
  });
  await openDetail();
  await act(async () => fixture.props.get("header").rightToolbar.props.onAction("uninstall"));
  await act(async () => fixture.alert.mock.calls.at(-1)![2][1].onPress());
  const detail = fixture.props.get("detail");
  expect(detail.busy).toBe(true);
  expect(detail.managementNotice?.actions?.[0].disabled).toBe(false);
  await act(async () => detail.managementNotice.actions[0].onPress());
  const requests = fixture.wire.mock.calls.map((call) => call[2]?.[0]);
  expect(requests.filter((request) => request?.actionId === "management:begin")).toHaveLength(1);
  expect(requests.filter((request) => request?.actionId === "management:operation").map((request) => request.input.operationId)).toEqual(["screen-operation"]);
  expect(fixture.props.get("detail").managementNotice).toBeUndefined();
  expect(fixture.props.get("detail").busy).toBe(false);
});

/* 依据：同账号的任务提示与详情必须共用 Host 批准事实，稍后只隐藏主动提示。
 * 最小输入：带 ui 声明但缺批准的已装插件；tier: unit，渲染生产入口，不检查 JSX 源码。 */
it('offers UI consent in plugin details even when the Host has suppressed its task prompt', async () => {
  const { plugin, snapshot, controller } = managedScreen();
  Object.assign(plugin.manifest, { tools: [{ name: 'open' }], mcpApps: { ui: { resources: [{ uri: 'ui://form', file: 'ui/form.html' }], tools: { open: { resourceUri: 'ui://form' } } } } });
  Object.assign(plugin, { uiPromptSuppressed: true });
  Object.assign(snapshot, { uiCapabilityApproval: true });
  const approveUi = vi.fn(async (_plugin: unknown, hold?: { onSettled(): void }) => hold?.onSettled());
  Object.assign(controller, { approveUi });
  await openDetail();
  const notice = fixture.props.get('detail').uiApprovalNotice;
  expect(notice.title).toBe('plugins.uiApproval.title');
  await act(async () => notice.actions[0].onPress());
  expect(approveUi).toHaveBeenCalledWith(plugin, expect.objectContaining({ guard: expect.any(Function) }));
  Object.assign(plugin, { uiCapabilityApproved: true });
  await act(async () => root.render(createElement(PluginsScreen)));
  expect(fixture.props.get('detail').uiApprovalNotice).toBeUndefined();
});
it('uses read-only guidance for an old Host rather than sending an unsupported page approval', async () => {
  const { plugin } = managedScreen();
  Object.assign(plugin.manifest, { tools: [{ name: 'open' }], mcpApps: { ui: { resources: [{ uri: 'ui://form', file: 'ui/form.html' }], tools: { open: { resourceUri: 'ui://form' } } } } });
  await openDetail();
  expect(fixture.props.get('detail').uiApprovalNotice).toMatchObject({ detail: 'plugins.uiApproval.updateHost', actions: undefined });
});

it('uses Host deferral for the task prompt and skips shared-task and provider-share visitors', async () => {
  const { plugin, snapshot, controller } = managedScreen();
  Object.assign(plugin.manifest, { tools: [{ name: 'open' }], mcpApps: { ui: { resources: [{ uri: 'ui://form', file: 'ui/form.html' }], tools: { open: { resourceUri: 'ui://form' } } } } });
  Object.assign(snapshot, { uiCapabilityApproval: true });
  const deferUi = vi.fn();
  Object.assign(controller, { deferUi });
  const props = { deviceId: 'mac', deviceName: 'Mac', active: true, online: true };
  await act(async () => root.render(createElement(PluginUiEnablePrompt, props)));
  const notice = fixture.props.get('plugins.uiApproval');
  expect(notice.actions).toHaveLength(2);
  await act(async () => notice.actions[1].onPress());
  expect(deferUi).toHaveBeenCalledWith(plugin);
  Object.assign(plugin, { uiPromptSuppressed: true });
  fixture.props.delete('plugins.uiApproval');
  await act(async () => root.render(createElement(PluginUiEnablePrompt, props)));
  expect(fixture.props.has('plugins.uiApproval')).toBe(false);
  for (const deviceId of [sharedTaskHostPeer('task', 'mac'), providerShareHostPeer('share', 'mac')]) {
    fixture.props.delete('managementScope');
    await act(async () => root.render(createElement(PluginUiEnablePrompt, { ...props, deviceId })));
    expect(fixture.props.has('managementScope')).toBe(false);
  }
});

/* 依据：另一个查看端选择稍后后，本端也隐藏提示；最小输入：plugins 失效推送；tier: unit。 */
it('refreshes task prompt suppression from the executing Host without storing a controller-local decision', async () => {
  const { plugin, snapshot } = realManagementHost();
  Object.assign(plugin.manifest, { tools: [{ name: 'open' }], mcpApps: { ui: { resources: [{ uri: 'ui://form', file: 'ui/form.html' }], tools: { open: { resourceUri: 'ui://form' } } } } });
  Object.assign(snapshot, { uiCapabilityApproval: true });
  await act(async () => root.render(createElement(PluginUiEnablePrompt, {
    deviceId: 'mac', deviceName: 'Mac', online: true, active: true,
  })));
  expect(fixture.props.has('plugins.uiApproval')).toBe(true);
  expect(fixture.subscribe).toHaveBeenCalledWith(expect.any(String), 'mac', ['sessions']);
  Object.assign(plugin, { uiPromptSuppressed: true });
  fixture.props.delete('plugins.uiApproval');
  await act(async () => { fixture.resourceListeners.forEach((listener) => listener('mac', { collectionId: 'plugins' })); });
  expect(fixture.props.has('plugins.uiApproval')).toBe(false);
});

// PR #10206 P2, adapted from independent acceptance: real prompt → hook →
// controller/client/shared reader, only wire and visual leaves are substituted.
// Existing prompt tests used snapshots or an extra push, masking stale consent
// after a successful mutation. Unit: fake timers, no notification after readback.
function lightweightPromptHost(change: 'defer-ui' | 'approve-ui' | 'uninstall' | 'disable', delayed = false) {
  const { plugin, snapshot } = realManagementHost();
  Object.assign(plugin.manifest, { tools: [{ name: 'open' }], mcpApps: {
    ui: { resources: [{ uri: 'ui://form', file: 'ui/form.html' }], tools: { open: { resourceUri: 'ui://form' } } },
  } });
  Object.assign(snapshot, { uiCapabilityApproval: true });
  const item = { instanceKey: plugin.instanceKey, name: plugin.manifest.name,
    approvalToken: 'approved:12345678-1234-4123-8123-123456789abc' };
  let currentItem = item, snapshotReads = 0;
  let release!: (value: unknown) => void;
  const readback = new Promise(resolve => { release = resolve; });
  fixture.wire.mockImplementation(async (_id, channel, args, opts) => {
    opts?.preSend?.(); opts?.onRequestWritten?.();
    if (channel.endsWith(':manifest')) return { collections: [{ id: 'plugins', actions: [
      { id: 'management:snapshot' }, { id: 'management:ui-consent' },
    ] }] };
    const request = args[0];
    if (request.actionId === 'management:ui-consent') return { result: { version: 1, uiCapabilityApproval: true, item: currentItem } };
    if (request.actionId === 'management:snapshot') {
      if (++snapshotReads === 2 && delayed) return readback;
      return { result: snapshot };
    }
    if (request.actionId === 'management:begin') {
      expect(request.input.kind).toBe(change);
      if (change === 'defer-ui') Object.assign(plugin, { uiPromptSuppressed: true });
      if (change === 'approve-ui') Object.assign(plugin, { uiCapabilityApproved: true });
      if (change === 'uninstall') snapshot.ghosts = [];
      if (change === 'disable') plugin.enabled = false;
      return { result: { operationId: request.input.operationId, phase: 'succeeded' } };
    }
    throw new Error('Unexpected ' + request.actionId);
  });
  fixture.promptReads = createPluginPromptReads(fixture.wire, () => true);
  return { plugin, snapshot,
    release: () => release({ result: snapshot }),
    newerItem: () => { currentItem = { ...item, instanceKey: 'other-plugin', name: 'New pending plugin' }; return currentItem; },
  };
}
it.each(['defer-ui', 'approve-ui', 'uninstall', 'disable'] as const)(
  'fresh full readback hides an older lightweight prompt after %s without a push', async change => {
    vi.useFakeTimers();
    const h = lightweightPromptHost(change);
    const container = document.createElement('div'); const localRoot = createRoot(container);
    try {
      await act(async () => localRoot.render(createElement(PluginUiEnablePrompt, {
        deviceId: 'mac', deviceName: 'Mac', online: true, active: true,
      })));
      expect(container.textContent).toContain('plugins.uiApproval.title');
      expect(fixture.wire.mock.calls.filter(c => c[2]?.[0]?.actionId === 'management:snapshot')).toHaveLength(0);
      await act(async () => {
        if (change === 'uninstall') await fixture.props.get('observedManagement').controller.uninstall(h.plugin);
        else if (change === 'disable') await fixture.props.get('observedManagement').controller.setEnabled(h.plugin, false);
        else fixture.props.get('plugins.uiApproval').actions[change === 'defer-ui' ? 1 : 0].onPress();
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(fixture.props.get('observedManagement').state.outcome).toBe('succeeded');
      const actions = fixture.wire.mock.calls.map(c => c[2]?.[0]?.actionId);
      expect(actions.filter(a => a === 'management:begin')).toHaveLength(1);
      expect(actions.filter(a => a === 'management:snapshot')).toHaveLength(2);
      expect(container.textContent).not.toContain('plugins.uiApproval.title');
      // A later lightweight read must supersede the completed full readback.
      const newer = h.newerItem();
      await act(async () => {
        fixture.resourceListeners.forEach(listener => listener('mac', { collectionId: 'plugins' }));
        await vi.advanceTimersByTimeAsync(250);
      });
      expect(container.textContent).toContain('plugins.uiApproval.title');
      expect(fixture.props.get('observedManagement').state.uiConsent?.item).toEqual(newer);
      expect(fixture.wire.mock.calls.filter(c => c[2]?.[0]?.actionId === 'management:snapshot')).toHaveLength(2);
    } finally {
      act(() => localRoot.unmount()); fixture.promptReads = null; vi.useRealTimers();
    }
  },
);
it('a newer lightweight prompt wins over a late full readback response', async () => {
  vi.useFakeTimers();
  const h = lightweightPromptHost('defer-ui', true);
  const container = document.createElement('div'); const localRoot = createRoot(container);
  try {
    await act(async () => localRoot.render(createElement(PluginUiEnablePrompt, {
      deviceId: 'mac', deviceName: 'Mac', online: true, active: true,
    })));
    await act(async () => {
      fixture.props.get('plugins.uiApproval').actions[1].onPress();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(fixture.wire.mock.calls.filter(c => c[2]?.[0]?.actionId === 'management:snapshot')).toHaveLength(2);
    const newer = h.newerItem();
    await act(async () => {
      fixture.resourceListeners.forEach(listener => listener('mac', { collectionId: 'plugins' }));
      await vi.advanceTimersByTimeAsync(250);
    });
    expect(fixture.props.get('observedManagement').state.uiConsent?.item).toEqual(newer);
    await act(async () => { h.release(); await vi.advanceTimersByTimeAsync(0); });
    expect(container.textContent).toContain('plugins.uiApproval.title');
    expect(fixture.props.get('observedManagement').state.uiConsent?.item).toEqual(newer);
  } finally {
    act(() => localRoot.unmount()); fixture.promptReads = null; vi.useRealTimers();
  }
});

// PR #10206: a committed consent receipt is sufficient to consume that prompt,
// even when readback fails. Earlier tests required successful readback. Unit:
// real prompt/hook/controller/client/reader, controlled wire and fake timers.
function consentReceiptHost(action: 'defer-ui' | 'approve-ui', running = false) {
  const h = lightweightPromptHost(action);
  const normal = fixture.wire.getMockImplementation()!;
  const originalItem = { instanceKey: h.plugin.instanceKey, name: h.plugin.manifest.name,
    approvalToken: 'approved:12345678-1234-4123-8123-123456789abc' };
  let item = originalItem, fullReads = 0;
  let finish!: (value: unknown) => void, failReadback!: (error: Error) => void, completeReadback!: (value: unknown) => void;
  const begin = new Promise(resolve => { finish = resolve; });
  const readback = new Promise((resolve, reject) => { completeReadback = resolve; failReadback = reject; });
  let delayedConsent: Promise<unknown> | undefined;
  fixture.wire.mockImplementation(async (id, channel, args, options) => {
    options?.preSend?.(); options?.onRequestWritten?.();
    const request = args?.[0];
    if (request?.actionId === 'management:ui-consent') {
      const response = { result: { version: 1, uiCapabilityApproval: true, item } };
      if (delayedConsent) { const gate = delayedConsent; delayedConsent = undefined; await gate; }
      return response;
    }
    if (request?.actionId === 'management:snapshot' && ++fullReads > 1) return readback;
    if (request?.actionId === 'management:begin') {
      expect(request.input.kind).toBe(action);
      return running ? { result: { operationId: 'screen-operation', phase: 'running' } } : begin;
    }
    if (request?.actionId === 'management:operation') return begin;
    return normal(id, channel, args, options);
  });
  const refresh = async () => act(async () => {
    fixture.resourceListeners.forEach(listener => listener('mac', { collectionId: 'plugins' }));
    await vi.advanceTimersByTimeAsync(250);
  });
  return { ...h, originalItem, refresh,
    show: (next: typeof item) => { item = next; },
    finish: async (phase: 'succeeded' | 'failed' | 'cancelled') => act(async () => {
      finish({ result: { operationId: 'screen-operation', phase } });
      if (running) void fixture.props.get('observedManagement').controller.reconcile();
      await vi.advanceTimersByTimeAsync(0);
    }),
    failReadback: async () => act(async () => { failReadback(new Error('INVOKE_TIMEOUT')); await vi.advanceTimersByTimeAsync(0); }),
    completeReadback: async () => act(async () => {
      completeReadback({ result: { ...h.snapshot, ghosts: [{ ...h.plugin, uiPromptSuppressed: true }] } });
      await vi.advanceTimersByTimeAsync(0);
    }),
    delayConsent: () => {
      let release!: () => void;
      delayedConsent = new Promise<void>(resolve => { release = resolve; });
      return async () => act(async () => { release(); await vi.advanceTimersByTimeAsync(0); });
    },
  };
}
it.each([
  ['defer-ui', 'succeeded', false], ['approve-ui', 'succeeded', false],
  ['defer-ui', 'succeeded', true], ['approve-ui', 'succeeded', true],
  ['defer-ui', 'failed', true], ['approve-ui', 'cancelled', true],
] as const)('consent receipt %s/%s handles failed readback (lightweight=%s)', async (action, phase, lightweight) => {
  vi.useFakeTimers();
  const h = consentReceiptHost(action, lightweight);
  const container = document.createElement('div'); const localRoot = createRoot(container);
  try {
    await act(async () => localRoot.render(createElement(PluginUiEnablePrompt, {
      deviceId: 'mac', deviceName: 'Mac', online: true, active: true,
    })));
    expect(container.textContent).toContain('plugins.uiApproval.title');
    await act(async () => {
      fixture.props.get('plugins.uiApproval').actions[action === 'defer-ui' ? 1 : 0].onPress();
      await vi.advanceTimersByTimeAsync(0);
    });
    if (lightweight) await h.refresh();
    await h.finish(phase);
    // Inspect before readback settles: the receipt, not a later notification, hides it.
    expect(container.textContent.includes('plugins.uiApproval.title')).toBe(phase !== 'succeeded');
    await h.failReadback();
    expect(fixture.props.get('observedManagement').state).toMatchObject({ outcome: phase, errorCode: 'INVOKE_TIMEOUT' });
    expect(container.textContent.includes('plugins.uiApproval.title')).toBe(phase !== 'succeeded');
  } finally { act(() => localRoot.unmount()); fixture.promptReads = null; vi.useRealTimers(); }
});
it.each(['other-instance', 'new-revision'] as const)('consent receipt leaves a different %s hint intact', async identity => {
  vi.useFakeTimers();
  const h = consentReceiptHost('defer-ui', true);
  const container = document.createElement('div'); const localRoot = createRoot(container);
  try {
    await act(async () => localRoot.render(createElement(PluginUiEnablePrompt, {
      deviceId: 'mac', deviceName: 'Mac', online: true, active: true,
    })));
    await act(async () => { fixture.props.get('plugins.uiApproval').actions[1].onPress(); await vi.advanceTimersByTimeAsync(0); });
    const next = { ...h.originalItem, ...(identity === 'other-instance'
      ? { instanceKey: '_ns__other__demo' }
      : { approvalToken: 'approved:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }) };
    h.show(next); await h.refresh();
    await h.finish('succeeded'); await h.failReadback();
    expect(fixture.props.get('observedManagement').state).toMatchObject({ outcome: 'succeeded', errorCode: 'INVOKE_TIMEOUT' });
    expect(container.textContent).toContain('plugins.uiApproval.title');
    expect(fixture.props.get('observedManagement').state.uiConsent.item).toEqual(next);
  } finally { act(() => localRoot.unmount()); fixture.promptReads = null; vi.useRealTimers(); }
});
it('consent receipt fences an older in-flight hint but allows a later lightweight read', async () => {
  vi.useFakeTimers();
  const h = consentReceiptHost('defer-ui', true);
  const container = document.createElement('div'); const localRoot = createRoot(container);
  try {
    await act(async () => localRoot.render(createElement(PluginUiEnablePrompt, {
      deviceId: 'mac', deviceName: 'Mac', online: true, active: true,
    })));
    await act(async () => { fixture.props.get('plugins.uiApproval').actions[1].onPress(); await vi.advanceTimersByTimeAsync(0); });
    const releaseOld = h.delayConsent(); await h.refresh();
    await h.finish('succeeded'); await h.failReadback();
    // The queued old request returns its pre-success item, even though the Host
    // has no more pending item for this revision. No fresh notification is sent.
    await releaseOld();
    await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    expect(container.textContent).not.toContain('plugins.uiApproval.title');
    const newer = { ...h.originalItem, approvalToken: 'approved:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' };
    h.show(newer); await h.refresh();
    expect(container.textContent).toContain('plugins.uiApproval.title');
    expect(fixture.props.get('observedManagement').state.uiConsent.item).toEqual(newer);
  } finally { act(() => localRoot.unmount()); fixture.promptReads = null; vi.useRealTimers(); }
});

// PR #10206 R5: an operation-time notification can discover a different pending
// revision. A failed newer full readback must not discard that already-requested
// result; successful readback still wins. Unit, real prompt chain, fake clock.
it.each([
  ['other-instance', false], ['new-revision', false], ['consumed', false],
  ['other-instance', true], ['new-revision', true], ['consumed', true],
] as const)('failed readback recovers the displaced %s hint (readback fails first=%s)', async (identity, failsFirst) => {
  vi.useFakeTimers();
  const h = consentReceiptHost('approve-ui', true);
  const container = document.createElement('div'); const localRoot = createRoot(container);
  try {
    await act(async () => localRoot.render(createElement(PluginUiEnablePrompt, {
      deviceId: 'mac', deviceName: 'Mac', online: true, active: true,
    })));
    await act(async () => { fixture.props.get('plugins.uiApproval').actions[0].onPress(); await vi.advanceTimersByTimeAsync(0); });
    const next = { ...h.originalItem, ...(identity === 'other-instance'
      ? { instanceKey: '_ns__other__demo' }
      : identity === 'new-revision' ? { approvalToken: 'approved:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' } : {}) };
    h.show(next);
    const release = h.delayConsent(); await h.refresh();
    await h.finish('succeeded');
    if (failsFirst) await h.failReadback();
    await release();
    await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    if (!failsFirst) {
      expect(container.textContent).not.toContain('plugins.uiApproval.title');
      await h.failReadback();
    }
    expect(fixture.props.get('observedManagement').state).toMatchObject({ outcome: 'succeeded', errorCode: 'INVOKE_TIMEOUT' });
    expect(container.textContent.includes('plugins.uiApproval.title')).toBe(identity !== 'consumed');
    if (identity !== 'consumed') expect(fixture.props.get('observedManagement').state.uiConsent.item).toEqual(next);
    // Success/readback invalidations already coalesce one shared follow-up to R1.
    // Recovering its result must not add any further state request or retry loop.
    const count = fixture.wire.mock.calls.filter(c => c[2]?.[0]?.actionId === 'management:ui-consent').length;
    expect(count).toBe(3);
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(fixture.wire.mock.calls.filter(c => c[2]?.[0]?.actionId === 'management:ui-consent')).toHaveLength(count);
  } finally { act(() => localRoot.unmount()); fixture.promptReads = null; vi.useRealTimers(); }
});

it.each(['full-success', 'newer-lightweight'] as const)(
  'displaced hint recovery does not override %s', async winner => {
    vi.useFakeTimers();
    const h = consentReceiptHost('approve-ui', true);
    const container = document.createElement('div'); const localRoot = createRoot(container);
    try {
      await act(async () => localRoot.render(createElement(PluginUiEnablePrompt, {
        deviceId: 'mac', deviceName: 'Mac', online: true, active: true,
      })));
      await act(async () => { fixture.props.get('plugins.uiApproval').actions[0].onPress(); await vi.advanceTimersByTimeAsync(0); });
      h.show({ ...h.originalItem, instanceKey: 'pending-b' });
      const release = h.delayConsent(); await h.refresh();
      await h.finish('succeeded'); await release();
      await act(async () => { await vi.advanceTimersByTimeAsync(250); });
      if (winner === 'full-success') {
        await h.completeReadback();
        expect(container.textContent).not.toContain('plugins.uiApproval.title');
        expect(fixture.props.get('observedManagement').state.uiConsent).toBeNull();
      } else {
        const latest = { ...h.originalItem, instanceKey: 'pending-c' };
        h.show(latest); await h.refresh();
        await h.failReadback();
        expect(container.textContent).toContain('plugins.uiApproval.title');
        expect(fixture.props.get('observedManagement').state.uiConsent.item).toEqual(latest);
      }
    } finally { act(() => localRoot.unmount()); fixture.promptReads = null; vi.useRealTimers(); }
  },
);

// PR #10206 R6, unit: the real prompt/client chain must tolerate additive compact
// item fields. Existing fixtures lacked a manifest field that collides with the
// full-plugin discriminator, hiding both actions before any approval request.
it('keeps compact consent actionable when the Host adds manifest and unknown item fields', async () => {
  vi.useFakeTimers();
  const { plugin } = lightweightPromptHost('approve-ui');
  const normal = fixture.wire.getMockImplementation()!;
  fixture.wire.mockImplementation(async (id, channel, args, options) => {
    const response = await normal(id, channel, args, options);
    if (args?.[0]?.actionId === 'management:ui-consent') return { ...response, result: {
      ...response.result, futureTopLevel: 'preserved', item: { ...response.result.item,
        manifest: { description: 'Additional Host metadata' }, futureItemField: { version: 2 },
      },
    } };
    return response;
  });
  const container = document.createElement('div'); const localRoot = createRoot(container);
  try {
    await act(async () => localRoot.render(createElement(PluginUiEnablePrompt, {
      deviceId: 'mac', deviceName: 'Mac', online: true, active: true,
    })));
    expect(container.textContent).toContain('plugins.uiApproval.title');
    const notice = fixture.props.get('plugins.uiApproval');
    expect(notice.actions.map((action: { label: string }) => action.label)).toEqual([
      'plugins.uiApproval.enable', 'plugins.uiApproval.later',
    ]);
    const { state, controller } = fixture.props.get('observedManagement');
    expect(state.uiConsent.futureTopLevel).toBe('preserved');
    const approve = vi.spyOn(controller, 'approveUiFromConsent'); // Calls through to production.
    await act(async () => { notice.actions[0].onPress(); await vi.advanceTimersByTimeAsync(0); });
    expect(approve).toHaveBeenCalledWith({ instanceKey: plugin.instanceKey, name: plugin.manifest.name,
      approvalToken: 'approved:12345678-1234-4123-8123-123456789abc' });
    const begins = fixture.wire.mock.calls.filter(call => call[2]?.[0]?.actionId === 'management:begin');
    expect(begins).toHaveLength(1);
    expect(begins[0][2][0]).toMatchObject({ resourceRef: { id: plugin.instanceKey }, input: {
      kind: 'approve-ui', expectedInstalledApproval: 'approved:12345678-1234-4123-8123-123456789abc', uiConsentVersion: 1,
    } });
    expect(fixture.props.get('observedManagement').state.outcome).toBe('succeeded');
  } finally { act(() => localRoot.unmount()); fixture.promptReads = null; vi.restoreAllMocks(); vi.useRealTimers(); }
});

// R7 unit: real visible-consumer effects + shared reader; global invalidations
// continue while screens are hidden. One visible consumer keeps refresh alive,
// zero consumers stop follow-ups and retain dirty state for the next visible read.
it.each(['hidden', 'background'] as const)('stops shared hint follow-ups with no active consumers (%s)', async mode => {
  vi.useFakeTimers();
  lightweightPromptHost('approve-ui');
  const normal = fixture.wire.getMockImplementation()!;
  const releases: Array<() => void> = [];
  let stateReads = 0, manifests = 0;
  fixture.wire.mockImplementation(async (id, channel, args, opts) => {
    if (channel.endsWith(':manifest')) manifests++;
    const response = await normal(id, channel, args, opts);
    if (args?.[0]?.actionId === 'management:ui-consent' && ++stateReads <= 2)
      await new Promise<void>(resolve => releases.push(resolve));
    return response;
  });
  const first = createRoot(document.createElement('div')), second = createRoot(document.createElement('div'));
  const prompt = (active: boolean) => createElement(PluginUiEnablePrompt, { deviceId: 'mac', deviceName: 'Mac', online: true, active });
  try {
    await act(async () => { first.render(prompt(true)); second.render(prompt(true)); await vi.advanceTimersByTimeAsync(0); });
    expect(stateReads).toBe(1);
    await act(async () => first.render(prompt(false)));
    fixture.promptReads!.invalidate('mac', {});
    await act(async () => { releases[0](); await vi.advanceTimersByTimeAsync(250); });
    expect(stateReads).toBe(2); // The second visible consumer still needs the queued refresh.
    fixture.promptReads!.invalidate('mac', {});
    if (mode === 'background') {
      // Leave during the already-scheduled follow-up debounce, before it sends.
      await act(async () => { releases[1](); await vi.advanceTimersByTimeAsync(0); });
    }
    await act(async () => {
      if (mode === 'hidden') second.render(prompt(false));
      else fixture.appStateListeners.forEach(listener => listener('background'));
    });
    fixture.promptReads!.invalidate('mac', {});
    await act(async () => { releases[1](); await vi.advanceTimersByTimeAsync(1000); });
    expect(stateReads).toBe(2);
    expect(manifests).toBe(2);
    await act(async () => {
      if (mode === 'hidden') second.render(prompt(true));
      else fixture.appStateListeners.forEach(listener => listener('active'));
      await vi.advanceTimersByTimeAsync(0);
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    expect(stateReads).toBe(3);
    expect(manifests).toBe(3);
  } finally { act(() => { first.unmount(); second.unmount(); }); fixture.promptReads = null; vi.useRealTimers(); }
});

/* 测试价值（手机插件市场，2026-11-25）
 * - 生产入口与可观察结果：真实 PluginsScreen + usePluginMarket + 管理 client/controller（只替换设备互联 invoke）；
 *   观察市场分段的状态、列表、确认面板与装好后打开的已装详情，以及发往电脑的请求。
 * - 依据：same-account-remote-plugin-management.md 旧 Host 只认 INVALID_PARAMS、不回退全量；
 *   remote-and-mobile-adaptation 切电脑/账号后旧响应不落地；brief 第 7 点装好后打开已装详情。
 * - 缺口：pluginManagement.test.ts 只到 client/controller，不覆盖手机页面的电脑切换、能力降级与成功后的导航。
 * - 最小失败输入：capabilities 回 INVALID_PARAMS；切电脑或切账号后上一台电脑的分页才返回；无 installed 的安装确认后成功。
 * - tier: unit（jsdom，内存 Host，无真实等待）。
 */
type MarketWireRequest = { device: string; actionId?: string; input?: any; resourceRef?: any };
function marketWire(respond: (request: MarketWireRequest) => unknown) {
  const requests: MarketWireRequest[] = [];
  fixture.realManagement = true;
  fixture.wire.mockImplementation(async (device: string, channel: string, args?: any[], options?: any) => transportSend(options, async () => {
    if (channel.endsWith(":manifest"))
      return { protocolVersion: 1, collections: [{ id: "plugins", actions: [{ id: "management:snapshot", label: "Manage" }] }] };
    const envelope = args?.[0] ?? {};
    const request = { device, actionId: envelope.actionId, input: envelope.input, resourceRef: envelope.resourceRef };
    requests.push(request);
    return { effects: [], result: await respond(request) };
  }));
  return requests;
}
const marketItem = (ghostId: string, name: string) => ({
  pluginId: `market/${ghostId}`, ghostId, namespace: null, name, description: "Demo", author: "Cindy", publisherKind: "official",
  scope: "public", organizationId: null, defaultInstall: false, releaseId: `${ghostId}@1`, version: "1", publishedAt: "",
  icon: null, installState: "not-installed", enabled: null, sourceType: "server", sourceMarketName: null,
});
// An official-market consent for the demo plugin; tests that lose a result after approving answer it first.
const demoConsent = (request: MarketWireRequest) => ({ operationId: request.input.operationId, phase: "confirmation", consent: {
  requestId: "consent", initiator: "user", origin: "market", facts: { kind: "install", ghostId: "demo", name: "Demo", version: "1", permissions: [] } } });
/** Allow from the phone (the Host then loses the reply in these tests). */
async function approveOnPhone() {
  await act(async () => { await fixture.props.get("confirmation").controller.answer(true); });
  await settle(14);
}
const marketPage = (items: any[]) => ({ items, unavailableReason: null, customSourceNames: [], unavailableCustomSourceNames: [],
  nextCursor: null, counts: null });
async function settle(rounds = 10) {
  for (let index = 0; index < rounds; index++) await act(async () => { await Promise.resolve(); });
}
async function openMarket() {
  await act(async () => root.render(createElement(PluginsScreen)));
  await act(async () => fixture.props.get("directory").onSegmentChange("market"));
  await settle();
}
const shownMarket = () => fixture.props.get("directory").market;
// Codex review (c656f8da): after a failed computer lookup the market alone has no target; refreshing it did nothing.
it("looks for computers again when the market is refreshed without one", async () => {
  fixture.devicesFailed = true;
  marketWire(() => { throw new Error("no computer to read"); });
  await openMarket();
  expect(shownMarket().status).toBe("noComputer");
  fixture.devicesRefresh.mockClear();
  await act(async () => { await shownMarket().refresh(); });
  expect(fixture.devicesRefresh).toHaveBeenCalledTimes(1);
});
it("asks to update an older computer instead of reading its whole market", async () => {
  const requests = marketWire((request) => {
    // Real wire shape: dispatch sends IPC_ERROR and unwrapInvoke throws the bare "[CODE] message".
    if (request.input?.read === "capabilities") throw new Error("[INVALID_PARAMS] Invalid plugin management request");
    throw new Error("unexpected market read");
  });
  await openMarket();
  expect(shownMarket().status).toBe("outdated");
  expect(requests.map((request) => request.input)).toEqual([{ read: "capabilities" }]);
});
it.each(["computer", "account"])("drops a late market page after switching the %s", async (change) => {
  fixture.extraDevices = [{ deviceId: "pc", name: "PC", platform: "win32", remoteControlEnabled: true }];
  let releaseLate!: (value: unknown) => void;
  const late = new Promise((resolve) => { releaseLate = resolve; });
  marketWire((request) => request.input?.read === "capabilities" ? { catalogPaging: true }
    : request.device === "mac" ? late : marketPage([marketItem("pc-only", "PC only")]));
  await openMarket();
  expect(shownMarket().target.deviceId).toBe("mac");
  if (change === "computer") await act(async () => shownMarket().selectDevice("pc"));
  else fixture.owner = false;
  await settle();
  await act(async () => releaseLate(marketPage([marketItem("stale", "Stale")])));
  await settle();
  expect(shownMarket().items.map((item: any) => item.name)).toEqual(change === "computer" ? ["PC only"] : []);
});
it("installs from the market through the existing consent sheet and opens the new installed detail", async () => {
  const item = marketItem("demo", "Demo");
  const manifest = { schemaVersion: 3, id: "demo", name: "Demo", version: "1" };
  let installed = false;
  const requests = marketWire((request) => {
    switch (request.actionId) {
      case "management:snapshot":
        if (request.input?.read === "capabilities") return { catalogPaging: true };
        if (request.input?.read === "catalog") return marketPage([item]);
        return { version: 1, market: { items: [], unavailableReason: null, customSourceNames: [], unavailableCustomSourceNames: [] },
          ghosts: installed ? [{ instanceKey: "_root__demo", namespace: null, manifest, enabled: true,
            approval: { state: "approved", revision: "12345678-1234-4123-8123-123456789abc" } }] : [] };
      case "management:market-detail": return { ...item, manifest };
      case "management:begin": return { operationId: request.input.operationId, phase: "confirmation", consent: {
        requestId: "consent", initiator: "user", origin: "market",
        facts: { kind: "install", ghostId: "demo", name: "Demo", version: "1", permissions: [] } } };
      case "management:answer": installed = true; return { operationId: request.input.operationId, phase: "succeeded" };
      default: throw new Error("unexpected " + request.actionId);
    }
  });
  await openMarket();
  // A double tap in the same frame starts one attempt only (the guard is a synchronous ref).
  await act(async () => { const market = shownMarket(); market.install(market.items[0]); market.install(market.items[0]); });
  await settle(14);
  const sheet = fixture.props.get("confirmation");
  expect(sheet.state.outcome).toBe("confirmation");
  expect(shownMarket().rowState(item)).toEqual({ kind: "waiting" });
  await act(async () => sheet.controller.answer(true));
  await settle(14);
  expect(requests.find((request) => request.actionId === "management:begin")).toMatchObject({ resourceRef: undefined,
    input: { kind: "install", pluginId: "market/demo", expectedReleaseId: "demo@1" } });
  expect(requests.find((request) => request.actionId === "management:begin")!.input).not.toHaveProperty("expectedInstalledApproval");
  expect(requests.filter((request) => request.actionId === "management:begin")).toHaveLength(1);
  expect(fixture.read).toHaveBeenLastCalledWith(fixture.wire, expect.objectContaining({ deviceId: "mac" }),
    expect.objectContaining({ id: "_root__demo" }), "en", ["plugin-capabilities"]);
  expect(fixture.props.get("header").title).toBe("Demo");
  // Browsing and installing never fall back to the full v1 snapshot on a paging Host (up to the post-commit
  // readback; the installed detail opened afterwards keeps its existing controller and reads).
  const answeredAt = requests.findIndex((request) => request.actionId === "management:answer");
  expect(requests.slice(0, answeredAt + 2).filter((request) => request.actionId === "management:snapshot")
    .map((request) => request.input?.read)).toEqual(["capabilities", "catalog", "catalog", "installed", "installed", "installed", "installed"]);
});

// PR review (2026-11-25): a first install from the user's own Git market, end to end on the phone side.
it("installs from a custom Git market with the Host's manifest check and opens the new installed detail", async () => {
  const { publisherKind: _server, ...base } = marketItem("repo-tools", "Repo Tools");
  const source = { kind: "git", repository: "github.com/demo-org/demo-git-market", sourceId: "DemoGitMarketSource001" };
  const item = { ...base, pluginId: "custom-market:Demo%20Git%20Market/repo-tools", sourceType: "git-market", sourceMarketName: "Demo Git Market",
    sourceIdentity: source };
  const manifest = { schemaVersion: 3, id: "repo-tools", name: "Repo Tools", version: "1", node: { entry: "worker.cjs", protocol: "json-rpc-stdio" } };
  let installed = false;
  const requests = marketWire((request) => {
    switch (request.actionId) {
      case "management:snapshot":
        if (request.input?.read === "capabilities") return { catalogPaging: true };
        if (request.input?.read === "catalog") return { ...marketPage(installed ? [] : [item]), customSourceNames: ["Demo Git Market"] };
        return { version: 1, market: { items: [], unavailableReason: null, customSourceNames: [], unavailableCustomSourceNames: [] },
          ghosts: installed ? [{ instanceKey: "_root__repo-tools", namespace: null, manifest, enabled: true,
            approval: { state: "approved", revision: "12345678-1234-4123-8123-123456789abc" } }] : [] };
      case "management:market-detail": return { ...item, manifest };
      case "management:begin": return { operationId: request.input.operationId, phase: "confirmation", consent: {
        requestId: "consent", initiator: "user", origin: "custom-market", originLabel: "Demo Git Market", originSource: source,
        installationSource: { kind: "third-party" },
        facts: { kind: "install", ghostId: "repo-tools", name: "Repo Tools", version: "1",
          permissions: [{ key: "node:execute", kind: "node", labelKey: "nodeRuntime", detailKey: "nodeRuntimeDetail" }] } } };
      case "management:answer": installed = true; return { operationId: request.input.operationId, phase: "succeeded" };
      default: throw new Error("unexpected " + request.actionId);
    }
  });
  await openMarket();
  await act(async () => shownMarket().setFilter("custom"));
  await settle();
  await act(async () => shownMarket().install(shownMarket().items[0]));
  await settle(14);
  // Custom-market packages are checked against the manifest the phone was shown (server items never send one).
  expect(requests.find((request) => request.actionId === "management:begin")!.input).toMatchObject({
    kind: "install", pluginId: item.pluginId, expectedReleaseId: item.releaseId, expectedManifest: manifest });
  const sheet = fixture.props.get("confirmation");
  expect(sheet.state.receipt.consent).toMatchObject({ origin: "custom-market", originLabel: "Demo Git Market", originSource: source });
  await act(async () => sheet.controller.answer(true));
  await settle(14);
  // The installed detail opened is the new instance (the mocked resource read always titles it "Demo").
  expect(fixture.read).toHaveBeenLastCalledWith(fixture.wire, expect.objectContaining({ deviceId: "mac" }),
    expect.objectContaining({ id: "_root__repo-tools" }), "en", ["plugin-capabilities"]);
});

const hostError = (code: string) => new Error(`[${code}] Plugin management request is no longer available`);
const demoGhost = { instanceKey: "_root__demo", namespace: null, manifest: { schemaVersion: 3, id: "demo", name: "Demo", version: "1" },
  enabled: true, approval: { state: "approved", revision: "12345678-1234-4123-8123-123456789abc" } };
const managementSnapshot = (installed: boolean) => ({ version: 1, ghosts: installed ? [demoGhost] : [],
  market: { items: [], unavailableReason: null, customSourceNames: [], unavailableCustomSourceNames: [] } });
it("keeps the shown market rows when the same page is pulled to refresh", async () => {
  const item = marketItem("demo", "Demo");
  marketWire((request) => request.input?.read === "capabilities" ? { catalogPaging: true } : marketPage([item]));
  await openMarket();
  expect(shownMarket().items.map((row: any) => row.name)).toEqual(["Demo"]);
  await act(async () => { await shownMarket().refresh(); });
  await settle();
  expect(shownMarket().items.map((row: any) => row.name)).toEqual(["Demo"]);
});
it("stops chaining empty publisher pages after three extra reads", async () => {
  const community = { ...marketItem("community", "Community"), publisherKind: "personal" };
  let page = 0;
  const requests = marketWire((request) => request.input?.read === "capabilities" ? { catalogPaging: true }
    : request.input?.query?.counts ? { ...marketPage([]), counts: null }
      : { ...marketPage([{ ...community, pluginId: `market/c${page}`, ghostId: `c${page}` }]), nextCursor: `cursor-${++page}` });
  await openMarket();
  await settle(20);
  const pages = requests.filter((request) => request.input?.read === "catalog" && !request.input.query.counts);
  expect(pages).toHaveLength(4);
  expect(shownMarket()).toMatchObject({ status: "ready", hasMore: true, items: [] });
});
/**
 * PR #12684 maintainer decision (older Host without repository identity), proposal pending confirmation:
 * - 依据：只能显示市场名时，同名的两个仓库在手机上看起来一样；新装不从手机发起，改在电脑上安装。
 * - 缺口：此前自定义市场条目缺少 sourceIdentity 时照常读取详情并发出 begin。
 * - 最小失败输入：列表条目无 sourceIdentity；或列表有、开始安装时读到的详情没有。tier: integration。
 */
describe("older Host custom market without a repository identity", () => {
  const { publisherKind: _server, ...base } = marketItem("legacy", "Legacy");
  const source = { kind: "git", repository: "github.com/acme/market", sourceId: "SourceA_0123456789abcd" };
  const wire = (listSource: unknown, detailSource: unknown) => marketWire((request) => {
    const item = { ...base, pluginId: "custom:Team/legacy", sourceType: "git-market", sourceMarketName: "Team",
      ...(listSource ? { sourceIdentity: listSource } : {}) };
    switch (request.actionId) {
      case "management:snapshot":
        if (request.input?.read === "capabilities") return { catalogPaging: true };
        if (request.input?.read === "catalog") return { ...marketPage([item]), customSourceNames: ["Team"] };
        return managementSnapshot(false);
      case "management:market-detail": {
        const { sourceIdentity: _list, ...rest } = item;
        return { ...rest, ...(detailSource ? { sourceIdentity: detailSource } : {}),
          manifest: { schemaVersion: 3, id: "legacy", name: "Legacy", version: "1" } };
      }
      case "management:begin": throw new Error("begin must not be sent");
      default: throw new Error("unexpected " + request.actionId);
    }
  });
  it("offers no install from the phone and sends nothing when Install is pressed anyway", async () => {
    const requests = wire(undefined, undefined);
    await openMarket();
    await act(async () => shownMarket().setFilter("custom"));
    await settle();
    const [item] = shownMarket().items;
    expect(shownMarket().rowState(item)).toEqual({ kind: "sourceUnverified" });
    await act(async () => shownMarket().install(item));
    await settle(14);
    expect(shownMarket()).toMatchObject({ installBusy: false });
    expect(requests.some((request) => request.actionId === "management:begin" || request.actionId === "management:market-detail")).toBe(false);
  });
  it("stops before begin when the detail read at install time no longer names the repository", async () => {
    const requests = wire(source, undefined);
    await openMarket();
    await act(async () => shownMarket().setFilter("custom"));
    await settle();
    const [item] = shownMarket().items;
    expect(shownMarket().rowState(item)).toEqual({ kind: "idle" });
    await act(async () => shownMarket().install(item));
    await settle(14);
    expect(requests.some((request) => request.actionId === "management:market-detail")).toBe(true);
    expect(requests.some((request) => request.actionId === "management:begin")).toBe(false);
    expect(shownMarket()).toMatchObject({ installBusy: false });
    expect(shownMarket().rowState(item)).toEqual({ kind: "failed", messageKey: "plugins.market.sourceUnverified" });
  });
});

describe("market install recovery", () => {
  const item = marketItem("demo", "Demo");
  // `installedBy`: the operation id the Host recorded with the installed package (contract V2.9), shown to this device.
  function installWire(options: { begin?: () => unknown; answer?: () => unknown; operation?: () => unknown; detail?: () => unknown; installed?: () => boolean;
    installedBy?: () => string | undefined }) {
    return marketWire((request) => {
      switch (request.actionId) {
        case "management:snapshot":
          if (request.input?.read === "capabilities") return { catalogPaging: true };
          if (request.input?.read === "catalog") return marketPage([item]);
          return managementSnapshot(options.installed?.() ?? false);
        case "management:market-detail":
          // Like the Host: installState comes from the market-source record of this exact plugin.
          return options.detail ? options.detail() : { ...item, installState: options.installed?.() ? "installed" : "not-installed",
            ...(options.installedBy?.() ? { installedOperationId: options.installedBy() } : {}),
            manifest: { schemaVersion: 3, id: "demo", name: "Demo", version: "1" } };
        case "management:begin": return options.begin!();
        case "management:answer": return options.answer!();
        case "management:operation": return options.operation!();
        default: throw new Error("unexpected " + request.actionId);
      }
    });
  }
  /* 测试价值（维护者 17:43 复审第 2 条；调度要求 G）
   * - 生产入口与可观察结果：真实 PluginsScreen + usePluginMarket + 管理 client / controller，只替换传输；整页卸载再打开后，
   *   观察页面上是否能找到占用者、原行是否恢复为待确认、「核实结果」发出的请求。
   * - 依据：持有占用的操作的身份（账号、电脑、入口、插件、尝试编号）与占用同层保存，任何页面重挂载时恢复；不允许
   *   「占用还在、页面上找不到是谁占着、也没有核实入口」。
   * - 缺口：重开的市场从空开始，拿不回原尝试，也无法核实，其它入口被旧占用挡住。
   * - 最小失败输入：允许已写出、回包丢失、Host 持续返回同一确认时整页卸载再打开。tier: unit。
   */
  it("restores an unconfirmed install after the whole plugins page is closed and opened again, and only looks it up", async () => {
    const requests = installWire({
      begin: () => demoConsent({ input: { operationId: "screen-operation" } } as any),
      answer: () => { throw new Error("[TIMEOUT] remote invoke timed out"); },
      // The Host keeps showing the same consent (the answer did not get there).
      operation: () => demoConsent({ input: { operationId: "screen-operation" } } as any),
    });
    await openMarket();
    await act(async () => shownMarket().install(shownMarket().items[0]));
    await settle(14);
    await approveOnPhone();
    expect(shownMarket().rowState(item)).toEqual({ kind: "unknown" });
    const begins = () => requests.filter((request) => request.actionId === "management:begin").length;
    expect(begins()).toBe(1);
    // The whole page goes away and is opened again.
    await act(async () => root.render(createElement("div")));
    await settle(6);
    fixture.props.delete("plugins.slotHolder");
    await act(async () => root.render(createElement(PluginsScreen)));
    await settle(14);
    // It says which plugin on which computer is still under way, and goes there.
    expect(fixture.props.get("plugins.slotHolder")).toMatchObject({ title: "plugins.slot.holder" });
    await act(async () => fixture.props.get("plugins.slotHolder").actions[0].onPress());
    await settle(14);
    expect(shownMarket().rowState(item)).toEqual({ kind: "unknown" });
    expect(shownMarket().installBusy).toBe(true);
    const before = requests.length;
    await act(async () => { await shownMarket().checkResult(); });
    await settle(14);
    // "Check result" only looks up the original operation; no second install.
    expect(requests.slice(before).map((request) => request.actionId)).toEqual(["management:operation"]);
    expect(begins()).toBe(1);
  });
  it("releases the row when the install never started because the computer went away mid-preparation", async () => {
    let releaseDetail!: () => void;
    const pending = new Promise<void>((resolve) => { releaseDetail = resolve; });
    let detailReads = 0;
    installWire({ detail: async () => {
      // The hook's own detail read passes; the controller's re-read is held while the computer drops.
      if (++detailReads === 2) await pending;
      return { ...item, manifest: { schemaVersion: 3, id: "demo", name: "Demo", version: "1" } };
    }, begin: () => { throw new Error("begin must not be sent"); } });
    await openMarket();
    await act(async () => shownMarket().install(shownMarket().items[0]));
    await settle(14);
    expect(shownMarket().rowState(item)).toEqual({ kind: "waiting" });
    fixture.online = false;
    await act(async () => root.render(createElement(PluginsScreen)));
    await act(async () => { releaseDetail(); });
    await settle(14);
    expect(shownMarket().installBusy).toBe(false);
    expect(shownMarket().rowState(item)).toEqual({ kind: "failed", messageKey: "plugins.actionFailed" });
  });
  it.each([
    ["installed on the computer", true, null, "screen-operation"],
    ["not on the computer", false, "plugins.market.unconfirmedNotInstalled", "screen-operation"],
    // Contract V2.9: Allow was written, but the computer's record says another operation installed this release.
    ["installed on the computer by another operation", true, "plugins.market.unconfirmedMismatch", "computer-update-0001"],
  ])("settles an unconfirmed install whose operation is gone when the plugin is %s", async (_name, installedAfter, messageKey, installedBy) => {
    let installed = false;
    const requests = installWire({
      begin: () => demoConsent({ input: { operationId: "screen-operation" } } as any),
      // Allow reached the computer; its reply was lost.
      answer: () => { installed = installedAfter; throw new Error("[TIMEOUT] remote invoke timed out"); },
      operation: () => { throw hostError("NOT_FOUND"); },
      installed: () => installed,
      // The operation the Host recorded with the installed package (contract V2.9 evidence).
      installedBy: () => installed ? installedBy : undefined,
    });
    await openMarket();
    await act(async () => shownMarket().install(shownMarket().items[0]));
    await settle(14);
    await approveOnPhone();
    expect(shownMarket().rowState(item)).toEqual({ kind: "unknown" });
    await act(async () => { await shownMarket().checkResult(); });
    await settle(14);
    if (messageKey) expect(shownMarket()).toMatchObject({ installBusy: false, canInstall: true });
    if (messageKey) expect(shownMarket().rowState(item)).toEqual({ kind: "failed", messageKey });
    else expect(fixture.read).toHaveBeenLastCalledWith(fixture.wire, expect.anything(), expect.objectContaining({ id: "_root__demo" }), "en", ["plugin-capabilities"]);
    // Never a second begin: the unknown result is only looked up, never replayed.
    expect(requests.filter((request) => request.actionId === "management:begin")).toHaveLength(1);
  });
  // Maintainer reviews 09:30 #2 and 10:36 #2 (contract V2.9): Allow was written; the computer went offline before its reply
  // timed out, the receipt expired, the phone came back. The result is confirmed only from the Host's own record that
  // this attempt's operation installed the package, so the offline period cannot lose it; the same id and release
  // installed by another operation stays unconfirmed. Minimal failing input: written Allow → offline → timeout →
  // receipt gone → reconnect. Tier: unit (jsdom, in-memory Host).
  it.each([
    ["this attempt's operation installed it", "screen-operation", true],
    ["another operation installed the same release", "computer-update-0001", false],
    ["the Host gives no operation evidence (older Host)", undefined, false],
  ] as const)("checks a written Allow after offline, timeout and an expired receipt: %s", async (_name, installedBy, confirmed) => {
    let installed = false, receiptGone = false, releaseReply!: () => void;
    const reply = new Promise<void>((resolve) => { releaseReply = resolve; });
    const requests = installWire({
      begin: () => demoConsent({ input: { operationId: "screen-operation" } } as any),
      // Written; the reply is held until the computer is offline, then times out.
      answer: async () => { installed = true; await reply; throw new Error("[TIMEOUT] remote invoke timed out"); },
      operation: () => { if (receiptGone) throw hostError("NOT_FOUND"); return { operationId: "screen-operation", phase: "running" }; },
      installed: () => installed,
      installedBy: () => installed ? installedBy : undefined,
    });
    await openMarket();
    await act(async () => shownMarket().install(shownMarket().items[0]));
    await settle(14);
    const controller = fixture.props.get("confirmation").controller;
    await act(async () => { void controller.answer(true); });
    await settle(6);
    expect(requests.filter((request) => request.actionId === "management:answer")).toHaveLength(1);
    await act(async () => controller.setOnline(false));
    await act(async () => { releaseReply(); });
    await settle(14);
    receiptGone = true;
    await act(async () => controller.setOnline(true));
    await settle(14);
    if (shownMarket().rowState(item).kind === "unknown") { await act(async () => { await shownMarket().checkResult(); }); await settle(14); }
    const opened = fixture.read.mock.calls.some((call: any[]) => call[2]?.id === "_root__demo");
    expect(opened).toBe(confirmed);
    // Unconfirmed: the row keeps the note and the market is released (confirmed opens the installed detail instead).
    if (!confirmed) {
      expect(shownMarket().rowState(item)).toEqual({ kind: "failed", messageKey: "plugins.market.unconfirmedMismatch" });
      expect(shownMarket()).toMatchObject({ installBusy: false });
    }
    // Only looked up: never a second begin or answer.
    expect(requests.filter((request) => request.actionId === "management:begin")).toHaveLength(1);
    expect(requests.filter((request) => request.actionId === "management:answer")).toHaveLength(1);
  });
  // Review (2026-11-25): with the receipt gone, a local package sharing the ghost id and namespace was taken
  // as the market install and its detail opened.
  it.each([
    ["a local package with the same id (market facts say conflict)", "conflict", "demo@1"],
    ["the market plugin at another release", "update-available", "demo@2"],
  ])("keeps the result unconfirmed when the computer only has %s", async (_name, installState, releaseId) => {
    let sameIdOnComputer = false;
    const requests = installWire({
      begin: () => { sameIdOnComputer = true; throw new Error("[TIMEOUT] remote invoke timed out"); },
      operation: () => { throw hostError("NOT_FOUND"); },
      installed: () => sameIdOnComputer,
      detail: () => ({ ...item, installState: sameIdOnComputer ? installState : "not-installed",
        releaseId: sameIdOnComputer ? releaseId : item.releaseId,
        manifest: { schemaVersion: 3, id: "demo", name: "Demo", version: "1" } }),
    });
    await openMarket();
    await act(async () => shownMarket().install(shownMarket().items[0]));
    await settle(14);
    await act(async () => { await shownMarket().checkResult(); });
    await settle(14);
    // Maintainer review (2026-11-25): once the Host has no receipt and its facts are read, the row keeps the
    // unconfirmed note and the market and other management actions are released (no endless installBusy).
    expect(shownMarket()).toMatchObject({ installBusy: false, canInstall: true });
    expect(shownMarket().rowState(item)).toEqual({ kind: "failed", messageKey: "plugins.market.unconfirmedMismatch" });
    expect(fixture.read).not.toHaveBeenCalledWith(fixture.wire, expect.anything(), expect.objectContaining({ id: "_root__demo" }),
      "en", ["plugin-capabilities"]);
    // The market facts were read for the original plugin id only; nothing was replayed.
    expect(requests.filter((request) => request.actionId === "management:market-detail")
      .every((request) => request.input.pluginId === "market/demo")).toBe(true);
    expect(requests.filter((request) => request.actionId === "management:begin")).toHaveLength(1);
  });
  // Maintainer reviews (2026-11-25, 01:52 and 04:44): after the receipt expired, the computer replaced custom market A
  // with a same-name repository or folder B and installed B's plugin with the same id and release; the phone took it
  // as A's result. Contract V2.9 (maintainer reviews 09:30 and 10:36): only the Host's record that this attempt's
  // operation installed the package confirms it; the installed source id is no longer the check.
  const sourceA = { kind: "git", repository: "github.com/acme/market", sourceId: "SourceA_0123456789abcd" };
  it.each([
    ["another operation installed the same id and release (e.g. from a same-name source)", "other-operation-0001", "unconfirmed"],
    ["the computer gives no operation evidence (older Host)", undefined, "unconfirmed"],
    ["this attempt's operation installed it", "screen-operation", "installed"],
  ])("confirms a lost-receipt custom-market install only from the Host's operation evidence: %s", async (_name, installedOperationId, expected) => {
    const { publisherKind: _server, ...base } = marketItem("demo", "Demo");
    const item = { ...base, pluginId: "custom:Team/demo", sourceType: "git-market", sourceMarketName: "Team", sourceIdentity: sourceA };
    let installed = false, receiptGone = false;
    const requests = marketWire((request) => {
      switch (request.actionId) {
        case "management:snapshot":
          if (request.input?.read === "capabilities") return { catalogPaging: true };
          if (request.input?.read === "catalog") return { ...marketPage(installed ? [] : [item]), customSourceNames: ["Team"] };
          return managementSnapshot(installed);
        case "management:market-detail":
          return { ...item, installState: installed ? "installed" : "not-installed",
            ...(installed ? { installedSourceId: sourceA.sourceId } : {}),
            ...(installed && installedOperationId ? { installedOperationId } : {}),
            manifest: { schemaVersion: 3, id: "demo", name: "Demo", version: "1" } };
        case "management:begin": return { operationId: request.input.operationId, phase: "confirmation", consent: {
          requestId: "consent", initiator: "user", origin: "custom-market", originLabel: "Team", originSource: sourceA,
          installationSource: { kind: "third-party" },
          facts: { kind: "install", ghostId: "demo", name: "Demo", version: "1", permissions: [] } } };
        case "management:answer": installed = true; throw new Error("[TIMEOUT] remote invoke timed out");
        case "management:operation":
          if (receiptGone) throw hostError("NOT_FOUND");
          return { operationId: request.input.operationId, phase: "running" };
        default: throw new Error("unexpected " + request.actionId);
      }
    });
    await openMarket();
    await act(async () => shownMarket().setFilter("custom"));
    await settle();
    await act(async () => shownMarket().install(shownMarket().items[0]));
    await settle(14);
    await act(async () => fixture.props.get("confirmation").controller.answer(true));
    await settle(14);
    expect(shownMarket().rowState(item)).toEqual({ kind: "unknown" });
    receiptGone = true;
    await act(async () => { await shownMarket().checkResult(); });
    await settle(14);
    const opened = fixture.read.mock.calls.some((call: any[]) => call[2]?.id === "_root__demo");
    if (expected === "installed") expect(opened).toBe(true);
    else {
      expect(opened).toBe(false);
      expect(shownMarket()).toMatchObject({ installBusy: false });
      expect(shownMarket().rowState(item)).toEqual({ kind: "failed", messageKey: "plugins.market.unconfirmedMismatch" });
    }
    expect(requests.filter((request) => request.actionId === "management:begin")).toHaveLength(1);
  });
  // Without the consent the phone has no source to bind to: even a matching-looking install stays unconfirmed.
  it("keeps a custom-market install unconfirmed when its consent was never received", async () => {
    const { publisherKind: _server, ...base } = marketItem("demo", "Demo");
    const item = { ...base, pluginId: "custom:Team/demo", sourceType: "git-market", sourceMarketName: "Team", sourceIdentity: sourceA };
    let installed = false;
    marketWire((request) => {
      switch (request.actionId) {
        case "management:snapshot":
          if (request.input?.read === "capabilities") return { catalogPaging: true };
          if (request.input?.read === "catalog") return { ...marketPage(installed ? [] : [item]), customSourceNames: ["Team"] };
          return managementSnapshot(installed);
        case "management:market-detail":
          return { ...item, installState: installed ? "installed" : "not-installed", ...(installed ? { installedSourceId: sourceA.sourceId } : {}),
            manifest: { schemaVersion: 3, id: "demo", name: "Demo", version: "1" } };
        case "management:begin": installed = true; throw new Error("[TIMEOUT] remote invoke timed out");
        case "management:operation": throw hostError("NOT_FOUND");
        default: throw new Error("unexpected " + request.actionId);
      }
    });
    await openMarket();
    await act(async () => shownMarket().setFilter("custom"));
    await settle();
    await act(async () => shownMarket().install(shownMarket().items[0]));
    await settle(14);
    await act(async () => { await shownMarket().checkResult(); });
    await settle(14);
    expect(fixture.read.mock.calls.some((call: any[]) => call[2]?.id === "_root__demo")).toBe(false);
    expect(shownMarket().rowState(item)).toEqual({ kind: "failed", messageKey: "plugins.market.unconfirmedMismatch" });
  });
  // Maintainer review 07:23: in each case the computer later has the same plugin at the same release (from another
  // operation); the receipt is gone. Nothing may be opened as this attempt's result, and nothing is sent again. Since
  // contract V2.9 this follows from the Host's evidence: none of these installs carries this attempt's operation id.
  const folderA = { kind: "local", sourceId: "SourceA_0123456789abcd" }, folderB = { kind: "local", sourceId: "SourceB_0123456789abcd" };
  it.each([
    ["① the consent named another source than the one chosen (Allow unavailable)", "mismatch"],
    ["② the person rejected and the reply was lost", "rejected"],
    ["③ the consent was shown and never answered", "unanswered"],
    ["④ begin was sent and the consent never arrived", "noConsent"],
  ] as const)("keeps the result unconfirmed when nothing was approved: %s", async (_name, scenario) => {
    const { publisherKind: _server, ...base } = marketItem("demo", "Demo");
    const custom = scenario === "mismatch";
    const shown = custom ? { ...base, pluginId: "custom:Team/demo", sourceType: "local-market", sourceMarketName: "Team", sourceIdentity: folderA } : item;
    let onComputer = false, receiptGone = false;
    const requests = marketWire((request) => {
      switch (request.actionId) {
        case "management:snapshot":
          if (request.input?.read === "capabilities") return { catalogPaging: true };
          if (request.input?.read === "catalog") return { ...marketPage(onComputer ? [] : [shown]), customSourceNames: custom ? ["Team"] : [] };
          return managementSnapshot(onComputer);
        case "management:market-detail":
          return { ...shown, installState: onComputer ? "installed" : "not-installed",
            ...(custom && onComputer ? { installedSourceId: folderB.sourceId } : {}),
            manifest: { schemaVersion: 3, id: "demo", name: "Demo", version: "1" } };
        case "management:begin":
          if (scenario === "noConsent") { onComputer = true; throw new Error("[TIMEOUT] remote invoke timed out"); }
          return custom ? { operationId: request.input.operationId, phase: "confirmation", consent: {
            requestId: "consent", initiator: "user", origin: "custom-market", originLabel: "Team", originSource: folderB,
            installationSource: { kind: "third-party" }, facts: { kind: "install", ghostId: "demo", name: "Demo", version: "1", permissions: [] } } }
            : demoConsent(request);
        case "management:answer": throw new Error("[TIMEOUT] remote invoke timed out");
        case "management:operation":
          if (receiptGone) throw hostError("NOT_FOUND");
          return { operationId: request.input.operationId, phase: "confirmation" };
        default: throw new Error("unexpected " + request.actionId);
      }
    });
    await openMarket();
    if (custom) { await act(async () => shownMarket().setFilter("custom")); await settle(); }
    await act(async () => shownMarket().install(shownMarket().items[0]));
    await settle(14);
    const controller = fixture.props.get("confirmation").controller;
    if (scenario === "mismatch") await act(async () => { await controller.answer(true); }); // refused: no answer is sent
    if (scenario === "rejected") await act(async () => { await controller.answer(false); });
    await settle(14);
    // Meanwhile the same plugin appears on the computer (from another operation) and the receipt expires.
    onComputer = true; receiptGone = true;
    if (scenario === "unanswered" || scenario === "mismatch") await act(async () => { await controller.reconcile(); });
    else await act(async () => { await shownMarket().checkResult(); });
    await settle(14);
    expect(fixture.read.mock.calls.some((call: any[]) => call[2]?.id === "_root__demo")).toBe(false);
    expect(shownMarket()).toMatchObject({ installBusy: false });
    expect(shownMarket().rowState(shown)).toEqual({ kind: "failed", messageKey: "plugins.market.unconfirmedMismatch" });
    expect(requests.filter((request) => request.actionId === "management:begin")).toHaveLength(1);
    expect(requests.filter((request) => request.actionId === "management:answer"))
      .toHaveLength(scenario === "rejected" ? 1 : 0);
  });
  // Maintainer review 05:55 #2: both detail reads show A, then the computer points the same-name market at folder B
  // (same id, release and manifest) and the Host packs B. The consent must be compared with the identity chosen.
  it("keeps only Reject when the consent names another source than the one chosen after the last detail read", async () => {
    const { publisherKind: _server, ...base } = marketItem("demo", "Demo");
    const folderA = { kind: "local", sourceId: "SourceA_0123456789abcd" }, folderB = { kind: "local", sourceId: "SourceB_0123456789abcd" };
    const item = { ...base, pluginId: "custom:Team/demo", sourceType: "local-market", sourceMarketName: "Team", sourceIdentity: folderA };
    const requests = marketWire((request) => {
      switch (request.actionId) {
        case "management:snapshot":
          if (request.input?.read === "capabilities") return { catalogPaging: true };
          if (request.input?.read === "catalog") return { ...marketPage([item]), customSourceNames: ["Team"] };
          return managementSnapshot(false);
        case "management:market-detail": return { ...item, manifest: { schemaVersion: 3, id: "demo", name: "Demo", version: "1" } };
        case "management:begin": return { operationId: request.input.operationId, phase: "confirmation", consent: {
          requestId: "consent", initiator: "user", origin: "custom-market", originLabel: "Team", originSource: folderB,
          installationSource: { kind: "third-party" }, facts: { kind: "install", ghostId: "demo", name: "Demo", version: "1", permissions: [] } } };
        default: throw new Error("unexpected " + request.actionId);
      }
    });
    await openMarket();
    await act(async () => shownMarket().setFilter("custom"));
    await settle();
    await act(async () => shownMarket().install(shownMarket().items[0]));
    await settle(14);
    expect(requests.filter((request) => request.actionId === "management:market-detail")).toHaveLength(2);
    const sheet = fixture.props.get("confirmation");
    expect(sheet.state.expectedSource).toEqual(folderA);
    const view = pluginConsentPresentation(sheet.state.receipt.consent, (key: string) => key, "Mac", sheet.state.expectedSource);
    expect(view).toMatchObject({ allowBlocked: true, sourceChanged: "plugins.notice.consentSource.sourceChanged" });
  });
  // Maintainer review 04:44 #1: the controller re-reads the detail right before begin; a same-name market that now
  // points to another source (same id, release and manifest) must stop there, and so must a detail without a source.
  it.each([
    ["another source under the same name", { kind: "git", repository: "github.com/other/market", sourceId: "SourceB_0123456789abcd" }, "plugins.market.sourceChanged"],
    ["the same repository text but another source id", { ...sourceA, sourceId: "SourceB_0123456789abcd" }, "plugins.market.sourceChanged"],
    // Missing is not "changed": the computer did not name the source (refresh or update it there).
    ["no source identity", undefined, "plugins.market.sourceUnverified"],
  ])("stops before begin when the last detail read shows %s", async (_name, laterSource, messageKey) => {
    const { publisherKind: _server, ...base } = marketItem("demo", "Demo");
    const item = { ...base, pluginId: "custom:Team/demo", sourceType: "git-market", sourceMarketName: "Team", sourceIdentity: sourceA };
    let details = 0;
    const requests = marketWire((request) => {
      switch (request.actionId) {
        case "management:snapshot":
          if (request.input?.read === "capabilities") return { catalogPaging: true };
          if (request.input?.read === "catalog") return { ...marketPage([item]), customSourceNames: ["Team"] };
          return managementSnapshot(false);
        case "management:market-detail": {
          // The market's own read sees A; the controller's read right before begin sees the later source.
          const { sourceIdentity: _a, ...rest } = item;
          const source = ++details === 1 ? sourceA : laterSource;
          return { ...rest, ...(source ? { sourceIdentity: source } : {}), manifest: { schemaVersion: 3, id: "demo", name: "Demo", version: "1" } };
        }
        case "management:begin": throw new Error("begin must not be sent");
        default: throw new Error("unexpected " + request.actionId);
      }
    });
    await openMarket();
    await act(async () => shownMarket().setFilter("custom"));
    await settle();
    await act(async () => shownMarket().install(shownMarket().items[0]));
    await settle(14);
    expect(details).toBe(2);
    expect(requests.some((request) => request.actionId === "management:begin")).toBe(false);
    expect(shownMarket()).toMatchObject({ installBusy: false });
    expect(shownMarket().rowState(item)).toEqual({ kind: "failed", messageKey });
  });
  it("stays unconfirmed while the original operation may still exist on an unreachable computer", async () => {
    let sameIdOnComputer = false;
    installWire({
      begin: () => { sameIdOnComputer = true; throw new Error("[TIMEOUT] remote invoke timed out"); },
      // Not NOT_FOUND: the Host may still hold the receipt, so nothing is concluded yet.
      operation: () => { throw new Error("[TIMEOUT] remote invoke timed out"); },
      installed: () => sameIdOnComputer,
      detail: () => ({ ...item, installState: sameIdOnComputer ? "conflict" : "not-installed",
        manifest: { schemaVersion: 3, id: "demo", name: "Demo", version: "1" } }),
    });
    await openMarket();
    await act(async () => shownMarket().install(shownMarket().items[0]));
    await settle(14);
    await act(async () => { await shownMarket().checkResult(); });
    await settle(14);
    expect(shownMarket()).toMatchObject({ installBusy: true });
    expect(shownMarket().rowState(item)).toEqual({ kind: "unknown" });
  });
});
// iOS simulator report (2026-11-25): back from the new installed detail after the 30 s window showed an empty market.
it("still lists the remaining market plugins when returning from the new installed detail after the reuse window", async () => {
  const item = marketItem("demo", "Demo"), other = marketItem("other", "Other");
  let installed = false;
  marketWire((request) => {
    switch (request.actionId) {
      case "management:snapshot":
        if (request.input?.read === "capabilities") return { catalogPaging: true };
        // The Host excludes installed plugins from the page, as excludeInstalled asks.
        if (request.input?.read === "catalog") return marketPage(installed ? [other] : [item, other]);
        return managementSnapshot(installed);
      case "management:market-detail": return { ...item, manifest: { schemaVersion: 3, id: "demo", name: "Demo", version: "1" } };
      case "management:begin": return { operationId: request.input.operationId, phase: "confirmation", consent: {
        requestId: "consent", initiator: "user", origin: "market",
        facts: { kind: "install", ghostId: "demo", name: "Demo", version: "1", permissions: [] } } };
      case "management:answer": installed = true; return { operationId: request.input.operationId, phase: "succeeded" };
      default: return {};
    }
  });
  await openMarket();
  await act(async () => shownMarket().install(shownMarket().items[0]));
  await settle(14);
  await act(async () => fixture.props.get("confirmation").controller.answer(true));
  await settle(14);
  expect(fixture.props.get("header").title).toBe("Demo");
  const later = Date.now() + 31_000;
  const clock = vi.spyOn(Date, "now").mockReturnValue(later);
  try {
    await act(async () => fixture.props.get("header").onBack());
    await settle(14);
    expect(shownMarket()).toMatchObject({ status: "ready" });
    expect(shownMarket().items.map((row: any) => row.name)).toEqual(["Other"]);
  } finally { clock.mockRestore(); }
});
// iOS simulator report (2026-11-25): after a supported probe, a Host that now rejects paged reads kept the old list.
it.each([
  ["rejects paged reads", true, "outdated"],
  ["keeps rejecting one request", false, "ready"],
])("probes again once when a refresh finds the computer %s", async (_name, oldHost, status) => {
  const item = marketItem("demo", "Demo");
  let rejecting = false;
  const requests = marketWire((request) => {
    if (rejecting && (request.input?.read === "catalog" || (oldHost && request.input?.read === "capabilities")))
      throw new Error("[INVALID_PARAMS] Invalid plugin management request");
    return request.input?.read === "capabilities" ? { catalogPaging: true } : marketPage([item]);
  });
  await openMarket();
  expect(shownMarket().items.map((row: any) => row.name)).toEqual(["Demo"]);
  rejecting = true;
  await act(async () => { await shownMarket().refresh(); });
  await settle(20);
  expect(shownMarket().status).toBe(status);
  // One re-probe per computer and connection: a request the Host keeps rejecting cannot loop.
  expect(requests.filter((request) => request.input?.read === "capabilities")).toHaveLength(2);
  if (!oldHost) expect(shownMarket()).toMatchObject({ items: [item], notices: { stale: true } });
});
it("keeps the shown rows with a read-failed note when a refresh fails", async () => {
  const item = marketItem("demo", "Demo");
  let failing = false;
  marketWire((request) => {
    if (failing && request.input?.read === "catalog") throw new Error("[TIMEOUT] remote invoke timed out");
    return request.input?.read === "capabilities" ? { catalogPaging: true } : marketPage([item]);
  });
  await openMarket();
  expect(shownMarket().notices.stale).toBe(false);
  failing = true;
  await act(async () => { await shownMarket().refresh(); });
  await settle();
  expect(shownMarket()).toMatchObject({ status: "ready", items: [item], notices: { stale: true } });
});

// Review F1 (2026-11-25): changing the Installed tab's computer during an install moved the market and
// put that install's failure on the same plugin of the other computer.
it("keeps the market on the installing computer and records its failure for that computer only", async () => {
  fixture.extraDevices = [{ deviceId: "pc", name: "PC", platform: "win32", remoteControlEnabled: true }];
  const item = marketItem("demo", "Demo");
  marketWire((request) => {
    switch (request.actionId) {
      case "management:snapshot":
        if (request.input?.read === "capabilities") return { catalogPaging: true };
        if (request.input?.read === "catalog") return marketPage([item]);
        return managementSnapshot(false);
      case "management:market-detail": return { ...item, manifest: { schemaVersion: 3, id: "demo", name: "Demo", version: "1" } };
      case "management:begin": return { operationId: request.input.operationId, phase: "confirmation", consent: {
        requestId: "consent", initiator: "user", origin: "market",
        facts: { kind: "install", ghostId: "demo", name: "Demo", version: "1", permissions: [] } } };
      case "management:answer": return { operationId: request.input.operationId, phase: "failed", errorCode: "GHOST_DOWNLOAD_FAILED" };
      default: return {};
    }
  });
  await openMarket();
  expect(shownMarket().target.deviceId).toBe("mac");
  await act(async () => shownMarket().install(shownMarket().items[0]));
  await settle(14);
  await act(async () => fixture.props.get("directory").onDeviceChange("pc"));
  await settle();
  expect(shownMarket().target.deviceId).toBe("mac");
  await act(async () => fixture.props.get("confirmation").controller.answer(true));
  await settle(14);
  // After the install ends, the later explicit Installed-tab choice applies; the failure stays on the Mac.
  expect(shownMarket().target.deviceId).toBe("pc");
  expect(shownMarket().rowState(item)).toEqual({ kind: "idle" });
  await act(async () => shownMarket().selectDevice("mac"));
  await settle();
  expect(shownMarket().rowState(item)).toEqual({ kind: "failed", messageKey: "plugins.market.errors.downloadFailed" });
});
/* 测试价值（PR 评审：两台电脑的市场缓存与续读，2026-11-25）
 * - 生产入口与可观察结果：真实 PluginsScreen + usePluginMarket，观察切换电脑后显示的市场状态、条目与发往电脑的读取。
 * - 依据：remote-and-mobile-adaptation.md 旧响应不落地也不能让页面卡住；server-channel-review.md 不服务当前页面的读取不发。
 * - 缺口：已有用例只覆盖迟到分页不落地，不覆盖丢弃后的缓存状态、跨电脑的安装后清理、离开后的续读与搜索续读。
 * - 最小失败输入：A 的首页 / 下一页在切到 B 后才返回再切回 A；先浏览 B 再在 A 装同一插件；空发布者页返回前离开市场；
 *   默认官方筛选下搜索到一页社区插件；偏好读取慢于市场打开。
 * - tier: unit（jsdom，内存 Host）。
 */
describe("market caches across two computers", () => {
  const twoComputers = () => { fixture.extraDevices = [{ deviceId: "pc", name: "PC", platform: "win32", remoteControlEnabled: true }]; };
  it.each(["first page", "next page"])("reads again when returning to a computer whose %s reply was dropped", async (which) => {
    twoComputers();
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let macPages = 0;
    const requests = marketWire(async (request) => {
      if (request.input?.read === "capabilities") return { catalogPaging: true };
      if (request.input?.query?.counts) return { ...marketPage([]), counts: null };
      if (request.device !== "mac") return marketPage([marketItem("pc-only", "PC only")]);
      const index = ++macPages;
      const heldIndex = which === "first page" ? 1 : 2;
      if (index === heldIndex) await held;
      return { ...marketPage([marketItem(`mac-${index}`, `Mac ${index}`)]), nextCursor: index === 1 ? "cursor-1" : null };
    });
    await openMarket();
    if (which === "next page") {
      expect(shownMarket().items.map((row: any) => row.name)).toEqual(["Mac 1"]);
      await act(async () => shownMarket().loadMore());
      await settle();
    }
    await act(async () => shownMarket().selectDevice("pc"));
    await settle();
    await act(async () => { release(); });
    await settle();
    await act(async () => shownMarket().selectDevice("mac"));
    await settle(14);
    expect(shownMarket()).toMatchObject({ status: "ready", loadingMore: false });
    if (which === "first page") {
      expect(shownMarket().items.map((row: any) => row.name)).toEqual(["Mac 2"]);
      expect(requests.filter((request) => request.device === "mac" && request.input?.read === "catalog"
        && !request.input.query.counts)).toHaveLength(2);
    } else expect(shownMarket()).toMatchObject({ hasMore: true, items: [expect.objectContaining({ name: "Mac 1" })] });
  });
  it("removes an installed plugin only from the computer it was installed on", async () => {
    twoComputers();
    const item = marketItem("demo", "Demo"), other = marketItem("other", "Other");
    let installed = false;
    marketWire((request) => {
      switch (request.actionId) {
        case "management:snapshot":
          if (request.input?.read === "capabilities") return { catalogPaging: true };
          if (request.input?.read === "catalog") return marketPage(request.device === "mac" && installed ? [other] : [item, other]);
          return managementSnapshot(request.device === "mac" && installed);
        case "management:market-detail": return { ...item, manifest: { schemaVersion: 3, id: "demo", name: "Demo", version: "1" } };
        case "management:begin": return { operationId: request.input.operationId, phase: "confirmation", consent: {
          requestId: "consent", initiator: "user", origin: "market",
          facts: { kind: "install", ghostId: "demo", name: "Demo", version: "1", permissions: [] } } };
        case "management:answer": installed = true; return { operationId: request.input.operationId, phase: "succeeded" };
        default: return {};
      }
    });
    await openMarket();
    await act(async () => shownMarket().selectDevice("pc"));
    await settle();
    expect(shownMarket().items.map((row: any) => row.name)).toEqual(["Demo", "Other"]);
    await act(async () => shownMarket().selectDevice("mac"));
    await settle();
    await act(async () => shownMarket().install(shownMarket().items[0]));
    await settle(14);
    await act(async () => fixture.props.get("confirmation").controller.answer(true));
    await settle(14);
    expect(fixture.props.get("header").title).toBe("Demo");
    await act(async () => fixture.props.get("header").onBack());
    await settle();
    // Within the reuse window the PC list is not re-read, so it must still hold the PC's own facts.
    await act(async () => shownMarket().selectDevice("pc"));
    await settle();
    expect(shownMarket().items.map((row: any) => row.name)).toEqual(["Demo", "Other"]);
  });
  it("stops chaining empty publisher pages once the market is left", async () => {
    const community = { ...marketItem("community", "Community"), publisherKind: "personal" };
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let page = 0;
    const requests = marketWire(async (request) => {
      if (request.input?.read === "capabilities") return { catalogPaging: true };
      if (request.input?.query?.counts) return { ...marketPage([]), counts: null };
      if (++page === 1) await held;
      return { ...marketPage([{ ...community, pluginId: `market/c${page}`, ghostId: `c${page}` }]), nextCursor: `cursor-${page}` };
    });
    await openMarket();
    await act(async () => fixture.props.get("directory").onSegmentChange("installed"));
    await act(async () => { release(); });
    await settle(20);
    expect(requests.filter((request) => request.input?.read === "catalog" && !request.input.query.counts)).toHaveLength(1);
  });
  // Codex review (d3fccdf7): in the background the route stays focused and the computer stays online during
  // Device Link's exit grace period; an empty publisher page then kept chaining reads nobody could see.
  it("stops chaining empty publisher pages while the app is in the background and resumes in the foreground", async () => {
    const community = { ...marketItem("community", "Community"), publisherKind: "personal" };
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let page = 0;
    const requests = marketWire(async (request) => {
      if (request.input?.read === "capabilities") return { catalogPaging: true };
      if (request.input?.query?.counts) return { ...marketPage([]), counts: null };
      if (++page === 1) await held;
      return { ...marketPage([{ ...community, pluginId: `market/c${page}`, ghostId: `c${page}` }]), nextCursor: `cursor-${page}` };
    });
    const pages = () => requests.filter((request) => request.input?.read === "catalog" && !request.input.query.counts);
    await openMarket();
    await act(async () => { fixture.appStateListeners.forEach((listener) => listener("background")); });
    await act(async () => { release(); });
    await settle(20);
    expect(pages()).toHaveLength(1);
    await act(async () => { fixture.appStateListeners.forEach((listener) => listener("active")); });
    await settle(20);
    expect(pages().length).toBeGreaterThan(1);
  });
  it("judges search pages by every source, so community results do not trigger extra reads", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const community = { ...marketItem("community", "Community"), publisherKind: "personal" };
      const requests = marketWire((request) => request.input?.read === "capabilities" ? { catalogPaging: true }
        : request.input?.query?.counts ? { ...marketPage([]), counts: null }
          : { ...marketPage([community]), nextCursor: "cursor-more" });
      await openMarket();
      const before = requests.filter((request) => request.input?.read === "catalog" && !request.input.query.counts).length;
      await act(async () => fixture.props.get("stack").headerSearchBarOptions.onChangeText({ nativeEvent: { text: "comm" } }));
      await act(async () => { await vi.advanceTimersByTimeAsync(300); });
      await settle(20);
      const searches = requests.slice(0).filter((request) => request.input?.read === "catalog" && !request.input.query.counts
        && request.input.query.query === "comm");
      expect(before).toBeGreaterThan(0);
      expect(searches).toHaveLength(1);
      expect(shownMarket().items.map((row: any) => row.name)).toEqual(["Community"]);
    } finally { vi.useRealTimers(); }
  });
  it("waits for the remembered market computer before picking one automatically", async () => {
    twoComputers();
    let releaseStored!: () => void;
    const stored = new Promise<void>((resolve) => { releaseStored = resolve; });
    fixture.storage.set("cindy.pluginMarketDevice.v1.demo", "pc");
    fixture.getStored.mockImplementation(async (key: string) => {
      if (key === "cindy.pluginMarketDevice.v1.demo") await stored;
      return fixture.storage.get(key) ?? null;
    });
    const requests = marketWire((request) => request.input?.read === "capabilities" ? { catalogPaging: true } : marketPage([]));
    await openMarket();
    expect(shownMarket().status).toBe("loading");
    await act(async () => { releaseStored(); });
    await settle();
    expect(shownMarket().target.deviceId).toBe("pc");
    expect(requests.filter((request) => request.device === "mac" && request.input?.read)).toEqual([]);
  });
});
// Codex review (2026-11-25): a refresh sent before an install must not write the pre-install rows back,
// and an unmounted page must not keep chaining empty publisher pages.
describe("market reads that outlive their purpose", () => {
  it("drops a refresh sent before an install, so the installed plugin does not come back as installable", async () => {
    const item = marketItem("demo", "Demo"), other = marketItem("other", "Other");
    let installed = false;
    let holdNextPage = false;
    let releasePage!: () => void;
    marketWire(async (request) => {
      switch (request.actionId) {
        case "management:snapshot": {
          if (request.input?.read === "capabilities") return { catalogPaging: true };
          if (request.input?.read === "catalog") {
            if (request.input.query.counts) return { ...marketPage([]), counts: null };
            // The page reflects the computer at the time the read was sent.
            const page = marketPage(installed ? [other] : [item, other]);
            if (holdNextPage) { holdNextPage = false; await new Promise<void>((resolve) => { releasePage = resolve; }); }
            return page;
          }
          return managementSnapshot(installed);
        }
        case "management:market-detail": return { ...item, manifest: { schemaVersion: 3, id: "demo", name: "Demo", version: "1" } };
        case "management:begin": return { operationId: request.input.operationId, phase: "confirmation", consent: {
          requestId: "consent", initiator: "user", origin: "market",
          facts: { kind: "install", ghostId: "demo", name: "Demo", version: "1", permissions: [] } } };
        case "management:answer": installed = true; return { operationId: request.input.operationId, phase: "succeeded" };
        default: return {};
      }
    });
    await openMarket();
    await act(async () => shownMarket().install(shownMarket().items[0]));
    await settle(14);
    holdNextPage = true;
    await act(async () => { void shownMarket().refresh(); });
    await settle();
    await act(async () => fixture.props.get("confirmation").controller.answer(true));
    await settle(14);
    expect(fixture.props.get("header").title).toBe("Demo");
    // The pre-install refresh reply arrives while the new installed detail is open.
    await act(async () => { releasePage(); });
    await settle();
    await act(async () => fixture.props.get("header").onBack());
    await settle(14);
    expect(shownMarket().items.map((row: any) => row.name)).toEqual(["Other"]);
  });
  // Maintainer review (2026-11-25): official and community share the public list key, and the debounced query
  // lags the typed one; a follow-up page must still serve what is on screen now.
  it.each(["switching from official to community", "typing a new search before it is debounced"])(
    "stops chaining an empty official page after %s", async (change) => {
      const community = { ...marketItem("community", "Community"), publisherKind: "personal" };
      let release!: () => void;
      const held = new Promise<void>((resolve) => { release = resolve; });
      let page = 0;
      const requests = marketWire(async (request) => {
        if (request.input?.read === "capabilities") return { catalogPaging: true };
        if (request.input?.query?.counts) return { ...marketPage([]), counts: null };
        if (++page === 1) await held;
        return { ...marketPage([{ ...community, pluginId: `market/c${page}`, ghostId: `c${page}` }]), nextCursor: `cursor-${page}` };
      });
      await openMarket();
      if (change.startsWith("switching")) await act(async () => shownMarket().setFilter("community"));
      else await act(async () => fixture.props.get("stack").headerSearchBarOptions.onChangeText({ nativeEvent: { text: "rota" } }));
      await act(async () => { release(); });
      await settle(20);
      // Only the original page was read for the empty query; no follow-up page for the stale official view.
      expect(requests.filter((request) => request.input?.read === "catalog" && !request.input.query.counts
        && !request.input.query.query)).toHaveLength(1);
    });
  it("stops chaining empty publisher pages once the plugins page is unmounted", async () => {
    const community = { ...marketItem("community", "Community"), publisherKind: "personal" };
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let page = 0;
    const requests = marketWire(async (request) => {
      if (request.input?.read === "capabilities") return { catalogPaging: true };
      if (request.input?.query?.counts) return { ...marketPage([]), counts: null };
      if (++page === 1) await held;
      return { ...marketPage([{ ...community, pluginId: `market/c${page}`, ghostId: `c${page}` }]), nextCursor: `cursor-${page}` };
    });
    await openMarket();
    await act(async () => root.render(null));
    await act(async () => { release(); });
    await settle(20);
    expect(requests.filter((request) => request.input?.read === "catalog" && !request.input.query.counts)).toHaveLength(1);
  });
});
/* 测试价值（PR #12684 第五轮评审：读取围栏统一与回执过期后的判定绑定，2026-11-25）
 * - 生产入口与可观察结果：真实 PluginsScreen + usePluginMarket + 管理 client/controller；观察真正离开设备互联的请求、
 *   能力探测状态、行内状态与是否打开已装实例。
 * - 依据：维护者 03:10 第 1 条（NOT_FOUND 后只用本次新读到的快照与实例，核对市场详情读取代次）；Codex：卸载后的发送围栏、
 *   同 scope 能力探测代次、搜索未稳定时的滚动续页；server-channel-review.md 无消费者的请求不发。
 * - 缺口：此前回包落地有围栏，排队中的请求在发出前没有；探测只比较 scope；loadMore 不看未去抖的搜索词；
 *   NOT_FOUND 后可用旧快照结束核实。
 * - 最小失败输入：排队中卸载；A 的第一次探测在第二次成功后才超时；去抖期间滚动；NOT_FOUND 后新快照挂起；旧详情晚到。
 * - tier: unit（jsdom，内存 Host）。
 */
describe("market read fences and lost-receipt facts", () => {
  type Request = { device: string; actionId?: string; input?: any; resourceRef?: any };
  // Like the real link queue: the client's last check (preSend) runs only when the request actually leaves.
  function queuedWire(respond: (request: Request) => unknown, wait: (request: Request | "manifest", device: string) => Promise<void> | undefined) {
    const sent: Request[] = [];
    fixture.realManagement = true;
    fixture.wire.mockImplementation(async (device: string, channel: string, args?: any[], options?: any) => {
      if (channel.endsWith(":manifest")) return transportSend(options,
        () => ({ protocolVersion: 1, collections: [{ id: "plugins", actions: [{ id: "management:snapshot", label: "Manage" }] }] }),
        () => wait("manifest", device));
      const envelope = args?.[0] ?? {};
      const request = { device, actionId: envelope.actionId, input: envelope.input, resourceRef: envelope.resourceRef };
      // `sent` records what passed the last check before the write (what actually reached the wire).
      return transportSend(options, async () => { sent.push(request); return { effects: [], result: await respond(request) }; },
        () => wait(request, device));
    });
    return sent;
  }
  const deferred = () => { let release!: () => void; const promise = new Promise<void>((resolve) => { release = resolve; }); return { promise, release }; };

  it("does not send queued catalog and count reads after the plugins page unmounts", async () => {
    const gate = deferred();
    const sent = queuedWire((request) => request.input?.read === "capabilities" ? { catalogPaging: true }
      : { ...marketPage([marketItem("demo", "Demo")]), counts: null },
    (request) => request !== "manifest" && request.input?.read === "catalog" ? gate.promise : undefined);
    await openMarket();
    await act(async () => root.render(null));
    await act(async () => { gate.release(); });
    await settle(10);
    expect(sent.filter((request) => request.input?.read === "catalog")).toEqual([]);
  });
  /* 测试价值（独立复核剩余项 1–5；自查发现的读取取消、卸载与重探问题）
   * - 生产入口与可观察结果：真实 PluginsScreen + usePluginMarket + 管理 client / controller，只替换传输；观察发出的请求、
   *   探测与详情的状态、是否重新打开详情。
   * - 依据：读取围栏关闭（离开市场、失焦、电脑离开、进后台、卸载）造成的结束是取消，不是失败；页面卸载后安装路径不再
   *   发请求也不打开详情；电脑重新在线时重探一次；装好后旧详情回包不重新打开详情。
   * - 最小失败输入：每条一次。tier: unit。
   */
  it("treats a market detail read cancelled by leaving the screen as interrupted, and reads it again on return", async () => {
    fixture.width = 900; // the market list stays beside its detail
    const item = marketItem("demo", "Demo");
    const gate = deferred();
    let held = true;
    queuedWire((request) => request.input?.read === "capabilities" ? { catalogPaging: true }
      : request.actionId === "management:market-detail" ? { ...item, manifest: { schemaVersion: 3, id: "demo", name: "Demo", version: "1" } }
        : marketPage([item]),
    (request) => request !== "manifest" && request.actionId === "management:market-detail" && held ? gate.promise : undefined);
    await openMarket();
    await act(async () => shownMarket().openDetail(item));
    await settle(6);
    // A notification or a deep link takes the screen away while the read is queued.
    fixture.focused = false;
    await act(async () => root.render(createElement(PluginsScreen)));
    held = false;
    await act(async () => { gate.release(); });
    await settle(10);
    expect(shownMarket().detail).toMatchObject({ failed: false });
    fixture.focused = true;
    await act(async () => root.render(createElement(PluginsScreen)));
    await settle(14);
    expect(shownMarket().detail).toMatchObject({ failed: false, loading: false, detail: expect.objectContaining({ pluginId: item.pluginId }) });
  });
  it("forgets a probe cancelled by leaving the screen instead of recording it as failed", async () => {
    fixture.width = 900;
    const gate = deferred();
    let held = true;
    queuedWire((request) => request.input?.read === "capabilities" ? { catalogPaging: true } : marketPage([marketItem("demo", "Demo")]),
      (request) => request !== "manifest" && request.input?.read === "capabilities" && held ? gate.promise : undefined);
    await openMarket();
    fixture.focused = false;
    await act(async () => root.render(createElement(PluginsScreen)));
    held = false;
    await act(async () => { gate.release(); });
    await settle(10);
    fixture.focused = true;
    await act(async () => root.render(createElement(PluginsScreen)));
    await settle(14);
    expect(shownMarket().status).not.toBe("failed");
    expect(shownMarket().canInstall).toBe(true);
  });
  it("probes again when an outdated computer comes back online", async () => {
    let paging = false;
    const sent = queuedWire((request) => request.input?.read === "capabilities" ? { catalogPaging: paging } : marketPage([marketItem("demo", "Demo")]), () => undefined);
    await openMarket();
    expect(shownMarket().canInstall).toBe(false);
    // The person updates Cindy on that computer; it restarts and comes back.
    paging = true;
    fixture.offlineDevices.add("mac");
    await act(async () => root.render(createElement(PluginsScreen)));
    fixture.offlineDevices.delete("mac");
    await act(async () => root.render(createElement(PluginsScreen)));
    await settle(14);
    expect(sent.filter((request) => request.input?.read === "capabilities").length).toBeGreaterThanOrEqual(2);
    expect(shownMarket().canInstall).toBe(true);
  });
  it("sends nothing for an install whose page was left while its detail read was queued", async () => {
    const item = marketItem("demo", "Demo");
    const gate = deferred();
    let hold = false;
    const sent = queuedWire((request) => request.input?.read === "capabilities" ? { catalogPaging: true }
      : request.actionId === "management:market-detail" ? { ...item, manifest: { schemaVersion: 3, id: "demo", name: "Demo", version: "1" } }
        : request.actionId === "management:snapshot" && request.input?.read === "installed" ? managementSnapshot(false) : marketPage([item]),
    (request) => request !== "manifest" && request.actionId === "management:market-detail" && hold ? gate.promise : undefined);
    await openMarket();
    hold = true;
    await act(async () => shownMarket().install(shownMarket().items[0]));
    await settle(10);
    const before = sent.length;
    await act(async () => root.render(null));
    await act(async () => { gate.release(); });
    await settle(14);
    expect(sent.slice(before).filter((request) => request.actionId === "management:market-detail" || request.actionId === "management:begin")).toEqual([]);
    expect(fixture.read).not.toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({ id: "_root__demo" }), expect.anything(), expect.anything());
  });
  it("does not reopen a market detail whose reply lands after the install completed", async () => {
    const item = marketItem("demo", "Demo");
    const gate = deferred();
    let holdDetail = false, installed = false, details = 0;
    queuedWire((request) => {
      if (request.input?.read === "capabilities") return { catalogPaging: true };
      if (request.actionId === "management:market-detail") return { ...item, installState: installed ? "installed" : "not-installed", manifest: { schemaVersion: 3, id: "demo", name: "Demo", version: "1" } };
      // The read-back after the install fails, so there is no instance to open (the case with no instanceKey).
      if (request.actionId === "management:snapshot" && request.input?.read === "installed") {
        if (installed) throw new Error("[TIMEOUT] read-back timed out");
        return managementSnapshot(false);
      }
      if (request.actionId === "management:begin") { installed = true; return { operationId: request.input.operationId, phase: "succeeded" }; }
      return marketPage([item]);
    }, (request) => {
      if (request === "manifest" || request.actionId !== "management:market-detail") return undefined;
      // Only the detail the person opened is held; the install's own reads go through.
      details += 1;
      return holdDetail && details === 1 ? gate.promise : undefined;
    });
    fixture.width = 900;
    await openMarket();
    // The person opened the plugin's detail (its read still in flight), then installed from the row.
    holdDetail = true;
    await act(async () => shownMarket().openDetail(item));
    await act(async () => shownMarket().install(shownMarket().items[0]));
    await settle(30);
    expect(shownMarket().installBusy).toBe(false);
    await act(async () => { gate.release(); });
    await settle(20);
    expect(shownMarket().detail).toBeNull();
  });
  it("does not send the paging probe when the manifest read finishes after the page unmounted", async () => {
    const gate = deferred();
    const sent = queuedWire(() => ({ catalogPaging: true }), (request) => request === "manifest" ? gate.promise : undefined);
    await act(async () => root.render(createElement(PluginsScreen)));
    await act(async () => fixture.props.get("directory").onSegmentChange("market"));
    await settle();
    await act(async () => root.render(null));
    await act(async () => { gate.release(); });
    await settle(10);
    expect(sent.filter((request) => request.input?.read === "capabilities")).toEqual([]);
  });
  it("keeps a newer successful probe when an older probe for the same computer fails later", async () => {
    fixture.extraDevices = [{ deviceId: "pc", name: "PC", platform: "win32", remoteControlEnabled: true }];
    const firstMacProbe = deferred();
    let macManifests = 0;
    fixture.realManagement = true;
    fixture.wire.mockImplementation(async (device: string, channel: string, args?: any[], options?: any) => {
      if (channel.endsWith(":manifest")) {
        if (device === "mac" && ++macManifests === 1) { await firstMacProbe.promise; throw new Error("[TIMEOUT] remote invoke timed out"); }
        options?.preSend?.(); options?.onRequestWritten?.();
        return { protocolVersion: 1, collections: [{ id: "plugins", actions: [{ id: "management:snapshot", label: "Manage" }] }] };
      }
      options?.preSend?.(); options?.onRequestWritten?.();
      const input = args?.[0]?.input;
      return { effects: [], result: input?.read === "capabilities" ? { catalogPaging: true } : marketPage([marketItem(`${device}-demo`, `${device} demo`)]) };
    });
    await openMarket();
    expect(shownMarket()).toMatchObject({ status: "loading", target: { deviceId: "mac" } });
    await act(async () => shownMarket().selectDevice("pc"));
    await settle();
    await act(async () => shownMarket().selectDevice("mac"));
    await settle(14);
    expect(shownMarket()).toMatchObject({ status: "ready", items: [expect.objectContaining({ name: "mac demo" })] });
    await act(async () => { firstMacProbe.release(); });
    await settle(10);
    expect(shownMarket().status).toBe("ready");
  });
  it("does not load the next page of the old search while the new search text is not debounced yet", async () => {
    const sent = queuedWire((request) => request.input?.read === "capabilities" ? { catalogPaging: true }
      : { ...marketPage([marketItem("demo", "Demo")]), nextCursor: "cursor-1", counts: null }, () => undefined);
    await openMarket();
    expect(shownMarket()).toMatchObject({ hasMore: true });
    await act(async () => fixture.props.get("stack").headerSearchBarOptions.onChangeText({ nativeEvent: { text: "rota" } }));
    await act(async () => shownMarket().loadMore());
    await settle();
    expect(sent.filter((request) => request.input?.query?.cursor)).toEqual([]);
  });

  // Maintainer review 03:54 #3: a probe cancelled by leaving the market must not leave the market stuck at "failed".
  it("probes again when coming back after leaving the market while the probe was queued", async () => {
    const gate = deferred();
    let firstManifest = true;
    queuedWire((request) => request.input?.read === "capabilities" ? { catalogPaging: true } : marketPage([marketItem("demo", "Demo")]),
      (request) => {
        if (request === "manifest" && firstManifest) { firstManifest = false; return gate.promise; }
        return undefined;
      });
    await openMarket();
    await act(async () => fixture.props.get("directory").onSegmentChange("installed"));
    await act(async () => { gate.release(); });
    await settle(10);
    await act(async () => fixture.props.get("directory").onSegmentChange("market"));
    await settle(14);
    expect(shownMarket()).toMatchObject({ status: "ready", items: [expect.objectContaining({ name: "Demo" })] });
  });
  // Maintainer review 03:54 #3: a next page queued by scrolling is checked again when it actually leaves.
  it("drops a queued next page when a new search is typed before it is sent", async () => {
    const gate = deferred();
    const sent = queuedWire((request) => request.input?.read === "capabilities" ? { catalogPaging: true }
      : { ...marketPage([marketItem("demo", "Demo")]), nextCursor: "cursor-1", counts: null },
    (request) => request !== "manifest" && request.input?.query?.cursor ? gate.promise : undefined);
    await openMarket();
    await act(async () => shownMarket().loadMore());
    await settle();
    await act(async () => fixture.props.get("stack").headerSearchBarOptions.onChangeText({ nativeEvent: { text: "rota" } }));
    await act(async () => { gate.release(); });
    await settle(10);
    expect(sent.filter((request) => request.input?.query?.cursor)).toEqual([]);
  });

  // Codex review (3200468): search A's first page and its count read wait in the Device Link queue; the search
  // becomes B (debounced). The first page skipped the follow-up check and counts checked only their cache entry, so
  // both A reads still went out after B was shown.
  it("drops queued first-page and count reads of a search that was replaced before they were sent", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const gate = deferred();
      const sent = queuedWire((request) => request.input?.read === "capabilities" ? { catalogPaging: true }
        : { ...marketPage([marketItem("demo", "Demo")]), counts: null },
      (request) => request !== "manifest" && request.input?.read === "catalog" && request.input?.query?.query === "alpha" ? gate.promise : undefined);
      await openMarket();
      const type = async (text: string) => {
        await act(async () => fixture.props.get("stack").headerSearchBarOptions.onChangeText({ nativeEvent: { text } }));
        await act(async () => { await vi.advanceTimersByTimeAsync(300); });
        await settle(10);
      };
      await type("alpha");
      await type("beta");
      expect(sent.some((request) => request.input?.query?.query === "beta")).toBe(true);
      await act(async () => { gate.release(); });
      await settle(10);
      expect(sent.filter((request) => request.input?.query?.query === "alpha")).toEqual([]);
    } finally { vi.useRealTimers(); }
  });
  // Maintainer review 03:10 #1: a snapshot read before NOT_FOUND must not settle the result, and a market
  // detail from an earlier verification must not open an instance.
  const item = marketItem("demo", "Demo");
  const demoManifest = { schemaVersion: 3, id: "demo", name: "Demo", version: "1" };
  it("waits for the snapshot read after NOT_FOUND instead of settling from an earlier one", async () => {
    let installed = false, receiptGone = false;
    const snapshotGate = deferred();
    let holdSnapshot = false;
    const sent = queuedWire((request) => {
      switch (request.actionId) {
        case "management:snapshot":
          if (request.input?.read === "capabilities") return { catalogPaging: true };
          if (request.input?.read === "catalog") return marketPage([item]);
          return managementSnapshot(installed);
        case "management:market-detail": return { ...item, installState: installed ? "conflict" : "not-installed", manifest: demoManifest };
        // The install is accepted and keeps running on the computer.
        case "management:begin": installed = true; return { operationId: request.input.operationId, phase: "running" };
        case "management:operation":
          if (receiptGone) throw hostError("NOT_FOUND");
          return { operationId: request.input.operationId, phase: "running" };
        default: throw new Error("unexpected " + request.actionId);
      }
    }, (request) => {
      if (holdSnapshot && request !== "manifest" && request.actionId === "management:snapshot" && request.input?.read === "installed") {
        holdSnapshot = false;
        return snapshotGate.promise;
      }
      return undefined;
    });
    await openMarket();
    await act(async () => shownMarket().install(shownMarket().items[0]));
    await settle(14);
    expect(fixture.props.get("confirmation").state.outcome).toBe("running");
    // While the operation runs, a plugin-change refresh puts the same-id instance into the controller's snapshot.
    await act(async () => { await fixture.props.get("confirmation").controller.refresh(); });
    await settle();
    expect(shownMarket()).toMatchObject({ installBusy: true });
    receiptGone = true;
    holdSnapshot = true;
    const detailsBefore = sent.filter((request) => request.actionId === "management:market-detail").length;
    await act(async () => { void shownMarket().checkResult(); });
    await settle(14);
    // NOT_FOUND arrived but the fresh snapshot is still being read: nothing is concluded yet.
    expect(shownMarket()).toMatchObject({ installBusy: true });
    expect(shownMarket().rowState(item)).toEqual({ kind: "unknown" });
    expect(sent.filter((request) => request.actionId === "management:market-detail")).toHaveLength(detailsBefore);
    // Meanwhile the instance was removed on the computer; the fresh facts decide.
    installed = false;
    await act(async () => { snapshotGate.release(); });
    await settle(14);
    expect(shownMarket().rowState(item)).toEqual({ kind: "failed", messageKey: "plugins.market.unconfirmedNotInstalled" });
    expect(fixture.read.mock.calls.some((call: any[]) => call[2]?.id === "_root__demo")).toBe(false);
  });
  // Maintainer review 03:54 #1: tapping "Check result" again starts a new round before its operation query returns.
  it("does not let the first round's detail settle while the second round's operation query is in flight", async () => {
    let verifying = false, round = 0;
    const firstDetail = deferred(), secondQuery = deferred();
    queuedWire((request) => {
      switch (request.actionId) {
        case "management:snapshot":
          if (request.input?.read === "capabilities") return { catalogPaging: true };
          if (request.input?.read === "catalog") return marketPage([item]);
          return managementSnapshot(verifying);
        case "management:market-detail": return { ...item, installState: verifying ? "installed" : "not-installed", ...(verifying ? { installedOperationId: "screen-operation" } : {}), manifest: demoManifest };
        case "management:begin": return demoConsent(request);
        case "management:answer": verifying = true; throw new Error("[TIMEOUT] remote invoke timed out");
        case "management:operation": throw hostError("NOT_FOUND");
        default: throw new Error("unexpected " + request.actionId);
      }
    }, (request) => {
      if (request === "manifest") return undefined;
      if (verifying && request.actionId === "management:market-detail" && round === 1) return firstDetail.promise;
      if (request.actionId === "management:operation" && ++round === 2) return secondQuery.promise;
      return undefined;
    });
    await openMarket();
    await act(async () => shownMarket().install(shownMarket().items[0]));
    await settle(14);
    await approveOnPhone();
    await act(async () => { void shownMarket().checkResult(); });
    await settle(14);
    await act(async () => { void shownMarket().checkResult(); });
    await settle(6);
    // The first round's detail would say "installed"; the second round's query has not returned yet.
    await act(async () => { firstDetail.release(); });
    await settle(10);
    expect(fixture.read.mock.calls.some((call: any[]) => call[2]?.id === "_root__demo")).toBe(false);
    expect(shownMarket()).toMatchObject({ installBusy: true });
    await act(async () => { secondQuery.release(); });
    await settle(14);
    // The second round reads its own facts and settles: the plugin is installed from this release.
    expect(fixture.read.mock.calls.some((call: any[]) => call[2]?.id === "_root__demo")).toBe(true);
  });
  // Maintainer review 03:54 #2: the snapshot read after NOT_FOUND (A) is replaced by a later plugin-change read (B).
  it("settles from the newer snapshot when the read after NOT_FOUND is replaced and returns last", async () => {
    let instancePresent = false;
    const readA = deferred();
    let holdNext = false;
    queuedWire((request) => {
      switch (request.actionId) {
        case "management:snapshot":
          if (request.input?.read === "capabilities") return { catalogPaging: true };
          if (request.input?.read === "catalog") return marketPage([item]);
          // A answers with the state at the time it was sent (before the instance appeared).
          return managementSnapshot(instancePresent && !(request as any).sentBeforeInstance);
        case "management:market-detail": return { ...item, installState: instancePresent ? "installed" : "not-installed", ...(instancePresent ? { installedOperationId: "screen-operation" } : {}), manifest: demoManifest };
        case "management:begin": return demoConsent(request);
        case "management:answer": throw new Error("[TIMEOUT] remote invoke timed out");
        case "management:operation": throw hostError("NOT_FOUND");
        default: throw new Error("unexpected " + request.actionId);
      }
    }, (request) => {
      if (holdNext && request !== "manifest" && request.actionId === "management:snapshot" && request.input?.read === "installed") {
        holdNext = false;
        (request as any).sentBeforeInstance = true;
        return readA.promise;
      }
      return undefined;
    });
    await openMarket();
    await act(async () => shownMarket().install(shownMarket().items[0]));
    await settle(14);
    await approveOnPhone();
    holdNext = true;
    await act(async () => { void shownMarket().checkResult(); });
    await settle(6);
    // B: a plugin-change refresh starts after A and returns first, showing the plugin installed.
    instancePresent = true;
    await act(async () => { await fixture.props.get("confirmation").controller.refresh(); });
    await settle(6);
    await act(async () => { readA.release(); });
    await settle(14);
    expect(shownMarket().rowState(item)).not.toEqual({ kind: "failed", messageKey: "plugins.market.unconfirmedNotInstalled" });
    expect(fixture.read.mock.calls.some((call: any[]) => call[2]?.id === "_root__demo")).toBe(true);
  });
  // Maintainer review 04:20: A (read after NOT_FOUND) is held; refresh B lands showing nothing; a newer refresh C is
  // still in flight when A returns. B was replaced by C, so it must not conclude "not on this computer".
  it("waits for the newest installed read when the facts after NOT_FOUND are replaced twice", async () => {
    const readA = deferred(), readC = deferred();
    let hold: "A" | "C" | null = null, began = false;
    queuedWire((request) => {
      switch (request.actionId) {
        case "management:snapshot":
          if (request.input?.read === "capabilities") return { catalogPaging: true };
          if (request.input?.read === "catalog") return marketPage([item]);
          // A and B answer without the plugin; C answers with it installed.
          return managementSnapshot((request as any).read === "C");
        case "management:market-detail": return { ...item, installState: began ? "installed" : "not-installed", ...(began ? { installedOperationId: "screen-operation" } : {}), manifest: demoManifest };
        case "management:begin": return demoConsent(request);
        case "management:answer": began = true; throw new Error("[TIMEOUT] remote invoke timed out");
        case "management:operation": throw hostError("NOT_FOUND");
        default: throw new Error("unexpected " + request.actionId);
      }
    }, (request) => {
      if (hold && request !== "manifest" && request.actionId === "management:snapshot" && request.input?.read === "installed") {
        const which = hold;
        hold = null;
        (request as any).read = which;
        return which === "A" ? readA.promise : readC.promise;
      }
      return undefined;
    });
    await openMarket();
    await act(async () => shownMarket().install(shownMarket().items[0]));
    await settle(14);
    await approveOnPhone();
    hold = "A";
    await act(async () => { void shownMarket().checkResult(); });
    await settle(6);
    // B: a plugin-change refresh lands with an empty list.
    await act(async () => { await fixture.props.get("confirmation").controller.refresh(); });
    await settle(6);
    // C: a newer refresh is sent and stays in flight; then A returns.
    hold = "C";
    await act(async () => { void fixture.props.get("confirmation").controller.refresh(); });
    await settle(6);
    expect(hold).toBeNull();
    await act(async () => { readA.release(); });
    await settle(14);
    expect(shownMarket()).toMatchObject({ installBusy: true });
    expect(shownMarket().rowState(item)).toEqual({ kind: "unknown" });
    expect(fixture.read.mock.calls.some((call: any[]) => call[2]?.id === "_root__demo")).toBe(false);
    // C lands with the plugin installed: the result follows the newest facts.
    await act(async () => { readC.release(); });
    await settle(14);
    expect(fixture.read.mock.calls.some((call: any[]) => call[2]?.id === "_root__demo")).toBe(true);
  });
  // Maintainer review 04:20: a newer installed snapshot replaces the facts, so a market detail read on the older
  // facts must not settle the result.
  it("drops a market detail read on facts that a newer installed snapshot replaced", async () => {
    const heldDetail = deferred();
    let began = false, present = true, holdDetail = false;
    queuedWire((request) => {
      switch (request.actionId) {
        case "management:snapshot":
          if (request.input?.read === "capabilities") return { catalogPaging: true };
          if (request.input?.read === "catalog") return marketPage([item]);
          return managementSnapshot(began && present);
        case "management:market-detail": return { ...item, installState: began ? "installed" : "not-installed", ...(began ? { installedOperationId: "screen-operation" } : {}), manifest: demoManifest };
        case "management:begin": return demoConsent(request);
        case "management:answer": began = true; throw new Error("[TIMEOUT] remote invoke timed out");
        case "management:operation": throw hostError("NOT_FOUND");
        default: throw new Error("unexpected " + request.actionId);
      }
    }, (request) => {
      if (holdDetail && request !== "manifest" && request.actionId === "management:market-detail") {
        holdDetail = false;
        return heldDetail.promise;
      }
      return undefined;
    });
    await openMarket();
    await act(async () => shownMarket().install(shownMarket().items[0]));
    await settle(14);
    await approveOnPhone();
    holdDetail = true;
    await act(async () => { void shownMarket().checkResult(); });
    await settle(14);
    // The facts after NOT_FOUND showed the same-id instance; its market detail is in flight. Then the instance
    // is removed and a plugin-change refresh lands with the newer facts.
    expect(holdDetail).toBe(false);
    present = false;
    await act(async () => { await fixture.props.get("confirmation").controller.refresh(); });
    await settle(14);
    await act(async () => { heldDetail.release(); });
    await settle(14);
    expect(fixture.read.mock.calls.some((call: any[]) => call[2]?.id === "_root__demo")).toBe(false);
    expect(shownMarket().rowState(item)).toEqual({ kind: "failed", messageKey: "plugins.market.unconfirmedNotInstalled" });
  });
  // Maintainer review 05:04: facts settle a result only while they come from the newest installed read issued.
  // Instead of hand-picked orders, run every order of: A (read after NOT_FOUND) returns, a plugin-change refresh B
  // is sent, the market detail read on the facts returns, B returns (B is always sent before it returns).
  // A shows the same-id instance; the detail always says "installed" (a stale detail is the dangerous case).
  const permutations = <T,>(items: T[]): T[][] => items.length <= 1 ? [items]
    : items.flatMap((first, index) => permutations([...items.slice(0, index), ...items.slice(index + 1)]).map((rest) => [first, ...rest]));
  type Step = "releaseA" | "sendB" | "releaseDetail" | "releaseB";
  const orders = permutations<Step>(["releaseA", "sendB", "releaseDetail", "releaseB"])
    .filter((order) => order.indexOf("sendB") < order.indexOf("releaseB"));
  describe.each([["B still shows the instance", true], ["B shows it removed", false]])("every reply order when %s", (_case, bPresent) => {
    it.each(orders.map((order) => [order.join(" → "), order] as const))("settles only on the newest installed read: %s", async (_label, order) => {
      const gates = new Map<string, { promise: Promise<void>; release: () => void }>();
      const gate = (label: string) => {
        if (!gates.has(label)) { let release!: () => void; const promise = new Promise<void>((resolve) => { release = resolve; }); gates.set(label, { promise, release }); }
        return gates.get(label)!;
      };
      let began = false, checking = false, sentA = false, sentB = false, sentDetail = false, bIssued = false, bReturned = false;
      queuedWire((request) => {
        switch (request.actionId) {
          case "management:snapshot": {
            if (request.input?.read === "capabilities") return { catalogPaging: true };
            if (request.input?.read === "catalog") return marketPage([item]);
            const label = (request as any).label;
            if (label === "B") bReturned = true;
            return managementSnapshot(began && (label === "A" ? true : label === "B" || bReturned ? bPresent : true));
          }
          case "management:market-detail": return { ...item, installState: began ? "installed" : "not-installed", ...(began ? { installedOperationId: "screen-operation" } : {}), manifest: demoManifest };
          case "management:begin": return demoConsent(request);
          case "management:answer": began = true; throw new Error("[TIMEOUT] remote invoke timed out");
          case "management:operation": throw hostError("NOT_FOUND");
          default: throw new Error("unexpected " + request.actionId);
        }
      }, (request) => {
        if (request === "manifest" || !checking) return undefined;
        if (request.actionId === "management:snapshot" && request.input?.read === "installed") {
          if (!sentA) { sentA = true; (request as any).label = "A"; return gate("A").promise; }
          if (bIssued && !sentB) { sentB = true; (request as any).label = "B"; return gate("B").promise; }
        }
        if (request.actionId === "management:market-detail" && !sentDetail) { sentDetail = true; return gate("detail").promise; }
        return undefined;
      });
      await openMarket();
      await act(async () => shownMarket().install(shownMarket().items[0]));
      await settle(14);
      await approveOnPhone();
      checking = true;
      await act(async () => { void shownMarket().checkResult(); });
      await settle(14);
      const opened = () => fixture.read.mock.calls.some((call: any[]) => call[2]?.id === "_root__demo");
      let openedBeforeB = false;
      for (const step of order) {
        if (step === "sendB") { bIssued = true; await act(async () => { void fixture.props.get("confirmation").controller.refresh(); }); }
        else gate(step === "releaseA" ? "A" : step === "releaseB" ? "B" : "detail").release();
        await settle(14);
        if (!bIssued) { openedBeforeB = opened(); continue; }
        // Once B is sent, nothing may open an instance until B has returned showing it.
        if (!bReturned) expect(opened()).toBe(openedBeforeB);
        if (!bPresent) expect(opened()).toBe(openedBeforeB);
      }
      if (openedBeforeB) return; // A was the newest read and settled the result before B was sent: valid.
      if (bPresent) expect(opened()).toBe(true);
      else expect(shownMarket().rowState(item)).toEqual({ kind: "failed", messageKey: "plugins.market.unconfirmedNotInstalled" });
    });
  });
  /* 测试价值（调度要求：扩到第三次已装读取与再次点「核实结果」，让下一个顺序先由测试跑到）
   * - 生产入口与可观察结果：真实 PluginsScreen + usePluginMarket + 管理 client / controller，只替换传输；观察是否打开
   *   实例、行的结论。
   * - 依据：核实事实只在它所依据的已装读取是最新发出的那次时有效（派生判断，单一出口 conclude）。
   * - 剪枝：A 的回包固定在最前（维护者 05:04 点名的顺序即以它开头）；其余事件 B 发出 / 回包、C 发出 / 回包、按 A 的
   *   事实发起的市场详情回包、再次点核实的全部合法先后顺序（发出先于回包，C 在 B 之后发出）都在集合里，共 90 种 × 两种
   *   内容。对应关系：05:04「B 挂起时先放行旧详情」= A → 发 B → 详情 → B 回包；03:54 #1「第一轮详情在途时再次核实」=
   *   A → 核实 → 详情……。tier: unit。
   * - 每一步之后断言：结论第一次出现时，最新发出的已装读取已回包且结论与它的内容一致；最新读取在途时仍待确认。
   *   全部回包后有结论，且等于最新一次读取的内容。
   */
  describe("every order with a third installed read and a second check", () => {
    type Step = "sendB" | "releaseB" | "sendC" | "releaseC" | "releaseDetail" | "check";
    const perms = <T,>(items: T[]): T[][] => items.length <= 1 ? [items]
      : items.flatMap((first, index) => perms([...items.slice(0, index), ...items.slice(index + 1)]).map((rest) => [first, ...rest]));
    const legal = (order: Step[]) => order.indexOf("sendB") < order.indexOf("releaseB") && order.indexOf("sendC") < order.indexOf("releaseC")
      && order.indexOf("sendB") < order.indexOf("sendC");
    const core = perms<Step>(["sendB", "releaseB", "sendC", "releaseC", "releaseDetail"]).filter(legal);
    const all = core.flatMap((order) => Array.from({ length: order.length + 1 }, (_, at) => [...order.slice(0, at), "check" as Step, ...order.slice(at)]));
    it("has the orders the maintainer named among them", () => {
      expect(all).toHaveLength(90);
      expect(all.some((order) => order.join() === "sendB,releaseDetail,releaseB,sendC,releaseC,check")).toBe(true);
      expect(all.some((order) => order.join() === "check,releaseDetail,sendB,releaseB,sendC,releaseC")).toBe(true);
    });
    describe.each([["B shows the instance, C shows it removed", true, false], ["B shows it removed, C shows it again", false, true]])(
      "%s", (_case, bPresent, cPresent) => {
        it.each(all.map((order) => [order.join(" → "), order] as const))("A → %s", async (_label, order) => {
          const gates = new Map<string, { promise: Promise<void>; release: () => void }>();
          const gate = (label: string) => {
            if (!gates.has(label)) { let release!: () => void; const promise = new Promise<void>((resolve) => { release = resolve; }); gates.set(label, { promise, release }); }
            return gates.get(label)!;
          };
          // Installed reads in the order they were sent, with what each shows and whether it came back.
          const reads: Array<{ label: string; present: boolean; returned: boolean }> = [];
          let began = false, checking = false, wanted: "B" | "C" | null = null, sentDetail = false;
          const truth = () => reads.length ? reads[reads.length - 1].present : true;
          queuedWire((request) => {
            switch (request.actionId) {
              case "management:snapshot": {
                if (request.input?.read === "capabilities") return { catalogPaging: true };
                if (request.input?.read === "catalog") return marketPage([item]);
                const read = (request as any).read as typeof reads[number] | undefined;
                if (read) { read.returned = true; return managementSnapshot(began && read.present); }
                return managementSnapshot(began && truth());
              }
              case "management:market-detail": return { ...item, installState: began ? "installed" : "not-installed", ...(began ? { installedOperationId: "screen-operation" } : {}), manifest: demoManifest };
              case "management:begin": return demoConsent(request);
              case "management:answer": began = true; throw new Error("[TIMEOUT] remote invoke timed out");
              case "management:operation": throw hostError("NOT_FOUND");
              default: throw new Error("unexpected " + request.actionId);
            }
          }, (request) => {
            if (request === "manifest" || !checking) return undefined;
            if (request.actionId === "management:snapshot" && request.input?.read === "installed") {
              const label = reads.length === 0 ? "A" : wanted ?? `R${reads.length}`;
              const present = label === "A" ? true : label === "B" ? bPresent : label === "C" ? cPresent : truth();
              const read = { label, present, returned: false };
              reads.push(read);
              (request as any).read = read;
              if (label === "A" || label === "B" || label === "C") { if (wanted === label) wanted = null; return gate(label).promise; }
              return undefined;
            }
            if (request.actionId === "management:market-detail" && !sentDetail) { sentDetail = true; return gate("detail").promise; }
            return undefined;
          });
          await openMarket();
          await act(async () => shownMarket().install(shownMarket().items[0]));
          await settle(14);
          await approveOnPhone();
          checking = true;
          await act(async () => { void shownMarket().checkResult(); });
          await settle(14);
          gate("A").release();
          await settle(14);
          const opened = () => fixture.read.mock.calls.some((call: any[]) => call[2]?.id === "_root__demo");
          const failed = () => shownMarket().rowState(item).kind === "failed";
          let concluded: boolean | null = opened() ? true : failed() ? false : null;
          // A was the newest read and settled the result right away: valid (it is what A showed).
          if (concluded !== null) expect(concluded).toBe(true);
          for (const step of order) {
            if (step === "sendB" || step === "sendC") {
              wanted = step === "sendB" ? "B" : "C";
              await act(async () => { void fixture.props.get("confirmation")?.controller.refresh(); });
            } else if (step === "check") {
              await act(async () => { void shownMarket().checkResult(); });
            } else gate(step === "releaseB" ? "B" : step === "releaseC" ? "C" : "detail").release();
            await settle(14);
            const now = opened() ? true : failed() ? false : null;
            if (concluded === null && now !== null) {
              // The first conclusion rests on the newest installed read issued, which has returned and agrees with it.
              const newest = reads[reads.length - 1];
              expect(newest.returned, `${step}: concluded before the newest read (${newest.label}) returned`).toBe(true);
              expect(now, `${step}: conclusion against ${newest.label}`).toBe(newest.present);
              concluded = now;
            }
            if (concluded === null && reads.some((read) => !read.returned)) {
              expect(shownMarket().rowState(item)).toEqual({ kind: "unknown" });
              expect(shownMarket().installBusy).toBe(true);
            }
          }
          // Every gate released (a read a newer one replaced may never be sent): never left waiting; the conclusion was
          // checked against the newest read when it appeared.
          expect(concluded, `still waiting: ${JSON.stringify(reads)}`).not.toBeNull();
        });
      });
  });
  // Shuffled release (dispatcher request after the 03:54 review): instead of hand-picked orders, each small scenario
  // holds 2–3 requests in flight and runs every order in which they could return, checking the invariants after each
  // step. The 03:54 orders are among them: second "Check result" while round 1's detail is in flight (#1), the probe
  // queued while leaving the market (#3), and a next page queued by scrolling before a new search (#3).
  describe("shuffled release of in-flight requests", () => {
    const orderings = <T,>(items: T[]): T[][] => items.length <= 1 ? [items]
      : items.flatMap((first, index) => orderings([...items.slice(0, index), ...items.slice(index + 1)]).map((rest) => [first, ...rest]));
    const gates = () => {
      const map = new Map<string, { promise: Promise<void>; release: () => void; released: boolean }>();
      const get = (label: string) => {
        if (!map.has(label)) { let release!: () => void; const promise = new Promise<void>((resolve) => { release = resolve; });
          map.set(label, { promise, release, released: false }); }
        return map.get(label)!;
      };
      return { hold: (label: string) => get(label).promise, release: (label: string) => { const g = get(label); g.released = true; g.release(); } };
    };
    const opened = () => fixture.read.mock.calls.some((call: any[]) => call[2]?.id === "_root__demo");

    // Group 1 (03:54 #1): round 1's market detail D1 ("installed") is in flight when "Check result" starts round 2,
    // whose operation query Q2 is held. Round 2's facts either still show the plugin or show it gone.
    describe.each([["round 2 still finds the plugin", true], ["round 2 finds it gone", false]])("check result twice: %s", (_c, presentInRound2) => {
      it.each(orderings(["D1", "Q2"]).map((order) => [order.join(" → "), order] as const))("%s", async (_label, order) => {
        const g = gates();
        let began = false, round = 0, queries = 0, details = 0;
        queuedWire((request) => {
          switch (request.actionId) {
            case "management:snapshot":
              if (request.input?.read === "capabilities") return { catalogPaging: true };
              if (request.input?.read === "catalog") return marketPage([item]);
              return managementSnapshot(began && (round < 2 || presentInRound2));
            case "management:market-detail": return { ...item, installState: began ? "installed" : "not-installed", ...(began ? { installedOperationId: "screen-operation" } : {}), manifest: demoManifest };
            case "management:begin": return demoConsent(request);
            case "management:answer": began = true; throw new Error("[TIMEOUT] remote invoke timed out");
            case "management:operation": throw hostError("NOT_FOUND");
            default: throw new Error("unexpected " + request.actionId);
          }
        }, (request) => {
          if (request === "manifest" || !began) return undefined;
          if (request.actionId === "management:operation" && ++queries === 2) return g.hold("Q2");
          if (request.actionId === "management:market-detail" && ++details === 1) return g.hold("D1");
          return undefined;
        });
        await openMarket();
        await act(async () => shownMarket().install(shownMarket().items[0]));
        await settle(14);
        await approveOnPhone();
        round = 1;
        await act(async () => { void shownMarket().checkResult(); });
        await settle(14);
        round = 2;
        await act(async () => { void shownMarket().checkResult(); });
        await settle(6);
        let q2Returned = false;
        for (const step of order) {
          g.release(step);
          if (step === "Q2") q2Returned = true;
          await settle(14);
          // Invariant ①/②: until round 2 has its own facts, round 1's detail gives no result.
          if (!q2Returned) { expect(opened()).toBe(false); expect(shownMarket()).toMatchObject({ installBusy: true }); }
        }
        if (presentInRound2) expect(opened()).toBe(true);
        else {
          expect(opened()).toBe(false);
          expect(shownMarket().rowState(item)).toEqual({ kind: "failed", messageKey: "plugins.market.unconfirmedNotInstalled" });
        }
      });
    });

    // Group 2 (03:54 #3): the first probe P1 is held while the person leaves the market and comes back, which starts
    // probe P2 (held too). P1 either times out or succeeds late.
    describe.each([["the first probe times out", true], ["the first probe succeeds late", false]])("probe while leaving and returning: %s", (_c, p1Fails) => {
      it.each(orderings(["P1", "P2"]).map((order) => [order.join(" → "), order] as const))("%s", async (_label, order) => {
        const g = gates();
        let manifests = 0;
        const probeOf = new Map<unknown, string>();
        queuedWire((request) => {
          if (request.input?.read === "capabilities") return { catalogPaging: true };
          return marketPage([marketItem("demo", "Demo")]);
        }, (request, device) => {
          if (request !== "manifest") return undefined;
          const label = ++manifests === 1 ? "P1" : manifests === 2 ? "P2" : null;
          if (!label) return undefined;
          return g.hold(label).then(() => { if (label === "P1" && p1Fails) throw new Error("[TIMEOUT] remote invoke timed out"); });
        });
        await openMarket();
        await act(async () => fixture.props.get("directory").onSegmentChange("installed"));
        await settle(6);
        await act(async () => fixture.props.get("directory").onSegmentChange("market"));
        await settle(6);
        for (const step of order) {
          g.release(step);
          await settle(14);
          // Invariant ③: never "failed" on an online computer while the newer probe can still answer.
          if (!order.slice(0, order.indexOf(step) + 1).includes("P2")) expect(shownMarket().status).not.toBe("failed");
        }
        expect(shownMarket()).toMatchObject({ status: "ready", items: [expect.objectContaining({ name: "Demo" })] });
        void probeOf;
      });
    });

    // Group 4 (maintainer review 08:15): Allow is queued; before it leaves, either a plugin-change refresh puts the
    // same-id instance on the computer (the last send check then stops it) or Allow leaves first and its reply is lost.
    // Events: "allow queued", "allow stopped" or "allow sent", "allow reply lost"; then the receipt expires.
    // Only an Allow that actually left can confirm the result.
    it.each(orderings(["refresh", "releaseAllow"]).map((order) => [order.join(" → "), order] as const))("allow queued, then %s", async (_label, order) => {
      const g = gates();
      let present = false, holdAllow = false, receiptGone = false, ours = false;
      const sent = queuedWire((request) => {
        switch (request.actionId) {
          case "management:snapshot":
            if (request.input?.read === "capabilities") return { catalogPaging: true };
            if (request.input?.read === "catalog") return marketPage([item]);
            return managementSnapshot(present);
          case "management:market-detail": return { ...item, installState: present ? "installed" : "not-installed",
            ...(ours ? { installedOperationId: "screen-operation" } : {}), manifest: demoManifest };
          case "management:begin": return demoConsent(request);
          case "management:answer": present = true; ours = true; throw new Error("[TIMEOUT] remote invoke timed out");
          case "management:operation":
            if (receiptGone) throw hostError("NOT_FOUND");
            return { operationId: request.input.operationId, phase: "running" };
          default: throw new Error("unexpected " + request.actionId);
        }
      }, (request) => request !== "manifest" && holdAllow && request.actionId === "management:answer" ? g.hold("allow") : undefined);
      await openMarket();
      await act(async () => shownMarket().install(shownMarket().items[0]));
      await settle(14);
      const controller = fixture.props.get("confirmation").controller;
      holdAllow = true;
      await act(async () => { void controller.answer(true); }); // "allow queued"
      await settle(6);
      for (const step of order) {
        if (step === "refresh") { present = true; await act(async () => { await controller.refresh(); }); }
        else g.release("allow");
        await settle(14);
      }
      const allowSent = sent.some((request) => request.actionId === "management:answer");
      expect(allowSent).toBe(order[0] === "releaseAllow");
      receiptGone = true;
      await act(async () => { await shownMarket().checkResult(); });
      await settle(14);
      // Sent with the reply lost: the result is confirmed from the computer. Stopped before sending: unconfirmed.
      expect(opened()).toBe(allowSent);
      if (!allowSent) expect(shownMarket().rowState(item)).toEqual({ kind: "failed", messageKey: "plugins.market.unconfirmedMismatch" });
      expect(sent.filter((request) => request.actionId === "management:begin")).toHaveLength(1);
      expect(sent.filter((request) => request.actionId === "management:answer").length).toBeLessThanOrEqual(1);
    });
    // Group 4, disconnect path: Allow is queued, the computer goes offline before it leaves (stopped), comes back,
    // and the receipt has expired while the plugin is on the computer from elsewhere.
    it("allow queued, stopped by a disconnect, then the receipt expires", async () => {
      const g = gates();
      let present = false, holdAllow = false, receiptGone = false;
      const sent = queuedWire((request) => {
        switch (request.actionId) {
          case "management:snapshot":
            if (request.input?.read === "capabilities") return { catalogPaging: true };
            if (request.input?.read === "catalog") return marketPage([item]);
            return managementSnapshot(present);
          case "management:market-detail": return { ...item, installState: present ? "installed" : "not-installed", manifest: demoManifest };
          case "management:begin": return demoConsent(request);
          case "management:answer": throw new Error("answer must not be sent");
          case "management:operation":
            if (receiptGone) throw hostError("NOT_FOUND");
            return { operationId: request.input.operationId, phase: "confirmation" };
          default: throw new Error("unexpected " + request.actionId);
        }
      }, (request) => request !== "manifest" && holdAllow && request.actionId === "management:answer" ? g.hold("allow") : undefined);
      await openMarket();
      await act(async () => shownMarket().install(shownMarket().items[0]));
      await settle(14);
      const controller = fixture.props.get("confirmation").controller;
      holdAllow = true;
      await act(async () => { void controller.answer(true); });
      await settle(6);
      await act(async () => controller.setOnline(false));
      g.release("allow");
      await settle(14);
      expect(sent.some((request) => request.actionId === "management:answer")).toBe(false);
      present = true; receiptGone = true;
      await act(async () => controller.setOnline(true));
      await settle(14);
      await act(async () => { await controller.reconcile(); });
      await settle(14);
      expect(opened()).toBe(false);
      expect(shownMarket().rowState(item)).toEqual({ kind: "failed", messageKey: "plugins.market.unconfirmedMismatch" });
      expect(sent.filter((request) => request.actionId === "management:begin")).toHaveLength(1);
    });

    // Group 3 (03:54 #3): a next page N is queued by scrolling, then a new search is typed and settles; its first
    // page S and count C are held too. Every request that leaves must match the list and search on screen then.
    it.each(orderings(["N", "S", "C"]).map((order) => [order.join(" → "), order] as const))("scroll queued, then a new search: %s", async (_label, order) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        const g = gates();
        let typed = "";
        const leftWith: Array<{ query: string; cursor: unknown; screen: string }> = [];
        queuedWire((request) => {
          if (request.input?.read === "capabilities") return { catalogPaging: true };
          const query = request.input?.query?.query ?? "";
          leftWith.push({ query, cursor: request.input?.query?.cursor, screen: typed });
          return { ...marketPage([marketItem(query ? "found" : "demo", query ? "Found" : "Demo")]), nextCursor: query ? null : "cursor-1",
            counts: request.input?.query?.counts ? { public: 1, organization: 0, personal: 0, custom: 0, official: 1, community: 0, all: 1 } : null };
        }, (request) => {
          if (request === "manifest" || request.input?.read !== "catalog") return undefined;
          const q = request.input.query;
          if (q.cursor) return g.hold("N");
          if (q.query === "rota") return g.hold(q.counts ? "C" : "S");
          return undefined;
        });
        await openMarket();
        await act(async () => shownMarket().loadMore());
        await settle(6);
        typed = "rota";
        await act(async () => fixture.props.get("stack").headerSearchBarOptions.onChangeText({ nativeEvent: { text: "rota" } }));
        await act(async () => { await vi.advanceTimersByTimeAsync(300); });
        await settle(6);
        for (const step of order) { g.release(step); await settle(10); }
        // Invariant ④: nothing left for a list or search no longer on screen.
        for (const sent of leftWith.filter((entry) => entry.query || entry.cursor)) expect(sent.query).toBe(sent.screen);
        expect(leftWith.filter((entry) => entry.cursor)).toEqual([]);
        expect(shownMarket().items.map((row: any) => row.name)).toEqual(["Found"]);
      } finally { vi.useRealTimers(); }
    });
  });
  it("ignores a market detail from an earlier verification that arrives late", async () => {
    let verifying = false;
    const details: Array<{ release: () => void; promise: Promise<void> }> = [];
    queuedWire((request) => {
      switch (request.actionId) {
        case "management:snapshot":
          if (request.input?.read === "capabilities") return { catalogPaging: true };
          if (request.input?.read === "catalog") return marketPage([item]);
          return managementSnapshot(verifying);
        case "management:market-detail":
          // The first verification's facts said "installed"; the second (newer) says "conflict".
          if (!verifying) return { ...item, manifest: demoManifest };
          return { ...item, installState: (request as any).verification === 1 ? "installed" : "conflict", manifest: demoManifest };
        case "management:begin": return demoConsent(request);
        case "management:answer": verifying = true; throw new Error("[TIMEOUT] remote invoke timed out");
        case "management:operation": throw hostError("NOT_FOUND");
        default: throw new Error("unexpected " + request.actionId);
      }
    }, (request) => {
      if (verifying && request !== "manifest" && request.actionId === "management:market-detail") {
        const gate = deferred();
        details.push(gate);
        (request as any).verification = details.length;
        return gate.promise;
      }
      return undefined;
    });
    await openMarket();
    await act(async () => shownMarket().install(shownMarket().items[0]));
    await settle(14);
    await approveOnPhone();
    await act(async () => { void shownMarket().checkResult(); });
    await settle(14);
    await act(async () => { void shownMarket().checkResult(); });
    await settle(14);
    expect(details).toHaveLength(2);
    await act(async () => { details[0]!.release(); });
    await settle(10);
    await act(async () => { details[1]!.release(); });
    await settle(10);
    expect(fixture.read.mock.calls.some((call: any[]) => call[2]?.id === "_root__demo")).toBe(false);
    expect(shownMarket().rowState(item)).toEqual({ kind: "failed", messageKey: "plugins.market.unconfirmedMismatch" });
  });
});
// Review F2 (2026-11-25): an offline remembered computer should not cost an extra step; explicit choices stay.
describe("market computer choice", () => {
  const remembered = "cindy.pluginMarketDevice.v1.demo";
  beforeEach(() => {
    fixture.extraDevices = [{ deviceId: "pc", name: "PC", platform: "win32", remoteControlEnabled: true }];
    marketWire((request) => request.input?.read === "capabilities" ? { catalogPaging: true } : marketPage([]));
  });
  it("falls back to an online computer without rewriting the remembered one, and stays put while browsing", async () => {
    fixture.storage.set(remembered, "pc");
    fixture.offlineDevices.add("pc");
    await openMarket();
    expect(shownMarket().target.deviceId).toBe("mac");
    // The remembered computer comes online mid-visit: the list does not jump.
    fixture.offlineDevices.delete("pc");
    await act(async () => root.render(createElement(PluginsScreen)));
    expect(shownMarket().target.deviceId).toBe("mac");
    expect(fixture.setStored).not.toHaveBeenCalledWith(remembered, expect.anything());
    // The next market visit picks again and prefers the remembered computer now that it is online.
    await act(async () => fixture.props.get("directory").onSegmentChange("installed"));
    await act(async () => fixture.props.get("directory").onSegmentChange("market"));
    await settle();
    expect(shownMarket().target.deviceId).toBe("pc");
  });
  it.each(["market", "installed"])("keeps an offline computer chosen explicitly in the %s tab", async (where) => {
    fixture.offlineDevices.add("pc");
    await openMarket();
    if (where === "market") await act(async () => shownMarket().selectDevice("pc"));
    else await act(async () => fixture.props.get("directory").onDeviceChange("pc"));
    await settle();
    expect(shownMarket()).toMatchObject({ status: "offline", target: { deviceId: "pc" } });
  });
});
