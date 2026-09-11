import { describe, expect, it } from "vitest";
import { isControlLossError, remoteDesktopErrorCode } from "../controlFailure";

describe("remote desktop control failure classification", () => {
  it("reads the code from the error field before falling back to the message", () => {
    expect(
      remoteDesktopErrorCode(
        Object.assign(new Error("boom"), { code: "DESKTOP_VIEW_ONLY" }),
      ),
    ).toBe("DESKTOP_VIEW_ONLY");
    expect(
      remoteDesktopErrorCode(new Error("[DESKTOP_LEASE_EXPIRED] gone")),
    ).toBe("DESKTOP_LEASE_EXPIRED");
    expect(remoteDesktopErrorCode(new Error("network down"))).toBeUndefined();
    expect(remoteDesktopErrorCode(undefined)).toBeUndefined();
  });
  it.each([
    "DESKTOP_VIEW_ONLY",
    "DESKTOP_INPUT_UNAVAILABLE",
    "DESKTOP_INPUT_BUSY",
    "INVOKE_TIMEOUT",
  ])("treats %s as lost control rather than a dead session", (code) => {
    expect(isControlLossError(new Error(code))).toBe(true);
  });
  it.each([
    "DESKTOP_LEASE_EXPIRED",
    "DESKTOP_STOPPED",
    "DESKTOP_DISABLED",
    "ACCESS_REVOKED",
    "CHANNEL_NOT_ALLOWED",
    "DESKTOP_VIDEO_UNAVAILABLE",
  ])("still rebuilds the session for %s", (code) => {
    expect(isControlLossError(new Error(code))).toBe(false);
  });
});
