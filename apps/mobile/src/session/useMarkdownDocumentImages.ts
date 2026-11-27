/**
 * useMarkdownDocumentImages — progressive remote image loader and ImageLightbox
 * gallery builder for Markdown files previewed on Mobile.
 *
 * Inline WebView previews request `thumbnail: true` (1024px WebP inline base64
 * from Desktop mediaFetch, zero OSS upload on current hosts) and fall back to
 * bounded data-URI download with guaranteed OSS cleanup on older hosts or
 * SVG/GIF assets. Tapping any image opens Mobile ImageLightbox with the inline
 * thumbnail as an instant backdrop while fetching the full-resolution original.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { MobileMakerTransport } from '@/device-link/mobileMakerTransport';
import { releasePeerMedia } from '@/device-link/peerFileRegistry';
import {
  createFileBrowserMediaResolver,
  type RemoteMediaSshContext,
} from '@/session/fileBrowserGallery';
import {
  appendRemoteMediaMaxBytes,
  buildMarkdownDocumentGallery,
  collectMarkdownDocumentImages,
  fetchMarkdownDocumentImages,
  planMarkdownDocumentImageFetches,
  type MarkdownImageResolution,
} from '@/session/markdownDocumentImages';
import type { MobileMessageGalleryImage } from '@/session/messageGallery';
import {
  resolveMobileRemoteMedia,
  type MobileRemoteMediaPresignResult,
  type ResolveRemoteMediaFn,
} from '@/session/remoteMedia';
import { downloadRemoteMediaAsDataUri } from '@/session/remoteMediaDiskCacheExpo';

export interface MarkdownLightboxSession {
  images: readonly MobileMessageGalleryImage[];
  initialUrl: string;
  initialImageKey: string;
  onResolveRemoteMedia: ResolveRemoteMediaFn;
}

export interface UseMarkdownDocumentImagesOptions {
  enabled: boolean;
  markdown: string;
  docAbsPath: string;
  versionMs?: number;
  deviceId: string;
  maker: Pick<MobileMakerTransport, 'fetchRemoteMedia'>;
  openLink(deviceId: string): Promise<unknown>;
  presignGet(ossKey: string): Promise<MobileRemoteMediaPresignResult>;
  deleteOssObject(ossKey: string): void;
  ssh: RemoteMediaSshContext | null;
}

export function useMarkdownDocumentImages({
  enabled,
  markdown,
  docAbsPath,
  versionMs,
  deviceId,
  maker,
  openLink,
  presignGet,
  deleteOssObject,
  ssh,
}: UseMarkdownDocumentImagesOptions): {
  resolvedImages: ReadonlyMap<string, MarkdownImageResolution>;
  buildLightboxSession: (imageIndex: number) => MarkdownLightboxSession | null;
} {
  const entries = useMemo(
    () => (enabled && markdown ? collectMarkdownDocumentImages(markdown, docAbsPath, { ssh, versionMs }) : []),
    [docAbsPath, enabled, markdown, ssh, versionMs],
  );
  const plan = useMemo(() => planMarkdownDocumentImageFetches(entries), [entries]);
  const [resolvedImages, setResolvedImages] = useState<ReadonlyMap<string, MarkdownImageResolution>>(
    () => new Map(),
  );
  const resolvedRef = useRef<ReadonlyMap<string, MarkdownImageResolution>>(resolvedImages);
  resolvedRef.current = resolvedImages;

  const fullOssKeysRef = useRef<Set<string>>(new Set());
  const deleteOssObjectRef = useRef(deleteOssObject);
  deleteOssObjectRef.current = deleteOssObject;

  // Clean up any OSS objects created while viewing full-resolution images in ImageLightbox.
  useEffect(() => {
    const keys = fullOssKeysRef.current;
    return () => {
      for (const key of keys) deleteOssObjectRef.current(key);
      keys.clear();
    };
  }, [deviceId, docAbsPath, markdown]);

  const fullImageResolver = useMemo<ResolveRemoteMediaFn>(
    () =>
      createFileBrowserMediaResolver({
        fetchRemoteMedia: async (url, opts) => {
          await openLink(deviceId);
          const result = await maker.fetchRemoteMedia(url, opts);
          if (result.ossKey) fullOssKeysRef.current.add(result.ossKey);
          return result;
        },
        presignGet,
      }),
    [deviceId, maker, openLink, presignGet],
  );

  useEffect(() => {
    if (!enabled || entries.length === 0) {
      setResolvedImages(new Map());
      return undefined;
    }

    let cancelled = false;
    const abort = new AbortController();
    const initial = new Map<string, MarkdownImageResolution>();
    for (const entry of entries) {
      if (entry.kind === 'unresolvable') {
        initial.set(entry.rawUrl, { status: 'error' });
      }
    }
    for (const rawUrl of plan.overLimitRawUrls) {
      initial.set(rawUrl, { status: 'deferred' });
    }
    setResolvedImages(initial);

    if (plan.targets.length === 0) {
      return undefined;
    }

    const fetchOne = async (
      target: { fetchUrl: string; mimeType: string },
      limits: { maxBytes: number },
    ): Promise<string | null> => {
      const ossKeys = new Set<string>();
      let peerUrlToRelease: string | null = null;
      const boundedPreviewUrl = appendRemoteMediaMaxBytes(target.fetchUrl, limits.maxBytes);
      try {
        const media = await resolveMobileRemoteMedia(
          { kind: 'image', url: boundedPreviewUrl },
          {
            fetchRemoteMedia: async (url, opts) => {
              await openLink(deviceId);
              return maker.fetchRemoteMedia(url, opts);
            },
            presignGet,
          },
          {
            thumbnail: true,
            signal: abort.signal,
            onOssKey: (key) => {
              if (key) ossKeys.add(key);
            },
          },
        );
        if (media.ossKey) ossKeys.add(media.ossKey);
        if (cancelled || abort.signal.aborted) return null;
        if (media.inlineBase64 && media.mimeType.startsWith('image/')) {
          return `data:${media.mimeType};base64,${media.inlineBase64}`;
        }
        if (media.url.startsWith('data:image/')) {
          return media.url;
        }
        if (media.url.startsWith('file://')) {
          peerUrlToRelease = media.url;
        }
        // Reject oversize fallback responses before starting an HTTP download
        // (e.g. older Desktop hosts that do not enforce `maxBytes`).
        if (media.size > limits.maxBytes) {
          return null;
        }
        const mime = media.mimeType.startsWith('image/') ? media.mimeType : target.mimeType;
        return await downloadRemoteMediaAsDataUri(media.url, mime, limits.maxBytes, abort.signal);
      } finally {
        if (peerUrlToRelease) releasePeerMedia(peerUrlToRelease);
        for (const key of ossKeys) deleteOssObjectRef.current(key);
      }
    };

    void fetchMarkdownDocumentImages(plan.targets, fetchOne, {
      isCancelled: () => cancelled,
      onResult: (rawUrl, resolution) => {
        if (cancelled) return;
        setResolvedImages((prev) => {
          const next = new Map(prev);
          next.set(rawUrl, resolution);
          return next;
        });
      },
    });

    return () => {
      cancelled = true;
      abort.abort();
    };
  }, [deviceId, enabled, entries, maker, openLink, plan, presignGet]);

  const buildLightboxSession = useCallback(
    (imageIndex: number): MarkdownLightboxSession | null => {
      const { images, keyForEntryIndex } = buildMarkdownDocumentGallery(entries, resolvedRef.current);
      const target = keyForEntryIndex(imageIndex);
      if (!target || images.length === 0) return null;
      return {
        images,
        initialUrl: target.url,
        initialImageKey: target.key,
        onResolveRemoteMedia: fullImageResolver,
      };
    },
    [entries, fullImageResolver],
  );

  return { resolvedImages, buildLightboxSession };
}
