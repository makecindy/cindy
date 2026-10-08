// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { browserViewport, browserViewportScript, browserViewportScrollScript } from '@/session/htmlBrowserViewport';

const portrait = { x: 0, y: 0, width: 402, height: 874 };
const controls = { top: 122, right: 0, bottom: 94, left: 0 };
const geometry = () => browserViewport(portrait, controls, null);
const run = (value = geometry()) => new Function(browserViewportScript(value))();
afterEach(() => {
  (window as any)[Symbol.for('cindy.browserViewport.cleanup')]?.();
  delete (window as any).cindyViewport;
  delete (window as any)[Symbol.for('cindy.browserViewport.offset')];
  vi.unstubAllGlobals();
});

describe('WebView geometry', () => {
  it('reserves controls and safe area without changing CSS viewport units', () => {
    expect(geometry()).toEqual({ width: 402, height: 874, controls, insets: controls, availableWidth: 402, availableHeight: 658 });
  });
  it('takes the union of keyboard and controls, rather than adding both heights', () => {
    const result = browserViewport(portrait, controls, { x: 0, y: 505, width: 402, height: 369 });
    expect(result.availableHeight).toBe(383);
    expect(result.insets.bottom).toBe(369);
    expect(result.controls.bottom).toBe(94);
  });
  it('updates landscape and horizontal safe areas', () => {
    expect(browserViewport({ x: 0, y: 0, width: 874, height: 402 }, { top: 60, bottom: 80, left: 62, right: 62 }, null))
      .toMatchObject({ availableWidth: 750, availableHeight: 262 });
  });
  it('measures a smaller reader in window coordinates without deducting Android resize twice', () => {
    expect(browserViewport({ x: 20, y: 122, width: 360, height: 383 }, { top: 0, bottom: 0, left: 0, right: 0 },
      { x: 0, y: 505, width: 402, height: 369 }).availableHeight).toBe(383);
  });
  it('ignores keyboards outside the reader and conservatively handles overlapping floating keyboards', () => {
    expect(browserViewport(portrait, controls, { x: 500, y: 300, width: 200, height: 200 }).availableHeight).toBe(658);
    expect(browserViewport(portrait, controls, { x: 200, y: 300, width: 200, height: 200 }).availableHeight).toBe(178);
  });
  it('clamps fully occluded and transient tiny frames to zero', () => {
    expect(browserViewport({ ...portrait, height: 70 }, controls, null).availableHeight).toBe(0);
  });
});

describe('page-local viewport contract', () => {
  it('starts a directly loaded landscape document at its existing native left inset', () => {
    run(browserViewport({ x: 0, y: 0, width: 874, height: 402 }, { top: 60, bottom: 80, left: 62, right: 62 }, null));
    expect((window as any).cindyViewport).toMatchObject({ availableTop: 0, availableLeft: 0, availableWidth: 750 });
  });
  it('converts native scroll offsets to a document origin without doubling the initial inset', () => {
    run();
    expect((window as any).cindyViewport.availableTop).toBe(0);
    new Function(browserViewportScrollScript(0, -60))();
    // Rotation back to portrait can retain the old landscape offset of -60.
    run();
    expect((window as any).cindyViewport.availableTop).toBe(62);
    new Function(browserViewportScrollScript(10, 250))();
    run();
    expect((window as any).cindyViewport).toMatchObject({ availableTop: 372, availableLeft: 10 });
    expect(browserViewportScrollScript(NaN, Infinity)).toBe('true;');
  });
  it('publishes frozen geometry and CSS lengths without creating an inbound bridge', () => {
    const listener = vi.fn();
    window.addEventListener('cindyviewportchange', listener, { once: true });
    run();
    expect(document.documentElement.style.getPropertyValue('--cindy-available-height')).toBe('658px');
    const value = (window as any).cindyViewport;
    expect(Object.isFrozen(value)).toBe(true);
    expect(Object.isFrozen(value.insets)).toBe(true);
    expect(Object.getOwnPropertyDescriptor(window, 'cindyViewport')?.set).toBeUndefined();
    expect(listener).toHaveBeenCalledOnce();
    expect(browserViewportScript(geometry())).not.toMatch(/postMessage|ReactNativeWebView/);
  });
  it('converts native points to CSS px for zoomed or viewport-less pages', () => {
    vi.stubGlobal('visualViewport', Object.assign(new EventTarget(), { scale: 0.5 }));
    run();
    expect((window as any).cindyViewport.availableHeight).toBe(1316);
    expect(document.documentElement.style.getPropertyValue('--cindy-inset-top')).toBe('244px');
  });
  it('replaces listeners on native updates and reads current zoom when the page resizes', () => {
    const viewport = Object.assign(new EventTarget(), { scale: 1 });
    vi.stubGlobal('visualViewport', viewport);
    let callback: FrameRequestCallback | undefined;
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { callback = cb; return 1; });
    run();
    run(browserViewport(portrait, controls, { x: 0, y: 505, width: 402, height: 369 }));
    const changed = vi.fn();
    window.addEventListener('cindyviewportchange', changed);
    viewport.scale = 2;
    viewport.dispatchEvent(new Event('resize'));
    callback!(0);
    expect((window as any).cindyViewport.availableHeight).toBe(191.5);
    expect(changed).toHaveBeenCalledOnce();
    window.removeEventListener('cindyviewportchange', changed);
  });
  it('works on the next document and never forces body padding or height', () => {
    run();
    expect(document.body.style.cssText).toBe('');
    delete (window as any).cindyViewport;
    run();
    expect((window as any).cindyViewport.version).toBe(1);
  });
});
