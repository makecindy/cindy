// @vitest-environment jsdom
import { act, createElement, createRef, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { ComposerNativeInput } from '@/session/ComposerNativeInput.ios';
import type { ComposerRichInputHandle, ComposerRichInputProps } from '@/session/ComposerRichInput';
import type { ComposerDocument } from '@/session/composerDocument';

const bridge = vi.hoisted(() => ({ props: {} as any, setDocument: vi.fn(), writeImage: vi.fn(), deleteImage: vi.fn() }));
vi.mock('expo', async () => {
  const { forwardRef, useImperativeHandle } = await import('react');
  return {
    requireOptionalNativeModule: () => ({}),
    requireNativeView: () => forwardRef((props, ref) => {
      bridge.props = props;
      useImperativeHandle(ref, () => ({ setDocument: bridge.setDocument }));
      return null;
    }),
  };
});
vi.mock('react-native-reanimated', () => ({
  default: { View: ({ children }: { children: ReactNode }) => createElement('div', null, children) },
  useAnimatedStyle: () => ({}),
}));
vi.mock('@/theme', () => ({ useTheme: () => ({ mode: 'light' }) }));
vi.mock('expo-file-system', () => ({ File: class { uri = 'file:///cache/native-paste.png'; }, Paths: {} }));
vi.mock('expo-file-system/legacy', () => ({ EncodingType: { Base64: 'base64' }, writeAsStringAsync: bridge.writeImage, deleteAsync: bridge.deleteImage }));

const cleanups: Array<() => void> = [];
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
afterEach(() => { cleanups.splice(0).forEach((cleanup) => cleanup()); vi.clearAllMocks(); });
function mount(text: string, initialProps: Partial<ComposerRichInputProps> = {}) {
  const container = document.createElement('div');
  const root = createRoot(container);
  const ref = createRef<ComposerRichInputHandle>();
  const render = (text: string, prefix: ComposerDocument['nodes'] = [], props = initialProps) => {
    const document: ComposerDocument = { version: 1, nodes: [...prefix, { type: 'text', text }] };
    act(() => root.render(createElement(ComposerNativeInput, {
      ref, document, height: 40, theme: {}, onChangeDocument: vi.fn(), ...props,
    } as unknown as ComposerRichInputProps & { ref: typeof ref })));
    return document;
  };
  render(text);
  cleanups.push(() => act(() => root.unmount()));
  return { input: ref, render };
}

it('keeps the final dictated caret across render and stale native selection echoes', () => {
  const { input, render } = mount('第一句');
  const final = '第一句，第二句话🙂。';
  input.current!.rememberSelection(final, { start: final.length, end: final.length });
  expect(input.current!.getSelection(final).end).toBe(final.length);
  const document = render(final);
  bridge.props.onSelectionChange({ nativeEvent: { start: 3, end: 3, revision: 0 } });
  const end = input.current!.getSelection(final).end;
  expect(end).toBe(final.length);
  input.current!.applyDocumentAndFocusSelection(document, end);
  expect(bridge.setDocument).toHaveBeenLastCalledWith(expect.anything(), final.length, true);
});

it('allows the stop callback to restore the caret after the final transcript renders', () => {
  const { input, render } = mount('开头');
  // finishVoiceRecording retains this handle across await controller.stop().
  const inputBeforeStop = input.current!;
  const final = '开头，最后一句话。';
  inputBeforeStop.rememberSelection(final, { start: final.length, end: final.length });
  const document = render(final);
  const end = input.current!.getSelection(final).end;
  // This is the screen's unmount/replacement guard before restoring the caret.
  if (input.current === inputBeforeStop) {
    inputBeforeStop.applyDocumentAndSetSelection(document, end);
  }
  // Dictation ending must not raise the keyboard on its own.
  expect(bridge.setDocument).toHaveBeenCalledWith(expect.anything(), final.length, false);
});

it('restores the insertion end before an existing suffix and maps quote attachments', () => {
  const { input, render } = mount('前后');
  const final = '前语音内容后';
  input.current!.rememberSelection(final, { start: 5, end: 5 });
  const document = render(final, [{ type: 'quote', quote: { text: '引用' } }]);
  input.current!.applyDocumentAndFocusSelection(document, input.current!.getSelection(final).end);
  expect(bridge.setDocument).toHaveBeenLastCalledWith(expect.anything(), 6, true);
});

it('lets subsequent native editing own the caret instead of reusing dictation memory', () => {
  const { input, render } = mount('语音');
  input.current!.rememberSelection('语音结果', { start: 4, end: 4 });
  render('语音结果');
  bridge.props.onDocumentChange({ nativeEvent: {
    document: { version: 1, nodes: [{ type: 'text', text: '语音结果' }] }, revision: 1,
  } });
  bridge.props.onSelectionChange({ nativeEvent: { start: 1, end: 1, revision: 1 } });
  expect(input.current!.getSelection('语音结果').end).toBe(1);
  expect(input.current!.getSelection('别的草稿').end).toBe(4);
});

// PR #9242 r4500592029, unit: native iOS can reject an oversized clipboard as
// images:[] without creating a placeholder. It must not settle an older accepted
// batch. Existing native-input tests did not exercise async image delivery.
it.each([{ images: [] }, { images: ['eA=='] }])('does not let a rejected native image batch release an accepted batch placeholder ($images)', async ({ images }) => {
  let finishWrite!: () => void;
  bridge.writeImage.mockReturnValue(new Promise<void>((resolve) => { finishWrite = resolve; }));
  bridge.deleteImage.mockResolvedValue(undefined);
  let placeholders = 0;
  const fail = vi.fn(() => { placeholders -= 1; });
  const deliver = vi.fn(() => { placeholders -= 1; });
  const props = {
    onPasteImages: deliver,
    onPasteImagesLoading: (count: number) => { placeholders += count; },
    onPasteImagesLoadFailed: fail,
  };
  const { render } = mount('draft with an image', props);
  act(() => bridge.props.onPasteImages({ nativeEvent: { images: ['eA=='] } }));
  expect(placeholders).toBe(1);
  // Send removes only new-image entry callbacks; the first file write is pending.
  render('draft with an image', [], { ...props, onPasteImages: undefined, onPasteImagesLoading: undefined });
  act(() => bridge.props.onPasteImages({ nativeEvent: { images } }));
  expect(placeholders).toBe(1);
  expect(fail).not.toHaveBeenCalled();
  expect(bridge.writeImage).toHaveBeenCalledTimes(1);
  await act(async () => finishWrite());
  expect(deliver).toHaveBeenCalledExactlyOnceWith(['file:///cache/native-paste.png']);
  expect(placeholders).toBe(0);
  expect(fail).not.toHaveBeenCalled();
});
