// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, createElement, createRef, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { TextInputProps, TextStyle } from 'react-native';
import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MobileComposerInputRow, type MobileComposerInputRowProps } from '@/session/MobileComposerInputRow';
import { palettes } from '@/theme/tokens';

const native = vi.hoisted(() => ({
  platform: 'android',
  mode: 'light' as 'light' | 'dark',
  props: {} as TextInputProps,
}));
vi.mock('react-native', () => ({
  Platform: { get OS() { return native.platform; } },
  StyleSheet: { hairlineWidth: 1 },
  View: ({ children }: { children: ReactNode }) => createElement('div', null, children),
}));
vi.mock('@/components/AppText', async () => {
  const { forwardRef } = await import('react');
  return { TextInput: forwardRef<HTMLTextAreaElement, TextInputProps>((props, ref) => {
    native.props = props;
    return createElement('textarea', {
      ref, value: props.value, readOnly: true,
      onMouseDown: () => props.onPressIn?.({} as never),
    });
  }) };
});
vi.mock('react-native-reanimated', () => ({
  default: { View: ({ children }: { children: ReactNode }) => createElement('div', null, children) },
}));
vi.mock('@/platform/gestureHandler', () => ({}));
vi.mock('lucide-react-native', () => ({}));
vi.mock('expo-constants', () => ({
  default: { executionEnvironment: 'bare' }, ExecutionEnvironment: { StoreClient: 'storeClient' },
}));
vi.mock('expo-paste-input', () => ({
  TextInputWrapper: ({ children }: { children: ReactNode }) => createElement('div', null, children),
}));
vi.mock('@/theme', () => ({
  useThemedStyles: (make: (colors: typeof palettes.light) => unknown) => make(palettes[native.mode]),
}));

// Exercise the page's actual visibility/event expressions and the real input row.
// Extract only this boundary so unrelated screen/network/native dependencies are not loaded.
// Native drawing and hit testing still require the Android emulator regression.
const source = ts.createSourceFile('new.tsx', readFileSync(
  resolve(process.cwd(), 'app/sessions/new.tsx'), 'utf8',
), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function findOne<T extends ts.Node>(guard: (node: ts.Node) => node is T): T {
  const found: T[] = [];
  function visit(node: ts.Node) {
    if (guard(node)) found.push(node);
    ts.forEachChild(node, visit);
  }
  visit(source);
  if (found.length !== 1) throw new Error(`Expected one source boundary, found ${found.length}`);
  return found[0];
}
const hiddenStyle = findOne((node): node is ts.PropertyAssignment =>
  ts.isPropertyAssignment(node) && node.name.getText(source) === 'inputVoiceHidden');
const composer = findOne((node): node is ts.JsxSelfClosingElement =>
  ts.isJsxSelfClosingElement(node) && node.tagName.getText(source) === 'MobileComposerInputRow');
const propNames = ['inputStyle', 'caretHidden', 'value', 'placeholder', 'selection', 'onPressIn', 'onKeyPress'];
function composerExpression(name: string) {
  const prop = composer.attributes.properties.find((node) =>
    ts.isJsxAttribute(node) && node.name.getText(source) === name);
  if (!prop || !ts.isJsxAttribute(prop) || !prop.initializer
    || !ts.isJsxExpression(prop.initializer) || !prop.initializer.expression) {
    throw new Error(`Missing composer expression: ${name}`);
  }
  return prop.initializer.expression.getText(source);
}
const expressions = propNames.map((name) => `${name}: ${composerExpression(name)}`);
const compiled = ts.transpileModule(`function pageProps(bindings) {
  const { Platform, voiceIsListening, draft, finishVoiceRecording, composerPlaceholder, firstMessageSelection,
    voiceStopGestureSelectionGuardRef, voicePendingSelectionEchoesRef } = bindings;
  const styles = { inputVoiceHidden: ${hiddenStyle.initializer.getText(source)} };
  return { ${expressions.join(',\n')} };
}`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const pageProps = new Function(`${compiled}; return pageProps;`)() as
  (bindings: Record<string, unknown>) => Partial<MobileComposerInputRowProps>;

// Run the actual page callbacks across a deferred stop(), including native
// selection echoes and typing, instead of asserting the source of a guard.
const draftCallback = findOne((node): node is ts.PropertyAssignment =>
  ts.isPropertyAssignment(node) && node.name.getText(source) === 'onDraftChanged');
const stopCallback = findOne((node): node is ts.VariableDeclaration =>
  ts.isVariableDeclaration(node) && node.name.getText(source) === 'finishVoiceRecording');
if (!stopCallback.initializer || !ts.isCallExpression(stopCallback.initializer)) {
  throw new Error('Missing finishVoiceRecording callback');
}
type Selection = { start: number; end: number };
const compiledVoice = ts.transpileModule(`function voiceCallbacks(bindings) {
  const { voiceSelectionUserOwnedRef, voiceRecordingActiveRef, voiceStopInFlightRef,
    voiceStopGestureSelectionGuardRef, voicePendingSelectionEchoesRef,
    firstMessageRef, firstMessageSelectionRef, setFirstMessageSelection, setFirstMessageDraft,
    voiceControllerSessionRef, voiceStartupSeqRef, voiceStartupInFlightRef, voiceState,
    setVoiceState, setVoiceError, setAudioModeAsync, requestAnimationFrame,
    firstMessageInputRef, formatRemoteError, voiceIsListening, finishVoiceRecording } = bindings;
  return {
    publish: ${draftCallback.initializer.getText(source)},
    select: ${composerExpression('onSelectionChange')},
    type: ${composerExpression('onChangeText')},
    press: ${composerExpression('onPressIn')},
    key: ${composerExpression('onKeyPress')},
    stop: ${stopCallback.initializer.arguments[0].getText(source)},
  };
}`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const voiceCallbacks = new Function(`${compiledVoice}; return voiceCallbacks;`)() as
  (bindings: Record<string, unknown>) => {
    publish: (text: string, selection?: Selection, replacement?: Selection & { text: string }) => void;
    select: (event: { nativeEvent: { selection: Selection } }) => void;
    type: (text: string) => void;
    press: () => void;
    key: () => void;
    stop: () => Promise<string | null>;
  };

function pendingVoiceStop(initialDraft = '前后') {
  const firstMessageRef = { current: initialDraft };
  const firstMessageSelectionRef = { current: { start: 1, end: 1 } };
  let controlledSelection = firstMessageSelectionRef.current;
  let completeStop!: (draft: string) => void;
  let finishVoiceRecording!: () => Promise<string | null>;
  let activeStop: Promise<string | null> | undefined;
  const stopGate = new Promise<string>((resolve) => { completeStop = resolve; });
  const setNativeProps = vi.fn();
  const bindings = {
    firstMessageRef, firstMessageSelectionRef,
    voiceSelectionUserOwnedRef: { current: false },
    voiceStopGestureSelectionGuardRef: { current: false },
    voicePendingSelectionEchoesRef: { current: [] },
    voiceRecordingActiveRef: { current: true }, voiceStopInFlightRef: { current: false },
    voiceStartupSeqRef: { current: 1 }, voiceStartupInFlightRef: { current: false },
    voiceControllerSessionRef: { current: { stop: () => stopGate } },
    voiceState: 'listening', setVoiceState: vi.fn(), setVoiceError: vi.fn(),
    setFirstMessageSelection: (next: Selection) => { controlledSelection = next; },
    setFirstMessageDraft: (text: string) => { firstMessageRef.current = text; },
    setAudioModeAsync: async () => undefined,
    requestAnimationFrame: (callback: () => void) => callback(),
    firstMessageInputRef: { current: { setNativeProps } }, formatRemoteError: String,
    voiceIsListening: true, finishVoiceRecording: () => {
      activeStop = callbacks.stop();
      return activeStop;
    },
  };
  const callbacks = voiceCallbacks(bindings);
  return {
    ...callbacks,
    selection: () => controlledSelection,
    move: (start: number, end = start) => callbacks.select({ nativeEvent: { selection: { start, end } } }),
    complete: () => completeStop(firstMessageRef.current), setNativeProps,
    press: () => { callbacks.press(); return activeStop; },
    pressToEdit: () => voiceCallbacks({ ...bindings, voiceIsListening: false }).press(),
    insert: (text: string) => firstMessageRef.current.slice(0, controlledSelection.start)
      + text + firstMessageRef.current.slice(controlledSelection.end),
  };
}

describe('new-session selection during dictation stop', () => {
  it.each([false, true])('ignores a delayed ASR selection echo (stop completed=%s)', async (completed) => {
    const voice = pendingVoiceStop();
    const stop = voice.stop();
    voice.publish('前原始转写后', { start: 5, end: 5 });
    voice.publish('前润色后', { start: 3, end: 3 });
    if (completed) {
      voice.complete();
      await stop;
    }
    voice.move(5); // the first controlled update arrives after the second JS update
    expect(voice.selection()).toEqual({ start: 3, end: 3 });
    if (!completed) {
      voice.publish('前最终润色后', { start: 5, end: 5 });
      voice.complete();
      await stop;
      expect(voice.selection()).toEqual({ start: 5, end: 5 });
      expect(voice.insert('!')).toBe('前最终润色!后');
    } else {
      expect(voice.insert('!')).toBe('前润色!后');
    }
  });

  it('ignores delayed echoes of a rebased user selection', async () => {
    const voice = pendingVoiceStop('前后缀');
    voice.publish('前识别后缀', { start: 3, end: 3 });
    const stop = voice.stop();
    voice.move(4);
    voice.publish('前原始转写后缀', { start: 5, end: 5 }, { start: 1, end: 3, text: '原始转写' });
    voice.publish('前词后缀', { start: 2, end: 2 }, { start: 1, end: 5, text: '词' });
    voice.move(6); // echo of the first rebase, not another user move
    expect(voice.selection()).toEqual({ start: 3, end: 3 });
    voice.complete();
    await stop;
    expect(voice.insert('!')).toBe('前词后!缀');
  });

  it('retires skipped echoes when native acknowledges the latest controlled selection', async () => {
    const voice = pendingVoiceStop();
    const stop = voice.stop();
    voice.publish('前原始转写后', { start: 5, end: 5 });
    voice.publish('前润色后', { start: 3, end: 3 });
    voice.move(3); // native coalesced the first event
    voice.move(5); // now a genuine movement back to an old controlled value
    voice.publish('前润色后', { start: 3, end: 3 });
    voice.complete();
    await stop;
    expect(voice.selection()).toEqual({ start: 5, end: 5 });
  });

  it.each(['touch', 'key', 'typing'] as const)('accepts a user returning to a pending value via %s', async (action) => {
    const voice = pendingVoiceStop();
    const stop = voice.stop();
    voice.publish('前原始转写后', { start: 5, end: 5 });
    voice.publish('前润色后', { start: 3, end: 3 });
    if (action === 'touch') voice.pressToEdit();
    if (action === 'key') voice.key();
    if (action === 'typing') voice.type('前润色!?后');
    voice.move(5);
    voice.publish(action === 'typing' ? '前润色!?后' : '前润色后', { start: 3, end: 3 });
    voice.complete();
    await stop;
    expect(voice.selection()).toEqual({ start: 5, end: 5 });
  });

  it.each([
    ['caret in suffix', [4, 4], [6, 6], [3, 3], '前词后!缀'],
    ['selected suffix', [3, 5], [5, 7], [2, 4], '前词!'],
    ['selected prefix', [0, 1], [0, 1], [0, 1], '!词后缀'],
    ['selection across insertion', [0, 5], [0, 7], [0, 4], '!'],
    ['caret inside replacement', [2, 2], [2, 2], [2, 2], '前词!后缀'],
  ] as const)('rebases %s through longer ASR and shorter refinement', async (_name, initial, longer, shorter, inserted) => {
    const voice = pendingVoiceStop('前后缀');
    voice.publish('前识别后缀', { start: 3, end: 3 });
    const stop = voice.stop();
    voice.move(initial[0], initial[1]);
    voice.publish('前原始转写后缀', { start: 5, end: 5 }, { start: 1, end: 3, text: '原始转写' });
    expect(voice.selection()).toEqual({ start: longer[0], end: longer[1] });
    voice.publish('前词后缀', { start: 2, end: 2 }, { start: 1, end: 5, text: '词' });
    expect(voice.selection()).toEqual({ start: shorter[0], end: shorter[1] });
    voice.complete();
    expect(await stop).toBe('前词后缀');
    expect(voice.setNativeProps).toHaveBeenCalledWith({ selection: { start: shorter[0], end: shorter[1] } });
    expect(voice.insert('!')).toBe(inserted);
  });

  it('preserves the position after manually typed suffix text when final voice text changes length', async () => {
    const voice = pendingVoiceStop();
    voice.publish('前识别后', { start: 3, end: 3 });
    const stop = voice.stop();
    voice.move(4);
    voice.type(voice.insert('!'));
    voice.move(5);
    voice.publish('前原始转写后!', { start: 5, end: 5 }, { start: 1, end: 3, text: '原始转写' });
    expect(voice.selection()).toEqual({ start: 7, end: 7 });
    voice.publish('前词后!', { start: 2, end: 2 }, { start: 1, end: 5, text: '词' });
    voice.complete();
    await stop;
    expect(voice.selection()).toEqual({ start: 4, end: 4 });
    expect(voice.insert('?')).toBe('前词后!?');
  });

  it('ignores the selection event caused by the stop gesture, then accepts a later user move', async () => {
    const voice = pendingVoiceStop();
    voice.publish('前识别后', { start: 3, end: 3 });
    const stop = voice.press();
    voice.move(5); // native selection change caused by the same stop press
    voice.publish('前原始转写后', { start: 5, end: 5 });
    expect(voice.selection()).toEqual({ start: 5, end: 5 });
    voice.move(0); // a real user move during stop owns the selection
    voice.publish('前润色后', { start: 3, end: 3 });
    voice.complete();
    expect(await stop).toBe('前润色后');
    expect(voice.selection()).toEqual({ start: 0, end: 0 });
  });

  it.each([false, true])('follows final ASR and refinement without a user move (partial=%s)', async (partial) => {
    const voice = pendingVoiceStop();
    if (partial) voice.publish('前识别后', { start: 3, end: 3 });
    const stop = voice.stop();
    voice.move(partial ? 3 : 1); // unchanged native echo must not claim the caret
    voice.publish('前原始转写后', { start: 5, end: 5 });
    expect(voice.selection()).toEqual({ start: 5, end: 5 });
    voice.move(5); // echo of the controlled final ASR selection
    voice.publish('前润色后', { start: 3, end: 3 });
    expect(voice.selection()).toEqual({ start: 3, end: 3 });
    voice.complete();
    expect(await stop).toBe('前润色后');
    expect(voice.setNativeProps).toHaveBeenCalledWith({ selection: { start: 3, end: 3 } });
    expect(voice.insert('!')).toBe('前润色!后');
  });

  it('preserves a user range across final ASR and refinement', async () => {
    const voice = pendingVoiceStop();
    voice.publish('前识别后', { start: 3, end: 3 });
    const stop = voice.stop();
    voice.move(0, 1);
    voice.publish('前原始转写后', { start: 5, end: 5 });
    voice.publish('前润色后', { start: 3, end: 3 });
    voice.complete();
    await stop;
    expect(voice.selection()).toEqual({ start: 0, end: 1 });
    expect(voice.insert('!')).toBe('!润色后');
  });

  it('keeps user ownership after moving away and back to the old insertion point', async () => {
    const voice = pendingVoiceStop();
    voice.publish('前识别后', { start: 3, end: 3 });
    const stop = voice.stop();
    voice.move(0);
    voice.move(3);
    voice.publish('前更长转写后', { start: 5, end: 5 });
    voice.complete();
    await stop;
    expect(voice.selection()).toEqual({ start: 3, end: 3 });
  });

  it('claims the caret on native typing before its selection event arrives', async () => {
    const voice = pendingVoiceStop();
    const stop = voice.stop();
    voice.type('前!后');
    voice.publish('前!转写后', { start: 4, end: 4 });
    expect(voice.selection()).toEqual({ start: 1, end: 1 });
    voice.move(2);
    voice.publish('前!润色结果后', { start: 6, end: 6 });
    voice.complete();
    await stop;
    expect(voice.selection()).toEqual({ start: 2, end: 2 });
    expect(voice.insert('?')).toBe('前!?润色结果后');
  });
});

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined;
afterEach(() => { act(() => root?.unmount()); root = undefined; });

function mountInput() {
  const container = document.createElement('div');
  const ref = createRef<HTMLTextAreaElement>();
  const finishVoiceRecording = vi.fn();
  root = createRoot(container);
  function render(listening: boolean, draft: string, selection = { start: draft.length, end: draft.length }) {
    const colors = palettes[native.mode];
    act(() => root!.render(createElement(MobileComposerInputRow, {
      accessibilityLabel: 'Draft', inputTestID: 'draft', inputRef: ref,
      placeholder: 'Draft', placeholderTextColor: colors.textTertiary,
      value: draft, onChangeText: vi.fn(), onPasteImages: vi.fn(),
      ...pageProps({ Platform: { OS: native.platform }, voiceIsListening: listening,
        draft: { firstMessage: draft }, firstMessageSelection: selection,
        finishVoiceRecording, composerPlaceholder: 'Draft',
        voiceStopGestureSelectionGuardRef: { current: false },
        voicePendingSelectionEchoesRef: { current: [] } }),
      inputOverlay: listening ? createElement('span', { 'data-testid': 'preview' }, draft) : null,
    })));
  }
  const inputStyle = () => {
    const styles: unknown[] = [native.props.style];
    return Object.assign({}, ...styles.flat(Infinity).filter(Boolean)) as TextStyle;
  };
  return { container, ref, render, inputStyle, finishVoiceRecording };
}

describe.each(['light', 'dark'] as const)('new-session dictation input (%s)', (mode) => {
  it('hides Android native drawing while keeping streamed drafts and the same mounted input', () => {
    native.platform = 'android';
    native.mode = mode;
    const input = mountInput();
    input.render(false, 'before suffix');
    const original = input.ref.current;
    expect(original).not.toBeNull();
    expect(input.inputStyle().opacity ?? 1).toBe(1);
    expect(input.inputStyle().color).toBe(palettes[mode].textPrimary);

    for (const draft of ['before hello suffix', 'before hello\nworld suffix']) {
      input.render(true, draft);
      expect(input.ref.current).toBe(original);
      expect(original?.value).toBe(draft);
      expect(input.inputStyle().opacity).toBe(0);
      expect(input.inputStyle().display).not.toBe('none');
      expect(native.props.caretHidden).toBe(true);
      expect(native.props.placeholder).toBe('');
      expect(native.props.selection).toEqual({ start: draft.length, end: draft.length });
      expect(input.container.querySelector('[data-testid="preview"]')?.textContent).toBe(draft);
    }
    act(() => original!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })));
    expect(input.finishVoiceRecording).toHaveBeenCalledOnce();

    input.render(false, 'before hello\nworld suffix');
    expect(input.ref.current).toBe(original);
    expect(original?.value).toBe('before hello\nworld suffix');
    expect(input.inputStyle().opacity ?? 1).toBe(1);
    expect(input.inputStyle().color).toBe(palettes[mode].textPrimary);
    expect(native.props.caretHidden).toBe(false);
    expect(native.props.selection).toEqual({ start: 'before hello\nworld suffix'.length, end: 'before hello\nworld suffix'.length });
    expect(input.container.querySelector('[data-testid="preview"]')).toBeNull();
    act(() => original!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })));
    expect(input.finishVoiceRecording).toHaveBeenCalledOnce();
  });

  it('retains transparent text on iOS without hiding the view from native hit testing', () => {
    native.platform = 'ios';
    native.mode = mode;
    const input = mountInput();
    input.render(true, 'dictation');
    expect(input.inputStyle().color).toBe('transparent');
    expect(input.inputStyle().opacity ?? 1).toBe(1);
    input.render(false, 'dictation');
    expect(input.inputStyle().color).toBe(palettes[mode].textPrimary);
  });

  it('keeps the post-dictation insertion point when Android returns to typing', () => {
    native.platform = 'android';
    native.mode = mode;
    const input = mountInput();
    input.render(true, '甲新词乙', { start: 4, end: 4 });
    expect(native.props.selection).toEqual({ start: 4, end: 4 });
    input.render(false, '甲新词乙', { start: 4, end: 4 });
    expect(native.props.selection).toEqual({ start: 4, end: 4 });
  });
});
