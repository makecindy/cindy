// @vitest-environment jsdom
import { act, createElement, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useConversationShareImages } from "@/session/useConversationShareImages";
import type { ConversationShareMessage } from "@/session/conversationShareWebViewHtml";
import type { ResolveRemoteMediaFn } from "@/session/remoteMedia";
import { downloadRemoteMediaAsDataUri } from "@/session/remoteMediaDiskCacheExpo";
import { createRemoteMediaResolveQueue } from "@/session/remoteMediaResolveQueue";

vi.mock("react-native", () => ({
  Image: { getSize: vi.fn(async () => ({ width: 40, height: 20 })) },
}));
const thumbs = vi.hoisted(() => ({
  entries: new Map<string, string>(),
  reads: vi.fn(async () => "aGVsbG8="),
}));
vi.mock("expo-file-system", () => ({
  File: class {
    exists = true;
    size = 5;
    base64 = thumbs.reads;
  },
}));
vi.mock("@/session/sentAttachmentThumbStore", () => ({
  ensureSentAttachmentThumbsHydrated: vi.fn(async () => undefined),
  getSentAttachmentThumbUri: (uri: string) => thumbs.entries.get(uri) ?? null,
}));
vi.mock("@/session/remoteMediaDiskCacheExpo", () => ({
  downloadRemoteMediaAsDataUri: vi.fn(),
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
afterEach(async () => {
  await act(async () => root.unmount());
  vi.useRealTimers();
  thumbs.entries.clear();
  thumbs.reads.mockClear();
  vi.mocked(downloadRemoteMediaAsDataUri).mockReset();
  root = createRoot(container);
});

describe("share image readiness", () => {
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
    expect(downloadRemoteMediaAsDataUri).not.toHaveBeenCalled();
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
      vi.mocked(downloadRemoteMediaAsDataUri).mockResolvedValue(media.url);
      await act(async () =>
        root.render(createElement(Probe, { messages: [source], resolve })),
      );
      await startShare();
      expect((await ready)[0]?.images?.size).toBe(size === 5 ? 1 : 0);
      expect(downloadRemoteMediaAsDataUri).toHaveBeenCalledTimes(
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
      expect(downloadRemoteMediaAsDataUri).not.toHaveBeenCalled();
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
    expect(downloadRemoteMediaAsDataUri).not.toHaveBeenCalled();
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
