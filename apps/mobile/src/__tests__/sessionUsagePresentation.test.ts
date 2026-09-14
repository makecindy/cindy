import { beforeAll, describe, expect, it } from "vitest";
import { i18n } from "@/i18n";
import {
  accountUsageRows,
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
        { id: "a", minutes: 180, remainingPercent: 8, resetsAt: 2000 },
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
});
