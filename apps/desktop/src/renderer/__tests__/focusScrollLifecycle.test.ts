import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  pickIntersectingChildAnchor,
  readAnchorClientId,
  readViewportChildAnchorClientId,
  resolveChipJumpTargetScrollTop,
  resolveDeleteCompensationLanding,
  resolveProgrammaticScrollEndDecision,
  shouldRefreshExpandedChildViewportAnchor,
  shouldRefreshHiddenChildViewportAnchor,
  shouldUseFocusedElementAsViewportAnchor,
  toRenderItemViewportSnapshot,
} from '../components/chat/MessageStream';

const messageStreamSource = readFileSync(
  new URL('../components/chat/MessageStream.tsx', import.meta.url),
  'utf8',
).replace(/\r\n/g, '\n');

function sourceBetween(start: string, end: string): string {
  const startIndex = messageStreamSource.indexOf(start);
  const endIndex = messageStreamSource.indexOf(end, startIndex + start.length);
  if (startIndex < 0 || endIndex < 0) {
    throw new Error(`MessageStream source markers not found: ${start} → ${end}`);
  }
  return messageStreamSource.slice(startIndex, endIndex);
}

describe('focus scroll cancellation decisions', () => {
  it('replays a deferred deletion when the user takes over the active focus scroll', () => {
    expect(
      resolveProgrammaticScrollEndDecision({
        generation: 7,
        activeGeneration: 7,
        hasDeferredDelete: true,
      }),
    ).toBe('replay-deferred-delete');
  });

  it('lets an explicit replacement navigation consume the old deletion compensation', () => {
    expect(
      resolveProgrammaticScrollEndDecision({
        generation: 7,
        activeGeneration: 7,
        hasDeferredDelete: true,
        consumeDeferredDelete: true,
      }),
    ).toBe('consume-deferred-delete');
  });

  it('does not let a stale focus callback mutate a newer navigation generation', () => {
    expect(
      resolveProgrammaticScrollEndDecision({
        generation: 7,
        activeGeneration: 8,
        hasDeferredDelete: true,
      }),
    ).toBe('stale');
  });
});

describe('chip jump settlement', () => {
  it('recomputes the landing from settled target geometry after content above it is deleted', () => {
    expect(
      resolveChipJumpTargetScrollTop({
        scrollTop: 240,
        containerTop: 100,
        targetTop: 62,
        topOffset: 12,
      }),
    ).toBe(190);
  });

  it('clamps a target shifted above the scroll range to the top', () => {
    expect(
      resolveChipJumpTargetScrollTop({
        scrollTop: 20,
        containerTop: 100,
        targetTop: 40,
        topOffset: 12,
      }),
    ).toBe(0);
  });
});

describe('focused message viewport anchor decisions', () => {
  it('keeps the measured viewport anchor when the focused message is centered below the top', () => {
    expect(
      shouldUseFocusedElementAsViewportAnchor({
        focusClientId: 'focused',
        elementClientId: 'focused',
        containerTop: 100,
        elementTop: 240,
        elementBottom: 320,
      }),
    ).toBe(false);
  });

  it('uses an exact focused message that crosses the viewport top', () => {
    expect(
      shouldUseFocusedElementAsViewportAnchor({
        focusClientId: 'focused',
        elementClientId: 'focused',
        containerTop: 100,
        elementTop: 80,
        elementBottom: 160,
      }),
    ).toBe(true);
  });

  it('does not treat a folded work-group fallback as the hidden focused message', () => {
    expect(
      shouldUseFocusedElementAsViewportAnchor({
        focusClientId: 'focused',
        containerTop: 100,
        elementTop: 80,
        elementBottom: 160,
      }),
    ).toBe(false);
  });

  it('drops a hidden child anchor when precise DOM restoration falls back to its render item', () => {
    expect(
      toRenderItemViewportSnapshot(
        {
          viewportTopKey: 'work-summary-task',
          offset: 48,
          messageClientId: 'hidden-child',
          messageOffset: 12,
        },
        0,
      ),
    ).toEqual({ viewportTopKey: 'work-summary-task', offset: 0 });
  });

  it('lands delete compensation on a visible collapsed container instead of a hidden child', () => {
    expect(
      resolveDeleteCompensationLanding({
        exactVisible: true,
        fallbackContainerVisible: true,
      }),
    ).toBe('exact');
    expect(
      resolveDeleteCompensationLanding({
        exactVisible: false,
        fallbackContainerVisible: true,
      }),
    ).toBe('container');
    expect(
      resolveDeleteCompensationLanding({
        exactVisible: false,
        fallbackContainerVisible: false,
      }),
    ).toBe('item');
  });

  it('refreshes a child snapshot only when collapse hid it without deleting the data', () => {
    expect(
      shouldRefreshHiddenChildViewportAnchor({
        snapshotMessageClientId: 'hidden-child',
        exactChildVisible: false,
        childStillInRenderItems: true,
      }),
    ).toBe(true);
    expect(
      shouldRefreshHiddenChildViewportAnchor({
        snapshotMessageClientId: 'hidden-child',
        exactChildVisible: false,
        childStillInRenderItems: false,
      }),
    ).toBe(false);
    expect(
      shouldRefreshHiddenChildViewportAnchor({
        snapshotMessageClientId: 'hidden-child',
        exactChildVisible: true,
        childStillInRenderItems: true,
      }),
    ).toBe(false);
    expect(
      shouldRefreshHiddenChildViewportAnchor({
        snapshotMessageClientId: undefined,
        exactChildVisible: false,
        childStillInRenderItems: true,
      }),
    ).toBe(false);
  });

  it('remeasures after expand only when the viewport-top item gained a visible child', () => {
    expect(
      shouldRefreshExpandedChildViewportAnchor({
        snapshotMessageClientId: undefined,
        viewportTopItemHasVisibleExactChild: true,
      }),
    ).toBe(true);
    expect(
      shouldRefreshExpandedChildViewportAnchor({
        snapshotMessageClientId: undefined,
        viewportTopItemHasVisibleExactChild: false,
      }),
    ).toBe(false);
    expect(
      shouldRefreshExpandedChildViewportAnchor({
        snapshotMessageClientId: 'already-anchored',
        viewportTopItemHasVisibleExactChild: true,
      }),
    ).toBe(false);
  });
});

describe('viewport child anchors', () => {
  it('prefers an exact message id over a tool-block token list', () => {
    expect(
      readAnchorClientId({
        dataset: { messageClientId: 'row-2', messageClientIds: 't1 t2' },
      }),
    ).toBe('row-2');
    expect(readAnchorClientId({ dataset: { messageClientIds: ' t1  t2 ' } })).toBe('t1');
    expect(readAnchorClientId({ dataset: {} })).toBeUndefined();
  });

  it('ignores aggregate token lists when snapshotting the viewport child', () => {
    expect(
      readViewportChildAnchorClientId({
        dataset: { messageClientId: 'row-2', messageClientIds: 't1 t2' },
      }),
    ).toBe('row-2');
    expect(
      readViewportChildAnchorClientId({ dataset: { messageClientIds: 'hidden-1 hidden-2' } }),
    ).toBeUndefined();
    expect(readViewportChildAnchorClientId({ dataset: {} })).toBeUndefined();
  });

  it('keeps the innermost intersecting child when a work-group block wraps a tool row', () => {
    expect(
      pickIntersectingChildAnchor(
        [
          { clientId: 't1', top: 40, bottom: 280 },
          { clientId: 'row-2', top: 90, bottom: 130 },
        ],
        100,
      ),
    ).toEqual({ clientId: 'row-2', offset: 10 });
  });

  it('skips children that sit entirely above or below the viewport top', () => {
    expect(
      pickIntersectingChildAnchor(
        [
          { clientId: 'above', top: 0, bottom: 80 },
          { clientId: 'cross', top: 90, bottom: 140 },
          { clientId: 'below', top: 160, bottom: 200 },
        ],
        100,
      ),
    ).toEqual({ clientId: 'cross', offset: 10 });
  });
});

describe('MessageStream focus cancellation wiring', () => {
  it('routes wheel, touch, pointer, and keyboard takeover through the replaying cancel path', () => {
    const takeover = sourceBetween('const onUserInput = () => {', 'const onNavigationKey');
    expect(takeover).toContain('cancelFocusJump();');
    expect(takeover).not.toContain('deferredDeleteCompensationRef.current = false');
  });

  it('cancels the old focus before the portaled previous-message chip starts smooth scrolling', () => {
    const previousMessageJump = sourceBetween(
      'const handleJumpToPrevUserMsg = useCallback(() => {',
      'const prevPreview =',
    );
    const cancelIndex = previousMessageJump.indexOf(
      'cancelFocusJump({ consumeDeferredDelete: true });',
    );
    const beginIndex = previousMessageJump.indexOf('beginChipJump({');
    const smoothScrollIndex = previousMessageJump.indexOf(
      "el.scrollIntoView({ behavior: 'smooth', block: 'start' });",
    );
    expect(cancelIndex).toBeGreaterThanOrEqual(0);
    expect(beginIndex).toBeGreaterThanOrEqual(0);
    expect(smoothScrollIndex).toBeGreaterThanOrEqual(0);
    expect(cancelIndex).toBeLessThan(beginIndex);
    expect(beginIndex).toBeLessThan(smoothScrollIndex);
    expect(previousMessageJump).toContain('clientId: prevUserMsgId');
    expect(previousMessageJump).toContain("selector: 'user-message'");
  });

  it('replays a deferred deletion before the message navigation rail requests a fallible target', () => {
    const railJump = sourceBetween(
      'const handleNavRailJump = useCallback((clientId: string) => {',
      'useLayoutEffect(() => {',
    );
    const cancelIndex = railJump.indexOf('cancelFocusJump();');
    const requestIndex = railJump.indexOf(
      'setRailJumpRequest({ id: clientId, seq: railJumpSeqRef.current });',
    );
    expect(cancelIndex).toBeGreaterThanOrEqual(0);
    expect(railJump).not.toContain('consumeDeferredDelete: true');
    expect(requestIndex).toBeGreaterThanOrEqual(0);
    expect(cancelIndex).toBeLessThan(requestIndex);
  });

  it('tracks the message navigation rail smooth scroll before moving to its target', () => {
    const railJumpEffect = sourceBetween(
      'useLayoutEffect(() => {\n    if (!railJumpRequest) return;',
      '// 第一条 user 消息没有',
    );
    const beginIndex = railJumpEffect.indexOf('beginChipJump({');
    const smoothScrollIndex = railJumpEffect.indexOf(
      "root.scrollTo({ top: Math.max(0, targetTop), behavior: 'smooth' });",
    );
    expect(beginIndex).toBeGreaterThanOrEqual(0);
    expect(smoothScrollIndex).toBeGreaterThanOrEqual(0);
    expect(beginIndex).toBeLessThan(smoothScrollIndex);
    expect(railJumpEffect).toContain('clientId: railJumpRequest.id');
    expect(railJumpEffect).toContain('topOffset: NAV_RAIL_JUMP_TOP_OFFSET_PX');
  });

  it('re-resolves the saved target before consuming an earlier deferred deletion', () => {
    const settlement = sourceBetween(
      'const settleChipJump = useCallback(',
      'const beginChipJump = useCallback(',
    );
    const queryIndex = settlement.indexOf('root.querySelector<HTMLElement>');
    const consumeIndex = settlement.indexOf('deferredDeleteCompensationRef.current = false');
    const finishIndex = settlement.indexOf(
      'requestAnimationFrame(() => finishChipJump(generation, { refreshAnchor: true }))',
    );
    expect(queryIndex).toBeGreaterThanOrEqual(0);
    expect(consumeIndex).toBeGreaterThan(queryIndex);
    expect(finishIndex).toBeGreaterThan(consumeIndex);
    expect(settlement).not.toContain('consumeDeferredDelete: true');
  });

  it('measures rendered child ids and skips collapsed aggregate containers', () => {
    const measure = sourceBetween(
      'const measureViewportTop = useCallback',
      'const refreshViewportAnchor = useCallback',
    );
    expect(measure).toContain("querySelectorAll<HTMLElement>('[data-message-client-id]')");
    expect(measure).not.toContain('[data-message-client-ids]');
    expect(measure).toContain('pickIntersectingChildAnchor(');
    expect(measure).toContain('readViewportChildAnchorClientId(element)');
  });

  it('remeasures a hidden child snapshot when a work group collapses', () => {
    const refreshHidden = sourceBetween(
      'const refreshHiddenChildViewportAnchor = useCallback(() => {',
      'const scrollKeyToViewportTop = useCallback',
    );
    expect(refreshHidden).toContain('queryMessageElement(root, clientId)');
    expect(refreshHidden).toContain('shouldRefreshHiddenChildViewportAnchor(');
    expect(refreshHidden).toContain('shouldRefreshExpandedChildViewportAnchor(');
    expect(refreshHidden).toContain('hasVisibleExactChildAnchor(itemElement)');
    expect(refreshHidden).toContain('toRenderItemViewportSnapshot(snapshot)');
    expect(refreshHidden).toContain('refreshViewportAnchor()');
    const resizeObserver = sourceBetween(
      'const ro = new ResizeObserver(() => {',
      'ro.observe(content);',
    );
    expect(resizeObserver).toContain('refreshHiddenChildViewportAnchor()');
    expect(resizeObserver).toContain('if (isNearBottomRef.current)');
    const collapseObserver = sourceBetween(
      'const observer = new MutationObserver(() => {',
      'observer.observe(items, { childList: true, subtree: true });',
    );
    expect(collapseObserver).toContain('refreshHiddenChildViewportAnchor()');
  });

  it('cancels chip jumps on scrollbar mousedown as well as wheel and touch', () => {
    const takeover = sourceBetween(
      'const onWheel = (event: WheelEvent) => {',
      '}, [clearChipJumpSuppression, triggerUserIntentFill, unpinAutoFollowForUserUpIntent]);',
    );
    expect(takeover).toContain('clearChipJumpSuppression();');
    expect(takeover).toContain("root.addEventListener('mousedown', onMouseDown)");
  });

  it('uses message-level neighbors only when the deleted child\'s render item survives', () => {
    const compensation = sourceBetween(
      '// ── 删除靠前 message 后的视口保位（#2289）──',
      '// ── post-load auto-expand ──',
    );
    expect(compensation).toContain(
      'if (anchor.messageClientId && snapshotMessageGone && anchorItemStillVisible)',
    );
    expect(compensation).toContain('if (anchorItemStillVisible) return;');
    expect(compensation).toContain('collectDeleteAnchorClientIds(prevSeq)');
    expect(compensation).toContain('resolveDeleteCompensationLanding(');
    expect(compensation).toContain('queryVisibleAggregateContainer(root, survivorMessageId)');
    expect(compensation).toContain('toRenderItemViewportSnapshot(');
    expect(compensation).not.toContain(
      'if (anchor.messageClientId && snapshotMessageGone) {',
    );
  });

  it('finishes an older chip or rail navigation before starting a jump to bottom', () => {
    const jumpToBottom = sourceBetween(
      'const scrollToBottomSmooth = useCallback(() => {',
      '// F2: messages diff',
    );
    const settleIndex = jumpToBottom.indexOf(
      'finishChipJump(chipJumpGeneration, { consumeDeferredDelete: true });',
    );
    const beginIndex = jumpToBottom.indexOf('const generation = beginProgrammaticScroll();');
    expect(settleIndex).toBeGreaterThanOrEqual(0);
    expect(beginIndex).toBeGreaterThanOrEqual(0);
    expect(settleIndex).toBeLessThan(beginIndex);
    expect(jumpToBottom).toContain('const generation = beginProgrammaticScroll();');
    expect(jumpToBottom).toContain('finishProgrammaticScroll(generation)');
  });

  it('finishes a jump-to-bottom generation on user takeover and scrollend', () => {
    const takeover = sourceBetween(
      'const clearChipJumpSuppression = useCallback(() => {',
      'const settleChipJump = useCallback(',
    );
    expect(takeover).toContain(
      'deferredDeleteCompensationRef.current ||\n      chipJumpGenerationRef.current !== null ||\n      focusJumpRef.current ||\n      programmaticScrollRef.current',
    );
    expect(takeover).toContain('unpinAutoFollowForUserUpIntent()');
    expect(takeover).toContain('if (focusJumpRef.current)');
    expect(takeover).toContain('cancelFocusJump()');
    expect(takeover).toContain('if (programmaticScrollRef.current)');
    expect(takeover).toContain('finishProgrammaticScroll(programmaticScrollGenerationRef.current)');
    expect(takeover).toContain("root.scrollTo({ top: root.scrollTop, behavior: 'auto' })");
    const scrollEnd = sourceBetween(
      'const onScrollEnd = () => {\n      settleChipJump();',
      "root.addEventListener('scrollend', onScrollEnd);",
    );
    expect(scrollEnd).toContain('finishProgrammaticScroll(generation)');
  });

  it('records a child viewport snapshot after restore settles', () => {
    const restore = sourceBetween(
      'const applyRestore = useCallback(() => {',
      'const applyRestoreRef = useRef(applyRestore);',
    );
    expect(restore).toContain('refreshViewportAnchor()');
    expect(restore).toContain(
      'if (finishProgrammaticScroll(generation) === false) refreshViewportAnchor()',
    );
  });

  it('scrolls restored child anchors only when the exact message DOM exists', () => {
    const restore = sourceBetween(
      'const scrollMessageToViewportTop = useCallback',
      'const restoreViewportSnapshot = useCallback',
    );
    expect(restore).toContain('queryMessageElement(container, clientId)');
    expect(restore).not.toContain('queryFocusElement(');
  });

  it('defers recovered grouping-key restoration while programmatic navigation is in flight', () => {
    const compensation = sourceBetween(
      '// ── 删除靠前 message 后的视口保位（#2289）──',
      '// ── post-load auto-expand ──',
    );
    const recoveredStart = compensation.indexOf(
      'if (snapshot && recoveredKey && !snapshotMessageGone)',
    );
    const recoveredEnd = compensation.indexOf('if (!sessionId) return;');
    expect(recoveredStart).toBeGreaterThanOrEqual(0);
    expect(recoveredEnd).toBeGreaterThan(recoveredStart);
    const recovered = compensation.slice(recoveredStart, recoveredEnd);
    expect(recovered).toContain('restoreViewportSnapshot(rebased, 0)');
    expect(recovered).toContain(
      'if (!windowAnchorLost && !programmaticScrollRef.current && !isLoadingMore)',
    );
    const restoreIndex = recovered.indexOf('restoreViewportSnapshot(rebased, 0)');
    const guardIndex = recovered.indexOf(
      'if (!windowAnchorLost && !programmaticScrollRef.current && !isLoadingMore)',
    );
    expect(guardIndex).toBeGreaterThanOrEqual(0);
    expect(guardIndex).toBeLessThan(restoreIndex);
  });
});
