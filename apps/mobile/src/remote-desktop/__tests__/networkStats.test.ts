import vm from "node:vm";
import { describe, expect, it } from "vitest";
import {
  DESKTOP_NETWORK_STATS_SCRIPT,
  formatReceiveRate,
} from "../networkStats";

const measure = vm.runInNewContext(`(${DESKTOP_NETWORK_STATS_SCRIPT})`);
const report = (
  bytes = 1000,
  time = 1000,
  candidateType = "host",
  path = "pair",
) =>
  new Map([
    [
      "video",
      {
        id: "video",
        type: "inbound-rtp",
        kind: "video",
        bytesReceived: bytes,
        timestamp: time,
      },
    ],
    ["transport", { type: "transport", selectedCandidatePairId: path }],
    [
      path,
      {
        id: path,
        type: "candidate-pair",
        localCandidateId: "local",
        remoteCandidateId: "remote",
        currentRoundTripTime: 0.042,
      },
    ],
    ["local", { candidateType }],
    ["remote", { candidateType: "srflx" }],
  ] as [string, Record<string, unknown>][]);

describe("remote desktop receive statistics", () => {
  it("measures media bytes over the report interval and converts RTT to ms", () => {
    const first = measure(report());
    expect(first.bytesPerSecond).toBeNull();
    expect(measure(report(5000, 3000), first.sample)).toMatchObject({
      transport: "direct",
      bytesPerSecond: 2000,
      latencyMs: 42,
    });
  });
  it("distinguishes relay from unknown paths without assuming direct", () => {
    expect(measure(report(1000, 1000, "relay")).transport).toBe("relay");
    expect(measure(report(1000, 1000, "unknown")).transport).toBe("video");
    const partial = report();
    partial.delete("remote");
    expect(measure(partial).transport).toBe("video");
    expect(measure(new Map())).toMatchObject({
      transport: "video",
      bytesPerSecond: null,
      latencyMs: null,
    });
  });
  it("discards baselines after path changes, counter resets or duplicate timestamps", () => {
    const previous = measure(report()).sample;
    for (const next of [
      report(5000, 2000, "host", "new-pair"),
      report(500, 2000),
      report(5000, 1000),
    ]) {
      expect(measure(next, previous).bytesPerSecond).toBeNull();
    }
    expect(measure(report(1000, 2000), previous).bytesPerSecond).toBe(0);
  });
  it("rejects unavailable statistics and formats compact byte units", () => {
    const invalid = report(NaN);
    invalid.get("pair")!.currentRoundTripTime = -1;
    expect(measure(invalid)).toMatchObject({ sample: null, latencyMs: null });
    expect([null, 0, 125000, 1500000].map(formatReceiveRate)).toEqual([
      "— KB/s",
      "0 KB/s",
      "125 KB/s",
      "1.5 MB/s",
    ]);
  });
});
