/** @vitest-environment jsdom */
import { describe, expect, it, vi } from 'vitest';
import { observeProgrammaticScroll } from '../components/chat/observeProgrammaticScroll';

const checkpoint = () => new Promise<void>(resolve => queueMicrotask(resolve));

describe('owned scroll container write observation', () => {
  it('batches changed writes after the caller finishes without modifying the DOM prototype', async () => {
    const element = document.createElement('div');
    const other = document.createElement('div');
    const prototype = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop');
    const onChange = vi.fn();
    const stop = observeProgrammaticScroll(element, onChange);
    element.scrollTop = 100;
    element.scrollTop = 200;
    other.scrollTop = 300;
    expect(onChange).not.toHaveBeenCalled();
    await checkpoint();
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(element.scrollTop).toBe(200);
    expect(Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop')).toEqual(prototype);
    expect(Object.hasOwn(other, 'scrollTop')).toBe(false);
    stop();
    expect(Object.hasOwn(element, 'scrollTop')).toBe(false);
  });

  it('preserves native clamping and still calls the setter for unchanged positions', async () => {
    const element = document.createElement('div');
    let top = 0;
    const write = vi.fn((value: number) => { top = Math.max(0, Math.min(500, value)); });
    const original = { configurable: true, enumerable: false, get: () => top, set: write };
    Object.defineProperty(element, 'scrollTop', original);
    const onChange = vi.fn();
    const stop = observeProgrammaticScroll(element, onChange);
    element.scrollTop = 800;
    await checkpoint();
    expect(element.scrollTop).toBe(500);
    expect(onChange).toHaveBeenCalledTimes(1);
    element.scrollTop = 900;
    await checkpoint();
    // An unchanged write can cancel a native smooth scroll, so it must not be elided.
    expect(write).toHaveBeenCalledTimes(2);
    expect(onChange).toHaveBeenCalledTimes(1);
    stop();
    expect(Object.getOwnPropertyDescriptor(element, 'scrollTop')).toEqual(original);
  });

  it('cancels pending work on cleanup and can observe the same element again', async () => {
    const element = document.createElement('div');
    const first = vi.fn();
    const stop = observeProgrammaticScroll(element, first);
    element.scrollTop = 100;
    stop();
    const next = vi.fn();
    const stopNext = observeProgrammaticScroll(element, next);
    element.scrollTop = 200;
    await checkpoint();
    expect(first).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
    stopNext();
  });

  it('does not clobber a later owner and leaves its saved setter functional after cleanup', async () => {
    const element = document.createElement('div');
    const onChange = vi.fn();
    const stop = observeProgrammaticScroll(element, onChange);
    const observed = Object.getOwnPropertyDescriptor(element, 'scrollTop')!;
    const later = { ...observed, set(value: number) { observed.set!.call(element, value); } };
    Object.defineProperty(element, 'scrollTop', later);
    stop();
    element.scrollTop = 100;
    await checkpoint();
    expect(element.scrollTop).toBe(100);
    expect(onChange).not.toHaveBeenCalled();
    expect(Object.getOwnPropertyDescriptor(element, 'scrollTop')).toEqual(later);
  });

  it('leaves a non-configurable property intact', async () => {
    const element = document.createElement('div');
    Object.defineProperty(element, 'scrollTop', { configurable: false, value: 10, writable: true });
    const onChange = vi.fn();
    const stop = observeProgrammaticScroll(element, onChange);
    element.scrollTop = 20;
    await checkpoint();
    stop();
    expect(element.scrollTop).toBe(20);
    expect(onChange).not.toHaveBeenCalled();
  });
});
