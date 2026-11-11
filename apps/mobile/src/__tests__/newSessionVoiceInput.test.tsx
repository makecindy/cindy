// @vitest-environment jsdom
import { act, createElement, createRef, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { TextInputProps, TextStyle } from 'react-native';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MobileComposerInputRow } from '@/session/MobileComposerInputRow';
import {
  changeNewSessionVoiceSelection, changeNewSessionVoiceText, finishNewSessionVoiceRecording,
  newSessionVoiceComposerProps, publishNewSessionVoiceDraft,
  type NewSessionVoiceSelectionInput, type NewSessionVoiceStopInput,
} from '@/session/newSessionVoiceInput';
import { deferred } from './fixtures/newSession';
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
  // MobileComposerInputRow 经 useReduceMotionEnabled 读系统「减弱动态效果」偏好。
  AccessibilityInfo: {
    isReduceMotionEnabled: () => Promise.resolve(false),
    addEventListener: () => ({ remove: () => {} }),
  },
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
vi.mock('expo-glass-effect', () => ({
  isLiquidGlassAvailable: () => true,
  GlassView: () => null,
}));
vi.mock('@/theme', () => ({
  useTheme: () => ({ mode: native.mode, colors: palettes[native.mode] }),
  useThemedStyles: (make: (colors: typeof palettes.light) => unknown) => make(palettes[native.mode]),
}));

// Unit: production voice/form functions and the real input row protect delayed
// selection echoes, typing during stop, and Android's native-text regression.
// Deferred stop plus a user edit is the minimum timing input. Native drawing and
// hit testing still require the Android emulator regression.
type Selection = { start: number; end: number };

function pendingVoiceStop(initialDraft = '前后') {
  const firstMessageRef = { current: initialDraft };
  const firstMessageSelectionRef = { current: { start: 1, end: 1 } };
  let controlledSelection = firstMessageSelectionRef.current;
  let activeStop: Promise<string | null> | undefined;
  const stopGate = deferred<string>();
  const setNativeProps = vi.fn();
  const bindings = {
    firstMessageRef, firstMessageSelectionRef,
    voiceSelectionUserOwnedRef: { current: false },
    voiceStopGestureSelectionGuardRef: { current: false },
    voicePendingSelectionEchoesRef: { current: [] as Selection[] },
    voiceRecordingActiveRef: { current: true }, voiceStopInFlightRef: { current: false },
    voiceStartupSeqRef: { current: 1 }, voiceStartupInFlightRef: { current: false },
    voiceControllerSessionRef: { current: { stop: () => stopGate.promise } },
    voiceState: 'listening', setVoiceState: vi.fn(), setVoiceError: vi.fn(),
    setFirstMessageSelection: (next: Selection) => { controlledSelection = next; },
    setFirstMessageDraft: (text: string) => { firstMessageRef.current = text; },
    requestAnimationFrame: (callback: () => void) => callback(),
    firstMessageInputRef: { current: { setNativeProps } }, formatRemoteError: String,
  } satisfies NewSessionVoiceSelectionInput & NewSessionVoiceStopInput;
  const stop = () => finishNewSessionVoiceRecording(bindings);
  const composer = (voiceIsListening: boolean) => newSessionVoiceComposerProps({
    ...bindings, platform: 'android', voiceIsListening, firstMessage: firstMessageRef.current,
    firstMessageSelection: controlledSelection, composerPlaceholder: 'Draft',
    finishVoiceRecording: () => { activeStop = stop(); return activeStop; },
  });
  return {
    stop,
    publish: (text: string, selection?: Selection, replacement?: Selection & { text: string }) =>
      publishNewSessionVoiceDraft(bindings, text, selection, replacement),
    type: (text: string) => changeNewSessionVoiceText(bindings, text),
    key: () => composer(true).onKeyPress(),
    selection: () => controlledSelection,
    move: (start: number, end = start) => changeNewSessionVoiceSelection(bindings, { start, end }),
    complete: () => stopGate.resolve(firstMessageRef.current), setNativeProps,
    press: () => { composer(true).onPressIn(); return activeStop; },
    pressToEdit: () => composer(false).onPressIn(),
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
      placeholderTextColor: colors.textTertiary,
      onChangeText: vi.fn(), onPasteImages: vi.fn(),
      ...newSessionVoiceComposerProps({ platform: native.platform, voiceIsListening: listening,
        firstMessage: draft, firstMessageSelection: selection,
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

  it('keeps iOS dictation text in the same visible native input', () => {
    native.platform = 'ios';
    native.mode = mode;
    const input = mountInput();
    input.render(true, 'dictation');
    expect(input.inputStyle().color).toBe(palettes[mode].textPrimary);
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
