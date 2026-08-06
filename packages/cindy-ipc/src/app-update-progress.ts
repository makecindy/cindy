export const APP_UPDATE_PROGRESS_CHANNELS = {
  APP_UPDATE_PROGRESS: "app-update-progress",
} as const;

export type APP_UPDATE_PROGRESSChannel = typeof APP_UPDATE_PROGRESS_CHANNELS[keyof typeof APP_UPDATE_PROGRESS_CHANNELS];
