/** @vitest-environment jsdom */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { rememberedItemIntrinsicSize } from '../components/chat/messageViewportCompensation';

// Run the production capture callback and restore layout effect, including their
// DOM/index matching. A missing card must never borrow its neighbour's height.
const source = ts.createSourceFile('MessageStream.tsx', readFileSync(
  resolve(__dirname, '../components/chat/MessageStream.tsx'), 'utf8',
), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const component = source.statements.find((node): node is ts.FunctionDeclaration =>
  ts.isFunctionDeclaration(node) && node.name?.text === 'MessageStream');
if (!component?.body) throw new Error('MessageStream not found');
const statements = component.body.statements.filter((node) => {
  if (ts.isVariableStatement(node)) return node.declarationList.declarations.some(
    (declaration) => declaration.name.getText(source) === 'saveScrollSnapshot');
  return ts.isExpressionStatement(node) && ts.isCallExpression(node.expression) &&
    node.expression.expression.getText(source) === 'useLayoutEffect' &&
    node.expression.arguments[0]?.getText(source).includes('const sizes = restoreSnapshotRef.current?.itemHeights');
});
if (statements.length !== 2) throw new Error('Height cache lifecycle not found');
const code = ts.transpileModule(statements.map((node) => node.getText(source)).join('\n') +
  '\nreturn saveScrollSnapshot;', {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;

function setup(keys: string[], mountedKeys: string[], cached = { before: 100, card: 300, after: 600 }) {
  const items = document.createElement('div');
  document.body.appendChild(items);
  items.getBoundingClientRect = () => ({ width: 720 }) as DOMRect;
  const elements = new Map<string, HTMLElement>();
  for (const [index, key] of mountedKeys.entries()) {
    const row = items.appendChild(document.createElement('div'));
    row.style.cssText = 'padding-top: 7px; padding-bottom: 9px; border-top: 1px solid; border-bottom: 3px solid';
    row.style.containIntrinsicBlockSize = 'auto 999px';
    row.getBoundingClientRect = () => ({ height: 120 + index * 200 }) as DOMRect;
    elements.set(key, row);
  }
  const save = vi.fn();
  let restore!: () => void;
  const bindings = {
    useCallback: (callback: unknown) => callback,
    useLayoutEffect: (callback: () => void) => { restore = callback; },
    itemsRef: { current: items },
    restoringRef: { current: true },
    restoreSnapshotRef: { current: { itemHeights: { width: 720, byKey: cached } } },
    visibleRenderItems: keys.map((key) => ({ key })),
    visibleRenderItemsRef: { current: keys.map((key) => ({ key })) },
    rememberedItemIntrinsicSize,
    refreshViewportAnchor: () => ({ viewportTopKey: 'after', offset: 12 }),
    saveSessionScroll: save,
    sessionId: 'height-cache-fixture',
    firstVisibleItemKeyRef: { current: null },
    isNearBottomRef: { current: false },
    anchoredForwardItemsRef: { current: 80 },
    RENDER_WINDOW_INITIAL_ITEMS: 80,
    getComputedStyle: window.getComputedStyle.bind(window),
  };
  const capture = new Function(...Object.keys(bindings), code)(...Object.values(bindings)) as
    (includeHeights?: boolean) => void;
  return { capture, restore, save, elements, items, restoringRef: bindings.restoringRef };
}

afterEach(() => document.body.replaceChildren());

describe('message item height cache DOM alignment', () => {
  it('stops reading layout and rewriting estimates once the user takes over scrolling', () => {
    const view = setup(['before', 'card', 'after'], ['before', 'card', 'after']);
    view.restore();
    expect(view.elements.get('after')!.style.containIntrinsicBlockSize).toBe('auto 600px');
    view.restoringRef.current = false;
    // A newer measurement must survive subsequent streaming render effects.
    view.elements.get('after')!.style.containIntrinsicBlockSize = 'auto 800px';
    const measure = vi.spyOn(view.items, 'getBoundingClientRect');
    for (let batch = 0; batch < 3; batch++) view.restore();
    expect(measure).not.toHaveBeenCalled();
    expect(view.elements.get('after')!.style.containIntrinsicBlockSize).toBe('auto 800px');
  });

  it.each(['before', 'card'])('does not cache shifted heights when %s renders no DOM', (missing) => {
    const view = setup(['before', 'card', 'after'], ['before', 'card', 'after'].filter((key) => key !== missing));
    view.capture(true);
    expect(view.save).toHaveBeenCalledOnce();
    expect(view.save.mock.calls[0][1]).toMatchObject({ viewportTopKey: 'after', offset: 12 });
    expect(view.save.mock.calls[0][1].itemHeights).toBeUndefined();
  });

  it('clears estimates instead of applying the absent card height to the next row', () => {
    const view = setup(['before', 'card', 'after'], ['before', 'after']);
    view.restore();
    for (const row of view.elements.values()) expect(row.style.containIntrinsicBlockSize).toBe('');
  });

  it('captures content-box heights and restores matching rows', () => {
    const view = setup(['before', 'card', 'after'], ['before', 'card', 'after']);
    view.capture(true);
    const cached = view.save.mock.calls[0][1].itemHeights;
    expect(cached).toEqual({ width: 720, byKey: { before: 100, card: 300, after: 500 } });
    const remounted = setup(['before', 'card', 'after'], ['before', 'card', 'after'], cached.byKey);
    remounted.restore();
    expect(remounted.elements.get('after')!.style.containIntrinsicBlockSize).toBe('auto 500px');
  });

  it('bounds aligned capture to the last 80 mounted rows', () => {
    const keys = Array.from({ length: 85 }, (_, index) => `row-${index}`);
    const view = setup(keys, keys);
    view.capture(true);
    expect(Object.keys(view.save.mock.calls[0][1].itemHeights.byKey)).toEqual(keys.slice(-80));
  });
});
