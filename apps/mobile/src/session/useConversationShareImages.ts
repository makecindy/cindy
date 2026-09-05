import { useEffect, useMemo, useRef, useState } from "react";
import { Image } from "react-native";
import { File } from "expo-file-system";
import {
  prepareConversationShareImages,
  type ConversationShareImageContext,
} from "@/session/conversationShareImages";
import type {
  ConversationShareImage,
  ConversationShareMessage,
} from "@/session/conversationShareWebViewHtml";
import {
  isDesktopLocalMediaUrl,
  type ResolveRemoteMediaFn,
} from "@/session/remoteMedia";
import { downloadRemoteMediaAsDataUri } from "@/session/remoteMediaDiskCacheExpo";
import { imageMimeFromUrl } from "@/session/remoteMediaDiskCache";

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

async function loadShareImage(
  url: string,
  resolve: ResolveRemoteMediaFn,
): Promise<ConversationShareImage | null> {
  let uri = url;
  let mimeType = imageMimeFromUrl(url) ?? "image/jpeg";
  if (isDesktopLocalMediaUrl(url)) {
    const media = await resolve({
      kind: "image",
      url,
      previewable: true,
      thumbnail: true,
    });
    if (!media.mimeType.startsWith("image/") || media.size > MAX_IMAGE_BYTES)
      return null;
    uri = media.url;
    mimeType = media.mimeType;
  }
  if (uri.startsWith("file://") && isDesktopLocalMediaUrl(url)) {
    // Only resolver-owned phone cache files may be read locally.
    const file = new File(uri);
    if (!file.exists || file.size <= 0 || file.size > MAX_IMAGE_BYTES)
      return null;
    uri = `data:${mimeType};base64,${await file.base64()}`;
  } else if (/^https?:\/\//i.test(uri)) {
    uri =
      (await downloadRemoteMediaAsDataUri(uri, mimeType, MAX_IMAGE_BYTES)) ??
      "";
  }
  if (
    !uri.startsWith("data:image/") ||
    uri.length > (MAX_IMAGE_BYTES * 4) / 3 + 128
  )
    return null;
  const size = await Image.getSize(uri);
  return { uri, width: size.width, height: size.height };
}

/** Resolve readiness after React commits the prepared SVG, including selection changes. */
export function useConversationShareImages(
  messages: readonly ConversationShareMessage[],
  resolve: ResolveRemoteMediaFn,
  { workdir, remoteHostId, sessionId }: ConversationShareImageContext,
) {
  // Unselected streaming messages recreate the projection array too. Keep the
  // selected content stable so they cannot cancel an in-flight image export.
  const sourceKey = JSON.stringify(messages);
  const sourceMessages = useMemo(
    () => JSON.parse(sourceKey) as ConversationShareMessage[],
    [sourceKey],
  );
  const job = useMemo(() => {
    let finish!: (messages: readonly ConversationShareMessage[]) => void;
    const ready = new Promise<readonly ConversationShareMessage[]>((done) => {
      finish = done;
    });
    return { ready, finish };
  }, [sourceMessages, resolve, workdir, remoteHostId, sessionId]);
  const revision = useRef(0);
  const activeJob = useRef<typeof job | null>(null);
  const [prepared, setPrepared] = useState<{
    job: typeof job;
    messages: readonly ConversationShareMessage[];
    revision: number;
  } | null>(null);
  useEffect(() => {
    let active = true;
    activeJob.current = job;
    let timedOut = false;
    let finishImageWait!: (image: null) => void;
    const imageDeadline = new Promise<null>((done) => {
      finishImageWait = done;
    });
    const timer = setTimeout(() => {
      timedOut = true;
      finishImageWait(null);
    }, 20_000);
    void prepareConversationShareImages(
      sourceMessages,
      // Keep completed images and all message text when the shared deadline
      // expires. Remaining images become placeholders without starting more IO.
      (url) =>
        timedOut
          ? Promise.resolve(null)
          : Promise.race([loadShareImage(url, resolve), imageDeadline]),
      { workdir, remoteHostId, sessionId },
      () => active,
    )
      .then((result) => {
        clearTimeout(timer);
        if (active)
          setPrepared({ job, messages: result, revision: ++revision.current });
      })
      .catch(() => {
        clearTimeout(timer);
        if (active)
          setPrepared({
            job,
            messages: sourceMessages,
            revision: ++revision.current,
          });
      });
    return () => {
      active = false;
      clearTimeout(timer);
      finishImageWait(null);
      activeJob.current = null;
      // StrictMode immediately replays this effect with the same job.
      queueMicrotask(() => {
        if (activeJob.current !== job) job.finish([]);
      });
    };
  }, [job, sourceMessages, resolve, workdir, remoteHostId, sessionId]);
  useEffect(() => {
    if (prepared?.job === job) job.finish(prepared.messages);
  }, [job, prepared]);
  return {
    ready: job.ready,
    messages: prepared?.job === job ? prepared.messages : [],
    revision: prepared?.job === job ? prepared.revision : 0,
  };
}
