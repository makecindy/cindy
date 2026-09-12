import { describe, expect, it } from "vitest";
import {
  FILE_PEER_CHANNEL,
  parseFilePeerFile,
  parseFilePeerRequest,
} from "../filePeer";
import { REMOTE_INVOKE_ALLOWLIST } from "../allowlist";

const connection = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
describe("file transfer signaling", () => {
  it("uses an allowed aggregate channel without accepting caller-supplied paths as read commands", () => {
    expect(REMOTE_INVOKE_ALLOWLIST.has(FILE_PEER_CHANNEL)).toBe(true);
    expect(parseFilePeerRequest({ action: "caps" })).toEqual({
      action: "caps",
    });
    expect(() =>
      parseFilePeerRequest({ action: "read", path: "/etc/passwd" }),
    ).toThrow();
    expect(
      parseFilePeerRequest({
        action: "open",
        connection,
        url: "xdt-file://local/?path=/tmp/a",
      }).action,
    ).toBe("open");
  });
  it.each([
    null,
    {},
    { action: "offer", sdp: "" },
    { action: "offer", sdp: "a".repeat(131073) },
    { action: "close", connection: "../other" },
    { action: "open", connection, url: 1 },
  ])("rejects malformed requests %#", (value) => {
    expect(() => parseFilePeerRequest(value)).toThrow();
  });
  it("accepts empty files and rejects unbounded metadata", () => {
    expect(
      parseFilePeerFile({ ticket: connection, size: 0, mimeType: "text/html" })
        .size,
    ).toBe(0);
    for (const size of [-1, NaN, Infinity, 1.5, 104857601])
      expect(() =>
        parseFilePeerFile({ ticket: connection, size, mimeType: "text/html" }),
      ).toThrow();
    expect(() =>
      parseFilePeerFile({
        ticket: connection,
        size: 1,
        mimeType: "text/html\r\nx:y",
      }),
    ).toThrow();
  });
});
