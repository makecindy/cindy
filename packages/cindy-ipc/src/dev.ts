export const DEV_CHANNELS = {
  EMBEDDING_STATUS: "dev:embedding:status",
  EMBEDDING_TEST_EMBED: "dev:embedding:test-embed",
  SQLITE_VEC_STATUS: "dev:sqlite-vec:status",
} as const;

export type DEVChannel = typeof DEV_CHANNELS[keyof typeof DEV_CHANNELS];
