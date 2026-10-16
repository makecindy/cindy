// @vitest-environment jsdom
import { StrictMode } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import {
  type VoiceConversationModel,
  type VoiceConversationEvent,
} from '@/../shared/voiceConversation';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/lib/logger', () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn() }) }));
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
        setInputMuted: vi.fn(async () => ({ inputGeneration: 2 })),
        finishUtterance: vi.fn(async () => {}),
        end: vi.fn(async () => {}),
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
const configure = vi.fn();
const close = vi.fn();
const panel = (blocked = false) => (
  <CompanionVoicePanel
    bot={{ id: 'bot', name: 'Partner' }}
    sessionId="canonical"
    messages={[]}
    blocked={blocked}
    onSend={vi.fn(async () => true)}
    onClose={close}
    onConfigure={configure}
  />
);

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
  fireEvent.click(screen.getByRole('button', { name: 'bots.voiceMode.openSettings' }));
  expect(configure).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole('button', { name: 'bots.voiceMode.end' }));
  expect(close).toHaveBeenCalledOnce();
});

it('keeps permission cards authoritative and resumes only after another explicit action', async () => {
  models = [{ id: 'tts', name: 'Speech', defaultVoice: 'alloy' }];
  const view = render(panel(true));
  await act(async () => {});
  expect(screen.getByRole('status').textContent).toBe('bots.voiceMode.status.confirmation');
  expect(
    screen.getByRole('button', { name: 'bots.voiceMode.resume' }).hasAttribute('disabled'),
  ).toBe(true);
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

it('keeps Send secondary and preserves a visible unsent draft when the microphone is muted', async () => {
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
  expect(screen.getByText('bots.voiceMode.unsent')).toBeTruthy();
  expect(screen.getByText('unfinished thought')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'bots.voiceMode.send' })).toBeTruthy();
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
