export const READ_FILE_BYTES_CHANNELS = {
  READ_FILE_BYTES: "read-file-bytes",
} as const;

export type READ_FILE_BYTESChannel = typeof READ_FILE_BYTES_CHANNELS[keyof typeof READ_FILE_BYTES_CHANNELS];
