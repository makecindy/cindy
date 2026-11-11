import { afterEach, expect, it, vi } from "vitest";
import { receivePluginOauthLoopback } from "../plugins/pluginOauthLoopback";
const state = "provider_state_123456789";
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; }
function harness(platform = "ios") {
  const received = deferred<unknown>(), browser = deferred<{ type: string }>();
  let appState!: (state: string) => void;
  const native = { start: vi.fn(async () => {}), wait: vi.fn(() => received.promise), status: vi.fn(async () => "waiting"), close: vi.fn(async () => {}) };
  const input = { native, id: "test-listener-identifier", platform, request: { url: "https://accounts.example.com/authorize", callbackUrl: "http://127.0.0.1:57123/callback", state }, expiresAt: Date.now() + 60000,
    assertCurrent: vi.fn(), openBrowser: vi.fn(() => browser.promise), dismissBrowser: vi.fn(async () => {}), onAppState: (fn: typeof appState) => { appState = fn; return vi.fn(); } };
  return { input, native, received, browser, appState: (value: string) => appState(value) };
}
afterEach(() => vi.useRealTimers());
it("binds before browser presentation and receives without waiting for iOS Done; provider state need not be bridge state", async () => {
  const h = harness(); const result = receivePluginOauthLoopback(h.input);
  await vi.waitFor(() => expect(h.input.openBrowser).toHaveBeenCalled());
  expect(h.native.start.mock.invocationCallOrder[0]).toBeLessThan(h.input.openBrowser.mock.invocationCallOrder[0]);
  h.appState("background"); h.appState("active");
  h.received.resolve({ state, code: "fake-code" });
  await expect(result).resolves.toEqual({ state, code: "fake-code" });
  expect(h.native.close).toHaveBeenCalled(); expect(h.input.dismissBrowser).toHaveBeenCalledOnce();
});
it("does not mistake Android opened or a foreground callback race for completion/cancellation", async () => {
  const h = harness("android"); const result = receivePluginOauthLoopback(h.input);
  await vi.waitFor(() => expect(h.input.openBrowser).toHaveBeenCalled());
  h.browser.resolve({ type: "opened" }); h.appState("background"); h.appState("active");
  h.native.status.mockResolvedValue("received");
  h.received.resolve({ state, error: "access_denied" });
  await expect(result).resolves.toEqual({ state, error: "access_denied" });
});
it("keeps an already received iOS callback when Done resolves concurrently", async () => {
  const h = harness(); const result = receivePluginOauthLoopback(h.input);
  await vi.waitFor(() => expect(h.input.openBrowser).toHaveBeenCalled());
  h.native.status.mockResolvedValue("received"); h.browser.resolve({ type: "cancel" });
  h.received.resolve({ state, code: "fake-code" });
  await expect(result).resolves.toMatchObject({ code: "fake-code" });
});
it("closes a late bind after owner cancellation and never opens the browser", async () => {
  const h = harness(); const ready = deferred<void>(); h.native.start.mockReturnValue(ready.promise);
  const abort = new AbortController(); const result = receivePluginOauthLoopback({ ...h.input, signal: abort.signal });
  const rejected = expect(result).rejects.toThrow("PLUGIN_OAUTH_CLOSED"); abort.abort(); await rejected;
  ready.resolve(); await Promise.resolve();
  expect(h.native.close.mock.calls.length).toBeGreaterThanOrEqual(2); expect(h.input.openBrowser).not.toHaveBeenCalled();
});
it("cleans up on owner changes while awaiting the callback", async () => {
  const h = harness(); const result = receivePluginOauthLoopback(h.input);
  await vi.waitFor(() => expect(h.input.openBrowser).toHaveBeenCalled());
  const rejected = expect(result).rejects.toThrow("PLUGIN_OAUTH_CLOSED");
  h.input.assertCurrent.mockImplementation(() => { throw new Error("owner changed"); });
  await rejected; expect(h.native.close).toHaveBeenCalled();
});
it("requires the updated module and refuses unsupported callbacks before opening a browser", async () => {
  const h = harness();
  await expect(receivePluginOauthLoopback({ ...h.input, native: null })).rejects.toThrow("PLUGIN_OAUTH_UPDATE_REQUIRED");
  await expect(receivePluginOauthLoopback({ ...h.input, request: { ...h.input.request, callbackUrl: "http://localhost:57123/callback" } })).rejects.toThrow("PLUGIN_OAUTH_CALLBACK_UNSUPPORTED");
  expect(h.input.openBrowser).not.toHaveBeenCalled();
});
