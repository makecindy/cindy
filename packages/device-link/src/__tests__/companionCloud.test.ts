import { describe, expect, it } from "vitest";
import {
  INVOKE_TIMEOUT_OVERRIDES_MS,
  REMOTE_INVOKE_ALLOWLIST,
} from "../allowlist.js";
import {
  COMPANION_CLOUD_CAPS_CHANNEL,
  COMPANION_CLOUD_HAND_OVER_CHANNEL,
  COMPANION_CLOUD_TARGETS_CHANNEL,
  companionCloudCapsVersion,
  isCompanionCloudCaps,
  parseCompanionCloudRemoteActionResult,
  parseCompanionCloudRemoteTargets,
} from "../companionCloud.js";

describe("cloud companion device-link contract", () => {
  it("lets another computer ask the home, with room for the hand-over to sync first", () => {
    for (const channel of [
      COMPANION_CLOUD_CAPS_CHANNEL,
      COMPANION_CLOUD_TARGETS_CHANNEL,
      COMPANION_CLOUD_HAND_OVER_CHANNEL,
    ])
      expect(REMOTE_INVOKE_ALLOWLIST.has(channel)).toBe(true);
    expect(
      INVOKE_TIMEOUT_OVERRIDES_MS[COMPANION_CLOUD_HAND_OVER_CHANNEL],
    ).toBeGreaterThanOrEqual(120_000);
  });

  it("reads the declared version; version 1 still receives companions", () => {
    expect(companionCloudCapsVersion({ companionCloud: 2 })).toBe(2);
    expect(companionCloudCapsVersion({ companionCloud: "2" })).toBe(0);
    expect(companionCloudCapsVersion(null)).toBe(0);
    expect(isCompanionCloudCaps({ companionCloud: 1 })).toBe(true);
    expect(isCompanionCloudCaps({})).toBe(false);
  });

  it("drops malformed remote answers", () => {
    expect(
      parseCompanionCloudRemoteTargets([
        { deviceId: "a", name: "A", online: true },
        { deviceId: "" },
        "x",
        { deviceId: "b" },
      ]),
    ).toEqual([
      { deviceId: "a", name: "A", online: true },
      { deviceId: "b", name: "", online: false },
    ]);
    expect(parseCompanionCloudRemoteTargets({})).toEqual([]);
    expect(
      parseCompanionCloudRemoteActionResult({ ok: true, extra: 1 }),
    ).toEqual({ ok: true });
    expect(
      parseCompanionCloudRemoteActionResult({
        ok: false,
        code: "HOME_CONFLICT",
        homeDeviceId: null,
      }),
    ).toEqual({ ok: false, code: "HOME_CONFLICT", homeDeviceId: null });
    expect(
      parseCompanionCloudRemoteActionResult({ ok: false, code: "not a code" }),
    ).toEqual({ ok: false, code: "FAILED" });
    expect(parseCompanionCloudRemoteActionResult(undefined)).toEqual({
      ok: false,
      code: "FAILED",
    });
  });
});
