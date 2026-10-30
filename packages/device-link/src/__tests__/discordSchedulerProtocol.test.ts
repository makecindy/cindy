import { describe, expect, it, vi } from "vitest";

import { isImSchedulerFrame } from "../discordSchedulerProtocol.js";

const identity = "12345678901234567";
const bindingGeneration = "binding-123456789";

describe("Discord scheduler protocol", () => {
  it("accepts non-secret advertisements, probes, and bounded dirty gaps", () => {
    expect(
      isImSchedulerFrame({
        kind: "advertisement",
        sentAt: 1,
        channels: [{ channel: "discord", identity, bindingGeneration }],
        inReplyTo: "1234567890abcdef",
      }),
    ).toBe(true);
    expect(
      isImSchedulerFrame({
        kind: "probe",
        sentAt: 1,
        nonce: "1234567890abcdef",
        channels: [],
        runtimeGaps: [
          {
            identity,
            bindingGeneration,
            generation: "a".repeat(32),
            state: "dirty",
          },
        ],
      }),
    ).toBe(true);
  });

  it("accepts multiple unresolved generations for the same binding", () => {
    expect(
      isImSchedulerFrame({
        kind: "advertisement",
        sentAt: 1,
        channels: [{ channel: "discord", identity, bindingGeneration }],
        runtimeGaps: [
          {
            identity,
            bindingGeneration,
            generation: "a".repeat(32),
            state: "dirty",
          },
          {
            identity,
            bindingGeneration,
            generation: "b".repeat(32),
            state: "dirty",
          },
        ],
      }),
    ).toBe(true);
  });

  it("rejects an exact duplicate unresolved generation", () => {
    const runtime = {
      identity,
      bindingGeneration,
      generation: "a".repeat(32),
      state: "dirty",
    };
    expect(
      isImSchedulerFrame({
        kind: "advertisement",
        sentAt: 1,
        channels: [{ channel: "discord", identity, bindingGeneration }],
        runtimeGaps: [runtime, runtime],
      }),
    ).toBe(false);
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
        channels: [{ channel: "telegram", identity, bindingGeneration }],
      }),
    ).toBe(false);
    expect(
      isImSchedulerFrame({
        kind: "advertisement",
        sentAt: 1,
        channels: [
          {
            channel: "discord",
            identity: `${identity}.secret`,
            bindingGeneration,
          },
        ],
      }),
    ).toBe(false);
    expect(
      isImSchedulerFrame({
        kind: "advertisement",
        sentAt: 1,
        channels: [],
        runtime: {
          identity,
          bindingGeneration,
          generation: "a".repeat(32),
          state: "clean",
          predecessor: "b".repeat(32),
        },
      }),
    ).toBe(false);
    expect(
      isImSchedulerFrame({
        kind: "advertisement",
        sentAt: 1,
        channels: [{ channel: "discord", identity }],
      }),
    ).toBe(false);
    expect(
      isImSchedulerFrame({
        kind: "advertisement",
        sentAt: 1,
        channels: [],
        runtimeGaps: [{ identity, generation: "a".repeat(32), state: "dirty" }],
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
