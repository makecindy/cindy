// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import type { Editor } from '@tiptap/core';
import { Schema } from '@tiptap/pm/model';
import { EditorState, type Transaction } from '@tiptap/pm/state';
import type { VoiceInputRendererEvent } from '@cindy/voice-input-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  advise: vi.fn(),
  promptExpired: vi.fn(),
  translate: (key: string) => key,
  settings: { language: 'auto', refinementEnabled: true, autoDictionaryEnabled: true },
}));

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: mocks.translate }) }));
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn() }),
}));
vi.mock('@/lib/toast', () => ({ toast: { warning: vi.fn(), error: vi.fn() } }));
vi.mock('@/hooks/useCodexSessionExpiredPrompt', () => ({
  useCodexSessionExpiredPrompt: () => mocks.promptExpired,
  isCodexSessionExpiredError: () => false,
}));
vi.mock('@/hooks/useVoiceInputSettings', () => ({
  useVoiceInputSettings: () => ({ settings: mocks.settings }),
  adviseAndRecordVoiceInputDictionaryLearning: mocks.advise,
}));
vi.mock('@/hooks/useVoiceInputHistory', () => ({
  recordVoiceInputHistory: () => null,
  updateVoiceInputHistoryEntry: vi.fn(),
}));
vi.mock('@/hooks/useVoiceInputUsageStats', () => ({
  recordVoiceInputUsage: vi.fn(),
  recordVoiceInputRefinementUsage: vi.fn(),
}));
vi.mock('../workletUrl', () => ({ getVoiceInputWorkletUrl: () => '' }));
// Deliver an already accepted transcript without opening a microphone/ASR session.
vi.mock('../eventScope', () => ({
  shouldHandleVoiceInputEvent: () => true,
  isVoiceInputEventScopeActive: () => false,
}));

import { useVoiceInput } from '../useVoiceInput';

const baseline = '使用 Cloud Code。';
const schema = new Schema({
  nodes: {
    doc: { content: 'paragraph+' },
    paragraph: { content: 'text*' },
    text: {},
  },
});

function mountDictation() {
  let onEvent!: (event: VoiceInputRendererEvent) => void;
  vi.stubGlobal('electronAPI', {
    voiceInput: {
      onEvent: (listener: typeof onEvent) => {
        onEvent = listener;
        return vi.fn();
      },
      cancel: vi.fn().mockResolvedValue({ ok: true }),
    },
  });
  let state = EditorState.create({ doc: schema.node('doc', null, [schema.node('paragraph')]) });
  const listeners = new Set<(payload: { transaction: Transaction }) => void>();
  const dispatch = (transaction: Transaction) => {
    state = state.apply(transaction);
    listeners.forEach((listener) => listener({ transaction }));
  };
  // Real ProseMirror documents, steps and mappings; only the editor view is stubbed.
  const editor = {
    get state() {
      return state;
    },
    view: {
      get state() {
        return state;
      },
      dispatch,
    },
    isDestroyed: false,
    commands: { focus: vi.fn() },
    on: (_event: string, listener: (payload: { transaction: Transaction }) => void) =>
      listeners.add(listener),
    off: (_event: string, listener: (payload: { transaction: Transaction }) => void) =>
      listeners.delete(listener),
  } as unknown as Editor;
  const hook = renderHook(() => useVoiceInput(editor, true));
  act(() =>
    onEvent({
      type: 'submitted',
      runId: 'run',
      text: baseline,
      segment: {
        id: 'segment',
        source: 'mic',
        status: 'submitted',
        text: baseline,
        updatedAt: Date.now(),
      },
    }),
  );
  expect(state.doc.textContent).toBe(baseline);

  return {
    unmount: hook.unmount,
    correct(replacement = 'Claude') {
      const transaction = state.tr.insertText(replacement, 4, 9);
      const undo = transaction.steps[0].invert(transaction.docs[0]);
      act(() => dispatch(transaction));
      return () => {
        act(() => dispatch(state.tr.step(undo)));
        expect(state.doc.textContent).toBe(baseline);
      };
    },
    clear() {
      act(() => dispatch(state.tr.delete(1, state.doc.content.size - 1)));
    },
    type(text: string) {
      act(() => dispatch(state.tr.insertText(text)));
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  mocks.advise.mockReset();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('in-app dictionary learning after undo', () => {
  describe.each(['unchanged', 'undone correction'] as const)('clearing %s dictation', (source) => {
    it.each(['clear', 'unmount', 'timeout'] as const)(
      'does not learn unrelated new input on %s',
      (finish) => {
        const dictation = mountDictation();
        if (source === 'undone correction') dictation.correct()();
        dictation.clear();
        dictation.type('明天再讨论这个问题。');
        if (finish === 'timeout') act(() => vi.advanceTimersByTime(15_000));
        else dictation[finish]();
        expect(mocks.advise).not.toHaveBeenCalled();
        dictation.unmount();
        act(() => vi.advanceTimersByTime(15_000));
        expect(mocks.advise).not.toHaveBeenCalled();
      },
    );
  });

  it.each(['clear', 'unmount'] as const)('discards an undone correction before %s', (finish) => {
    const dictation = mountDictation();
    const undo = dictation.correct();
    expect(mocks.advise).not.toHaveBeenCalled();
    undo();
    dictation[finish]();
    act(() => vi.advanceTimersByTime(15_000));
    expect(mocks.advise).not.toHaveBeenCalled();
  });

  it('does not learn an undone correction when its old timeout elapses', () => {
    const dictation = mountDictation();
    const undo = dictation.correct();
    undo();
    act(() => vi.advanceTimersByTime(15_000));
    expect(mocks.advise).not.toHaveBeenCalled();
    dictation.unmount();
    expect(mocks.advise).not.toHaveBeenCalled();
  });

  it.each(['clear', 'unmount', 'timeout'] as const)(
    'learns a fresh correction after undo on %s',
    (finish) => {
      const dictation = mountDictation();
      const undo = dictation.correct();
      undo();
      dictation.correct('Codex');
      if (finish === 'timeout') act(() => vi.advanceTimersByTime(15_000));
      else dictation[finish]();
      expect(mocks.advise).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          beforeText: baseline,
          rawTranscriptText: baseline,
          afterText: '使用 Codex Code。',
        }),
      );
      dictation.unmount();
      act(() => vi.advanceTimersByTime(15_000));
      expect(mocks.advise).toHaveBeenCalledTimes(1);
    },
  );
});
