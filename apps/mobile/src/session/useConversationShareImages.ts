import { useCallback, useEffect, useRef, useState } from "react";
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
import {
  getSentAttachmentThumbUri,
  ensureSentAttachmentThumbsHydrated,
} from "@/session/sentAttachmentThumbStore";

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

async function readShareImageFile(
  uri: string,
  mimeType: string,
): Promise<string | null> {
  const file = new File(uri);
  if (!file.exists || file.size <= 0 || file.size > MAX_IMAGE_BYTES)
    return null;
  return `data:${mimeType};base64,${await file.base64()}`;
}

async function loadShareImage(
  url: string,
  resolve: ResolveRemoteMediaFn,
): Promise<ConversationShareImage | null> {
  // The existing store owns both OSS and desktop-media upload thumbnails.
  await ensureSentAttachmentThumbsHydrated();
  const localThumb = getSentAttachmentThumbUri(url);
  let uri = localThumb
    ? ((await readShareImageFile(
        localThumb,
        imageMimeFromUrl(localThumb) ?? "image/jpeg",
      ).catch(() => null)) ?? url)
    : url;
  let mimeType = imageMimeFromUrl(uri) ?? "image/jpeg";
  if (uri === url && isDesktopLocalMediaUrl(url)) {
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
    // Other local files must come from the controlled media resolver.
    uri = (await readShareImageFile(uri, mimeType)) ?? "";
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

interface ShareImageJob {
  sourceMessages: readonly ConversationShareMessage[];
  resolve: ResolveRemoteMediaFn;
  context: ConversationShareImageContext;
  finish: (messages: readonly ConversationShareMessage[]) => void;
}

/** Prepare one click-time snapshot; live message updates cannot replace it. */
export function useConversationShareImages(
  messages: readonly ConversationShareMessage[],
  resolve: ResolveRemoteMediaFn,
  { workdir, remoteHostId, sessionId }: ConversationShareImageContext,
) {
  const [job, setJob] = useState<ShareImageJob | null>(null);
  const prepare = useCallback(() => {
    return new Promise<readonly ConversationShareMessage[]>((finish) => {
      setJob({
        sourceMessages: messages,
        resolve,
        context: { workdir, remoteHostId, sessionId },
        finish,
      });
    });
  }, [messages, resolve, workdir, remoteHostId, sessionId]);
  const cancel = useCallback(() => setJob(null), []);
  const selectionKey = JSON.stringify(
    messages.map((message) => message.clientId),
  );
  useEffect(cancel, [cancel, selectionKey, sessionId]);
  const revision = useRef(0);
  const activeJob = useRef<typeof job | null>(null);
  const [prepared, setPrepared] = useState<{
    job: typeof job;
    messages: readonly ConversationShareMessage[];
    revision: number;
  } | null>(null);
  useEffect(() => {
    if (!job) return;
    const { sourceMessages, resolve, context } = job;
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
      context,
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
  }, [job]);
  useEffect(() => {
    if (job && prepared?.job === job) job.finish(prepared.messages);
  }, [job, prepared]);
  return {
    prepare,
    cancel,
    messages: prepared?.job === job ? prepared.messages : [],
    revision: prepared?.job === job ? prepared.revision : 0,
  };
}
