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

  it.each([null, undefined, "", "  ", "anthropic", "custom"])(
    "does not attribute Gateway usage to a Pi task without a confirmed Gateway source: %s",
    async (providerId) => {
      const r = reader();
      r.getAccountUsage.mockResolvedValue({
        spend: 12,
        maxBudget: 100,
        currency: "CNY",
      });
      for (const agentKind of ["pi", "cc"] as const) {
        for (const model of ["claude-sonnet-4-6", "chatgpt/gpt-5"]) {
          const result = await readSessionMenuAccountUsage(
            { ...session, agentKind, providerId, model },
            r,
          );
          expect(result.source).toBe(
            providerId === "custom" ? "api" : "unavailable",
          );
          expect(result.windows).toEqual([]);
          expect(result.amounts).toEqual([]);
        }
      }
      expect(r.getAccountUsage).not.toHaveBeenCalled();
      expect(r.getCodexRateLimits).not.toHaveBeenCalled();
    },
  );

  it.each([
    { agentKind: "codex", providerId: "xd", model: "gpt-6-astra" },
    { agentKind: "pi", providerId: "xd", model: "claude-sonnet-4-6" },
    { agentKind: "cc", providerId: "xd", model: "claude-sonnet-4-6" },
    { agentKind: "codex", providerId: null, model: "codex/gpt-6-astra" },
  ] as const)(
    "uses existing Gateway cycle usage for a confirmed Gateway route and preserves currency: %o",
    async (route) => {
      const r = reader();
      r.getAccountUsage.mockResolvedValue({
        spend: 12,
        maxBudget: 100,
        todaySpend: 0,
        currency: "CNY",
        fetchedAt: 1000,
      });
      const result = await readSessionMenuAccountUsage(
        { ...session, ...route },
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
    },
  );

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

  it.each(["official", "legacy"])(
    "keeps exhausted overall quota alongside the current model quota via %s",
    async (source) => {
      const r = reader();
      const buckets = {
        codex: {
          limitId: "codex",
          secondary: { usedPercent: 100, windowMinutes: 10080 },
        },
        spark: {
          limitId: "spark",
          limitName: "GPT-5.3-Codex-Spark",
          primary: { usedPercent: 20, windowMinutes: 300 },
        },
        other: {
          limitId: "other",
          limitName: "Another Model",
          primary: { usedPercent: 40 },
        },
      };
      if (source === "official") {
        r.getCodexRateLimits.mockResolvedValue({
          ...quota(),
          rateLimitsByLimitId: buckets,
        });
      } else {
        r.getCodexRateLimits.mockRejectedValue({ code: "CHANNEL_NOT_ALLOWED" });
        r.getAccountUsage.mockResolvedValue({ appServerBuckets: buckets });
      }
      const result = await readSessionMenuAccountUsage(
        { ...session, model: "gpt-5.3-codex-spark" },
        r,
      );
      expect(result.windows).toEqual([
        {
          id: "secondary",
          remainingPercent: 0,
          minutes: 10080,
          resetsAt: null,
        },
        {
          id: "model:primary",
          modelLabel: "GPT-5.3-Codex-Spark",
          remainingPercent: 80,
          minutes: 300,
          resetsAt: null,
        },
      ]);
    },
  );

  it("does not duplicate the generic bucket when no model bucket matches", async () => {
    const r = reader();
    r.getCodexRateLimits.mockResolvedValue({
      ...quota(),
      rateLimitsByLimitId: {
        __default__: { primary: { usedPercent: 10 } },
        codex: { limitId: "codex", primary: { usedPercent: 80 } },
        other: {
          limitId: "other",
          limitName: "Another Model",
          primary: { usedPercent: 40 },
        },
      },
    });
    const result = await readSessionMenuAccountUsage(session, r);
    expect(result.windows).toEqual([
      { id: "primary", remainingPercent: 20, minutes: null, resetsAt: null },
    ]);
  });

  it.each(["gpt-5.3-codex-spark", "another-model"])(
    "only shows a matching model bucket when overall quota is absent: %s",
    async (model) => {
      const r = reader();
      r.getCodexRateLimits.mockResolvedValue({
        ...quota(),
        rateLimitsByLimitId: {
          spark: {
            limitId: "spark",
            limitName: "GPT-5.3-Codex-Spark",
            primary: { usedPercent: 20 },
          },
        },
      });
      const result = await readSessionMenuAccountUsage(
        { ...session, model },
        r,
      );
      expect(result.windows).toEqual(
        model === "another-model"
          ? []
          : [
              {
                id: "model:primary",
                modelLabel: "GPT-5.3-Codex-Spark",
                remainingPercent: 80,
                minutes: null,
                resetsAt: null,
              },
            ],
      );
    },
  );

  it("retains the oldest bucket timestamp when combining legacy observations", async () => {
    const r = reader();
    r.getCodexRateLimits.mockRejectedValue({ code: "CHANNEL_NOT_ALLOWED" });
    r.getAccountUsage.mockResolvedValue({
      updatedAt: 3000,
      appServerBuckets: {
        codex: { updatedAt: 1000, primary: { usedPercent: 100 } },
        spark: {
          limitName: "GPT-5.3-Codex-Spark",
          updatedAt: 2000,
          primary: { usedPercent: 20 },
        },
      },
    });
    const result = await readSessionMenuAccountUsage(
      { ...session, model: "gpt-5.3-codex-spark" },
      r,
    );
    expect(result.updatedAt).toBe(1000);
    expect(result.windows).toHaveLength(2);
  });

  it("keeps both buckets while omitting expired observations", async () => {
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
      { id: "primary", remainingPercent: 10, minutes: null, resetsAt: null },
      {
        id: "model:primary",
        modelLabel: "GPT-5.3-Codex-Spark",
        remainingPercent: 90,
        minutes: null,
        resetsAt: null,
      },
    ]);
  });
});
