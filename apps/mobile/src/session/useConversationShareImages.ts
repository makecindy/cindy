import { useCallback, useEffect, useRef, useState } from "react";
import { Image } from "react-native";
import { Directory, File, Paths } from "expo-file-system";
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
  isDirectPreviewableMediaUrl,
  type ResolveRemoteMediaFn,
} from "@/session/remoteMedia";
import { withDownloadedRemoteMediaFile } from "@/session/remoteMediaDiskCacheExpo";
import { extOfMime, imageMimeFromUrl } from "@/session/remoteMediaDiskCache";
import {
  getSentAttachmentThumbUri,
  ensureSentAttachmentThumbsHydrated,
} from "@/session/sentAttachmentThumbStore";

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

/** Decode one bounded first frame only when the user exports. Reuse the player
 * and image encoder already shipped with the app; no persistent thumbnail store. */
async function loadShareVideoCover(
  url: string,
  resolve: ResolveRemoteMediaFn,
  canRead: () => boolean,
  signal: AbortSignal,
): Promise<ConversationShareImage | null> {
  if (!canRead()) return null;
  let uri = url;
  let releaseSource: (() => void) | undefined;
  if (!isDirectPreviewableMediaUrl(url)) {
    const media = await resolve(
      { kind: "video", url, previewable: false },
      { signal },
    );
    if (
      !canRead() ||
      !media.previewable ||
      !media.mimeType.startsWith("video/")
    )
      return null;
    uri = media.url;
    releaseSource = media.protectLocalFile?.();
  }
  let player: import("expo-video").VideoPlayer | undefined;
  let thumbnail: import("expo-video").VideoThumbnail | undefined;
  let context:
    import("expo-image-manipulator").ImageManipulatorContext | undefined;
  let image: import("expo-image-manipulator").ImageRef | undefined;
  let savedUri: string | undefined;
  const deleteSavedFile = (uri: string) => {
    try { new File(uri).delete(); } catch { /* OS cache cleanup */ }
  };
  const release = () => {
    const resources = [image, context, thumbnail, player];
    image = undefined; context = undefined; thumbnail = undefined; player = undefined;
    for (const resource of resources) {
      try { resource?.release(); } catch { /* Already disposed by native cancellation. */ }
    }
    const releaseFile = releaseSource;
    releaseSource = undefined;
    releaseFile?.();
    if (savedUri) { deleteSavedFile(savedUri); savedUri = undefined; }
  };
  // Adopt a native result before completing the await. Cancellation owns all
  // adopted resources; results arriving after it are disposed without adoption.
  const take = <T,>(read: () => Promise<T>, adopt: (value: T) => void, discard: (value: T) => void) =>
    readWithShareImageCancellation(() => read().then(value => {
      if (signal.aborted) discard(value);
      else adopt(value);
    }), signal);
  signal.addEventListener("abort", release, { once: true });
  try {
    const { createVideoPlayer } = await import("expo-video");
    const { ImageManipulator, SaveFormat } =
      await import("expo-image-manipulator");
    if (!canRead()) return null;
    const currentPlayer = player = createVideoPlayer(null);
    currentPlayer.muted = true;
    await readWithShareImageCancellation(() => currentPlayer.replaceAsync(uri), signal);
    if (!canRead()) return null;
    await take(() => currentPlayer.generateThumbnailsAsync([0], {
      maxWidth: 1024,
      maxHeight: 1024,
    }), frames => { [thumbnail] = frames; }, frames => frames.forEach(frame => frame.release()));
    if (!thumbnail || !canRead()) return null;
    const currentContext = context = ImageManipulator.manipulate(thumbnail);
    await take(() => currentContext.renderAsync(), value => { image = value; }, value => value.release());
    if (!image || !canRead()) return null;
    let saved: import("expo-image-manipulator").ImageResult | undefined;
    const currentImage = image;
    await take(() => currentImage.saveAsync({
      format: SaveFormat.JPEG,
      compress: 0.85,
      base64: true,
    }), value => { saved = value; savedUri = value.uri; }, value => deleteSavedFile(value.uri));
    if (
      !canRead() ||
      !saved ||
      !saved.base64 ||
      saved.base64.length > (MAX_IMAGE_BYTES * 4) / 3
    )
      return null;
    return {
      uri: `data:image/jpeg;base64,${saved.base64}`,
      width: saved.width,
      height: saved.height,
    };
  } finally {
    signal.removeEventListener("abort", release);
    release();
  }
}

async function readWithShareImageCancellation<T>(
  read: () => Promise<T>,
  signal: AbortSignal,
) {
  if (signal.aborted) throw new Error("conversation share image cancelled");
  let onAbort!: () => void;
  const cancelled = new Promise<never>((_, reject) => {
    onAbort = () => reject(new Error("conversation share image cancelled"));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    // Native IO may outlive this export; let its owner clean up on cancellation.
    return await Promise.race([read(), cancelled]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

async function readShareImageFile(
  uri: string,
  mimeType: string,
  canRead: () => boolean,
  signal: AbortSignal,
  embeddedUri?: string,
): Promise<ConversationShareImage | null> {
  if (!canRead()) return null;
  const file = new File(uri);
  if (!file.exists || file.size <= 0 || file.size > MAX_IMAGE_BYTES)
    return null;
  // Android's encoded-image size reader accepts file:// but rejects data:.
  const size = await readWithShareImageCancellation(
    () => Image.getSize(uri),
    signal,
  );
  if (!canRead()) return null;
  const dataUri =
    embeddedUri ?? `data:${mimeType};base64,${await file.base64()}`;
  return canRead() ? { uri: dataUri, ...size } : null;
}

/** Stage Base64 only for sizing; retain other inline formats supported natively. */
async function readShareImageDataUri(
  uri: string,
  canRead: () => boolean,
  signal: AbortSignal,
): Promise<ConversationShareImage | null> {
  if (!canRead()) return null;
  const header = /^data:(image\/[^;,]+)(?:;[^,]*)?;base64,/i.exec(uri);
  if (!header) {
    // iOS can size other data-image encodings. Preserve that existing support;
    // an unsupported native format still follows the usual placeholder path.
    const size = await readWithShareImageCancellation(
      () => Image.getSize(uri),
      signal,
    );
    return canRead() ? { uri, ...size } : null;
  }
  if (uri.length === header[0].length) return null;
  const mimeType = header[1]!.toLowerCase();
  const base64 = decodeURIComponent(uri.slice(header[0].length));
  const directory = new Directory(Paths.cache, "conversation-share-images");
  let file: File | null = null;
  const cleanup = () => {
    try {
      file?.delete();
    } catch {
      // Best-effort cleanup within the OS cache, including partial writes.
    }
  };
  try {
    directory.create({ intermediates: true, idempotent: true });
    const unique = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    file = new File(directory, `image-${unique}.${extOfMime(mimeType)}`);
    const FileSystem = await import("expo-file-system/legacy");
    if (!canRead()) return null;
    const targetUri = file.uri;
    await readWithShareImageCancellation(() => {
      const write = FileSystem.writeAsStringAsync(targetUri, base64, {
        encoding: FileSystem.EncodingType.Base64,
      });
      // Cancellation cannot stop this native write. Clean up again if a late
      // completion recreates the file after the immediate finally cleanup.
      const cleanupLateWrite = () => {
        if (signal.aborted) cleanup();
      };
      void write.then(cleanupLateWrite, cleanupLateWrite);
      return write;
    }, signal);
    return await readShareImageFile(file.uri, mimeType, canRead, signal, uri);
  } finally {
    cleanup();
  }
}

async function loadShareImage(
  url: string,
  resolve: ResolveRemoteMediaFn,
  canRead: () => boolean,
  signal: AbortSignal,
): Promise<ConversationShareImage | null> {
  // The existing store owns both OSS and desktop-media upload thumbnails.
  await ensureSentAttachmentThumbsHydrated();
  if (!canRead()) return null;
  const localThumb = getSentAttachmentThumbUri(url);
  if (localThumb) {
    const image = await readShareImageFile(
      localThumb,
      imageMimeFromUrl(localThumb) ?? "image/jpeg",
      canRead,
      signal,
    ).catch(() => null);
    if (image) return image;
  }
  if (!canRead()) return null;
  let uri = url;
  let mimeType = imageMimeFromUrl(uri) ?? "image/jpeg";
  if (uri === url && isDesktopLocalMediaUrl(url)) {
    const media = await resolve(
      {
        kind: "image",
        url,
        previewable: true,
        thumbnail: true,
      },
      { signal },
    );
    if (
      !canRead() ||
      !media.mimeType.startsWith("image/") ||
      !Number.isFinite(media.size) ||
      media.size <= 0 ||
      media.size > MAX_IMAGE_BYTES
    )
      return null;
    uri = media.url;
    mimeType = media.mimeType;
    // Only download objects whose size the controlled desktop resolver knows.
    // Arbitrary HTTP sources have no trusted pre-transfer bound: keep alt text.
    if (/^https?:\/\//i.test(uri)) {
      return withDownloadedRemoteMediaFile(
        uri,
        mimeType,
        MAX_IMAGE_BYTES,
        (file) => readShareImageFile(file.uri, mimeType, canRead, signal),
      );
    }
  }
  if (uri.startsWith("file://") && isDesktopLocalMediaUrl(url)) {
    // Other local files must come from the controlled media resolver.
    return readShareImageFile(uri, mimeType, canRead, signal);
  }
  if (
    !canRead() ||
    !uri.startsWith("data:image/") ||
    uri.length > (MAX_IMAGE_BYTES * 4) / 3 + 128
  )
    return null;
  return readShareImageDataUri(uri, canRead, signal);
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
  {
    workdir,
    remoteHostId,
    sessionId,
    snapshotRichValues,
  }: ConversationShareImageContext,
) {
  const [job, setJob] = useState<ShareImageJob | null>(null);
  const prepare = useCallback(() => {
    return new Promise<readonly ConversationShareMessage[]>((finish) => {
      setJob({
        sourceMessages: messages.map((message) =>
          message.kind === "assistant" && snapshotRichValues
            ? { ...message, richValues: snapshotRichValues(message) }
            : message,
        ),
        resolve,
        context: { workdir, remoteHostId, sessionId },
        finish,
      });
    });
  }, [messages, resolve, workdir, remoteHostId, sessionId, snapshotRichValues]);
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
    // The existing media queue removes this export's still-queued waiter.
    // Effect-local ownership also gives StrictMode replays a fresh signal.
    const controller = new AbortController();
    let active = true;
    activeJob.current = job;
    let timedOut = false;
    let finishImageWait!: (image: null) => void;
    const imageDeadline = new Promise<null>((done) => {
      finishImageWait = done;
    });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      finishImageWait(null);
    }, 20_000);
    void prepareConversationShareImages(
      sourceMessages,
      // Keep completed images and all message text when the shared deadline
      // expires. Remaining images become placeholders without starting more IO.
      (url, kind) =>
        timedOut
          ? Promise.resolve(null)
          : Promise.race([
              (kind === "video" ? loadShareVideoCover : loadShareImage)(
                url,
                resolve,
                () => active && !timedOut,
                controller.signal,
              ),
              imageDeadline,
            ]),
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
      controller.abort();
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
