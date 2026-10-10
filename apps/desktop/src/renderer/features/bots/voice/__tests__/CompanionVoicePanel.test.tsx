// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
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
    cancel() {}
    async play() {}
  },
}));

import { CompanionVoicePanel } from '../CompanionVoicePanel';
let models: Array<{ id: string; name: string }>;
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
        start,
        end: vi.fn(async () => {}),
        onEvent: () => () => {},
      },
      maker: { refreshBuiltinProviderModels: refresh },
      voiceInput: { updateSettings: vi.fn(async () => ({})), onPowerStateChange: () => () => {} },
      onAuthStateChange: () => () => {},
    },
  });
});
afterEach(cleanup);
const renderPanel = (blocked = false) =>
  render(
    <CompanionVoicePanel
      bot={{ id: 'bot', name: 'Partner' }}
      sessionId="canonical"
      messages={[]}
      blocked={blocked}
      onSend={vi.fn(async () => true)}
      onClose={vi.fn()}
    />,
  );

it('shows a useful empty state without requesting a microphone or inventing models', async () => {
  renderPanel();
  await screen.findByText('bots.voiceMode.noModels');
  const button = screen.getByRole('button', { name: 'bots.voiceMode.start' });
  expect(button.hasAttribute('disabled')).toBe(true);
  fireEvent.click(button);
  expect(start).not.toHaveBeenCalled();
  expect(audio.start).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'bots.voiceMode.refresh' }));
  await waitFor(() => expect(refresh).toHaveBeenCalledWith('xd'));
});

it('opens the chosen voice route and releases capture when the panel unmounts', async () => {
  models = [{ id: 'gateway-speech', name: 'Speech' }];
  const view = renderPanel();
  await waitFor(() =>
    expect(
      screen.getByRole('button', { name: 'bots.voiceMode.start' }).hasAttribute('disabled'),
    ).toBe(false),
  );
  fireEvent.change(screen.getByLabelText('bots.voiceMode.voice'), { target: { value: 'nova' } });
  fireEvent.click(screen.getByRole('button', { name: 'bots.voiceMode.start' }));
  await waitFor(() => expect(audio.start).toHaveBeenCalledOnce());
  expect(start).toHaveBeenCalledWith({
    callId: expect.any(String),
    botId: 'bot',
    sessionId: 'canonical',
    modelId: 'gateway-speech',
    voice: 'nova',
  });
  expect(screen.getByRole('status').textContent).toBe('bots.voiceMode.status.listening');
  view.unmount();
  expect(audio.stop).toHaveBeenCalledOnce();
  expect(audio.close).toHaveBeenCalledOnce();
});

it('keeps permission cards authoritative and never starts through a pending confirmation', async () => {
  models = [{ id: 'tts', name: 'Speech' }];
  renderPanel(true);
  await waitFor(() =>
    expect(screen.getByRole('status').textContent).toBe('bots.voiceMode.status.confirmation'),
  );
  expect(
    screen.getByRole('button', { name: 'bots.voiceMode.start' }).hasAttribute('disabled'),
  ).toBe(true);
});
