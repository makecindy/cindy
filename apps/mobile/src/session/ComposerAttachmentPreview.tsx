import {
  ImageLightbox,
  type ImageLightboxAnnotationConfig,
} from "./ImageLightbox";
import { PreviewCollectionContext } from "./PreviewChrome";
import { RemoteAttachmentPreview } from "./RemoteAttachmentPreview";
import { isPayloadDirectPreviewableUrl } from "./messagePayload";
import type { MobileMessageGalleryImage } from "./messageGallery";
import type { ResolveRemoteMediaFn } from "./remoteMedia";
import type { RemoteSerializedAttachment } from "./types";

/** One explicit draft collection; annotation continues to use the original image and strokes. */
export function ComposerAttachmentPreview({
  attachments,
  images,
  selectedId,
  annotation,
  resolveRemoteMedia,
  onSelect,
  onClose,
}: {
  attachments: readonly RemoteSerializedAttachment[];
  images: readonly MobileMessageGalleryImage[];
  selectedId: string | null;
  annotation: ImageLightboxAnnotationConfig;
  resolveRemoteMedia: ResolveRemoteMediaFn;
  onSelect(id: string): void;
  onClose(): void;
}) {
  const index = attachments.findIndex((item) => item.id === selectedId);
  const attachment = attachments[index];
  if (!attachment) return null;
  const image = images.find((item) => item.key === attachment.id);
  return (
    <PreviewCollectionContext.Provider
      value={{
        index,
        names: attachments.map((item) => item.name),
        onSelect: (next) => {
          const item = attachments[next];
          if (item) onSelect(item.id);
        },
      }}
    >
      {image ? (
        <ImageLightbox
          key={attachment.id}
          annotation={annotation}
          images={[image]}
          initialUrl={image.url}
          onClose={onClose}
        />
      ) : (
        <RemoteAttachmentPreview
          key={attachment.id}
          name={attachment.name}
          onClose={onClose}
          resolve={async (signal) => {
            const source = attachment.url || attachment.path;
            if (!source) throw new Error("MEDIA_SOURCE_MISSING");
            const direct: boolean = isPayloadDirectPreviewableUrl(source);
            if (direct)
              return { url: source, mimeType: attachment.mimeType };
            return resolveRemoteMedia(
              {
                kind: "file",
                url: source.startsWith("/")
                  ? `xdt-file://open?path=${encodeURIComponent(source)}`
                  : source,
                previewable: false,
              },
              { front: true, signal },
            );
          }}
        />
      )}
    </PreviewCollectionContext.Provider>
  );
}
