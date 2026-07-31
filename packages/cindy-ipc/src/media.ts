export const MEDIA_CHANNELS = {
  CACHE_FOR_SESSION: "media:cache-for-session",
  COPY_TO_CLIPBOARD: "media:copy-to-clipboard",
  OPEN_WITH_DEFAULT_APP: "media:open-with-default-app",
  READ_IMAGE_BYTES: "media:read-image-bytes",
  SAVE_AS: "media:save-as",
} as const;

export type MEDIAChannel = typeof MEDIA_CHANNELS[keyof typeof MEDIA_CHANNELS];
