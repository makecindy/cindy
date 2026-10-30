// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { createElement, useLayoutEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { describe, expect, it } from 'vitest';
import { findRestorableViewportItemIdx, pickIntersectingChildAnchor, readViewportChildAnchorClientId, viewportRestoreNeedsMoreContent } from '../components/chat/MessageStream';
import { findRenderItemElement, viewportAnchorCorrection } from '../components/chat/messageViewportCompensation';

// Run the actual capture and positioning callbacks with a deterministic layout.
// jsdom cannot lay out, so rectangles model a message moving into a work group.
const source = ts.createSourceFile('MessageStream.tsx', readFileSync(
  resolve(__dirname, '../components/chat/MessageStream.tsx'), 'utf8',
), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const component = source.statements.find((node): node is ts.FunctionDeclaration =>
  ts.isFunctionDeclaration(node) && node.name?.text === 'MessageStream')!;
const names = ['measureViewportTop', 'scrollMessageToViewportTop'];
const statements = component.body!.statements.filter(node => ts.isVariableStatement(node) &&
  node.declarationList.declarations.some(d => names.includes(d.name.getText(source))));
if (statements.length !== names.length) throw new Error('Viewport callbacks not found');
const query = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'queryMessageElement')!;
const code = ts.transpileModule([query, ...statements].map(node => node.getText(source)).join('\n') +
  '\nreturn {capture:measureViewportTop,restore:scrollMessageToViewportTop};', {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;

function setup() {
  const container = document.createElement('div');
  const items = container.appendChild(document.createElement('div'));
  container.scrollTop = 100;
  container.getBoundingClientRect = () => ({ top: 40 }) as DOMRect;
  const row = items.appendChild(document.createElement('div'));
  row.dataset.renderItemKey = 'msg-target';
  row.dataset.messageClientId = 'target';
  const measure = (element: HTMLElement, y: number, height = 300) => {
    element.getBoundingClientRect = () => ({ top: y - container.scrollTop,
      bottom: y - container.scrollTop + height, height }) as DOMRect;
  };
  measure(row, 120);
  const bindings = {
    useCallback: (callback: unknown) => callback,
    scrollRef: { current: container }, itemsRef: { current: items },
    pickIntersectingChildAnchor, readViewportChildAnchorClientId, viewportAnchorCorrection,
    CSS: { escape: (id: string) => id }, isLoadingMore: false,
    prevScrollHeightRef: { current: 0 }, prevScrollTopAtLoadRef: { current: 0 },
    beginProgrammaticScroll: () => 1, finishProgrammaticScroll: () => false,
    requestAnimationFrame: (callback: () => void) => { callback(); return 1; },
  };
  const callbacks = new Function(...Object.keys(bindings), code)(...Object.values(bindings));
  return { container, row, measure, ...callbacks };
}

describe('message viewport capture and restore across remount', () => {
  it('captures an exact message on the render-item root and restores after a 40px group prefix', () => {
    const view = setup();
    const saved = view.capture();
    expect(saved).toEqual({ viewportTopKey: 'msg-target', offset: 20,
      messageClientId: 'target', messageOffset: 20 });
    delete view.row.dataset.messageClientId;
    view.row.dataset.renderItemKey = 'work-target';
    const message = view.row.appendChild(document.createElement('div'));
    message.dataset.messageClientId = 'target';
    view.measure(message, 160, 260);
    expect(view.restore(saved.messageClientId, saved.messageOffset)).toBe(true);
    expect(message.getBoundingClientRect().top).toBe(20);
    expect(view.container.scrollTop).toBe(140);
  });

  it('still prefers the innermost visible exact message and excludes hidden children', () => {
    const view = setup();
    const child = view.row.appendChild(document.createElement('div'));
    child.dataset.messageClientId = 'inner';
    view.measure(child, 130, 100);
    const hidden = child.appendChild(document.createElement('div'));
    hidden.dataset.messageClientId = 'hidden';
    view.measure(hidden, 135, 0);
    expect(view.capture()).toMatchObject({ messageClientId: 'inner', messageOffset: 10 });
    child.remove();
    expect(view.capture()).toMatchObject({ messageClientId: 'target', messageOffset: 20 });
  });

  it('preserves the signed gap when the first message starts below the viewport', () => {
    const view = setup();
    view.measure(view.row, 152);
    const saved = view.capture();
    expect(saved).toMatchObject({ messageClientId: 'target', messageOffset: -12 });
    view.measure(view.row, 192);
    expect(view.restore(saved.messageClientId, saved.messageOffset)).toBe(true);
    expect(view.row.getBoundingClientRect().top).toBe(52);
  });
});

it('finishes a required forward-window expansion in the layout commit before paint', () => {
  const restoration = component.body!.statements.find(node => ts.isExpressionStatement(node) &&
    node.getText(source).includes('const restoredKey = resolveSavedViewportKey'))!;
  const effect = ts.transpileModule(restoration.getText(source), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const allRenderItems = Array.from({ length: 30 }, (_, i) => ({ key: `row-${i}` }));
  const restoreLoadRef = { current: 'idle' };
  const restoringRef = { current: true };
  const restoreSnapshotRef = { current: { viewportTopKey: 'row-0' } };
  const commits: number[] = [];
  function Fixture() {
    const [count, setCount] = useState(15);
    useLayoutEffect(() => { commits.push(count); });
    const bindings = {
      useLayoutEffect, restoringRef, restoreLoadRef, restoreSnapshotRef,
      historyLoaded: true, firstMountDeferred: false, historyCleared: false,
      restoreCancelledRef: { current: false }, sessionId: 'reading', restoreRevision: 0,
      allRenderItems, visibleRenderItems: allRenderItems.slice(0, count),
      restoreClientIdFromKey: () => 'source', resolveSavedViewportKey: () => 'row-0',
      setFirstVisibleItemKey: () => { throw new Error('Anchor was already mounted'); },
      setAnchoredForwardItems: setCount,
      applyRestoreRef: { current: () => {
        if (count < 30) { setCount(count + 40); return false; }
        return true;
      } },
    };
    new Function(...Object.keys(bindings), effect)(...Object.values(bindings));
    return null;
  }
  const root = createRoot(document.createElement('div'));
  try {
    flushSync(() => root.render(createElement(Fixture)));
    expect(commits).toEqual([15, 55]);
    expect(restoreLoadRef.current).toBe('settled');
  } finally {
    flushSync(() => root.unmount());
  }
});

it('bounds synchronous expansion rounds through thousands of non-rendering rows', () => {
  const statement = component.body!.statements.find(node => ts.isVariableStatement(node) &&
    node.declarationList.declarations.some(d => d.name.getText(source) === 'applyRestore'))!;
  const effect = ts.transpileModule(statement.getText(source) + '\nreturn applyRestore;', {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const container = { scrollTop: 0, scrollHeight: 800, clientHeight: 800,
    getBoundingClientRect: () => ({ top: 0 }) };
  const row = { getAttribute: () => 'anchor', getBoundingClientRect: () => ({ top: 100, height: 100 }) };
  const count = { current: 15 };
  const coversEnd = { current: false };
  const bindings = {
    useCallback: (callback: unknown) => callback,
    restoreSnapshotRef: { current: { viewportTopKey: 'anchor', offset: 0 } },
    scrollRef: { current: container }, itemsRef: { current: { children: [row] } },
    visibleRenderItemsRef: { current: [{ key: 'anchor' }] },
    findRestorableViewportItemIdx, findRenderItemElement, viewportAnchorCorrection,
    viewportRestoreNeedsMoreContent, windowCoversEndRef: coversEnd,
    restoreLoadRef: { current: 'idle' }, anchoredForwardItemsRef: count,
    RENDER_WINDOW_GROWTH_ITEMS: 80,
    setAnchoredForwardItems: (update: (previous: number) => number) => { count.current = update(count.current); },
    beginProgrammaticScroll: () => 1, finishProgrammaticScroll: () => false,
    refreshViewportAnchor: () => null, scrollMessageToViewportTop: () => false,
    requestAnimationFrame: (callback: () => void) => { callback(); return 1; },
  };
  const restore = new Function(...Object.keys(bindings), effect)(...Object.values(bindings));
  let rounds = 0;
  while (count.current < 5000 && rounds < 50) { expect(restore()).toBe(false); rounds++; }
  expect(rounds).toBeLessThan(10);
  coversEnd.current = true;
  expect(restore()).toBe(true);
});
