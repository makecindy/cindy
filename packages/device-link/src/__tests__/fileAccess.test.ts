import { describe, expect, it, vi } from "vitest";
import { readDeviceFile } from "../fileAccess";

const metadata = {
  ossKey: "",
  size: 100_000,
  mimeType: "text/plain",
  transferRequired: true,
};
describe("shared file read policy", () => {
  it.each(["audio/mpeg", "video/mp4", "Audio/MP4"])("keeps %s playback on OSS but full-file reads on peer", async (mimeType) => {
    const prepared = { ...metadata, mimeType };
    const peer = vi.fn(async () => ({ ...prepared, transferRequired: false }));
    const fallback = vi.fn(async () => ({ ...prepared, ossKey: "stream/key", transferRequired: false }));
    expect((await readDeviceFile({ prepare: async () => prepared, peer, fallback, stream: true })).ossKey).toBe("stream/key");
    expect(peer).not.toHaveBeenCalled();
    expect(fallback).toHaveBeenCalledOnce();
    await readDeviceFile({ prepare: async () => prepared, peer, fallback, stream: false });
    expect(peer).toHaveBeenCalledOnce();
    expect(fallback).toHaveBeenCalledOnce();
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
  it("accepts old hosts ordinary OSS result without uploading twice", async () => {
    const result = { ossKey: "old/key", size: 1, mimeType: "text/plain" };
    const peer = vi.fn(),
      fallback = vi.fn();
    expect(
      await readDeviceFile({ prepare: async () => result, peer, fallback }),
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
