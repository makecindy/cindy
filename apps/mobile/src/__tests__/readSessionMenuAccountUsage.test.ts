import { describe, expect, it, vi } from "vitest";
import type { MobileCodexRateLimitsResult } from "@cindy/maker-shared/device-link-contract";
import { readSessionMenuAccountUsage } from "@/session/readSessionMenuAccountUsage";
import type { RemoteSession } from "@/session/types";

const session = {
  id: "s1",
  agentKind: "codex",
  providerId: "openai",
  model: "gpt-6-astra",
} as RemoteSession;
const quota = (): MobileCodexRateLimitsResult => ({
  account: {
    email: "private@example.test",
    accountId: "private-id",
    planType: "pro",
  },
  rateLimits: { primary: { usedPercent: 25, windowMinutes: 300 } },
  rateLimitsByLimitId: null,
  rateLimitResetCredits: null,
  resetOffer: null,
});
const reader = () => ({
  getCodexRateLimits: vi.fn(async () => quota()),
  getAccountUsage: vi.fn<() => Promise<unknown>>().mockResolvedValue({
    primary: { usedPercent: 40, windowMinutes: 300 },
    updatedAt: 1000,
  }),
});

describe("existing remote quota compatibility", () => {
  it("reads Codex quota using only the existing transport methods", async () => {
    const r = reader();
    const result = await readSessionMenuAccountUsage(session, r);
    expect(result).toMatchObject({
      source: "chatgpt",
      accountOnly: true,
      plan: "pro",
      windows: [{ remainingPercent: 75, minutes: 300 }],
    });
    expect(r.getCodexRateLimits).toHaveBeenCalledOnce();
    expect(r.getAccountUsage).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain("private");
  });

  it("uses the existing account snapshot on desktops without the official control channel", async () => {
    const r = reader();
    r.getCodexRateLimits.mockRejectedValue({ code: "CHANNEL_NOT_ALLOWED" });
    const result = await readSessionMenuAccountUsage(session, r);
    expect(r.getAccountUsage).toHaveBeenCalledWith("codex");
    expect(result).toMatchObject({
      updatedAt: 1000,
      windows: [{ remainingPercent: 60 }],
    });
    expect(result.accountOnly).toBe(true);
  });

  it("does not fall back to an old account after the desktop reports an identity change", async () => {
    const r = reader();
    const error = { code: "PRECONDITION_FAILED", message: "ACCOUNT_CHANGED" };
    r.getCodexRateLimits.mockRejectedValue(error);
    await expect(readSessionMenuAccountUsage(session, r)).rejects.toBe(error);
    expect(r.getAccountUsage).not.toHaveBeenCalled();
  });

  it.each([
    { providerId: "custom" },
    { remoteHostId: "ssh" },
    { agentKind: "cc" as const },
  ])(
    "does not substitute Codex account usage for another task route: %o",
    async (patch) => {
      const r = reader();
      const result = await readSessionMenuAccountUsage(
        { ...session, ...patch },
        r,
      );
      expect(result.windows).toEqual([]);
      expect(result.amounts).toEqual([]);
      expect(r.getCodexRateLimits).not.toHaveBeenCalled();
      expect(r.getAccountUsage).not.toHaveBeenCalled();
    },
  );

  it("uses existing Gateway cycle usage for an explicit Gateway provider and preserves currency", async () => {
    const r = reader();
    r.getAccountUsage.mockResolvedValue({
      spend: 12,
      maxBudget: 100,
      todaySpend: 0,
      currency: "CNY",
      fetchedAt: 1000,
    });
    const result = await readSessionMenuAccountUsage(
      { ...session, providerId: "xd" },
      r,
    );
    expect(result).toMatchObject({
      source: "gateway",
      updatedAt: 1000,
      amounts: [
        { id: "cycle", amount: 12, limit: 100, currency: "CNY" },
        { id: "today", amount: 0, currency: "CNY" },
      ],
    });
    expect(r.getAccountUsage).toHaveBeenCalledWith("claude-code");
    expect(r.getCodexRateLimits).not.toHaveBeenCalled();
  });

  it.each([
    null,
    { spend: 12, maxBudget: 100, todaySpend: 0 },
    { spend: NaN, maxBudget: 100, todaySpend: null, currency: "USD" },
  ])(
    "does not invent money from incomplete Gateway data: %o",
    async (payload) => {
      const r = reader();
      r.getAccountUsage.mockResolvedValue(payload);
      const result = await readSessionMenuAccountUsage(
        { ...session, providerId: "xd" },
        r,
      );
      expect(result.amounts).toEqual([]);
    },
  );

  it("does not infer the default Codex task route from account login", async () => {
    const result = await readSessionMenuAccountUsage(
      { ...session, providerId: null },
      reader(),
    );
    expect(result.accountOnly).toBe(true);
  });

  it("keeps ChatGPT bridge usage separate from Codex app-server usage", async () => {
    const r = reader();
    r.getAccountUsage.mockResolvedValue({
      primary: { usedPercent: 90 },
      webSnapshot: {
        primary: { usedPercent: 20 },
        planType: "plus",
        updatedAt: 1000,
      },
    });
    const result = await readSessionMenuAccountUsage(
      { ...session, agentKind: "pi", model: "chatgpt/gpt-5" },
      r,
    );
    expect(result).toMatchObject({
      plan: "plus",
      accountOnly: false,
      windows: [{ remainingPercent: 80 }],
    });
    expect(r.getCodexRateLimits).not.toHaveBeenCalled();
  });

  it("does not substitute CLI usage when the ChatGPT web slot is missing", async () => {
    const r = reader();
    const result = await readSessionMenuAccountUsage(
      { ...session, agentKind: "pi", model: "chatgpt/gpt-5" },
      r,
    );
    expect(result.windows).toEqual([]);
  });

  it("selects the current model bucket and omits expired observations", async () => {
    const r = reader();
    r.getCodexRateLimits.mockResolvedValue({
      ...quota(),
      rateLimitsByLimitId: {
        codex: { limitId: "codex", primary: { usedPercent: 90 } },
        spark: {
          limitId: "spark",
          limitName: "GPT-5.3-Codex-Spark",
          primary: { usedPercent: 10 },
          secondary: { usedPercent: 50, resetsAt: 1 },
        },
      },
    });
    const result = await readSessionMenuAccountUsage(
      { ...session, model: "gpt-5.3-codex-spark" },
      r,
    );
    expect(result.windows).toEqual([
      { id: "primary", remainingPercent: 90, minutes: null, resetsAt: null },
    ]);
  });
});
