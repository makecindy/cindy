import { attachmentPreviewKind } from "@cindy/maker-shared/attachment-preview";
import {
  ImageLightbox,
  type ImageLightboxAnnotationConfig,
} from "./ImageLightbox";
import { RemoteAttachmentPreview } from "./RemoteAttachmentPreview";
import { isPayloadDirectPreviewableUrl, toRemoteAttachmentUrl } from "./messagePayload";
import type { MobileMessageGalleryImage } from "./messageGallery";
import { isDirectPreviewableMediaUrl, type ResolveRemoteMediaFn } from "./remoteMedia";
import type { RemoteSerializedAttachment } from "./types";

/** One explicit draft collection; images swipe inside one viewer, annotation keeps the original image and strokes. */
export function ComposerAttachmentPreview({
  attachments,
  images,
  selectedId,
  annotation,
  resolveRemoteMedia,
  onClose,
}: {
  attachments: readonly RemoteSerializedAttachment[];
  images: readonly MobileMessageGalleryImage[];
  selectedId: string | null;
  annotation: ImageLightboxAnnotationConfig;
  resolveRemoteMedia: ResolveRemoteMediaFn;
  onClose(): void;
}) {
  const index = attachments.findIndex((item) => item.id === selectedId);
  const attachment = attachments[index];
  if (!attachment) return null;
  const image = images.find((item) => item.key === attachment.id);
  const audio = attachmentPreviewKind(attachment.name, attachment.mimeType) === "audio";
  return (
    <>
      {image ? (
        <ImageLightbox
          key={attachment.id}
          annotation={annotation}
          // 待发托盘里的图片放进同一个看图器,左右滑动切换(手机没有集合导航按钮)。
          images={images}
          initialImageKey={image.key}
          initialUrl={image.url}
          onClose={onClose}
        />
      ) : (
        <RemoteAttachmentPreview
          key={attachment.id}
          name={attachment.name}
          mediaKind={audio ? "audio" : undefined}
          onClose={onClose}
          resolve={async (signal, forceRefresh) => {
            const source = attachment.url || attachment.path;
            if (!source) throw new Error("MEDIA_SOURCE_MISSING");
            const direct: boolean = audio ? isDirectPreviewableMediaUrl(source) : isPayloadDirectPreviewableUrl(source);
            if (direct)
              return { url: source, mimeType: attachment.mimeType };
            return resolveRemoteMedia(
              {
                kind: audio ? "audio" : "file",
                url: toRemoteAttachmentUrl(source),
                previewable: false,
              },
              { front: true, signal, ...(forceRefresh ? { forceRefresh: true } : {}) },
            );
          }}
        />
      )}
    </>
  );
}
