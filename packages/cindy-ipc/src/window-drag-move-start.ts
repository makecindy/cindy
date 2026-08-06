export const WINDOW_DRAG_MOVE_START_CHANNELS = {
  WINDOW_DRAG_MOVE_START: "window-drag-move-start",
} as const;

export type WINDOW_DRAG_MOVE_STARTChannel = typeof WINDOW_DRAG_MOVE_START_CHANNELS[keyof typeof WINDOW_DRAG_MOVE_START_CHANNELS];
