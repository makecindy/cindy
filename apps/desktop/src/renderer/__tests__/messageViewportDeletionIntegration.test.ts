/** @vitest-environment jsdom */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildRenderItems,
  collectDeleteAnchorClientIds,
  consumePendingReanchorForAutoFollow,
  findRestorableViewportItemIdx,
  groupWorkRuns,
  isVisibleDeleteCompensationElement,
  pickDeleteCompensationAnchorKey,
  resolveDeleteCompensationLanding,
  toRenderItemViewportSnapshot,
} from '../components/chat/MessageStream';
import {
  canCompensateMessageHeight,
  viewportAnchorCorrection,
} from '../components/chat/messageViewportCompensation';
import type { ChatMessage } from '../lib/makerChatStore';

// Exercise the actual scroll callbacks and both layout effects in source order.
// Extracting this small lifecycle avoids mocking the many unrelated providers in
// MessageStream. In particular, restoreViewportSnapshot is NOT a test double:
// its missing-child fallback used to erase the deletion effect's evidence.
const source = ts.createSourceFile(
  'MessageStream.tsx',
  readFileSync(resolve(__dirname, '../components/chat/MessageStream.tsx'), 'utf8'),
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);
const component = source.statements.find(
  (node): node is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(node) && node.name?.text === 'MessageStream',
);
if (!component?.body) throw new Error('MessageStream component not found');
const callbackNames = new Set([
  'scrollKeyToViewportTop',
  'scrollMessageToViewportTop',
  'restoreViewportSnapshot',
  'restoreViewportSnapshotOrRebuildWindow',
  'compensateMessageHeight',
]);
const helpers = source.statements.filter(
  (node) => ts.isFunctionDeclaration(node) && [
    'queryMessageElement',
    'queryVisibleAggregateContainer',
    'renderItemContainsClientId',
    'renderItemKeyForClientId',
  ].includes(node.name?.text ?? ''),
);
const lifecycle = component.body.statements.filter((node) => {
  if (ts.isVariableStatement(node)) {
    return node.declarationList.declarations.some(
      (declaration) => ts.isIdentifier(declaration.name) && callbackNames.has(declaration.name.text),
    );
  }
  if (!ts.isExpressionStatement(node) || !ts.isCallExpression(node.expression)) return false;
  if (node.expression.expression.getText(source) !== 'useLayoutEffect') return false;
  const callback = node.expression.arguments[0]?.getText(source) ?? '';
  return callback.includes('compensateMessageHeight();') || callback.includes('prevVisibleItemsRef.current');
});
const lifecycleCode = ts.transpileModule(
  [...helpers, ...lifecycle].map((node) => node.getText(source)).join('\n') +
    '\nreturn { compensateMessageHeight };',
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } },
).outputText;

type Snapshot = Parameters<typeof toRenderItemViewportSnapshot>[0];
const ref = <T>(current: T) => ({ current });
const messages: ChatMessage[] = [
  { clientId: 'u1', role: 'user', content: 'Start' },
  { clientId: 'a-intro', role: 'assistant', content: 'Starting.' },
  { clientId: 't1', role: 'tool_use', content: '', toolUseId: 'tu-t1', toolName: 'Read', toolInput: {} },
  { clientId: 'a-draft', role: 'assistant', content: 'Progress update.' },
  { clientId: 't2', role: 'tool_use', content: '', toolUseId: 'tu-t2', toolName: 'Bash', toolInput: {} },
  { clientId: 'a-final', role: 'assistant', content: 'done' },
];
const build = (input: ChatMessage[]) => groupWorkRuns(buildRenderItems(input).items, false);

function setup({ deleted = true, hidden = false, nativeShift = 0 } = {}) {
  const before = build(messages);
  const after = build(deleted ? messages.filter((message) => message.clientId !== 'a-draft') : messages);
  const beforeGroup = before.find((item) => item.type === 'work_group')!;
  const afterGroup = after.find((item) => item.type === 'work_group')!;
  expect(afterGroup.key).toBe(beforeGroup.key);
  expect(after).toHaveLength(before.length);

  vi.stubGlobal('CSS', { escape: (value: string) => value });
  const root = document.createElement('div');
  const items = root.appendChild(document.createElement('div'));
  document.body.appendChild(root);
  const containerTop = 40;
  const rect = (top: number, height: number) => ({ top, bottom: top + height, height }) as DOMRect;
  root.getBoundingClientRect = () => rect(containerTop, 500);
  root.scrollTop = 930 + nativeShift;
  const positions = new Map<string, number>();
  const elements = new Map<string, HTMLElement>();
  for (const item of after) {
    const row = items.appendChild(document.createElement('div'));
    const rowTop = item.key === afterGroup.key ? 200 : item.type === 'message' && item.message.role === 'user' ? 0 : 1800;
    row.getBoundingClientRect = () => rect(containerTop + rowTop - root.scrollTop, 1000);
    for (const id of collectDeleteAnchorClientIds([item])) {
      if (hidden && id === 'a-draft') continue;
      const child = row.appendChild(document.createElement('div'));
      child.dataset.messageClientId = id;
      positions.set(id, id === 't2' ? (deleted ? 800 : 1000) : id === 'a-draft' ? 800 : 200);
      child.getBoundingClientRect = () => rect(containerTop + positions.get(id)! - root.scrollTop, 200);
      elements.set(id, child);
    }
  }
  const snapshot: Snapshot = {
    viewportTopKey: beforeGroup.key,
    offset: 730,
    messageClientId: 'a-draft',
    messageOffset: 130,
  };
  const lastViewportTopRef = ref<Snapshot | null>(snapshot);
  const programmaticScrollRef = ref(false);
  const effects: Array<() => void> = [];
  const frames: FrameRequestCallback[] = [];
  const refreshViewportAnchor = vi.fn();
  const bindings = {
    useCallback: (callback: unknown) => callback,
    useLayoutEffect: (callback: () => void) => effects.push(callback),
    requestAnimationFrame: (callback: FrameRequestCallback) => frames.push(callback),
    beginProgrammaticScroll: () => { programmaticScrollRef.current = true; return 1; },
    finishProgrammaticScroll: () => { programmaticScrollRef.current = false; },
    canCompensateMessageHeight,
    viewportAnchorCorrection,
    toRenderItemViewportSnapshot,
    consumePendingReanchorForAutoFollow,
    findRestorableViewportItemIdx,
    collectDeleteAnchorClientIds,
    pickDeleteCompensationAnchorKey,
    resolveDeleteCompensationLanding,
    isVisibleDeleteCompensationElement,
    scrollRef: ref(root),
    itemsRef: ref(items),
    lastViewportTopRef,
    programmaticScrollRef,
    visibleRenderItemsRef: ref(after),
    allRenderItemsRef: ref(after),
    prevVisibleItemsRef: ref(before),
    prevAllItemsRef: ref(before),
    restoringRef: ref(false),
    isNearBottomRef: ref(false),
    prevScrollHeightRef: ref(0),
    saveRafRef: ref(null),
    scrollbarDragStartTopRef: ref(null),
    suppressHeightCompensationUntilRef: ref(0),
    pendingReanchorScrollRef: ref(null),
    deferredDeleteCompensationRef: ref(false),
    restoreSnapshotRef: ref(null),
    refreshViewportAnchor,
    setFirstVisibleItemKey: vi.fn(),
    visibleRenderItems: after,
    allRenderItems: after,
    firstVisibleItemKey: null,
    isLoadingMore: false,
    sessionId: 'disposable-scroll-test',
    deleteCompensationReplay: 0,
    bottomPadding: 0,
  };
  const callbacks = new Function(...Object.keys(bindings), lifecycleCode)(...Object.values(bindings)) as {
    compensateMessageHeight(): void;
  };
  expect(effects).toHaveLength(2);
  return {
    root, snapshot, lastViewportTopRef, elements, positions,
    compensate: callbacks.compensateMessageHeight,
    commit: () => effects.forEach((effect) => effect()),
    flushFrames: () => frames.splice(0).forEach((callback) => callback(0)),
  };
}

afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe('message height and deletion compensation lifecycle', () => {
  it.each([
    { nativeShift: 0, observerFirst: false },
    { nativeShift: -200, observerFirst: false },
    { nativeShift: 0, observerFirst: true },
    { nativeShift: -200, observerFirst: true },
  ])(
    'lands on the next tool after child deletion (native shift $nativeShift px, observer first $observerFirst)',
    ({ nativeShift, observerFirst }) => {
      const view = setup({ nativeShift });
      // Observer callbacks may also run before deletion handling. Neither may
      // degrade a deleted child to the surviving work group's old pixel offset.
      if (observerFirst) {
        view.compensate();
        view.compensate();
        expect(view.lastViewportTopRef.current).toEqual(view.snapshot);
        expect(view.root.scrollTop).toBe(930 + nativeShift);
      }
      view.commit();
      expect(view.lastViewportTopRef.current?.messageClientId).toBe('t2');
      expect(view.elements.get('t2')!.getBoundingClientRect().top).toBe(40);
      view.flushFrames();
      view.compensate();
      expect(view.elements.get('t2')!.getBoundingClientRect().top).toBe(40);
    },
  );

  it('still falls back to the group when a child is hidden but remains in the data', () => {
    const view = setup({ deleted: false, hidden: true });
    view.commit();
    expect(view.lastViewportTopRef.current).toEqual({
      viewportTopKey: view.snapshot.viewportTopKey,
      offset: 730,
    });
    expect(view.root.scrollTop).toBe(930);
  });

  it('still preserves an existing exact child after content above it grows', () => {
    const view = setup({ deleted: false });
    view.positions.set('a-draft', 977);
    view.commit();
    expect(view.lastViewportTopRef.current).toEqual(view.snapshot);
    expect(view.elements.get('a-draft')!.getBoundingClientRect().top).toBe(40 - 130);
    expect(view.root.scrollTop).toBe(930 + 177);
  });
});
