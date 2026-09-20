import { expect, it, vi } from "vitest";
import { RemoteDesktopViewerMedia } from "../remoteDesktopViewerMedia";
import type { DesktopViewerRequest } from "../remoteDesktopViewerSession";

function viewer(lease: string, request: DesktopViewerRequest) {
  const send = vi.fn();
  const onOfferFailure = vi.fn();
  const state = {
    lease: {
      lease,
      controlling: false,
      display: { id: "screen", name: "Screen", width: 800, height: 600 },
    },
    caps: {
      version: 1 as const,
      enabled: true,
      platform: "linux" as const,
      canControl: false,
      displays: [],
    },
    settings: { fps: 30 as const, bitrate: 0 as const, audio: false },
  };
  const media = new RemoteDesktopViewerMedia({
    request,
    send,
    onOfferFailure,
    current: () => state,
    loadIce: async () => [],
  });
  return {
    media,
    send,
    onOfferFailure,
    offer: () =>
      media.handle({
        type: "offer",
        epoch: lease,
        attemptId: "attempt",
        sdp: "offer",
      }),
  };
}

it("keeps consent pending local to one viewer and leaves other signaling untouched", async () => {
  const transport = vi.fn(async (request: { lease?: string }) => {
    if (request.lease === "waiting") throw new Error("DESKTOP_CAPTURE_PENDING");
    return { sdp: "answer" };
  });
  const waiting = viewer("waiting", transport as DesktopViewerRequest);
  const other = viewer("other", transport as DesktopViewerRequest);
  await Promise.all([waiting.offer(), other.offer()]);
  expect(waiting.send).toHaveBeenCalledWith({
    type: "fallback",
    epoch: "waiting",
    attemptId: "attempt",
    retry: true,
    capturePending: true,
  });
  expect(waiting.onOfferFailure).not.toHaveBeenCalled();
  expect(other.send).toHaveBeenCalledWith({
    type: "answer",
    epoch: "other",
    attemptId: "attempt",
    sdp: "answer",
  });
  expect(transport).toHaveBeenCalledTimes(2);
});

it("does not classify an ordinary video failure as consent and discards a retired result", async () => {
  const request = vi.fn(async () => {
    throw new Error("DESKTOP_VIDEO_UNAVAILABLE");
  });
  const h = viewer("lease", request);
  await h.offer();
  expect(h.send).toHaveBeenLastCalledWith(
    expect.objectContaining({ capturePending: false }),
  );
  expect(h.onOfferFailure).toHaveBeenCalledOnce();
  h.send.mockClear();
  let reject!: (error: Error) => void;
  request.mockImplementationOnce(
    () =>
      new Promise<never>((_, no) => {
        reject = no;
      }),
  );
  const pending = h.offer();
  h.media.reset();
  reject(new Error("DESKTOP_CAPTURE_PENDING"));
  await pending;
  expect(h.send).not.toHaveBeenCalled();
  expect(h.onOfferFailure).toHaveBeenCalledOnce();
});
