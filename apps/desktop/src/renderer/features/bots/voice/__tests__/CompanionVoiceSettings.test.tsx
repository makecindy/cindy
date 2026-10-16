// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import {
  voiceModelKey,
  type SpeechVoiceCatalog,
  type VoiceConversationModel,
} from '@/../shared/voiceConversation';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';

vi.mock('@/components/ui/select', () => ({
  Select: ({
    label,
    value,
    options,
    onValueChange,
    disabled,
  }: {
    label: string;
    value: string;
    options: { value: string; label: string }[];
    onValueChange(value: string): void;
    disabled: boolean;
  }) => (
    <select
      aria-label={label}
      value={value}
      disabled={disabled}
      onChange={(e) => onValueChange(e.target.value)}
    >
      <option value="" />
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  ),
}));
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
    pause() {}
    resume() {}
    cancel() {}
    async play() {}
  },
}));

import { CompanionVoiceSettings } from '../CompanionVoiceSettings';
const sessionState = vi.hoisted(() => ({ value: {} }));
vi.mock('@/lib/makerChatStore', () => ({
  makerChatStore: { subscribeLight: () => () => {}, getLightSnapshot: () => sessionState.value },
  EMPTY_LIGHT_STATE: {},
}));
let models: VoiceConversationModel[];
const start = vi.fn(async () => ({ callId: 'call' }));
const refresh = vi.fn(async () => undefined);
const openProviders = vi.fn();
beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  setDataOwnerGeneration('owner-a', 1);
  models = [];
  sessionState.value = {};
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
const renderSettings = (botId = 'bot') =>
  render(
    <CompanionVoiceSettings botId={botId} sessionId="canonical" onOpenProviders={openProviders} />,
  );

it('defaults to sentence playback, persists a playback-only change, and restores the default', async () => {
  models = [{ id: 'tts', name: 'Speech', defaultVoice: 'alloy' }];
  const view = renderSettings();
  const toggle = await screen.findByRole('switch', { name: 'bots.voiceMode.sentencePlayback' });
  await waitFor(() => expect(toggle.hasAttribute('disabled')).toBe(false));
  expect(toggle.getAttribute('aria-checked')).toBe('true');
  vi.mocked(window.electronAPI.voiceConversation.setPreference).mockResolvedValueOnce({
    selection: null,
    customized: true,
    sentencePlayback: false,
  });
  fireEvent.click(toggle);
  await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('false'));
  expect(window.electronAPI.voiceConversation.setPreference).toHaveBeenCalledWith(
    'bot',
    undefined,
    false,
  );
  view.unmount();
  vi.mocked(window.electronAPI.voiceConversation.preference).mockResolvedValueOnce({
    selection: null,
    customized: true,
    sentencePlayback: false,
  });
  renderSettings();
  await waitFor(() =>
    expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('false'),
  );
  fireEvent.click(screen.getByRole('button', { name: 'bots.voiceMode.resetPreference' }));
  await waitFor(() => expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('true'));
  expect(window.electronAPI.voiceConversation.setPreference).toHaveBeenLastCalledWith(
    'bot',
    null,
    null,
  );
  expect(start).not.toHaveBeenCalled();
});

it('retains the saved toggle and reports a save failure', async () => {
  models = [{ id: 'tts', name: 'Speech', defaultVoice: 'alloy' }];
  renderSettings();
  const toggle = await screen.findByRole('switch');
  await waitFor(() => expect(toggle.hasAttribute('disabled')).toBe(false));
  vi.mocked(window.electronAPI.voiceConversation.setPreference).mockRejectedValueOnce(
    new Error('disk'),
  );
  fireEvent.click(toggle);
  await screen.findByRole('alert');
  expect(toggle.getAttribute('aria-checked')).toBe('true');
});

it('does not erase an unsaved manual voice when only changing playback', async () => {
  models = [{ id: 'tts', name: 'Speech', defaultVoice: 'alloy' }];
  renderSettings();
  const voice = await screen.findByLabelText('bots.voiceMode.voiceId');
  await waitFor(() => expect((voice as HTMLInputElement).disabled).toBe(false));
  fireEvent.change(voice, { target: { value: 'unfinished-voice' } });
  vi.mocked(window.electronAPI.voiceConversation.setPreference).mockResolvedValueOnce({
    selection: null,
    customized: true,
    sentencePlayback: false,
  });
  fireEvent.click(screen.getByRole('switch'));
  await waitFor(() =>
    expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('false'),
  );
  expect((screen.getByLabelText('bots.voiceMode.voiceId') as HTMLInputElement).value).toBe(
    'unfinished-voice',
  );
});

it('shows a useful empty state without requesting a microphone or inventing models', async () => {
  const savedSelection = { modelId: 'tts', voice: 'nova' };
  vi.mocked(window.electronAPI.voiceConversation.preference).mockResolvedValue({
    selection: savedSelection,
    customized: true,
    sentencePlayback: false,
  });
  const view = renderSettings();
  expect(screen.getByRole('status').textContent).toBe('bots.voiceMode.status.loading');
  expect(screen.queryByLabelText('bots.voiceMode.model')).toBeNull();
  expect(screen.queryByRole('switch')).toBeNull();
  await screen.findByText('bots.voiceMode.noModels');
  expect(screen.getByText('bots.voiceMode.noModelsSupportedProtocols')).toBeTruthy();
  expect(screen.getByText('bots.voiceMode.noModelsSetupHint')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'bots.voiceMode.openProviders' }));
  expect(openProviders).toHaveBeenCalledOnce();
  expect(screen.queryByRole('button', { name: 'bots.voiceMode.preview' })).toBeNull();
  expect(screen.queryByText('bots.voiceMode.settingsHint')).toBeNull();
  expect(screen.queryByText('bots.voiceMode.preferenceHint')).toBeNull();
  expect(screen.queryByLabelText('bots.voiceMode.model')).toBeNull();
  expect(screen.queryByRole('switch')).toBeNull();
  expect(screen.getAllByRole('button')).toHaveLength(1);
  expect(window.electronAPI.voiceConversation.setPreference).not.toHaveBeenCalled();
  expect(start).not.toHaveBeenCalled();
  expect(audio.start).not.toHaveBeenCalled();
  view.unmount();
  models = [{ id: 'tts', name: 'Speech', defaultVoice: 'alloy' }];
  renderSettings();
  await screen.findByRole('option', { name: 'Speech' });
  expect(screen.queryByText('bots.voiceMode.noModelsSupportedProtocols')).toBeNull();
  expect(screen.queryByRole('button', { name: 'bots.voiceMode.openProviders' })).toBeNull();
  expect(screen.getByText('bots.voiceMode.settingsHint')).toBeTruthy();
  await waitFor(() =>
    expect((screen.getByLabelText('bots.voiceMode.voiceId') as HTMLInputElement).value).toBe(
      'nova',
    ),
  );
  expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('false');
  expect(window.electronAPI.voiceConversation.setPreference).not.toHaveBeenCalled();
});

it('does not present a catalog failure as missing models or suggest adding a connection', async () => {
  window.electronAPI.voiceConversation.models = vi.fn(async () => {
    throw new Error('catalog unavailable');
  });
  renderSettings();
  await screen.findByText('bots.voiceMode.catalogError');
  expect(screen.queryByText('bots.voiceMode.noModelsSupportedProtocols')).toBeNull();
  expect(screen.queryByRole('button', { name: 'bots.voiceMode.openProviders' })).toBeNull();
  expect(screen.queryByLabelText('bots.voiceMode.model')).toBeNull();
  expect(screen.queryByRole('switch')).toBeNull();
  window.electronAPI.voiceConversation.models = vi.fn(async () => models);
  fireEvent.click(screen.getByRole('button', { name: 'bots.voiceMode.refresh' }));
  await screen.findByText('bots.voiceMode.noModels');
  expect(refresh).toHaveBeenCalledWith('xd');
});

it('selects the exact BYOK connection for duplicate IDs and persists it for this companion', async () => {
  models = ['a', 'b'].map((providerId) => ({
    id: 'same',
    name: 'Speech',
    providerId,
    providerName: providerId,
    agent: 'codex',
    protocol: 'openai',
    defaultVoice: 'alloy',
  }));
  renderSettings();
  await waitFor(() =>
    expect(
      screen.getByRole('button', { name: 'bots.voiceMode.preview' }).hasAttribute('disabled'),
    ).toBe(false),
  );
  expect(screen.getByRole('option', { name: 'Speech · b' })).toBeTruthy();
  fireEvent.change(screen.getByLabelText('bots.voiceMode.model'), {
    target: { value: voiceModelKey(models[1]) },
  });
  await waitFor(() =>
    expect(window.electronAPI.voiceConversation.setPreference).toHaveBeenCalledWith('bot', {
      providerId: 'b',
      agent: 'codex',
      modelId: 'same',
      voice: 'alloy',
    }),
  );
  fireEvent.click(screen.getByRole('button', { name: 'bots.voiceMode.preview' }));
  await waitFor(() =>
    expect(window.electronAPI.voiceConversation.preview).toHaveBeenCalledWith(
      expect.objectContaining({ providerId: 'b', agent: 'codex', modelId: 'same' }),
    ),
  );
});

it('requires an explicit API choice for an unknown endpoint before previewing', async () => {
  models = [
    { id: 'private', name: 'Voice', providerId: 'custom', agent: 'codex', defaultVoice: '' },
  ];
  renderSettings();
  await screen.findByText('bots.voiceMode.protocolHint');
  fireEvent.change(screen.getByLabelText('bots.voiceMode.voiceId'), {
    target: { value: 'voice-id' },
  });
  expect(
    screen.getByRole('button', { name: 'bots.voiceMode.preview' }).hasAttribute('disabled'),
  ).toBe(true);
  fireEvent.change(screen.getByLabelText('bots.voiceMode.protocol'), {
    target: { value: 'elevenlabs' },
  });
  expect(((await screen.findByLabelText('bots.voiceMode.voiceId')) as HTMLInputElement).value).toBe(
    '',
  );
  fireEvent.change(screen.getByLabelText('bots.voiceMode.voiceId'), {
    target: { value: 'voice-id' },
  });
  fireEvent.blur(screen.getByLabelText('bots.voiceMode.voiceId'));
  await waitFor(() =>
    expect(window.electronAPI.voiceConversation.setPreference).toHaveBeenCalledWith(
      'bot',
      expect.objectContaining({ protocol: 'elevenlabs', voice: 'voice-id' }),
    ),
  );
  fireEvent.click(screen.getByRole('button', { name: 'bots.voiceMode.preview' }));
  await waitFor(() =>
    expect(window.electronAPI.voiceConversation.preview).toHaveBeenCalledWith(
      expect.objectContaining({ providerId: 'custom', protocol: 'elevenlabs', voice: 'voice-id' }),
    ),
  );
});

it.each(['elevenlabs', 'minimax', 'openai'] as const)(
  'hides the fixed %s API for an official endpoint and keeps its saved voice',
  async (protocol) => {
    models = [
      {
        id: 'speech',
        name: 'Speech',
        providerId: 'official',
        agent: 'codex',
        protocol,
        protocolLocked: true,
      },
    ];
    vi.mocked(window.electronAPI.voiceConversation.preference).mockResolvedValue({
      selection: {
        providerId: 'official',
        agent: 'codex',
        modelId: 'speech',
        protocol,
        voice: 'saved-voice',
      },
      customized: true,
    });
    renderSettings();
    await waitFor(() =>
      expect((screen.getByLabelText('bots.voiceMode.voiceId') as HTMLInputElement).value).toBe(
        'saved-voice',
      ),
    );
    expect(screen.queryByLabelText('bots.voiceMode.protocol')).toBeNull();
    expect(screen.queryByText('bots.voiceMode.protocolCorrectedHint')).toBeNull();
    expect(window.electronAPI.voiceConversation.setPreference).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'bots.voiceMode.preview' }));
    await waitFor(() =>
      expect(window.electronAPI.voiceConversation.preview).toHaveBeenCalledWith(
        expect.objectContaining({ modelId: 'speech', voice: 'saved-voice' }),
      ),
    );
    expect(
      vi.mocked(window.electronAPI.voiceConversation.preview).mock.calls[0][0],
    ).not.toHaveProperty('protocol');
  },
);

it('repairs a saved API mismatch without reusing its voice or rewriting preferences on load', async () => {
  models = [
    {
      id: 'eleven_flash_v2_5',
      name: 'ElevenLabs',
      providerId: 'official',
      agent: 'codex',
      protocol: 'elevenlabs',
      protocolLocked: true,
    },
  ];
  vi.mocked(window.electronAPI.voiceConversation.preference).mockResolvedValue({
    selection: {
      providerId: 'official',
      agent: 'codex',
      modelId: 'eleven_flash_v2_5',
      protocol: 'openai',
      voice: 'alloy',
    },
    customized: true,
  });
  renderSettings();
  await screen.findByText('bots.voiceMode.protocolCorrectedHint');
  expect(screen.queryByLabelText('bots.voiceMode.protocol')).toBeNull();
  // The protocol hint can render before the asynchronous voice catalog is ready.
  const voice = (await screen.findByLabelText('bots.voiceMode.voiceId')) as HTMLInputElement;
  expect(voice.value).toBe('');
  expect(
    screen.getByRole('button', { name: 'bots.voiceMode.preview' }).hasAttribute('disabled'),
  ).toBe(true);
  expect(
    screen.getByRole('button', { name: 'bots.voiceMode.preview' }).hasAttribute('disabled'),
  ).toBe(true);
  await waitFor(() =>
    expect(window.electronAPI.voiceConversation.voices).toHaveBeenCalledWith({
      providerId: 'official',
      agent: 'codex',
      modelId: 'eleven_flash_v2_5',
      protocol: undefined,
    }),
  );
  expect(window.electronAPI.voiceConversation.setPreference).not.toHaveBeenCalled();
  fireEvent.change(voice, { target: { value: 'eleven-voice-id' } });
  fireEvent.blur(voice);
  await waitFor(() =>
    expect(window.electronAPI.voiceConversation.setPreference).toHaveBeenCalledWith('bot', {
      providerId: 'official',
      agent: 'codex',
      modelId: 'eleven_flash_v2_5',
      voice: 'eleven-voice-id',
    }),
  );
  fireEvent.click(screen.getByRole('button', { name: 'bots.voiceMode.preview' }));
  await waitFor(() =>
    expect(window.electronAPI.voiceConversation.preview).toHaveBeenCalledWith(
      expect.objectContaining({ voice: 'eleven-voice-id' }),
    ),
  );
  expect(
    vi.mocked(window.electronAPI.voiceConversation.preview).mock.calls[0][0],
  ).not.toHaveProperty('protocol');
  expect(start).not.toHaveBeenCalled();
  expect(audio.start).not.toHaveBeenCalled();
});

it('keeps a proxy API override and shows its selector only while a custom endpoint is selected', async () => {
  models = [
    {
      id: 'eleven_flash_v2_5',
      name: 'Official',
      providerId: 'official',
      agent: 'codex',
      protocol: 'elevenlabs',
      protocolLocked: true,
    },
    { id: 'eleven_flash_v2_5', name: 'Proxy', providerId: 'proxy', agent: 'codex' },
  ];
  vi.mocked(window.electronAPI.voiceConversation.preference).mockResolvedValue({
    selection: {
      providerId: 'proxy',
      agent: 'codex',
      modelId: 'eleven_flash_v2_5',
      protocol: 'openai',
      voice: 'proxy-voice',
    },
    customized: true,
  });
  renderSettings();
  await waitFor(() =>
    expect((screen.getByLabelText('bots.voiceMode.protocol') as HTMLSelectElement).value).toBe(
      'openai',
    ),
  );
  expect(((await screen.findByLabelText('bots.voiceMode.voiceId')) as HTMLInputElement).value).toBe(
    'proxy-voice',
  );
  await act(async () => {
    fireEvent.change(screen.getByLabelText('bots.voiceMode.model'), {
      target: { value: voiceModelKey(models[0]) },
    });
  });
  expect(screen.queryByLabelText('bots.voiceMode.protocol')).toBeNull();
  await act(async () => {
    fireEvent.change(screen.getByLabelText('bots.voiceMode.model'), {
      target: { value: voiceModelKey(models[1]) },
    });
  });
  const field = screen.getByLabelText('bots.voiceMode.protocol') as HTMLSelectElement;
  expect(field.disabled).toBe(false);
  expect(
    Array.from(field.options)
      .map((option) => option.value)
      .filter(Boolean),
  ).toEqual(['openai', 'elevenlabs', 'minimax']);
  await act(async () => {
    fireEvent.change(field, { target: { value: 'minimax' } });
  });
  expect(field.value).toBe('minimax');
});

it('preserves an unavailable saved connection until the user restores defaults', async () => {
  models = [
    {
      id: 'same',
      name: 'Available',
      providerId: 'other',
      agent: 'codex',
      protocol: 'openai',
      defaultVoice: 'alloy',
    },
  ];
  vi.mocked(window.electronAPI.voiceConversation.preference).mockResolvedValue({
    selection: { providerId: 'missing', agent: 'codex', modelId: 'same', voice: 'nova' },
    customized: true,
  });
  renderSettings();
  await screen.findByText('bots.voiceMode.modelUnavailable');
  expect(screen.queryByRole('button', { name: 'bots.voiceMode.preview' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'bots.voiceMode.resetPreference' }));
  await waitFor(() =>
    expect(window.electronAPI.voiceConversation.setPreference).toHaveBeenCalledWith(
      'bot',
      null,
      null,
    ),
  );
  await waitFor(() =>
    expect(
      screen.getByRole('button', { name: 'bots.voiceMode.preview' }).hasAttribute('disabled'),
    ).toBe(false),
  );
  expect(start).not.toHaveBeenCalled();
});

it('reloads the right companion preference after reopening and does not save a derived default', async () => {
  models = [{ id: 'tts', name: 'Speech' }];
  vi.mocked(window.electronAPI.voiceConversation.preference).mockImplementation(async (id) => ({
    selection: { modelId: 'tts', voice: id === 'a' ? 'nova' : 'alloy' },
    customized: true,
  }));
  const first = renderSettings('a');
  await waitFor(() =>
    expect((screen.getByLabelText('bots.voiceMode.voiceId') as HTMLInputElement).value).toBe(
      'nova',
    ),
  );
  first.unmount();
  renderSettings('b');
  await waitFor(() =>
    expect((screen.getByLabelText('bots.voiceMode.voiceId') as HTMLInputElement).value).toBe(
      'alloy',
    ),
  );
  expect(window.electronAPI.voiceConversation.setPreference).not.toHaveBeenCalled();
});

it('retries a failed preference load and still lists BYOK when Gateway refresh fails', async () => {
  models = [{ id: 'tts', name: 'Speech', defaultVoice: 'alloy' }];
  vi.mocked(window.electronAPI.voiceConversation.preference).mockRejectedValueOnce(
    new Error('load failed'),
  );
  refresh.mockRejectedValueOnce(new Error('Gateway unavailable'));
  renderSettings();
  await screen.findByText('bots.voiceMode.preferenceError');
  expect(screen.queryByRole('button', { name: 'bots.voiceMode.preview' })).toBeNull();
  expect(window.electronAPI.voiceConversation.voices).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'bots.voiceMode.refresh' }));
  await waitFor(() =>
    expect(
      screen.getByRole('button', { name: 'bots.voiceMode.preview' }).hasAttribute('disabled'),
    ).toBe(false),
  );
  expect(window.electronAPI.voiceConversation.preference).toHaveBeenCalledTimes(2);
});

it('loads in the picker without a manual-input flash and keeps the saved name during refresh', async () => {
  const voice = 'SAz9YHcvj6GT2YYXdXww';
  const name = 'River - Relaxed, Neutral, Informative';
  models = [
    {
      id: 'speech',
      name: 'ElevenLabs',
      providerId: 'mine',
      agent: 'codex',
      protocol: 'elevenlabs',
    },
  ];
  let release!: (catalog: SpeechVoiceCatalog) => void;
  vi.mocked(window.electronAPI.voiceConversation.voices).mockImplementation(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  vi.mocked(window.electronAPI.voiceConversation.preference).mockResolvedValue({
    selection: { providerId: 'mine', agent: 'codex', modelId: 'speech', voice },
    customized: true,
  });
  renderSettings();
  await waitFor(() => expect(window.electronAPI.voiceConversation.voices).toHaveBeenCalledTimes(1));
  const picker = screen.getByLabelText('bots.voiceMode.voice') as HTMLSelectElement;
  expect(picker.value).toBe('loading');
  expect(picker.disabled).toBe(true);
  expect(screen.queryByLabelText('bots.voiceMode.voiceId')).toBeNull();
  expect(screen.queryByText(voice)).toBeNull();
  await act(async () => release({ source: 'provider', voices: [{ id: voice, name }] }));
  const option = (await screen.findByRole('option', { name })) as HTMLOptionElement;
  expect(option.selected).toBe(true);
  expect(option.value).toBe(`voice:${voice}`);
  expect(screen.queryByText('bots.voiceMode.voiceId')).toBeNull();
  expect(screen.queryByText(voice)).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'bots.voiceMode.refreshVoices' }));
  await waitFor(() => expect(window.electronAPI.voiceConversation.voices).toHaveBeenCalledTimes(2));
  expect(picker.value).toBe(`voice:${voice}`);
  expect(picker.disabled).toBe(false);
  expect(option.selected).toBe(true);
  expect(screen.queryByLabelText('bots.voiceMode.voiceId')).toBeNull();
  expect(
    screen.getByRole('button', { name: 'bots.voiceMode.refreshVoices' }).getAttribute('aria-busy'),
  ).toBe('true');
  await act(async () => release({ source: 'provider', voices: [{ id: voice, name }] }));
  expect(window.electronAPI.voiceConversation.setPreference).not.toHaveBeenCalled();
  expect(window.electronAPI.voiceConversation.preview).not.toHaveBeenCalled();
  expect(start).not.toHaveBeenCalled();
  expect(audio.start).not.toHaveBeenCalled();
});

it('shows the last selected label on re-entry, refreshes renamed voices, and retains it offline', async () => {
  const voice = 'saved-voice';
  models = [
    { id: 'speech', name: 'Speech', providerId: 'mine', agent: 'codex', protocol: 'elevenlabs' },
  ];
  vi.mocked(window.electronAPI.voiceConversation.preference).mockResolvedValue({
    selection: { providerId: 'mine', agent: 'codex', modelId: 'speech', voice },
    customized: true,
  });
  let release!: (catalog: SpeechVoiceCatalog) => void;
  vi.mocked(window.electronAPI.voiceConversation.voices)
    .mockResolvedValueOnce({ source: 'provider', voices: [{ id: voice, name: 'River' }] })
    .mockReturnValueOnce(new Promise((resolve) => (release = resolve)))
    .mockRejectedValueOnce(new Error('offline'));
  const first = renderSettings();
  await screen.findByRole('option', { name: 'River' });
  first.unmount();
  const reopened = renderSettings();
  await waitFor(() => expect(window.electronAPI.voiceConversation.voices).toHaveBeenCalledTimes(2));
  const picker = screen.getByLabelText('bots.voiceMode.voice') as HTMLSelectElement;
  expect(picker.value).toBe(`voice:${voice}`);
  expect(picker.selectedOptions[0].textContent).toBe('River');
  expect(screen.queryByLabelText('bots.voiceMode.voiceId')).toBeNull();
  expect(
    screen.getByRole('button', { name: 'bots.voiceMode.refreshVoices' }).getAttribute('aria-busy'),
  ).toBe('true');
  await act(async () =>
    release({ source: 'provider', voices: [{ id: voice, name: 'River Updated' }] }),
  );
  expect(picker.value).toBe(`voice:${voice}`);
  expect(picker.selectedOptions[0].textContent).toBe('River Updated');
  reopened.unmount();
  renderSettings();
  await screen.findByText('bots.voiceMode.voicesError');
  expect(
    (screen.getByRole('option', { name: 'River Updated' }) as HTMLOptionElement).selected,
  ).toBe(true);
  expect(screen.queryByLabelText('bots.voiceMode.voiceId')).toBeNull();
  // Name refreshes are derived metadata, not edits to the user's full-ID preference.
  expect(window.electronAPI.voiceConversation.setPreference).not.toHaveBeenCalled();
  expect(window.electronAPI.voiceConversation.preview).not.toHaveBeenCalled();
  expect(audio.start).not.toHaveBeenCalled();
});

it('does not display or cache a late catalog from the previous account', async () => {
  models = [
    { id: 'speech', name: 'Speech', providerId: 'mine', agent: 'codex', protocol: 'elevenlabs' },
  ];
  vi.mocked(window.electronAPI.voiceConversation.preference).mockResolvedValue({
    selection: { providerId: 'mine', agent: 'codex', modelId: 'speech', voice: 'private' },
    customized: true,
  });
  let release!: (catalog: SpeechVoiceCatalog) => void;
  vi.mocked(window.electronAPI.voiceConversation.voices).mockReturnValueOnce(
    new Promise((resolve) => (release = resolve)),
  );
  renderSettings();
  await waitFor(() => expect(window.electronAPI.voiceConversation.voices).toHaveBeenCalled());
  setDataOwnerGeneration('owner-b', 2);
  await act(async () =>
    release({ source: 'provider', voices: [{ id: 'private', name: 'Private voice' }] }),
  );
  expect(screen.queryByRole('option', { name: 'Private voice' })).toBeNull();
  expect(window.localStorage.length).toBe(0);
});

it.each(['empty', 'missing', 'failed'] as const)(
  'waits for the first catalog before showing manual fallback when it is %s',
  async (outcome) => {
    models = [
      { id: 'speech', name: 'Speech', providerId: 'mine', agent: 'codex', protocol: 'elevenlabs' },
    ];
    vi.mocked(window.electronAPI.voiceConversation.preference).mockResolvedValue({
      selection: { providerId: 'mine', agent: 'codex', modelId: 'speech', voice: 'saved-voice' },
      customized: true,
    });
    let release!: (catalog: SpeechVoiceCatalog) => void;
    let fail!: (error: Error) => void;
    vi.mocked(window.electronAPI.voiceConversation.voices).mockReturnValue(
      new Promise((resolve, reject) => {
        release = resolve;
        fail = reject;
      }),
    );
    renderSettings();
    await waitFor(() => expect(window.electronAPI.voiceConversation.voices).toHaveBeenCalled());
    expect(screen.queryByLabelText('bots.voiceMode.voiceId')).toBeNull();
    await act(async () => {
      if (outcome === 'failed') fail(new Error('offline'));
      else
        release({
          source: 'provider',
          voices: outcome === 'empty' ? [] : [{ id: 'other', name: 'Other' }],
        });
    });
    const input = (await screen.findByLabelText('bots.voiceMode.voiceId')) as HTMLInputElement;
    expect(input.value).toBe('saved-voice');
    if (outcome === 'failed') expect(screen.getByText('bots.voiceMode.voicesError')).toBeTruthy();
    expect(window.electronAPI.voiceConversation.setPreference).not.toHaveBeenCalled();
  },
);

it('disambiguates duplicate names even when short ID suffixes collide and preserves full IDs', async () => {
  models = [
    {
      id: 'speech',
      name: 'ElevenLabs',
      providerId: 'mine',
      agent: 'codex',
      protocol: 'elevenlabs',
    },
  ];
  vi.mocked(window.electronAPI.voiceConversation.voices).mockResolvedValue({
    source: 'provider',
    voices: [
      { id: 'voice-a-123456', name: 'River' },
      { id: 'voice-b-123456', name: 'River' },
      { id: 'unnamed-voice-id', name: ' ' },
      { id: 'already-the-name', name: 'already-the-name' },
    ],
  });
  renderSettings();
  await screen.findByRole('option', { name: 'River · …a-123456' });
  const other = (await screen.findByRole('option', {
    name: 'River · …b-123456',
  })) as HTMLOptionElement;
  expect(other.value).toBe('voice:voice-b-123456');
  expect(screen.getByRole('option', { name: 'unnamed-voice-id' })).toBeTruthy();
  expect(screen.getByRole('option', { name: 'already-the-name' })).toBeTruthy();
  fireEvent.change(screen.getByLabelText('bots.voiceMode.voice'), {
    target: { value: other.value },
  });
  await waitFor(() =>
    expect(window.electronAPI.voiceConversation.setPreference).toHaveBeenCalledWith('bot', {
      providerId: 'mine',
      agent: 'codex',
      modelId: 'speech',
      voice: 'voice-b-123456',
    }),
  );
});

it('keeps a known voice on refresh failure, allows explicit manual input, and previews without capturing audio', async () => {
  models = [
    { id: 'speech', name: 'MiniMax', providerId: 'mine', agent: 'codex', protocol: 'minimax' },
  ];
  vi.mocked(window.electronAPI.voiceConversation.voices)
    .mockResolvedValueOnce({
      source: 'provider',
      voices: [{ id: 'Chinese (Mandarin)_News_Anchor', name: 'News Anchor' }],
    })
    .mockRejectedValueOnce(new Error('offline'));
  renderSettings();
  await screen.findByRole('option', { name: 'News Anchor' });
  fireEvent.change(screen.getByLabelText('bots.voiceMode.voice'), {
    target: { value: 'voice:Chinese (Mandarin)_News_Anchor' },
  });
  await waitFor(() =>
    expect(window.electronAPI.voiceConversation.setPreference).toHaveBeenCalledWith(
      'bot',
      expect.objectContaining({
        voice: 'Chinese (Mandarin)_News_Anchor',
        providerId: 'mine',
      }),
    ),
  );
  fireEvent.click(screen.getByRole('button', { name: 'bots.voiceMode.preview' }));
  await waitFor(() =>
    expect(window.electronAPI.voiceConversation.preview).toHaveBeenCalledWith(
      expect.objectContaining({
        modelId: 'speech',
        voice: 'Chinese (Mandarin)_News_Anchor',
        text: 'bots.voiceMode.previewText',
      }),
    ),
  );
  expect(
    vi.mocked(window.electronAPI.voiceConversation.preview).mock.calls[0][0].protocol,
  ).toBeUndefined();
  expect(
    vi.mocked(window.electronAPI.voiceConversation.voices).mock.calls[0][0].protocol,
  ).toBeUndefined();
  expect(start).not.toHaveBeenCalled();
  expect(audio.start).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'bots.voiceMode.refreshVoices' }));
  await screen.findByText('bots.voiceMode.voicesError');
  expect((screen.getByRole('option', { name: 'News Anchor' }) as HTMLOptionElement).selected).toBe(
    true,
  );
  expect(screen.queryByLabelText('bots.voiceMode.voiceId')).toBeNull();
  fireEvent.change(screen.getByLabelText('bots.voiceMode.voice'), { target: { value: 'manual' } });
  expect((screen.getByLabelText('bots.voiceMode.voiceId') as HTMLInputElement).value).toBe(
    'Chinese (Mandarin)_News_Anchor',
  );
});

it('resets a voice when switching models on the same connection and ignores a late catalog', async () => {
  models = ['first', 'second'].map((id) => ({
    id,
    name: id,
    providerId: 'mine',
    agent: 'codex',
    protocol: 'elevenlabs',
  }));
  vi.mocked(window.electronAPI.voiceConversation.preference).mockResolvedValue({
    selection: { providerId: 'mine', agent: 'codex', modelId: 'first', voice: 'private-voice' },
    customized: true,
  });
  let releaseOld!: (value: SpeechVoiceCatalog) => void;
  let releaseNew!: (value: SpeechVoiceCatalog) => void;
  vi.mocked(window.electronAPI.voiceConversation.voices)
    .mockResolvedValueOnce({
      source: 'provider',
      voices: [{ id: 'private-voice', name: 'Old voice' }],
    })
    .mockReturnValueOnce(
      new Promise((resolve) => {
        releaseOld = resolve;
      }),
    )
    .mockReturnValueOnce(
      new Promise((resolve) => {
        releaseNew = resolve;
      }),
    );
  renderSettings();
  await screen.findByRole('option', { name: 'Old voice' });
  fireEvent.click(screen.getByRole('button', { name: 'bots.voiceMode.refreshVoices' }));
  await waitFor(() => expect(window.electronAPI.voiceConversation.voices).toHaveBeenCalledTimes(2));
  fireEvent.change(screen.getByLabelText('bots.voiceMode.model'), {
    target: { value: voiceModelKey(models[1]) },
  });
  await waitFor(() => expect(window.electronAPI.voiceConversation.voices).toHaveBeenCalledTimes(3));
  expect((screen.getByLabelText('bots.voiceMode.voice') as HTMLSelectElement).value).toBe(
    'loading',
  );
  expect(screen.queryByRole('option', { name: 'Old voice' })).toBeNull();
  expect(screen.queryByLabelText('bots.voiceMode.voiceId')).toBeNull();
  await act(async () =>
    releaseOld({ source: 'provider', voices: [{ id: 'old', name: 'Old voice' }] }),
  );
  expect((screen.getByLabelText('bots.voiceMode.voice') as HTMLSelectElement).value).toBe(
    'loading',
  );
  expect(screen.queryByRole('option', { name: 'Old voice' })).toBeNull();
  await act(async () =>
    releaseNew({ source: 'provider', voices: [{ id: 'new', name: 'New voice' }] }),
  );
  await screen.findByRole('option', { name: 'New voice' });
  expect((screen.getByLabelText('bots.voiceMode.voice') as HTMLSelectElement).value).toBe('');
  expect(screen.queryByLabelText('bots.voiceMode.voiceId')).toBeNull();
  expect(window.electronAPI.voiceConversation.setPreference).not.toHaveBeenCalled();
});

it('flushes a manually typed voice before leaving and keeps the page open on save failure', async () => {
  models = [{ id: 'tts', name: 'Speech', defaultVoice: 'alloy' }];
  const beforeLeaveRef = { current: null as null | (() => Promise<boolean>) };
  render(
    <CompanionVoiceSettings
      botId="bot"
      sessionId="canonical"
      beforeLeaveRef={beforeLeaveRef}
      onOpenProviders={openProviders}
    />,
  );
  const input = await screen.findByLabelText('bots.voiceMode.voiceId');
  await waitFor(() => expect((input as HTMLInputElement).disabled).toBe(false));
  fireEvent.change(input, { target: { value: 'nova' } });
  vi.mocked(window.electronAPI.voiceConversation.setPreference).mockRejectedValueOnce(
    new Error('disk error'),
  );
  let allowed = true;
  await act(async () => {
    allowed = await beforeLeaveRef.current!();
  });
  expect(allowed).toBe(false);
  expect(screen.getByRole('alert').textContent).toBe('bots.voiceMode.preferenceError');
  await act(async () => {
    allowed = await beforeLeaveRef.current!();
  });
  expect(allowed).toBe(true);
  expect(window.electronAPI.voiceConversation.setPreference).toHaveBeenLastCalledWith('bot', {
    modelId: 'tts',
    voice: 'nova',
  });
  expect(start).not.toHaveBeenCalled();
});

it('allows model configuration but disables preview before a canonical conversation exists', async () => {
  models = [{ id: 'tts', name: 'Speech', defaultVoice: 'alloy' }];
  render(<CompanionVoiceSettings botId="bot" onOpenProviders={openProviders} />);
  await waitFor(() =>
    expect((screen.getByLabelText('bots.voiceMode.model') as HTMLSelectElement).disabled).toBe(
      false,
    ),
  );
  expect(screen.getByText('bots.voiceMode.previewNeedsChat')).toBeTruthy();
  expect(
    screen.getByRole('button', { name: 'bots.voiceMode.preview' }).hasAttribute('disabled'),
  ).toBe(true);
  expect(start).not.toHaveBeenCalled();
});

it('blocks preview while the companion is waiting for confirmation', async () => {
  models = [{ id: 'tts', name: 'Speech', defaultVoice: 'alloy' }];
  sessionState.value = { pendingPermission: { requestId: 'permission' } };
  renderSettings();
  await screen.findByRole('button', { name: 'bots.voiceMode.preview' });
  expect(
    screen.getByRole('button', { name: 'bots.voiceMode.preview' }).hasAttribute('disabled'),
  ).toBe(true);
  expect(start).not.toHaveBeenCalled();
});
