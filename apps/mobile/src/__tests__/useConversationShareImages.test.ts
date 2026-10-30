// @vitest-environment jsdom
import { act, createElement, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Image } from "react-native";
import { File } from "expo-file-system";
import { useConversationShareImages } from "@/session/useConversationShareImages";
import type { ConversationShareMessage } from "@/session/conversationShareWebViewHtml";
import type { ResolveRemoteMediaFn } from "@/session/remoteMedia";
import { withDownloadedRemoteMediaFile } from "@/session/remoteMediaDiskCacheExpo";
import { createRemoteMediaResolveQueue } from "@/session/remoteMediaResolveQueue";

vi.mock("react-native", () => ({
  Image: { getSize: vi.fn() },
}));
const thumbs = vi.hoisted(() => ({
  entries: new Map<string, string>(),
  reads: vi.fn(async () => "aGVsbG8="),
  writes: vi.fn(async () => undefined),
  deletes: vi.fn(),
  size: 5,
}));
vi.mock("expo-file-system", () => ({
  Paths: { cache: "file:///app/cache" },
  Directory: class {
    uri: string;
    constructor(parent: string, name: string) {
      this.uri = `${parent}/${name}`;
    }
    create() {}
  },
  File: class {
    uri: string;
    constructor(parent: string | { uri: string }, name?: string) {
      this.uri = typeof parent === "string" ? parent : parent.uri;
      if (name) this.uri += `/${name}`;
    }
    exists = true;
    get size() { return thumbs.size; }
    base64 = thumbs.reads;
    delete() { thumbs.deletes(this.uri); }
  },
}));
vi.mock("expo-file-system/legacy", () => ({
  writeAsStringAsync: thumbs.writes,
  EncodingType: { Base64: "base64" },
}));
vi.mock("@/session/sentAttachmentThumbStore", () => ({
  ensureSentAttachmentThumbsHydrated: vi.fn(async () => undefined),
  getSentAttachmentThumbUri: (uri: string) => thumbs.entries.get(uri) ?? null,
}));
vi.mock("@/session/remoteMediaDiskCacheExpo", () => ({
  withDownloadedRemoteMediaFile: vi.fn(),
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const container = document.createElement("div");
let root = createRoot(container);
let current!: ReturnType<typeof useConversationShareImages>;
let ready!: Promise<readonly ConversationShareMessage[]>;
async function startShare() {
  await act(async () => {
    ready = current.prepare();
  });
}
function Probe({
  messages,
  resolve,
  sessionId = "session",
}: {
  messages: ConversationShareMessage[];
  resolve: ResolveRemoteMediaFn;
  sessionId?: string;
}) {
  current = useConversationShareImages(messages, resolve, {
    sessionId,
  });
  return null;
}
const source: ConversationShareMessage = {
  clientId: "user",
  kind: "user",
  body: "",
  attachments: [{ kind: "image", name: "paste", uri: "cindy-media://paste" }],
};
const media = {
  url: "data:image/png;base64,aGVsbG8=",
  mimeType: "image/png",
  size: 5,
  ossKey: "",
  expiresAt: "",
  previewable: true,
};
beforeEach(() => {
  vi.mocked(Image.getSize).mockReset().mockImplementation(async (uri) => {
    if (!uri.startsWith("file://")) {
      throw new Error("Unsupported uri scheme for encoded image fetch!");
    }
    return { width: 40, height: 20 };
  });
  thumbs.size = 5;
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.useRealTimers();
  thumbs.entries.clear();
  thumbs.reads.mockClear();
  thumbs.writes.mockReset();
  thumbs.deletes.mockReset();
  vi.mocked(withDownloadedRemoteMediaFile).mockReset();
  root = createRoot(container);
});

describe("share image readiness", () => {
  it("sizes a controlled local file before embedding its bytes", async () => {
    const uri = "file:///app/cache/remote.png";
    const resolve = vi.fn<ResolveRemoteMediaFn>(async () => ({ ...media, url: uri }));
    await act(async () => root.render(createElement(Probe, { messages: [source], resolve })));
    await startShare();
    expect((await ready)[0]?.images?.get("cindy-media://paste")).toEqual({
      uri: media.url, width: 40, height: 20,
    });
    expect(Image.getSize).toHaveBeenCalledWith(uri);
    expect(vi.mocked(Image.getSize).mock.invocationCallOrder[0]).toBeLessThan(
      thumbs.reads.mock.invocationCallOrder[0]!,
    );
    expect(thumbs.writes).not.toHaveBeenCalled();
    expect(thumbs.deletes).not.toHaveBeenCalled();
  });

  it("sizes inline bytes via a temporary file and keeps the original data URI", async () => {
    const resolve = vi.fn<ResolveRemoteMediaFn>(async () => media);
    await act(async () => root.render(createElement(Probe, { messages: [source], resolve })));
    await startShare();
    expect((await ready)[0]?.images?.get("cindy-media://paste")).toEqual({
      uri: media.url, width: 40, height: 20,
    });
    const tempUri = vi.mocked(Image.getSize).mock.calls[0]![0];
    expect(tempUri).toMatch(/^file:\/\/\/app\/cache\/conversation-share-images\/image-.*\.png$/);
    expect(thumbs.writes).toHaveBeenCalledWith(tempUri, "aGVsbG8=", { encoding: "base64" });
    expect(thumbs.deletes).toHaveBeenCalledExactlyOnceWith(tempUri);
    expect(thumbs.reads).not.toHaveBeenCalled();
  });

  it.each([
    "data:image/png;charset=utf-8;base64,aGVsbG8=",
    "data:image/png;charset=utf-8;name=photo;BASE64,aGVsbG8%3D",
  ])("preserves MIME parameters and escaped Base64 in %s", async (uri) => {
    const resolve = vi.fn<ResolveRemoteMediaFn>(async () => ({ ...media, url: uri }));
    await act(async () => root.render(createElement(Probe, { messages: [source], resolve })));
    await startShare();
    expect((await ready)[0]?.images?.get("cindy-media://paste")).toEqual({
      uri, width: 40, height: 20,
    });
    const tempUri = vi.mocked(Image.getSize).mock.calls[0]![0];
    expect(tempUri).toMatch(/^file:\/\/\/app\/cache\/conversation-share-images\/image-.*\.png$/);
    expect(thumbs.writes).toHaveBeenCalledWith(tempUri, "aGVsbG8=", { encoding: "base64" });
    expect(thumbs.deletes).toHaveBeenCalledExactlyOnceWith(tempUri);
  });

  it.each([true, false])("preserves non-Base64 data images when native sizing supports them: %s", async (supported) => {
    const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jBvkAAAAASUVORK5CYII=";
    const encoded = Array.from(atob(png), (byte) => `%${byte.charCodeAt(0).toString(16).padStart(2, "0")}`).join("");
    const uri = `data:image/png,${encoded}`;
    if (supported) vi.mocked(Image.getSize).mockImplementationOnce(async () => ({ width: 1, height: 1 }));
    const message = { ...source, attachments: [{ kind: "image" as const, name: "pixel", uri }] };
    const resolve = vi.fn<ResolveRemoteMediaFn>();
    await act(async () => root.render(createElement(Probe, { messages: [message], resolve })));
    await startShare();
    expect((await ready)[0]?.images?.get(uri)).toEqual(supported ? { uri, width: 1, height: 1 } : undefined);
    expect(Image.getSize).toHaveBeenCalledWith(uri);
    expect(thumbs.writes).not.toHaveBeenCalled();
    expect(thumbs.deletes).not.toHaveBeenCalled();
    expect(resolve).not.toHaveBeenCalled();
  });

  it.each([
    ["cancel", "resolve"], ["cancel", "reject"],
    ["timeout", "resolve"], ["timeout", "reject"],
  ])("cleans a pending write on %s and again after its late %s", async (event, outcome) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const files = new Set<string>();
    let finish!: () => void;
    let tempUri!: string;
    thumbs.deletes.mockImplementation((uri: string) => { files.delete(uri); });
    thumbs.writes.mockImplementationOnce((...args: unknown[]) => {
      tempUri = args[0] as string;
      files.add(tempUri);
      return new Promise<undefined>((resolve, reject) => {
        finish = () => {
          // The native writer can create or finish a partial file after cancellation.
          files.add(tempUri);
          if (outcome === "resolve") resolve(undefined);
          else reject(new Error("late write failed"));
        };
      });
    });
    const resolve = vi.fn<ResolveRemoteMediaFn>(async () => media);
    await act(async () => root.render(createElement(Probe, { messages: [source], resolve })));
    await startShare();
    expect(files.has(tempUri)).toBe(true);
    await act(async () => {
      if (event === "cancel") current.cancel();
      else await vi.advanceTimersByTimeAsync(20_000);
    });
    const result = await ready;
    expect(event === "cancel" ? result.length : result[0]?.images?.size).toBe(0);
    expect(files.size).toBe(0);
    expect(thumbs.deletes).toHaveBeenCalledExactlyOnceWith(tempUri);
    await act(async () => finish());
    expect(files.size).toBe(0);
    expect(thumbs.deletes).toHaveBeenCalledTimes(2);
    expect(Image.getSize).not.toHaveBeenCalled();
    expect(thumbs.reads).not.toHaveBeenCalled();
  });

  it.each(["error", "cancel", "timeout"])("cleans inline sizing files on %s", async (event) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let finish!: (size: { width: number; height: number }) => void;
    if (event === "error") {
      vi.mocked(Image.getSize).mockRejectedValueOnce(new Error("invalid image"));
    } else {
      vi.mocked(Image.getSize).mockImplementationOnce(() => new Promise<{ width: number; height: number }>((done) => { finish = done; }));
    }
    const resolve = vi.fn<ResolveRemoteMediaFn>(async () => media);
    await act(async () => root.render(createElement(Probe, { messages: [source], resolve })));
    await startShare();
    const tempUri = vi.mocked(Image.getSize).mock.calls[0]![0];
    await act(async () => {
      if (event === "cancel") current.cancel();
      if (event === "timeout") await vi.advanceTimersByTimeAsync(20_000);
    });
    const result = await ready;
    expect(event === "cancel" ? result.length : result[0]?.images?.size).toBe(0);
    expect(thumbs.deletes).toHaveBeenCalledExactlyOnceWith(tempUri);
    if (finish) await act(async () => finish({ width: 40, height: 20 }));
    expect(event === "cancel" ? current.messages.length : current.messages[0]?.images?.size).toBe(0);
  });

  it("cleans a partial inline write without trying to size it", async () => {
    thumbs.writes.mockRejectedValueOnce(new Error("disk full"));
    const resolve = vi.fn<ResolveRemoteMediaFn>(async () => media);
    await act(async () => root.render(createElement(Probe, { messages: [source], resolve })));
    await startShare();
    expect((await ready)[0]?.images?.size).toBe(0);
    expect(Image.getSize).not.toHaveBeenCalled();
    expect(thumbs.deletes).toHaveBeenCalledOnce();
  });

  it.each([0, 8 * 1024 * 1024 + 1])("rejects an inline file of %s bytes before native sizing", async (size) => {
    thumbs.size = size;
    const resolve = vi.fn<ResolveRemoteMediaFn>(async () => media);
    await act(async () => root.render(createElement(Probe, { messages: [source], resolve })));
    await startShare();
    expect((await ready)[0]?.images?.size).toBe(0);
    expect(Image.getSize).not.toHaveBeenCalled();
    expect(thumbs.deletes).toHaveBeenCalledOnce();
  });

  it.each(["timeout", "cancel", "selection", "session", "unmount"])(
    "removes queued media work on %s before a free slot can start it",
    async (event) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      let finish!: (value: typeof media) => void;
      const fetch = vi.fn(
        () =>
          new Promise<typeof media>((done) => {
            finish = done;
          }),
      );
      const queue = createRemoteMediaResolveQueue(
        { resolve: fetch },
        { maxConcurrent: 1 },
      );
      const busy = queue.request({ kind: "image", url: "cindy-media://busy" });
      const resolve: ResolveRemoteMediaFn = (request, opts) =>
        queue.request(request, opts);
      await act(async () =>
        root.render(createElement(Probe, { messages: [source], resolve })),
      );
      await startShare();
      expect(queue.stats()).toEqual({ inFlight: 1, queued: 1 });
      await act(async () => {
        if (event === "timeout") await vi.advanceTimersByTimeAsync(20_000);
        if (event === "cancel") current.cancel();
        if (event === "selection")
          root.render(createElement(Probe, { messages: [], resolve }));
        if (event === "session")
          root.render(
            createElement(Probe, {
              messages: [source],
              resolve,
              sessionId: "next",
            }),
          );
        if (event === "unmount") root.render(null);
      });
      expect(queue.stats().queued).toBe(0);
      expect((await ready).length).toBe(event === "timeout" ? 1 : 0);
      await act(async () => {
        finish(media);
        await busy;
      });
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(queue.stats()).toEqual({ inFlight: 0, queued: 0 });
    },
  );

  it("cancels only the share waiter while a shared queued consumer still completes", async () => {
    let finish!: (value: typeof media) => void;
    const fetch = vi.fn(async ({ url }: { url: string }) =>
      url.endsWith("busy")
        ? new Promise<typeof media>((done) => {
            finish = done;
          })
        : media,
    );
    const queue = createRemoteMediaResolveQueue(
      { resolve: fetch },
      { maxConcurrent: 1 },
    );
    const busy = queue.request({ kind: "image", url: "cindy-media://busy" });
    const resolve: ResolveRemoteMediaFn = (request, opts) =>
      queue.request(request, opts);
    await act(async () =>
      root.render(createElement(Probe, { messages: [source], resolve })),
    );
    await startShare();
    const other = queue.request({
      kind: "image",
      url: "cindy-media://paste",
      thumbnail: true,
    });
    await act(async () => current.cancel());
    expect(await ready).toEqual([]);
    expect(queue.stats().queued).toBe(1);
    await act(async () => {
      finish(media);
      await busy;
      await other;
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("keeps direct HTTP images as placeholders without starting a download", async () => {
    const resolve = vi.fn<ResolveRemoteMediaFn>();
    const url = "https://example.com/unbounded.png";
    await act(async () =>
      root.render(
        createElement(Probe, {
          messages: [
            {
              ...source,
              body: `![preview](${url})`,
              attachments: [{ kind: "image", name: "remote", uri: url }],
            },
          ],
          resolve,
        }),
      ),
    );
    await startShare();
    expect((await ready)[0]?.images?.size).toBe(0);
    expect(resolve).not.toHaveBeenCalled();
    expect(withDownloadedRemoteMediaFile).not.toHaveBeenCalled();
  });

  it.each([5, 0, -1, NaN, Infinity, 8 * 1024 * 1024 + 1])(
    "downloads controlled images only with a valid known size (%s)",
    async (size) => {
      const url = "https://example.com/controlled.png";
      const resolve = vi.fn<ResolveRemoteMediaFn>(async () => ({
        ...media,
        size,
        url,
      }));
      vi.mocked(withDownloadedRemoteMediaFile).mockImplementation(async (_url, _mime, _maxBytes, read) => read(new File("file:///app/cache/download.png")));
      await act(async () =>
        root.render(createElement(Probe, { messages: [source], resolve })),
      );
      await startShare();
      expect((await ready)[0]?.images?.size).toBe(size === 5 ? 1 : 0);
      expect(withDownloadedRemoteMediaFile).toHaveBeenCalledTimes(
        size === 5 ? 1 : 0,
      );
    },
  );

  it.each([
    "cindy-oss-attach://upload/paste",
    "xdt-oss-attach://upload/paste",
    "cindy-media://blobs/paste",
    "xdt-image://paste",
  ])(
    "reads the latest %s thumbnail on each share without background preparation",
    async (uri) => {
      const resolve = vi.fn<ResolveRemoteMediaFn>(async () => {
        throw new Error("desktop offline");
      });
      const messages: ConversationShareMessage[] = [
        {
          ...source,
          attachments: [
            { kind: "image", name: "paste", uri },
            {
              kind: "image",
              name: "untrusted",
              uri: "file:///private/image.png",
            },
          ],
        },
      ];
      const render = () => createElement(Probe, { messages, resolve });
      await act(async () => root.render(render()));
      expect(resolve).not.toHaveBeenCalled();
      await startShare();
      const oldReady = ready;
      expect((await oldReady)[0]?.images?.size).toBe(0);
      expect(thumbs.reads).not.toHaveBeenCalled();
      resolve.mockClear();
      thumbs.entries.set(uri, "file:///app/sent-attachment-thumbs/paste.png");
      await act(async () => root.render(render()));
      await startShare();
      expect(ready).not.toBe(oldReady);
      const result = await ready;
      expect(result[0]?.images?.get(uri)?.uri).toBe(media.url);
      expect(result[0]?.images?.size).toBe(1);
      expect(result[0]?.attachments?.[0]?.uri).toBe(uri);
      expect(thumbs.reads).toHaveBeenCalledTimes(1);
      expect(Image.getSize).toHaveBeenCalledWith("file:///app/sent-attachment-thumbs/paste.png");
      expect(thumbs.writes).not.toHaveBeenCalled();
      expect(thumbs.deletes).not.toHaveBeenCalled();
      expect(resolve).not.toHaveBeenCalled();
    },
  );

  it("falls back to the controlled resolver if a registered thumbnail cannot be read", async () => {
    thumbs.entries.set(
      "cindy-media://paste",
      "file:///app/sent-attachment-thumbs/paste.png",
    );
    thumbs.reads.mockRejectedValueOnce(new Error("file removed"));
    const resolve = vi.fn<ResolveRemoteMediaFn>(async () => media);
    await act(async () =>
      root.render(createElement(Probe, { messages: [source], resolve })),
    );
    await startShare();
    expect((await ready)[0]?.images?.get("cindy-media://paste")?.uri).toBe(
      media.url,
    );
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])(
    "keeps later local images across messages when a remote source stalls (reverse=%s)",
    async (reverse) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      thumbs.entries.set(
        "cindy-media://remaining",
        "file:///app/remaining.png",
      );
      thumbs.entries.set("cindy-media://next", "file:///app/next.png");
      let finish!: (value: typeof media) => void;
      const resolve = vi.fn<ResolveRemoteMediaFn>(async ({ url }) => {
        if (url === "cindy-media://paste") return media;
        return new Promise((done) => {
          finish = done;
        });
      });
      await act(async () =>
        root.render(
          createElement(Probe, {
            messages: [
              {
                ...source,
                body: "keep this text",
                attachments: (reverse
                  ? [
                      {
                        kind: "image",
                        name: "slow image",
                        uri: "cindy-media://slow",
                      },
                      {
                        kind: "image",
                        name: "remaining image",
                        uri: "cindy-media://remaining",
                      },
                      ...source.attachments!,
                    ]
                  : [
                      ...source.attachments!,
                      {
                        kind: "image" as const,
                        name: "slow image",
                        uri: "cindy-media://slow",
                      },
                      {
                        kind: "image" as const,
                        name: "remaining image",
                        uri: "cindy-media://remaining",
                      },
                    ]) as ConversationShareMessage["attachments"],
              },
              {
                clientId: "next",
                kind: "assistant",
                body: "keep the next message",
                attachments: [
                  { kind: "image", name: "next", uri: "cindy-media://next" },
                ],
              },
            ],
            resolve,
          }),
        ),
      );
      await startShare();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(20_000);
      });
      const result = await ready;
      expect(result.map((message) => message.body)).toEqual([
        "keep this text",
        "keep the next message",
      ]);
      expect(result[0]?.images?.size).toBe(2);
      expect(result[1]?.images?.size).toBe(1);
      expect(result[0]?.images?.get("cindy-media://paste")?.uri).toBe(
        media.url,
      );
      expect(
        result[0]?.attachments?.find(
          (attachment) => attachment.uri === "cindy-media://slow",
        )?.name,
      ).toBe("slow image");
      expect(resolve).toHaveBeenCalledTimes(2);
      await act(async () =>
        finish({ ...media, url: "https://example.com/late.png" }),
      );
      expect(current.messages).toBe(result);
      expect(result[0]?.images?.size).toBe(2);
      expect(withDownloadedRemoteMediaFile).not.toHaveBeenCalled();
    },
  );

  it("survives StrictMode and unrelated rerenders while a remote image loads", async () => {
    let finish!: (value: typeof media) => void;
    const pending = new Promise<typeof media>((done) => {
      finish = done;
    });
    const resolve = vi.fn(() => pending);
    const render = () =>
      createElement(
        StrictMode,
        null,
        createElement(Probe, {
          messages: [
            {
              ...source,
              attachments: source.attachments?.map((a) => ({ ...a })),
            },
          ],
          resolve,
        }),
      );
    await act(async () => root.render(render()));
    await startShare();
    await act(async () => root.render(render()));
    await act(async () => finish(media));
    expect((await ready)[0]?.images?.get("cindy-media://paste")?.uri).toBe(
      media.url,
    );
    expect(current.messages).toHaveLength(1);
  });

  it("cancels the previous selection and ignores its late image result", async () => {
    let finish!: (value: typeof media) => void;
    const resolve = vi.fn(
      () =>
        new Promise<typeof media>((done) => {
          finish = done;
        }),
    );
    await act(async () =>
      root.render(createElement(Probe, { messages: [source], resolve })),
    );
    await startShare();
    const oldReady = ready;
    await act(async () =>
      root.render(
        createElement(Probe, {
          messages: [{ clientId: "next", kind: "assistant", body: "next" }],
          resolve,
        }),
      ),
    );
    expect(await oldReady).toEqual([]);
    await act(async () =>
      finish({ ...media, url: "https://example.com/cancelled.png" }),
    );
    expect(withDownloadedRemoteMediaFile).not.toHaveBeenCalled();
    await startShare();
    expect((await ready).map((message) => message.clientId)).toEqual(["next"]);
    expect(current.messages[0]?.images?.size).toBe(0);
  });

  it("retains the clicked snapshot through streaming and thumbnail updates", async () => {
    let finish!: (value: typeof media) => void;
    const resolve = vi.fn<ResolveRemoteMediaFn>(
      () =>
        new Promise((done) => {
          finish = done;
        }),
    );
    await act(async () =>
      root.render(
        createElement(Probe, {
          messages: [{ ...source, body: "clicked text" }],
          resolve,
        }),
      ),
    );
    await startShare();
    const clickedReady = ready;
    thumbs.entries.set(
      "cindy-media://paste",
      "file:///app/sent-attachment-thumbs/new.png",
    );
    await act(async () =>
      root.render(
        createElement(Probe, {
          messages: [{ ...source, body: "later streamed text" }],
          resolve,
        }),
      ),
    );
    await act(async () => finish(media));
    const snapshot = await clickedReady;
    expect(snapshot[0]?.body).toBe("clicked text");
    expect(snapshot[0]?.images?.get("cindy-media://paste")?.uri).toBe(
      media.url,
    );
    expect(current.messages).toBe(snapshot);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(thumbs.reads).not.toHaveBeenCalled();
    await startShare();
    expect((await ready)[0]?.body).toBe("later streamed text");
    expect(thumbs.reads).toHaveBeenCalledTimes(1);
  });
});
