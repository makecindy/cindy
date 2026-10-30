import { describe, expect, it } from "vitest";
import {
  controlFailureAction,
  remoteDesktopErrorCode,
} from "../controlFailure";

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
  it.each(["DESKTOP_VIEW_ONLY", "DESKTOP_INPUT_UNAVAILABLE"])(
    "releases control for %s without rebuilding the session",
    (code) => {
      expect(controlFailureAction(new Error(code))).toBe("release");
    },
  );
  it.each(["INVOKE_TIMEOUT", "DESKTOP_INPUT_BUSY"])(
    "keeps the current state for the unknown outcome %s",
    (code) => {
      // A lost reply does not prove the host released control, and a batch that
      // was injected must not be answered with a release that drops its key-up.
      expect(controlFailureAction(new Error(code))).toBe("ignore");
    },
  );
  it.each([
    "DESKTOP_LEASE_EXPIRED",
    "DESKTOP_STOPPED",
    "DESKTOP_DISABLED",
    "ACCESS_REVOKED",
    "CHANNEL_NOT_ALLOWED",
    "DESKTOP_VIDEO_UNAVAILABLE",
  ])("still rebuilds the session for %s", (code) => {
    expect(controlFailureAction(new Error(code))).toBe("rebuild");
  });
  it("rebuilds when there is no usable code at all", () => {
    expect(controlFailureAction(new Error("network down"))).toBe("rebuild");
    expect(controlFailureAction(undefined)).toBe("rebuild");
  });
});
