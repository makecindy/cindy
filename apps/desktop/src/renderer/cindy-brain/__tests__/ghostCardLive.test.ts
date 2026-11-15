import { afterEach, describe, expect, it, vi } from 'vitest';

import { startGhostCardLiveIndicators } from '../ghostCardLive';

// Production entry: GhostToolCard calls this on every card document load. The pulse must stop
// costing frames when the card is off screen and must not run at all with reduced motion.
describe('startGhostCardLiveIndicators', () => {
  afterEach(() => vi.unstubAllGlobals());

  function fakeDoc() {
    const animation = { playState: 'running', play: vi.fn(function (this: { playState: string }) { this.playState = 'running'; }),
      pause: vi.fn(function (this: { playState: string }) { this.playState = 'paused'; }), cancel: vi.fn() };
    const el = { animate: vi.fn(() => animation) };
    const doc = { querySelectorAll: vi.fn(() => [el]), getAnimations: () => [] } as unknown as Document;
    return { doc, el, animation };
  }

  it('pauses off screen, resumes on screen, and cleans up', () => {
    let onChange: (entries: Array<{ isIntersecting: boolean }>) => void = () => {};
    const disconnect = vi.fn();
    vi.stubGlobal('IntersectionObserver', class {
      constructor(cb: typeof onChange) { onChange = cb; }
      observe() {}
      disconnect = disconnect;
    });
    const { doc, el, animation } = fakeDoc();
    const frame = { ownerDocument: { documentElement: { hasAttribute: () => false }, defaultView: {} } } as unknown as HTMLIFrameElement;
    const stop = startGhostCardLiveIndicators(doc, frame, () => false);
    expect(el.animate).toHaveBeenCalledWith(expect.any(Array), expect.objectContaining({ iterations: Infinity }));
    onChange([{ isIntersecting: false }]);
    expect(animation.pause).toHaveBeenCalled();
    onChange([{ isIntersecting: true }]);
    expect(animation.play).toHaveBeenCalled();
    stop();
    expect(animation.cancel).toHaveBeenCalled();
    expect(disconnect).toHaveBeenCalled();
  });

  it('does not animate with reduced motion', () => {
    const { doc, el } = fakeDoc();
    startGhostCardLiveIndicators(doc, {} as HTMLIFrameElement, () => true);
    expect(el.animate).not.toHaveBeenCalled();
  });
});
