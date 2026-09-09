import { describe, expect, it } from "vitest";
import {
  isDesktopInput,
  parseRemoteDesktopRequest,
  REMOTE_DESKTOP_CHANNEL,
  isDesktopPermission,
} from "../remoteDesktop";
import { REMOTE_INVOKE_ALLOWLIST, PUSH_FORWARD_ALLOWLIST } from "../allowlist";
describe("remote desktop wire boundary", () => {
  it("accepts old starts and validates the optional recovery flag", () => {
    expect(parseRemoteDesktopRequest({ op: "start", displayId: "1" })).toEqual({
      op: "start",
      displayId: "1",
    });
    expect(
      parseRemoteDesktopRequest({
        op: "start",
        displayId: "1",
        resume: true,
      }),
    ).toEqual({ op: "start", displayId: "1", resume: true });
    for (const resume of ["", 1, null])
      expect(() =>
        parseRemoteDesktopRequest({ op: "start", displayId: "1", resume }),
      ).toThrow("INVALID_REQUEST");
  });
  it("limits permission actions to status and the dedicated guide", () => {
    expect(
      parseRemoteDesktopRequest({ op: "permissions", action: "guide" }),
    ).toEqual({ op: "permissions", action: "guide" });
    expect(() =>
      parseRemoteDesktopRequest({ op: "permissions", action: "openExternal" }),
    ).toThrow();
    expect(isDesktopPermission("accessibility")).toBe(true);
    expect(isDesktopPermission("https://example.com")).toBe(false);
    expect(isDesktopPermission("fullDiskAccess")).toBe(false);
  });
  it("adds only a business invoke channel, never a broadcast", () => {
    expect(REMOTE_INVOKE_ALLOWLIST.has(REMOTE_DESKTOP_CHANNEL)).toBe(true);
    expect(PUSH_FORWARD_ALLOWLIST.has(REMOTE_DESKTOP_CHANNEL)).toBe(false);
  });
  it.each([
    { kind: "move", x: NaN, y: 0 },
    { kind: "move", x: -1, y: 0 },
    { kind: "button", x: 0, y: 0, button: 5, down: true },
    { kind: "key", code: "shell", down: true },
    { kind: "text", text: "a".repeat(4097) },
    { kind: "scroll", dx: 1, dy: Infinity },
  ])("rejects malformed input %j", (value) => {
    expect(isDesktopInput(value)).toBe(false);
  });
  it("bounds batches, SDP, and sequence numbers", () => {
    expect(() =>
      parseRemoteDesktopRequest({
        op: "input",
        lease: "a",
        sequence: -1,
        events: [],
      }),
    ).toThrow();
    expect(() =>
      parseRemoteDesktopRequest({
        op: "input",
        lease: "a",
        sequence: 1,
        events: Array(65).fill({ kind: "release" }),
      }),
    ).toThrow();
    expect(() =>
      parseRemoteDesktopRequest({
        op: "offer",
        lease: "a",
        sdp: "x".repeat(64001),
      }),
    ).toThrow();
  });
});
