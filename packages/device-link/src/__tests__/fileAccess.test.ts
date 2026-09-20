import { describe, expect, it, vi } from "vitest";
import { readDeviceFile } from "../fileAccess";

const metadata = {
  ossKey: "",
  size: 100_000,
  mimeType: "text/plain",
  transferRequired: true,
};
describe("shared file read policy", () => {
  it.each(["audio/mpeg", "video/mp4", "image/png", "application/pdf", "application/octet-stream"])("keeps retained %s previews on OSS but full-file reads on peer", async (mimeType) => {
    const prepared = { ...metadata, mimeType };
    const peer = vi.fn(async () => ({ ...prepared, transferRequired: false }));
    const fallback = vi.fn(async () => ({ ...prepared, ossKey: "stream/key", transferRequired: false }));
    expect((await readDeviceFile({ prepare: async () => prepared, peer, fallback, stream: true, peerResultIsTransient: true })).ossKey).toBe("stream/key");
    expect(peer).not.toHaveBeenCalled();
    expect(fallback).toHaveBeenCalledOnce();
    await readDeviceFile({ prepare: async () => prepared, peer, fallback, stream: false, peerResultIsTransient: true });
    expect(peer).toHaveBeenCalledOnce();
    expect(fallback).toHaveBeenCalledOnce();
  });
  it.each([["image/png", 1], ["application/pdf", 1], ["audio/mpeg", 0], ["video/mp4", 0], ["Audio/MP4", 0]] as const)("preserves copied-peer adapter policy for %s", async (mimeType, peerCalls) => {
    const prepared = { ...metadata, mimeType };
    const peer = vi.fn(async () => ({ ...prepared, transferRequired: false }));
    const fallback = vi.fn(async () => ({ ...prepared, ossKey: "stream/key" }));
    await readDeviceFile({ prepare: async () => prepared, peer, fallback, stream: true });
    expect(peer).toHaveBeenCalledTimes(peerCalls);
    expect(fallback).toHaveBeenCalledTimes(1 - peerCalls);
  });
  it.each([
    ["video/mp4", true],
    ["audio/mpeg", true],
    ["Audio/MP4", true],
    ["image/png", false],
    ["text/plain", false],
  ] as const)("uses a retained URL only for inline %s playback", async (mimeType, needsUrl) => {
    const prepared = { ossKey: "", size: 3, mimeType, inlineBase64: "YWJj" };
    const uploaded = { ossKey: "stream/key", size: 3, mimeType };
    const peer = vi.fn();
    const fallback = vi.fn(async () => uploaded);
    expect(await readDeviceFile({
      prepare: async () => prepared, peer, fallback, stream: true,
    })).toBe(needsUrl ? uploaded : prepared);
    expect(fallback).toHaveBeenCalledTimes(needsUrl ? 1 : 0);
    expect(peer).not.toHaveBeenCalled();

    // Download/share consumers still receive complete inline bytes without uploading.
    fallback.mockClear();
    expect(await readDeviceFile({
      prepare: async () => prepared, peer, fallback, stream: false,
    })).toBe(prepared);
    expect(fallback).not.toHaveBeenCalled();
    expect(peer).not.toHaveBeenCalled();
  });
  it("discards an inline video's uploaded result when playback is cancelled", async () => {
    const abort = new AbortController();
    const uploaded = { ossKey: "stream/key", size: 3, mimeType: "video/mp4" };
    const discard = vi.fn();
    const peer = vi.fn();
    await expect(readDeviceFile({
      prepare: async () => ({ ...uploaded, ossKey: "", inlineBase64: "YWJj" }),
      peer,
      fallback: async () => {
        abort.abort();
        return uploaded;
      },
      stream: true,
      signal: abort.signal,
      discard,
    })).rejects.toThrow("FILE_PEER_CANCELLED");
    expect(discard).toHaveBeenCalledExactlyOnceWith(uploaded);
    expect(peer).not.toHaveBeenCalled();
  });
  it("returns an empty inline file without peer negotiation or OSS", async () => {
    const result = {
      ossKey: "",
      size: 0,
      mimeType: "text/plain",
      inlineBase64: "",
    };
    const peer = vi.fn(),
      fallback = vi.fn();
    expect(
      await readDeviceFile({ prepare: async () => result, peer, fallback }),
    ).toBe(result);
    expect(peer).not.toHaveBeenCalled();
    expect(fallback).not.toHaveBeenCalled();
  });
  it.each(["text/plain", "video/mp4", "audio/mpeg"])("accepts old hosts ordinary %s OSS result without uploading twice", async (mimeType) => {
    const result = { ossKey: "old/key", size: 1, mimeType };
    const peer = vi.fn(),
      fallback = vi.fn();
    expect(
      await readDeviceFile({ prepare: async () => result, peer, fallback, stream: true }),
    ).toBe(result);
    expect(peer).not.toHaveBeenCalled();
    expect(fallback).not.toHaveBeenCalled();
  });
  it("uses peer first for prepared bytes, then OSS only when unavailable", async () => {
    const fallback = vi.fn(async () => ({
      ...metadata,
      ossKey: "oss/key",
      transferRequired: false,
    }));
    const result = { ...metadata, ossKey: "", transferRequired: false };
    expect(
      await readDeviceFile({
        prepare: async () => metadata,
        peer: async () => result,
        fallback,
      }),
    ).toBe(result);
    expect(fallback).not.toHaveBeenCalled();
    expect(
      (
        await readDeviceFile({
          prepare: async () => metadata,
          peer: async () => null,
          fallback,
        })
      ).ossKey,
    ).toBe("oss/key");
  });
  it("does not route permission failures into another transport", async () => {
    const peer = vi.fn(),
      fallback = vi.fn();
    await expect(
      readDeviceFile({
        prepare: async () => {
          throw new Error("DENIED");
        },
        peer,
        fallback,
      }),
    ).rejects.toThrow("DENIED");
    expect(peer).not.toHaveBeenCalled();
    expect(fallback).not.toHaveBeenCalled();
  });
  it("disposes a peer result overtaken by cancellation and never starts OSS", async () => {
    const abort = new AbortController(),
      discard = vi.fn(),
      fallback = vi.fn();
    await expect(
      readDeviceFile({
        prepare: async () => metadata,
        peer: async () => {
          abort.abort();
          return metadata;
        },
        fallback,
        discard,
        signal: abort.signal,
      }),
    ).rejects.toThrow("FILE_PEER_CANCELLED");
    expect(discard).toHaveBeenCalledWith(metadata);
    expect(fallback).not.toHaveBeenCalled();
  });
});
