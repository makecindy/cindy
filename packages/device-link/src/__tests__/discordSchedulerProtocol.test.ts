import { describe, expect, it, vi } from "vitest";

import { isImSchedulerFrame } from "../discordSchedulerProtocol.js";

const identity = "12345678901234567";

describe("Discord scheduler protocol", () => {
  it("accepts non-secret advertisements, probes, and bounded dirty gaps", () => {
    expect(
      isImSchedulerFrame({
        kind: "advertisement",
        sentAt: 1,
        channels: [{ channel: "discord", identity }],
        inReplyTo: "1234567890abcdef",
      }),
    ).toBe(true);
    expect(
      isImSchedulerFrame({
        kind: "probe",
        sentAt: 1,
        nonce: "1234567890abcdef",
        channels: [],
        runtimeGaps: [{ identity, generation: "a".repeat(32), state: "dirty" }],
      }),
    ).toBe(true);
  });

  it("rejects credentials, other channels, malformed ids, and invalid runtime state", () => {
    expect(
      isImSchedulerFrame({
        kind: "advertisement",
        sentAt: 1,
        channels: [],
        token: "secret",
      }),
    ).toBe(false);
    expect(
      isImSchedulerFrame({
        kind: "advertisement",
        sentAt: 1,
        channels: [{ channel: "telegram", identity }],
      }),
    ).toBe(false);
    expect(
      isImSchedulerFrame({
        kind: "advertisement",
        sentAt: 1,
        channels: [{ channel: "discord", identity: `${identity}.secret` }],
      }),
    ).toBe(false);
    expect(
      isImSchedulerFrame({
        kind: "advertisement",
        sentAt: 1,
        channels: [],
        runtime: {
          identity,
          generation: "a".repeat(32),
          state: "clean",
          predecessor: "b".repeat(32),
        },
      }),
    ).toBe(false);
  });

  it("prevalidates untrusted fields before calculating payload size", () => {
    const stringify = vi.spyOn(JSON, "stringify");
    try {
      expect(
        isImSchedulerFrame({
          kind: "advertisement",
          sentAt: 1,
          channels: [],
          unexpected: "x".repeat(100_000),
        }),
      ).toBe(false);
      expect(stringify).not.toHaveBeenCalled();
    } finally {
      stringify.mockRestore();
    }
  });
});
