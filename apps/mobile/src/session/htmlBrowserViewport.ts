/** Geometry only: the page receives no native callback, path, token or capability. */
export interface BrowserInsets { top: number; right: number; bottom: number; left: number }
export interface BrowserFrame { x: number; y: number; width: number; height: number }
export interface BrowserViewport {
  width: number;
  height: number;
  controls: BrowserInsets;
  insets: BrowserInsets;
  availableWidth: number;
  availableHeight: number;
}

/** All inputs are native window points; insets are relative to the measured WebView. */
export function browserViewport(frame: BrowserFrame, controls: BrowserInsets, keyboard: BrowserFrame | null): BrowserViewport {
  const clamp = (value: number, max: number) => Math.max(0, Math.min(max, value));
  const bounded = {
    top: clamp(controls.top, frame.height), bottom: clamp(controls.bottom, frame.height),
    left: clamp(controls.left, frame.width), right: clamp(controls.right, frame.width),
  };
  const overlaps = keyboard && keyboard.width > 0 && keyboard.height > 0
    && keyboard.x < frame.x + frame.width && keyboard.x + keyboard.width > frame.x
    && keyboard.y < frame.y + frame.height && keyboard.y + keyboard.height > frame.y;
  // A floating keyboard conservatively reserves everything below its top edge.
  // If Android already resized this view above the keyboard, overlap is zero.
  const bottom = Math.max(bounded.bottom, overlaps ? clamp(frame.y + frame.height - keyboard.y, frame.height) : 0);
  const insets = { ...bounded, bottom };
  return {
    width: frame.width, height: frame.height, controls: bounded, insets,
    availableWidth: Math.max(0, frame.width - insets.left - insets.right),
    availableHeight: Math.max(0, frame.height - insets.top - insets.bottom),
  };
}

/** Reinstalled for each document and native update; old page listeners are removed. */
export function browserViewportScript(viewport: BrowserViewport): string {
  return `(() => {
    const native = ${JSON.stringify(viewport)};
    const key = Symbol.for('cindy.browserViewport.cleanup');
    if (typeof window[key] === 'function') window[key]();
    let pending = 0;
    let last = '';
    const publish = () => {
      pending = 0;
      if (!document.documentElement) return;
      const scale = window.visualViewport?.scale || 1;
      const px = n => Math.round(n / scale * 1000) / 1000;
      const edges = value => Object.freeze(Object.fromEntries(Object.entries(value).map(([k,v]) => [k, px(v)])));
      const offset = window[Symbol.for('cindy.browserViewport.offset')] || { x: -native.controls.left, y: -native.controls.top };
      const value = Object.freeze({ version: 1, width: px(native.width), height: px(native.height),
        controls: edges(native.controls), insets: edges(native.insets),
        availableTop: px(offset.y + native.insets.top), availableLeft: px(offset.x + native.insets.left),
        availableWidth: px(native.availableWidth), availableHeight: px(native.availableHeight) });
      const signature = JSON.stringify(value);
      if (signature === last) return;
      last = signature;
      const style = document.documentElement.style;
      const set = (name, n) => style.setProperty('--cindy-' + name, n + 'px');
      set('viewport-width', value.width); set('viewport-height', value.height);
      set('available-width', value.availableWidth); set('available-height', value.availableHeight);
      set('available-top', value.availableTop); set('available-left', value.availableLeft);
      for (const side of ['top', 'right', 'bottom', 'left']) {
        set('controls-' + side, value.controls[side]);
        set('inset-' + side, value.insets[side]);
      }
      // Advisory page-local data, not a security boundary. A page may override its own globals.
      try { Object.defineProperty(window, 'cindyViewport', { configurable: true, get: () => value }); } catch {}
      window.dispatchEvent(new CustomEvent('cindyviewportchange', { detail: value }));
    };
    const schedule = () => { if (!pending) pending = requestAnimationFrame(publish); };
    window.addEventListener('resize', schedule);
    window.addEventListener('pageshow', schedule);
    window.addEventListener('cindy:viewport-scroll', schedule);
    document.addEventListener('DOMContentLoaded', schedule);
    window.visualViewport?.addEventListener('resize', schedule);
    window[key] = () => {
      cancelAnimationFrame(pending);
      window.removeEventListener('resize', schedule);
      window.removeEventListener('pageshow', schedule);
      window.removeEventListener('cindy:viewport-scroll', schedule);
      document.removeEventListener('DOMContentLoaded', schedule);
      window.visualViewport?.removeEventListener('resize', schedule);
    };
    publish();
  })(); true;`;
}

/** UIKit offset includes the negative initial contentInset; window.scrollY does not. */
export function browserViewportScrollScript(x: number, y: number): string {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return 'true;';
  return `window[Symbol.for('cindy.browserViewport.offset')] = ${JSON.stringify({ x, y })};
    window.dispatchEvent(new Event('cindy:viewport-scroll')); true;`;
}
