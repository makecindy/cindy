import { describe, expect, it } from "vitest";
import { parseModelDisplayPricing } from "../modelDisplayPricing.js";
const table = {
  items: [
    {
      label: "Generated video",
      tier: "HD",
      price: 0.5,
      unit: "second",
      quantity: 1,
      priceType: "estimated" as const,
    },
  ],
  notes: ["Billed by output duration."],
};

describe("display pricing contract", () => {
  it("preserves mixed units, zero prices, conditions and item order", () => {
    const value = {
      ...table,
      items: [
        ...table.items,
        { label: "Input", price: 0, unit: "image", quantity: 5 },
      ],
    };
    expect(parseModelDisplayPricing(value)).toEqual(value);
  });
  it.each([
    { price: -1 },
    { price: Infinity },
    { price: NaN },
    { price: "0.5" },
    { quantity: 0 },
    { quantity: -1 },
    { quantity: Infinity },
    { priceType: "future" },
    { unit: "" },
    { label: " " },
    { tier: 8 },
  ])("rejects the whole table if any charge is invalid: %j", (patch) => {
    expect(
      parseModelDisplayPricing({
        ...table,
        items: [table.items[0], { ...table.items[0], ...patch }],
      }),
    ).toBeUndefined();
  });
  it("rejects invalid notes and oversized tables instead of dropping billing conditions", () => {
    expect(parseModelDisplayPricing({ ...table, notes: [5] })).toBeUndefined();
    expect(parseModelDisplayPricing({ items: [] })).toBeUndefined();
    expect(
      parseModelDisplayPricing({ items: Array(129).fill(table.items[0]) }),
    ).toBeUndefined();
  });
  it("copies only display fields, preserves unknown unit text and does not infer a price type", () => {
    const row = {
      label: "Usage",
      price: 0.01,
      unit: "future_unit",
      quantity: 2.5,
    };
    expect(
      parseModelDisplayPricing({
        internal: "secret",
        items: [{ ...row, internal: "secret" }],
      }),
    ).toEqual({ items: [row] });
  });
});
