export const CHAT_ATTACHMENT_CHANNELS = {
  CLEANUP: "chat-attachment:cleanup",
  SAVE_AS: "chat-attachment:save-as",
  STAGE: "chat-attachment:stage",
} as const;

export type CHAT_ATTACHMENTChannel = typeof CHAT_ATTACHMENT_CHANNELS[keyof typeof CHAT_ATTACHMENT_CHANNELS];
