export const AGENT_ISLAND_CHANNELS = {
  GET_DISPLAY_OPTIONS: "agent-island:get-display-options",
  PREVIEW_SOUND: "agent-island:preview-sound",
  SELECT_SOUND_FILE: "agent-island:select-sound-file",
  SESSION_SNAPSHOTS: "agent-island:session-snapshots",
  SET_DISPLAY_TARGET: "agent-island:set-display-target",
  SET_ENABLED: "agent-island:set-enabled",
  SET_MASCOT_SKIN: "agent-island:set-mascot-skin",
  SET_SOUND_SETTINGS: "agent-island:set-sound-settings",
  SET_VISIBLE_SESSION: "agent-island:set-visible-session",
} as const;

export type AGENT_ISLANDChannel = typeof AGENT_ISLAND_CHANNELS[keyof typeof AGENT_ISLAND_CHANNELS];
