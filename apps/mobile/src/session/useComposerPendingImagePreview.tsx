import { useMemo, useState } from "react";
import { ImageLightbox } from "./ImageLightbox";
import { buildMediaPayload } from "./messagePayload";
import type { MobileMessageGalleryImage } from "./messageGallery";
import type { ComposerAttachmentTrayProps } from "./ComposerAttachmentTray";

/** Keep the viewer at screen level: the tray unmounts when the keyboard blurs. */
export function useComposerPendingImagePreview({
  attachments,
  previews,
  pendingUploads = [],
  getUploadedAttachmentId,
}: Pick<
  ComposerAttachmentTrayProps,
  "attachments" | "previews" | "pendingUploads"
> & {
  getUploadedAttachmentId: (localId: string) => string | undefined;
}) {
  const [localId, setLocalId] = useState<string | null>(null);
  const deliveredId = localId ? getUploadedAttachmentId(localId) : undefined;
  const delivered = attachments.find((item) => item.id === deliveredId);
  const pending = pendingUploads.find((item) => item.localId === localId);
  const uri = delivered ? previews[delivered.id] : pending?.previewUri;
  const name = delivered?.name ?? pending?.name;
  const images = useMemo<MobileMessageGalleryImage[]>(() => {
    if (!uri || !name || !localId) return [];
    const payload = buildMediaPayload(
      { kind: "image", previewable: true, title: name, url: uri },
      name,
    );
    return payload.kind === "media"
      ? [{ key: localId, payload, title: name, url: uri }]
      : [];
  }, [uri, name, localId]);
  return {
    open: setLocalId,
    active: images.length > 0,
    // The lightbox follows the stable image key when the uploader replaces its URI.
    host:
      images.length > 0 ? (
        <ImageLightbox
          images={images}
          initialUrl={images[0].url}
          initialImageKey={localId ?? undefined}
          onClose={() => setLocalId(null)}
        />
      ) : null,
  };
}
