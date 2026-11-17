// @vitest-environment jsdom
// Unit: the real hook must not repaint model lists for unchanged countdowns,
// must expire model-specific buckets, and must suspend work when not active.
// Existing picker tests replace this hook, so they cannot cover its timers.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ProviderView } from "@cindy/model-providers/registry";

const h = vi.hoisted(() => ({
  invoke: vi.fn(),
  status: "online",
  connectionEpoch: 1,
  app: "active",
  changed: new Set<(deviceId: string) => void>(),
  listeners: new Set<(state: string) => void>(),
}));
vi.mock("react-native", () => ({
  AppState: {
    get currentState() {
      return h.app;
    },
    addEventListener: (_name: string, listener: (state: string) => void) => {
      h.listeners.add(listener);
      return { remove: () => h.listeners.delete(listener) };
    },
  },
}));
vi.mock("@/device-link/DeviceLinkContext", () => ({ useDeviceLink: () => h, subscribeRemoteSubscriptionAccountsChanged: (cb: (device: string) => void) => { h.changed.add(cb); return () => h.changed.delete(cb); } }));
import { useMobileModelQuotas } from "@/session/useMobileModelQuotas";
import {
  mobileWeeklyQuota,
  quotaCountdown,
} from "@/session/mobileModelRowPresentation";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const providers = [
  { id: "openai", connected: true, auth: { method: "oauth", native: "codex" } },
] as ProviderView[];
let root: Root;
let view: ReturnType<typeof useMobileModelQuotas>;
let renders: number;
function Probe({ sources = providers, remoteCatalogs = [], taskId }: {
  sources?: ProviderView[];
  remoteCatalogs?: { deviceId: string; providers: ProviderView[] }[];
  taskId?: string;
}) {
  view = useMobileModelQuotas('["account","host"]', true, sources, remoteCatalogs, taskId);
  renders++;
  return null;
}
const window = (reset: number) => ({
  windowMinutes: 10080,
  usedPercent: 20,
  resetsAt: reset,
});
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  h.app = "active";
  h.listeners.clear();
  h.changed.clear();
  renders = 0;
  h.invoke
    .mockReset()
    .mockResolvedValue({ providerId: "openai", configured: true, accounts: [{
      identity: "b@example.test", status: "ready", paused: false, running: 0, limit: 4,
      usage: { codex: { buckets: { codex: { secondary: window(4 * 86400) } } } },
    }] });
  root = createRoot(document.createElement("div"));
});
afterEach(() => {
  act(() => root.unmount());
  vi.useRealTimers();
});
const mount = async (sources = providers) => {
  await act(async () => root.render(createElement(Probe, { sources })));
};
const advance = async (ms: number) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};

it("keeps the same rendered snapshot while a days-long countdown is unchanged", async () => {
  await mount();
  const count = renders;
  const snapshot = view;
  await advance(10000);
  expect(renders).toBe(count);
  expect(view).toBe(snapshot);
  expect(h.invoke).toHaveBeenCalledTimes(1);
});

it("does not start quota work when no provider has a subscription", async () => {
  await mount([]);
  const count = renders;
  await advance(60000);
  expect(renders).toBe(count);
  expect(h.invoke).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it("updates and expires a model-specific countdown even while the generic quota stays stable", async () => {
  const generic = { secondary: window(4 * 86400) };
  h.invoke.mockResolvedValue({ providerId: "openai", configured: true, accounts: [{
    identity: "b@example.test", status: "ready", paused: false, running: 0, limit: 4,
    usage: { codex: { buckets: {
      codex: generic, special: { limitName: "special-model", secondary: window(2) },
    } } },
  }] });
  await mount();
  await advance(1000);
  const q = view.quotas.openai;
  const special = mobileWeeklyQuota(q.source, q.raw, view.now, "special-model");
  expect(quotaCountdown(special!.resetsAt!, view.now)).toBe("1s");
  await advance(1000);
  expect(
    mobileWeeklyQuota(q.source, q.raw, view.now, "special-model"),
  ).toBeNull();
  expect(view.quotas.openai.remaining).toBe(80);
});

it("stops clocks and polling while inactive, then refreshes on resume", async () => {
  await mount();
  act(() => {
    h.app = "inactive";
    h.listeners.forEach((fn) => fn(h.app));
  });
  const count = renders;
  await advance(60000);
  expect(renders).toBe(count);
  expect(h.invoke).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
  await act(async () => {
    h.app = "active";
    h.listeners.forEach((fn) => fn(h.app));
  });
  expect(h.invoke).toHaveBeenCalledTimes(2);
  expect(view.now).toBe(60000);
});

// Regression: the menu used account A's identity with account B's pooled quota.
// Real hook, fake transport: paused A + ready B, then pause B while menu stays open.
it("keeps candidate identity and quota together and invalidates them on account changes", async () => {
  const account = (identity: string, paused: boolean, used: number) => ({
    identity, status: "ready", paused, running: 0, limit: 4,
    usage: { claude: { sevenDay: { utilization: used } } },
  });
  let accounts = [account("a@example.test", true, 66), account("b@example.test", false, 0)];
  h.invoke.mockImplementation(async () => ({ providerId: "anthropic", configured: true, accounts }));
  await mount([{ id: "anthropic", connected: true, auth: { method: "oauth", native: "claude" } } as ProviderView]);
  expect(view.quotas.anthropic.accountIdentity).toBe("b@example.test");
  expect(view.quotas.anthropic.remaining).toBe(100);
  accounts = accounts.map(a => ({ ...a, paused: true }));
  await act(async () => { h.changed.forEach(cb => cb("host")); });
  expect(view.quotas.anthropic.accountIdentity).toBeNull();
  expect(view.quotas.anthropic.remaining).toBeUndefined();
  h.invoke.mockRejectedValue(new Error("offline"));
  await advance(30000);
  expect(view.quotas.anthropic.accountIdentity).toBeNull();
});

it("keeps a recorded task account while previewing the same provider on another computer independently", async () => {
  const account = (id: string, identity: string, paused = false) => ({ id, identity, paused,
    status: "ready", running: 0, limit: 4, usage: { codex: { buckets: { codex: { secondary: window(86400) } } } } });
  h.invoke.mockImplementation(async (deviceId: string) => ({ providerId: "openai", configured: true,
    ...(deviceId === "host" ? { boundAccountId: "pinned" } : {}),
    accounts: deviceId === "host" ? [account("pinned", "bound@example.test", true), account("new", "candidate@example.test")]
      : [account("remote", "remote@example.test")],
  }));
  await act(async () => root.render(createElement(Probe, { taskId: "existing", remoteCatalogs: [{ deviceId: "other-host", providers }] })));
  expect(view.quotas.openai.accountIdentity).toBe("bound@example.test");
  expect(view.quotaOf("other-host", "openai").accountIdentity).toBe("remote@example.test");
  expect(h.invoke).toHaveBeenCalledWith("host", "maker:subscription-accounts", [{ action: "read", providerId: "openai", taskId: "existing" }]);
  expect(h.invoke).toHaveBeenCalledWith("other-host", "maker:subscription-accounts", [{ action: "read", providerId: "openai" }]);
});

it("does not mistake an old host's missing task binding for permission to use another account", async () => {
  await act(async () => root.render(createElement(Probe, { taskId: "existing" })));
  expect(view.quotas.openai.accountIdentity).toBeNull();
  expect(view.quotas.openai.remaining).toBeUndefined();
  // Explicitly unconfigured pools still use the legacy single-account reader,
  // even on an older peer with no task binding field (same rule as Desktop).
  h.invoke.mockImplementation(async (_device: string, channel: string) => channel === "maker:subscription-accounts"
    ? { providerId: "openai", configured: false, accounts: [] }
    : { account: { planType: "pro" }, rateLimits: { secondary: window(86400) } });
  await act(async () => { for (const listener of h.changed) listener("host"); });
  expect(view.quotas.openai.accountIdentity).toBeUndefined();
  expect(view.quotas.openai.remaining).toBe(80);
});

// User report: allocation ambiguity/busy capacity must not erase known quota.
it('keeps separate pool quotas, excludes paused accounts, and expires each window', async () => {
  const account = (identity: string, used: number, paused = false) => ({ identity,
    status: 'ready', paused, running: identity === 'busy' ? 4 : 0, limit: 4,
    usage: { codex: { buckets: { codex: { secondary: { ...window(15), usedPercent: used } } } } },
  });
  h.invoke.mockResolvedValue({ providerId: 'openai', configured: true,
    accounts: [account('busy',66),account('ready',20),account('paused',1,true)] });
  await mount();
  expect(view.quotas.openai.remaining).toBeUndefined();
  expect(view.quotas.openai.members?.map(member => [member.accountIdentity, member.remaining])).toEqual([['busy',34],['ready',80]]);
  await advance(16000);
  expect(view.quotas.openai.members?.map(member => member.remaining)).toEqual([undefined, undefined]);
});

// PR #9891 review / unit: successful data must survive a transient poll error;
// prior tests only rejected after the pool was already empty.
it("retains the last successful quota after a transient pool read failure", async () => {
  await mount();
  h.invoke.mockRejectedValue(new Error("timeout"));
  await advance(30000);
  expect(view.quotas.openai.accountIdentity).toBe("b@example.test");
  expect(view.quotas.openai.remaining).toBe(80);
});

// Old-host missing channel may degrade, while a permission/transport error may not.
it.each([true, false])("uses legacy quota only for an explicitly absent pool channel (%s)", async (unsupported) => {
  h.invoke.mockImplementation(async (_device: string, channel: string) => {
    if (channel === "maker:subscription-accounts") throw new Error(unsupported
      ? "[CHANNEL_NOT_ALLOWED] channel 'maker:subscription-accounts' not allowed remotely"
      : "[FORBIDDEN] access denied");
    return { account: { planType: "pro" }, rateLimits: { secondary: window(86400) } };
  });
  await mount();
  expect(view.quotas.openai.remaining).toBe(unsupported ? 80 : undefined);
  expect(h.invoke.mock.calls.some(call => call[1] === "maker:usage:codex-rate-limits")).toBe(unsupported);
});

// The compact pool header floors hours whereas the old detail countdown rounds up.
it("updates the pool summary at the six-hour boundary without a network poll", async () => {
  h.invoke.mockResolvedValue({ providerId: 'openai', configured: true, accounts: [1,2].map(id => ({
    identity: `${id}@example.test`, status: 'ready', paused: false, running: 0, limit: 4,
    usage: { codex: { buckets: { codex: { secondary: window(6 * 3600 + 1) } } } },
  })) });
  await mount();
  await advance(1000);
  await advance(1000);
  expect(view.now).toBe(2000);
  expect(h.invoke).toHaveBeenCalledTimes(1);
});
