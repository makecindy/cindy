import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearPeerMedia,
  installPeerFileDownload,
  peerMediaUri,
  recordPeerMedia,
  releasePeerMedia,
  tryMobilePeerFile,
} from "../device-link/peerFileRegistry";
afterEach(() => {
  clearPeerMedia();
  vi.useRealTimers();
});
describe("peer file staging ownership", () => {
  it("cannot be forged by fields in a remote JSON response", () => {
    expect(
      peerMediaUri({
        uri: "file:///private/secret",
        localUri: "file:///private/secret",
      }),
    ).toBeUndefined();
    const result = { ossKey: "", size: 1, mimeType: "image/png" };
    expect(recordPeerMedia(result, "file:///cache/owned", vi.fn())).toBe(true);
    expect(peerMediaUri(result)).toBe("file:///cache/owned");
    expect(peerMediaUri({ ...result })).toBeUndefined();
  });
  it("releases consumed snapshots once and expires abandoned staging files", () => {
    vi.useFakeTimers();
    const dispose = vi.fn(),
      abandon = vi.fn();
    recordPeerMedia(
      { ossKey: "", size: 10, mimeType: "text/html" },
      "file:///one",
      dispose,
    );
    recordPeerMedia(
      { ossKey: "", size: 10, mimeType: "text/html" },
      "file:///two",
      abandon,
    );
    releasePeerMedia("file:///one");
    releasePeerMedia("file:///one");
    vi.advanceTimersByTime(300000);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(abandon).toHaveBeenCalledTimes(1);
  });
  it("bounds aggregate staging storage and keeps replacement providers registered", async () => {
    expect(
      recordPeerMedia(
        { ossKey: "", size: 256 * 1024 * 1024, mimeType: "text/plain" },
        "file:///full",
        vi.fn(),
      ),
    ).toBe(true);
    expect(
      recordPeerMedia(
        { ossKey: "", size: 1, mimeType: "text/plain" },
        "file:///extra",
        vi.fn(),
      ),
    ).toBe(false);
    const old = installPeerFileDownload(async () => null);
    const result = { ossKey: "", size: 0, mimeType: "text/plain" };
    const remove = installPeerFileDownload(async () => result);
    old();
    expect(await tryMobilePeerFile("device", "url")).toBe(result);
    remove();
    expect(await tryMobilePeerFile("device", "url")).toBeNull();
  });
});
