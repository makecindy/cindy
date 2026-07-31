export const LOCAL_THEMES_CHANNELS = {
  IMPORT: "local-themes:import",
  LIST: "local-themes:list",
  LIST_SYNC: "local-themes:list-sync",
  OPEN_DIR: "local-themes:open-dir",
  WRITE: "local-themes:write",
} as const;

export type LOCAL_THEMESChannel = typeof LOCAL_THEMES_CHANNELS[keyof typeof LOCAL_THEMES_CHANNELS];
