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
vi.mock("@/device-link/DeviceLinkContext", () => ({ useDeviceLink: () => h }));
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
function Probe({ sources = providers }: { sources?: ProviderView[] }) {
  view = useMobileModelQuotas('["account","host"]', true, sources);
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
  renders = 0;
  h.invoke
    .mockReset()
    .mockResolvedValue({
      providerId: "openai",
      rateLimits: { secondary: window(4 * 86400) },
    });
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
  h.invoke.mockResolvedValue({
    providerId: "openai",
    rateLimits: generic,
    rateLimitsByLimitId: {
      codex: generic,
      special: { limitName: "special-model", secondary: window(2) },
    },
  });
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
