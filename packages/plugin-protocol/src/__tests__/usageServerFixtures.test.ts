import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { parsePluginUsageAck } from "../usage.js";
import {
  parsePluginDownloadStatistics,
  parsePluginUsageStatistics,
  PLUGIN_API_SCHEMA_VERSION,
} from "../delivery.js";

// Copied byte-for-byte from the server's frozen S1 fixture, not reconstructed from client types.
const fixture = JSON.parse(
  readFileSync(
    new URL("../../../../docs/fixtures/plugin-usage.json", import.meta.url),
    "utf8",
  ),
);
const eventIds = fixture.request.events.map(
  (event: { eventId: string }) => event.eventId,
);

it.each(["accepted", "retry", "conflict"])(
  "parses the server %s acknowledgement",
  (name) => {
    expect(parsePluginUsageAck(fixture[name], eventIds)).toEqual(fixture[name]);
  },
);

it("keeps real zero, missing metrics, and download totals independent without requiring installationCount", () => {
  expect(PLUGIN_API_SCHEMA_VERSION).toBe(fixture.schemaVersion);
  for (const name of ["zero", "independent", "unavailable"]) {
    expect(parsePluginUsageStatistics(fixture[name].usageStatistics)).toEqual(
      fixture[name].usageStatistics,
    );
    expect(
      parsePluginDownloadStatistics(fixture[name].downloadStatistics),
    ).toEqual(fixture[name].downloadStatistics);
    expect(
      parsePluginUsageStatistics(fixture[name].usageStatistics)
        ?.installationCount,
    ).toBeUndefined();
  }
});

it("does not treat a storage error envelope as a committed ACK", () => {
  expect(() => parsePluginUsageAck(fixture.retryableError, eventIds)).toThrow();
});
