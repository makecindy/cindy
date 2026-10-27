import path from 'node:path';

/** Host-owned snapshot: the channel and chat must use the same image bytes. */
export interface PreparedOutboundImage {
  path: string;
  url?: string;
  errorCode?: string;
  assertCurrent?: () => void;
}

export type PrepareOutboundImage = (sourcePath: string) => Promise<PreparedOutboundImage>;

/** Add the existing chat media contract to a file-send tool's own receipt. */
export async function sendFileWithImagePreview<T extends { ok: boolean }>(
  sourcePath: string,
  displayName: string | undefined,
  prepare: PrepareOutboundImage | undefined,
  send: (filePath: string, name?: string) => Promise<T>,
): Promise<T & { xdt_image_urls?: string[]; _xdt_forward_media?: false; imagePreviewError?: string }> {
  let image: PreparedOutboundImage;
  try {
    image = await prepare?.(sourcePath) ?? { path: sourcePath };
  } catch {
    // Preview preparation must not turn a working channel send into a failure.
    image = { path: sourcePath, errorCode: 'IMAGE_PREVIEW_UNAVAILABLE' };
  }
  image.assertCurrent?.();
  const sent = await send(image.path, displayName ?? (image.path !== sourcePath ? path.basename(sourcePath) : undefined));
  return {
    ...sent,
    ...(sent.ok && image.url ? {
      xdt_image_urls: [image.url],
      // The tool already sent this image. Only surface it in Cindy's chat.
      _xdt_forward_media: false as const,
    } : {}),
    ...(sent.ok && image.errorCode ? { imagePreviewError: image.errorCode } : {}),
  };
}
