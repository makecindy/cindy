export const SIDEBAR_SETTINGS_CHANNELS = {
  HIDDEN_PROJECT_KEYS_CHANGED: "sidebar-settings:hidden-project-keys-changed",
  LOAD_HIDDEN_PROJECT_KEYS_SYNC: "sidebar-settings:load-hidden-project-keys-sync",
  LOAD_PINNED_ORDER_SYNC: "sidebar-settings:load-pinned-order-sync",
  PINNED_ORDER_CHANGED: "sidebar-settings:pinned-order-changed",
  SAVE_PINNED_ORDER: "sidebar-settings:save-pinned-order",
  SET_PROJECT_HIDDEN: "sidebar-settings:set-project-hidden",
} as const;

export type SIDEBAR_SETTINGSChannel = typeof SIDEBAR_SETTINGS_CHANNELS[keyof typeof SIDEBAR_SETTINGS_CHANNELS];
