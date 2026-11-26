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
  adviseAndRecordVoiceInputDictionaryLearning: vi.fn(),
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
  }) => {
    mocks.onSamples = input.onSamples ?? null;
    input.onCaptureReady?.();
    input.onSoundDetected();
    return { ok: true, drainPendingChunks: () => {} };
  },
}));
vi.mock('@/contexts/dataOwnerGeneration', () => ({
  getDataOwnerGeneration: () => ({ ...mocks.owner }),
  isDataOwnerGenerationCurrent: (owner: typeof mocks.owner) => owner.generation === mocks.owner.generation,
}));
vi.mock('@/lib/logger', () => ({ createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn() }) }));

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
  drainAudioQueue: vi.fn().mockResolvedValue(undefined),
  muteSystemAudio: vi.fn().mockResolvedValue({ ok: true }),
  restoreSystemAudio: vi.fn().mockResolvedValue({ ok: true }),
};

const segment = { id: 'seg-1', source: 'mic' as const, status: 'submitted' as const, text: 'hello world', updatedAt: 1 };

function FieldHarness({
  id,
  draftKey = id,
  onSubmitted,
}: {
  id: string;
  draftKey?: string;
  onSubmitted?: (text: string) => void;
}) {
  const [text, setText] = useState('');
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
      <FieldVoiceInputNotice error={voice.lastError} speakerFiltered={voice.speakerFiltered} />
      <button
        type="button"
        onClick={() => {
          void (async () => {
            const finalText = voice.isBusy ? await voice.stop() : text;
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
  events.clear();
  shortcuts.clear();
  mocks.onSamples = null;
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
});
