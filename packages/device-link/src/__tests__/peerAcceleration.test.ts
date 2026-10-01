import { describe, expect, it, vi } from "vitest";
import { createPeerTransferCooldown } from "../peerTransferCooldown.js";
import { canUsePeerInvoke } from "../peerInvoke.js";
import { REMOTE_DESKTOP_CHANNEL } from "../remoteDesktop.js";
import {
  uploadPeerAttachment,
  parsePeerAttachmentRef,
  peerAttachmentFinishTimeoutMs,
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
  it("reports only acknowledged chunks, not bytes merely read or rejected", async () => {
    const progress = vi.fn();
    let writes = 0;
    await expect(
      uploadPeerAttachment(
        { size: 2 * 1024 * 1024, sha256: "a".repeat(64) },
        async () => "YQ==",
        async (request) => {
          if (request.op === "begin")
            return { ticket: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" };
          if (request.op === "write" && ++writes === 2)
            throw new Error("disconnected");
          return {};
        },
        () => {},
        progress,
      ),
    ).rejects.toThrow("disconnected");
    expect(progress.mock.calls).toEqual([[1024 * 1024]]);
  });
  it("finishes byte staging before returning a reference; cancellation never finishes", async () => {
    const ticket = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    const metadata = { size: 1, sha256: "a".repeat(64), originalName: "a.txt" };
    const invoke = vi.fn(
      async (_request: Record<string, unknown>, _timeoutMs?: number) => ({
        ticket,
      }),
    );
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
    // 只有 finish(接收端整读重算摘要)按体积放宽等待,其余请求用默认超时。
    expect(invoke.mock.calls.map(([, timeoutMs]) => timeoutMs)).toEqual([
      undefined,
      undefined,
      peerAttachmentFinishTimeoutMs(metadata.size),
    ]);
    expect(peerAttachmentFinishTimeoutMs(1)).toBe(16_000);
    expect(peerAttachmentFinishTimeoutMs(10 * 1024 ** 3)).toBe(15_000 + 512_000);
    expect(parsePeerAttachmentRef("cindy-peer-attach://bad")).toBeNull();
    // 直连附件不设固定体积上限(只受接收端磁盘约束),但仍要求安全整数。
    const large = { ...metadata, size: 64 * 1024 ** 3, ticket };
    expect(parsePeerAttachmentRef(buildPeerAttachmentRef(large))).toEqual(large);
    expect(() =>
      buildPeerAttachmentRef({ ...metadata, size: Number.MAX_SAFE_INTEGER + 1, ticket }),
    ).toThrow();
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
