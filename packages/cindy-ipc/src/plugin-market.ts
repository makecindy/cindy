export const PLUGIN_MARKET_CHANNELS = {
  DETAIL: "plugin-market:detail",
  INSTALL: "plugin-market:install",
  SNAPSHOT: "plugin-market:snapshot",
  UNINSTALL: "plugin-market:uninstall",
  LIST_SOURCES: "plugin-market:list-sources",
  PICK_LOCAL_SOURCE: "plugin-market:pick-local-source",
  ADD_SOURCE: "plugin-market:add-source",
  REMOVE_SOURCE: "plugin-market:remove-source",
  REFRESH_SOURCE: "plugin-market:refresh-source",
  GIT_PREFLIGHT: "plugin-market:git-preflight",
  CONSUME_REMOVAL_NOTICE: "plugin-market:consume-removal-notice",
  REMOVAL_NOTICE_AVAILABLE: "plugin-market:removal-notice-available",
} as const;

export type PLUGIN_MARKETChannel = typeof PLUGIN_MARKET_CHANNELS[keyof typeof PLUGIN_MARKET_CHANNELS];
