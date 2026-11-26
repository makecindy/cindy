// @vitest-environment jsdom
import { fixture, row, root, element, openDetail, transportSend, type MarketWireRequest, marketWire, marketItem, demoConsent, approveOnPhone, marketPage, settle, openMarket, shownMarket, hostError, demoGhost, attributed, managementSnapshot } from "./pluginsScreenHarness";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PluginUiEnablePrompt } from "@/plugins/PluginUiEnablePrompt";
import { sharedTaskHostPeer, providerShareHostPeer } from "@cindy/device-link";
import PluginsScreen from "@/plugins/PluginsScreen";
import { pluginConsentPresentation } from "@/plugins/pluginConsentPresentation";
import { usePluginManagement, __retainedForTests } from "@/plugins/usePluginManagement";
import { __testing as slotTesting, pluginManagementSlotFor } from "@/plugins/pluginManagementSlot";
import { createPluginPromptReads } from "@/plugins/pluginPromptReads";
import { CONTRACT_SAMPLES, HOST_INSTALL_SITUATIONS, hostInstallFacts, secondShapes, type HostInstallSituation } from "./hostPluginInstallFacts";
/**
 * Proven as this install: concluded as done with its instance read from the computer. The page never opens a result by
 * itself; the person opens it from the list of checks ("Open plugin"), which the tests of that list cover.
 */
const provenDemo = () => __retainedForTests.conclusions().some((conclusion) => (conclusion.result === "succeeded" || conclusion.result === "installed")
  && conclusion.readback === "verified" && conclusion.instanceKey === "_root__demo");
/** What the page draws at the top now (the stand-in keeps the props of a notice that is no longer drawn). */
async function topNotice() {
  fixture.props.delete("plugins.slotHolder");
  await act(async () => root.render(createElement(PluginsScreen)));
  return fixture.props.get("plugins.slotHolder") as { title: string; onPress: () => void } | undefined;
}
const sheetControl = (id: string) => element.querySelector(`[data-testid="${id}"]`) as HTMLButtonElement | null;
/** "View" at the top, then "Open plugin" on the result's line: the only way a result's instance gets opened. */
async function openListedResult() {
  const notice = await topNotice();
  expect(notice, "the result is listed at the top").toBeDefined();
  await act(async () => notice!.onPress());
  await settle(6);
  expect(sheetControl("plugins.checks.open"), "its line offers Open plugin").not.toBeNull();
  await act(async () => sheetControl("plugins.checks.open")!.click());
  await settle(14);
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
    expect(fixture.alert).toHaveBeenCalledWith("plugins.notice.title.managementFailed", "plugins.actionFailed", [{ text: "plugins.gotIt", onPress: expect.any(Function) }]);
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
  expect(fixture.alert).toHaveBeenCalledWith("plugins.notice.title.managementFailed", "plugins.actionFailed", [{ text: "plugins.gotIt", onPress: expect.any(Function) }]);
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
  expect(fixture.alert).toHaveBeenCalledWith("plugins.detail.computerSettingsTitle", "plugins.detail.computerSettings", [{ text: "plugins.gotIt", onPress: expect.any(Function) }]);
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
  expect(fixture.alert).toHaveBeenCalledWith("plugins.notice.title.managementFailed", undefined, [{ text: "plugins.gotIt", onPress: expect.any(Function) }]);
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
    "plugins.management.releaseChangedTitle", "plugins.management.releaseChanged", [{ text: "plugins.gotIt", onPress: expect.any(Function) }],
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
    expect((pluginManagementSlotFor().holders()[0] ?? null)).toBeNull();
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
  const holder = () => (pluginManagementSlotFor().holders()[0] ?? null);
  async function updateScreen(host: { begin?: (request: any) => unknown; operation?: (request: any) => unknown; answer?: (request: any) => unknown;
    detail?: () => unknown; cancel?: (request: any) => unknown; refuseCancel?: () => boolean; ui?: boolean }) {
    const { snapshot, market, plugin } = realManagementHost();
    if (host.ui) {
      // A plugin with pages waiting for approval, on a Host that approves them (the page approval entry).
      Object.assign(plugin.manifest, { tools: [{ name: "open" }], mcpApps: { ui: { resources: [{ uri: "ui://form", file: "ui/form.html" }], tools: { open: { resourceUri: "ui://form" } } } } });
      Object.assign(snapshot, { uiCapabilityApproval: true });
    }
    fixture.width = 900;
    const requests: string[] = [], asked: string[] = [];
    fixture.wire.mockImplementation(async (_host: string, channel: string, args: any[], options: any) => {
      if (args?.[0]?.actionId) asked.push(args[0].actionId);
      // Refused before its first write (no write receipt): never written.
      // Refused before the first write, reported the way DeviceLinkContext.invoke reports it (`onNotSent`).
      if (args?.[0]?.actionId === "management:cancel" && host.refuseCancel?.()) { options?.onNotSent?.(); throw new Error("refused before the first write"); }
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
    /**
     * The computer after this phone's update `operationId` of Demo 1 → 2 (market release r2), then `situation`: its
     * installed snapshot and market detail as it would answer this phone (hostPluginInstallFacts.ts).
     */
    const become = (situation: HostInstallSituation, operationId: string) => {
      const facts = hostInstallFacts(situation, { operationId, target: { ...market, installState: "installed" } as any,
        instance: { ...plugin, manifest: { ...plugin.manifest, version: "2" } } as any, next: { releaseId: "r3", version: "3" } });
      snapshot.ghosts.splice(0, snapshot.ghosts.length, ...facts.ghosts);
      for (const key of Object.keys(market)) delete (market as any)[key];
      // The detail's manifest is the catalog's current release.
      Object.assign(market, facts.record, { manifest: { ...(facts.record as any).manifest, version: (facts.record as any).version } });
      snapshot.market.items.splice(0, snapshot.market.items.length, market);
    };
    return { update, requests, market, snapshot, plugin, leave, writes, become };
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
  // Maintainer review 18:45 (I-3): a stopped unknown result waits for the person; the computer's slot goes (other
  // plugins there may start), the pending check stays, shown or not, and still blocks this plugin.
  it("frees the computer's slot while a stopped unknown result waits for a check, and keeps its pending check after the view is gone", async () => {
    const s = await updateScreen({
      begin: () => { throw new Error("[TIMEOUT] remote invoke timed out"); },
      operation: () => { throw new Error("[INVALID_RESPONSE] nonsense"); },
    });
    await s.update();
    await act(async () => { await fixture.props.get("observedManagement").controller.reconcile(); });
    await settle(14);
    expect(fixture.props.get("observedManagement").controller.lookupsStopped()).toBe(true);
    expect(holder()).toBeNull();
    const same = { name: "Demo", deviceId: "mac", deviceName: "Mac", instanceKey: "demo" };
    expect(pluginManagementSlotFor().available(same)).toBe(false);
    expect(pluginManagementSlotFor().available({ ...same, name: "Other", instanceKey: "other", ghostId: "other" })).toBe(true);
    await act(async () => root.render(createElement("div")));
    await settle(6);
    expect(holder()).toBeNull();
    expect(__retainedForTests.size()).toBe(1);
    expect(pluginManagementSlotFor().available(same)).toBe(false);
  });
  // Dispatcher N-2: while an operation of the plugin on screen is under way the page went unavailable with no notice.
  // The notice shows whenever anything is unfinished: above both panes on a wide screen; on a narrow iOS screen as the
  // first row of the detail on screen; on Android above the page.
  it.each([["wide", 900, "ios"], ["narrow iOS", 390, "ios"], ["narrow Android", 390, "android"]] as const)(
    "shows the notice while the plugin on screen has an operation under way (%s)", async (_name, width, platform) => {
      const s = await updateScreen({ begin: (request) => receiptOf(request, "running"), operation: (request) => receiptOf(request, "running") });
      // The detail is open (selected through the iOS directory); then the platform and width under test.
      fixture.platform = platform;
      fixture.width = width;
      await act(async () => root.render(createElement(PluginsScreen)));
      await settle(6);
      expect(fixture.props.has("plugins.slotHolder")).toBe(false);
      if (platform === "ios") await s.update();
      else { await act(async () => { void fixture.props.get("header").right.props.onAction("update"); }); await settle(14); }
      expect(holder()).toMatchObject({ entry: "update" });
      expect(fixture.props.get("plugins.slotHolder")).toMatchObject({ title: "plugins.slot.holder" });
      if (platform === "ios" && width < 768) expect(fixture.props.get("detail").pageNotice).toMatchObject({ title: "plugins.slot.holder" });
    });
  // Dispatcher L-1 / L-4, the success rows of the other entries: an update, an uninstall and a page approval followed to
  // their end from the list of checks after their view went away (another plugin's detail opened). The list reads the
  // computer itself; "Open" only for the instance that read found; an uninstall keeps no instance id and has no "Open".
  describe("succeeded from the list of checks, per entry", () => {
    const byId = (id: string) => element.querySelector(`[data-testid="${id}"]`) as HTMLButtonElement | null;
    const press = async (id: string) => {
      const control = byId(id);
      expect(control, `${id} is on screen`).not.toBeNull();
      await act(async () => control!.click());
      await settle(14);
    };
    it.each(["update", "uninstall"] as const)("%s", async (entry) => {
      let done = false, operationId = "";
      const s = await updateScreen({ begin: (request) => { operationId = request.input.operationId; return receiptOf(request, "running"); },
        operation: (request) => receiptOf(request, done ? "succeeded" : "running") });
      if (entry === "update") await s.update();
      else if (entry === "uninstall") {
        await act(async () => { void fixture.props.get("header").rightToolbar.props.onAction("uninstall"); });
        await act(async () => fixture.alert.mock.calls.at(-1)![2][1].onPress());
        await settle(14);
      }
      expect(s.writes()).toEqual(["management:begin"]);
      await act(async () => root.render(createElement("div")));
      await settle(6);
      await act(async () => root.render(createElement(PluginsScreen)));
      await settle(14);
      done = true;
      // What the computer has after it: this phone's update in place (the uninstall's instance is gone in its own test below).
      if (entry === "update") s.become("own", operationId);
      await press("plugins.slotHolder.show");
      await press("plugins.checks.verify");
      expect(s.writes()).toEqual(["management:begin", "management:operation"]);
      const text = byId("plugins.checks")?.textContent ?? "";
      if (entry === "uninstall") {
        expect(text).toContain("plugins.checks.result.uninstalled");
        expect(byId("plugins.checks.open")).toBeNull();
      } else {
        expect(text).toContain("plugins.checks.result.succeeded");
        fixture.read.mockClear();
        await press("plugins.checks.open");
        expect(fixture.read).toHaveBeenCalledWith(fixture.wire, expect.objectContaining({ deviceId: "mac" }),
          expect.objectContaining({ id: "demo" }), "en", ["plugin-capabilities"]);
      }
    });
    it("page approval", async () => {
      let done = false;
      const s = await updateScreen({ begin: (request) => receiptOf(request, "running"), operation: (request) => receiptOf(request, done ? "succeeded" : "running"), ui: true });
      await act(async () => { fixture.props.get("detail").uiApprovalNotice.actions[0].onPress(); });
      await settle(14);
      expect(s.writes()).toEqual(["management:begin"]);
      await act(async () => root.render(createElement("div")));
      await settle(6);
      await act(async () => root.render(createElement(PluginsScreen)));
      await settle(14);
      done = true;
      Object.assign(s.plugin, { uiCapabilityApproved: true });             // the computer approved its pages
      await press("plugins.slotHolder.show");
      await press("plugins.checks.verify");
      expect(s.writes()).toEqual(["management:begin", "management:operation"]);
      expect(byId("plugins.checks")?.textContent).toContain("plugins.checks.kind.pageApproval");
      fixture.read.mockClear();
      await press("plugins.checks.open");
      expect(fixture.read).toHaveBeenCalledWith(fixture.wire, expect.objectContaining({ deviceId: "mac" }),
        expect.objectContaining({ id: "demo" }), "en", ["plugin-capabilities"]);
    });
  });
  // Dispatcher O-1 (maintainer review 23:03 of #12684, items 1 and 2): once the computer no longer has an operation's
  // receipt (NOT_FOUND), each entry settles by its row of AFTER_RECEIPT_GONE, through the list's own "Check result":
  // an update from the Host's record of this operation (`installedOperationId`) on the instance it started from; an
  // uninstall or a page approval, which nothing on the computer can prove, shows what the computer has now and only
  // "Stop tracking"; enable and task settings never leave a record. Minimal failing input on 015469869c: an update whose
  // receipt expired stayed "result unconfirmed" with the same record on the computer (only market installs settled), and
  // an uninstall or a page approval stayed "check again" forever. Tier: unit/jsdom (real controller and registry).
  describe("receipt gone (NOT_FOUND), per entry, through the list of checks (dispatcher O-1)", () => {
    const byId = (id: string) => element.querySelector(`[data-testid="${id}"]`) as HTMLButtonElement | null;
    const press = async (id: string) => {
      const control = byId(id);
      expect(control, `${id} is on screen`).not.toBeNull();
      await act(async () => control!.click());
      await settle(14);
    };
    type Entry = "update" | "uninstall" | "page approval";
    async function gone(entry: Entry, after: (s: Awaited<ReturnType<typeof updateScreen>>, operationId: string) => void) {
      let operationId = "", expired = false;
      const s = await updateScreen({ ui: entry === "page approval",
        begin: (request) => { operationId = request.input.operationId; return receiptOf(request, "running"); },
        operation: (request) => { if (expired) throw new Error("[NOT_FOUND] no such operation"); return receiptOf(request, "running"); } });
      if (entry === "update") await s.update();
      else if (entry === "uninstall") {
        await act(async () => { void fixture.props.get("header").rightToolbar.props.onAction("uninstall"); });
        await act(async () => fixture.alert.mock.calls.at(-1)![2][1].onPress());
        await settle(14);
      } else {
        await act(async () => { fixture.props.get("detail").uiApprovalNotice.actions[0].onPress(); });
        await settle(14);
      }
      await act(async () => root.render(createElement("div")));
      await settle(6);
      await act(async () => root.render(createElement(PluginsScreen)));
      await settle(14);
      expired = true;
      after(s, operationId);
      await press("plugins.slotHolder.show");
      await press("plugins.checks.verify");
      expect(s.writes()).toEqual(["management:begin", "management:operation"]);
      return { s, text: () => byId("plugins.checks")?.textContent ?? "" };
    }
    // The computer's own answers (hostPluginInstallFacts.ts, dispatcher R-3) after this phone's update, then each situation.
    it.each([
      ["own", "plugins.checks.result.installed", true],
      ["catalogAdvanced", "plugins.checks.result.installed", true],
      ["localReinstall", "plugins.market.unconfirmedMismatch", false],
      ["otherControllerReinstall", "plugins.market.unconfirmedMismatch", false],
      ["otherControllerUpdate", "plugins.market.unconfirmedMismatch", false],
      ["bindingLost", "plugins.market.unconfirmedMismatch", false],
      ["olderHost", "plugins.market.unconfirmedLegacy", false],
      ["uninstalled", "plugins.market.unconfirmedNotInstalled", false],
    ] as const)("update, then the computer: %s", async (situation, text, opens) => {
      const { s } = await gone("update", (s, operationId) => s.become(situation, operationId));
      const shown = byId("plugins.checks")?.textContent ?? "";
      expect(shown).toContain(text);
      expect(!!byId("plugins.checks.open")).toBe(opens);
      expect(s.writes()).toEqual(["management:begin", "management:operation"]);
    });
    it("update, the instance it started from is gone (another instance has the plugin now)", async () => {
      await gone("update", (s, operationId) => { s.become("own", operationId); Object.assign(s.snapshot.ghosts[0]!, { instanceKey: "demo-copy" }); });
      expect(byId("plugins.checks")?.textContent ?? "").toContain("plugins.market.unconfirmedNotInstalled");
      expect(byId("plugins.checks.open")).toBeNull();
    });
    it.each([
      ["uninstall, the plugin is gone", "uninstall", (s: any) => { s.snapshot.ghosts.splice(0); }, "plugins.checks.status.unprovable.uninstall.absent"],
      ["uninstall, the plugin is still there", "uninstall", () => {}, "plugins.checks.status.unprovable.uninstall.present"],
      ["page approval, its pages are on", "page approval", (s: any) => { s.plugin.uiCapabilityApproved = true; }, "plugins.checks.status.unprovable.pageApproval.approved"],
      ["page approval, its pages are not on", "page approval", () => {}, "plugins.checks.status.unprovable.pageApproval.notApproved"],
    ] as const)("%s: cannot be confirmed, says what is there now, only Stop tracking", async (_name, entry, after, text) => {
      const { s, text: shown } = await gone(entry, after);
      expect(shown()).toContain(text);
      expect(byId("plugins.checks.verify")).toBeNull();
      expect(byId("plugins.checks.open")).toBeNull();
      // Nothing looks it up again by itself.
      await settle(20);
      expect(s.writes()).toEqual(["management:begin", "management:operation"]);
      await press("plugins.checks.stop");
      expect(shown()).toContain("plugins.checks.result.untracked");
      expect(s.writes()).toEqual(["management:begin", "management:operation"]);
    });
    // Existing behaviour (passes on 015469869c too): enable writes directly, with no operation to track.
    it("enable: a lost reply leaves no record to check (it is read back, never tracked)", async () => {
      const { plugin } = realManagementHost();
      fixture.invoke.mockImplementation(async () => { throw new Error("[TIMEOUT] remote invoke timed out"); });
      await openDetail();
      await settle(8);
      await act(async () => fixture.props.get("detail").onEnabledChange(false));
      await settle(14);
      expect(plugin.instanceKey).toBe("demo");
      expect(byId("plugins.slotHolder.show")).toBeNull();
      expect(holder()).toBeNull();
    });
  });
  // The installed detail after its own update uses the same decision as the list (pluginOperationOpens), from the
  // record's one read of the computer. Nothing is prompted for a result: this phone's update in place (also with the
  // catalog at its next release) leaves no line (its detail is on screen); a reinstall by the computer or another
  // controller, another controller's update, an older computer and the old version are each listed at the top with
  // their sentence in the list of checks, and no "Open plugin". Minimal failing input on a337ae955c: each of those
  // raised an alert over whatever was on screen. Tier: unit/jsdom.
  const listedResult = async () => {
    const notice = await topNotice();
    if (!notice) return null;
    await act(async () => notice.onPress());
    await settle(6);
    return { title: notice.title, text: sheetControl("plugins.checks")?.textContent ?? "", open: !!sheetControl("plugins.checks.open") };
  };
  const resultAlerts = () => fixture.alert.mock.calls.filter((call) => String(call[1]).startsWith("plugins.checks.result."));
  it.each([
    ["own", null], ["catalogAdvanced", null], ["localReinstall", "plugins.checks.result.unconfirmed"],
    ["otherControllerReinstall", "plugins.checks.result.unconfirmed"], ["otherControllerUpdate", "plugins.checks.result.unconfirmed"],
    ["olderHost", "plugins.checks.result.legacyHost"],
  ] as const)("after an update succeeds on its detail, the computer then: %s", async (situation, said) => {
    const s = await updateScreen({ begin: (request) => { s.become(situation, request.input.operationId); return receiptOf(request, "succeeded"); } });
    fixture.alert.mockClear();
    await s.update();
    expect(resultAlerts()).toEqual([]);
    expect(fixture.props.get("header")).toBeDefined();
    const listed = await listedResult();
    if (!said) expect(listed).toBeNull();
    else expect(listed).toMatchObject({ title: "plugins.checks.settledOne", text: expect.stringContaining(said), open: false });
  });
  it("after an update succeeds on its detail and the computer still has the old version: lists that it cannot confirm", async () => {
    // The old install is nobody's here: a V2.10 computer says `'unattributed'` for it.
    const s = await updateScreen({ begin: (request) => { Object.assign(s.market, { installedOperationAttribution: "unattributed" });
      return receiptOf(request, "succeeded"); } });
    fixture.alert.mockClear();
    await s.update();
    expect(resultAlerts()).toEqual([]);
    expect(await listedResult()).toMatchObject({ text: expect.stringContaining("plugins.checks.result.unconfirmed"), open: false });
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
    // Android layout re-check: the alert's button is localized (RN's default "OK" showed in English). J-2: a short
    // title, the full explanation as its message.
    for (const call of fixture.alert.mock.calls) expect(call[2]).toEqual([{ text: "plugins.gotIt", onPress: expect.any(Function) }]);
    for (const call of fixture.alert.mock.calls) expect(call[0]).toBe(call[1] + "Title");
    return fixture.alert.mock.calls.map((call) => call[1]);
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
  expect(fixture.alert).toHaveBeenCalledWith("plugins.notice.title.managementFailed", undefined, [{ text: "plugins.gotIt", onPress: expect.any(Function) }]);
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
it("installs from the market through the existing consent sheet; its result is listed and opens the new installed detail", async () => {
  const item = marketItem("demo", "Demo");
  const manifest = { schemaVersion: 3, id: "demo", name: "Demo", version: "1" };
  let installed = false;
  const requests = marketWire((request) => {
    switch (request.actionId) {
      case "management:snapshot":
        if (request.input?.read === "capabilities") return { catalogPaging: true };
        if (request.input?.read === "catalog") return marketPage([item]);
        // Once installed, the computer's record of it carries this phone's operation id (hostPluginInstallFacts.ts).
        return { version: 1, market: { items: installed ? [{ ...item, installState: "installed", installedOperationId: "screen-operation", installedOperationAttribution: "self" }] : [],
          unavailableReason: null, customSourceNames: [], unavailableCustomSourceNames: [] },
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
  // Browsing and installing never fall back to the full v1 snapshot on a paging Host. One install costs five light
  // installed reads: three before the result (the controller's, as for any operation), and two after it (the record's
  // own read, which settles the result, and the controller's read after a result, which only this controller would
  // use). All of them are counted, not a window of them.
  const snapshots = requests.filter((request) => request.actionId === "management:snapshot").map((request) => request.input?.read);
  expect(snapshots.filter((read) => read === undefined)).toEqual([]);
  expect(snapshots.filter((read) => read === "installed")).toHaveLength(5);
  const answeredAt = requests.findIndex((request) => request.actionId === "management:answer");
  expect(requests.slice(answeredAt).filter((request) => request.actionId === "management:snapshot" && request.input?.read === "installed")).toHaveLength(2);
  // The result does not change the page by itself: the market stays, the row is done, the result is listed at the top.
  expect(fixture.props.get("header").title).not.toBe("Demo");
  expect(shownMarket().installBusy).toBe(false);
  expect(provenDemo()).toBe(true);
  expect((await topNotice())?.title).toBe("plugins.checks.settledOne");
  await openListedResult();
  expect(fixture.read).toHaveBeenLastCalledWith(fixture.wire, expect.objectContaining({ deviceId: "mac" }),
    expect.objectContaining({ id: "_root__demo" }), "en", ["plugin-capabilities"]);
  expect(fixture.props.get("header").title).toBe("Demo");
  // (The list read once more as it opened; the installed detail opened afterwards keeps its existing controller and reads.)
});

// Contract V2.10: once the one read of the computer after the result has landed, the market row ends at once and the
// result is listed at the top, without a prompt and without waiting on any timer: the proven instance has "Open plugin"
// in the list of checks; ② (not attributable) and ③ (an older computer) have their sentence and no "Open plugin".
// Minimal failing input on 3429eff0eb: an older computer's shape kept the row "installing" for 5 more seconds, then
// ended without a word; on a337ae955c ② and ③ raised an alert over the page. Tier: unit/jsdom (no timer is advanced).
it.each([
  ["this install, proven", { installedOperationId: "screen-operation", installedOperationAttribution: "self" }, null],
  ["not attributable (②)", { installedOperationAttribution: "unattributed" }, "plugins.checks.result.unconfirmed"],
  ["an older computer (③)", {}, "plugins.checks.result.legacyHost"],
] as const)("settles a market install as soon as the computer is read after it: %s", async (_name, evidence, said) => {
  const item = marketItem("demo", "Demo");
  const manifest = { schemaVersion: 3, id: "demo", name: "Demo", version: "1" };
  let installed = false;
  const requests = marketWire(async (request) => {
    switch (request.actionId) {
      case "management:snapshot":
        if (request.input?.read === "capabilities") return { catalogPaging: true };
        if (request.input?.read === "catalog") return marketPage([item]);
        return { version: 1, market: { items: installed ? [{ ...item, installState: "installed", ...evidence }] : [],
          unavailableReason: null, customSourceNames: [], unavailableCustomSourceNames: [] },
          ghosts: installed ? [{ instanceKey: "_root__demo", namespace: null, manifest, enabled: true,
            approval: { state: "approved", revision: "12345678-1234-4123-8123-123456789abc" } }] : [] };
      case "management:market-detail": return { ...item, manifest };
      case "management:begin": return demoConsent(request);
      case "management:answer": installed = true; return { operationId: request.input.operationId, phase: "succeeded" };
      default: throw new Error("unexpected " + request.actionId);
    }
  });
  await openMarket();
  await act(async () => shownMarket().install(shownMarket().items[0]));
  await settle(14);
  fixture.alert.mockClear();
  await act(async () => fixture.props.get("confirmation").controller.answer(true));
  await settle(14);
  // The read after the result landed: the row ended at once, the market is still the page, nothing was prompted.
  expect(shownMarket().installBusy).toBe(false);
  expect(fixture.props.get("header").title).not.toBe("Demo");
  expect(fixture.alert.mock.calls.filter((call) => String(call[1]).startsWith("plugins.checks.result."))).toEqual([]);
  expect(provenDemo()).toBe(said === null);
  const notice = await topNotice();
  expect(notice?.title).toBe("plugins.checks.settledOne");
  await act(async () => notice!.onPress());
  await settle(6);
  expect({ text: sheetControl("plugins.checks")?.textContent ?? "", open: !!sheetControl("plugins.checks.open") })
    .toMatchObject({ text: expect.stringContaining(said ?? "plugins.checks.result.succeeded"), open: said === null });
  expect(requests.filter((request) => request.actionId === "management:begin")).toHaveLength(1);
});

// PR review (2026-11-25): a first install from the user's own Git market, end to end on the phone side.
it("installs from a custom Git market with the Host's manifest check; its result opens the new installed detail", async () => {
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
        return { version: 1, market: { items: installed ? [{ ...item, installState: "installed", installedOperationId: "screen-operation", installedOperationAttribution: "self" }] : [],
          unavailableReason: null, customSourceNames: [], unavailableCustomSourceNames: [] },
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
  // Its result is listed; "Open plugin" opens the new instance (the mocked resource read always titles it "Demo").
  await openListedResult();
  expect(fixture.read).toHaveBeenLastCalledWith(fixture.wire, expect.objectContaining({ deviceId: "mac" }),
    expect.objectContaining({ id: "_root__repo-tools" }), "en", ["plugin-capabilities"]);
});

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
    installedBy?: () => string | undefined; olderHost?: boolean }) {
    // Like the Host: installState and the evidence come from the market-source record of this exact plugin.
    const record$ = (): Record<string, unknown> => (options.detail ? options.detail() : { ...item, installState: options.installed?.() ? "installed" : "not-installed",
      ...attributed(!!options.installed?.(), options.installedBy?.(), options.olderHost),
      manifest: { schemaVersion: 3, id: "demo", name: "Demo", version: "1" } }) as Record<string, unknown>;
    return marketWire((request) => {
      switch (request.actionId) {
        case "management:snapshot": {
          if (request.input?.read === "capabilities") return { catalogPaging: true };
          if (request.input?.read === "catalog") return marketPage([item]);
          // The same record of the plugin as its market detail: the Host projects both from one install record (V2.10).
          const { manifest: _manifest, ...record } = record$();
          return managementSnapshot(options.installed?.() ?? false, record);
        }
        case "management:market-detail": return record$();
        case "management:begin": return options.begin!();
        case "management:answer": return options.answer!();
        case "management:operation": return options.operation!();
        default: throw new Error("unexpected " + request.actionId);
      }
    });
  }
  /* 测试价值（维护者 18:45 复审第 1、2 条；调度要求 I-4）
   * - 生产入口与可观察结果：真实 PluginsScreen（Android 渲染：市场分段、筛选面板、市场行、确认面板、顶部提示、待核实
   *   面板都是真实组件）+ usePluginMarket + 管理 client / controller，只替换设备互联传输；测试只点渲染出来的控件
   *   （按 testID 找到 DOM 按钮再 click），观察发往电脑的 management:* 写请求与查询，以及查询带的操作号。
   * - 依据：已写出、结果未定的操作是这个账号的待核实记录，不依赖目录、筛选、分页或市场列表；顶部提示在有记录时一直可见，
   *   「查看」打开记录自己的面板，「核实结果」只按原操作号查询，不再发 begin、answer 或 cancel；断线时可读、不可核实并
   *   说明原因，重连后按原操作号查。
   * - 缺口：「查看」只切到市场分段，原条目被默认官方筛选、分页或「排除已装」藏起时找不到核实入口；写出后断线再离开整页，
   *   记录被丢弃，重开重连也无法核实。
   * - 最小失败输入：自定义市场安装，Allow 写出、回包丢失；整页卸载再打开，原条目被三种方式之一藏起；或卸载前先断线、
   *   重开后再重连。tier: integration（jsdom，内存 Host，无真实等待）。
   */
  describe("pending checks reached through the page's own controls", () => {
    const { publisherKind: _official, ...base } = marketItem("repo-tools", "Repo Tools");
    const source = { kind: "git", repository: "github.com/demo-org/demo-git-market", sourceId: "DemoGitMarketSource001" };
    const custom = { ...base, pluginId: "custom-market:Demo%20Git%20Market/repo-tools", sourceType: "git-market",
      sourceMarketName: "Demo Git Market", sourceIdentity: source };
    const official = marketItem("notes", "Notes");
    const manifest = { schemaVersion: 3, id: "repo-tools", name: "Repo Tools", version: "1" };
    const ghost = { instanceKey: "_root__repo-tools", namespace: null, manifest, enabled: true,
      approval: { state: "approved", revision: "12345678-1234-4123-8123-123456789abc" } };
    const byId = (id: string) => element.querySelector(`[data-testid="${id}"]`) as HTMLButtonElement | null;
    async function click(id: string) {
      const control = byId(id);
      expect(control, `${id} is on screen`).not.toBeNull();
      expect(control!.disabled, `${id} is available`).toBe(false);
      await act(async () => control!.click());
      await settle(14);
    }
    /** The Host: `hide` decides how the custom item is missing from the reopened market; `installed` after Allow arrives. */
    function wire(world: { hide: "filter" | "paging" | "excludeInstalled" | null; installed: boolean; lookup: "consent" | "running" | "succeeded" }) {
      return requests = marketWire((request) => {
        const consent = { operationId: request.input?.operationId, phase: "confirmation", consent: {
          requestId: "consent", initiator: "user", origin: "custom-market", originLabel: "Demo Git Market", originSource: source,
          installationSource: { kind: "third-party" }, facts: { kind: "install", ghostId: "repo-tools", name: "Repo Tools", version: "1", permissions: [] } } };
        switch (request.actionId) {
          case "management:snapshot": {
            if (request.input?.read === "capabilities") return { catalogPaging: true };
            if (request.input?.read === "catalog") {
              const scope = request.input.query?.scope;
              // Paging: the custom item is on a page the reopened market never asked for.
              if (world.hide === "paging") return { ...marketPage([official]), nextCursor: "page-2", customSourceNames: ["Demo Git Market"] };
              // excludeInstalled: the Host installed it after all, so it is left out of every page.
              const items = scope === "custom" || scope === "all" ? (world.installed && world.hide === "excludeInstalled" ? [] : [custom]) : [official];
              return { ...marketPage(items), customSourceNames: ["Demo Git Market"] };
            }
            return { version: 1, market: { items: world.installed ? [{ ...custom, installState: "installed", installedOperationId: "screen-operation", installedOperationAttribution: "self" }] : [],
              unavailableReason: null, customSourceNames: [], unavailableCustomSourceNames: [] }, ghosts: world.installed ? [ghost] : [] };
          }
          case "management:market-detail": return { ...custom, manifest };
          case "management:begin": return consent;
          case "management:answer": throw new Error("[TIMEOUT] remote invoke timed out");   // written; the reply is lost
          case "management:operation":
            return world.lookup === "consent" ? consent : { operationId: request.input.operationId, phase: world.lookup };
          default: throw new Error("unexpected " + request.actionId);
        }
      });
    }
    /** Real controls only: the market segment, its filter sheet (Custom), the row's Install, the sheet's Allow. */
    let requests: MarketWireRequest[] = [];
    async function installAndAllow() {
      fixture.platform = "android";
      fixture.realConfirmation = true;
      await act(async () => root.render(createElement(PluginsScreen)));
      await act(async () => fixture.props.get("segment").onChange("market"));
      await settle(14);
      await click("plugins.market.filter");
      await click("plugins.market.filter.custom");
      await click(`plugins.market.install.${custom.pluginId}`);
      await click("plugins.management.allow");
    }
    const sentFor = (requests: MarketWireRequest[]) => requests
      .filter((request) => ["management:begin", "management:answer", "management:cancel", "management:operation"].includes(request.actionId!))
      .map((request) => [request.actionId, request.input?.operationId]);
    async function reopenPage() {
      await act(async () => root.render(createElement("div")));
      await settle(6);
      await act(async () => root.render(createElement(PluginsScreen)));
      await settle(14);
    }
    it.each(["filter", "paging", "excludeInstalled"] as const)(
      "opens the check from the notice and looks up only the original operation when the item is hidden by %s", async (hide) => {
        const world = { hide: null as "filter" | "paging" | "excludeInstalled" | null, installed: false, lookup: "consent" as "consent" | "running" | "succeeded" };
        const requests = wire(world);
        await installAndAllow();
        expect(sentFor(requests)).toEqual([["management:begin", "screen-operation"], ["management:answer", "screen-operation"]]);
        // The Host goes on (or not) by itself; the reopened market no longer shows the item.
        world.hide = hide;
        if (hide === "excludeInstalled") world.installed = true;
        await reopenPage();
        await act(async () => fixture.props.get("segment").onChange("market"));
        await settle(14);
        if (hide !== "filter") { await click("plugins.market.filter"); await click("plugins.market.filter.custom"); }
        expect(byId(`plugins.market.install.${custom.pluginId}`)).toBeNull();
        // The notice stays at the top; "View" opens the check's own panel (not the directory or the market list).
        expect(byId("plugins.slotHolder")?.textContent).toContain("plugins.checks.waitingOne");
        await click("plugins.slotHolder.show");
        expect(byId("plugins.checks")?.textContent).toContain("Repo Tools");
        const before = requests.length;
        world.lookup = "succeeded";
        world.installed = true;
        await click("plugins.checks.verify");
        expect(sentFor(requests.slice(before))).toEqual([["management:operation", "screen-operation"]]);
        // Settled by the original operation's receipt: the line says how it ended; nothing more is tracked.
        expect(byId("plugins.checks.verify")).toBeNull();
        expect(byId("plugins.checks")?.textContent).toContain("plugins.checks.result.succeeded");
        await click("plugins.checks.close");
        expect(byId("plugins.slotHolder")).toBeNull();
        expect(sentFor(requests).filter(([action]) => action !== "management:operation"))
          .toEqual([["management:begin", "screen-operation"], ["management:answer", "screen-operation"]]);
      });
    it("keeps the check through offline, leaving and reopening the page, and looks up only the original operation on reconnect", async () => {
      const world = { hide: null, installed: false, lookup: "consent" as "consent" | "running" | "succeeded" };
      const requests = wire(world);
      await installAndAllow();
      // Offline first, then the whole page goes away; it is opened again while the computer is still away.
      fixture.online = false;
      await act(async () => root.render(createElement(PluginsScreen)));
      await settle(6);
      await reopenPage();
      const sentBefore = requests.length;
      expect(byId("plugins.slotHolder")?.textContent).toContain("plugins.checks.waitingOne");
      await click("plugins.slotHolder.show");
      // Readable, not checkable while offline, and says why.
      expect(byId("plugins.checks.verify")?.disabled).toBe(true);
      expect(byId("plugins.checks")?.textContent).toContain("plugins.checks.status.offline");
      await click("plugins.checks.close");
      world.lookup = "running";
      fixture.online = true;
      await act(async () => root.render(createElement(PluginsScreen)));
      await settle(14);
      expect(sentFor(requests.slice(sentBefore))).toEqual([["management:operation", "screen-operation"]]);
      expect(sentFor(requests).filter(([action]) => action !== "management:operation"))
        .toEqual([["management:begin", "screen-operation"], ["management:answer", "screen-operation"]]);
      // Still under way on the computer: the operation stays at the top (it holds the computer's slot again).
      expect(byId("plugins.slotHolder")?.textContent).toContain("plugins.slot.holder");
    });
    it("stops tracking only on this phone: nothing is sent, the notice goes, and the plugin can be installed again", async () => {
      const world = { hide: null, installed: false, lookup: "consent" as "consent" | "running" | "succeeded" };
      const requests = wire(world);
      await installAndAllow();
      await reopenPage();
      await click("plugins.slotHolder.show");
      const before = requests.length;
      await click("plugins.checks.stop");
      expect(sentFor(requests.slice(before))).toEqual([]);
      expect(byId("plugins.checks")?.textContent).toContain("plugins.checks.result.untracked");
      await click("plugins.checks.close");
      expect(byId("plugins.slotHolder")).toBeNull();
      await act(async () => fixture.props.get("segment").onChange("market"));
      await settle(14);
      await click("plugins.market.filter");
      await click("plugins.market.filter.custom");
      expect(byId(`plugins.market.install.${custom.pluginId}`)?.disabled).toBe(false);
    });
  });
  /* 测试价值（维护者 20:45 两条；调度要求 L-1、L-4：待核实记录的状态表逐行一条）
   * - 生产入口与可观察结果：真实 PluginsScreen（Android 渲染）+ usePluginMarket + 待核实记录 + 管理 client / controller，
   *   只替换传输；只点渲染出来的控件（市场行、顶部提示「查看」、记录面板「核实结果」「查看并决定」「打开」「重新读取」、
   *   确认面板「允许」）；观察每一步发往电脑的 management:* 写入与查询（带原操作号）、面板上的状态与按钮、打开的电脑与实例。
   * - 依据：docs/dev-rules/plugin-mobile-implementation.md「待核实记录的状态表」：记录驱动的步骤只读、零 begin / answer /
   *   cancel；写入只来自用户在当前画面上的点按；「打开」只给记录自己按账号与电脑回读核实过的实例。
   * - 缺口：核实时首次发现的确认被后台立刻取消；后台核实出成功后实例回读随 controller 销毁失效，面板没有「打开」。
   * - 最小失败输入：begin 回包丢失、查询停在协议错误后交给记录，再按「核实结果」；表中每行一个 Host 回答。tier: integration。
   */
  describe("pending check state table, through the panel's own controls", () => {
    const byId = (id: string) => element.querySelector(`[data-testid="${id}"]`) as HTMLButtonElement | null;
    async function click(id: string) {
      const control = byId(id);
      expect(control, `${id} is on screen`).not.toBeNull();
      expect(control!.disabled, `${id} is available`).toBe(false);
      await act(async () => control!.click());
      await settle(14);
    }
    type World = { operation: () => unknown; installed: boolean; installedBy?: string; snapshotFails?: number; answer?: () => unknown;
      /** The computer's instances instead of `installed`'s, and the market's record of them in the installed read. */
      ghosts?: () => unknown[]; marketItems?: unknown[];
      /** The computer's installed snapshot and market detail as it answers in one situation (hostPluginInstallFacts.ts). */
      facts?: { ghosts: unknown[]; record: unknown } };
    const consentOf = (requestId = "consent") => ({ operationId: "screen-operation", phase: "confirmation", consent: {
      requestId, initiator: "user", origin: "market", facts: { kind: "install", ghostId: "demo", name: "Demo", version: "1", permissions: [] } } });
    const receipt = (phase: string, extra: object = {}) => ({ operationId: "screen-operation", phase, ...extra });
    function tableWire(world: World) {
      return marketWire((request) => {
        switch (request.actionId) {
          case "management:snapshot":
            if (request.input?.read === "capabilities") return { catalogPaging: true };
            if (request.input?.read === "catalog") return marketPage(world.installed ? [] : [item]);
            if (world.snapshotFails) { world.snapshotFails -= 1; throw hostError("TIMEOUT"); }
            if (world.facts) return { ...managementSnapshot(false), ghosts: world.facts.ghosts,
              market: { ...managementSnapshot(false).market, items: [world.facts.record] } };
            return { ...managementSnapshot(world.installed, { ...item, installState: world.installed ? "installed" : "not-installed",
              ...attributed(world.installed, world.installedBy ?? "screen-operation") }), ...(world.ghosts ? { ghosts: world.ghosts() } : {}),
              ...(world.marketItems ? { market: { ...managementSnapshot(false).market, items: world.marketItems } } : {}) };
          // The detail's manifest is the catalog's current release (its version is the record's, not the installed one).
          case "management:market-detail": if (world.facts) return { ...(world.facts.record as object),
            manifest: { schemaVersion: 3, id: "demo", name: "Demo", version: (world.facts.record as { version: string }).version } };
            return { ...item, installState: world.installed ? "installed" : "not-installed",
            ...attributed(world.installed, world.installedBy ?? "screen-operation"), manifest: { schemaVersion: 3, id: "demo", name: "Demo", version: "1" } };
          case "management:begin": throw new Error("[TIMEOUT] remote invoke timed out");    // written; the reply is lost
          case "management:answer": return world.answer ? world.answer() : receipt("running");
          case "management:operation": return world.operation();
          case "management:cancel": return receipt("cancelled");
          default: throw new Error("unexpected " + request.actionId);
        }
      });
    }
    const writes = (requests: MarketWireRequest[]) => requests
      .filter((request) => ["management:begin", "management:answer", "management:cancel", "management:operation"].includes(request.actionId!))
      .map((request) => request.actionId!.replace("management:", "") + ":" + request.input?.operationId);
    /**
     * The maintainer's start: Install on the market row, begin's reply lost; "Check result" on the row hits a protocol
     * error, so automatic lookups stop and the attempt is handed to its pending check while the person stays on the
     * market; then the notice's "View" opens the list of checks.
     */
    async function toPanel(world: World) {
      fixture.platform = "android";
      fixture.realConfirmation = true;
      const requests = tableWire(world);
      await act(async () => root.render(createElement(PluginsScreen)));
      await act(async () => fixture.props.get("segment").onChange("market"));
      await settle(14);
      await click(`plugins.market.install.${item.pluginId}`);
      world.operation = () => { throw hostError("INVALID_RESPONSE"); };
      await click(`plugins.market.install.${item.pluginId}`);              // the row's "Check result"
      expect(writes(requests)).toEqual(["begin:screen-operation", "operation:screen-operation"]);
      await click("plugins.slotHolder.show");
      expect(byId("plugins.checks")?.textContent).toContain("Demo");
      return requests;
    }
    /** "Check result" in the list: one lookup of the original operation, then nothing written by the list. */
    async function verifyFrom(requests: MarketWireRequest[]) {
      const before = requests.length;
      await click("plugins.checks.verify");
      return () => writes(requests.slice(before));
    }
    const status = () => byId("plugins.checks")?.textContent ?? "";
    it("a consent first found by Check result stays read-only; only View and decide → Allow writes, once (maintainer 20:45 #1)", async () => {
      const world: World = { operation: () => receipt("running"), installed: false };
      const requests = await toPanel(world);
      world.operation = () => consentOf();
      const sent = await verifyFrom(requests);
      expect(sent()).toEqual(["operation:screen-operation"]);
      await settle(14);
      expect(sent()).toEqual(["operation:screen-operation"]);           // no cancel behind the panel
      expect(status()).toContain("plugins.checks.status.awaitingYou");
      expect(byId("plugins.checks.verify")).toBeNull();
      await click("plugins.checks.decide");
      // The same confirmation sheet; only the person's Allow writes the answer.
      expect(sent()).toEqual(["operation:screen-operation"]);
      await click("plugins.management.allow");
      expect(sent()).toEqual(["operation:screen-operation", "answer:screen-operation"]);
      expect(writes(requests).filter((write) => write.startsWith("cancel") || write.startsWith("begin"))).toEqual(["begin:screen-operation"]);
    });
    // Dispatcher O-4 (maintainer review 23:03 of #12684, item 4): a consent that does not declare what was chosen is
    // never allowed, wherever it is shown: the sheet's Allow stays unavailable and pressing it writes nothing; Reject
    // stays. Here the person chose the official market's Demo and the computer's consent names a custom market (another
    // source type), the maintainer's case. Minimal failing input on 015469869c: "View and decide" → Allow wrote the
    // answer (only custom-market consents were compared). Tier: unit/jsdom (real controller, real sheet).
    const otherSourceType = (requestId = "consent") => ({ ...consentOf(requestId), consent: { ...consentOf(requestId).consent,
      origin: "custom-market", originLabel: "Team", originSource: { kind: "git", repository: "github.com/acme/market", sourceId: "SourceA_0123456789abcd" } } });
    const answers = (requests: MarketWireRequest[]) => writes(requests).filter((write) => write.startsWith("answer"));
    async function allowIsRefused(requests: MarketWireRequest[]) {
      const allow = byId("plugins.management.allow");
      expect(allow, "the confirmation is on screen").not.toBeNull();
      expect(allow!.disabled).toBe(true);
      await act(async () => allow!.click());
      await settle(14);
      expect(answers(requests)).toEqual([]);
      expect(element.textContent).toContain("plugins.notice.consentSource.sourceChanged");
      expect(byId("plugins.management.reject")?.disabled).toBe(false);
    }
    it("View and decide: a consent naming another source type than the one chosen writes no answer", async () => {
      const world: World = { operation: () => receipt("running"), installed: false };
      const requests = await toPanel(world);
      world.operation = () => otherSourceType();
      await verifyFrom(requests);
      await click("plugins.checks.decide");
      await allowIsRefused(requests);
    });
    it("first display: the consent begin returns names another source type, Allow writes nothing", async () => {
      fixture.platform = "android";
      fixture.realConfirmation = true;
      const world: World = { operation: () => otherSourceType(), installed: false };
      const requests = tableWire(world);
      await act(async () => root.render(createElement(PluginsScreen)));
      await act(async () => fixture.props.get("segment").onChange("market"));
      await settle(14);
      // The begin's own reply is the consent (no lookup): the table's begin loses its reply, so answer it here.
      const wire = fixture.wire.getMockImplementation()!;
      fixture.wire.mockImplementation(async (device: string, channel: string, args?: any[], options?: any) =>
        args?.[0]?.actionId === "management:begin" ? transportSend(options, async () => {
          requests.push({ device, actionId: "management:begin", input: args[0].input });
          return { effects: [], result: otherSourceType() };
        }) : wire(device, channel, args, options));
      await click(`plugins.market.install.${item.pluginId}`);
      expect(writes(requests)).toEqual(["begin:screen-operation"]);
      await allowIsRefused(requests);
    });
    it("after a reconnect: the consent the lookup finds names another source type, Allow writes nothing", async () => {
      fixture.platform = "android";
      fixture.realConfirmation = true;
      const world: World = { operation: () => receipt("running"), installed: false };
      const requests = tableWire(world);
      await act(async () => root.render(createElement(PluginsScreen)));
      await act(async () => fixture.props.get("segment").onChange("market"));
      await settle(14);
      await click(`plugins.market.install.${item.pluginId}`);               // begin written, reply lost
      world.operation = () => otherSourceType();
      fixture.online = false;
      await act(async () => root.render(createElement(PluginsScreen)));
      await settle(14);
      fixture.online = true;
      await act(async () => root.render(createElement(PluginsScreen)));
      await settle(14);
      expect(writes(requests)).toContain("operation:screen-operation");  // looked up on reconnect
      await allowIsRefused(requests);
    });
    it("after a remount: the consent its row finds names another source type, Allow writes nothing", async () => {
      const world: World = { operation: () => receipt("running"), installed: false };
      const requests = await toPanel(world);
      await click("plugins.checks.close");
      await act(async () => root.render(createElement("div")));
      await settle(6);
      await act(async () => root.render(createElement(PluginsScreen)));
      await act(async () => fixture.props.get("segment").onChange("market"));
      await settle(14);
      world.operation = () => otherSourceType();
      await click("plugins.slotHolder.show");
      await verifyFrom(requests);
      await click("plugins.checks.decide");
      await allowIsRefused(requests);
    });
    it("leaving a consent the sheet showed cancels it once (the one write a gone view makes)", async () => {
      fixture.platform = "android";
      fixture.realConfirmation = true;
      const world: World = { operation: () => consentOf(), installed: false };
      const requests = marketWire((request) => request.actionId === "management:begin" ? consentOf()
        : request.actionId === "management:cancel" ? receipt("cancelled")
          : request.actionId === "management:snapshot" ? (request.input?.read === "capabilities" ? { catalogPaging: true }
            : request.input?.read === "catalog" ? marketPage([item]) : managementSnapshot(false))
            : request.actionId === "management:market-detail" ? { ...item, manifest: { schemaVersion: 3, id: "demo", name: "Demo", version: "1" } }
              : world.operation());
      await act(async () => root.render(createElement(PluginsScreen)));
      await act(async () => fixture.props.get("segment").onChange("market"));
      await settle(14);
      await click(`plugins.market.install.${item.pluginId}`);
      expect(byId("plugins.management.allow")).not.toBeNull();             // on screen
      await act(async () => root.render(createElement("div")));
      await settle(14);
      expect(writes(requests)).toEqual(["begin:screen-operation", "cancel:screen-operation"]);
    });
    it("an Allow written whose consent the computer still shows: only looks up, never answers again", async () => {
      const world: World = { operation: () => receipt("running"), installed: false, answer: () => { throw new Error("[TIMEOUT] remote invoke timed out"); } };
      const requests = await toPanel(world);
      world.operation = () => consentOf();
      const sent = await verifyFrom(requests);
      await click("plugins.checks.decide");
      await click("plugins.management.allow");                            // written, reply lost
      await click("plugins.slotHolder.show");
      const after = requests.length;
      await click("plugins.checks.verify");
      expect(writes(requests.slice(after))).toEqual(["operation:screen-operation"]);
      expect(byId("plugins.checks.decide")).toBeNull();
      expect(sent().filter((write) => write.startsWith("answer"))).toEqual(["answer:screen-operation"]);
    });
    it("a new consent (another request id) found by a check is read-only until the person opens it", async () => {
      const world: World = { operation: () => receipt("running"), installed: false };
      const requests = await toPanel(world);
      world.operation = () => consentOf("consent-2");
      const sent = await verifyFrom(requests);
      expect(sent()).toEqual(["operation:screen-operation"]);
      expect(status()).toContain("plugins.checks.status.awaitingYou");
      expect(byId("plugins.checks.decide")).not.toBeNull();
    });
    it("running: says the computer is working on it, writes nothing", async () => {
      const world: World = { operation: () => receipt("running"), installed: false };
      const requests = await toPanel(world);
      world.operation = () => receipt("running");
      const sent = await verifyFrom(requests);
      expect(sent()).toEqual(["operation:screen-operation"]);
      expect(status()).toContain("plugins.checks.status.running");
    });
    it("succeeded: the list reads the computer, then Open opens that instance on that computer (maintainer 20:45 #2)", async () => {
      const world: World = { operation: () => receipt("running"), installed: false };
      const requests = await toPanel(world);
      world.operation = () => receipt("succeeded");
      world.installed = true;
      const sent = await verifyFrom(requests);
      expect(sent()).toEqual(["operation:screen-operation"]);
      expect(status()).toContain("plugins.checks.result.succeeded");
      fixture.read.mockClear();
      await click("plugins.checks.open");
      expect(fixture.read).toHaveBeenCalledWith(fixture.wire, expect.objectContaining({ deviceId: "mac" }),
        expect.objectContaining({ id: "_root__demo" }), "en", ["plugin-capabilities"]);
    });
    it("succeeded but the computer could not be read: no Open until Read again finds the instance", async () => {
      const world: World = { operation: () => receipt("running"), installed: false };
      const requests = await toPanel(world);
      world.operation = () => receipt("succeeded");
      world.installed = true;
      world.snapshotFails = 5;
      await verifyFrom(requests);
      expect(status()).toContain("plugins.checks.result.succeededUnread");
      expect(byId("plugins.checks.open")).toBeNull();
      world.snapshotFails = 0;
      await click("plugins.checks.readAgain");
      expect(byId("plugins.checks.open")).not.toBeNull();
    });
    // Dispatcher O-2, R-1, R-2, R-3 (maintainer review 01:21 of #12684): after the operation, the list opens only what
    // the computer's facts now name as this operation's instance (pluginOperationOpens); a success receipt is a past
    // result. The facts are the computer's own answers in each situation (hostPluginInstallFacts.ts), after a final
    // receipt and after the receipt is gone. Otherwise the result stands and one sentence says why there is no Open.
    // Minimal failing inputs on 5983ba71dd: a same-version reinstall by the computer or another controller (evidence left
    // out) still offered Open after a final receipt; only the catalog's next release lost Open after the final receipt
    // and read "could not confirm" after the receipt was gone. Tier: unit/jsdom.
    const situated = (situation: HostInstallSituation) => hostInstallFacts(situation, { operationId: "screen-operation",
      target: { ...item, installState: "installed" } as any, instance: demoGhost as any, next: { releaseId: "demo@2", version: "2" } });
    const afterFinal: Record<HostInstallSituation, string | null> = {
      own: null, catalogAdvanced: null,
      localReinstall: "plugins.checks.result.unconfirmed", otherControllerReinstall: "plugins.checks.result.unconfirmed",
      bindingLost: "plugins.checks.result.unconfirmed", olderHost: "plugins.checks.result.legacyHost",
      otherControllerUpdate: "plugins.checks.result.unconfirmed", uninstalled: "plugins.checks.result.goneSince",
    };
    it.each(HOST_INSTALL_SITUATIONS)("succeeded, then the computer: %s", async (situation) => {
      const world: World = { operation: () => receipt("running"), installed: false };
      const requests = await toPanel(world);
      world.operation = () => receipt("succeeded");
      world.facts = situated(situation);
      const sent = await verifyFrom(requests);
      expect(sent()).toEqual(["operation:screen-operation"]);
      const said = afterFinal[situation];
      if (said) expect(status()).toContain(said); else expect(status()).toContain("plugins.checks.result.succeeded");
      expect(!!byId("plugins.checks.open")).toBe(said === null);
    });
    // Maintainer review 03:52 of c6efda5691: "Go to Installed" (an older computer, V2.10 ③) left a narrow screen on the
    // detail it was opened from (it only closed the list and switched the segment; a narrow screen with a detail selected
    // draws no directory). It now goes back to the directory the way its back step does, on the record's computer, in the
    // installed segment. Where it is pressed from: an installed detail or a market detail, the directory on the record's
    // computer or on another one; narrow and wide. The narrow installed-detail rows failed on c6efda5691. Tier: unit/jsdom.
    it.each([
      ["narrow, from an installed detail", 390, "installed", "mac"],
      ["narrow, from an installed detail, the directory on another computer", 390, "installed", "pc"],
      ["narrow, from a market detail", 390, "market", "mac"],
      ["wide, from an installed detail", 1024, "installed", "mac"],
    ] as const)("Go to Installed (an older computer) ends on the record's computer's installed list: %s", async (_name, width, from, onComputer) => {
      fixture.extraDevices = [{ deviceId: "pc", name: "PC", platform: "win32", remoteControlEnabled: true }];
      const world: World = { operation: () => receipt("running"), installed: false };
      const requests = await toPanel(world);
      await click("plugins.checks.close");
      // iOS: the directory is its own view here (Android draws it inline), so where the page ends up is observable.
      fixture.platform = "ios";
      fixture.width = width;
      await act(async () => root.render(createElement(PluginsScreen)));
      if (onComputer !== "mac") await act(async () => fixture.props.get("directory").onDeviceChange(onComputer));
      if (from === "installed") await act(async () => fixture.props.get("directory").onDetail(row()));
      else await act(async () => fixture.props.get("directory").market.openDetail(fixture.props.get("directory").market.items[0] ?? item));
      await settle(14);
      // The notice opens the list (the market detail stand-in here draws no notice row of its own).
      await act(async () => fixture.props.get("plugins.slotHolder").onPress());
      await settle(14);
      world.operation = () => receipt("succeeded");
      world.facts = { ghosts: [demoGhost], record: { ...item, ...evidenceOf(CONTRACT_SAMPLES.olderHost) } };
      await verifyFrom(requests);
      expect(status()).toContain("plugins.checks.result.legacyHost");
      fixture.props.delete("directory");
      await click("plugins.checks.showInstalled");
      await settle(6);
      expect(byId("plugins.checks")).toBeNull();
      // The directory is drawn again, on the record's computer, in the installed segment; no detail stays selected.
      expect(fixture.props.has("directory")).toBe(true);
      expect(fixture.props.get("directory")).toMatchObject({ deviceId: "mac", segment: "installed" });
      expect(fixture.props.get("directory").market.detail ?? null).toBeNull();
    });
    // The record's computer is no longer in the account's list when "Go to Installed" is pressed: the computer shown stays
    // (there is none to switch to) and only the segment changes. Locks the current behaviour; whether "Go to Installed"
    // should be offered at all then is a proposal for the maintainer. Tier: unit/jsdom.
    it("Go to Installed when the record's computer is no longer listed: the computer shown stays, the segment changes", async () => {
      fixture.extraDevices = [{ deviceId: "pc", name: "PC", platform: "win32", remoteControlEnabled: true }];
      const world: World = { operation: () => receipt("running"), installed: false };
      const requests = await toPanel(world);
      await click("plugins.checks.close");
      fixture.platform = "ios";
      await act(async () => root.render(createElement(PluginsScreen)));
      await act(async () => fixture.props.get("directory").onDeviceChange("pc"));
      await act(async () => fixture.props.get("directory").onSegmentChange("market"));
      await act(async () => fixture.props.get("plugins.slotHolder").onPress());
      await settle(14);
      world.operation = () => receipt("succeeded");
      world.facts = { ghosts: [demoGhost], record: { ...item, ...evidenceOf(CONTRACT_SAMPLES.olderHost) } };
      await verifyFrom(requests);
      expect(status()).toContain("plugins.checks.result.legacyHost");
      fixture.removedDevices.add("mac");
      await act(async () => root.render(createElement(PluginsScreen)));
      await click("plugins.checks.showInstalled");
      await settle(6);
      expect(byId("plugins.checks")).toBeNull();
      expect(fixture.props.get("directory")).toMatchObject({ deviceId: "pc", segment: "installed" });
    });
    // As the computer answers (dispatcher R-3): an older package of the same plugin installed over it rewrites the record
    // (no evidence for this phone, the record an older release on this route); the root instance gone with one of the same
    // name in another namespace leaves the root record not installed.
    // Contract V2.10's samples ② and ③ (their evidence fields byte for byte, on this test's plugin) and every shape it
    // lists under ②, after a final receipt and after it is gone: never Open; ② "changed or cannot be confirmed", ③ "older
    // computer, open it from Installed" (with the way there). Sample ① is the `catalogAdvanced` row above (its shape on
    // this test's plugin; the samples' operation id is not this phone's). Tier: unit/jsdom.
    const evidenceOf = (sample: Record<string, unknown>) => Object.fromEntries(Object.entries(sample)
      .filter(([key]) => key === "installState" || key === "installedOperationId" || key === "installedOperationAttribution"));
    it.each([
      ["sample ②", evidenceOf(CONTRACT_SAMPLES.unattributed), "plugins.checks.result.unconfirmed", "plugins.market.unconfirmedMismatch"],
      ["sample ③", evidenceOf(CONTRACT_SAMPLES.olderHost), "plugins.checks.result.legacyHost", "plugins.market.unconfirmedLegacy"],
      ...secondShapes("screen-operation").map(([name, fields]) => [`② ${name}`, { installState: "update-available", ...fields },
        "plugins.checks.result.unconfirmed", "plugins.market.unconfirmedMismatch"] as const),
    ] as const)("succeeded or receipt gone, the computer's record is %s: no Open", async (_name, fields, afterFinal, afterGone) => {
      for (const receiptGone of [false, true]) {
        __retainedForTests.clear(); slotTesting.reset();
        const world: World = { operation: () => receipt("running"), installed: false };
        const requests = await toPanel(world);
        world.operation = receiptGone ? () => { throw hostError("NOT_FOUND"); } : () => receipt("succeeded");
        world.facts = { ghosts: [demoGhost], record: { ...item, ...fields } };
        await verifyFrom(requests);
        expect(status()).toContain(receiptGone ? afterGone : afterFinal);
        expect(byId("plugins.checks.open")).toBeNull();
        if (!receiptGone && afterFinal === "plugins.checks.result.legacyHost") {
          // The way there: the installed segment (never a particular instance).
          await click("plugins.checks.showInstalled");
          expect(byId("plugins.checks")).toBeNull();
          expect(fixture.props.get("segment").value).toBe("installed");
        }
        await act(async () => root.render(createElement("div")));
        await settle(6);
      }
    });
    it.each([
      ["only an older version with the same id", { ghosts: [{ ...demoGhost, manifest: { ...demoGhost.manifest, version: "0" } }],
        record: { ...item, installState: "update-available", installedOperationAttribution: "unattributed" } }, "plugins.checks.result.unconfirmed"],
      ["the same name in another namespace", { ghosts: [{ ...demoGhost, instanceKey: "team__demo", namespace: "team" }],
        record: { ...item, installState: "not-installed" } }, "plugins.checks.result.goneSince"],
    ] as const)("succeeded, but %s: no Open, says why", async (_name, facts, said) => {
      const world: World = { operation: () => receipt("running"), installed: false };
      const requests = await toPanel(world);
      world.operation = () => receipt("succeeded");
      world.facts = facts as unknown as World["facts"];
      await verifyFrom(requests);
      expect(status()).toContain(said);
      expect(byId("plugins.checks.open")).toBeNull();
    });
    const afterGone: Record<HostInstallSituation, [string, boolean]> = {
      own: ["plugins.checks.result.installed", true], catalogAdvanced: ["plugins.checks.result.installed", true],
      localReinstall: ["plugins.market.unconfirmedMismatch", false], otherControllerReinstall: ["plugins.market.unconfirmedMismatch", false],
      bindingLost: ["plugins.market.unconfirmedMismatch", false], olderHost: ["plugins.market.unconfirmedLegacy", false],
      otherControllerUpdate: ["plugins.market.unconfirmedMismatch", false], uninstalled: ["plugins.market.unconfirmedNotInstalled", false],
    };
    it.each(HOST_INSTALL_SITUATIONS)("NOT_FOUND, then the computer: %s: settles from its facts, writes nothing", async (situation) => {
      const world: World = { operation: () => receipt("running"), installed: false };
      const requests = await toPanel(world);
      world.operation = () => { throw hostError("NOT_FOUND"); };
      world.facts = situated(situation);
      const sent = await verifyFrom(requests);
      expect(sent()).toEqual(["operation:screen-operation"]);
      const [text, opens] = afterGone[situation];
      expect(status()).toContain(text);
      expect(!!byId("plugins.checks.open")).toBe(opens);
    });
    it.each([["failed", "plugins.checks.result.failed"], ["cancelled", "plugins.checks.result.cancelled"]])(
      "%s (here or by another controller): says how it ended, writes nothing", async (phase, text) => {
        const world: World = { operation: () => receipt("running"), installed: false };
        const requests = await toPanel(world);
        world.operation = () => receipt(phase, phase === "failed" ? { errorCode: "GHOST_DOWNLOAD_FAILED" } : {});
        const sent = await verifyFrom(requests);
        expect(sent()).toEqual(["operation:screen-operation"]);
        expect(status()).toContain(text);
        expect(byId("plugins.checks.open")).toBeNull();
      });
    it.each([["a retryable failure", "TIMEOUT"], ["a protocol error", "INVALID_RESPONSE"]])(
      "lookup fails with %s: stays unconfirmed, Check result stays, nothing written", async (_name, code) => {
        const world: World = { operation: () => receipt("running"), installed: false };
        const requests = await toPanel(world);
        world.operation = () => { throw hostError(code); };
        const sent = await verifyFrom(requests);
        expect(sent()).toEqual(["operation:screen-operation"]);
        expect(status()).toContain("plugins.checks.status.waiting");
        expect(byId("plugins.checks.verify")).not.toBeNull();
      });
    // Dispatcher N-1, found while verifying on the mock: "no write receipt" was taken as "never written", so a begin
    // that reached the computer but whose reply was lost read "failed, try again" on a transport that does not report
    // writes, and a second tap sent a second begin. Now only positive evidence of a refusal makes it a plain failure.
    function silentWire(begin: "silent" | "refused") {
      fixture.realManagement = true;
      const requests: MarketWireRequest[] = [];
      fixture.wire.mockImplementation(async (device: string, channel: string, args?: any[], options?: any) => {
        if (channel.endsWith(":manifest"))
          return { protocolVersion: 1, collections: [{ id: "plugins", actions: [{ id: "management:snapshot", label: "Manage" }] }] };
        const envelope = args?.[0] ?? {};
        const request = { device, actionId: envelope.actionId, input: envelope.input, resourceRef: envelope.resourceRef };
        requests.push(request);
        options?.preSend?.();
        if (request.actionId === "management:begin") {
          // `silent`: a transport that reports neither the write nor a refusal; `refused`: refused before the write, said so.
          if (begin === "refused") options?.onNotSent?.();
          throw new Error("[TIMEOUT] remote invoke timed out");
        }
        options?.onRequestWritten?.();
        if (request.actionId === "management:operation") return { effects: [], result: receipt("running") };
        if (request.actionId === "management:market-detail") return { effects: [], result: { ...item, manifest: { schemaVersion: 3, id: "demo", name: "Demo", version: "1" } } };
        if (request.input?.read === "capabilities") return { effects: [], result: { catalogPaging: true } };
        if (request.input?.read === "catalog") return { effects: [], result: marketPage([item]) };
        return { effects: [], result: managementSnapshot(false) };
      });
      return requests;
    }
    async function pressInstall() {
      fixture.platform = "android";
      await act(async () => root.render(createElement(PluginsScreen)));
      await act(async () => fixture.props.get("segment").onChange("market"));
      await settle(14);
      await click(`plugins.market.install.${item.pluginId}`);
    }
    const lineOf = () => byId(`plugins.market.line.${item.pluginId}`)?.textContent ?? "";
    it("a begin that fails on a transport that reports nothing is a result to check, never a failure to retry", async () => {
      const requests = silentWire("silent");
      await pressInstall();
      expect(lineOf()).toContain("plugins.market.resultUnknownDetail");
      expect(lineOf()).not.toContain("plugins.actionFailed");
      await click(`plugins.market.install.${item.pluginId}`);              // the row now says "Check result"
      expect(writes(requests)).toEqual(["begin:screen-operation", "operation:screen-operation"]);
    });
    it("a begin refused before the write (said so by the transport) is a plain failure that may be tried again", async () => {
      const requests = silentWire("refused");
      await pressInstall();
      expect(lineOf()).not.toContain("plugins.market.resultUnknownDetail");
      expect(byId(`plugins.market.install.${item.pluginId}`)?.textContent).toContain("plugins.retry");
      await click(`plugins.market.install.${item.pluginId}`);
      expect(writes(requests)).toEqual(["begin:screen-operation", "begin:screen-operation"]);
    });
    it("offline: readable, Check result unavailable with the reason, nothing sent", async () => {
      const world: World = { operation: () => receipt("running"), installed: false };
      const requests = await toPanel(world);
      fixture.online = false;
      await act(async () => root.render(createElement(PluginsScreen)));
      await settle(14);
      const before = requests.length;
      if (!byId("plugins.checks")) await click("plugins.slotHolder.show");
      expect(byId("plugins.checks.verify")?.disabled).toBe(true);
      expect(status()).toContain("plugins.checks.status.offline");
      expect(writes(requests.slice(before))).toEqual([]);
    });
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
    // Allow was written, but the computer or another controller installed this release since: the computer then says
    // `'unattributed'` to this phone (contract V2.10; dispatcher R-3: its actual answer, not another id).
    ["installed on the computer by another install", true, "plugins.market.unconfirmedMismatch", undefined],
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
    await act(async () => { await shownMarket().checkResult(item); });
    await settle(14);
    if (messageKey) expect(shownMarket()).toMatchObject({ installBusy: false, canInstall: true });
    if (messageKey) expect(shownMarket().rowState(item)).toEqual({ kind: "failed", messageKey });
    else {
      // Proven as this install; listed, and opened only by the person from the list.
      expect(provenDemo()).toBe(true);
      expect(fixture.props.get("header").title).not.toBe("Demo");
      await openListedResult();
      expect(fixture.read).toHaveBeenLastCalledWith(fixture.wire, expect.anything(), expect.objectContaining({ id: "_root__demo" }), "en", ["plugin-capabilities"]);
    }
    // Never a second begin: the unknown result is only looked up, never replayed.
    expect(requests.filter((request) => request.actionId === "management:begin")).toHaveLength(1);
  });
  // Maintainer reviews 09:30 #2 and 10:36 #2 (contract V2.9): Allow was written; the computer went offline before its reply
  // timed out, the receipt expired, the phone came back. The result is confirmed only from the Host's own record that
  // this attempt's operation installed the package, so the offline period cannot lose it; the same id and release
  // installed by another operation stays unconfirmed. Minimal failing input: written Allow → offline → timeout →
  // receipt gone → reconnect. Tier: unit (jsdom, in-memory Host).
  it.each([
    ["this attempt's operation installed it", "screen-operation", true, false],
    // The computer or another controller installed the same release: V2.10 says `'unattributed'` to this phone.
    ["another install put the same release there ('unattributed')", undefined, false, false],
    ["the Host gives no operation evidence (older Host)", undefined, false, true],
  ] as const)("checks a written Allow after offline, timeout and an expired receipt: %s", async (_name, installedBy, confirmed, olderHost) => {
    let installed = false, receiptGone = false, releaseReply!: () => void;
    const reply = new Promise<void>((resolve) => { releaseReply = resolve; });
    const requests = installWire({
      begin: () => demoConsent({ input: { operationId: "screen-operation" } } as any),
      // Written; the reply is held until the computer is offline, then times out.
      answer: async () => { installed = true; await reply; throw new Error("[TIMEOUT] remote invoke timed out"); },
      operation: () => { if (receiptGone) throw hostError("NOT_FOUND"); return { operationId: "screen-operation", phase: "running" }; },
      installed: () => installed,
      installedBy: () => installed ? installedBy : undefined,
      olderHost,
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
    if (shownMarket().rowState(item).kind === "unknown") { await act(async () => { await shownMarket().checkResult(item); }); await settle(14); }
    const opened = provenDemo();
    expect(opened).toBe(confirmed);
    // Unconfirmed: the row keeps the note and the market is released (confirmed opens the installed detail instead).
    if (!confirmed) {
      // An older computer (no evidence fields, V2.10 ③) says so; anything else not this operation's is ②.
      expect(shownMarket().rowState(item)).toEqual({ kind: "failed", messageKey: olderHost ? "plugins.market.unconfirmedLegacy" : "plugins.market.unconfirmedMismatch" });
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
      // A record on this route (another release) is attributed to nobody here; a conflict carries no marker (V2.10).
      detail: () => ({ ...item, installState: sameIdOnComputer ? installState : "not-installed",
        ...(sameIdOnComputer && installState === "update-available" ? { installedOperationAttribution: "unattributed" } : {}),
        releaseId: sameIdOnComputer ? releaseId : item.releaseId,
        manifest: { schemaVersion: 3, id: "demo", name: "Demo", version: "1" } }),
    });
    await openMarket();
    await act(async () => shownMarket().install(shownMarket().items[0]));
    await settle(14);
    await act(async () => { await shownMarket().checkResult(item); });
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
  // Controller rule ④ (contract V2.10, settled 2026-11-26; maintainer review 03:52 of c6efda5691): after NOT_FOUND, "Open"
  // is decided only from one installed read, its market record and its instances together. A market detail's 'self' is
  // only "the install current when it was read": combined with another response's instances it can name a replaced
  // instance. Responses shaped as the Host projects them (contract section "同一响应里归属与实例出自同一次安装"; it has
  // no JSON samples for this). Both failed on c6efda5691 (it read the detail after the snapshot). Tier: unit/jsdom.
  const replaced = { ...demoGhost, manifest: { ...demoGhost.manifest, version: "2" },
    approval: { state: "approved", revision: "22222222-2222-4222-8222-222222222222" } };
  it.each([
    ["the detail says this install, the installed read another install's record beside the replaced instance", false],
    ["the installed read says this install beside its instance, and the detail cannot be read", true],
  ] as const)("after the receipt is gone, Open comes only from one installed read: %s", async (_name, sameResponseProves) => {
    let installed = false, receiptGone = false;
    const requests = marketWire((request) => {
      switch (request.actionId) {
        case "management:snapshot":
          if (request.input?.read === "capabilities") return { catalogPaging: true };
          if (request.input?.read === "catalog") return marketPage(installed ? [] : [item]);
          if (!installed) return managementSnapshot(false);
          return sameResponseProves ? managementSnapshot(true)
            : { ...managementSnapshot(true, { ...item, installState: "installed", installedOperationAttribution: "unattributed" }), ghosts: [replaced] };
        case "management:market-detail":
          if (installed && sameResponseProves) throw hostError("TIMEOUT");
          return { ...item, installState: installed ? "installed" : "not-installed", ...attributed(installed, "screen-operation"),
            manifest: { schemaVersion: 3, id: "demo", name: "Demo", version: "1" } };
        case "management:begin": return demoConsent(request);
        case "management:answer": installed = true; throw new Error("[TIMEOUT] remote invoke timed out");
        case "management:operation":
          if (receiptGone) throw hostError("NOT_FOUND");
          return { operationId: request.input.operationId, phase: "running" };
        default: throw new Error("unexpected " + request.actionId);
      }
    });
    await openMarket();
    await act(async () => shownMarket().install(shownMarket().items[0]));
    await settle(14);
    await act(async () => { void fixture.props.get("confirmation").controller.answer(true); });
    await settle(14);
    receiptGone = true;
    await act(async () => { await shownMarket().checkResult(item); });
    await settle(14);
    expect(provenDemo()).toBe(sameResponseProves);
    if (!sameResponseProves) expect(shownMarket().rowState(item)).toEqual({ kind: "failed", messageKey: "plugins.market.unconfirmedMismatch" });
    expect(requests.filter((request) => request.actionId === "management:begin")).toHaveLength(1);
    expect(requests.filter((request) => request.actionId === "management:answer")).toHaveLength(1);
  });
  // Maintainer reviews (2026-11-25, 01:52 and 04:44): after the receipt expired, the computer replaced custom market A
  // with a same-name repository or folder B and installed B's plugin with the same id and release; the phone took it
  // as A's result. Contract V2.9 (maintainer reviews 09:30 and 10:36): only the Host's record that this attempt's
  // operation installed the package confirms it; the installed source id is no longer the check.
  const sourceA = { kind: "git", repository: "github.com/acme/market", sourceId: "SourceA_0123456789abcd" };
  it.each([
    // Another install (the computer's or another controller's, e.g. from a same-name source): the field is left out.
    ["another install put the same id and release there (e.g. from a same-name source)", undefined, "unconfirmed", false],
    ["the computer gives no operation evidence (older Host)", undefined, "unconfirmed", true],
    ["this attempt's operation installed it", "screen-operation", "installed", false],
  ])("confirms a lost-receipt custom-market install only from the Host's operation evidence: %s", async (_name, installedOperationId, expected, olderHost) => {
    const { publisherKind: _server, ...base } = marketItem("demo", "Demo");
    const item = { ...base, pluginId: "custom:Team/demo", sourceType: "git-market", sourceMarketName: "Team", sourceIdentity: sourceA };
    let installed = false, receiptGone = false;
    const record = () => ({ ...item, installState: installed ? "installed" : "not-installed",
      ...(installed ? { installedSourceId: sourceA.sourceId } : {}), ...attributed(installed, installedOperationId, olderHost) });
    const requests = marketWire((request) => {
      switch (request.actionId) {
        case "management:snapshot":
          if (request.input?.read === "capabilities") return { catalogPaging: true };
          if (request.input?.read === "catalog") return { ...marketPage(installed ? [] : [item]), customSourceNames: ["Team"] };
          // The installed read carries the same record of the plugin as its market detail (V2.10, one install record).
          return managementSnapshot(installed, record());
        case "management:market-detail":
          return { ...record(), manifest: { schemaVersion: 3, id: "demo", name: "Demo", version: "1" } };
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
    await act(async () => { await shownMarket().checkResult(item); });
    await settle(14);
    const opened = provenDemo();
    if (expected === "installed") expect(opened).toBe(true);
    else {
      expect(opened).toBe(false);
      expect(shownMarket()).toMatchObject({ installBusy: false });
      expect(shownMarket().rowState(item)).toEqual({ kind: "failed", messageKey: olderHost ? "plugins.market.unconfirmedLegacy" : "plugins.market.unconfirmedMismatch" });
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
          // The computer's record of this item comes with its installed read (the one response a result is judged from).
          return managementSnapshot(installed, { ...item, installState: "installed", ...attributed(installed), installedSourceId: sourceA.sourceId });
        case "management:market-detail":
          return { ...item, installState: installed ? "installed" : "not-installed", ...attributed(installed), ...(installed ? { installedSourceId: sourceA.sourceId } : {}),
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
    await act(async () => { await shownMarket().checkResult(item); });
    await settle(14);
    expect(provenDemo()).toBe(false);
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
    const record = () => ({ ...shown, installState: onComputer ? "installed" : "not-installed", ...attributed(onComputer),
      ...(custom && onComputer ? { installedSourceId: folderB.sourceId } : {}) });
    const requests = marketWire((request) => {
      switch (request.actionId) {
        case "management:snapshot":
          if (request.input?.read === "capabilities") return { catalogPaging: true };
          if (request.input?.read === "catalog") return { ...marketPage(onComputer ? [] : [shown]), customSourceNames: custom ? ["Team"] : [] };
          // The installed read carries the same record of the plugin as its market detail (V2.10, one install record).
          return managementSnapshot(onComputer, record());
        case "management:market-detail":
          return { ...record(), manifest: { schemaVersion: 3, id: "demo", name: "Demo", version: "1" } };
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
    else await act(async () => { await shownMarket().checkResult(item); });
    await settle(14);
    expect(provenDemo()).toBe(false);
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
    // What the sheet shows: the controller's own decision (pluginConsentAllowance) for the consent on screen.
    const view = pluginConsentPresentation(sheet.state.receipt.consent, (key: string) => key, "Mac", sheet.controller.consentAllowance());
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
    await act(async () => { await shownMarket().checkResult(item); });
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
  // The market stays on screen after the install and no longer offers what was just installed.
  expect(shownMarket().items.map((row: any) => row.name)).toEqual(["Other"]);
  await openListedResult();
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
    await openListedResult();
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
    await openListedResult();
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

// Dispatcher S-1 (Android seventh reshoot): with market=detailReadFailed the detail's "Retry" seemed to leave the banner.
// Through the real screen and the mock computer itself: the first detail read fails, the notice's own Retry reads it
// again, and the banner goes with the freshly read detail. The product path recovers (this passes on 5983ba71dd too:
// existing behaviour). What the capture saw was its script tapping the banner's text, which also contains "Retry"
// (Android eighth reshoot), not the app. The mock is made repeatable on its own account: it fails once per plugin, and
// applying the same scenario again does not arm it again. Tier: unit/jsdom.
it("recovers the market detail with its Retry after the first read failed (mock market=detailReadFailed)", async () => {
  const { pluginMarketVisualManagement, setPluginMarketVisualScenario, resetPluginMarketVisualComputer } = await import("@/debug/pluginMarketVisualFixture");
  resetPluginMarketVisualComputer();
  setPluginMarketVisualScenario("normal", true);
  setPluginMarketVisualScenario("detailReadFailed", true);
  try {
    const requests = marketWire((request) => (pluginMarketVisualManagement(request.actionId, request.input, request.resourceRef?.id) as any).result);
    await openMarket();
    const agenda = shownMarket().items.find((entry: any) => entry.name === "Demo Agenda");
    await act(async () => shownMarket().openDetail(agenda));
    await settle(14);
    const banner = () => element.querySelector('[data-testid="plugins.market.detailFailed"]');
    expect(banner()).not.toBeNull();
    // While failed the page shows what the market list already said; the manifest's tools come only from a detail read.
    expect(element.textContent).not.toContain("demo_list_events");
    // The same deep link again does not make the next read fail (the mock scenario is repeatable).
    setPluginMarketVisualScenario("detailReadFailed", true);
    await act(async () => fixture.props.get("plugins.market.detailFailed").actions[0].onPress());
    await settle(14);
    expect(banner()).toBeNull();
    expect(requests.filter((request) => request.actionId === "management:market-detail").map((request) => request.input?.pluginId))
      .toEqual([agenda.pluginId, agenda.pluginId]);
    // The detail shown is the one read now (its manifest's tools), not only the list's item.
    expect(element.textContent).toContain("demo_list_events");
  } finally { setPluginMarketVisualScenario("normal", true); }
});
// Dispatcher S-1, the same check for the market list (mock market=readFailed): the list's Retry (it calls the market's
// refresh) reads again and the failure goes, even when the deep link was applied again before it (before the S-1 mock
// change a repeated link armed the failure again, so the Retry failed again). Tier: unit/jsdom.
it("recovers the market list with its Retry after the first read failed (mock market=readFailed)", async () => {
  const { pluginMarketVisualManagement, setPluginMarketVisualScenario, resetPluginMarketVisualComputer } = await import("@/debug/pluginMarketVisualFixture");
  resetPluginMarketVisualComputer();
  setPluginMarketVisualScenario("normal", true);
  setPluginMarketVisualScenario("readFailed", true);
  try {
    marketWire((request) => (pluginMarketVisualManagement(request.actionId, request.input, request.resourceRef?.id) as any).result);
    await openMarket();
    await settle(14);
    expect(shownMarket().status).toBe("failed");
    setPluginMarketVisualScenario("readFailed", true);
    await act(async () => { await shownMarket().refresh(); });
    await settle(14);
    expect(shownMarket().status).toBe("ready");
    expect(shownMarket().items.map((entry: any) => entry.name)).toContain("Demo Agenda");
  } finally { setPluginMarketVisualScenario("normal", true); }
});
