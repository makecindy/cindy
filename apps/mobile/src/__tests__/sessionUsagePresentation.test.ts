import { beforeAll, describe, expect, it } from "vitest";
import { i18n } from "@/i18n";
import {
  accountUsageRows,
  formatQuotaResetCountdown,
  formatSessionUsageMoney,
  sessionUsageAmounts,
} from "@/session/sessionUsagePresentation";
import type { SessionMenuAccountUsage } from "@/session/readSessionMenuAccountUsage";
import type { RemoteMoney } from "@/session/remoteMoney";

beforeAll(async () => {
  await i18n.changeLanguage("zh-CN");
});
const money = (
  amount: number,
  currency: "USD" | "CNY" = "USD",
  estimate = false,
): RemoteMoney => ({
  amount,
  currency,
  approximate: estimate,
  kind: estimate ? "value-estimate" : "actual-cost",
});
describe("task menu usage presentation", () => {
  it("includes the full persisted subscription estimate in mixed task usage", () => {
    const result = sessionUsageAmounts(
      { totalMoney: money(2) },
      money(12, "USD", true),
    );
    expect(result.total).toEqual(money(14, "USD", true));
    expect(result.actual).toEqual(money(2));
    expect(result.estimate).toEqual(money(12, "USD", true));
  });
  it("does not combine currencies or label a value estimate as actual cost", () => {
    const result = sessionUsageAmounts(
      { totalMoney: money(2, "CNY") },
      money(12, "USD", true),
    );
    expect(result.total).toBeNull();
    expect(result.mixed).toBe(true);
    expect(formatSessionUsageMoney(result.estimate!)).toBe("≈ $12.00");
  });
  it("prefers structured money over legacy USD and preserves small nonzero values", () => {
    expect(
      sessionUsageAmounts(
        { totalMoney: money(3, "CNY"), totalCostUsd: 10 },
        null,
      ).total,
    ).toEqual(money(3, "CNY"));
    expect(formatSessionUsageMoney(money(0.001))).toBe("<$0.01");
    expect(sessionUsageAmounts({ totalCostUsd: NaN }, null).total).toBeNull();
  });
  it("shows missing usage separately from zero balance", () => {
    expect(sessionUsageAmounts({}, null).total).toBeNull();
    expect(accountUsageRows(null, i18n.t, "zh-CN")).toEqual([]);
    const account: SessionMenuAccountUsage = {
      source: "gateway",
      plan: null,
      updatedAt: 1,
      windows: [],
      amounts: [{ id: "balance", amount: 0, currency: "CNY" }],
    };
    expect(accountUsageRows(account, i18n.t, "zh-CN")[0]).toMatchObject({
      value: "¥0.00",
      warning: true,
    });
  });
  it("uses real window periods, warns at low remaining, and marks expired observations", () => {
    const account: SessionMenuAccountUsage = {
      source: "chatgpt",
      plan: "pro",
      updatedAt: 1000,
      amounts: [],
      windows: [
        { id: "a", minutes: 180, remainingPercent: 8, resetsAt: null },
        { id: "b", minutes: 10080, remainingPercent: 0, resetsAt: 1 },
      ],
    };
    const rows = accountUsageRows(account, i18n.t, "zh-CN", 1_000_000);
    expect(rows[0]).toMatchObject({
      label: "3 小时",
      value: "剩余 8%",
      warning: true,
    });
    expect(rows[1]).toMatchObject({ value: "等待刷新", warning: false });
  });
  it.each([
    [{ balance: 1234.5, status: null }, "剩余 1,234.50", false],
    [{ balance: null, status: "unlimited" }, "不限", false],
    [{ balance: 0, status: "depleted" }, "剩余 0.00 · 已耗尽", true],
    [{ balance: null, status: "available" }, "可用", false],
  ] as const)("shows ChatGPT credits %o after the quota windows", (credits, value, warning) => {
    const account: SessionMenuAccountUsage = {
      source: "chatgpt",
      plan: null,
      updatedAt: 1,
      amounts: [],
      windows: [{ id: "a", minutes: 300, remainingPercent: 50, resetsAt: null }],
      credits,
    };
    const rows = accountUsageRows(account, i18n.t, "zh-CN");
    expect(rows[1]).toEqual({ label: "Credits", value, warning });
  });
  it("labels each quota by the time left until it resets, like the desktop status chip", () => {
    const now = 1_000_000_000_000;
    const at = (ms: number) => (now + ms) / 1000;
    const account: SessionMenuAccountUsage = {
      source: "claude",
      plan: null,
      updatedAt: now,
      amounts: [],
      windows: [
        { id: "a", minutes: 300, remainingPercent: 94, resetsAt: at(4.5 * 3_600_000) },
        { id: "b", minutes: 10080, remainingPercent: 29, resetsAt: at(2.2 * 86_400_000) },
        { id: "m", minutes: 10080, modelLabel: "Opus", remainingPercent: 8, resetsAt: at(2.2 * 86_400_000) },
        { id: "c", minutes: 300, remainingPercent: 50, resetsAt: at(90_000) },
        { id: "d", minutes: 300, remainingPercent: 50, resetsAt: at(-1_000) },
        { id: "e", minutes: 10080, remainingPercent: 50, resetsAt: null },
      ],
    };
    const rows = accountUsageRows(account, i18n.t, "zh-CN", now);
    expect(rows.map(({ label, value }) => [label, value])).toEqual([
      ["5小时", "剩余 94%"],
      ["3天", "剩余 29%"],
      ["Opus · 3天", "剩余 8%"],
      ["2分钟", "剩余 50%"],
      ["5 小时", "等待刷新"],
      ["本周", "剩余 50%"],
    ]);
    expect(rows.every((row) => row.detail === undefined)).toBe(true);
    expect(formatQuotaResetCountdown(at(45_000), now, i18n.t)).toBe("45秒");
  });
  it("caps a just-reset window at its length, but never xAI's possibly non-weekly reset", () => {
    const now = 1_000_000_000_000;
    const at = (ms: number) => (now + ms) / 1000;
    const window = (resetsAt: number) => ({ id: "w", minutes: 10080, remainingPercent: 100, resetsAt });
    const account = (source: SessionMenuAccountUsage["source"], resetsAt: number): SessionMenuAccountUsage => ({
      source,
      plan: null,
      updatedAt: now,
      amounts: [],
      windows: [window(resetsAt)],
    });
    // resetsAt lands 30s past now + 7 days (server rounding / clock skew).
    expect(accountUsageRows(account("claude", at(7 * 86_400_000 + 30_000)), i18n.t, "zh-CN", now)[0].label).toBe("7天");
    expect(accountUsageRows(account("xai", at(25 * 86_400_000)), i18n.t, "zh-CN", now)[0].label).toBe("25天");
    expect(formatQuotaResetCountdown(at(7 * 86_400_000 + 30_000), now, i18n.t, 10080)).toBe("7天");
  });
});
