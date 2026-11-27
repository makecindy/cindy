import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createDragOrHoldOptionsController,
  REORDER_DRAG_MOVE_THRESHOLD_PX,
  REORDER_HOLD_STILL_OPTIONS_MS,
} from '@/session/dragOrHoldOptions';

describe('dragOrHoldOptions controller', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('cancels drag and opens options when held still past the extra hold window', () => {
    const controller = createDragOrHoldOptionsController();
    const onCancelDrag = vi.fn();
    const onHoldOptions = vi.fn();

    controller.start({ startY: 200, onCancelDrag, onHoldOptions });
    // Micro-jitter under the movement threshold keeps counting as holding still.
    expect(controller.move(200 + REORDER_DRAG_MOVE_THRESHOLD_PX - 1)).toBe(false);
    vi.advanceTimersByTime(REORDER_HOLD_STILL_OPTIONS_MS - 1);
    expect(onCancelDrag).not.toHaveBeenCalled();
    expect(onHoldOptions).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(onCancelDrag).toHaveBeenCalledOnce();
    expect(onHoldOptions).toHaveBeenCalledOnce();
    expect(controller.finish()).toEqual({ moved: false });
  });

  it('suppresses options once the finger moves past the drag threshold even if paused mid-drag', () => {
    const controller = createDragOrHoldOptionsController();
    const onCancelDrag = vi.fn();
    const onHoldOptions = vi.fn();

    controller.start({ startY: 200, onCancelDrag, onHoldOptions });
    expect(controller.move(200 + REORDER_DRAG_MOVE_THRESHOLD_PX)).toBe(true);
    vi.advanceTimersByTime(REORDER_HOLD_STILL_OPTIONS_MS * 3);
    expect(onCancelDrag).not.toHaveBeenCalled();
    expect(onHoldOptions).not.toHaveBeenCalled();
    expect(controller.finish()).toEqual({ moved: true });
  });

  it('does not open options or mark as moved when released before the extra hold window', () => {
    const controller = createDragOrHoldOptionsController();
    const onCancelDrag = vi.fn();
    const onHoldOptions = vi.fn();

    controller.start({ startY: 200, onCancelDrag, onHoldOptions });
    vi.advanceTimersByTime(REORDER_HOLD_STILL_OPTIONS_MS - 100);
    expect(controller.finish()).toEqual({ moved: false });

    vi.advanceTimersByTime(REORDER_HOLD_STILL_OPTIONS_MS * 2);
    expect(onCancelDrag).not.toHaveBeenCalled();
    expect(onHoldOptions).not.toHaveBeenCalled();
  });

  it('cancels pending hold timers cleanly on explicit cancel or restart', () => {
    const controller = createDragOrHoldOptionsController();
    const firstCancel = vi.fn();
    const firstOptions = vi.fn();
    const secondCancel = vi.fn();
    const secondOptions = vi.fn();

    controller.start({ startY: 100, onCancelDrag: firstCancel, onHoldOptions: firstOptions });
    controller.cancel();
    vi.advanceTimersByTime(REORDER_HOLD_STILL_OPTIONS_MS * 2);
    expect(firstCancel).not.toHaveBeenCalled();
    expect(firstOptions).not.toHaveBeenCalled();

    controller.start({ startY: 100, onCancelDrag: firstCancel, onHoldOptions: firstOptions });
    controller.start({ startY: 300, onCancelDrag: secondCancel, onHoldOptions: secondOptions });
    vi.advanceTimersByTime(REORDER_HOLD_STILL_OPTIONS_MS);
    expect(firstCancel).not.toHaveBeenCalled();
    expect(firstOptions).not.toHaveBeenCalled();
    expect(secondCancel).toHaveBeenCalledOnce();
    expect(secondOptions).toHaveBeenCalledOnce();
  });
});
