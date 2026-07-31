export const SHELL_CHANNELS = {
  OPEN_CHATGPT_APP: "shell:open-chatgpt-app",
  OPEN_EXTERNAL: "shell:open-external",
  OPEN_FILE_IN_BROWSER: "shell:open-file-in-browser",
  OPEN_PATH: "shell:open-path",
  SHOW_ITEM_IN_FOLDER: "shell:show-item-in-folder",
} as const;

export type SHELLChannel = typeof SHELL_CHANNELS[keyof typeof SHELL_CHANNELS];
