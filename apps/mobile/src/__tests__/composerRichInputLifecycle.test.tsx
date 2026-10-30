// @vitest-environment jsdom
import { act, createElement, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { runInNewContext } from 'node:vm';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { afterEach, expect, it, vi } from 'vitest';
import { Platform } from 'react-native';
import { ComposerRichInput, type ComposerRichInputHandle } from '@/session/ComposerRichInput';
import { composerDocumentProjectedText, textComposerDocument, type ComposerDocument } from '@/session/composerDocument';
import { createComposerDraftSource } from '@/session/composerDraftSource';

// Execute the page's real cancellation/persistence callbacks with the mounted
// editor below, without importing the unrelated native/network page UI.
const pageSource = ts.createSourceFile('session.tsx', readFileSync('app/sessions/[sessionId].tsx', 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const pageCallbacks = new Map<string, string>();
function collectPageCallbacks(node: ts.Node) {
  if (ts.isVariableDeclaration(node) && ['cancelQueueEdit', 'applyComposerDocument', 'applyRichComposerChange'].includes(node.name.getText(pageSource))
    && node.initializer && ts.isCallExpression(node.initializer)) {
    pageCallbacks.set(node.name.getText(pageSource), ts.transpileModule(`(${node.initializer.arguments[0].getText(pageSource)})`, {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText);
  }
  ts.forEachChild(node, collectPageCallbacks);
}
collectPageCallbacks(pageSource);
function pageCallback(name: string, bindings: Record<string, unknown>) {
  const compiled = pageCallbacks.get(name);
  if (!compiled) throw new Error(`Missing page callback: ${name}`);
  return runInNewContext(compiled, bindings);
}

const bridge = vi.hoisted(() => ({
  onMessage: (_event: { nativeEvent: { data: string } }) => {},
  onContentProcessDidTerminate: () => {},
  onRenderProcessGone: () => {},
  state: 'active',
  listeners: new Set<(state: string) => void>(),
  mounts: 0,
  clipboard: vi.fn<() => Promise<string>>(),
  inject: vi.fn(),
  requestFocus: vi.fn(),
}));
vi.mock('react-native', () => ({
  Platform: { OS: 'ios' }, StyleSheet: { create: (styles: unknown) => styles },
  AppState: {
    get currentState() { return bridge.state; },
    addEventListener: (_: string, listener: (state: string) => void) => {
      bridge.listeners.add(listener);
      return { remove: () => bridge.listeners.delete(listener) };
    },
  },
}));
vi.mock('react-native-webview', async () => {
  const { forwardRef, useImperativeHandle, useEffect } = await import('react');
  return { WebView: forwardRef((props: Pick<typeof bridge, 'onMessage' | 'onContentProcessDidTerminate' | 'onRenderProcessGone'>, ref) => {
    bridge.onMessage = props.onMessage;
    bridge.onContentProcessDidTerminate = props.onContentProcessDidTerminate;
    bridge.onRenderProcessGone = props.onRenderProcessGone;
    useEffect(() => { bridge.mounts += 1; }, []);
    useImperativeHandle(ref, () => ({ injectJavaScript: bridge.inject, requestFocus: bridge.requestFocus }));
    return null;
  }) };
});
vi.mock('react-native-reanimated', () => ({
  default: { View: ({ children }: { children: unknown }) => children },
  useAnimatedStyle: (factory: () => unknown) => factory(),
}));
vi.mock('expo-file-system', () => ({ File: class {}, Paths: { cache: '/unused' } }));
vi.mock('expo-clipboard', () => ({ getStringAsync: bridge.clipboard }));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined;
afterEach(() => {
  act(() => root?.unmount()); root = undefined; bridge.inject.mockReset();
  bridge.requestFocus.mockReset(); bridge.state = 'active'; bridge.mounts = 0; bridge.clipboard.mockReset(); vi.useRealTimers();
  Platform.OS = 'ios';
  expect(bridge.listeners.size).toBe(0);
});

function appState(state: string) {
  act(() => { bridge.state = state; bridge.listeners.forEach(listener => listener(state)); });
}

function mount(hidden = false) {
  const ref = createRef<ComposerRichInputHandle>();
  const onChangeDocument = vi.fn();
  const onPasteImagesLoadFailed = vi.fn();
  const page = {
    id: 0,
    document: textComposerDocument('initial'),
    applyDocument: vi.fn((document: ComposerDocument, _focus: boolean, _caret: unknown, id: number) => {
      page.document = document;
      page.id = id;
    }),
    setConfig: vi.fn(),
    focus: vi.fn(),
    snapshot: vi.fn((requestId: number) => bridge.onMessage({ nativeEvent: { data: JSON.stringify({
      type: 'snapshot', requestId, documentId: page.id, document: page.document, pendingPaste: false,
    }) } })),
    ping: vi.fn((id: number) => bridge.onMessage({ nativeEvent: { data: JSON.stringify({ type: 'pong', id }) } })),
  };
  bridge.inject.mockImplementation((script: string) => runInNewContext(script, { window: { cindyComposer: page } }));
  root = createRoot(document.createElement('div'));
  const renderDocument = (document: ComposerDocument) => act(() => root!.render(createElement(ComposerRichInput, {
    ref, document, hidden, onChangeDocument, onPasteImagesLoadFailed,
    accessibilityLabel: 'input', placeholder: '', height: 40, maxHeight: 264,
    theme: { background: '#fff', border: '#aaa', chip: '#ddd', focus: '#555', placeholder: '#777', text: '#111', textSecondary: '#333' },
  })));
  renderDocument(page.document);
  const send = (message: unknown) => act(() => bridge.onMessage({ nativeEvent: { data: JSON.stringify(message) } }));
  return { ref, page, send, onChangeDocument, onPasteImagesLoadFailed, renderDocument };
}

// #7508 / #7509, unit: the real WebView bridge must hand Send the visible document,
// including preedit, without echoing it back into the IME. Earlier tests only covered
// unsolicited change events; the minimal missing case is a DOM edit with no change yet.
it('reads the visible send snapshot and acknowledges it without replacing the editor', async () => {
  const { ref, page, send, onChangeDocument, renderDocument } = mount();
  send({ type: 'ready' });
  page.document = { version: 1, nodes: [
    { type: 'quote', quote: { text: 'retained reference' } },
    { type: 'text', text: '자동완성 껐는데 그래도 잘리네' },
  ] };
  page.applyDocument.mockClear();
  let snapshot!: ComposerDocument;
  await act(async () => { snapshot = await ref.current!.flushDocument!(); });
  expect(snapshot).toEqual(page.document);
  expect(onChangeDocument).toHaveBeenLastCalledWith(snapshot);
  renderDocument(snapshot);
  expect(page.applyDocument).not.toHaveBeenCalled();
});

it.each(['replacement', 'termination', 'unmount', 'timeout'] as const)(
  'rejects an unavailable send snapshot after %s and ignores a late reply', async reason => {
    vi.useFakeTimers();
    const { ref, page, send, renderDocument, onChangeDocument } = mount();
    send({ type: 'ready' });
    page.snapshot.mockImplementation(() => {});
    const oldId = page.id;
    const result = ref.current!.flushDocument!().then(() => 'accepted', () => 'rejected');
    const requestId = page.snapshot.mock.lastCall![0];
    if (reason === 'replacement') renderDocument(textComposerDocument('new draft'));
    else if (reason === 'termination') act(() => bridge.onRenderProcessGone());
    else if (reason === 'unmount') { act(() => root!.unmount()); root = undefined; }
    else act(() => vi.advanceTimersByTime(5000));
    expect(await result).toBe('rejected');
    send({ type: 'snapshot', requestId, documentId: oldId, document: textComposerDocument('stale'), pendingPaste: false });
    expect(onChangeDocument).not.toHaveBeenCalled();
  },
);

it('does not submit a partially replaced paste or an editor that has not loaded', async () => {
  const { ref, page, send, onChangeDocument } = mount();
  await expect(ref.current!.flushDocument!()).rejects.toThrow();
  send({ type: 'ready' });
  page.snapshot.mockImplementation(requestId => send({
    type: 'snapshot', requestId, documentId: page.id, document: textComposerDocument('partial'), pendingPaste: true,
  }));
  await expect(ref.current!.flushDocument!()).rejects.toThrow();
  expect(onChangeDocument).not.toHaveBeenCalled();
});

// #7508 review, unit: cancelling queue edit restores the draft synchronously,
// but its WebView props wait for the next frame. A solicited snapshot can arrive
// in that gap even without typing; replacement-after-render coverage misses it.
it('rejects an invalidated send scope before a late snapshot can overwrite the restored draft', async () => {
  vi.useFakeTimers();
  const { ref, page, send, onChangeDocument } = mount();
  send({ type: 'ready' });
  page.snapshot.mockImplementation(() => {});
  const editing = { clientId: 'queued-message' };
  let queueEdit: typeof editing | null = editing;
  const source = createComposerDraftSource(textComposerDocument('edited queued message'));
  const unsubscribe = source.subscribe(() => {});
  onChangeDocument.mockImplementation((document: ComposerDocument) => source.setDocument(document));
  const result = ref.current!.flushDocument!(() => queueEdit === editing).then(() => 'accepted', () => 'rejected');
  const requestId = page.snapshot.mock.lastCall![0];
  queueEdit = null;
  const restored = textComposerDocument('unsent personal draft');
  source.setDocument(restored);
  // Deliberately do not render the restored document or advance its frame yet.
  send({ type: 'snapshot', requestId, documentId: page.id,
    document: textComposerDocument('edited queued message'), pendingPaste: false });
  expect(await result).toBe('rejected');
  expect(onChangeDocument).not.toHaveBeenCalled();
  expect(source.getSnapshot().document).toEqual(restored);
  unsubscribe();
});

// #7536 review, unit: a queued IME change can arrive after cancelQueueEdit but
// before its scheduled React frame. Snapshot guards do not cover this unsolicited
// message; the restored personal draft must survive in memory and persistence.
it('cancels queue edit before a late change can overwrite the restored personal draft', () => {
  vi.useFakeTimers();
  Platform.OS = 'android';
  const { ref, page, send, onChangeDocument, renderDocument } = mount();
  send({ type: 'ready' });
  const edited = textComposerDocument('edited queued message');
  const stashed = textComposerDocument('unsent personal draft');
  renderDocument(edited);
  const oldId = page.id;
  const source = createComposerDraftSource(edited);
  const publish = vi.fn();
  const unsubscribe = source.subscribe(publish);
  const composerDocumentRef = { current: edited };
  const queueEditingRef = { current: { clientId: 'queue-1', stashedDocument: stashed, stashedAttachments: [] } };
  const saveComposerDocumentDraft = vi.fn();
  const saveComposerDraft = vi.fn();
  const applyComposerDocument = pageCallback('applyComposerDocument', {
    composerDocumentRef, draftRef: { current: '' }, pendingSkillSelectionRef: { current: null },
    composerDocumentProjectedText, composerDraftSource: source, sessionId: 'task',
    voiceDictionaryLearningTrackerRef: { current: null }, saveComposerDocumentDraft, saveComposerDraft,
  });
  onChangeDocument.mockImplementation(pageCallback('applyRichComposerChange', { applyComposerDocument, queueEditingRef }));
  const cancel = pageCallback('cancelQueueEdit', {
    queueEditingRef, composerInputRef: ref, composerDocumentProjectedText,
    setQueueEditing: vi.fn(), queueEditLockOwnerRef: { current: null },
    queueEditSaveOwnerRef: { current: null }, queueEditSaveInFlightRef: { current: null },
    discardQueueEditTransientAttachments: vi.fn(), applyComposerDocument,
    attachmentsRef: { current: [] }, setAttachments: vi.fn(),
  });
  try {
    act(() => cancel());
    // Do not render the restored props or advance the scheduled frame.
    send({ type: 'change', documentId: oldId, document: edited });
    expect(onChangeDocument).not.toHaveBeenCalled();
    expect(composerDocumentRef.current).toEqual(stashed);
    expect(source.getSnapshot().document).toEqual(stashed);
    expect(saveComposerDocumentDraft).toHaveBeenCalledExactlyOnceWith('task', stashed);
    expect(saveComposerDraft).toHaveBeenCalledExactlyOnceWith('task', 'unsent personal draft');
    expect(publish).not.toHaveBeenCalled();
    expect(bridge.requestFocus).not.toHaveBeenCalled();
    expect(page.applyDocument.mock.lastCall?.[1]).toBe(false);
    // The new document remains editable; rejecting stale messages must not
    // permanently suppress normal input after cancellation.
    const continued = textComposerDocument('unsent personal draft continued');
    send({ type: 'change', documentId: page.id, document: continued });
    expect(composerDocumentRef.current).toEqual(continued);
    expect(saveComposerDocumentDraft).toHaveBeenLastCalledWith('task', continued);
  } finally {
    unsubscribe();
  }
});

it('never writes an older native edit back over later typing, but applies external replacements', () => {
  const { page, send, onChangeDocument, renderDocument } = mount();
  send({ type: 'ready' });
  const id = page.id;
  send({ type: 'change', documentId: id, document: textComposerDocument('a') });
  const first = onChangeDocument.mock.lastCall![0];
  send({ type: 'change', documentId: id, document: textComposerDocument('abc') });
  const latest = onChangeDocument.mock.lastCall![0];
  page.applyDocument.mockClear();
  renderDocument(first);
  renderDocument(latest);
  expect(page.applyDocument).not.toHaveBeenCalled();
  expect(page.id).toBe(id);
  const empty = textComposerDocument('');
  renderDocument(empty);
  expect(page.document).toEqual(empty);
  // Explicitly restoring a previously acknowledged draft is still a command.
  renderDocument(first);
  expect(page.document).toEqual(first);
});

it('restores the latest accepted draft on every ready and accepts only the new document id', () => {
  const { ref, page, send, onChangeDocument } = mount();
  send({ type: 'ready' });
  const firstId = page.id;
  expect(firstId).toBeGreaterThan(0);
  const edited = textComposerDocument('typed before reload');
  // The parent has not rerendered its initial prop yet.
  send({ type: 'change', documentId: firstId, document: edited });
  page.id = 0;
  page.document = textComposerDocument('initial');
  send({ type: 'ready' });
  expect(page.document).toEqual(edited);
  expect(page.id).toBeGreaterThan(firstId);
  expect(page.applyDocument.mock.lastCall?.[1]).toBe(false);
  const restoredId = page.id;
  const afterReload = textComposerDocument('typed after reload');
  send({ type: 'change', documentId: restoredId, document: afterReload });
  send({ type: 'selection', documentId: restoredId, before: { textLength: 3, atomCount: 0 }, through: { textLength: 3, atomCount: 0 } });
  expect(onChangeDocument).toHaveBeenLastCalledWith(afterReload);
  expect(ref.current?.getSelection('typed after reload')).toEqual({ start: 3, end: 3, atomRange: { start: 0, end: 0 } });
  send({ type: 'change', documentId: firstId, document: edited });
  send({ type: 'selection', documentId: firstId, before: { textLength: 0, atomCount: 0 }, through: { textLength: 0, atomCount: 0 } });
  expect(onChangeDocument).toHaveBeenCalledTimes(2);
  expect(ref.current?.getSelection('typed after reload')).toEqual({ start: 3, end: 3, atomRange: { start: 0, end: 0 } });
});

it.each(['onContentProcessDidTerminate', 'onRenderProcessGone'] as const)('rebuilds on %s without replaying focus or accepting old callbacks', event => {
  const { page, send, onChangeDocument } = mount();
  send({ type: 'ready' });
  const draft: ComposerDocument = { version: 1, nodes: [{ type: 'quote', quote: { text: 'kept quote' } }] };
  send({ type: 'change', documentId: page.id, document: draft });
  const oldMessage = bridge.onMessage;
  const oldTermination = bridge[event];
  act(() => { oldTermination(); oldTermination(); });
  expect(bridge.mounts).toBe(2);
  act(() => oldMessage({ nativeEvent: { data: JSON.stringify({ type: 'ready' }) } }));
  page.document = textComposerDocument('stale initial');
  send({ type: 'ready' });
  expect(page.document).toEqual(draft);
  expect(page.focus).not.toHaveBeenCalled();
  expect(page.applyDocument.mock.lastCall?.[1]).toBe(false);
  act(() => oldMessage({ nativeEvent: { data: JSON.stringify({ type: 'change', documentId: page.id, document: textComposerDocument('late') }) } }));
  expect(onChangeDocument).toHaveBeenCalledTimes(1);
});

it('does not probe slow initial loading or discard pending focus', () => {
  vi.useFakeTimers();
  bridge.state = 'inactive';
  const { ref, page, send } = mount();
  act(() => ref.current?.focus());
  appState('active');
  act(() => vi.advanceTimersByTime(10000));
  expect(page.ping).not.toHaveBeenCalled();
  expect(bridge.mounts).toBe(1);
  send({ type: 'ready' });
  expect(page.focus).toHaveBeenCalledTimes(1);
  appState('background'); appState('active');
  expect(page.ping).toHaveBeenCalledTimes(1);
});

it('requests native WebView focus on Android when the editor receives focus', () => {
  const { ref, send } = mount();
  Platform.OS = 'android';
  send({ type: 'ready' });

  act(() => ref.current?.focus());
  expect(bridge.requestFocus).toHaveBeenCalledOnce();

  bridge.requestFocus.mockClear();
  act(() => ref.current?.applyDocumentAndSetSelectionToEnd(textComposerDocument('recommendation')));
  expect(bridge.requestFocus).toHaveBeenCalledOnce();
});

it('recovers a terminated initial load but does not probe the replacement before ready', () => {
  vi.useFakeTimers();
  const { page, send } = mount();
  act(() => bridge.onContentProcessDidTerminate());
  expect(bridge.mounts).toBe(2);
  appState('background'); appState('active');
  act(() => vi.advanceTimersByTime(10000));
  expect(page.ping).not.toHaveBeenCalled();
  expect(bridge.mounts).toBe(2);
  send({ type: 'ready' });
  appState('background'); appState('active');
  expect(page.ping).toHaveBeenCalledTimes(1);
});

it('leaves a healthy editor and its focus untouched on foreground', () => {
  vi.useFakeTimers();
  const { page, send } = mount();
  send({ type: 'ready' });
  page.applyDocument.mockClear();
  appState('background'); appState('active');
  act(() => vi.advanceTimersByTime(5000));
  expect(page.ping).toHaveBeenCalledTimes(1);
  expect(bridge.mounts).toBe(1);
  expect(page.applyDocument).not.toHaveBeenCalled();
  expect(page.focus).not.toHaveBeenCalled();
});

it('rebuilds an unresponsive editor once, and cancels probes in background or on unmount', () => {
  vi.useFakeTimers();
  const { page, send } = mount();
  send({ type: 'ready' }); page.ping.mockImplementation(() => {});
  appState('background'); appState('active');
  appState('background');
  act(() => vi.advanceTimersByTime(5000));
  expect(bridge.mounts).toBe(1);
  appState('active');
  act(() => vi.advanceTimersByTime(3000));
  expect(bridge.mounts).toBe(2);
  act(() => vi.advanceTimersByTime(60000));
  expect(bridge.mounts).toBe(2);
  appState('background'); appState('active');
  act(() => root?.unmount()); root = undefined;
  expect(vi.getTimerCount()).toBe(0);
});

it('defers background termination recovery and ignores callbacks from the terminated editor', () => {
  const { page, send, onChangeDocument } = mount(true);
  send({ type: 'ready' });
  appState('background');
  act(() => bridge.onContentProcessDidTerminate());
  expect(bridge.mounts).toBe(1);
  send({ type: 'change', documentId: page.id, document: textComposerDocument('late') });
  expect(onChangeDocument).not.toHaveBeenCalled();
  appState('active');
  expect(bridge.mounts).toBe(2);
  send({ type: 'ready' });
  expect(page.focus).not.toHaveBeenCalled();
});

it('bounds repeated crashes until the next foreground transition', () => {
  const { send } = mount();
  send({ type: 'ready' });
  act(() => bridge.onContentProcessDidTerminate());
  send({ type: 'ready' });
  act(() => bridge.onContentProcessDidTerminate());
  expect(bridge.mounts).toBe(2);
  appState('background'); appState('active');
  expect(bridge.mounts).toBe(3);
});

it('does not let an old pong or duplicate active event cancel the current probe', () => {
  vi.useFakeTimers();
  const { page, send } = mount();
  send({ type: 'ready' }); page.ping.mockImplementation(() => {});
  appState('background'); appState('active');
  const oldId = page.ping.mock.lastCall![0];
  appState('background'); appState('active'); appState('active');
  send({ type: 'pong', id: oldId });
  act(() => vi.advanceTimersByTime(3000));
  expect(bridge.mounts).toBe(2);
});

it('settles interrupted paste placeholders and drops late clipboard results', async () => {
  const { send, onPasteImagesLoadFailed } = mount();
  send({ type: 'ready' });
  let resolveClipboard!: (value: string) => void;
  bridge.clipboard.mockReturnValue(new Promise(resolve => { resolveClipboard = resolve; }));
  send({ type: 'paste-text-request', requestId: 'old' });
  send({ type: 'paste-images-start', requestId: 'images', count: 2 });
  act(() => bridge.onContentProcessDidTerminate());
  expect(onPasteImagesLoadFailed).toHaveBeenCalledTimes(1);
  send({ type: 'ready' }); bridge.inject.mockClear();
  await act(async () => resolveClipboard('late text'));
  expect(bridge.inject).not.toHaveBeenCalled();
});

it.each(['text', 'empty', 'failure'])('settles a native clipboard fallback with %s', async (result) => {
  const { send, page } = mount();
  const commit = vi.fn();
  Object.assign(page, { commitPaste: commit });
  send({ type: 'ready' });
  if (result === 'failure') bridge.clipboard.mockRejectedValueOnce(new Error('clipboard unavailable'));
  else bridge.clipboard.mockResolvedValueOnce(result === 'text' ? 'pasted text' : '');
  await act(async () => send({ type: 'paste-text-request', requestId: 'clipboard' }));
  expect(commit).toHaveBeenCalledExactlyOnceWith('clipboard', result === 'text' ? [{ type: 'text', text: 'pasted text' }] : []);
});

it('retains structural endpoints when only a zero-width quote is selected', () => {
  const { ref, page, send } = mount();
  send({ type: 'ready' });
  send({ type: 'change', documentId: page.id, document: {
    version: 1, nodes: [{ type: 'quote', quote: { text: 'selected quote' } }],
  } });
  send({ type: 'selection', documentId: page.id, before: { textLength: 0, atomCount: 0 }, through: { textLength: 0, atomCount: 1 } });
  expect(ref.current?.getSelection('')).toEqual({ start: 0, end: 0, atomRange: { start: 0, end: 1 } });
  send({ type: 'change', documentId: page.id, document: textComposerDocument('') });
  expect(ref.current?.getSelection('')).toEqual({ start: 0, end: 0 });
});

it('keeps pending caret intent on first ready but does not replay it on reload', () => {
  const { ref, page, send } = mount();
  act(() => ref.current?.applyDocumentAndFocusSelection(textComposerDocument('inserted suffix'), 8));
  send({ type: 'ready' });
  expect(page.applyDocument.mock.lastCall?.slice(1, 3)).toEqual([true, { nodeIndex: 0, offset: 8 }]);
  send({ type: 'ready' });
  expect(page.applyDocument.mock.lastCall?.slice(1, 3)).toEqual([false, null]);
});

it('applies the final dictation document without focusing and keeps the remembered caret', () => {
  const { ref, page, send } = mount();
  send({ type: 'ready' });
  act(() => ref.current?.rememberSelection('voice suffix', { start: 5, end: 5 }));
  act(() => ref.current?.applyDocumentAndSetSelection(textComposerDocument('voice suffix'), 5));
  expect(page.document).toEqual(textComposerDocument('voice suffix'));
  expect(page.applyDocument.mock.lastCall?.slice(1, 3)).toEqual([false, { nodeIndex: 0, offset: 5 }]);
  expect(page.focus).not.toHaveBeenCalled();
  expect(ref.current?.getSelection('voice suffix')).toEqual({ start: 5, end: 5 });
});

it('restores a hidden dictation draft without focusing or losing its saved insertion end', () => {
  const { ref, page, send } = mount(true);
  send({ type: 'ready' });
  send({ type: 'change', documentId: page.id, document: textComposerDocument('voice suffix') });
  act(() => ref.current?.rememberSelection('voice suffix', { start: 5, end: 5 }));
  send({ type: 'ready' });
  expect(page.document).toEqual(textComposerDocument('voice suffix'));
  expect(page.applyDocument.mock.lastCall?.[1]).toBe(false);
  expect(page.focus).not.toHaveBeenCalled();
  send({ type: 'selection', documentId: page.id, before: { textLength: 0, atomCount: 0 }, through: { textLength: 0, atomCount: 0 } });
  expect(ref.current?.getSelection('voice suffix')).toEqual({ start: 5, end: 5 });
});
