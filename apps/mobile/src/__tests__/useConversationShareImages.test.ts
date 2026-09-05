// @vitest-environment jsdom
import { act, createElement, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useConversationShareImages } from "@/session/useConversationShareImages";
import type { ConversationShareMessage } from "@/session/conversationShareWebViewHtml";
import type { ResolveRemoteMediaFn } from "@/session/remoteMedia";

vi.mock("react-native", () => ({
  Image: { getSize: vi.fn(async () => ({ width: 40, height: 20 })) },
}));
const thumbs = vi.hoisted(() => ({
  entries: new Map<string, string>(),
  version: 0,
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
  useSentAttachmentThumbsVersion: () => thumbs.version,
  getSentAttachmentThumbUri: (uri: string) => thumbs.entries.get(uri) ?? null,
}));
vi.mock("@/session/remoteMediaDiskCacheExpo", () => ({
  downloadRemoteMediaAsDataUri: vi.fn(),
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const container = document.createElement("div");
let root = createRoot(container);
let current!: ReturnType<typeof useConversationShareImages>;
function Probe({
  messages,
  resolve,
}: {
  messages: ConversationShareMessage[];
  resolve: ResolveRemoteMediaFn;
}) {
  current = useConversationShareImages(messages, resolve, {
    sessionId: "session",
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
  thumbs.version = 0;
  thumbs.reads.mockClear();
  root = createRoot(container);
});

describe("share image readiness", () => {
  it.each([
    "cindy-oss-attach://upload/paste",
    "xdt-oss-attach://upload/paste",
    "cindy-media://blobs/paste",
    "xdt-image://paste",
  ])(
    "refreshes %s when its existing upload thumbnail becomes available",
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
      const oldReady = current.ready;
      expect((await oldReady)[0]?.images?.size).toBe(0);
      expect(thumbs.reads).not.toHaveBeenCalled();
      resolve.mockClear();
      thumbs.entries.set(uri, "file:///app/sent-attachment-thumbs/paste.png");
      thumbs.version++;
      await act(async () => root.render(render()));
      expect(current.ready).not.toBe(oldReady);
      const result = await current.ready;
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
    expect(
      (await current.ready)[0]?.images?.get("cindy-media://paste")?.uri,
    ).toBe(media.url);
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it("keeps text and completed images when another image times out, ignoring its late result", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
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
              attachments: [
                ...source.attachments!,
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
              ],
            },
            {
              clientId: "next",
              kind: "assistant",
              body: "keep the next message",
            },
          ],
          resolve,
        }),
      ),
    );
    const ready = current.ready;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });
    const result = await ready;
    expect(result.map((message) => message.body)).toEqual([
      "keep this text",
      "keep the next message",
    ]);
    expect(result[0]?.images?.size).toBe(1);
    expect(result[0]?.images?.get("cindy-media://paste")?.uri).toBe(media.url);
    expect(result[0]?.attachments?.[1]?.name).toBe("slow image");
    expect(resolve).toHaveBeenCalledTimes(2);
    await act(async () =>
      finish({ ...media, url: "data:image/png;base64,bGF0ZQ==" }),
    );
    expect(current.messages).toBe(result);
    expect(result[0]?.images?.size).toBe(1);
  });

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
    const ready = current.ready;
    await act(async () => root.render(render()));
    expect(current.ready).toBe(ready);
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
    const oldReady = current.ready;
    await act(async () =>
      root.render(
        createElement(Probe, {
          messages: [{ clientId: "next", kind: "assistant", body: "next" }],
          resolve,
        }),
      ),
    );
    expect(await oldReady).toEqual([]);
    await act(async () => finish(media));
    expect((await current.ready).map((message) => message.clientId)).toEqual([
      "next",
    ]);
    expect(current.messages[0]?.images?.size).toBe(0);
  });
});
