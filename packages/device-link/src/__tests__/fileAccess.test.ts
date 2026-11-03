import { describe, expect, it, vi } from "vitest";
import { readDeviceFile, type DeviceFileResult } from "../fileAccess";

const metadata = {
  ossKey: "",
  size: 100_000,
  mimeType: "text/plain",
  transferRequired: true,
};
describe("shared file read policy", () => {
  // Unit: old peers omit video MIME mappings; preserve both authorization and the
  // WeakMap-bound staging lease when reconciling metadata with downloaded bytes.
  it.each(['same', 'version', 'size', 'unversioned', 'explicit-type'] as const)(
    'reconciles generic peer media only for the authorized version: %s', async mode => {
      const prepared = { ...metadata, version: 'a'.repeat(64), mimeType: 'video/mp4' };
      const direct = { ossKey: '', size: prepared.size + (mode === 'size' ? 1 : 0),
        version: mode === 'unversioned' ? undefined : (mode === 'version' ? 'b' : 'a').repeat(64),
        mimeType: mode === 'explicit-type' ? 'text/html' : 'application/octet-stream' };
      const expectedMime = mode === 'same' ? prepared.mimeType : direct.mimeType;
      const result = await readDeviceFile({ prepare: async () => prepared, peer: async () => direct, fallback: vi.fn() });
      expect(result).toBe(direct);
      expect(result.mimeType).toBe(expectedMime);
    },
  );
  it.each(['cancelled', 'superseded'])('reopens from cache and refreshes independently of a %s read', async mode => {
    const cached = { ...metadata, version: 'a'.repeat(64), inlineBase64: 'YQ==' };
    const fresh = { ...cached, version: 'b'.repeat(64), transferRequired: false, inlineBase64: 'Yg==' };
    let reply!: (value: DeviceFileResult) => void;
    const prepare = vi.fn().mockImplementationOnce(() => new Promise<DeviceFileResult>(resolve => { reply = resolve; }))
      .mockResolvedValue(fresh);
    const retain = vi.fn(), discard = vi.fn(), peer = vi.fn();
    const abort = new AbortController();
    let current = true;
    const options = { prepare, peer, fallback: vi.fn(), discard,
      cacheFirst: { read: async () => cached, retain } };
    expect(await readDeviceFile({ ...options, signal: abort.signal, isCurrent: () => current })).toBe(cached);
    if (mode === 'cancelled') abort.abort();
    else current = false;
    expect(await readDeviceFile(options)).toBe(cached);
    // The reopened request must publish before the obsolete host read settles.
    try { await vi.waitFor(() => expect(retain).toHaveBeenCalledExactlyOnceWith(fresh)); }
    finally { reply(cached); }
    await vi.waitFor(() => expect(discard).toHaveBeenCalledWith(cached));
    expect(retain).toHaveBeenCalledExactlyOnceWith(fresh);
    expect(peer).not.toHaveBeenCalled();
  });
  it.each(['unchanged', 'offline'] as const)('keeps cached bytes on %s without transferring them again', async mode => {
    const cached = { ...metadata, version: 'a'.repeat(64), inlineBase64: 'YQ==' };
    const prepare = vi.fn(async () => {
      if (mode === 'offline') throw new Error('offline');
      return cached;
    });
    const peer = vi.fn(), fallback = vi.fn(), retain = vi.fn();
    expect(await readDeviceFile({ prepare, peer, fallback,
      cacheFirst: { read: async () => cached, retain } })).toBe(cached);
    await vi.waitFor(() => expect(prepare).toHaveBeenCalledOnce());
    expect(peer).not.toHaveBeenCalled();
    expect(fallback).not.toHaveBeenCalled();
    expect(retain).not.toHaveBeenCalled();
  });
  it('disposes a cached consumer copy if its account changes during lookup', async () => {
    let current = true;
    const cached = { ...metadata, version: 'a'.repeat(64) };
    const discard = vi.fn(), prepare = vi.fn();
    await expect(readDeviceFile({ prepare, peer: vi.fn(), fallback: vi.fn(), discard,
      isCurrent: () => current, cacheFirst: { read: async () => { current = false; return cached; } },
    })).rejects.toThrow('FILE_PEER_CANCELLED');
    expect(discard).toHaveBeenCalledWith(cached);
    expect(prepare).not.toHaveBeenCalled();
  });
  it.each(['unchanged', 'version', 'source-size', 'export-size', 'denied', 'cancelled'] as const)(
    'only delivers a revalidated export to its consumer: %s', async mode => {
    const version = 'a'.repeat(64);
    const prepared = { ...metadata, version };
    const exported = { ossKey: 'export/key', size: prepared.size + (mode === 'export-size' ? 1 : 0), mimeType: 'application/octet-stream' };
    const discard = vi.fn(), publish = vi.fn();
    const abort = new AbortController();
    const pending = readDeviceFile({
      prepare: async () => prepared,
      peer: async () => null,
      fallback: async () => exported,
      revalidate: async () => {
        if (mode === 'denied') throw new Error('DENIED');
        if (mode === 'cancelled') abort.abort();
        return { ...prepared, version: mode === 'version' ? 'b'.repeat(64) : version,
          size: prepared.size + (mode === 'source-size' ? 1 : 0) };
      },
      signal: abort.signal, discard,
    }).then(publish);
    if (mode === 'unchanged') {
      await pending;
      expect(publish).toHaveBeenCalledExactlyOnceWith({ ...exported, version, mimeType: metadata.mimeType });
      expect(discard).not.toHaveBeenCalled();
    } else {
      await expect(pending).rejects.toThrow(mode === 'denied' ? 'DENIED' : mode === 'cancelled' ? 'FILE_PEER_CANCELLED' : 'FILE_PEER_CHANGED');
      expect(publish).not.toHaveBeenCalled();
      expect(discard).toHaveBeenCalledExactlyOnceWith(exported);
    }
  });
  it('keeps the last good cache when a background export changes during revalidation', async () => {
    const cached = { ...metadata, version: 'a'.repeat(64), inlineBase64: 'b2xk' };
    const exported = { ossKey: 'export/changed', size: metadata.size, mimeType: metadata.mimeType };
    const discard = vi.fn(), retain = vi.fn();
    expect(await readDeviceFile({
      cacheFirst: { read: async () => cached, retain },
      prepare: async () => ({ ...metadata, version: 'b'.repeat(64) }),
      peer: async () => null, fallback: async () => exported,
      revalidate: async () => ({ ...metadata, version: 'c'.repeat(64) }), discard,
    })).toBe(cached);
    await vi.waitFor(() => expect(discard).toHaveBeenCalledExactlyOnceWith(exported));
    expect(retain).not.toHaveBeenCalled();
  });
  it.each(['text/html', 'text/css', 'application/javascript', 'text/plain', 'application/pdf', 'image/png', 'application/zip'])(
    'revalidates %s before reusing bytes and replaces changed versions', async (mimeType) => {
      let version = 'a'.repeat(64);
      let stored: DeviceFileResult | undefined;
      const prepare = vi.fn(async () => ({ ...metadata, size: 3, mimeType, version }));
      const inline = vi.fn(async () => ({ ossKey: '', size: 3, mimeType, version, inlineBase64: 'YWJj' }));
      const peer = vi.fn(), fallback = vi.fn();
      const inlineCache = {
        read: vi.fn(async (meta: DeviceFileResult) => stored?.version === meta.version ? stored! : null),
        store: vi.fn(async (result: DeviceFileResult) => { stored = result; }),
      };
      const options = { prepare, inline, peer, fallback, inlineCache };
      await readDeviceFile(options);
      await readDeviceFile(options);
      expect(prepare).toHaveBeenCalledTimes(2);
      expect(inline).toHaveBeenCalledOnce();
      version = 'b'.repeat(64);
      expect((await readDeviceFile(options)).version).toBe(version);
      expect(inline).toHaveBeenCalledTimes(2);
      prepare.mockRejectedValueOnce(new Error('DENIED'));
      await expect(readDeviceFile(options)).rejects.toThrow('DENIED');
      expect(inlineCache.read).toHaveBeenCalledTimes(3);
      expect(peer).not.toHaveBeenCalled();
      expect(fallback).not.toHaveBeenCalled();
    },
  );
  it('does not deliver a cache hit after cancellation or fail a read when the cache fails', async () => {
    const abort = new AbortController();
    const result = { ossKey: '', size: 3, mimeType: 'text/plain', version: 'a'.repeat(64), inlineBase64: 'YWJj' };
    const inline = vi.fn(async () => result);
    const options = {
      prepare: async () => ({ ...result, inlineBase64: undefined, transferRequired: true }),
      inline, peer: vi.fn(), fallback: vi.fn(), signal: abort.signal,
      inlineCache: { read: vi.fn(async () => { abort.abort(); return result; }), store: vi.fn() },
    };
    await expect(readDeviceFile(options)).rejects.toThrow('FILE_PEER_CANCELLED');
    expect(inline).not.toHaveBeenCalled();
    options.inlineCache.read.mockRejectedValueOnce(new Error('disk unavailable'));
    options.inlineCache.store.mockRejectedValueOnce(new Error('disk full'));
    expect(await readDeviceFile({ ...options, signal: undefined })).toBe(result);
  });
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
