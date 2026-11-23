/**
 * MarkdownImageLightboxHost
 *
 * Bridges the vanilla-DOM CodeMirror image widget (see
 * `markdownImageLivePreview.ts`) to the React `ImageLightbox` overlay.
 *
 * Same pattern as `MermaidLightboxHost`: the widget can't import React, so
 * it dispatches a CustomEvent on `window` when the user clicks a rendered
 * image; this component listens and mounts the lightbox. Mount once above
 * the editor — FileBodyView is the natural place.
 */

import { useEffect, useRef, useState } from 'react';

import { ImageLightbox, imageSourceSnapshotFields } from '@/components/chat/ImageLightbox';

import {
  MD_IMAGE_LIGHTBOX_EVENT,
  type MdImageLightboxOpenDetail,
} from './markdownImageLivePreview';

export function MarkdownImageLightboxHost({
  sessionId,
}: {
  /** 宿主会话 id:文件浏览器不在 ChatSessionFileContext provider 内,显式传给
   *  lightbox 才能启用"发送到对话"。不传则该动作不显示。 */
  sessionId?: string;
}) {
  const sessionRef = useRef(sessionId);
  sessionRef.current = sessionId;
  const [media, setMedia] = useState<{
    src: string;
    sessionId?: string;
    galleryId?: string;
    filename?: string;
    enableGallery?: boolean;
    annotationFallbackSrc?: string;
    autoAnnotate?: boolean;
    annotationDisabled?: boolean;
  } | null>(null);

  useEffect(() => {
    const onOpen = (ev: Event) => {
      const detail = (ev as CustomEvent<MdImageLightboxOpenDetail>).detail;
      if (detail?.src) setMedia({ src: detail.src, sessionId: sessionRef.current });
    };
    window.addEventListener(MD_IMAGE_LIGHTBOX_EVENT, onOpen);
    return () => window.removeEventListener(MD_IMAGE_LIGHTBOX_EVENT, onOpen);
  }, []);

  if (media == null) return null;
  return (
    <ImageLightbox
      src={media.src}
      galleryId={media.galleryId}
      filename={media.filename}
      enableGallery={media.enableGallery}
      annotationFallbackSrc={media.annotationFallbackSrc}
      autoAnnotate={media.autoAnnotate}
      annotationDisabled={media.annotationDisabled}
      onClose={() => setMedia(null)}
      onSourceChangeCancelled={(displayed) => setMedia(imageSourceSnapshotFields(displayed))}
      sessionId={media.sessionId}
    />
  );
}
