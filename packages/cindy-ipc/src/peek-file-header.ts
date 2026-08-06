export const PEEK_FILE_HEADER_CHANNELS = {
  PEEK_FILE_HEADER: "peek-file-header",
} as const;

export type PEEK_FILE_HEADERChannel = typeof PEEK_FILE_HEADER_CHANNELS[keyof typeof PEEK_FILE_HEADER_CHANNELS];
