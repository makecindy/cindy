import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  SessionDragPreviewController,
  type SessionDragPreviewWindowLike,
} from '../sessionDragPreviewController';
import type { SessionDragPreviewPalette } from '../../shared/sessionDragPreview';

const PALETTE: SessionDragPreviewPalette = {
  surface: 'rgb(31, 32, 34)',
  border: 'rgb(64, 66, 70)',
  text: 'rgb(244, 244, 242)',
};

function createPreviewWindow(): SessionDragPreviewWindowLike & {
  setPosition: ReturnType<typeof vi.fn>;
  setOpacity: ReturnType<typeof vi.fn>;
  showInactive: ReturnType<typeof vi.fn>;
  hide: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
} {
  return {
    ready: Promise.resolve(),
    isDestroyed: vi.fn(() => false),
    setPosition: vi.fn(),
    setOpacity: vi.fn(),
    showInactive: vi.fn(),
    hide: vi.fn(),
    close: vi.fn(),
  };
}

describe('SessionDragPreviewController', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps the preview hidden while the pointer is inside Cindy windows', () => {
    const owner = {};
    const preview = createPreviewWindow();
    const create = vi.fn(() => preview);
    const controller = new SessionDragPreviewController({
      screen: {
        getCursorScreenPoint: () => ({ x: 200, y: 200 }),
        getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1200, height: 800 } }),
      },
      getAppWindowBounds: () => [{ x: 0, y: 0, width: 800, height: 600 }],
      createPreviewWindow: create,
    });

    controller.begin(owner, '任务 A', PALETTE);
    vi.advanceTimersByTime(48);

    expect(create).toHaveBeenCalledWith('任务 A', PALETTE);
    expect(preview.showInactive).not.toHaveBeenCalled();
    expect(controller.isActive()).toBe(true);
    controller.end(owner);
  });

  it('shows and follows a preview only after the pointer leaves all Cindy windows', async () => {
    const owner = {};
    let point = { x: 200, y: 200 };
    const preview = createPreviewWindow();
    const create = vi.fn(() => preview);
    const controller = new SessionDragPreviewController({
      screen: {
        getCursorScreenPoint: () => point,
        getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1200, height: 800 } }),
      },
      getAppWindowBounds: () => [{ x: 0, y: 0, width: 800, height: 600 }],
      createPreviewWindow: create,
    });

    controller.begin(owner, '任务 A', PALETTE);
    point = { x: 900, y: 700 };
    vi.advanceTimersByTime(16);
    await Promise.resolve();

    expect(create).toHaveBeenCalledWith('任务 A', PALETTE);
    expect(preview.setPosition).toHaveBeenCalledWith(880, 708, false);
    expect(preview.showInactive).toHaveBeenCalled();

    point = { x: 300, y: 300 };
    vi.advanceTimersByTime(16);
    expect(preview.hide).toHaveBeenCalled();

    point = { x: 900, y: 700 };
    vi.advanceTimersByTime(16);
    expect(create).toHaveBeenCalledOnce();
    expect(preview.showInactive).toHaveBeenCalledTimes(2);

    controller.end(owner);
    expect(preview.hide).toHaveBeenCalled();
    expect(preview.setOpacity).not.toHaveBeenCalled();
    expect(preview.close).not.toHaveBeenCalled();
    vi.runOnlyPendingTimers();
    expect(preview.setOpacity).toHaveBeenCalledWith(0);
    expect(preview.close).toHaveBeenCalledOnce();
    expect(controller.isActive()).toBe(false);
  });

  it('can show again when the preview finishes loading after re-entering Cindy', async () => {
    const owner = {};
    let point = { x: 200, y: 200 };
    let resolveReady!: () => void;
    const preview = {
      ...createPreviewWindow(),
      ready: new Promise<void>((resolve) => {
        resolveReady = resolve;
      }),
    };
    const create = vi.fn(() => preview);
    const controller = new SessionDragPreviewController({
      screen: {
        getCursorScreenPoint: () => point,
        getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1200, height: 800 } }),
      },
      getAppWindowBounds: () => [{ x: 0, y: 0, width: 800, height: 600 }],
      createPreviewWindow: create,
    });

    controller.begin(owner, '任务 A', PALETTE);
    point = { x: 900, y: 700 };
    vi.advanceTimersByTime(16);
    point = { x: 300, y: 300 };
    vi.advanceTimersByTime(16);
    resolveReady();
    await Promise.resolve();

    expect(preview.showInactive).not.toHaveBeenCalled();

    point = { x: 900, y: 700 };
    vi.advanceTimersByTime(16);
    expect(preview.showInactive).toHaveBeenCalledOnce();

    controller.end(owner);
  });

  it('does not let another window stop the active drag', () => {
    const owner = {};
    const other = {};
    const preview = createPreviewWindow();
    const controller = new SessionDragPreviewController({
      screen: {
        getCursorScreenPoint: () => ({ x: 900, y: 700 }),
        getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1200, height: 800 } }),
      },
      getAppWindowBounds: () => [],
      createPreviewWindow: () => preview,
    });

    controller.begin(owner, '任务 A', PALETTE);
    controller.end(other);

    expect(controller.isActive()).toBe(true);
    controller.end(owner);
  });

  it('ignores a native release from an older drag token', () => {
    const owner = {};
    const firstPreview = createPreviewWindow();
    const secondPreview = createPreviewWindow();
    const controller = new SessionDragPreviewController({
      screen: {
        getCursorScreenPoint: () => ({ x: 900, y: 700 }),
        getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1200, height: 800 } }),
      },
      getAppWindowBounds: () => [],
      createPreviewWindow: vi.fn().mockReturnValueOnce(firstPreview).mockReturnValue(secondPreview),
    });

    const firstToken = controller.begin(owner, '任务 A', PALETTE);
    const secondToken = controller.begin(owner, '任务 B', PALETTE);
    expect(firstToken).not.toBe(secondToken);

    expect(controller.endByToken(firstToken!)).toBe(false);
    expect(controller.isActive()).toBe(true);
    expect(secondPreview.hide).not.toHaveBeenCalled();

    expect(controller.endByToken(secondToken!)).toBe(true);
    expect(controller.isActive()).toBe(false);
    expect(secondPreview.hide).toHaveBeenCalledOnce();
  });

  it('notifies native cleanup when the safety timeout ends a drag', () => {
    const onStopped = vi.fn();
    const controller = new SessionDragPreviewController({
      screen: {
        getCursorScreenPoint: () => ({ x: 900, y: 700 }),
        getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1200, height: 800 } }),
      },
      getAppWindowBounds: () => [],
      createPreviewWindow,
      maxDurationMs: 32,
      onStopped,
    });

    const token = controller.begin({}, '任务 A', PALETTE);
    vi.advanceTimersByTime(48);

    expect(controller.isActive()).toBe(false);
    expect(onStopped).toHaveBeenCalledWith(token);
  });
});
