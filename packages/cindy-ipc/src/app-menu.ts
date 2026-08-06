export const APP_MENU_CHANNELS = {
  COMMAND: "app-menu:command",
  SET_LOCALE: "app-menu:set-locale",
} as const;

export type APP_MENUChannel = typeof APP_MENU_CHANNELS[keyof typeof APP_MENU_CHANNELS];
