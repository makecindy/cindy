import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DISCLOSURE_WINDOW_TAIL_MS,
  commitRegisteredLevel,
  createDisclosureController,
  detachDisclosureScope,
  openDisclosureWindow,
  runDisclosure,
  type DisclosureLevel,
} from '@/session/listDisclosureController';

/** 模拟 ListDisclosureScope:setLevel 记录请求的档位,登记由测试手动触发。 */
function mountScope() {
  const controller = createDisclosureController();
  const levels: DisclosureLevel[] = [];
  controller.setLevel = (level) => { levels.push(level); };
  return { controller, levels };
}

describe('list disclosure controller', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('applies immediately and opens no window when motion is not allowed (reduced motion or preference unknown)', () => {
    const { controller, levels } = mountScope();
    const apply = vi.fn();
    runDisclosure(controller, apply, 1, false);
    expect(apply).toHaveBeenCalledTimes(1);
    expect(levels).toEqual([]);
    expect(controller.timer).toBeNull();
    expect(openDisclosureWindow(controller, 1, false)).toBe(false);
  });

  it('applies immediately when the list is not mounted', () => {
    const controller = createDisclosureController();
    const apply = vi.fn();
    runDisclosure(controller, apply, 1, true);
    expect(apply).toHaveBeenCalledTimes(1);
    expect(controller.pending).toEqual([]);
  });

  it('opens the window and holds the change until rows have registered their animation', () => {
    const { controller, levels } = mountScope();
    const apply = vi.fn();
    runDisclosure(controller, apply, 1, true);
    expect(levels).toEqual([1]);
    expect(apply).not.toHaveBeenCalled();
    commitRegisteredLevel(controller, 1);
    expect(apply).toHaveBeenCalledTimes(1);
    expect(controller.pending).toEqual([]);
  });

  it('applies straight away once the window is already registered, but queues behind pending changes to keep order', () => {
    const { controller } = mountScope();
    const order: string[] = [];
    runDisclosure(controller, () => order.push('first'), 1, true);
    runDisclosure(controller, () => order.push('second'), 1, true);
    expect(order).toEqual([]);
    commitRegisteredLevel(controller, 1);
    expect(order).toEqual(['first', 'second']);
    runDisclosure(controller, () => order.push('third'), 1, true);
    expect(order).toEqual(['first', 'second', 'third']);
  });

  it('raises the level for nested toggles and waits for the higher registration', () => {
    const { controller, levels } = mountScope();
    const plain = vi.fn();
    const nested = vi.fn();
    runDisclosure(controller, plain, 1, true);
    commitRegisteredLevel(controller, 1);
    runDisclosure(controller, nested, 2, true);
    expect(levels).toEqual([1, 2]);
    expect(nested).not.toHaveBeenCalled();
    commitRegisteredLevel(controller, 2);
    expect(nested).toHaveBeenCalledTimes(1);
    expect(plain).toHaveBeenCalledTimes(1);
  });

  it('prepare (press-in) opens the window without applying anything, and the later change runs at once', () => {
    const { controller, levels } = mountScope();
    expect(openDisclosureWindow(controller, 1, true)).toBe(true);
    commitRegisteredLevel(controller, 1);
    expect(levels).toEqual([1]);
    const apply = vi.fn();
    runDisclosure(controller, apply, 1, true);
    expect(apply).toHaveBeenCalledTimes(1);
    expect(levels).toEqual([1]);
  });

  it('closes the window after the tail and resets, and every new change extends the tail', () => {
    const { controller, levels } = mountScope();
    runDisclosure(controller, vi.fn(), 1, true);
    commitRegisteredLevel(controller, 1);
    vi.advanceTimersByTime(DISCLOSURE_WINDOW_TAIL_MS - 10);
    expect(levels).toEqual([1]);
    runDisclosure(controller, vi.fn(), 1, true);
    vi.advanceTimersByTime(DISCLOSURE_WINDOW_TAIL_MS - 10);
    expect(levels).toEqual([1]);
    vi.advanceTimersByTime(10);
    expect(levels).toEqual([1, 0]);
    expect(controller.registered).toBe(0);
    expect(controller.requested).toBe(0);
    expect(controller.timer).toBeNull();
  });

  it('never leaves a change stuck: pending work runs even if the window closed before registration', () => {
    const { controller } = mountScope();
    const apply = vi.fn();
    runDisclosure(controller, apply, 1, true);
    vi.advanceTimersByTime(DISCLOSURE_WINDOW_TAIL_MS);
    expect(controller.registered).toBe(0);
    commitRegisteredLevel(controller, 0);
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it('flushes queued changes and clears the timer when the list unmounts', () => {
    const { controller } = mountScope();
    const apply = vi.fn();
    runDisclosure(controller, apply, 1, true);
    detachDisclosureScope(controller);
    expect(apply).toHaveBeenCalledTimes(1);
    expect(controller.setLevel).toBeNull();
    expect(controller.timer).toBeNull();
    expect(controller.pending).toEqual([]);
  });
});
