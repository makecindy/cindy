import { describe, expect, it } from 'vitest';

import {
  __composerRenderGateDefaultsForTest,
  composerRenderSnapshot,
  shouldRefreshComposerRender,
} from '../composerRenderGate';

describe('composer render gate', () => {
  it('skips ordinary text updates when trigger and send state are stable', () => {
    const none = composerRenderSnapshot({ kind: 'none' }, true, false);
    expect(shouldRefreshComposerRender(none, composerRenderSnapshot({ kind: 'none' }, true, false))).toBe(
      false,
    );
  });

  it('refreshes when text becomes sendable or empty', () => {
    expect(
      shouldRefreshComposerRender(
        composerRenderSnapshot({ kind: 'none' }, false, false),
        composerRenderSnapshot({ kind: 'none' }, true, false),
      ),
    ).toBe(true);
    expect(
      shouldRefreshComposerRender(
        composerRenderSnapshot({ kind: 'none' }, true, false),
        composerRenderSnapshot({ kind: 'none' }, false, false),
      ),
    ).toBe(true);
  });

  it('refreshes when a palette trigger changes', () => {
    const before = composerRenderSnapshot({ kind: 'slash', sigil: '/', query: '', from: 1 }, true, false);
    expect(
      shouldRefreshComposerRender(
        before,
        composerRenderSnapshot({ kind: 'slash', sigil: '/', query: 'he', from: 1 }, true, false),
      ),
    ).toBe(true);
    expect(
      shouldRefreshComposerRender(
        before,
        composerRenderSnapshot({ kind: 'slash', sigil: '$', query: '', from: 1 }, true, false),
      ),
    ).toBe(true);
  });

  it('refreshes when the trigger kind itself changes', () => {
    // 'none' -> a palette trigger opening.
    expect(
      shouldRefreshComposerRender(
        composerRenderSnapshot({ kind: 'none' }, true, false),
        composerRenderSnapshot({ kind: 'slash', sigil: '/', query: '', from: 1 }, true, false),
      ),
    ).toBe(true);
    // A palette trigger closing back to 'none'.
    expect(
      shouldRefreshComposerRender(
        composerRenderSnapshot({ kind: 'slash', sigil: '/', query: '', from: 1 }, true, false),
        composerRenderSnapshot({ kind: 'none' }, true, false),
      ),
    ).toBe(true);
    // One palette trigger kind swapping directly for the other.
    expect(
      shouldRefreshComposerRender(
        composerRenderSnapshot({ kind: 'slash', sigil: '/', query: '', from: 1 }, true, false),
        composerRenderSnapshot({ kind: 'at', query: '', from: 1 }, true, false),
      ),
    ).toBe(true);
  });

  it('refreshes when the draft crosses the single/multiline boundary', () => {
    expect(
      shouldRefreshComposerRender(
        composerRenderSnapshot({ kind: 'none' }, true, false),
        composerRenderSnapshot({ kind: 'none' }, true, true),
      ),
    ).toBe(true);
    expect(
      shouldRefreshComposerRender(
        composerRenderSnapshot({ kind: 'none' }, true, true),
        composerRenderSnapshot({ kind: 'none' }, true, false),
      ),
    ).toBe(true);
    expect(
      shouldRefreshComposerRender(
        composerRenderSnapshot({ kind: 'none' }, true, true),
        composerRenderSnapshot({ kind: 'none' }, true, true),
      ),
    ).toBe(false);
  });

  it('keeps the ordinary update default explicit', () => {
    expect(__composerRenderGateDefaultsForTest.ordinaryTextUpdatesRefresh).toBe(false);
  });
});
