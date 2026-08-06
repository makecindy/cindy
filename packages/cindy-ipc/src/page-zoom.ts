export const PAGE_ZOOM_CHANNELS = {
  IN: "page-zoom:in",
  OUT: "page-zoom:out",
  RESET: "page-zoom:reset",
} as const;

export type PAGE_ZOOMChannel = typeof PAGE_ZOOM_CHANNELS[keyof typeof PAGE_ZOOM_CHANNELS];
