import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DragWindowLike, ScreenLike } from '../windowManualDrag';
import { WindowManualDragController } from '../windowManualDrag';

/** 可编程光标 + 单显示器 workArea 的 ScreenLike 假件。 */
function makeScreen(workAreaY = 25) {
  const cursor = { x: 500, y: 300 };
  const screen: ScreenLike = {
    getCursorScreenPoint: () => ({ ...cursor }),
    getDisplayNearestPoint: () => ({ workArea: { x: 0, y: workAreaY, width: 1512, height: 900 } }),
  };
  return { screen, cursor };
}

function makeWindow(x = 100, y = 100) {
  const win = {
    destroyed: false,
    maximized: false,
    fullScreen: false,
    position: [x, y] as [number, number],
    size: [813, 607] as [number, number],
    isDestroyed() {
      return this.destroyed;
    },
    isMaximized() {
      return this.maximized;
    },
    isFullScreen() {
      return this.fullScreen;
    },
    getPosition() {
      return [...this.position];
    },
    setPosition(nx: number, ny: number) {
      this.position = [nx, ny];
    },
    getBounds() {
      return { x: this.position[0], y: this.position[1], width: this.size[0], height: this.size[1] };
    },
    setBounds(bounds: { x: number; y: number; width: number; height: number }) {
      this.position = [bounds.x, bounds.y];
      this.size = [bounds.width, bounds.height];
    },
  };
  return win satisfies DragWindowLike & Record<string, unknown>;
}

describe('WindowManualDragController', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('follows the cursor keeping the grab offset', () => {
    const { screen, cursor } = makeScreen();
    const win = makeWindow(100, 100);
    const controller = new WindowManualDragController(screen, 16);

    controller.start(win);
    expect(controller.isDragging()).toBe(true);

    // 按下时 offset = (400, 200);光标移动后窗口应保持该偏移
    cursor.x = 700;
    cursor.y = 400;
    vi.advanceTimersByTime(16);
    expect(win.position).toEqual([300, 200]);

    controller.stop();
    expect(controller.isDragging()).toBe(false);

    // stop 后不再跟随
    cursor.x = 900;
    vi.advanceTimersByTime(64);
    expect(win.position).toEqual([300, 200]);
  });

  // #7860: the old position-only path repeatedly round-trips the native size at
  // fractional DPI. Existing fakes only tracked position, hiding that feedback.
  // Unit tier: model that native rounding and assert the public drag preserves size.
  it('preserves the starting size through movement and stationary polling at fractional DPI', () => {
    const { screen, cursor } = makeScreen();
    const win = makeWindow();
    const updates = vi.spyOn(win, 'setBounds');
    win.setPosition = (x, y) => {
      win.position = [x, y];
      win.size = [win.size[0] + 1, win.size[1] + 1];
    };
    const controller = new WindowManualDragController(screen, 16);

    controller.start(win);
    cursor.x += 40;
    cursor.y += 20;
    vi.advanceTimersByTime(16);
    expect(win.position).toEqual([140, 120]);
    expect(win.size).toEqual([813, 607]);
    vi.advanceTimersByTime(160);
    expect(win.size).toEqual([813, 607]);
    expect(updates).toHaveBeenCalledTimes(1);
    controller.stop();

    // A new gesture must capture a user's intervening resize, not an old size.
    win.size = [901, 701];
    controller.start(win);
    cursor.x += 20;
    vi.advanceTimersByTime(32);
    expect(win.position).toEqual([160, 120]);
    expect(win.size).toEqual([901, 701]);
    controller.stop();
  });

  // #7860: native physical movement must never re-enter the DIP resize path.
  it('delegates native movement until stop or native failure, without writing DIP bounds', () => {
    const { screen } = makeScreen();
    const win = makeWindow();
    const bounds = vi.spyOn(win, 'setBounds');
    const follow = vi.fn(() => true);
    const controller = new WindowManualDragController(screen, 16, 1000, () => follow);
    controller.start(win);
    vi.advanceTimersByTime(16);
    expect(follow).toHaveBeenCalledTimes(1);
    controller.stop();
    vi.advanceTimersByTime(32);
    expect(follow).toHaveBeenCalledTimes(1);

    controller.start(win);
    follow.mockReturnValue(false);
    vi.advanceTimersByTime(16);
    expect(controller.isDragging()).toBe(false);
    expect(bounds).not.toHaveBeenCalled();
  });

  // #7898 review: a native offset read can throw during a Windows desktop
  // switch. Unit tier: start must still move with fixed bounds and stop normally;
  // prior native coverage only exercised a follower returning false after start.
  it('falls back to fixed bounds when native drag initialization throws', () => {
    const { screen, cursor } = makeScreen();
    const win = makeWindow();
    const error = new Error('GetCursorPos failed');
    const report = vi.fn();
    const controller = new WindowManualDragController(screen, 16, 1000, () => {
      throw error;
    }, report);

    expect(() => controller.start(win)).not.toThrow();
    expect(report).toHaveBeenCalledWith(error);
    cursor.x += 40;
    cursor.y += 20;
    vi.advanceTimersByTime(16);
    expect(win.position).toEqual([140, 120]);
    expect(win.size).toEqual([813, 607]);
    controller.stop(win);
    cursor.x += 40;
    vi.advanceTimersByTime(16);
    expect(win.position).toEqual([140, 120]);
    expect(controller.isDragging()).toBe(false);
  });

  it('clamps window y to the display workArea top (menu bar)', () => {
    const { screen, cursor } = makeScreen(25);
    const win = makeWindow(100, 100);
    const controller = new WindowManualDragController(screen, 16);

    controller.start(win);
    // 光标推到屏幕最顶,窗口 y 不得高于 workArea.y
    cursor.y = 0;
    vi.advanceTimersByTime(16);
    expect(win.position[1]).toBe(25);
    controller.stop();
  });

  it('ignores start on maximized / fullscreen / destroyed windows', () => {
    const { screen } = makeScreen();
    const controller = new WindowManualDragController(screen, 16);

    const maximized = makeWindow();
    maximized.maximized = true;
    controller.start(maximized);
    expect(controller.isDragging()).toBe(false);

    const fullscreen = makeWindow();
    fullscreen.fullScreen = true;
    controller.start(fullscreen);
    expect(controller.isDragging()).toBe(false);

    const destroyed = makeWindow();
    destroyed.destroyed = true;
    controller.start(destroyed);
    expect(controller.isDragging()).toBe(false);
  });

  it('stops automatically when the window is destroyed mid-drag', () => {
    const { screen, cursor } = makeScreen();
    const win = makeWindow(100, 100);
    const controller = new WindowManualDragController(screen, 16);

    controller.start(win);
    win.destroyed = true;
    cursor.x = 700;
    vi.advanceTimersByTime(32);
    expect(controller.isDragging()).toBe(false);
    expect(win.position).toEqual([100, 100]);
  });

  it('stops after the max-duration fuse when stop never arrives', () => {
    const { screen } = makeScreen();
    const win = makeWindow(100, 100);
    const controller = new WindowManualDragController(screen, 16, 1000);

    controller.start(win);
    vi.advanceTimersByTime(1100);
    expect(controller.isDragging()).toBe(false);
  });

  it('ignores stop from a window that does not own the active drag', () => {
    const { screen, cursor } = makeScreen();
    const winA = makeWindow(100, 100);
    const winB = makeWindow(0, 0);
    const controller = new WindowManualDragController(screen, 16);

    controller.start(winB);
    // 窗口 A 遗留 / 延迟到达的 stop 不能清掉 B 正在进行的拖拽
    controller.stop(winA);
    expect(controller.isDragging()).toBe(true);
    cursor.x = 600;
    vi.advanceTimersByTime(16);
    // y 原始目标 0,被 workArea.y=25 钳制
    expect(winB.position).toEqual([100, 25]);

    // owner 自己的 stop 正常生效
    controller.stop(winB);
    expect(controller.isDragging()).toBe(false);

    // 拖拽结束后任意窗口的 stop 都是 no-op(不抛错、不复活)
    controller.stop(winA);
    expect(controller.isDragging()).toBe(false);
  });

  it('rejects a start from another window while a drag is active (no preemption)', () => {
    const { screen, cursor } = makeScreen();
    const winA = makeWindow(100, 100);
    const winB = makeWindow(0, 0);
    const controller = new WindowManualDragController(screen, 16);

    controller.start(winB);
    // B 拖拽进行中,A 的延迟 start 不得抢占(停掉 B、让 A 粘附光标)
    controller.start(winA);

    cursor.x = 600;
    cursor.y = 350;
    vi.advanceTimersByTime(16);
    expect(winA.position).toEqual([100, 100]);
    expect(winB.position).toEqual([100, 50]);

    // owner(B)的 stop 仍然有效:owner 身份未被延迟 start 篡改
    controller.stop(winB);
    expect(controller.isDragging()).toBe(false);
  });

  it('same-window restart replaces the previous drag (lost-stop self-heal)', () => {
    const { screen, cursor } = makeScreen();
    const win = makeWindow(100, 100);
    const controller = new WindowManualDragController(screen, 16);

    controller.start(win);
    // 同窗口新手势(前一次 stop 丢失):以最新按下点重建 offset
    win.position = [200, 200];
    controller.start(win); // offset 变为 (300, 100)

    cursor.x = 600;
    cursor.y = 350;
    vi.advanceTimersByTime(16);
    expect(win.position).toEqual([300, 250]);
    controller.stop();
  });
});
