// @vitest-environment jsdom
import { act, createElement, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { runInNewContext } from 'node:vm';
import { afterEach, expect, it, vi } from 'vitest';
import { ComposerRichInput, type ComposerRichInputHandle } from '@/session/ComposerRichInput';
import { textComposerDocument, type ComposerDocument } from '@/session/composerDocument';

const bridge = vi.hoisted(() => ({
  onMessage: (_event: { nativeEvent: { data: string } }) => {},
  onContentProcessDidTerminate: () => {},
  onRenderProcessGone: () => {},
  state: 'active',
  listeners: new Set<(state: string) => void>(),
  mounts: 0,
  clipboard: vi.fn<() => Promise<string>>(),
  inject: vi.fn(),
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
    useImperativeHandle(ref, () => ({ injectJavaScript: bridge.inject }));
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
  bridge.state = 'active'; bridge.mounts = 0; bridge.clipboard.mockReset(); vi.useRealTimers();
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
    ping: vi.fn((id: number) => bridge.onMessage({ nativeEvent: { data: JSON.stringify({ type: 'pong', id }) } })),
  };
  bridge.inject.mockImplementation((script: string) => runInNewContext(script, { window: { cindyComposer: page } }));
  root = createRoot(document.createElement('div'));
  act(() => root!.render(createElement(ComposerRichInput, {
    ref, document: page.document, hidden, onChangeDocument, onPasteImagesLoadFailed,
    accessibilityLabel: 'input', placeholder: '', height: 40, maxHeight: 264,
    theme: { background: '#fff', border: '#aaa', chip: '#ddd', focus: '#555', placeholder: '#777', text: '#111', textSecondary: '#333' },
  })));
  const send = (message: unknown) => act(() => bridge.onMessage({ nativeEvent: { data: JSON.stringify(message) } }));
  return { ref, page, send, onChangeDocument, onPasteImagesLoadFailed };
}

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
