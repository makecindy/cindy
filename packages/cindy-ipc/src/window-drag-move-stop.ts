export const WINDOW_DRAG_MOVE_STOP_CHANNELS = {
  WINDOW_DRAG_MOVE_STOP: "window-drag-move-stop",
} as const;

export type WINDOW_DRAG_MOVE_STOPChannel = typeof WINDOW_DRAG_MOVE_STOP_CHANNELS[keyof typeof WINDOW_DRAG_MOVE_STOP_CHANNELS];
