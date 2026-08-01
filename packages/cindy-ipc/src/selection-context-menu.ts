export const SELECTION_CONTEXT_MENU_CHANNELS = {
  ADD_TO_CHAT: "selection-context-menu:add-to-chat",
} as const;

export type SELECTION_CONTEXT_MENUChannel =
  typeof SELECTION_CONTEXT_MENU_CHANNELS[keyof typeof SELECTION_CONTEXT_MENU_CHANNELS];
