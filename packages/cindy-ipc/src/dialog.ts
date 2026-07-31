export const DIALOG_CHANNELS = {
  SHOW_OPEN_DIRECTORY: "dialog:show-open-directory",
  SHOW_OPEN_FILE: "dialog:show-open-file",
  SHOW_OPEN_RESOURCE: "dialog:show-open-resource",
} as const;

export type DIALOGChannel = typeof DIALOG_CHANNELS[keyof typeof DIALOG_CHANNELS];
