// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { Alert } from "react-native";
import * as WebBrowser from "expo-web-browser";
import { PluginOriginalSettings } from "../plugins/PluginOriginalSettings";

// Card callbacks exercise the original settings boundary without a native WebView or credentials.
const state = vi.hoisted(() => ({ card: {} as any, notice: undefined as any, owner: true, authorize: vi.fn() }));
vi.mock("react-native", async () => {
  const React = await import("react");
  return {
    View: (p: any) => React.createElement("div", { style: p.style, "data-testid": p.testID, "aria-hidden": p.accessibilityElementsHidden }, p.children),
    ActivityIndicator: (p: any) => React.createElement("div", { "data-testid": p.testID, role: "progressbar" }),
    Alert: { alert: vi.fn() }, AppState: { currentState: "active" },
  };
});
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@/theme", () => ({ spacing: { md: 12 }, useTheme: () => ({ colors: {} }) }));
vi.mock("@/auth/AuthContext", () => ({ useAuth: () => ({ deviceId: "phone", accountGeneration: 1 }) }));
vi.mock("@/auth/authOwnerGeneration", () => ({ getMobileAuthOwner: () => "owner", isMobileAuthOwnerCurrent: () => state.owner }));
vi.mock("@/device-link/DeviceLinkContext", () => ({ useDeviceLink: () => ({ connectionEpoch: 1, invoke: vi.fn() }) }));
vi.mock("expo-web-browser", () => ({ openBrowserAsync: vi.fn() }));
vi.mock("../plugins/PluginDirectoryPicker", () => ({ PluginDirectoryPicker: () => null }));
vi.mock("../plugins/PluginSettingsCard", () => ({ PluginSettingsCard: (p: any) => { state.card = p; return null; } }));
vi.mock("../plugins/PluginNotice", () => ({ PluginNotice: (p: any) => { state.notice = p; return p.title; } }));
vi.mock("../plugins/pluginOauthSession", () => ({ openMobilePluginOauthSession: async () => ({ request: vi.fn(), dispose: vi.fn() }) }));
vi.mock("../plugins/pluginAuthorizationController", () => ({ runMobilePluginAuthorization: (...args: any[]) => state.authorize(...args) }));
vi.mock("../plugins/pluginOauthLoopbackNative", () => ({ receiveMobilePluginOauthLoopback: vi.fn() }));
vi.mock("../plugins/pluginOauthPlatformCrypto", () => ({ pluginOauthPlatformCrypto: {} }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: ReturnType<typeof createRoot>;
afterEach(() => { act(() => root?.unmount()); state.notice = undefined; state.owner = true; vi.clearAllMocks(); });
const identity = { deviceId: "mac", instanceId: "plugin", expectedInstalledApproval: "approval" } as any;
function mount() {
  const element = document.createElement("div");
  root = createRoot(element);
  const onNotice = vi.fn();
  const render = (active: boolean, target = identity) => act(() => root.render(createElement(PluginOriginalSettings, { identity: target, active, onNotice })));
  render(true);
  return { onNotice, render, element };
}
it("shows a specific bridge-only authorization failure once, then accepts a new error", async () => {
  const { onNotice } = mount();
  const error = new Error("PLUGIN_AUTHORIZATION_COMPUTER_CALLBACK");
  state.authorize.mockRejectedValueOnce(error);
  await act(async () => { await expect(state.card.onAuthorize({})).rejects.toBe(error); });
  expect(state.notice).toBeUndefined();
  act(() => state.card.onError(new Error(error.message), "operation"));
  expect(state.notice.detail).toBe("plugins.computerAuthorizationHint");
  expect(state.notice.title).toBe("plugins.notice.title.authorization");
  act(() => state.card.onError(new Error(error.message), "operation"));
  expect(state.notice.title).toBe("plugins.notice.title.writeFailed");
  expect(onNotice).not.toHaveBeenCalled();
});
it("keeps read and unknown results local and rejects stale inactive or replacement-target callbacks", () => {
  const { render, onNotice } = mount();
  act(() => state.card.onError(new Error("read"), "read"));
  expect(state.notice.title).toBe("plugins.notice.title.readFailed");
  act(() => state.card.onError(new Error("unknown"), "unknown"));
  expect(state.notice.title).toBe("plugins.notice.title.resultUnknown");
  const stale = state.card;
  render(false);
  act(() => { stale.onNotice("late"); stale.onError(new Error("late"), "operation"); });
  expect(state.notice.title).toBe("plugins.notice.title.resultUnknown");
  render(true, { ...identity, instanceId: "other" });
  act(() => stale.onNotice("wrong target"));
  expect(onNotice).not.toHaveBeenCalled();
});


it("lets the original form handle replied command failures without a duplicate native error", () => {
  mount();
  for (const context of ["read", "operation", "unknown"]) act(() => state.card.onError(new Error("PLUGIN_SETTINGS_UNAVAILABLE"), context, true));
  expect(state.notice).toBeUndefined();
  act(() => state.card.onError(new Error("PLUGIN_SETTINGS_DOWNLOAD_BLOCKED"), "operation"));
  expect(state.notice.title).toBe("plugins.notice.title.writeFailed");
  expect(state.notice.compact).toBe(true);
});


it.each(["OAUTH_BRIDGE_UNAVAILABLE", "PLUGIN_SETTINGS_AUTHORIZATION_CANCELLED", "PLUGIN_OAUTH_UPDATE_REQUIRED"])("delegates replied authorization failure %s to the page except required native upgrade", async (code) => {
  mount();
  state.authorize.mockRejectedValueOnce(new Error(code));
  await act(async () => { await expect(state.card.onAuthorize({})).rejects.toThrow(code); });
  expect(state.notice).toBeUndefined();
  act(() => state.card.onError(new Error(code), "operation", true));
  if (code === "PLUGIN_OAUTH_UPDATE_REQUIRED") expect(state.notice.detail).toBe("plugins.oauthUpdateRequired");
  else expect(state.notice).toBeUndefined();
});

it("does not retain a native error for a cancelled authorization even without a page reply", async () => {
  mount();
  const code = "PLUGIN_SETTINGS_AUTHORIZATION_CANCELLED";
  state.authorize.mockRejectedValueOnce(new Error(code));
  await act(async () => { await expect(state.card.onAuthorize({})).rejects.toThrow(code); });
  act(() => state.card.onError(new Error(code), "operation", false));
  expect(state.notice).toBeUndefined();
});

it.each(["accept", "cancel", "stale"])("opens external links on this phone only after current-page confirmation (%s)", async (decision) => {
  const { render } = mount();
  const check = vi.fn();
  let work!: Promise<void>;
  await act(async () => { work = state.card.onOpenLink("https://example.com/console#keys", check); });
  expect(WebBrowser.openBrowserAsync).not.toHaveBeenCalled();
  const buttons = vi.mocked(Alert.alert).mock.calls.at(-1)![2]!;
  if (decision === "stale") render(false);
  await act(async () => {
    buttons[decision === "cancel" ? 0 : 1].onPress!();
    if (decision === "stale") await expect(work).rejects.toThrow("CLOSED");
    else await work;
  });
  if (decision === "accept") expect(WebBrowser.openBrowserAsync).toHaveBeenCalledExactlyOnceWith("https://example.com/console#keys", { showTitle: true });
  else expect(WebBrowser.openBrowserAsync).not.toHaveBeenCalled();
});
it.each(["javascript:alert(1)", "file:///tmp/x", "https://user:password@example.com", "https://example.com/\npath"])("refuses unsupported external navigation %s", async (url) => {
  mount();
  await expect(state.card.onOpenLink(url, () => {})).rejects.toThrow();
  expect(Alert.alert).not.toHaveBeenCalled();
  expect(WebBrowser.openBrowserAsync).not.toHaveBeenCalled();
});
it("explains target-local links without opening a phone-local service", async () => {
  const { onNotice } = mount();
  await state.card.onOpenLink("http://127.0.0.1:3923/console", () => {});
  expect(onNotice).toHaveBeenCalledWith("plugins.settingsComputerLink");
  expect(WebBrowser.openBrowserAsync).not.toHaveBeenCalled();
});
it("identifies the computer that needs the settings authorization update even after a page reply", () => {
  mount();
  act(() => state.card.onError(new Error("PLUGIN_SETTINGS_HOST_UPDATE_REQUIRED"), "operation", true));
  expect(state.notice.detail).toBe("plugins.settingsHostUpdateRequired");
});

// User-reported blank interval: the real wrapper must keep a visible progress
// indicator and disable the unpainted form until the card reports document readiness.
// Existing callback tests did not inspect this presentation. Tier: unit, fake WebView only.
it("shows progress in the configuration area until the page is ready, and on reload", () => {
  const { element } = mount();
  expect(element.querySelector('[role="progressbar"]')).not.toBeNull();
  expect(element.querySelector('[aria-hidden="true"]')?.getAttribute("style")).toContain("opacity: 0");
  act(() => state.card.onLoading(false));
  expect(element.querySelector('[role="progressbar"]')).toBeNull();
  expect(element.querySelector('[aria-hidden="true"]')).toBeNull();
  act(() => state.card.onLoading(true));
  expect(element.querySelectorAll('[role="progressbar"]')).toHaveLength(1);
});
