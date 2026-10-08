import { describe, expect, it, vi } from "vitest";
import type { MobileCodexRateLimitsResult } from "@cindy/maker-shared/device-link-contract";
import { REMOTE_INVOKE_ALLOWLIST } from "@cindy/device-link";
import {
  NATIVE_SUBSCRIPTION_AUTHS,
  NATIVE_SUBSCRIPTION_DEFAULT_PROVIDER_IDS,
} from "@cindy/model-providers/types";
import { SUBSCRIPTION_USAGE_CHANNELS } from "@/device-link/mobileMakerTransport";
import {
  isSubscriptionUsageSource,
  readSessionMenuAccountUsage,
  sessionSubscriptionFamily,
  SUBSCRIPTION_USAGE_SOURCES,
} from "@/session/readSessionMenuAccountUsage";
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
  getSubscriptionUsage: vi.fn<() => Promise<unknown>>().mockResolvedValue(null),
  getClaudeSessionRoute: vi.fn<() => Promise<unknown>>().mockResolvedValue(null),
});

describe("existing remote quota compatibility", () => {
  it('reads the selected independent account and never falls back after its read fails', async () => {
    const r = reader();
    const provider = { id: 'openai-second', auth: { method: 'oauth' as const, native: 'codex' as const } };
    const selected = { ...session, providerId: provider.id };
    await readSessionMenuAccountUsage(selected, r, provider);
    expect(r.getCodexRateLimits).toHaveBeenCalledWith(provider.id);
    r.getAccountUsage.mockClear();
    r.getCodexRateLimits.mockRejectedValue(new Error('legacy host'));
    await expect(readSessionMenuAccountUsage(selected, r, provider)).rejects.toThrow('legacy host');
    expect(r.getAccountUsage).not.toHaveBeenCalled();
  });
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
    // Only the account snapshot's credits are read alongside the control read.
    expect(r.getAccountUsage).toHaveBeenCalledWith("codex");
    expect(result.credits).toBeUndefined();
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

  it.each([null, undefined, "", "  ", "custom"])(
    "does not attribute Gateway usage to a Pi task without a confirmed Gateway source: %s",
    async (providerId) => {
      const r = reader();
      r.getAccountUsage.mockResolvedValue({
        spend: 12,
        maxBudget: 100,
        currency: "CNY",
      });
      for (const agentKind of ["pi", "cc"] as const) {
        for (const model of ["claude-sonnet-4-6"]) {
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

describe("subscription quota for every subscription family", () => {
  const nowSec = () => Math.floor(Date.now() / 1000);
  const claudeSnapshot = () => ({
    subscriptionType: "max",
    updatedAt: 2000,
    fiveHour: { utilization: 30, resetsAt: nowSec() + 3600 },
    sevenDay: { utilization: 55, resetsAt: nowSec() + 86400 },
    scoped: [
      { modelDisplayName: "Opus", utilization: 92, resetsAt: nowSec() + 86400 },
      { modelDisplayName: "Sonnet", utilization: 10 },
    ],
  });

  it.each(["cc", "pi", "codex"] as const)(
    "reads the desktop Claude subscription for an Anthropic %s task",
    async (agentKind) => {
      const r = reader();
      r.getSubscriptionUsage.mockResolvedValue(claudeSnapshot());
      const result = await readSessionMenuAccountUsage(
        { ...session, agentKind, providerId: "anthropic", model: "claude-opus-5-5" },
        r,
      );
      expect(r.getSubscriptionUsage).toHaveBeenCalledWith("claude", "anthropic");
      expect(result).toMatchObject({
        source: "claude",
        plan: "max",
        updatedAt: 2000,
        amounts: [],
      });
      expect(result.windows.map(({ id, minutes, modelLabel, remainingPercent }) => ({
        id,
        minutes,
        modelLabel,
        remainingPercent,
      }))).toEqual([
        { id: "five-hour", minutes: 300, modelLabel: undefined, remainingPercent: 70 },
        { id: "seven-day", minutes: 10080, modelLabel: undefined, remainingPercent: 45 },
        { id: "model:seven-day", minutes: 10080, modelLabel: "Opus", remainingPercent: 8 },
      ]);
      expect(r.getAccountUsage).not.toHaveBeenCalled();
      expect(r.getCodexRateLimits).not.toHaveBeenCalled();
    },
  );

  it("skips expired and malformed Claude windows instead of inventing quota", async () => {
    const r = reader();
    r.getSubscriptionUsage.mockResolvedValue({
      fiveHour: { utilization: 99, resetsAt: 1 },
      sevenDay: { utilization: "55" },
      scoped: [null, { utilization: 10 }],
    });
    const result = await readSessionMenuAccountUsage(
      { ...session, agentKind: "cc", providerId: "anthropic", model: "claude-sonnet-5" },
      r,
    );
    expect(result).toMatchObject({ source: "claude", windows: [], plan: null });
  });

  it("reads an independent subscription account by its own id", async () => {
    const r = reader();
    const provider = { id: "grok-second", auth: { method: "oauth" as const, native: "xai" as const } };
    await readSessionMenuAccountUsage(
      { ...session, agentKind: "pi", providerId: provider.id, model: "grok-4.6" },
      r,
      provider,
    );
    expect(r.getSubscriptionUsage).toHaveBeenCalledWith("xai", "grok-second");
  });

  it("reads the SuperGrok weekly quota and purchased credits", async () => {
    const r = reader();
    r.getSubscriptionUsage.mockResolvedValue({
      planLabel: "SuperGrok Heavy",
      creditUsagePercent: 25,
      resetsAt: nowSec() + 86400,
      prepaidBalance: 4.5,
      updatedAt: Date.now(),
    });
    const result = await readSessionMenuAccountUsage(
      { ...session, agentKind: "pi", providerId: "xai", model: "grok-4.6" },
      r,
    );
    expect(r.getSubscriptionUsage).toHaveBeenCalledWith("xai", "xai");
    expect(result).toMatchObject({
      source: "xai",
      plan: "SuperGrok Heavy",
      windows: [{ id: "week", minutes: 10080, remainingPercent: 75 }],
      amounts: [{ id: "balance", amount: 4.5, currency: "USD" }],
    });
  });

  it("does not present a stale SuperGrok percentage or balance as current", async () => {
    const r = reader();
    r.getSubscriptionUsage.mockResolvedValue({
      planLabel: "SuperGrok",
      creditUsagePercent: 25,
      prepaidBalance: 4.5,
      updatedAt: Date.now() - 2 * 60 * 60_000,
    });
    const result = await readSessionMenuAccountUsage(
      { ...session, agentKind: "cc", providerId: "xai", model: "xai/grok-4.6" },
      r,
    );
    expect(result).toMatchObject({ source: "xai", plan: "SuperGrok", windows: [], amounts: [] });
  });

  it.each([
    ["cc", "chatgpt/gpt-5", "chatgpt", "codex"],
    ["pi", "chatgpt/gpt-5", "chatgpt", "codex"],
    ["cc", "xai/grok-4.6", "xai", "xai"],
    ["codex", "xai/grok-4.6", "xai", "xai"],
  ] as const)(
    "attributes a providerless %s %s task to the default %s account",
    async (agentKind, model, source, kind) => {
      const r = reader();
      const result = await readSessionMenuAccountUsage(
        { ...session, agentKind, providerId: null, model },
        r,
      );
      expect(result.source).toBe(source);
      if (kind === "xai") expect(r.getSubscriptionUsage).toHaveBeenCalledWith("xai", undefined);
      else expect(r.getAccountUsage).toHaveBeenCalledWith("codex");
      expect(r.getClaudeSessionRoute).not.toHaveBeenCalled();
    },
  );

  it("does not attribute a bridge model to another family's selected account", async () => {
    const r = reader();
    const result = await readSessionMenuAccountUsage(
      { ...session, agentKind: "cc", providerId: "anthropic", model: "xai/grok-4.6" },
      r,
    );
    expect(result.source).toBe("unavailable");
    expect(r.getSubscriptionUsage).not.toHaveBeenCalled();
  });

  it.each([
    ["subscription", "claude"],
    ["gateway", "gateway"],
    [null, "unavailable"],
  ] as const)(
    "follows the host-observed route of a default Claude Code task: %s",
    async (route, source) => {
      const r = reader();
      r.getClaudeSessionRoute.mockResolvedValue(route);
      r.getAccountUsage.mockResolvedValue({ currency: "USD", spend: 1, maxBudget: 10 });
      const result = await readSessionMenuAccountUsage(
        { ...session, agentKind: "cc", providerId: null, model: "claude-opus-5-5" },
        r,
      );
      expect(r.getClaudeSessionRoute).toHaveBeenCalledWith("s1");
      expect(result.source).toBe(source);
      if (source === "claude")
        expect(r.getSubscriptionUsage).toHaveBeenCalledWith("claude", undefined);
      else expect(r.getSubscriptionUsage).not.toHaveBeenCalled();
    },
  );

  it("keeps a default Claude Code task unattributed on hosts without the route channel", async () => {
    const r = reader();
    r.getClaudeSessionRoute.mockRejectedValue({ code: "CHANNEL_NOT_ALLOWED" });
    const result = await readSessionMenuAccountUsage(
      { ...session, agentKind: "cc", providerId: null, model: "claude-opus-5-5" },
      r,
    );
    expect(result.source).toBe("unavailable");
    expect(r.getSubscriptionUsage).not.toHaveBeenCalled();
    expect(r.getAccountUsage).not.toHaveBeenCalled();
  });

  it.each([
    { code: "NOT_CONNECTED", message: "offline" },
    new Error("[DEVICE_LINK_TIMEOUT] timed out"),
  ])("fails the read on a transient route lookup error so cached quota is kept: %o", async (error) => {
    const r = reader();
    r.getClaudeSessionRoute.mockRejectedValue(error);
    await expect(
      readSessionMenuAccountUsage(
        { ...session, agentKind: "cc", providerId: null, model: "claude-opus-5-5" },
        r,
      ),
    ).rejects.toBe(error);
    expect(r.getSubscriptionUsage).not.toHaveBeenCalled();
  });

  it("treats a channel-not-allowed error message as an older host", async () => {
    const r = reader();
    r.getClaudeSessionRoute.mockRejectedValue(new Error("[DEVICE_LINK_CHANNEL_NOT_ALLOWED] nope"));
    const result = await readSessionMenuAccountUsage(
      { ...session, agentKind: "cc", providerId: null, model: "claude-opus-5-5" },
      r,
    );
    expect(result.source).toBe("unavailable");
  });

  it("surfaces an old host's missing subscription channel as a failed read", async () => {
    const r = reader();
    const error = { code: "CHANNEL_NOT_ALLOWED" };
    r.getSubscriptionUsage.mockRejectedValue(error);
    await expect(
      readSessionMenuAccountUsage(
        { ...session, agentKind: "cc", providerId: "anthropic", model: "claude-opus-5-5" },
        r,
      ),
    ).rejects.toBe(error);
  });
});

describe("new subscription families cannot be skipped", () => {
  it.each(NATIVE_SUBSCRIPTION_AUTHS)(
    "routes the default %s account to its own subscription quota",
    async (family) => {
      const r = reader();
      const providerId = NATIVE_SUBSCRIPTION_DEFAULT_PROVIDER_IDS[family];
      const routed = {
        ...session,
        agentKind: family === "codex" ? ("codex" as const) : ("pi" as const),
        providerId,
        model: family === "codex" ? "gpt-6-astra" : "any-model",
      };
      expect(sessionSubscriptionFamily(routed)).toBe(family);
      const result = await readSessionMenuAccountUsage(routed, r);
      expect(result.source).toBe(SUBSCRIPTION_USAGE_SOURCES[family]);
      expect(isSubscriptionUsageSource(result.source)).toBe(true);
    },
  );

  it("reads every subscription snapshot channel the desktop exposes remotely", () => {
    const exposed = [...REMOTE_INVOKE_ALLOWLIST].filter((channel) =>
      /^maker:usage:[a-z0-9-]+-subscription$/.test(channel),
    );
    expect(exposed.length).toBeGreaterThan(0);
    expect(Object.values(SUBSCRIPTION_USAGE_CHANNELS).sort()).toEqual(exposed.sort());
  });

  it.each(["en", "ja", "ko", "zh-CN", "zh-TW"])(
    "labels every subscription source in %s",
    async (locale) => {
      const { default: strings } = await import(`../i18n/locales/${locale}/session.json`);
      const labels = strings.menu.usage.source as Record<string, string>;
      for (const source of Object.values(SUBSCRIPTION_USAGE_SOURCES))
        expect(labels[source]?.trim()).toBeTruthy();
    },
  );
});

describe("ChatGPT credits", () => {
  it.each([
    [{ hasCredits: true, unlimited: false, balance: "1,234.5" }, { balance: 1234.5, status: null }],
    [{ hasCredits: true, unlimited: true, balance: null }, { balance: null, status: "unlimited" }],
    [{ hasCredits: false, unlimited: false, balance: "0" }, { balance: 0, status: "depleted" }],
    [{ hasCredits: false, unlimited: false, balance: "12.5" }, { balance: 12.5, status: "depleted" }],
    [{ hasCredits: true, unlimited: false }, { balance: null, status: "available" }],
    [{ hasCredits: true, unlimited: false, balance: "n/a" }, { balance: null, status: "available" }],
  ])("projects the account credit state %o", async (credits, expected) => {
    const r = reader();
    r.getCodexRateLimits.mockResolvedValue({
      ...quota(),
      rateLimits: { primary: { usedPercent: 25, windowMinutes: 300 }, credits },
    } as MobileCodexRateLimitsResult);
    const result = await readSessionMenuAccountUsage(session, r);
    expect(result.credits).toEqual(expected);
    expect(result.windows).toHaveLength(1);
  });

  it("reads credits from the account snapshot when the control read omits them", async () => {
    const r = reader();
    r.getAccountUsage.mockResolvedValue({
      appServerBuckets: {
        codex: { credits: { hasCredits: true, unlimited: false, balance: "42" } },
      },
    });
    const result = await readSessionMenuAccountUsage(session, r);
    expect(result).toMatchObject({
      windows: [{ remainingPercent: 75 }],
      credits: { balance: 42, status: null },
    });
  });

  it("fails the read when the credits snapshot is transiently unavailable", async () => {
    const r = reader();
    const error = new Error("[NOT_CONNECTED] offline");
    r.getAccountUsage.mockRejectedValue(error);
    await expect(readSessionMenuAccountUsage(session, r)).rejects.toBe(error);
  });

  it("reads credits of the selected independent account only", async () => {
    const r = reader();
    const provider = { id: "openai-second", auth: { method: "oauth" as const, native: "codex" as const } };
    await readSessionMenuAccountUsage({ ...session, providerId: provider.id }, r, provider);
    expect(r.getAccountUsage).toHaveBeenCalledWith("codex", "openai-second");
  });

  it("reads credits from the ChatGPT bridge web slot", async () => {
    const r = reader();
    r.getAccountUsage.mockResolvedValue({
      credits: { hasCredits: false, unlimited: false },
      webSnapshot: {
        primary: { usedPercent: 20 },
        credits: { hasCredits: true, unlimited: false, balance: "8" },
      },
    });
    const result = await readSessionMenuAccountUsage(
      { ...session, agentKind: "pi", model: "chatgpt/gpt-5" },
      r,
    );
    expect(result.credits).toEqual({ balance: 8, status: null });
  });

  it("omits credits when the account reports none", async () => {
    const r = reader();
    r.getAccountUsage.mockResolvedValue({ primary: { usedPercent: 10 } });
    const result = await readSessionMenuAccountUsage(session, r);
    expect(result).not.toHaveProperty("credits");
  });
});
