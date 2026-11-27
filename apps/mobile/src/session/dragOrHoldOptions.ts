/**
 * Arbitrates long-press drag-to-reorder vs. holding still to open options (iOS SpringBoard pattern).
 *
 * - Touch-hold for REORDER_DRAG_HOLD_MS lifts the row into drag mode.
 * - Moving >= REORDER_DRAG_MOVE_THRESHOLD_PX commits to dragging and suppresses options.
 * - Continuing to hold still for REORDER_HOLD_STILL_OPTIONS_MS cancels drag and opens options.
 */
export const REORDER_DRAG_HOLD_MS = 550;
export const REORDER_HOLD_STILL_OPTIONS_MS = 650;
export const REORDER_DRAG_MOVE_THRESHOLD_PX = 12;

export interface DragOrHoldOptionsController {
  start(input: {
    startY: number;
    onHoldOptions?: () => void;
    onCancelDrag(): void;
  }): void;
  move(absoluteY: number): boolean;
  finish(): { moved: boolean };
  cancel(): void;
}

export function createDragOrHoldOptionsController(options?: {
  holdStillMs?: number;
  moveThresholdPx?: number;
}): DragOrHoldOptionsController {
  const holdStillMs = options?.holdStillMs ?? REORDER_HOLD_STILL_OPTIONS_MS;
  const moveThresholdPx = options?.moveThresholdPx ?? REORDER_DRAG_MOVE_THRESHOLD_PX;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let startY = 0;
  let moved = false;
  let active = false;

  const clearTimer = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  return {
    start({ startY: initialY, onHoldOptions, onCancelDrag }) {
      clearTimer();
      startY = initialY;
      moved = false;
      active = true;
      if (!onHoldOptions) return;
      timer = setTimeout(() => {
        timer = null;
        if (!active || moved) return;
        active = false;
        onCancelDrag();
        onHoldOptions();
      }, holdStillMs);
    },
    move(absoluteY) {
      if (!active) return false;
      if (!moved && Math.abs(absoluteY - startY) >= moveThresholdPx) {
        moved = true;
        clearTimer();
      }
      return moved;
    },
    finish() {
      const result = { moved };
      clearTimer();
      active = false;
      moved = false;
      return result;
    },
    cancel() {
      clearTimer();
      active = false;
      moved = false;
    },
  };
}
