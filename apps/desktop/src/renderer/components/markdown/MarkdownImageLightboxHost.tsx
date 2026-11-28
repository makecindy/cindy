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

import { AttachmentCollectionContext } from '@/components/chat/AttachmentCollectionContext';
import { ImageGalleryContext } from '@/components/chat/ImageGalleryContext';
import { ImageLightbox, imageSourceSnapshotFields } from '@/components/chat/ImageLightbox';

import {
  MD_IMAGE_LIGHTBOX_EVENT,
  type MdImageLightboxOpenDetail,
} from './markdownImageLivePreview';

type MarkdownImageLightboxState = ReturnType<typeof imageSourceSnapshotFields> & {
  gallery: MdImageLightboxOpenDetail['gallery'] | null;
};

export function MarkdownImageLightboxHost({
  sessionId,
}: {
  /** 宿主会话 id:文件浏览器不在 ChatSessionFileContext provider 内,显式传给
   *  lightbox 才能启用"发送到对话"。不传则该动作不显示。 */
  sessionId?: string;
}) {
  const sessionRef = useRef(sessionId);
  sessionRef.current = sessionId;
  const [opening, setOpening] = useState<MarkdownImageLightboxState | null>(null);

  useEffect(() => {
    const onOpen = (ev: Event) => {
      const detail = (ev as CustomEvent<MdImageLightboxOpenDetail>).detail;
      if (!detail?.src) return;
      setOpening({
        ...imageSourceSnapshotFields({
          src: detail.src,
          sessionId: sessionRef.current,
          galleryId: detail.galleryId,
          enableGallery: Boolean(detail.gallery && detail.gallery.length > 0),
        }),
        gallery: detail.gallery ?? null,
      });
    };
    window.addEventListener(MD_IMAGE_LIGHTBOX_EVENT, onOpen);
    return () => window.removeEventListener(MD_IMAGE_LIGHTBOX_EVENT, onOpen);
  }, []);

  if (opening == null) return null;
  return (
    <AttachmentCollectionContext.Provider value={null}>
      <ImageGalleryContext.Provider value={opening.gallery ?? null}>
        <ImageLightbox
          {...imageSourceSnapshotFields(opening)}
          onClose={() => setOpening(null)}
          onSourceChangeCancelled={(displayed) =>
            setOpening((current) =>
              current ? { ...current, ...imageSourceSnapshotFields(displayed) } : current,
            )
          }
        />
      </ImageGalleryContext.Provider>
    </AttachmentCollectionContext.Provider>
  );
}
