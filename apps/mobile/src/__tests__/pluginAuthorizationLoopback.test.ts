import { afterEach, expect, it, vi } from "vitest";
import { runMobilePluginAuthorization } from "../plugins/pluginAuthorizationController";
const h = vi.hoisted(() => ({ offer: {} as any, sealed: [] as any[] }));
vi.mock("../plugins/pluginOauthCrypto", () => ({ MobileOauthBox: class {
  publicKey = "a".repeat(59);
  async open() { return h.offer; }
  async seal(_peer: string, _id: string, _purpose: string, value: unknown) { h.sealed.push(value); return "a".repeat(60); }
  dispose() {}
} }));
const bridgeState = "b".repeat(43), providerState = "provider-state-123456789";
const url = (state: string) => "https://accounts.example.com/authorize?" + new URLSearchParams({ state, redirect_uri: "http://127.0.0.1:57123/callback", response_type: "code", client_id: "synthetic-client", code_challenge: "c".repeat(43), code_challenge_method: "S256" });
function harness(typed: boolean) {
  const state = typed ? providerState : bridgeState;
  h.offer = typed ? { kind: "authorization", state: bridgeState, request: { kind: "loopback", url: url(state), callbackUrl: "http://127.0.0.1:57123/callback", state } } : { authorizeUrl: url(state), callbackUrl: "http://127.0.0.1:57123/callback", state, corsHosts: [], corsOrigins: [] };
  let delivered = false, foreground = true;
  const invoke = vi.fn(async (request: any): Promise<any> => {
    if (request.op === "capabilities") return { version: 1, encrypted: true, callback: "desktop-loopback", authorizationV1: true };
    if (request.op === "start") return { id: "transaction123456", publicKey: "a".repeat(59) };
    if (request.op === "status") { expect(foreground).toBe(true); return delivered ? { phase: "succeeded" } : { phase: "authorizing", offer: "sealed" }; }
    if (request.op === "callback") { expect(foreground).toBe(true); delivered = true; return { accepted: true }; }
    return {};
  });
  const receiveLoopback = vi.fn(async (_request: any, _expiresAt: number, _signal: AbortSignal) => ({ state, code: "synthetic-code" }));
  const deps = { action: {} as any, crypto: {} as any, kind: "oauth" as const, invoke, assertCurrent: vi.fn(), clearInput: vi.fn(), pause: async () => {}, isForeground: () => foreground, showAuthorization: vi.fn(), receiveLoopback };
  return { deps, invoke, receiveLoopback, foreground(value: boolean) { foreground = value; } };
}
afterEach(() => { h.sealed = []; vi.useRealTimers(); });
it.each([true, false])("seals the correct bridge callback and waits for Host success (typed=%s)", async (typed) => {
  const test = harness(typed);
  await runMobilePluginAuthorization(test.deps);
  expect(h.sealed).toEqual([{ state: bridgeState, code: "synthetic-code" }]);
  expect(test.receiveLoopback.mock.calls[0][0]).toMatchObject({ state: typed ? providerState : bridgeState });
  expect(test.invoke.mock.calls.some(([request]) => request.op === "cancel")).toBe(false);
});
it("does not poll or submit while Android CustomTabs is background, then submits on foreground", async () => {
  vi.useFakeTimers();
  const test = harness(false);
  test.receiveLoopback.mockImplementation(async () => {
    test.foreground(false);
    setTimeout(() => test.foreground(true), 750);
    return { state: bridgeState, code: "synthetic-code" };
  });
  const authorization = runMobilePluginAuthorization(test.deps);
  await vi.advanceTimersByTimeAsync(500);
  expect(h.sealed).toEqual([]);
  expect(test.invoke.mock.calls.some(([request]) => request.op === "callback")).toBe(false);
  await vi.advanceTimersByTimeAsync(500);
  await authorization;
  expect(h.sealed).toEqual([{ state: bridgeState, code: "synthetic-code" }]);
});
it("never claims success when the Host rejects the sealed callback", async () => {
  const test = harness(false);
  const invoke = test.deps.invoke;
  test.deps.invoke = vi.fn(async (request: any) => request.op === "callback" ? { accepted: false } : invoke(request));
  await expect(runMobilePluginAuthorization(test.deps)).rejects.toThrow("OAUTH_BRIDGE_UNAVAILABLE");
  expect(test.invoke.mock.calls.some(([request]) => request.op === "cancel")).toBe(true);
});
