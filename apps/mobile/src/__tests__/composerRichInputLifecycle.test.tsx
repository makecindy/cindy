// @vitest-environment jsdom
import { act, createElement, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { runInNewContext } from 'node:vm';
import { afterEach, expect, it, vi } from 'vitest';
import { ComposerRichInput, type ComposerRichInputHandle } from '@/session/ComposerRichInput';
import { textComposerDocument, type ComposerDocument } from '@/session/composerDocument';

const bridge = vi.hoisted(() => ({
  onMessage: (_event: { nativeEvent: { data: string } }) => {},
  inject: vi.fn(),
}));
vi.mock('react-native', () => ({ Platform: { OS: 'ios' }, StyleSheet: { create: (styles: unknown) => styles } }));
vi.mock('react-native-webview', async () => {
  const { forwardRef, useImperativeHandle } = await import('react');
  return { WebView: forwardRef((props: { onMessage: typeof bridge.onMessage }, ref) => {
    bridge.onMessage = props.onMessage;
    useImperativeHandle(ref, () => ({ injectJavaScript: bridge.inject }));
    return null;
  }) };
});
vi.mock('react-native-reanimated', () => ({
  default: { View: ({ children }: { children: unknown }) => children },
  useAnimatedStyle: (factory: () => unknown) => factory(),
}));
vi.mock('expo-file-system', () => ({ File: class {}, Paths: { cache: '/unused' } }));
vi.mock('expo-clipboard', () => ({}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined;
afterEach(() => { act(() => root?.unmount()); root = undefined; bridge.inject.mockReset(); });

function mount(hidden = false) {
  const ref = createRef<ComposerRichInputHandle>();
  const onChangeDocument = vi.fn();
  const page = {
    id: 0,
    document: textComposerDocument('initial'),
    applyDocument: vi.fn((document: ComposerDocument, _focus: boolean, _caret: unknown, id: number) => {
      page.document = document;
      page.id = id;
    }),
    setConfig: vi.fn(),
    focus: vi.fn(),
  };
  bridge.inject.mockImplementation((script: string) => runInNewContext(script, { window: { cindyComposer: page } }));
  root = createRoot(document.createElement('div'));
  act(() => root!.render(createElement(ComposerRichInput, {
    ref, document: page.document, hidden, onChangeDocument,
    accessibilityLabel: 'input', placeholder: '', height: 40, maxHeight: 264,
    theme: { background: '#fff', border: '#aaa', chip: '#ddd', focus: '#555', placeholder: '#777', text: '#111', textSecondary: '#333' },
  })));
  const send = (message: unknown) => act(() => bridge.onMessage({ nativeEvent: { data: JSON.stringify(message) } }));
  return { ref, page, send, onChangeDocument };
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
