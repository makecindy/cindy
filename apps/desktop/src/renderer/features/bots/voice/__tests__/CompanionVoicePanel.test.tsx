// @vitest-environment jsdom
import { StrictMode, useState } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import {
  type VoiceConversationModel,
  type VoiceConversationEvent,
} from '@/../shared/voiceConversation';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    i18n: { language: 'en', resolvedLanguage: 'en' },
    t: (key: string, options?: { seconds?: number }) =>
      options?.seconds ? `${key}:${options.seconds}` : key,
  }),
}));
const log = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn() }));
vi.mock('@/lib/logger', () => ({ createLogger: () => log }));
vi.mock('@/hooks/useVoiceInputSettings', () => ({
  getVoiceInputSettings: () => ({ microphoneDeviceId: null }),
}));
vi.mock('../../BotAvatar', () => ({ BotAvatar: () => <span>Avatar</span> }));
vi.mock('@/voice-input/workletUrl', () => ({ getVoiceInputWorkletUrl: () => 'worklet.js' }));
const audio = vi.hoisted(() => ({
  start: vi.fn(async () => {}),
  stop: vi.fn(async () => {}),
  onPcm16k: vi.fn(),
  close: vi.fn(),
}));
vi.mock('@/voice-input/WebMicAudioEngine', () => ({
  WebMicAudioEngine: class {
    start = audio.start;
    stop = audio.stop;
    onPcm16k = audio.onPcm16k;
  },
}));
vi.mock('../PcmSpeechPlayer', () => ({
  PcmSpeechPlayer: class {
    close = audio.close;
    pause() {}
    resume() {}
    cancel() {}
    async play() {}
  },
}));

import { CompanionVoicePanel } from '../CompanionVoicePanel';
import { visibleVoiceCallMessages, VoiceCallCard, VoiceCallTranscript } from '../VoiceCallTranscript';
import { collectBotMessageTimeGroups } from '../../botConversationTimeline';
import type { VoiceCallRecord } from '@/../shared/voiceConversation';
import type { ChatMessage } from '@/lib/makerChatStore';
import type { VoiceTaskFailure } from '../VoiceReplyTracker';
let models: VoiceConversationModel[];
let inputEvent: (event: VoiceConversationEvent) => void;
const start = vi.fn(async () => ({ callId: 'call' }));
const refresh = vi.fn(async () => undefined);
beforeEach(() => {
  vi.clearAllMocks();
  models = [];
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      voiceConversation: {
        models: async () => models,
        voices: vi.fn(async () => ({ source: 'manual', voices: [] })),
        preview: vi.fn(async () => ({ sampleRate: 24000 })),
        readPreview: vi.fn(async () => ({ pcm: new ArrayBuffer(2), done: true })),
        stopPreview: vi.fn(async () => {}),
        preference: vi.fn(async () => ({ selection: null, customized: false })),
        setPreference: vi.fn(async (_botId, selection) => ({ selection, customized: !!selection })),
        start,
        classifyExit: vi.fn(async () => false),
        setInputMuted: vi.fn(async () => ({ inputGeneration: 2 })),
        finishUtterance: vi.fn(async () => {}),
        end: vi.fn(async () => {}),
        interrupt: vi.fn(async () => {}),
        onEvent: (callback: typeof inputEvent) => {
          inputEvent = callback;
          return () => {
            inputEvent = () => {};
          };
        },
      },
      maker: { refreshBuiltinProviderModels: refresh },
      voiceInput: { updateSettings: vi.fn(async () => ({})), onPowerStateChange: () => () => {} },
      onAuthStateChange: () => () => {},
    },
  });
});
afterEach(cleanup);
afterEach(() => vi.useRealTimers());
const configure = vi.fn();
const close = vi.fn();
const panel = (blocked = false, taskBusy = false, open = true, taskFailure?: VoiceTaskFailure) => (
  <CompanionVoicePanel
    open={open}
    bot={{ id: 'bot', name: 'Partner' }}
    sessionId="canonical"
    messages={[]}
    blocked={blocked}
    taskBusy={taskBusy}
    taskFailure={taskFailure}
    onSend={vi.fn(async (_text, created) => {
      created('input');
      return true;
    })}
    onClose={close}
    onConfigure={configure}
  />
);

// #5718 review: real panel/controller wiring must observe a terminal failure
// even without a final assistant message. Earlier cases only used busy/idle.
// Unit/jsdom, fake audio/IPC: accepted input -> matching error -> listening.
// Standalone file validation: 1.39s wall time.
it('passes terminal input failure to the live call without stopping capture', async () => {
  vi.useFakeTimers();
  models = [{ id: 'tts', name: 'Speech', defaultVoice: 'alloy' }];
  const view = render(panel());
  await act(async () => {});
  await act(async () => {
    inputEvent({ callId: 'call', event: { type: 'utterance', id: 'utterance', text: 'Hello' } });
  });
  expect(screen.getByRole('status').textContent).toBe('bots.voiceMode.status.thinking');
  view.rerender(panel(false, false, true, { clientId: 'input', reason: 'error' }));
  expect(screen.getByRole('status').textContent).toBe('bots.voiceMode.status.listening');
  expect(audio.stop).not.toHaveBeenCalled();
  expect(window.electronAPI.voiceConversation.end).not.toHaveBeenCalled();
  await act(() => vi.advanceTimersByTimeAsync(60_000));
  expect(screen.getByRole('timer')).toBeTruthy();
});

// Exit animation retains the real panel briefly. The old unmount-only cleanup
// would keep recording/playing until that animation ended. Existing cases only
// unmount immediately; these unit cases close a still-mounted panel and reopen
// it, or resolve an old configuration load during exit. Audio/API boundaries are
// faked; the production panel and controller own all lifecycle transitions.
it('releases voice immediately during exit and can reopen before the visual unmount', async () => {
  vi.useFakeTimers();
  models = [{ id: 'tts', name: 'Speech', defaultVoice: 'alloy' }];
  const view = render(panel(false, false, false));
  await act(async () => {});
  expect(start).not.toHaveBeenCalled();
  view.rerender(panel());
  await act(async () => {});
  expect(audio.start).toHaveBeenCalledOnce();
  // A portal is outside the fading/inert call wrapper. Closing must dismiss it
  // immediately, and reopening must not resurrect the previous transcript.
  fireEvent.click(screen.getByRole('button', { name: 'bots.voiceMode.showDetails' }));
  expect(screen.getByRole('dialog')).toBeTruthy();
  view.rerender(panel(false, false, false));
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(audio.stop).toHaveBeenCalledOnce();
  expect(audio.close).toHaveBeenCalledOnce();
  expect(log.info).toHaveBeenCalledWith('voice mode ended', {
    callId: 'call',
    reason: 'view_closed',
  });
  expect(window.electronAPI.voiceConversation.end).toHaveBeenCalledOnce();
  expect(screen.queryByRole('status')).toBeNull();
  // Freeze the last visible state rather than flashing idle/Resume during exit.
  expect(screen.getByRole('status', { hidden: true }).textContent).toBe(
    'bots.voiceMode.status.listening',
  );

  await act(() => vi.advanceTimersByTimeAsync(50));
  view.rerender(panel());
  await act(async () => {});
  await act(() => vi.advanceTimersByTimeAsync(250));
  expect(audio.start).toHaveBeenCalledTimes(2);
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(audio.stop).toHaveBeenCalledOnce();
  expect(screen.getByRole('status').textContent).toBe('bots.voiceMode.status.listening');
  view.rerender(panel(false, false, false));
  await act(() => vi.advanceTimersByTimeAsync(250));
  expect(screen.queryByRole('status', { hidden: true })).toBeNull();
  expect(audio.stop).toHaveBeenCalledTimes(2);
});

it('ignores late configuration while the closed toolbar is still fading out', async () => {
  let release!: (value: { selection: null; customized: boolean }) => void;
  models = [{ id: 'tts', name: 'Speech', defaultVoice: 'alloy' }];
  vi.mocked(window.electronAPI.voiceConversation.preference).mockReturnValue(
    new Promise((resolve) => {
      release = resolve;
    }),
  );
  const view = render(panel());
  view.rerender(panel(false, false, false));
  await act(async () => {
    release({ selection: null, customized: false });
  });
  expect(start).not.toHaveBeenCalled();
  expect(configure).not.toHaveBeenCalled();
});

// Contract: companion-voice-mode.md auto-exit warning. Existing panel cases only
// covered manual End. Minimal regression: 60s idle has no visible/cancellable
// warning. Unit/jsdom; real controller, fake timers and audio/API boundaries.
// Standalone vitest run: 1.64s wall time, including the toolbar disclosure cases.
it('shows a quiet countdown, lets the user keep the call, then closes through the host callback', async () => {
  vi.useFakeTimers();
  models = [{ id: 'tts', name: 'Speech', defaultVoice: 'alloy' }];
  render(panel());
  await act(async () => {});
  await act(() => vi.advanceTimersByTimeAsync(60_000));
  expect(screen.getByRole('status').textContent).toBe('bots.voiceMode.exit.idle');
  expect(screen.getByRole('timer').textContent).toBe('bots.voiceMode.exit.countdown:10');
  expect(screen.getByRole('timer').getAttribute('aria-live')).toBe('off');
  fireEvent.click(screen.getByRole('button', { name: 'bots.voiceMode.exit.cancel' }));
  expect(screen.queryByRole('timer')).toBeNull();
  expect(document.activeElement).toBe(
    screen.getByRole('heading', { name: 'bots.voiceMode.title' }),
  );
  expect(close).not.toHaveBeenCalled();
  await act(() => vi.advanceTimersByTimeAsync(70_000));
  expect(window.electronAPI.voiceConversation.end).toHaveBeenCalledWith('call');
  expect(audio.stop).toHaveBeenCalledOnce();
  expect(close).toHaveBeenCalledOnce();
  expect(screen.queryByRole('timer')).toBeNull();
});

it('keeps task activity authoritative, but allows an intentional farewell without stopping the task', async () => {
  vi.useFakeTimers();
  models = [{ id: 'tts', name: 'Speech', defaultVoice: 'alloy' }];
  const view = render(panel(false, true));
  await act(async () => {});
  await act(() => vi.advanceTimersByTimeAsync(120_000));
  expect(screen.queryByRole('timer')).toBeNull();
  view.rerender(panel(false, false));
  await act(() => vi.advanceTimersByTimeAsync(60_000));
  expect(screen.getByRole('timer')).toBeTruthy();
  view.rerender(panel(false, true));
  expect(screen.queryByRole('timer')).toBeNull();
  act(() => inputEvent({ callId: 'call', event: { type: 'utterance', id: 'bye', text: '再见' } }));
  expect(screen.getByRole('status').textContent).toBe('bots.voiceMode.exit.farewell');
  expect(screen.getByRole('timer').textContent).toBe('bots.voiceMode.exit.countdown:3');
  await act(() => vi.advanceTimersByTimeAsync(3_000));
  expect(close).toHaveBeenCalledOnce();
  expect(window.electronAPI.voiceConversation.end).toHaveBeenCalledOnce();
});

it('shows the same cancellable three-second control for a semantic exit', async () => {
  vi.useFakeTimers();
  models = [{ id: 'tts', name: 'Speech', defaultVoice: 'alloy' }];
  vi.mocked(window.electronAPI.voiceConversation.classifyExit).mockResolvedValue(true);
  render(panel());
  await act(async () => {});
  await act(async () =>
    inputEvent({
      callId: 'call',
      event: { type: 'utterance', id: 'natural-exit', text: '今天先聊到这里吧' },
    }),
  );
  expect(screen.getByRole('status').textContent).toBe('bots.voiceMode.exit.semantic');
  expect(screen.getByRole('timer').textContent).toBe('bots.voiceMode.exit.countdown:3');
  fireEvent.click(screen.getByRole('button', { name: 'bots.voiceMode.exit.cancel' }));
  await act(() => vi.advanceTimersByTimeAsync(3_000));
  expect(close).not.toHaveBeenCalled();
  expect(screen.queryByRole('timer')).toBeNull();
});

// Real panel/controller with a deferred send: waiting must remain cancellable,
// must not advertise a zero-second timer, and cannot close before acceptance.
it('shows sending-before-exit until accepted, then closes immediately without a countdown', async () => {
  vi.useFakeTimers();
  models = [{ id: 'tts', name: 'Speech', defaultVoice: 'alloy' }];
  vi.mocked(window.electronAPI.voiceConversation.classifyExit).mockResolvedValue(
    'submit_then_exit',
  );
  let accept!: () => void;
  const onSend = vi.fn(
    async (_text: string, created: (id: string) => void, current: () => boolean) => {
      await new Promise<void>((done) => {
        accept = done;
      });
      expect(current()).toBe(true);
      created('input');
      return true;
    },
  );
  render(<CompanionVoicePanel {...panel().props} onSend={onSend} />);
  await act(async () => {});
  await act(async () =>
    inputEvent({
      callId: 'call',
      event: { type: 'utterance', id: 'compound', text: '帮我查资料，然后退出语音模式' },
    }),
  );
  expect(screen.getByRole('status').textContent).toBe('bots.voiceMode.exit.sending');
  expect(screen.queryByRole('timer')).toBeNull();
  expect(screen.getByRole('button', { name: 'bots.voiceMode.exit.cancel' })).toBeTruthy();
  await act(() => vi.advanceTimersByTimeAsync(10_000));
  expect(close).not.toHaveBeenCalled();
  await act(async () => accept());
  expect(onSend).toHaveBeenCalledOnce();
  expect(onSend.mock.calls[0]![0]).toBe('帮我查资料，然后退出语音模式');
  expect(close).toHaveBeenCalledOnce();
  expect(window.electronAPI.voiceConversation.end).toHaveBeenCalledOnce();
  expect(screen.queryByRole('timer')).toBeNull();
});

// Acceptance coverage through the real panel + controller: the controller's
// state tests alone cannot detect a missing full-text recovery view, a broken
// Retry button, or a Cancel button wired to closing the panel. Inject only the
// send boundary (false/throw/deferred acknowledgement), with no live account.
// Contract: companion-voice-mode.md, original-text retention and cancellable
// submit-then-exit. Unit/jsdom with fake time.
it.each(['rejected', 'throw'] as const)(
  'shows the complete original after send %s and retries it once without reviving exit',
  async (failure) => {
    vi.useFakeTimers();
    models = [{ id: 'tts', name: 'Speech', defaultVoice: 'alloy' }];
    vi.mocked(window.electronAPI.voiceConversation.classifyExit).mockResolvedValue(
      'submit_then_exit',
    );
    const text = '请在后台整理一份三条的周末读书计划，收到这条请求就退出语音模式，不用等你完成。';
    let fail!: () => void;
    const accepted: string[] = [];
    const onSend = vi.fn(
      async (original: string, created: (id: string) => void, current: () => boolean) => {
        expect(current()).toBe(true);
        accepted.push(original);
        created('accepted-input');
        return true;
      },
    );
    onSend.mockImplementationOnce(async () => {
      await new Promise<void>((done) => {
        fail = done;
      });
      if (failure === 'throw') throw new Error('injected send failure');
      return false;
    });
    render(<CompanionVoicePanel {...panel().props} onSend={onSend} />);
    await act(async () => {});
    await act(async () =>
      inputEvent({ callId: 'call', event: { type: 'utterance', id: 'compound', text } }),
    );
    expect(screen.getByRole('status').textContent).toBe('bots.voiceMode.exit.sending');
    await act(async () => fail());
    await act(() => vi.advanceTimersByTimeAsync(5_000));
    fireEvent.click(screen.getByRole('button', { name: 'bots.voiceMode.showDetails' }));
    expect(screen.getByText(text)).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toBe('bots.voiceMode.errors.send');
    expect(screen.queryByRole('button', { name: 'bots.voiceMode.exit.cancel' })).toBeNull();
    expect(screen.queryByRole('timer')).toBeNull();
    expect(close).not.toHaveBeenCalled();
    expect(accepted).toEqual([]);
    expect(onSend).toHaveBeenCalledOnce();

    await act(async () =>
      fireEvent.click(screen.getByRole('button', { name: 'bots.voiceMode.retrySend' })),
    );
    await act(() => vi.advanceTimersByTimeAsync(5_000));
    expect(onSend.mock.calls.map(([original]) => original)).toEqual([text, text]);
    expect(accepted).toEqual([text]);
    expect(screen.queryByText(text)).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('timer')).toBeNull();
    expect(close).not.toHaveBeenCalled();
    expect(window.electronAPI.voiceConversation.classifyExit).toHaveBeenCalledOnce();
  },
);

it('cancels through the waiting-for-send button and keeps the accepted work without closing', async () => {
  vi.useFakeTimers();
  models = [{ id: 'tts', name: 'Speech', defaultVoice: 'alloy' }];
  vi.mocked(window.electronAPI.voiceConversation.classifyExit).mockResolvedValue(
    'submit_then_exit',
  );
  const text = '帮我用三条列出整理桌面的步骤，然后退出语音模式。';
  let accept!: () => void;
  const accepted: string[] = [];
  const onSend = vi.fn(
    async (original: string, created: (id: string) => void, current: () => boolean) => {
      await new Promise<void>((done) => {
        accept = done;
      });
      expect(current()).toBe(true);
      accepted.push(original);
      created('accepted-input');
      return true;
    },
  );
  render(<CompanionVoicePanel {...panel().props} onSend={onSend} />);
  await act(async () => {});
  await act(async () =>
    inputEvent({ callId: 'call', event: { type: 'utterance', id: 'compound', text } }),
  );
  expect(screen.getByRole('status').textContent).toBe('bots.voiceMode.exit.sending');
  fireEvent.click(screen.getByRole('button', { name: 'bots.voiceMode.exit.cancel' }));
  expect(screen.queryByRole('button', { name: 'bots.voiceMode.exit.cancel' })).toBeNull();
  expect(screen.queryByRole('timer')).toBeNull();
  expect(close).not.toHaveBeenCalled();
  await act(async () => accept());
  await act(() => vi.advanceTimersByTimeAsync(5_000));
  expect(accepted).toEqual([text]);
  expect(onSend).toHaveBeenCalledOnce();
  expect(screen.queryByText(text)).toBeNull();
  expect(screen.queryByRole('timer')).toBeNull();
  expect(close).not.toHaveBeenCalled();
  expect(audio.stop).not.toHaveBeenCalled();
  expect(window.electronAPI.voiceConversation.end).not.toHaveBeenCalled();
});

it('starts the saved route directly and releases capture when the panel unmounts', async () => {
  models = [
    {
      id: 'speech',
      name: 'Speech',
      providerId: 'mine',
      agent: 'codex',
      protocol: 'elevenlabs',
      protocolLocked: true,
    },
  ];
  vi.mocked(window.electronAPI.voiceConversation.preference).mockResolvedValue({
    selection: { providerId: 'mine', agent: 'codex', modelId: 'speech', voice: 'saved-voice' },
    customized: true,
  });
  const view = render(panel());
  await waitFor(() => expect(audio.start).toHaveBeenCalledOnce());
  expect(start).toHaveBeenCalledWith({
    callId: expect.any(String),
    botId: 'bot',
    sessionId: 'canonical',
    providerId: 'mine',
    agent: 'codex',
    modelId: 'speech',
    voice: 'saved-voice',
  });
  expect(screen.getByRole('status').textContent).toBe('bots.voiceMode.status.listening');
  expect(screen.queryByLabelText('bots.voiceMode.model')).toBeNull();
  expect(screen.queryByRole('button', { name: 'bots.voiceMode.preview' })).toBeNull();
  expect(window.electronAPI.voiceConversation.setPreference).not.toHaveBeenCalled();
  view.unmount();
  expect(audio.stop).toHaveBeenCalledOnce();
  expect(audio.close).toHaveBeenCalledOnce();
  expect(log.info).toHaveBeenCalledWith('voice mode ended', {
    callId: 'call',
    reason: 'view_cleanup',
  });
});

it.each(['empty', 'missing-model', 'missing-voice', 'unknown-api', 'mismatched-api'])(
  'opens settings for %s without starting ASR or changing preferences',
  async (reason) => {
    models =
      reason === 'empty'
        ? []
        : [
            {
              id: 'speech',
              name: 'Speech',
              providerId: 'mine',
              agent: 'codex',
              ...(reason === 'unknown-api' ? {} : { protocol: 'elevenlabs', protocolLocked: true }),
            },
          ];
    vi.mocked(window.electronAPI.voiceConversation.preference).mockResolvedValue({
      selection: {
        providerId: 'mine',
        agent: 'codex',
        modelId: reason === 'missing-model' ? 'removed' : 'speech',
        voice: reason === 'missing-voice' ? '' : 'saved-voice',
        ...(reason === 'mismatched-api' ? { protocol: 'openai' } : {}),
      },
      customized: true,
    });
    render(panel());
    await waitFor(() => expect(configure).toHaveBeenCalledOnce());
    expect(start).not.toHaveBeenCalled();
    expect(audio.start).not.toHaveBeenCalled();
    expect(window.electronAPI.voiceConversation.setPreference).not.toHaveBeenCalled();
  },
);

it('starts once under StrictMode and keeps end and settings actions separate from configuration', async () => {
  models = [{ id: 'tts', name: 'Speech', defaultVoice: 'alloy' }];
  render(<StrictMode>{panel()}</StrictMode>);
  await waitFor(() => expect(audio.start).toHaveBeenCalledOnce());
  expect(start).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole('button', { name: 'bots.voiceMode.showDetails' }));
  fireEvent.click(await screen.findByRole('button', { name: 'bots.voiceMode.openSettings' }));
  expect(configure).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole('button', { name: 'bots.voiceMode.end' }));
  expect(close).toHaveBeenCalledOnce();
});

// Real panel/controller: the disclosure owns both saved turns and current ASR,
// and opening accepted work is navigation only, never another send or hangup.
it('merges the live draft into the call record and opens accepted work without ending capture', async () => {
  models = [{ id: 'tts', name: 'Speech', defaultVoice: 'alloy' }];
  const openTask = vi.fn();
  const callChanged = vi.fn();
  render(<CompanionVoicePanel {...panel().props} onOpenTask={openTask} onCallIdChange={callChanged} />);
  await waitFor(() => expect(audio.start).toHaveBeenCalledOnce());
  act(() => inputEvent({
    callId: 'call', event: { type: 'call-record', record: {
      version: 1, callId: 'call', startedAt: 1000,
      turns: [{ id: 'u1', role: 'user', text: '在后台整理计划', complete: true, createdAt: 1100 }],
      handoffs: [{ id: 'voice-task:call:u1', inputId: 'u1', text: '在后台整理计划', state: 'accepted' }],
    } },
  }));
  act(() => inputEvent({ callId: 'call', event: { type: 'draft', text: '还有一个想法' } }));
  expect(screen.queryByText('还有一个想法')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'bots.voiceMode.showDetails' }));
  expect(screen.getByText('还有一个想法').closest('[data-voice-call-transcript]')).toBeTruthy();
  expect(screen.getByText('在后台整理计划').closest('[data-voice-call-transcript]')).toBeTruthy();
  expect(screen.getAllByText('还有一个想法')).toHaveLength(1);
  fireEvent.click(await screen.findByRole('button', { name: 'bots.voiceMode.viewTaskProgress' }));
  expect(openTask).toHaveBeenCalledWith('voice-task:call:u1');
  expect(callChanged).toHaveBeenLastCalledWith('call');
  expect(screen.getByRole('button', { name: 'bots.voiceMode.showDetails' })).toBeTruthy();
  expect(audio.start).toHaveBeenCalledOnce();
  expect(window.electronAPI.voiceConversation.end).not.toHaveBeenCalled();
  expect(close).not.toHaveBeenCalled();
});

it('hides only the active call card and restores one folded record after End', async () => {
  models = [{ id: 'tts', name: 'Speech', defaultVoice: 'alloy' }];
  const record: VoiceCallRecord = {
    version: 1, callId: 'call', startedAt: 1000,
    turns: [{ id: 'u1', role: 'user', text: '你好', complete: true, createdAt: 1100 }],
    handoffs: [],
  };
  // The database record is already saved while the call is live. An earlier
  // interrupted record must remain accessible; filtering cannot erase history.
  const saved: ChatMessage[] = ['interrupted', 'call'].map(callId => ({
    clientId: `voice-call:${callId}`, role: 'assistant', content: '',
    systemCardType: 'voice-call', systemCardData: { record: { ...record, callId } },
  }));
  function WithHistory() {
    const [active, setActive] = useState<string | null>(null);
    const [open, setOpen] = useState(true);
    return <>
      <div data-testid="history">
        {visibleVoiceCallMessages(saved, active).map(message =>
          <VoiceCallCard key={message.clientId} record={message.systemCardData!.record as VoiceCallRecord} />)}
      </div>
      <CompanionVoicePanel {...panel().props} open={open} onCallIdChange={setActive} onClose={() => setOpen(false)} />
    </>;
  }
  render(<WithHistory />);
  await waitFor(() => expect(audio.start).toHaveBeenCalledOnce());
  expect(screen.getByTestId('history').querySelectorAll('[data-voice-call-card]')).toHaveLength(1);
  expect(saved).toHaveLength(2);
  fireEvent.click(screen.getByRole('button', { name: 'bots.voiceMode.end' }));
  await waitFor(() => expect(window.electronAPI.voiceConversation.end).toHaveBeenCalledWith('call'));
  const cards = screen.getByTestId('history').querySelectorAll('[data-voice-call-card]');
  expect(cards).toHaveLength(2);
  for (const card of cards) expect(card.querySelector('button')?.getAttribute('aria-expanded')).toBe('false');
  expect(audio.stop).toHaveBeenCalledOnce();
});

// Empty calls used to leave both a placeholder card and a standalone timestamp.
// Filter before the real timeline grouping while retaining the saved source rows.
it('shows the speaking prompt only in a live call and never renders a direct empty history card', () => {
  const record: VoiceCallRecord = {
    version: 1, callId: 'empty', startedAt: 1000, endedAt: 8241, turns: [], handoffs: [],
  };
  const view = render(<VoiceCallTranscript record={record} live />);
  expect(screen.getByText('bots.voiceMode.transcriptEmpty')).toBeTruthy();
  view.rerender(<VoiceCallTranscript record={record} />);
  expect(screen.queryByText('bots.voiceMode.transcriptEmpty')).toBeNull();
  view.rerender(<VoiceCallCard record={record} />);
  expect(view.container.querySelector('[data-voice-call-card]')).toBeNull();
});

it('omits empty calls and their time groups without changing saved messages', () => {
  const record: VoiceCallRecord = {
    version: 1, callId: 'empty', startedAt: 1000, endedAt: 8000, turns: [], handoffs: [],
  };
  const empty: ChatMessage = {
    clientId: 'voice-call:empty', role: 'assistant', content: '',
    createdAt: '2026-10-20T12:12:00Z',
    systemCardType: 'voice-call', systemCardData: { record },
  };
  const whitespace: ChatMessage = {
    ...empty, clientId: 'voice-call:whitespace',
    systemCardData: { record: {
      ...record, callId: 'whitespace',
      turns: [{ id: 'a1', role: 'assistant', text: ' \n\t', complete: false, createdAt: 1100 }],
    } },
  };
  const before: ChatMessage = {
    clientId: 'before', role: 'assistant', content: '前面的回复', createdAt: '2026-10-20T12:00:00Z',
  };
  const after: ChatMessage = {
    clientId: 'after', role: 'user', content: '接着聊', createdAt: '2026-10-20T12:13:00Z',
  };
  const saved = [before, empty, whitespace, after];
  const original = structuredClone(saved);
  const visible = visibleVoiceCallMessages(saved, null);
  expect(visible).toEqual([before, after]);
  expect([...collectBotMessageTimeGroups(visible).entries()]).toEqual([
    ['before', Date.parse(before.createdAt!)],
    ['after', Date.parse(after.createdAt!)],
  ]);
  expect(collectBotMessageTimeGroups(visibleVoiceCallMessages([empty], null)).size).toBe(0);
  expect(saved).toEqual(original);
});

it.each<{
  name: string;
  turns: VoiceCallRecord['turns'];
  handoffs: VoiceCallRecord['handoffs'];
}>([
  {
    name: 'user text',
    turns: [{ id: 'u1', role: 'user', text: '你好', complete: true, createdAt: 1100 }],
    handoffs: [],
  },
  {
    name: 'an interrupted assistant reply',
    turns: [{ id: 'a1', role: 'assistant', text: '还没说完', complete: false, createdAt: 1100 }],
    handoffs: [],
  },
  {
    name: 'a failed original',
    turns: [{ id: 'u1', role: 'user', text: '请保留这句话', failed: true, complete: true, createdAt: 1100 }],
    handoffs: [],
  },
  {
    name: 'a handoff without transcript turns',
    turns: [],
    handoffs: [{ id: 'task', inputId: 'u1', text: '在后台整理计划', state: 'accepted' }],
  },
])('retains a saved call containing $name', ({ turns, handoffs }) => {
  const message: ChatMessage = {
    clientId: 'voice-call:saved', role: 'assistant', content: '',
    systemCardType: 'voice-call', systemCardData: { record: {
      version: 1, callId: 'saved', startedAt: 1000, endedAt: 8000, turns, handoffs,
    } },
  };
  const visible = visibleVoiceCallMessages([message], null);
  expect(visible).toHaveLength(1);
  expect(visible[0]).toBe(message);
});

it('keeps permission cards authoritative and resumes only after another explicit action', async () => {
  models = [{ id: 'tts', name: 'Speech', defaultVoice: 'alloy' }];
  const view = render(panel(true));
  await act(async () => {});
  expect(screen.getByRole('status').textContent).toBe('bots.voiceMode.status.confirmation');
  expect(
    screen.getByRole('button', { name: 'bots.voiceMode.resume' }).hasAttribute('disabled'),
  ).toBe(true);
  // The compact toolbar has no separate close icon: End remains reachable even
  // when a permission card owns the composer and capture cannot be resumed.
  fireEvent.click(screen.getByRole('button', { name: 'bots.voiceMode.end' }));
  expect(close).toHaveBeenCalledOnce();
  view.rerender(panel());
  await act(async () => {});
  expect(start).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'bots.voiceMode.resume' }));
  await waitFor(() => expect(audio.start).toHaveBeenCalledOnce());
});

it('does not start a late configuration result after closing', async () => {
  let release!: (value: { selection: null; customized: boolean }) => void;
  models = [{ id: 'tts', name: 'Speech', defaultVoice: 'alloy' }];
  vi.mocked(window.electronAPI.voiceConversation.preference).mockReturnValue(
    new Promise((resolve) => {
      release = resolve;
    }),
  );
  const view = render(panel());
  view.unmount();
  await act(async () => {
    release({ selection: null, customized: false });
  });
  expect(start).not.toHaveBeenCalled();
  expect(configure).not.toHaveBeenCalled();
});

it('keeps a load failure visible and retries without silently switching providers', async () => {
  models = [{ id: 'tts', name: 'Speech', defaultVoice: 'alloy' }];
  vi.mocked(window.electronAPI.voiceConversation.preference).mockRejectedValueOnce(
    new Error('offline'),
  );
  render(panel());
  await screen.findByText('bots.voiceMode.preferenceError');
  expect(start).not.toHaveBeenCalled();
  expect(configure).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'bots.voiceMode.resume' }));
  await waitFor(() => expect(audio.start).toHaveBeenCalledOnce());
});

it('distinguishes ASR connection from microphone startup, with explicit microphone-only controls', async () => {
  models = [{ id: 'tts', name: 'Speech', defaultVoice: 'alloy' }];
  let connected!: (value: { callId: string }) => void;
  let capturing!: () => void;
  start.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        connected = resolve;
      }),
  );
  audio.start.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        capturing = resolve;
      }),
  );
  const view = render(panel());
  await waitFor(() => expect(start).toHaveBeenCalledOnce());
  expect(screen.getByRole('status').textContent).toBe('bots.voiceMode.status.connecting');
  expect(screen.getByRole('button', { name: 'bots.voiceMode.mute' }).hasAttribute('disabled')).toBe(
    true,
  );
  await act(async () => {
    connected({ callId: 'call' });
  });
  expect(screen.getByRole('status').textContent).toBe('bots.voiceMode.status.microphone');
  expect(
    view.container.querySelector('[data-activity="microphone"] .animate-spinner'),
  ).not.toBeNull();
  expect(view.container.querySelector('.companion-voice-meter')).toBeNull();
  await act(async () => {
    capturing();
  });
  expect(screen.getByRole('status').textContent).toBe('bots.voiceMode.status.listening');
  expect(view.container.querySelector('.companion-voice-meter')).not.toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'bots.voiceMode.mute' }));
  await waitFor(() =>
    expect(window.electronAPI.voiceConversation.setInputMuted).toHaveBeenCalledWith('call', true),
  );
  expect(screen.getByRole('status').textContent).toBe('bots.voiceMode.status.muted');
  expect(
    screen.getByRole('button', { name: 'bots.voiceMode.unmute' }).getAttribute('aria-pressed'),
  ).toBe('true');
  expect(screen.getByText('bots.voiceMode.mutedHint')).toBeTruthy();
  expect(view.container.querySelector('.companion-voice-meter')).toBeNull();
  expect(window.electronAPI.voiceConversation.end).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'bots.voiceMode.unmute' }));
  await waitFor(() => expect(audio.start).toHaveBeenCalledTimes(2));
  expect(screen.getByRole('status').textContent).toBe('bots.voiceMode.status.listening');
  expect(start).toHaveBeenCalledOnce();
});

it('keeps Send secondary and preserves the draft inside the disclosure when muted', async () => {
  models = [{ id: 'tts', name: 'Speech', defaultVoice: 'alloy' }];
  render(panel());
  await waitFor(() => expect(audio.start).toHaveBeenCalledOnce());
  act(() => inputEvent({ callId: 'call', event: { type: 'draft', text: 'unfinished thought' } }));
  fireEvent.click(screen.getByRole('button', { name: 'bots.voiceMode.send' }));
  expect(window.electronAPI.voiceConversation.finishUtterance).toHaveBeenCalledWith('call');
  fireEvent.click(screen.getByRole('button', { name: 'bots.voiceMode.mute' }));
  await waitFor(() =>
    expect(
      screen.getByRole('button', { name: 'bots.voiceMode.unmute' }).hasAttribute('disabled'),
    ).toBe(false),
  );
  expect(screen.queryByText('unfinished thought')).toBeNull();
  expect(screen.getByRole('button', { name: 'bots.voiceMode.send' })).toBeTruthy();
  expect(window.electronAPI.voiceConversation.end).not.toHaveBeenCalled();

  // Production disclosure contract: folding text must not replace the call,
  // discard the unsent draft or resume a muted microphone. Old panel coverage
  // had no disclosure. Minimal input: one draft, then mute + expand/Escape.
  // Unit/jsdom, existing real controller with only audio/API boundaries faked.
  fireEvent.click(screen.getByRole('button', { name: 'bots.voiceMode.showDetails' }));
  expect(screen.getByText('unfinished thought')).toBeTruthy();
  const disclosure = screen.getByRole('button', { name: 'bots.voiceMode.hideDetails' });
  expect(disclosure.getAttribute('aria-expanded')).toBe('true');
  fireEvent.keyDown(disclosure, { key: 'Escape' });
  // The draft has one home. Collapse keeps it only for its exit animation;
  // reopening restores it without recreating capture or changing mute.
  await waitFor(() => expect(screen.queryByText('unfinished thought')).toBeNull());
  expect(document.activeElement).toBe(
    screen.getByRole('button', { name: 'bots.voiceMode.showDetails' }),
  );
  fireEvent.click(screen.getByRole('button', { name: 'bots.voiceMode.showDetails' }));
  expect(screen.getAllByText('unfinished thought')).toHaveLength(1);
  expect(audio.start).toHaveBeenCalledOnce();
  expect(start).toHaveBeenCalledOnce();
  expect(window.electronAPI.voiceConversation.end).not.toHaveBeenCalled();
});

it('offers unmute again after capture fails without replacing the call with a full reconnect', async () => {
  models = [{ id: 'tts', name: 'Speech', defaultVoice: 'alloy' }];
  render(panel());
  await waitFor(() => expect(audio.start).toHaveBeenCalledOnce());
  fireEvent.click(screen.getByRole('button', { name: 'bots.voiceMode.mute' }));
  await waitFor(() =>
    expect(
      screen.getByRole('button', { name: 'bots.voiceMode.unmute' }).hasAttribute('disabled'),
    ).toBe(false),
  );
  audio.start.mockRejectedValueOnce(new Error('device unavailable'));
  fireEvent.click(screen.getByRole('button', { name: 'bots.voiceMode.unmute' }));
  await screen.findByText('bots.voiceMode.microphoneResumeError');
  await waitFor(() =>
    expect(
      screen.getByRole('button', { name: 'bots.voiceMode.unmute' }).hasAttribute('disabled'),
    ).toBe(false),
  );
  expect(screen.queryByRole('button', { name: 'bots.voiceMode.resume' })).toBeNull();
  expect(window.electronAPI.voiceConversation.end).not.toHaveBeenCalled();
});
