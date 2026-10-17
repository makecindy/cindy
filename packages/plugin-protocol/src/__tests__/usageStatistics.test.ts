import { expect, it } from "vitest";
import { parsePluginUsageStatistics, PLUGIN_API_SCHEMA_VERSION } from "../delivery.js";

const asOf = "2026-10-12T00:00:00.000Z";
it("preserves v2, real installation zero, and absence of unsupported statistics", () => {
  expect(PLUGIN_API_SCHEMA_VERSION).toBe(2);
  expect(parsePluginUsageStatistics({installationCount: "0", usageCount: "18446744073709551615", usageCountLast7Days: "20", asOf}))
    .toEqual({installationCount: "0", usageCount: "18446744073709551615", usageCountLast7Days: "20", asOf});
  for (const value of [undefined, null, {}, { downloadCount: "400" }, { usageCount: "-1", asOf }])
    expect(parsePluginUsageStatistics(value)).toBeUndefined();
});
it("accepts usage-only servers without inventing an installation count", () => {
  expect(
    parsePluginUsageStatistics({
      usageCount: "0",
      usageCountLast7Days: "0",
      asOf,
    }),
  ).toEqual({ usageCount: "0", usageCountLast7Days: "0", asOf });
});
it("validates each metric independently and preserves exact large counts", () => {
  expect(
    parsePluginUsageStatistics({
      installationCount: -1,
      usageCount: "18446744073709551615",
      usageCountLast7Days: "01",
      asOf,
    }),
  ).toEqual({ usageCount: "18446744073709551615", asOf });
  expect(parsePluginUsageStatistics({ asOf })).toBeUndefined();
  expect(
    parsePluginUsageStatistics({ usageCount: "0", asOf: "invalid" }),
  ).toBeUndefined();
});
