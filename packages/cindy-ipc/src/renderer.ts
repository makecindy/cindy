export const RENDERER_CHANNELS = {
  LOG: "renderer:log",
} as const;

export type RENDERERChannel = typeof RENDERER_CHANNELS[keyof typeof RENDERER_CHANNELS];
