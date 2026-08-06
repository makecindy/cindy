export const BINDING_CHANNELS = {
  CHANGED: "binding:changed",
  LIST_ATTACHED: "binding:list-attached",
  RESOLVE_SESSION: "binding:resolve-session",
  REVOKE: "binding:revoke",
} as const;

export type BINDINGChannel = typeof BINDING_CHANNELS[keyof typeof BINDING_CHANNELS];
