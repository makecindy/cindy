import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ShortcutHoldPhaseController } from '../ShortcutHoldPhaseController';

describe('ShortcutHoldPhaseController', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('classifies a short press as start followed by tap', () => {
    const onTrigger = vi.fn();
    const controller = new ShortcutHoldPhaseController({ onTrigger });

    controller.setPressed(true);
    vi.advanceTimersByTime(449);
    controller.setPressed(false);

    expect(onTrigger.mock.calls.map(([phase]) => phase)).toEqual(['start', 'tap']);
  });

  it('classifies a held press as start followed by end', () => {
    const onTrigger = vi.fn();
    const controller = new ShortcutHoldPhaseController({ onTrigger });

    controller.setPressed(true);
    vi.advanceTimersByTime(450);
    controller.setPressed(false);

    expect(onTrigger.mock.calls.map(([phase]) => phase)).toEqual(['start', 'end']);
  });

  it('ignores repeated key-down messages while the key is held', () => {
    const onTrigger = vi.fn();
    const controller = new ShortcutHoldPhaseController({ onTrigger });

    controller.setPressed(true);
    controller.setPressed(true);
    vi.advanceTimersByTime(500);
    controller.setPressed(false);

    expect(onTrigger.mock.calls.map(([phase]) => phase)).toEqual(['start', 'end']);
  });

  it('ends an active press when the native listener stops or the system suspends', () => {
    const onTrigger = vi.fn();
    const controller = new ShortcutHoldPhaseController({ onTrigger });

    controller.setPressed(true);
    controller.releaseIfPressed();
    controller.releaseIfPressed();

    expect(onTrigger.mock.calls.map(([phase]) => phase)).toEqual(['start', 'end']);
  });

  it('cancels a held chord when another key joins, then waits for the real key-up', () => {
    const onTrigger = vi.fn();
    const controller = new ShortcutHoldPhaseController({ onTrigger });

    controller.setPressed(true, true);
    controller.setPressed(false, true);
    controller.setPressed(true, true);
    controller.setPressed(false, false);

    expect(onTrigger.mock.calls.map(([phase]) => phase)).toEqual(['start', 'end']);
  });

  it('starts a new activation only after the cancelled target key is released', () => {
    const onTrigger = vi.fn();
    const controller = new ShortcutHoldPhaseController({ onTrigger });

    controller.setPressed(true, true);
    controller.setPressed(false, true);
    controller.setPressed(false, false);
    controller.setPressed(true, true);
    vi.advanceTimersByTime(450);
    controller.setPressed(false, false);

    expect(onTrigger.mock.calls.map(([phase]) => phase)).toEqual(['start', 'end', 'start', 'end']);
  });

  it('does not start when the target key arrives while another key is already down', () => {
    const onTrigger = vi.fn();
    const controller = new ShortcutHoldPhaseController({ onTrigger });

    controller.setPressed(false, true);
    controller.setPressed(true, true);
    controller.setPressed(false, false);

    expect(onTrigger).not.toHaveBeenCalled();
  });
});
