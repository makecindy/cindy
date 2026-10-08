import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import {
  resolveNearBottomOnScroll, resolveEffectiveNearBottom,
  shouldBumpSendFollowCancelOnScroll, shouldUnpinOnScrollbarDrag, shouldUnpinOnUpIntent,
} from '../components/chat/autoFollowIntent';

// Execute the actual scroll coordinator, including the order of follow-state
// updates and window changes. Geometry-only scrolls occur when Ctrl+F / Ctrl+A
// replace estimated placeholders with full text at an already-followed tail.
const source = ts.createSourceFile('MessageStream.tsx', readFileSync(
  resolve(__dirname, '../components/chat/MessageStream.tsx'), 'utf8',
), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const component = source.statements.find((node): node is ts.FunctionDeclaration =>
  ts.isFunctionDeclaration(node) && node.name?.text === 'MessageStream')!;
const statement = component.body!.statements.find(node => ts.isVariableStatement(node)
  && node.declarationList.declarations.some(d => d.name.getText(source) === 'handleScroll')) as ts.VariableStatement;
const initializer = statement.declarationList.declarations[0].initializer as ts.CallExpression;
const code = ts.transpileModule(`return (${initializer.arguments[0].getText(source)});`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;

function fixture(following: boolean, delta: number, distance = 0, coversEnd = true) {
  const setFirstVisibleItemKey = vi.fn();
  const setAnchoredForwardItems = vi.fn();
  const setUnreadCount = vi.fn();
  const onLoadMore = vi.fn();
  const expandWindow = vi.fn();
  const isNearBottomRef = { current: following };
  const bindings = {
    scrollRef: { current: { scrollTop: 10_000, scrollHeight: 10_600 + distance, clientHeight: 600 } },
    prevScrollTopRef: { current: 10_000 - delta },
    isNearBottomRef, setIsNearBottom: vi.fn(), setUnreadCount,
    restoringRef: { current: false }, scrollbarDragStartTopRef: { current: null },
    programmaticScrollRef: { current: false }, isLoadingMore: false,
    prevScrollHeightRef: { current: 0 }, saveRafRef: { current: 1 },
    firstVisibleItemKey: 'msg-qa5406-340', windowCoversEnd: coversEnd,
    setFirstVisibleItemKey, anchoredForwardItems: 160, setAnchoredForwardItems,
    jumpDownIdleTimerRef: { current: null }, setShowJumpDown: vi.fn(),
    window: { setTimeout: vi.fn(), clearTimeout: vi.fn() }, JUMP_DOWN_IDLE_MS: 1500,
    SCROLL_DIRECTION_DEAD_ZONE_PX: 1, RENDER_WINDOW_GROWTH_ITEMS: 80,
    TOP_HISTORY_TRIGGER_PX: 50, onLoadMore, expandWindow,
    resolveNearBottomOnScroll, resolveEffectiveNearBottom,
    shouldBumpSendFollowCancelOnScroll, shouldUnpinOnScrollbarDrag, shouldUnpinOnUpIntent,
    bumpSendFollowCancelGeneration: vi.fn(), sessionId: 'restored-tail',
  };
  const scroll = new Function(...Object.keys(bindings), code)(...Object.values(bindings)) as () => void;
  return { scroll, isNearBottomRef, setFirstVisibleItemKey, setAnchoredForwardItems, setUnreadCount, onLoadMore, expandWindow };
}

describe('tail window during layout scrolls', () => {
  it.each([-1605, 0, 1605])('preserves the searchable window when text mounting changes scrollTop by %d', delta => {
    const state = fixture(true, delta);
    state.scroll();
    expect(state.isNearBottomRef.current).toBe(true);
    expect(state.setFirstVisibleItemKey).not.toHaveBeenCalled();
    expect(state.setAnchoredForwardItems).not.toHaveBeenCalled();
    expect(state.onLoadMore).not.toHaveBeenCalled();
    expect(state.expandWindow).not.toHaveBeenCalled();
  });
  it('still returns to the default tail when the reader scrolls down to resume following', () => {
    const state = fixture(false, 1605);
    state.scroll();
    expect(state.isNearBottomRef.current).toBe(true);
    expect(state.setFirstVisibleItemKey).toHaveBeenCalledExactlyOnceWith(null);
    expect(state.setUnreadCount).toHaveBeenCalledExactlyOnceWith(0);
  });
  it('does not shrink history when scrolling up close to the tail', () => {
    const state = fixture(false, -40, 40);
    state.scroll();
    expect(state.isNearBottomRef.current).toBe(false);
    expect(state.setFirstVisibleItemKey).not.toHaveBeenCalled();
  });
  it('still expands an intermediate history window by the existing 80 items', () => {
    const state = fixture(false, 100, 20, false);
    state.scroll();
    expect(state.isNearBottomRef.current).toBe(false);
    expect(state.setFirstVisibleItemKey).not.toHaveBeenCalled();
    expect(state.setAnchoredForwardItems).toHaveBeenCalledExactlyOnceWith(240);
    expect(state.onLoadMore).not.toHaveBeenCalled();
  });
});
