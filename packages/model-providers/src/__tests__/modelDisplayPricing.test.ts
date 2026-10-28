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

// Contract regression: the old parser dropped a valid summary. Unit tier; existing cases only covered items.
// Minimum input: one summary.input quote. Invalid roles must drop the summary, preserving the full table.
describe("optional primary quote summary", () => {
  const quote = { price: 0, unit: "image", quantity: 1 };
  it("preserves all roles, ranges, units and conditions but strips unknown fields", () => {
    const summary = {
      input: [quote, { price: 140, unit: "character", quantity: 1000000 }],
      output: [
        {
          price: 6,
          maxPrice: 10,
          unit: "token",
          quantity: 1000000,
          tier: "480P/720P",
          priceType: "estimated",
        },
      ],
      cacheRead: [{ ...quote, priceType: "exact" }],
      cacheWrite: [{ ...quote, priceType: "estimated" }],
    };
    expect(
      parseModelDisplayPricing({
        ...table,
        summary: { ...summary, future: true },
      }),
    ).toEqual({ ...table, summary });
  });
  it.each([
    undefined,
    null,
    {},
    [],
    "summary",
    { input: null },
    { input: [] },
    { input: Array(5).fill(quote) },
    { input: [quote, quote] },
    {
      input: [
        { ...quote, tier: "<=200k" },
        { ...quote, tier: "<=200k" },
      ],
    },
    ...[
      { price: -1 },
      { price: Infinity },
      { price: "1" },
      { quantity: 0 },
      { quantity: NaN },
      { unit: " " },
      { unit: "x".repeat(129) },
      { tier: "" },
      { priceType: "future" },
      // Summary-only contract: one unsupported segment invalidates all roles, not the table.
      { priceType: "starting_at" },
      { priceType: "starting_at", maxPrice: 2 },
      { maxPrice: 0 },
      { maxPrice: -1 },
      { maxPrice: Infinity },
      { maxPrice: null },
      { maxPrice: "2" },
    ].map((patch) => ({ output: [quote], input: [{ ...quote, ...patch }] })),
  ])("drops absent or invalid summary only: %j", (summary) => {
    expect(parseModelDisplayPricing({ ...table, summary })).toEqual(table);
  });
  it("preserves distinct tiers that share a denominator", () => {
    const summary = {
      input: [
        { ...quote, price: 1, unit: "token", quantity: 1000000, tier: "<=200k" },
        { ...quote, price: 2, unit: "token", quantity: 1000000, tier: ">200k" },
      ],
    };
    expect(parseModelDisplayPricing({ ...table, summary })?.summary).toEqual(
      summary,
    );
  });
  it("allows four distinct denominators and preserves unknown units", () => {
    const summary = {
      input: [
        quote,
        { ...quote, quantity: 2 },
        { ...quote, unit: "future" },
        { ...quote, quantity: 0.5 },
      ],
    };
    expect(parseModelDisplayPricing({ ...table, summary })?.summary).toEqual(
      summary,
    );
  });
});
