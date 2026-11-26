/**
 * The plugins page under test with its leaves stubbed, shared by pluginsScreen.test.tsx,
 * pluginsScreenMarketFences.test.tsx, pluginsScreenSuccessRead.test.tsx and pluginsScreenSlot.test.tsx (split so each file stays
 * within the unit budget): the fixture, every module mock
 * (registered here, before a test file imports the page), the per-test reset, and the helpers the files use.
 * Test files import it first.
 */
import { act, createElement, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, vi } from "vitest";
import { DeviceLinkError } from "@cindy/device-link";
import PluginsScreen from "@/plugins/PluginsScreen";
import { __retainedForTests } from "@/plugins/usePluginManagement";
import { __testing as slotTesting } from "@/plugins/pluginManagementSlot";
import { createPluginPromptReads } from "@/plugins/pluginPromptReads";

const fixture = vi.hoisted(() => ({
  props: new Map<string, any>(),
  originalSettingsMounts: 0,
  appStateListeners: new Set<(state: string) => void>(),
  promptReads: null as ReturnType<typeof createPluginPromptReads> | null,
  realManagement: false,
  realConfirmation: false,
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
  /** Computers no longer in the account's list (the rest stay). */
  removedDevices: new Set<string>(),
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
  ...actual,
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
// The real sheet where a test presses its Allow (`realConfirmation`); elsewhere only what the screen hands it.
vi.mock("@/plugins/PluginManagementConfirmation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/plugins/PluginManagementConfirmation")>();
  return { PluginManagementConfirmation: (p: any) => {
    fixture.props.set("confirmation", p);
    // Like the real sheet: a consent shown while active is marked as seen (only that one may be cancelled by leaving).
    const requestId = p.state?.receipt?.consent?.requestId;
    useEffect(() => { if (!fixture.realConfirmation && p.active && p.state?.outcome === "confirmation" && requestId) p.controller?.markConsentShown?.(requestId); });
    return fixture.realConfirmation ? createElement(actual.PluginManagementConfirmation, p) : null;
  } };
});
// The app's two-mode prompt, as its iOS path shows it: the system alert (the same buttons showConfirm passes).
vi.mock("@/session/useSharedTaskConfirmation", () => ({ useSharedTaskConfirmation: () => ({ dialog: null,
  confirm: (request: any) => new Promise((resolve) => fixture.alert(request.title, request.message, request.cancelLabel !== undefined
    ? [{ style: "cancel", text: request.cancelLabel, onPress: () => resolve(false) },
      { style: request.destructive ? "destructive" : "default", text: request.confirmLabel, onPress: () => { request.onConfirm?.(); resolve(true); } }]
    : [{ text: request.confirmLabel, onPress: () => { request.onConfirm?.(); resolve(true); } }])) }) }));
/** A notice as the real component shows it: its title and its action buttons (tests press them by test id). */
export function noticeElement(p: any) {
  fixture.props.set(p.testID ?? "notice", p);
  return createElement("span", { "data-testid": p.testID }, p.title, ...(p.actions ?? []).map((action: any) =>
    createElement("button", { key: action.label, onClick: action.onPress, disabled: action.disabled, "data-testid": action.testID }, action.label)));
}
vi.mock("@/plugins/PluginNotice", () => ({ PluginNotice: (p: any) => noticeElement(p) }));
vi.mock("react-native", async () => {
  const React = await import("react");
  const view = ({ children, testID }: any) =>
    React.createElement("div", { "data-testid": testID }, children);
  // The confirmation sheet's measured views report one layout when they mount, as on a device: a list tall enough for
  // the whole identity block, the buttons, and (AppText below) the summary's heading and items. Its Allow answers only
  // once every size has arrived (pluginNativeViews covers the cases before that).
  const LAID_OUT: Record<string, number> = { "plugins.management.list": 2000, "plugins.management.identity": 100, "plugins.management.actions": 44 };
  const laidOutView = (p: any) => {
    React.useEffect(() => {
      if (p.testID in LAID_OUT) p.onLayout?.({ nativeEvent: { layout: { height: LAID_OUT[p.testID] } } });
    }, []);
    return view(p);
  };
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
      // A selection row's state, as the selection rows say it (`accessibilityState.selected`).
      const selected = p.accessibilityState && "selected" in p.accessibilityState ? String(!!p.accessibilityState.selected) : undefined;
      return React.createElement("button", { onClick: p.onPress, disabled: p.disabled, "data-testid": p.testID, "aria-pressed": selected }, p.children);
    },
    RefreshControl: view,
    ScrollView: laidOutView,
    View: laidOutView,
    Platform: {
      get OS() {
        return fixture.platform;
      },
    },
    StyleSheet: { create: (s: any) => s, hairlineWidth: 1 },
    useWindowDimensions: () => ({ width: fixture.width, height: 800 }),
  };
});
vi.mock("react-native-safe-area-context", async () => ({
  SafeAreaView: ({ children }: any) => createElement("div", null, children),
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
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
      "Check",
      "Search",
      "Plus",
      "Wrench",
      "CircleAlert",
      "WifiOff",
    ].map((key) => [key, () => null]),
  ),
);
vi.mock("@/components/AppText", () => ({
  // Measured text (the confirmation sheet's summary heading and items) reports one layout when it mounts.
  Text: ({ children, onLayout }: any) => {
    useEffect(() => { onLayout?.({ nativeEvent: { layout: { height: 20 } } }); }, []);
    return createElement("span", null, children);
  },
  TextInput: () => null,
  MAX_FONT_SIZE_MULTIPLIER: 1.2,
}));
vi.mock("@/auth/AuthContext", () => ({
  useAuth: () => ({ accountGeneration: fixture.accountGeneration, apiFetch: vi.fn() }),
}));
vi.mock("@/auth/authOwnerGeneration", () => ({
  subscribeMobileAuthOwner: () => () => {},
  getMobileAuthOwner: () => ({ accountKey: "demo" }),
  isMobileAuthOwnerCurrent: () => fixture.owner,
}));
export function resourceListener(listener: (device: string, payload: any) => void) {
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
          ].filter((device) => !fixture.removedDevices.has(device.deviceId)),
    refresh: () => fixture.devicesRefresh(),
  }),
}));
/** The revision the computer gives an installed row and its detail: `[version, approval token]` (desktop mobilePageService). */
export const INSTALLED_REVISION = JSON.stringify(["1", "approved:12345678-1234-4123-8123-123456789abc"]);
export const row = () => ({
  key: "mac:plugin",
  host: { deviceId: "mac", deviceName: "Mac" },
  item: {
    ref: { collectionId: "plugins", kind: "plugin", id: "demo" },
    revision: INSTALLED_REVISION,
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
// iOS draws the page's notice as the first row of these native lists (`pageNotice`): rendered here the same way.
vi.mock("@/plugins/PluginDirectoryView", () => ({
  PluginDirectoryView: (p: any) => {
    fixture.props.set("directory", p);
    return p.pageNotice ? noticeElement(p.pageNotice) : null;
  },
}));
vi.mock("@/plugins/PluginDetailView", () => ({
  PluginDetailView: (p: any) => {
    fixture.props.set("detail", p);
    return createElement("div", null, p.pageNotice ? noticeElement(p.pageNotice) : null, p.settingsContent);
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
// The Android sheets (market choice, computer picker, list of checks): content without native presentation, drawn only
// while visible like the native modal; each keeps its props under its surface's testID ("sheet:<testID>").
vi.mock("@/session/SheetModal", () => ({
  SheetModal: (p: any) => {
    fixture.props.set("sheet:" + (p.children?.props?.testID ?? ""), p);
    return p.visible === false ? null : p.children;
  },
}));
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
export let root: ReturnType<typeof createRoot>;
export let element: HTMLDivElement;
beforeEach(() => {
  // The page slot and retained controllers live per account in modules; every test starts with none.
  slotTesting.reset();
  __retainedForTests?.clear();
  fixture.props.clear();
  fixture.originalSettingsMounts = 0;
  fixture.realManagement = false;
  fixture.realConfirmation = false;
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
  fixture.removedDevices.clear();
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
  // As the computer's installed detail answers: the row with its revision `[version, approval token]` (desktop
  // mobilePageService); the token is the one of every installed instance in these fixtures.
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
export async function openDetail() {
  await act(async () => root.render(createElement(PluginsScreen)));
  await act(async () => fixture.props.get("directory").onDetail(row()));
}
/**
 * The transport stand-in follows the production order (DeviceLinkContext.invoke → sendInvoke → client.invoke; see
 * plugin-mobile-implementation.md and the contract test in historyViewProvider.test.tsx): `preSend` runs at entry,
 * the request may then wait (queue, reconnect), and `preSend` runs again right before the first socket write, where
 * `onRequestWritten` runs. A reply that never comes after the write is a transport timeout marked `inFlight`.
 */
export async function transportSend<T>(options: any, write: () => T | Promise<T>, queue?: () => Promise<void> | undefined): Promise<T> {
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
export type MarketWireRequest = { device: string; actionId?: string; input?: any; resourceRef?: any };
export function marketWire(respond: (request: MarketWireRequest) => unknown) {
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
export const marketItem = (ghostId: string, name: string) => ({
  pluginId: `market/${ghostId}`, ghostId, namespace: null, name, description: "Demo", author: "Cindy", publisherKind: "official",
  scope: "public", organizationId: null, defaultInstall: false, releaseId: `${ghostId}@1`, version: "1", publishedAt: "",
  icon: null, installState: "not-installed", enabled: null, sourceType: "server", sourceMarketName: null,
});
// An official-market consent for the demo plugin; tests that lose a result after approving answer it first.
export const demoConsent = (request: MarketWireRequest) => ({ operationId: request.input.operationId, phase: "confirmation", consent: {
  requestId: "consent", initiator: "user", origin: "market", facts: { kind: "install", ghostId: "demo", name: "Demo", version: "1", permissions: [] } } });
/** Allow from the phone (the Host then loses the reply in these tests). */
export async function approveOnPhone() {
  await act(async () => { await fixture.props.get("confirmation").controller.answer(true); });
  await settle(14);
}
export const marketPage = (items: any[]) => ({ items, unavailableReason: null, customSourceNames: [], unavailableCustomSourceNames: [],
  nextCursor: null, counts: null });
export async function settle(rounds = 10) {
  for (let index = 0; index < rounds; index++) await act(async () => { await Promise.resolve(); });
}
export async function openMarket() {
  await act(async () => root.render(createElement(PluginsScreen)));
  await act(async () => fixture.props.get("directory").onSegmentChange("market"));
  await settle();
}
export const shownMarket = () => fixture.props.get("directory").market;
export const hostError = (code: string) => new Error(`[${code}] Plugin management request is no longer available`);
export const demoGhost = { instanceKey: "_root__demo", namespace: null, manifest: { schemaVersion: 3, id: "demo", name: "Demo", version: "1" },
  enabled: true, approval: { state: "approved", revision: "12345678-1234-4123-8123-123456789abc" } };
/**
 * What a computer adds to its record of an installed plugin for this phone (contract V2.10, hostPluginInstallFacts.ts):
 * this phone's operation (`'self'` with its id), anyone else's install (`'unattributed'`), or, from an older computer,
 * nothing. Nothing either for a plugin that is not installed.
 */
export function attributed(installed: boolean, own?: string, olderHost = false) {
  if (!installed || olderHost) return {};
  return own ? { installedOperationId: own, installedOperationAttribution: "self" } : { installedOperationAttribution: "unattributed" };
}
/**
 * The computer's installed snapshot as it answers this phone (dispatcher R-3): once this phone's install of Demo is there,
 * the snapshot's market records include Demo's, with this phone's operation id (contract V2.9; see
 * hostPluginInstallFacts.ts). `record` replaces that record (another situation's shape).
 */
export const managementSnapshot = (installed: boolean, record?: unknown) => ({ version: 1, ghosts: installed ? [demoGhost] : [],
  market: { items: installed ? [record ?? { ...marketItem("demo", "Demo"), installState: "installed", installedOperationId: "screen-operation", installedOperationAttribution: "self" }] : [],
    unavailableReason: null, customSourceNames: [], unavailableCustomSourceNames: [] } });
export { fixture };
// Shared by pluginsScreen.test.tsx and pluginsScreenSlot.test.tsx (moved here unchanged).
export function managedScreen() {
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

// Production screen → hook → controller → client. Transport and visual leaves remain isolated.
export function realManagementHost() {
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
