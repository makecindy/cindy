/** @vitest-environment jsdom */
import { act, useLayoutEffect, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MessageViewport, type MessageViewportApi } from '../components/chat/MessageViewport';
import { acquirePageTextAccess, isPageTextAccessActive } from '../lib/pageTextAccess';

let host: HTMLDivElement;
let root: Root;
let frames: Map<number, FrameRequestCallback>;
let sequence: number;
let viewportHeight: number;
let scrollWrites: number[];
let rowMeasurements: number;
let parentRenders: number;
let notifyResize: () => void;
let syncViewport: () => void;
let reconcileViewport: () => void;
let setFollowing: (value: boolean) => void;
const entries = Array.from({ length: 80 }, (_, index) => ({ key: String(index), retain: index === 79 }));
const rectangle = (top: number, height: number) => ({ top, bottom: top + height, height, width: 800,
  left: 0, right: 800, x: 0, y: top, toJSON() {} }) as DOMRect;
function Fixture({ disabled = false, restore = false, restoreOffset, onProgrammaticScroll }: {
  disabled?: boolean; restore?: boolean; restoreOffset?: number; onProgrammaticScroll?: () => void;
}) {
  parentRenders++;
  const scrollRef = useRef<HTMLDivElement>(null);
  const itemsRef = useRef<HTMLDivElement>(null);
  const followRef = useRef(!restore);
  const apiRef = useRef<MessageViewportApi>(null);
  useLayoutEffect(() => { apiRef.current?.connect(); });
  useLayoutEffect(() => {
    if (restoreOffset !== undefined) scrollRef.current!.scrollTop = 40 * 180 + restoreOffset;
  }, [restoreOffset]);
  setFollowing = value => { followRef.current = value; };
  return <div ref={scrollRef} data-scroll="" onWheel={() => { followRef.current = false; }}>
    <MessageViewport apiRef={apiRef} options={{ entries, scrollRef, itemsRef, followRef, disabled, onProgrammaticScroll,
      initialAnchor: restore ? '40' : undefined,
      initialHeights: restore ? Object.fromEntries(entries.map(entry => [entry.key, 180])) : undefined,
    }}>{viewport => {
      syncViewport = () => apiRef.current!.syncViewport();
      reconcileViewport = () => apiRef.current!.reconcileViewport();
      return <div ref={itemsRef}>{entries.map(entry => viewport.shouldMount(entry)
      ? <div key={entry.key} data-render-item-key={entry.key}><button>Row {entry.key}</button></div>
      : <div key={entry.key} data-render-item-key={entry.key} data-message-placeholder=""
        style={{ height: viewport.placeholderHeight(entry.key) }} />)}</div>;
    }}</MessageViewport></div>;
}
async function flushFrames() {
  for (let i = 0; i < 5 && frames.size; i++) {
    const pending = [...frames.values()]; frames.clear();
    await act(async () => { pending.forEach(callback => callback(i * 16)); });
  }
}
const scroller = () => host.querySelector<HTMLElement>('[data-scroll]')!;
const row = (key: number) => host.querySelector<HTMLElement>(`[data-render-item-key="${key}"]`)!;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  frames = new Map(); sequence = 0; viewportHeight = 600; scrollWrites = []; rowMeasurements = 0; parentRenders = 0;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++sequence, callback); return sequence; });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => { frames.delete(id); });
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: () => void) { notifyResize = callback; }
    observe() {} unobserve() {} disconnect() {}
  });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (this.hasAttribute('data-render-item-key')) {
      rowMeasurements++;
      let top = 0;
      for (const sibling of Array.from(this.parentElement!.children) as HTMLElement[]) {
        if (sibling === this) break;
        top += Number.parseFloat(sibling.style.height) || 180;
      }
      return rectangle(top - scroller().scrollTop, Number.parseFloat(this.style.height) || 180);
    }
    return rectangle(0, viewportHeight);
  });
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(() => viewportHeight);
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (this: HTMLElement) {
    return Array.from(this.querySelectorAll<HTMLElement>('[data-render-item-key]'))
      .reduce((sum, row) => sum + (Number.parseFloat(row.style.height) || 180), 0);
  });
  // jsdom does not clamp scrollTop like a browser.
  const tops = new WeakMap<HTMLElement, number>();
  vi.spyOn(HTMLElement.prototype, 'scrollTop', 'get').mockImplementation(function (this: HTMLElement) { return tops.get(this) || 0; });
  vi.spyOn(HTMLElement.prototype, 'scrollTop', 'set').mockImplementation(function (this: HTMLElement, value: number) {
    scrollWrites.push(value);
    tops.set(this, Math.max(0, Math.min(value, this.scrollHeight - this.clientHeight)));
  });
  host = document.body.appendChild(document.createElement('div'));
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  document.getSelection()?.removeAllRanges();
  host.remove(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});
describe('message viewport content virtualization', () => {
  it('initializes before the owner restores a precise reading offset', async () => {
    await act(async () => root.render(<Fixture restore restoreOffset={97} />));
    await flushFrames();
    expect(row(40).getBoundingClientRect().top).toBe(-97);
    await act(async () => root.render(<Fixture restore restoreOffset={97} />));
    await flushFrames();
    expect(row(40).getBoundingClientRect().top).toBe(-97);
  });
  it('changes the mounted range without rerendering the owning thread or measuring every row', async () => {
    await act(async () => root.render(<Fixture restore />));
    await flushFrames();
    const before = parentRenders;
    rowMeasurements = 0;
    await act(async () => { scroller().scrollTop = 1800; syncViewport(); });
    await flushFrames();
    expect(row(10).querySelector('button')).not.toBeNull();
    expect(row(40).hasAttribute('data-message-placeholder')).toBe(true);
    expect(parentRenders).toBe(before);
    expect(rowMeasurements).toBeLessThan(entries.length);
  });
  it('reuses the measured interval for small scrolls without reading every row again', async () => {
    await act(async () => root.render(<Fixture restore />));
    await flushFrames();
    const mountedBefore = host.querySelectorAll('button').length;
    rowMeasurements = 0;
    await act(async () => {
      scroller().scrollTop += 16;
      syncViewport();
      scroller().dispatchEvent(new Event('scroll'));
    });
    expect(rowMeasurements).toBe(0);
    expect(host.querySelectorAll('button').length).toBe(mountedBefore);
    expect(row(40).querySelector('button')).not.toBeNull();
  });

  it('coalesces the scroll event following an already committed script jump', async () => {
    await act(async () => root.render(<Fixture restore />));
    await act(async () => { scroller().scrollTop = 1800; syncViewport(); });
    await flushFrames();
    expect(row(10).querySelector('button')).not.toBeNull();
    rowMeasurements = 0;
    await act(async () => {
      scroller().dispatchEvent(new Event('scroll'));
      syncViewport();
      reconcileViewport();
    });
    expect(rowMeasurements).toBe(0);
  });

  it('does not repeat a committed measurement when resize delivery catches up', async () => {
    await act(async () => root.render(<Fixture restore />));
    await flushFrames();
    await act(async () => { scroller().scrollTop = 1800; syncViewport(); });
    await flushFrames();
    rowMeasurements = 0;
    await act(async () => notifyResize());
    await flushFrames();
    expect(rowMeasurements).toBe(0);
  });

  it('invalidates the interval when nested rows redistribute height without changing the total', async () => {
    await act(async () => root.render(<Fixture restore />));
    await flushFrames();
    const total = scroller().scrollHeight;
    rowMeasurements = 0;
    await act(async () => {
      row(39).style.height = '270px';
      row(40).style.height = '90px';
      expect(scroller().scrollHeight).toBe(total);
      // Before MutationObserver delivery: synchronous navigation must also see it.
      syncViewport();
    });
    expect(rowMeasurements).toBeGreaterThan(0);
    expect(row(39).querySelector('button')).not.toBeNull();
    expect(row(40).querySelector('button')).not.toBeNull();
  });

  it('invalidates an unchanged scroll position when the viewport grows', async () => {
    await act(async () => root.render(<Fixture restore />));
    await flushFrames();
    expect(row(48).querySelector('button')).toBeNull();
    await act(async () => { viewportHeight = 1600; syncViewport(); });
    expect(row(48).querySelector('button')).not.toBeNull();
  });

  it('exposes every loaded body immediately when accessibility support is already enabled', async () => {
    vi.stubGlobal('electronAPI', { accessibilitySupport: { getSync: () => true, onChanged: () => () => {} } });
    await act(async () => root.render(<Fixture restore />));
    expect(host.querySelectorAll('button').length).toBe(80);
    expect(host.querySelectorAll('[data-message-placeholder]').length).toBe(0);
  });

  it('handles accessibility changes after subscription without changing logical rows or the reading anchor', async () => {
    let notify: (enabled: boolean) => void = () => {};
    const unsubscribe = vi.fn();
    vi.stubGlobal('electronAPI', { accessibilitySupport: {
      getSync: () => false,
      onChanged: (callback: typeof notify) => { notify = callback; return unsubscribe; },
    } });
    await act(async () => root.render(<Fixture restore />));
    await flushFrames();
    const before = row(40).getBoundingClientRect().top;
    expect(host.querySelectorAll('button').length).toBeLessThan(20);
    await act(async () => notify(true));
    expect(host.querySelectorAll('button').length).toBe(80);
    expect(row(40).getBoundingClientRect().top).toBe(before);
    await act(async () => notify(false));
    expect(host.querySelectorAll('button').length).toBeLessThan(20);
    expect(row(40).getBoundingClientRect().top).toBe(before);
    expect(host.querySelectorAll('[data-render-item-key]').length).toBe(80);
    await act(async () => root.render(null));
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('exposes only the logical window for page text consumers and restores virtualization on release', async () => {
    await act(async () => root.render(<Fixture restore />));
    await flushFrames();
    const before = row(40).getBoundingClientRect().top;
    let release = () => {};
    let releaseSecond = () => {};
    try {
      await act(async () => { release = acquirePageTextAccess(); releaseSecond = acquirePageTextAccess(); });
      expect(host.querySelectorAll('button').length).toBe(80);
      expect(row(40).getBoundingClientRect().top).toBe(before);
      await act(async () => { release(); release(); });
      expect(isPageTextAccessActive()).toBe(true);
      expect(host.querySelectorAll('button').length).toBe(80);
      await act(async () => releaseSecond());
      expect(isPageTextAccessActive()).toBe(false);
      expect(host.querySelectorAll('button').length).toBeLessThan(20);
      expect(row(40).getBoundingClientRect().top).toBe(before);
      expect(host.querySelectorAll('[data-render-item-key]').length).toBe(80);
    } finally { await act(async () => { release(); releaseSecond(); }); }
  });
  it.each([{ ctrlKey: true }, { metaKey: true }])('exposes page text before native select-all with BODY focused: %j', async modifiers => {
    // jsdom does not perform native select-all. Inspect the keydown commit
    // before the later settlement task checks the browser's resulting selection.
    vi.useFakeTimers();
    await act(async () => root.render(<Fixture />));
    await flushFrames();
    expect(document.activeElement).toBe(document.body);
    await act(async () => document.body.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'a', bubbles: true, ...modifiers,
    })));
    expect(host.querySelectorAll('button').length).toBe(80);
    expect(scroller().scrollHeight - scroller().scrollTop - viewportHeight).toBe(0);
    await act(async () => vi.runOnlyPendingTimers());
    expect(host.querySelectorAll('button').length).toBeLessThan(20);
  });
  it.each(['input', 'textarea'])('leaves select-all in an editable %s alone', async tag => {
    await act(async () => root.render(<Fixture />));
    await flushFrames();
    const input = host.appendChild(document.createElement(tag));
    input.focus();
    await act(async () => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', ctrlKey: true, bubbles: true })));
    expect(host.querySelectorAll('button').length).toBeLessThan(20);
  });
  it.each([false, true])('exposes offscreen controls before Tab enters from outside (reverse: %s), then releases on exit', async shiftKey => {
    vi.useFakeTimers();
    await act(async () => root.render(<Fixture restore />));
    const outside = host.appendChild(document.createElement('input'));
    outside.focus();
    expect(row(0).querySelector('button')).toBeNull();
    await act(async () => {
      outside.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey, bubbles: true }));
      // Assert during keydown, before the browser chooses its default target.
      expect(row(0).querySelector('button')).not.toBeNull();
      row(0).querySelector('button')!.focus();
      vi.runOnlyPendingTimers();
    });
    expect(host.querySelectorAll('button')).toHaveLength(80);
    await act(async () => { outside.focus(); vi.runOnlyPendingTimers(); });
    expect(host.querySelectorAll('button').length).toBeLessThan(20);
    // The row that was actually used keeps its state; untouched rows can unmount.
    expect(row(0).querySelector('button')).not.toBeNull();
    expect(row(1).hasAttribute('data-message-placeholder')).toBe(true);
  });
  it('releases a prevented external Tab that leaves focus outside the messages', async () => {
    vi.useFakeTimers();
    await act(async () => root.render(<Fixture restore />));
    const outside = host.appendChild(document.createElement('input'));
    outside.focus();
    outside.addEventListener('keydown', event => event.preventDefault());
    await act(async () => outside.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })));
    await act(async () => vi.runOnlyPendingTimers());
    expect(host.querySelectorAll('button').length).toBeLessThan(20);
  });
  it('releases select-all on selection collapse without moving the reading anchor', async () => {
    vi.useFakeTimers();
    await act(async () => root.render(<Fixture restore />));
    const before = row(40).getBoundingClientRect().top;
    await act(async () => {
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', ctrlKey: true, bubbles: true }));
      const range = document.createRange(); range.selectNodeContents(scroller());
      document.getSelection()!.addRange(range);
      document.dispatchEvent(new Event('selectionchange'));
      vi.runOnlyPendingTimers();
    });
    expect(host.querySelectorAll('button')).toHaveLength(80);
    await act(async () => { document.getSelection()!.removeAllRanges(); document.dispatchEvent(new Event('selectionchange')); });
    expect(host.querySelectorAll('button').length).toBeLessThan(20);
    expect(row(40).getBoundingClientRect().top).toBe(before);
  });
  it('preserves selections starting outside the stream and releases when they move outside', async () => {
    await act(async () => root.render(<Fixture restore />));
    const outside = document.createElement('span'); outside.textContent = 'Outside'; host.prepend(outside);
    await act(async () => {
      const range = document.createRange(); range.setStart(outside.firstChild!, 0); range.setEndAfter(row(40));
      document.getSelection()!.addRange(range); document.dispatchEvent(new Event('selectionchange'));
    });
    expect(host.querySelectorAll('button')).toHaveLength(80);
    await act(async () => {
      const range = document.createRange(); range.selectNodeContents(outside);
      document.getSelection()!.removeAllRanges(); document.getSelection()!.addRange(range);
      document.dispatchEvent(new Event('selectionchange'));
    });
    expect(host.querySelectorAll('button').length).toBeLessThan(20);
  });
  it('keeps page-text access active when a selection ends, then releases independently', async () => {
    await act(async () => root.render(<Fixture restore />));
    let release = () => {};
    try {
      await act(async () => { release = acquirePageTextAccess(); });
      await act(async () => document.dispatchEvent(new Event('selectionchange')));
      expect(host.querySelectorAll('button')).toHaveLength(80);
      await act(async () => release());
      expect(host.querySelectorAll('button').length).toBeLessThan(20);
    } finally { await act(async () => release()); }
  });
  it('mounts the bottom viewport and preserves full row geometry on first paint', async () => {
    await act(async () => root.render(<Fixture />));
    expect(host.querySelectorAll('button').length).toBeLessThan(20);
    expect(row(79).querySelector('button')).not.toBeNull();
    expect(scroller().scrollHeight - scroller().scrollTop - 600).toBeLessThan(1);
  });
  it('mounts rows reached by a large scroll and remembers heights when they leave', async () => {
    await act(async () => root.render(<Fixture />));
    await act(async () => { scroller().dispatchEvent(new WheelEvent('wheel', { bubbles: true })); scroller().scrollTop = 0; scroller().dispatchEvent(new Event('scroll')); });
    // The destination must exist before another animation frame is allowed.
    // Otherwise fast wheel/scrollbar input can paint a viewport of placeholders.
    expect(row(0).querySelector('button')).not.toBeNull();
    await flushFrames();
    expect(row(0).querySelector('button')).not.toBeNull();
    expect(scroller().scrollTop).toBe(0);
    expect(row(77).hasAttribute('data-message-placeholder')).toBe(true);
    expect(row(77).style.height).toBe('180px');
    expect(row(79).querySelector('button')).not.toBeNull();
  });
  it('starts around a restored reading anchor with remembered row heights', async () => {
    await act(async () => root.render(<Fixture restore />));
    await flushFrames();
    expect(row(40).querySelector('button')).not.toBeNull();
    expect(row(40).getBoundingClientRect().top).toBe(0);
    expect(row(0).style.height).toBe('180px');
    expect(host.querySelectorAll('button').length).toBeLessThan(20);
  });
  it('commits a programmatic jump before the browser has dispatched its scroll event', async () => {
    await act(async () => root.render(<Fixture restore />));
    await act(async () => {
      scroller().scrollTop = 1800;
      syncViewport();
      expect(row(10).querySelector('button')).not.toBeNull();
    });
    expect(row(10).getBoundingClientRect().top).toBe(0);
  });
  it('mounts a direct animation-frame write at its microtask checkpoint without a scroll event', async () => {
    await act(async () => root.render(<Fixture restore />));
    await flushFrames();
    expect(row(10).querySelector('button')).toBeNull();
    await act(async () => {
      requestAnimationFrame(() => { scroller().scrollTop = 1800; });
      const pending = [...frames.values()];
      frames.clear();
      pending.forEach(callback => callback(16));
      await new Promise<void>(resolve => queueMicrotask(resolve));
      // No scroll event or next animation frame has been delivered.
      expect(row(10).querySelector('button')).not.toBeNull();
      expect(row(10).getBoundingClientRect().top).toBe(0);
    });
    expect(host.querySelectorAll('button').length).toBeLessThan(20);
  });
  it('lets a new tail-follow intent supersede a queued reading anchor', async () => {
    await act(async () => root.render(<Fixture restore />));
    await act(async () => {
      scroller().scrollTop = 1800;
      reconcileViewport();
      setFollowing(true);
      scroller().scrollTop = scroller().scrollHeight;
    });
    expect(scroller().scrollHeight - scroller().scrollTop - viewportHeight).toBe(0);
    expect(row(78).querySelector('button')).not.toBeNull();
  });
  it('preserves a script jump away from the tail before scroll can clear the old follow flag', async () => {
    await act(async () => root.render(<Fixture />));
    await flushFrames();
    await act(async () => {
      scroller().scrollTop = 0;
      await new Promise<void>(resolve => queueMicrotask(resolve));
      expect(scroller().scrollTop).toBe(0);
      expect(row(0).querySelector('button')).not.toBeNull();
    });
    expect(host.querySelectorAll('button').length).toBeLessThan(20);
  });
  it('updates the owner before DOM observers can compensate toward a stale reading position', async () => {
    let savedTop = 40 * 180;
    const observeScroll = vi.fn(() => { savedTop = scroller().scrollTop; });
    await act(async () => root.render(<Fixture restore onProgrammaticScroll={observeScroll} />));
    await flushFrames();
    // Model the owner's existing content-height compensator: a DOM replacement
    // restores its last known reading point unless a scroll updated that point.
    const compensator = new MutationObserver(() => {
      if (scroller().scrollTop !== savedTop) scroller().scrollTop = savedTop;
    });
    compensator.observe(scroller(), { childList: true, subtree: true });
    try {
      await act(async () => {
        scroller().scrollTop = 1800;
        await new Promise<void>(resolve => queueMicrotask(resolve));
      });
      expect(observeScroll).toHaveBeenCalled();
      expect(scroller().scrollTop).toBe(1800);
      expect(row(10).querySelector('button')).not.toBeNull();
    } finally { compensator.disconnect(); }
  });
  it('does not rewrite an already aligned position when the mounted range changes', async () => {
    await act(async () => root.render(<Fixture restore />));
    await act(async () => {
      scroller().scrollTop = 1800;
      scrollWrites.length = 0;
      scroller().dispatchEvent(new Event('scroll'));
    });
    await flushFrames();
    expect(row(10).querySelector('button')).not.toBeNull();
    expect(scrollWrites).toEqual([]);
  });
  it('compensates the first scroll even when the initial mounted range already fits', async () => {
    viewportHeight = 1100;
    await act(async () => root.render(<Fixture />));
    expect(host.querySelectorAll('button').length).toBe(10);
    await act(async () => {
      scroller().dispatchEvent(new WheelEvent('wheel', { bubbles: true }));
      scroller().scrollTop = 50 * 240 + 30;
      scroller().dispatchEvent(new Event('scroll'));
    });
    await flushFrames();
    expect(row(50).querySelector('button')).not.toBeNull();
    expect(row(50).getBoundingClientRect().top).toBe(-30);
  });
  it('retains an interacted row after scrolling away', async () => {
    await act(async () => root.render(<Fixture />));
    await act(async () => row(77).querySelector('button')!.dispatchEvent(new Event('pointerdown', { bubbles: true })));
    await act(async () => { scroller().dispatchEvent(new WheelEvent('wheel', { bubbles: true })); scroller().scrollTop = 0; scroller().dispatchEvent(new Event('scroll')); });
    await flushFrames();
    expect(row(77).querySelector('button')).not.toBeNull();
  });
  it('exposes loaded rows for sharing and keyboard selection', async () => {
    vi.useFakeTimers();
    await act(async () => root.render(<Fixture disabled />));
    expect(host.querySelectorAll('button').length).toBe(80);
    await act(async () => root.render(<Fixture />));
    await act(async () => scroller().dispatchEvent(new KeyboardEvent('keydown', { key: 'a', ctrlKey: true, bubbles: true })));
    expect(host.querySelectorAll('button').length).toBe(80);
  });
});
