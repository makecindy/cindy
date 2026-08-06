export const IMAGE_CACHE_CHANNELS = {
  CLEANUP_FILES: "image-cache:cleanup-files",
  CLEANUP_SESSION: "image-cache:cleanup-session",
  FROM_BUFFER: "image-cache:from-buffer",
  FROM_PATH: "image-cache:from-path",
  READ_BASE64: "image-cache:read-base64",
} as const;

export type IMAGE_CACHEChannel = typeof IMAGE_CACHE_CHANNELS[keyof typeof IMAGE_CACHE_CHANNELS];
