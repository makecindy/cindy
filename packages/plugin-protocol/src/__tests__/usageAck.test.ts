import { expect, it } from "vitest";
import { parsePluginUsageAck } from "../usage.js";

it("accepts partial ACKs and preserves future rejection codes for retry", () => {
  expect(
    parsePluginUsageAck(
      {
        accepted: ["a"],
        duplicate: ["b"],
        rejected: [{ eventId: "c", code: "FUTURE_REASON" }],
      },
      ["a", "b", "c", "d"],
    ),
  ).toEqual({
    accepted: ["a"],
    duplicate: ["b"],
    rejected: [{ eventId: "c", code: "FUTURE_REASON" }],
  });
});
it.each([
  { accepted: ["outside"], duplicate: [], rejected: [] },
  { accepted: ["a"], duplicate: ["a"], rejected: [] },
  {
    accepted: [],
    duplicate: [],
    rejected: [{ eventId: "a", code: "private message" }],
  },
  { accepted: [], rejected: [] },
])("rejects malformed or cross-batch ACKs", (ack) => {
  expect(() => parsePluginUsageAck(ack, ["a"])).toThrow();
});
