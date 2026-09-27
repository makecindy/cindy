import { describe, expect, it, vi } from "vitest";
import { createPeerTransferCooldown } from "../peerTransferCooldown.js";
import { canUsePeerInvoke } from "../peerInvoke.js";
import { REMOTE_DESKTOP_CHANNEL } from "../remoteDesktop.js";
import {
  uploadPeerAttachment,
  parsePeerAttachmentRef,
  buildPeerAttachmentRef,
} from "../peerAttachment.js";

describe("peer acceleration policy", () => {
  it("backs off only the failing device, caps delay and recovers after success", () => {
    let time = 0;
    const cd = createPeerTransferCooldown(() => time);
    expect(cd.fail("a")).toBe(30_000);
    expect(cd.remaining("b")).toBe(0);
    time = 30_001;
    expect(cd.remaining("a")).toBe(0);
    expect(cd.fail("a")).toBe(60_000);
    for (let i = 0; i < 10; i++) cd.fail("a");
    expect(cd.remaining("a")).toBe(300_000);
    cd.success("a");
    expect(cd.fail("a")).toBe(30_000);
    cd.clear();
    expect(cd.remaining("a")).toBe(0);
  });
  it("never retries clipboard commits or arbitrary remote commands through peer", () => {
    expect(
      canUsePeerInvoke("file-browser:remote-op", [{ op: "readFile" }]),
    ).toBe(true);
    expect(canUsePeerInvoke("file-browser:remote-op", [{ op: "delete" }])).toBe(
      false,
    );
    expect(
      canUsePeerInvoke(REMOTE_DESKTOP_CHANNEL, [
        { op: "clipboardContent", action: "write" },
      ]),
    ).toBe(true);
    expect(
      canUsePeerInvoke(REMOTE_DESKTOP_CHANNEL, [
        { op: "clipboardContent", action: "commit" },
      ]),
    ).toBe(false);
    expect(canUsePeerInvoke("maker:send", [{}])).toBe(false);
  });
  it("finishes byte staging before returning a reference; cancellation never finishes", async () => {
    const ticket = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    const metadata = { size: 1, sha256: "a".repeat(64), originalName: "a.txt" };
    const invoke = vi.fn(async (_request: Record<string, unknown>) => ({
      ticket,
    }));
    const ref = await uploadPeerAttachment(
      metadata,
      async () => "YQ==",
      invoke,
      () => {},
    );
    expect(parsePeerAttachmentRef(ref)).toEqual({ ...metadata, ticket });
    expect(invoke.mock.calls.map(([r]) => (r as any).op)).toEqual([
      "begin",
      "write",
      "finish",
    ]);
    expect(parsePeerAttachmentRef("cindy-peer-attach://bad")).toBeNull();
    expect(() =>
      buildPeerAttachmentRef({ ...metadata, ticket: "../evil" }),
    ).toThrow();
    invoke.mockClear();
    let checks = 0;
    await expect(
      uploadPeerAttachment(
        metadata,
        async () => "YQ==",
        invoke,
        () => {
          if (++checks > 1) throw new Error("cancelled");
        },
      ),
    ).rejects.toThrow("cancelled");
    expect(invoke.mock.calls.map(([r]) => (r as any).op)).toEqual([
      "begin",
      "cancel",
    ]);
  });
});
