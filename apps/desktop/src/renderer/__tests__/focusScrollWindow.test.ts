import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { expect, it, vi } from 'vitest';
import { resolveWindowCoverageLossAction, REPIN_AT_BOTTOM_PX } from '../components/chat/autoFollowIntent';

const source = ts.createSourceFile('MessageStream.tsx', readFileSync(
  resolve(__dirname, '../components/chat/MessageStream.tsx'), 'utf8',
), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const component = source.statements.find((node): node is ts.FunctionDeclaration =>
  ts.isFunctionDeclaration(node) && node.name?.text === 'MessageStream')!;
const declaration = component.body!.statements.flatMap(node => ts.isVariableStatement(node)
  ? [...node.declarationList.declarations] : []).find(node => node.name.getText(source) === 'handleScroll')!;
const callback = (declaration.initializer as ts.CallExpression).arguments[0];
const code = ts.transpileModule(`return (${callback.getText(source)});`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;

function fixture(windowAtTop: boolean) {
  const bindings = {
    scrollRef: { current: { scrollTop: 0, scrollHeight: 10000, clientHeight: 600 } },
    scrollbarDragStartTopRef: { current: null }, restoringRef: { current: false },
    prevScrollTopRef: { current: 0 }, programmaticScrollRef: { current: true },
    focusJumpRef: { current: {} as object | null }, chipJumpGenerationRef: { current: null },
    chipJumpInProgressRef: { current: false }, SCROLL_DIRECTION_DEAD_ZONE_PX: 2,
    TOP_HISTORY_TRIGGER_PX: 50, windowAtTop, prevScrollHeightRef: { current: 0 },
    prevScrollTopAtLoadRef: { current: 0 }, expandWindow: vi.fn(),
    isLoadingMore: false, onLoadMore: vi.fn(), hasMoreMessages: true,
  };
  const scroll = new Function(...Object.keys(bindings), code)(...Object.values(bindings)) as () => void;
  return { ...bindings, scroll };
}

it.each([false, true])('does not load older history when a search lands on the top edge (atTop=%s)', windowAtTop => {
  const f = fixture(windowAtTop);
  f.scroll();
  expect(f.expandWindow).not.toHaveBeenCalled();
  expect(f.onLoadMore).not.toHaveBeenCalled();
  expect(f.prevScrollHeightRef.current).toBe(0);
  // Once focus navigation releases ownership, the existing history path resumes.
  f.focusJumpRef.current = null;
  f.scroll();
  expect(windowAtTop ? f.onLoadMore : f.expandWindow).toHaveBeenCalledOnce();
});

it.each([false, true])('only repins a window extended to the tail outside programmatic navigation (navigating=%s)', navigating => {
  const effect = component.body!.statements.find(node => ts.isExpressionStatement(node) &&
    ts.isCallExpression(node.expression) && node.expression.expression.getText(source) === 'useLayoutEffect' &&
    node.getText(source).includes('const wasCovering = prevWindowCoversEndRef.current;')) as ts.ExpressionStatement;
  const callback = (effect.expression as ts.CallExpression).arguments[0];
  const code = ts.transpileModule(`return (${callback.getText(source)});`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const bindings = {
    prevWindowCoversEndRef: { current: false }, windowCoversEnd: true,
    firstVisibleItemKey: 'search-window', isNearBottomRef: { current: false },
    programmaticScrollRef: { current: navigating }, restoringRef: { current: false },
    scrollRef: { current: { scrollHeight: 600, scrollTop: 0, clientHeight: 600 } },
    setIsNearBottom: vi.fn(), setUnreadCount: vi.fn(), setFirstVisibleItemKey: vi.fn(),
    resolveWindowCoverageLossAction, REPIN_AT_BOTTOM_PX,
  };
  new Function(...Object.keys(bindings), code)(...Object.values(bindings))();
  expect(bindings.isNearBottomRef.current).toBe(!navigating);
  expect(bindings.setFirstVisibleItemKey).toHaveBeenCalledTimes(navigating ? 0 : 1);
});
