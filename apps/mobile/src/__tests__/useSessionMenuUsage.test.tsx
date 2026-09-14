// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  useSessionMenuUsage,
  type SessionMenuUsageReader,
} from "@/session/useSessionMenuUsage";
import type { RemoteSession } from "@/session/types";
import type { MobileCodexRateLimitsResult } from "@cindy/maker-shared/device-link-contract";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined;
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  vi.useRealTimers();
});
const account: MobileCodexRateLimitsResult = {
  account: { email: null, accountId: null, planType: "pro" },
  rateLimits: { primary: { usedPercent: 25, windowMinutes: 300 } },
  rateLimitsByLimitId: null,
  rateLimitResetCredits: null,
  resetOffer: null,
};
const session = (id: string): RemoteSession =>
  ({
    id,
    model: "gpt-5",
    providerId: "openai",
    agentKind: "codex",
    deviceLinkDeviceId: "host",
  }) as RemoteSession;
function reader(): SessionMenuUsageReader {
  return {
    getCodexRateLimits: vi.fn(async () => account),
    getAccountUsage: vi.fn(async () => {
      throw new Error("unavailable");
    }),
    getSessionEstimatedValue: vi.fn(async () => ({
      totalValueMoney: {
        amount: 12,
        currency: "USD",
        approximate: true,
        kind: "value-estimate",
      },
    })),
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { resolve, promise };
}
function harness(r: SessionMenuUsageReader) {
  let value!: ReturnType<typeof useSessionMenuUsage>;
  function Probe({
    task,
    visible,
    snapshot,
  }: {
    task: RemoteSession;
    visible: boolean;
    snapshot: MobileCodexRateLimitsResult | null;
  }) {
    value = useSessionMenuUsage(task, r, visible, snapshot);
    return null;
  }
  root = createRoot(document.createElement("div"));
  return {
    get value() {
      return value;
    },
    render: async (
      task = session("a"),
      visible = true,
      snapshot: MobileCodexRateLimitsResult | null = null,
    ) => {
      await act(async () =>
        root!.render(createElement(Probe, { task, visible, snapshot })),
      );
    },
  };
}

describe("menu usage refresh lifecycle", () => {
  it("reads on opening the primary sheet, polls only while visible, and retains values on reopening", async () => {
    vi.useFakeTimers();
    const r = reader();
    const h = harness(r);
    await h.render(session("a"), false);
    expect(r.getCodexRateLimits).not.toHaveBeenCalled();
    await h.render();
    expect(h.value.estimate?.amount).toBe(12);
    expect(r.getCodexRateLimits).toHaveBeenCalledOnce();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(r.getCodexRateLimits).toHaveBeenCalledTimes(2);
    await h.render(session("a"), false);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(r.getCodexRateLimits).toHaveBeenCalledTimes(2);
    await h.render();
    expect(h.value.account?.plan).toBe("pro");
  });
  it("refreshes on the reset snapshot and rejects a late pre-reset response", async () => {
    const r = reader();
    const h = harness(r);
    const exhausted = {
      ...account,
      rateLimits: { primary: { usedPercent: 100 } },
    };
    const reset = { ...account, rateLimits: { primary: { usedPercent: 0 } } };
    vi.mocked(r.getCodexRateLimits).mockResolvedValue(exhausted);
    await h.render(session("a"), true, exhausted);
    expect(h.value.account?.windows[0].remainingPercent).toBe(0);
    const pending = deferred<MobileCodexRateLimitsResult>();
    vi.mocked(r.getCodexRateLimits).mockReturnValueOnce(pending.promise);
    await act(async () => h.value.refresh());
    vi.mocked(r.getCodexRateLimits).mockResolvedValue(reset);
    await h.render(session("a"), true, reset);
    expect(h.value.account?.windows[0].remainingPercent).toBe(100);
    await act(async () => pending.resolve(exhausted));
    expect(h.value.account?.windows[0].remainingPercent).toBe(100);
    await h.render(session("a"), true, reset);
    expect(r.getCodexRateLimits).toHaveBeenCalledTimes(3);
  });
  it("defers control snapshot refresh while hidden and discards results after closing", async () => {
    const r = reader();
    const h = harness(r);
    await h.render(session("a"), false, account);
    expect(r.getCodexRateLimits).not.toHaveBeenCalled();
    const pending = deferred<MobileCodexRateLimitsResult>();
    vi.mocked(r.getCodexRateLimits).mockReturnValueOnce(pending.promise);
    await h.render(session("a"), true, account);
    await h.render(session("a"), false, { ...account });
    await act(async () => pending.resolve(account));
    expect(h.value.account).toBeNull();
    expect(r.getCodexRateLimits).toHaveBeenCalledTimes(1);
    await h.render(session("a"), true, account);
    expect(h.value.account?.plan).toBe("pro");
    expect(r.getCodexRateLimits).toHaveBeenCalledTimes(2);
  });
  it("drops late responses from the previous task and does not show its values in the next task", async () => {
    const pending = deferred<MobileCodexRateLimitsResult>();
    const r = reader();
    vi.mocked(r.getCodexRateLimits).mockImplementationOnce(
      () => pending.promise,
    );
    const h = harness(r);
    await h.render();
    await h.render(session("b"));
    await act(async () =>
      pending.resolve({
        ...account,
        account: { ...account.account, planType: "old-account" },
      }),
    );
    expect(h.value.account?.plan).toBe("pro");
  });
  it("clears account data when the same task switches provider and rejects its old in-flight result", async () => {
    const pending = deferred<MobileCodexRateLimitsResult>();
    const r = reader();
    const h = harness(r);
    await h.render();
    vi.mocked(r.getCodexRateLimits).mockReturnValueOnce(pending.promise);
    await act(async () => h.value.refresh());
    await h.render({ ...session("a"), providerId: "custom" });
    expect(h.value.account?.source).toBe("api");
    await h.render({ ...session("a"), providerId: "xai" });
    await act(async () =>
      pending.resolve({
        ...account,
        account: { ...account.account, planType: "wrong-provider" },
      }),
    );
    expect(h.value.account?.source).toBe("unavailable");
    expect(h.value.account?.windows).toEqual([]);
  });
  it("does not reuse web quota across an unresolved source and a Gateway switch", async () => {
    const r = reader();
    const pending = deferred<unknown>();
    vi.mocked(r.getAccountUsage).mockReturnValueOnce(pending.promise);
    const h = harness(r);
    const task = {
      ...session("a"),
      agentKind: "pi" as const,
      model: "chatgpt/gpt-5",
    };
    await h.render(task);
    await h.render({ ...task, providerId: null });
    expect(h.value.account?.source).toBe("unavailable");
    expect(r.getAccountUsage).toHaveBeenCalledTimes(1);
    vi.mocked(r.getAccountUsage).mockResolvedValue({
      spend: 12,
      maxBudget: 100,
      currency: "CNY",
    });
    await h.render({ ...task, providerId: "xd" });
    await act(async () =>
      pending.resolve({ webSnapshot: { primary: { usedPercent: 20 } } }),
    );
    expect(h.value.account?.source).toBe("gateway");
    expect(h.value.account?.windows).toEqual([]);
    await h.render({ ...task, providerId: null });
    expect(h.value.account?.source).toBe("unavailable");
    expect(h.value.account?.amounts).toEqual([]);
    expect(r.getAccountUsage).toHaveBeenCalledTimes(2);
  });
  it("preserves the last successful values with failure metadata when disconnected", async () => {
    const r = reader();
    const h = harness(r);
    await h.render();
    vi.mocked(r.getCodexRateLimits).mockRejectedValue(
      new Error("DEVICE_OFFLINE"),
    );
    vi.mocked(r.getSessionEstimatedValue).mockRejectedValue(
      new Error("DEVICE_OFFLINE"),
    );
    await act(async () => h.value.refresh());
    expect(h.value.account?.plan).toBe("pro");
    expect(h.value.estimate?.amount).toBe(12);
    expect(h.value.accountFailed).toBe(true);
    expect(h.value.estimateFailed).toBe(true);
    expect(h.value.loading).toBe(false);
  });
  it("allows task value to load even when both existing quota reads fail", async () => {
    const r = reader();
    vi.mocked(r.getCodexRateLimits).mockRejectedValue(
      new Error("CHANNEL_NOT_ALLOWED"),
    );
    const h = harness(r);
    await h.render();
    expect(h.value.account).toBeNull();
    expect(h.value.accountFailed).toBe(true);
    expect(h.value.estimate?.amount).toBe(12);
    expect(h.value.loading).toBe(false);
  });
});
