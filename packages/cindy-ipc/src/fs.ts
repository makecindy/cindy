export const FS_CHANNELS = {
  LIST_DIR: "fs:list-dir",
  MKDIR_P: "fs:mkdir-p",
  RESOLVE_PATH: "fs:resolve-path",
  RESOLVE_PATH_BATCH: "fs:resolve-path-batch",
  STAT_PATH: "fs:stat-path",
} as const;

export type FSChannel = typeof FS_CHANNELS[keyof typeof FS_CHANNELS];
