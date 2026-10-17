// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import PluginsScreen from "@/plugins/PluginsScreen";

const fixture = vi.hoisted(() => ({
  props: new Map<string, any>(),
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
  extraRows: [] as any[],
  devicesFailed: false,
  devicesAbsent: false,
  platform: "ios",
  storage: new Map<string, string>(),
  getStored: vi.fn(),
  setStored: vi.fn(),
}));
vi.mock("react-native", async () => {
  const React = await import("react");
  const view = ({ children }: any) =>
    React.createElement("div", null, children);
  return {
    ActivityIndicator: view,
    Alert: { alert: fixture.alert },
    BackHandler: { addEventListener: () => ({ remove() {} }) },
    Image: view,
    Pressable: view,
    RefreshControl: view,
    ScrollView: view,
    View: view,
    Platform: {
      get OS() {
        return fixture.platform;
      },
    },
    StyleSheet: { create: (s: any) => s, hairlineWidth: 1 },
    useWindowDimensions: () => ({ width: 390 }),
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
    ["ChevronDown", "ChevronRight", "Info", "Monitor", "Puzzle", "Search"].map(
      (key) => [key, () => null],
    ),
  ),
);
vi.mock("@/components/AppText", () => ({
  Text: ({ children }: any) => createElement("span", null, children),
  TextInput: () => null,
}));
vi.mock("@/auth/AuthContext", () => ({
  useAuth: () => ({ accountGeneration: 0, apiFetch: vi.fn() }),
}));
vi.mock("@/auth/authOwnerGeneration", () => ({
  getMobileAuthOwner: () => ({ accountKey: "demo" }),
  isMobileAuthOwnerCurrent: () => fixture.owner,
}));
vi.mock("@/device-link/DeviceLinkContext", () => ({
  useDeviceLink: () => ({ invoke: vi.fn() }),
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
          ],
    refresh() {},
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
}));
vi.mock("@/session/useRemoteResourceList", () => ({
  useRemoteResourceList: () => ({
    items:
      fixture.devicesFailed || fixture.devicesAbsent
        ? []
        : [...fixture.extraRows, row()],
    error: fixture.devicesFailed || fixture.devicesAbsent ? "noHosts" : null,
    loading: false,
    isOnline: () => fixture.online,
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
    return null;
  },
}));
vi.mock("@/plugins/PluginTaskPicker", () => ({
  PluginTaskPicker: (p: any) => {
    fixture.props.set("taskPicker", p);
    return null;
  },
}));
vi.mock("@/plugins/PluginPage", () => ({ PluginPage: () => null }));
vi.mock("@/plugins/pluginClient", () => ({
  invokePlugin: (...args: any[]) => fixture.invoke(...args),
}));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  fixture.props.clear();
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
  fixture.extraRows = [];
  fixture.devicesFailed = false;
  fixture.devicesAbsent = false;
  fixture.push.mockClear();
  fixture.enabled = true;
  fixture.online = true;
  fixture.focused = true;
  fixture.owner = true;
  fixture.platform = "ios";
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
  root = createRoot(document.createElement("div"));
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
    expect(fixture.alert).toHaveBeenCalledWith("plugins.actionFailed");
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
  expect(fixture.alert).toHaveBeenCalledWith("plugins.actionFailed");
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
  expect(detail.children).toBeUndefined();
  await act(async () => detail.onResolveStatus());
  expect(fixture.alert).toHaveBeenCalledWith("plugins.detail.computerSettings");
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
