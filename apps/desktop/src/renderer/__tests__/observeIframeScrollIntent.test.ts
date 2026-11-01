/** @vitest-environment jsdom */
import { describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { observeIframeScrollIntent, useIframeScrollIntent } from '../components/chat/observeIframeScrollIntent';

// #8124, unit: wheel stays in an iframe document while scroll chaining reaches
// the list. Existing restoration tests only cover input in the parent document.
function setup() {
  const root = document.createElement('div');
  const frame = document.createElement('iframe');
  const text = document.createElement('div');
  root.append(frame, text);
  let restoring = true;
  let programmatic = false;
  const takeOver = vi.fn(() => { restoring = false; });
  const stop = observeIframeScrollIntent(root, () => restoring && !programmatic, takeOver);
  // Same ordering as MessageStream's restoration branch: capture input first,
  // then decide whether this scroll should restore the saved position.
  root.addEventListener('scroll', () => { if (restoring) root.scrollTop = 100; });
  const scroll = () => {
    root.scrollTop = 180;
    root.dispatchEvent(new Event('scroll'));
    return root.scrollTop;
  };
  const over = (target: HTMLElement) => target.dispatchEvent(new Event('pointerover', { bubbles: true }));
  return { root, frame, text, takeOver, stop, scroll, over,
    setProgrammatic: (value: boolean) => { programmatic = value; } };
}

describe('iframe scroll takeover', () => {
  it('retains iframe hover across rerenders and uses the current takeover callback', async () => {
    // Review regression: history/message changes used to rebuild the listener,
    // losing hover even though the pointer never left the embedded document.
    const actGlobal = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
    const previousActEnvironment = actGlobal.IS_REACT_ACT_ENVIRONMENT;
    actGlobal.IS_REACT_ACT_ENVIRONMENT = true;
    const host = document.createElement('div');
    const list = document.createElement('div');
    const frame = document.createElement('iframe');
    list.append(frame);
    const rootRef = { current: list };
    const root = createRoot(host);
    let restoring = true;
    const before = vi.fn();
    const after = vi.fn(() => { restoring = false; });
    function Fixture({ takeOver }: { takeOver: () => void }) {
      useIframeScrollIntent(rootRef, () => restoring, takeOver);
      return null;
    }
    try {
      await act(async () => { root.render(createElement(Fixture, { takeOver: before })); });
      frame.dispatchEvent(new Event('pointerover', { bubbles: true }));
      await act(async () => { root.render(createElement(Fixture, { takeOver: after })); });
      list.addEventListener('scroll', () => { if (restoring) list.scrollTop = 100; });
      list.scrollTop = 180;
      list.dispatchEvent(new Event('scroll'));
      expect(list.scrollTop).toBe(180);
      expect(before).not.toHaveBeenCalled();
      expect(after).toHaveBeenCalledOnce();
    } finally {
      await act(async () => { root.unmount(); });
      actGlobal.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
    }
  });

  it('releases restoration before the list can pull a chained scroll back', () => {
    const h = setup();
    h.over(h.frame);
    expect(h.scroll()).toBe(180);
    expect(h.takeOver).toHaveBeenCalledOnce();
    h.scroll();
    expect(h.takeOver).toHaveBeenCalledOnce();
    h.stop();
  });

  it('keeps programmatic restoration and ordinary layout correction intact', () => {
    const h = setup();
    expect(h.scroll()).toBe(100);
    h.over(h.frame);
    h.setProgrammatic(true);
    expect(h.scroll()).toBe(100);
    h.setProgrammatic(false);
    expect(h.scroll()).toBe(180);
    h.stop();
  });

  it.each(['pointerout', 'removed', 'cleanup'] as const)('does not retain stale iframe intent after %s', mode => {
    const h = setup();
    h.over(h.frame);
    if (mode === 'pointerout') {
      h.frame.dispatchEvent(new Event('pointerout', { bubbles: true }));
      h.over(h.text);
    } else if (mode === 'removed') h.frame.remove();
    else h.stop();
    expect(h.scroll()).toBe(100);
    expect(h.takeOver).not.toHaveBeenCalled();
    h.stop();
  });

  it('ignores nested scrolling that does not move the list', () => {
    const h = setup();
    h.over(h.frame);
    h.text.dispatchEvent(new Event('scroll'));
    expect(h.takeOver).not.toHaveBeenCalled();
    expect(h.scroll()).toBe(180);
    h.stop();
  });
});
