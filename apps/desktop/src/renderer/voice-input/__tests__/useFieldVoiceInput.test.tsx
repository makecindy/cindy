// @vitest-environment jsdom
// Unified non-composer voice input regression: covers the shared VoiceInputButton
// visual/accessibility contract, single-owner arbitration across multiple mounted
// fields, Escape-to-cancel inside Radix AlertDialog without dismissing the dialog,
// and submit-while-recording returning the finalized transcript.
import * as AlertDialog from '@radix-ui/react-alert-dialog';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useRef, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VoiceInputRendererEvent } from '@cindy/voice-input-core';

import { Tooltip } from '@/components/ui/tooltip';
import type { VoiceInputShortcut } from '@/voice-input/shortcut';

const mocks = vi.hoisted(() => ({
  settings: {
    language: 'auto',
    refinementEnabled: true,
    fastActivationEnabled: false,
    muteSystemAudio: false,
    playInteractionSound: false,
    composerLongPressEnabled: true,
    shortcut: null as VoiceInputShortcut | null,
    dictionaryEntries: [],
    refinementInstructions: '',
  },
  owner: { dataOwnerId: 'field-owner', generation: 1 },
  guards: vi.fn(),
  onSamples: null as ((pcm: ArrayBuffer) => void) | null,
  captureVoiced: true,
  captureStarts: 0,
  adviseDictionaryLearning: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@/hooks/useCodexSessionExpiredPrompt', () => ({
  useCodexSessionExpiredPrompt: () => vi.fn(),
  isCodexSessionExpiredError: () => false,
}));
vi.mock('@/hooks/useVoiceInputSettings', () => ({
  useVoiceInputSettings: () => ({ settings: mocks.settings }),
  getVoiceInputSettings: () => mocks.settings,
  adviseAndRecordVoiceInputDictionaryLearning: mocks.adviseDictionaryLearning,
}));
vi.mock('@/hooks/useVoiceInputHistory', () => ({
  recordVoiceInputHistory: () => null,
  updateVoiceInputHistoryEntry: vi.fn(),
  getVoiceInputHistoryForRefinement: () => [],
}));
vi.mock('@/hooks/useVoiceInputUsageStats', () => ({
  recordVoiceInputUsage: vi.fn(),
  recordVoiceInputRefinementUsage: vi.fn(),
}));
vi.mock('@/voice-input/workletUrl', () => ({ getVoiceInputWorkletUrl: () => '' }));
vi.mock('@/voice-input/audioContextPool', () => ({ prewarmVoiceInputAudio: async () => {} }));
vi.mock('@/voice-input/WebMicAudioEngine', () => ({
  disposeKeepAliveVoiceInputMicrophone: async () => {},
  prewarmVoiceInputBenchmarkFixture: async () => {},
  isMicrophoneDeviceUnavailableError: () => false,
  isSelectedMicrophoneUnavailableError: () => false,
}));
vi.mock('@/voice-input/startGuards', () => ({ resolveVoiceInputStartGuards: mocks.guards }));
vi.mock('@/voice-input/captureSession', () => ({
  startVoiceInputCaptureSession: async (input: {
    onCaptureReady?: () => void;
    onSoundDetected: () => void;
    onSamples?: (pcm: ArrayBuffer) => void;
    onPcmCaptured?: (pcm: ArrayBuffer) => void;
  }) => {
    mocks.captureStarts += 1;
    mocks.onSamples = input.onSamples ?? null;
    input.onCaptureReady?.();
    const pcm = new Int16Array(4_000);
    if (mocks.captureVoiced) {
      pcm.fill(2_000);
      input.onPcmCaptured?.(pcm.buffer.slice(0));
      input.onSoundDetected();
    } else {
      input.onPcmCaptured?.(pcm.buffer.slice(0));
    }
    return { ok: true, drainPendingChunks: () => {} };
  },
}));
vi.mock('@/contexts/dataOwnerGeneration', () => ({
  getDataOwnerGeneration: () => ({ ...mocks.owner }),
  isDataOwnerGenerationCurrent: (owner: typeof mocks.owner) => owner.generation === mocks.owner.generation,
}));
vi.mock('@/lib/logger', () => ({ createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn() }) }));

import { VOICE_INPUT_DICTIONARY_LEARNING_TRACK_TIMEOUT_MS } from '../../../shared/voiceInputDictionaryLearning';
import { FieldVoiceInputNotice } from '../FieldVoiceInputNotice';
import { useFieldVoiceInput } from '../useFieldVoiceInput';
import { VoiceInputButton } from '../VoiceInputButton';
import { PlanActionCard } from '@/components/new-chat/PlanActionCard';

type Trigger = { id: string; phase?: 'start' | 'tap' | 'end' };
const events = new Set<(event: VoiceInputRendererEvent) => void>();
const shortcuts = new Set<(event: Trigger) => void>();
const emit = (event: VoiceInputRendererEvent) => events.forEach((listener) => listener(event));

const voiceApi = {
  onEvent: (listener: (event: VoiceInputRendererEvent) => void) => {
    events.add(listener);
    return () => events.delete(listener);
  },
  onGlobalShortcutTrigger: (listener: (event: Trigger) => void) => {
    shortcuts.add(listener);
    return () => shortcuts.delete(listener);
  },
  claimGlobalShortcutTrigger: vi.fn(),
  prewarm: vi.fn().mockResolvedValue({ ok: true }),
  start: vi.fn(),
  stop: vi.fn(),
  cancel: vi.fn(),
  appendAudio: vi.fn(),
  drainAudioQueue: vi.fn().mockResolvedValue(undefined),
  muteSystemAudio: vi.fn().mockResolvedValue({ ok: true }),
  restoreSystemAudio: vi.fn().mockResolvedValue({ ok: true }),
};

const segment = { id: 'seg-1', source: 'mic' as const, status: 'submitted' as const, text: 'hello world', updatedAt: 1 };

function FieldHarness({
  id,
  draftKey = id,
  initialValue = '',
  onSubmitted,
}: {
  id: string;
  draftKey?: string;
  initialValue?: string;
  onSubmitted?: (text: string) => void;
}) {
  const [text, setText] = useState(initialValue);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const voice = useFieldVoiceInput({
    draftKey,
    inputRef: textareaRef,
    value: text,
    onChange: (next) => setText(next),
  });
  return (
    <div>
      <textarea
        ref={textareaRef}
        aria-label={id}
        value={voice.displayText}
        readOnly={voice.isBusy}
        onChange={(e) => setText(e.target.value)}
      />
      <VoiceInputButton {...voice.buttonProps} testId={`${id}-voice`} />
      <FieldVoiceInputNotice {...voice.noticeProps} />
      <button
        type="button"
        onClick={() => {
          void (async () => {
            const finalText = voice.isBusy ? await voice.stop() : text;
            if (finalText === null) return;
            onSubmitted?.(finalText);
          })();
        }}
      >
        submit-{id}
      </button>
    </div>
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  voiceApi.start.mockReset();
  voiceApi.stop.mockReset();
  voiceApi.cancel.mockReset();
  voiceApi.appendAudio.mockReset();
  events.clear();
  shortcuts.clear();
  mocks.onSamples = null;
  mocks.captureVoiced = true;
  mocks.captureStarts = 0;
  mocks.owner.generation = 1;
  mocks.guards.mockResolvedValue({ ok: true, permission: { ok: true }, readiness: { ok: true } });
  voiceApi.start.mockResolvedValue({ ok: true, runId: 'run-1', transport: 'direct' });
  voiceApi.stop.mockImplementation(async () => {
    emit({ type: 'submitted', runId: 'run-1', text: 'hello world', segment });
    emit({
      type: 'refined',
      runId: 'run-1',
      text: 'Hello world.',
      segment: { ...segment, status: 'refined' },
      range: { id: 'range-1', segmentIds: ['seg-1'], startOffset: 0, endOffset: 11, userTouched: false },
    });
    emit({ type: 'state', runId: 'run-1', state: 'done' });
    return { ok: true };
  });
  voiceApi.cancel.mockResolvedValue({ ok: true });
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: { platform: 'darwin', voiceInput: voiceApi },
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('VoiceInputButton & useFieldVoiceInput', () => {
  it('follows the 30px pill spec, drives live level bars on PCM samples, and delays spinner without dimming', async () => {
    const { rerender } = render(
      <Tooltip.Provider>
        <VoiceInputButton
          state="idle"
          onStart={vi.fn()}
          onStop={vi.fn()}
          testId="canonical-voice"
        />
      </Tooltip.Provider>,
    );
    const button = screen.getByTestId('canonical-voice');
    expect(button.className).toContain('h-[30px]');
    expect(button.className).toContain('rounded-full');
    expect(button.getAttribute('aria-pressed')).toBe('false');
    expect(button.getAttribute('aria-busy')).toBe('false');

    // Submitting keeps full strength (no opacity-40) and delays spinner by 150ms.
    rerender(
      <Tooltip.Provider>
        <VoiceInputButton
          state="submitting"
          onStart={vi.fn()}
          onStop={vi.fn()}
          testId="canonical-voice"
        />
      </Tooltip.Provider>,
    );
    expect(button.className).not.toContain('opacity-40');
    expect(button.getAttribute('aria-busy')).toBe('true');
    expect(button.querySelector('[data-spinner]')).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(160);
    });
    expect(button.className).not.toContain('opacity-40');

    // Truly disabled control dims with opacity-40.
    rerender(
      <Tooltip.Provider>
        <VoiceInputButton
          state="idle"
          disabled
          onStart={vi.fn()}
          onStop={vi.fn()}
          testId="canonical-voice"
        />
      </Tooltip.Provider>,
    );
    expect(button.className).toContain('opacity-40');
  });

  it('arbitrates single active voice owner across mounted fields and returns finalized text on stop()', async () => {
    const onSubmittedA = vi.fn();
    render(
      <Tooltip.Provider>
        <FieldHarness id="first" onSubmitted={onSubmittedA} />
        <FieldHarness id="second" />
      </Tooltip.Provider>,
    );

    await act(async () => {
      fireEvent.click(screen.getByTestId('first-voice'));
    });
    expect(screen.getByTestId('first-voice').getAttribute('aria-pressed')).toBe('true');

    // Live PCM samples reach ComposerRecordingBars while listening.
    expect(mocks.onSamples).not.toBeNull();
    const loudPcm = new Int16Array(640).fill(12000).buffer;
    act(() => {
      mocks.onSamples?.(loudPcm);
    });

    // Second field cannot hijack recording while first owns it.
    await act(async () => {
      fireEvent.click(screen.getByTestId('second-voice'));
    });
    expect(screen.getByTestId('second-voice').getAttribute('aria-pressed')).toBe('false');
    expect(voiceApi.start).toHaveBeenCalledTimes(1);

    // Submitting while recording awaits stop() and receives the refined text.
    await act(async () => {
      fireEvent.click(screen.getByText('submit-first'));
    });
    expect(onSubmittedA).toHaveBeenCalledWith('Hello world.');
    expect((screen.getByRole('textbox', { name: 'first' }) as HTMLTextAreaElement).value).toBe('Hello world.');

    // Once first is idle, second field can claim voice ownership.
    await act(async () => {
      fireEvent.click(screen.getByTestId('second-voice'));
    });
    expect(screen.getByTestId('second-voice').getAttribute('aria-pressed')).toBe('true');
    expect(voiceApi.start).toHaveBeenCalledTimes(2);
  });

  it('cancels active dictation on Escape inside a Radix AlertDialog without dismissing the dialog', async () => {
    function DialogHarness() {
      const [open, setOpen] = useState(true);
      const [value, setValue] = useState('');
      const textareaRef = useRef<HTMLTextAreaElement | null>(null);
      const voice = useFieldVoiceInput({
        draftKey: `dialog:${open}`,
        inputRef: textareaRef,
        value,
        onChange: (next) => setValue(next),
        active: open,
      });
      return (
        <Tooltip.Provider>
          <AlertDialog.Root open={open} onOpenChange={setOpen}>
            <AlertDialog.Portal>
              <AlertDialog.Content
                onEscapeKeyDown={(event) => {
                  if (voice.isBusy) event.preventDefault();
                }}
              >
                <AlertDialog.Title>Goal</AlertDialog.Title>
                <AlertDialog.Description>Describe goal</AlertDialog.Description>
                <textarea
                  ref={textareaRef}
                  aria-label="goal-input"
                  value={voice.displayText}
                  readOnly={voice.isBusy}
                  onChange={(e) => setValue(e.target.value)}
                />
                <VoiceInputButton {...voice.buttonProps} testId="dialog-voice" />
              </AlertDialog.Content>
            </AlertDialog.Portal>
          </AlertDialog.Root>
          <output data-testid="dialog-open">{String(open)}</output>
        </Tooltip.Provider>
      );
    }

    render(<DialogHarness />);
    expect(screen.getByTestId('dialog-open').textContent).toBe('true');

    await act(async () => {
      fireEvent.click(screen.getByTestId('dialog-voice'));
    });
    expect(screen.getByTestId('dialog-voice').getAttribute('aria-pressed')).toBe('true');

    // First Escape cancels dictation and keeps the dialog open.
    await act(async () => {
      fireEvent.keyDown(screen.getByRole('textbox', { name: 'goal-input' }), { key: 'Escape' });
    });
    expect(voiceApi.cancel).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('dialog-open').textContent).toBe('true');
    expect(screen.getByTestId('dialog-voice').getAttribute('aria-pressed')).toBe('false');
  });

  it('lets PlanActionCard start dictation from its collapsed row, cancel on Escape, and submit finalized text on Enter', async () => {
    const onRespond = vi.fn();
    render(
      <Tooltip.Provider>
        <PlanActionCard requestId="req-plan-1" onRespond={onRespond} />
      </Tooltip.Provider>,
    );

    await act(async () => {
      fireEvent.click(screen.getByTestId('plan-feedback-voice'));
    });
    const input = screen.getByRole('textbox') as HTMLTextAreaElement;
    expect(screen.getByTestId('plan-feedback-voice').getAttribute('aria-pressed')).toBe('true');

    // Escape cancels dictation without collapsing the feedback editor.
    await act(async () => {
      fireEvent.keyDown(input, { key: 'Escape' });
    });
    expect(voiceApi.cancel).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('textbox')).toBeTruthy();

    // Start again and press Enter while recording -> stops dictation and submits finalized text.
    await act(async () => {
      fireEvent.click(screen.getByTestId('plan-feedback-voice'));
    });
    expect(screen.getByTestId('plan-feedback-voice').getAttribute('aria-pressed')).toBe('true');
    await act(async () => {
      fireEvent.keyDown(input, { key: 'Enter' });
    });
    expect(onRespond).toHaveBeenCalledWith('req-plan-1', false, 'Hello world.');
  });

  it('aborts submit-while-recording when stop() fails instead of sending stale pre-existing text', async () => {
    voiceApi.stop.mockResolvedValueOnce({ ok: false, error: 'transcription failed' });
    const onSubmitted = vi.fn();
    render(
      <Tooltip.Provider>
        <FieldHarness id="fail-stop" initialValue="stale draft" onSubmitted={onSubmitted} />
      </Tooltip.Provider>,
    );

    await act(async () => {
      fireEvent.click(screen.getByTestId('fail-stop-voice'));
    });
    expect(screen.getByTestId('fail-stop-voice').getAttribute('aria-pressed')).toBe('true');

    await act(async () => {
      fireEvent.click(screen.getByText('submit-fail-stop'));
    });
    expect(onSubmitted).not.toHaveBeenCalled();
  });

  it('aborts submit-while-recording when draftKey switches mid-refinement so the new draft is never sent to the old target', async () => {
    let releaseStop: (() => void) | null = null;
    voiceApi.stop.mockImplementationOnce(
      () =>
        new Promise<{ ok: true }>((resolve) => {
          releaseStop = () => {
            emit({ type: 'state', runId: 'run-1', state: 'done' });
            resolve({ ok: true });
          };
        }),
    );

    const onSubmitted = vi.fn();
    function SwitchableDraftHarness() {
      const [activeId, setActiveId] = useState<'A' | 'B'>('A');
      const [drafts, setDrafts] = useState<Record<'A' | 'B', string>>({ A: 'draft A', B: 'draft B' });
      const textareaRef = useRef<HTMLTextAreaElement | null>(null);
      const voice = useFieldVoiceInput({
        draftKey: `subagent:${activeId}`,
        inputRef: textareaRef,
        value: drafts[activeId],
        onChange: (next) => setDrafts((prev) => ({ ...prev, [activeId]: next })),
      });
      return (
        <div>
          <textarea
            ref={textareaRef}
            aria-label="switchable"
            value={voice.displayText}
            readOnly={voice.isBusy}
            onChange={(e) => setDrafts((prev) => ({ ...prev, [activeId]: e.target.value }))}
          />
          <VoiceInputButton {...voice.buttonProps} testId="switch-voice" />
          <button
            type="button"
            onClick={() => {
              const targetId = activeId;
              void (async () => {
                const text = voice.isBusy ? await voice.stop() : drafts[targetId];
                if (text === null) return;
                onSubmitted(targetId, text);
              })();
            }}
          >
            submit-active
          </button>
          <button type="button" onClick={() => setActiveId('B')}>
            switch-to-B
          </button>
        </div>
      );
    }

    render(
      <Tooltip.Provider>
        <SwitchableDraftHarness />
      </Tooltip.Provider>,
    );

    await act(async () => {
      fireEvent.click(screen.getByTestId('switch-voice'));
    });
    expect(screen.getByTestId('switch-voice').getAttribute('aria-pressed')).toBe('true');

    // Click submit for A so stop() reaches IPC and blocks awaiting refinement,
    // then switch to B before stop resolves.
    await act(async () => {
      fireEvent.click(screen.getByText('submit-active'));
    });
    expect(voiceApi.stop).toHaveBeenCalledTimes(1);
    await act(async () => {
      fireEvent.click(screen.getByText('switch-to-B'));
    });
    await act(async () => {
      releaseStop?.();
    });
    expect(onSubmitted).not.toHaveBeenCalled();
  });

  it('keeps the PlanActionCard voice button mounted across collapse-to-expand so hold-to-speak stops on release', async () => {
    const onRespond = vi.fn();
    render(
      <Tooltip.Provider>
        <PlanActionCard requestId="req-plan-hold" onRespond={onRespond} />
      </Tooltip.Provider>,
    );

    const buttonBefore = screen.getByTestId('plan-feedback-voice');
    await act(async () => {
      fireEvent.pointerDown(buttonBefore, { button: 0, pointerId: 1, clientX: 10, clientY: 10 });
    });
    // Expanded editor mounted while preserving the exact same VoiceInputButton node.
    expect(screen.getByRole('textbox')).toBeTruthy();
    expect(screen.getByTestId('plan-feedback-voice')).toBe(buttonBefore);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    // Release away from SendButton (jsdom default rect is 0,0,0,0 with 10px hit padding): stops without sending.
    await act(async () => {
      fireEvent.pointerUp(buttonBefore, { button: 0, pointerId: 1, clientX: 100, clientY: 100 });
    });
    expect(voiceApi.stop).toHaveBeenCalledTimes(1);
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('Hello world.');
    expect(onRespond).not.toHaveBeenCalled();
  });

  it('preserves active dictation when inputElementKey remounts the textarea for the same logical draft', async () => {
    function ExpandableHarness() {
      const [expanded, setExpanded] = useState(false);
      const [text, setText] = useState('');
      const textareaRef = useRef<HTMLTextAreaElement | null>(null);
      const voice = useFieldVoiceInput({
        draftKey: 'same-prompt',
        inputElementKey: expanded,
        inputRef: textareaRef,
        value: text,
        onChange: (next) => setText(next),
      });
      return (
        <div>
          {expanded ? (
            <textarea
              key="expanded"
              ref={textareaRef}
              aria-label="expanded-prompt"
              value={voice.displayText}
              readOnly={voice.isBusy}
              onChange={(e) => setText(e.target.value)}
            />
          ) : (
            <textarea
              key="compact"
              ref={textareaRef}
              aria-label="compact-prompt"
              value={voice.displayText}
              readOnly={voice.isBusy}
              onChange={(e) => setText(e.target.value)}
            />
          )}
          <button type="button" onClick={() => setExpanded((prev) => !prev)}>
            toggle-expand
          </button>
          <VoiceInputButton {...voice.buttonProps} testId="expandable-voice" />
        </div>
      );
    }

    render(
      <Tooltip.Provider>
        <ExpandableHarness />
      </Tooltip.Provider>,
    );

    await act(async () => {
      fireEvent.click(screen.getByTestId('expandable-voice'));
    });
    expect(screen.getByTestId('expandable-voice').getAttribute('aria-pressed')).toBe('true');

    // Expanding swaps the textarea DOM node without cancelling dictation.
    await act(async () => {
      fireEvent.click(screen.getByText('toggle-expand'));
    });
    expect(voiceApi.cancel).not.toHaveBeenCalled();
    expect(screen.getByTestId('expandable-voice').getAttribute('aria-pressed')).toBe('true');

    await act(async () => {
      fireEvent.click(screen.getByTestId('expandable-voice'));
    });
    expect((screen.getByRole('textbox', { name: 'expanded-prompt' }) as HTMLTextAreaElement).value).toBe(
      'Hello world.',
    );
  });

  it('tracks post-dictation manual corrections in controlled textareas for dictionary learning', async () => {
    mocks.adviseDictionaryLearning.mockClear();
    render(
      <Tooltip.Provider>
        <FieldHarness id="dict-learn" initialValue="前文：" />
      </Tooltip.Provider>,
    );

    const textarea = screen.getByRole('textbox', { name: 'dict-learn' }) as HTMLTextAreaElement;
    textarea.setSelectionRange(3, 3);

    await act(async () => {
      fireEvent.click(screen.getByTestId('dict-learn-voice'));
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('dict-learn-voice'));
    });
    expect(textarea.value).toBe('前文：Hello world.');

    // User fixes a misrecognized word inside the voice-inserted range.
    await act(async () => {
      fireEvent.change(textarea, { target: { value: '前文：Hello Notion.' } });
    });
    expect(mocks.adviseDictionaryLearning).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(VOICE_INPUT_DICTIONARY_LEARNING_TRACK_TIMEOUT_MS + 100);
    });
    expect(mocks.adviseDictionaryLearning).toHaveBeenCalledTimes(1);
    expect(mocks.adviseDictionaryLearning).toHaveBeenCalledWith(expect.objectContaining({
      source: 'in_app',
      rawTranscriptText: 'hello world',
      beforeText: 'Hello world.',
      afterText: 'Hello Notion.',
      context: expect.objectContaining({
        selectionBefore: '前文：',
        selectionAfter: '',
      }),
    }));
  });

  it('clears pending dictionary learning on undo, flushes on submit-clear, and drops on owner switch', async () => {
    mocks.adviseDictionaryLearning.mockClear();
    const { rerender, unmount } = render(
      <Tooltip.Provider>
        <FieldHarness id="dict-undo" />
      </Tooltip.Provider>,
    );

    const textarea = screen.getByRole('textbox', { name: 'dict-undo' }) as HTMLTextAreaElement;
    await act(async () => {
      fireEvent.click(screen.getByTestId('dict-undo-voice'));
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('dict-undo-voice'));
    });
    expect(textarea.value).toBe('Hello world.');

    // Edit then undo back to baseline -> must not publish on timeout or clear.
    await act(async () => {
      fireEvent.change(textarea, { target: { value: 'Hello Notion.' } });
    });
    await act(async () => {
      fireEvent.change(textarea, { target: { value: 'Hello world.' } });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(VOICE_INPUT_DICTIONARY_LEARNING_TRACK_TIMEOUT_MS + 100);
    });
    expect(mocks.adviseDictionaryLearning).not.toHaveBeenCalled();

    // Edit again after a fresh utterance and clear input (as when submitting a form) -> flushes immediately.
    await act(async () => {
      fireEvent.change(textarea, { target: { value: '' } });
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('dict-undo-voice'));
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('dict-undo-voice'));
    });
    expect(textarea.value).toBe('Hello world.');
    await act(async () => {
      fireEvent.change(textarea, { target: { value: 'Hello PostgreSQL.' } });
    });
    await act(async () => {
      fireEvent.change(textarea, { target: { value: '' } });
    });
    expect(mocks.adviseDictionaryLearning).toHaveBeenCalledTimes(1);
    expect(mocks.adviseDictionaryLearning).toHaveBeenCalledWith(expect.objectContaining({
      beforeText: 'Hello world.',
      afterText: 'Hello PostgreSQL.',
    }));

    // Owner switch before timeout must discard pending evidence without leaking across accounts.
    mocks.adviseDictionaryLearning.mockClear();
    await act(async () => {
      fireEvent.click(screen.getByTestId('dict-undo-voice'));
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('dict-undo-voice'));
    });
    await act(async () => {
      fireEvent.change(textarea, { target: { value: 'Hello Cindy.' } });
    });
    mocks.owner.generation += 1;
    rerender(
      <Tooltip.Provider>
        <FieldHarness id="dict-undo" />
      </Tooltip.Provider>,
    );
    unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(VOICE_INPUT_DICTIONARY_LEARNING_TRACK_TIMEOUT_MS + 100);
    });
    expect(mocks.adviseDictionaryLearning).not.toHaveBeenCalled();
  });

  it('retains failed voiced audio and replays it via one-click retry without reopening the mic', async () => {
    voiceApi.stop.mockImplementationOnce(async () => {
      emit({ type: 'error', runId: 'run-1', message: 'ASR timeout' });
      emit({ type: 'state', runId: 'run-1', state: 'error' });
      return { ok: false, error: 'ASR timeout' };
    });

    render(
      <Tooltip.Provider>
        <FieldHarness id="retry-field" />
      </Tooltip.Provider>,
    );

    await act(async () => {
      fireEvent.click(screen.getByTestId('retry-field-voice'));
    });
    expect(mocks.captureStarts).toBe(1);

    await act(async () => {
      fireEvent.click(screen.getByTestId('retry-field-voice'));
    });
    expect(screen.getByText('ASR timeout')).toBeTruthy();
    const retryButton = screen.getByRole('button', { name: 'voiceInputOverlay.retryRecognition' });
    expect(retryButton).toBeTruthy();

    await act(async () => {
      fireEvent.click(retryButton);
    });
    expect(mocks.captureStarts).toBe(1);
    expect(voiceApi.start).toHaveBeenCalledTimes(2);
    expect(voiceApi.appendAudio).toHaveBeenCalled();
    expect(voiceApi.drainAudioQueue).toHaveBeenCalled();
    expect((screen.getByRole('textbox', { name: 'retry-field' }) as HTMLTextAreaElement).value).toBe('Hello world.');
    expect(screen.queryByRole('button', { name: 'voiceInputOverlay.retryRecognition' })).toBeNull();
  });

  it('does not retain failed audio on silent takes or explicit cancel', async () => {
    mocks.captureVoiced = false;
    voiceApi.start.mockResolvedValueOnce({ ok: false, error: 'connect failed' });

    render(
      <Tooltip.Provider>
        <FieldHarness id="silent-field" />
      </Tooltip.Provider>,
    );

    await act(async () => {
      fireEvent.click(screen.getByTestId('silent-field-voice'));
    });
    expect(screen.getByText('connect failed')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'voiceInputOverlay.retryRecognition' })).toBeNull();

    // Explicit cancel on a voiced recording must not leave retry audio behind.
    mocks.captureVoiced = true;
    await act(async () => {
      fireEvent.click(screen.getByTestId('silent-field-voice'));
    });
    await act(async () => {
      fireEvent.keyDown(window, { key: 'Escape' });
    });
    expect(screen.queryByRole('button', { name: 'voiceInputOverlay.retryRecognition' })).toBeNull();
  });
});
