export const GHOST_PIPE_CHANNELS = {
  MESSAGE: "ghost-pipe:message",
  PING: "ghost-pipe:ping",
  SEND: "ghost-pipe:send",
} as const;

export type GHOST_PIPEChannel = typeof GHOST_PIPE_CHANNELS[keyof typeof GHOST_PIPE_CHANNELS];
