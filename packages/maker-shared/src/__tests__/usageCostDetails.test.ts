import { describe, expect, it } from "vitest";
import {
  groupUsageCostRows,
  messageUsageCostRows,
  normalizeUsageCostRows,
  splitUsageCost,
  usageCostTotals,
  type UsageCostMoney,
  type UsageCostRow,
} from "../usageCostDetails";

// Unit: the shared production projection must not merge subscription value with a charge,
// double-count media totals, or guess a historical provider. Existing token-format tests
// do not exercise those billing identities. Minimal input: same model on two channels.
const money = (
  amount: number,
  kind: UsageCostMoney["kind"] = "actual-cost",
  currency: UsageCostMoney["currency"] = "USD",
): UsageCostMoney => ({
  amount,
  kind,
  currency,
  approximate: kind === "value-estimate",
});
const row = (patch: Partial<UsageCostRow> = {}): UsageCostRow => ({
  model: "model-a",
  category: "conversation",
  billingSource: "cindy-ai",
  money: money(1),
  ...patch,
});

describe("model and channel cost details", () => {
  it("sums repeat calls but preserves channel, estimate, model and currency boundaries", () => {
    const rows = [
      row(),
      row(),
      row({ billingSource: "subscription", money: money(3, "value-estimate") }),
      row({ model: "model-b" }),
      row({ money: money(8, "actual-cost", "CNY") }),
    ];
    const grouped = groupUsageCostRows(rows);
    expect(grouped.map((item) => item.money.amount)).toEqual([2, 3, 1, 8]);
    expect(usageCostTotals(grouped)).toEqual([
      money(6, "value-estimate"),
      money(8, "actual-cost", "CNY"),
    ]);
    expect(rows[0].money.amount).toBe(1);
  });
  it("uses model detail plus the unidentified historical remainder, without counting totals twice", () => {
    const meta = {
      mediaCosts: [money(4)],
      mediaCostDetails: [row({ category: "additional", money: money(1.5) })],
    };
    const rows = messageUsageCostRows(meta, "user");
    expect(rows.map((item) => [item.model, item.money.amount])).toEqual([
      ["model-a", 1.5],
      ["", 2.5],
    ]);
    expect(usageCostTotals(rows)[0].amount).toBe(4);
  });
  it("retains mixed billing facts and never derives old channel identity from the model name", () => {
    const rows = messageUsageCostRows(
      {
        turnCost: money(2),
        turnUsageDetails: {
          model: "gpt-example",
          perModelCost: [
            { model: "gpt-example", money: money(2) },
            {
              model: "claude-example",
              billingSource: "subscription",
              money: money(3, "value-estimate"),
            },
          ],
        },
      },
      "assistant",
    );
    expect(rows).toHaveLength(2);
    expect(rows[0].billingSource).toBeUndefined();
    expect(rows[1].billingSource).toBe("subscription");
    expect(usageCostTotals(rows)[0].amount).toBe(5);
  });
  it("splits the included additional costs and leaves other currencies separate", () => {
    const split = splitUsageCost(money(2.46, "value-estimate"), [
      money(1.35),
      money(8, "actual-cost", "CNY"),
    ]);
    expect(split.conversation.amount).toBeCloseTo(1.11);
    expect(split.additional.map((item) => item.amount)).toEqual([1.35, 8]);
  });
  // Historical production rows used costUsd before structured money existed.
  it.each([false, true])("retains legacy per-model USD amounts (estimate=%s)", (estimate) => {
    const rows = messageUsageCostRows({
      turnCostUsd: 3,
      turnCostIsEstimate: estimate,
      turnUsageDetails: { perModelCost: [
        { model: "legacy-a", costUsd: 1 },
        { model: "legacy-b", costUsd: 2 },
        { model: "invalid", costUsd: NaN },
      ] },
    }, "assistant");
    expect(rows.map(item => [item.model, item.money.amount, item.money.kind]))
      .toEqual([["legacy-a", 1, estimate ? "value-estimate" : "actual-cost"],
        ["legacy-b", 2, estimate ? "value-estimate" : "actual-cost"]]);
    expect(rows.every(item => item.billingSource === undefined)).toBe(true);
    expect(usageCostTotals(rows)[0].amount).toBe(3);
  });
  it("rejects malformed remote billing rows without inventing zero-cost records", () => {
    expect(
      normalizeUsageCostRows([
        {},
        row({ money: { ...money(1), amount: NaN } }),
        row({ money: { ...money(1), amount: -1 } }),
        row(),
      ]),
    ).toEqual([row()]);
    expect(
      messageUsageCostRows(
        { turnCostUsd: 2, userTurnCostUsd: 50 },
        "assistant",
      ),
    ).toEqual([{ category: "conversation", model: "", money: money(2) }]);
  });
});
