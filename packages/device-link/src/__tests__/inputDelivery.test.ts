import { describe, expect, it } from "vitest";
import { readInputDeliveryClientIds } from "../inputDelivery.js";

describe("optional input delivery receipt requests", () => {
  it("leaves legacy callers unchanged and preserves original client IDs", () => {
    expect(readInputDeliveryClientIds(undefined)).toBeUndefined();
    expect(readInputDeliveryClientIds({})).toBeUndefined();
    expect(
      readInputDeliveryClientIds({ deliveryClientIds: ["a", "b", "a"] }),
    ).toEqual(["a", "b"]);
  });
  it("bounds receipt reads and rejects malformed IDs instead of truncating the request", () => {
    for (const deliveryClientIds of [
      null,
      "id",
      [""],
      [42],
      ["a".repeat(257)],
      Array(65).fill("id"),
    ]) {
      expect(() => readInputDeliveryClientIds({ deliveryClientIds })).toThrow();
    }
    expect(readInputDeliveryClientIds({ deliveryClientIds: [] })).toEqual([]);
  });
});
