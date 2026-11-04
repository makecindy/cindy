// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import {
  voiceModelKey,
  type SpeechVoiceCatalog,
  type VoiceConversationModel,
} from '@/../shared/voiceConversation';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import type { SpeechPlayer } from '../PcmSpeechPlayer';

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
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { voice?: string }) =>
      key === 'settings.providers.xd.title'
        ? 'Cindy AI'
        : options?.voice
          ? `${key}: ${options.voice}`
          : key,
  }),
}));
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
  play: vi.fn<SpeechPlayer['play']>(async () => {}),
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
    play = audio.play;
  },
}));

import { CompanionVoiceSettings } from '../CompanionVoiceSettings';
import { resolveVoiceConfiguration } from '../voiceConfiguration';
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
  audio.play.mockReset().mockResolvedValue(undefined);
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
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
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const renderSettings = (botId = 'bot') =>
  render(
    <CompanionVoiceSettings botId={botId} sessionId="canonical" onOpenProviders={openProviders} />,
  );

const voicePicker = () =>
  screen.getByRole('button', { name: 'bots.voiceMode.voice' }) as HTMLButtonElement;
const openVoices = async () => {
  await screen.findByRole('button', { name: 'bots.voiceMode.voice' });
  await waitFor(() => expect(voicePicker().disabled).toBe(false));
  if (voicePicker().getAttribute('aria-expanded') !== 'true') fireEvent.click(voicePicker());
  return within(screen.getByRole('dialog', { name: 'bots.voiceMode.voice' }));
};
const closeVoices = () =>
  fireEvent.keyDown(screen.getByRole('dialog', { name: 'bots.voiceMode.voice' }), {
    key: 'Escape',
  });

const listedVoices = () => {
  models = [{ id: 'tts', name: 'Speech', defaultVoice: 'river' }];
  vi.mocked(window.electronAPI.voiceConversation.voices).mockResolvedValue({
    source: 'provider',
    voices: [
      { id: 'river', name: 'River' },
      { id: 'bella', name: 'Bella' },
    ],
  });
  vi.mocked(window.electronAPI.voiceConversation.preference).mockResolvedValue({
    selection: { modelId: 'tts', voice: 'river', speed: 0.95 },
    customized: true,
  });
};

// Real settings -> menu -> shared preview controller: browsing/previewing must
// never commit a voice, even while an older synthesis request is unresolved.
it('previews unselected voices with the saved speed, switches and stops without saving', async () => {
  listedVoices();
  const pending: Array<() => void> = [];
  vi.mocked(window.electronAPI.voiceConversation.preview).mockImplementation(
    () => new Promise((resolve) => pending.push(() => resolve({ sampleRate: 24000 }))),
  );
  renderSettings();
  const menu = await openVoices();
  const river = menu.getByRole('button', { name: 'River' });
  const bella = menu.getByRole('button', { name: 'Bella' });
  expect(document.activeElement).toBe(river);
  fireEvent.mouseEnter(bella);
  fireEvent.keyDown(river, { key: 'ArrowDown' });
  expect(document.activeElement).toBe(bella);
  expect(window.electronAPI.voiceConversation.preview).not.toHaveBeenCalled();
  fireEvent.click(menu.getByRole('button', { name: 'bots.voiceMode.previewVoice: Bella' }));
  await waitFor(() =>
    expect(window.electronAPI.voiceConversation.preview).toHaveBeenCalledTimes(1),
  );
  expect(window.electronAPI.voiceConversation.preview).toHaveBeenLastCalledWith(
    expect.objectContaining({ voice: 'bella', speed: 0.95 }),
  );
  const firstId = vi.mocked(window.electronAPI.voiceConversation.preview).mock.calls[0][0]
    .previewId;
  expect(voicePicker().value).toBe('voice:river');
  fireEvent.click(menu.getByRole('button', { name: 'bots.voiceMode.previewVoice: River' }));
  await waitFor(() =>
    expect(window.electronAPI.voiceConversation.preview).toHaveBeenCalledTimes(2),
  );
  expect(window.electronAPI.voiceConversation.stopPreview).toHaveBeenCalledWith(firstId);
  expect(window.electronAPI.voiceConversation.preview).toHaveBeenLastCalledWith(
    expect.objectContaining({ voice: 'river', speed: 0.95 }),
  );
  fireEvent.click(menu.getByRole('button', { name: 'bots.voiceMode.stopPreviewVoice: River' }));
  await act(async () => {
    pending.forEach((resolve) => resolve());
  });
  expect(audio.play).not.toHaveBeenCalled();
  expect(window.electronAPI.voiceConversation.setPreference).not.toHaveBeenCalled();
  expect(start).not.toHaveBeenCalled();
  expect(audio.start).not.toHaveBeenCalled();
  fireEvent.click(bella);
  await waitFor(() =>
    expect(window.electronAPI.voiceConversation.setPreference).toHaveBeenCalledTimes(1),
  );
  expect(window.electronAPI.voiceConversation.setPreference).toHaveBeenCalledWith(
    'bot',
    expect.objectContaining({ voice: 'bella', speed: 0.95 }),
  );
  expect(screen.queryByRole('dialog', { name: 'bots.voiceMode.voice' })).toBeNull();
});

it('keeps the menu and saved voice on preview failure, retries and stops playback on Escape', async () => {
  listedVoices();
  vi.mocked(window.electronAPI.voiceConversation.preview).mockRejectedValueOnce(
    new Error('offline'),
  );
  let finishPlayback!: () => void;
  audio.play.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishPlayback = resolve;
      }),
  );
  renderSettings();
  const menu = await openVoices();
  fireEvent.click(menu.getByRole('button', { name: 'bots.voiceMode.previewVoice: Bella' }));
  await menu.findByText('bots.voiceMode.previewStatus.error');
  expect(voicePicker().value).toBe('voice:river');
  fireEvent.click(menu.getByRole('button', { name: 'bots.voiceMode.previewVoice: Bella' }));
  await menu.findByText('bots.voiceMode.previewStatus.playing');
  const previewId = vi.mocked(window.electronAPI.voiceConversation.preview).mock.calls[1][0]
    .previewId;
  closeVoices();
  await waitFor(() => expect(document.activeElement).toBe(voicePicker()));
  expect(window.electronAPI.voiceConversation.stopPreview).toHaveBeenCalledWith(previewId);
  expect(audio.close).toHaveBeenCalled();
  await act(async () => finishPlayback());
  expect(window.electronAPI.voiceConversation.setPreference).not.toHaveBeenCalled();
  expect(voicePicker().value).toBe('voice:river');
});

// PR #6660 P2: real settings -> preview -> status must distinguish header/read
// timeouts in both voice inputs. Existing failure coverage only used a generic
// rejection in the menu. Unit tier; one rejected IPC is the minimal reproducer.
it.each([
  { input: 'list', stage: 'preview' },
  { input: 'list', stage: 'readPreview' },
  { input: 'manual', stage: 'preview' },
  { input: 'manual', stage: 'readPreview' },
] as const)(
  'shows a timeout for $input voice $stage without changing preferences',
  async ({ input, stage }) => {
    listedVoices();
    const api = window.electronAPI.voiceConversation;
    vi.mocked(api[stage]).mockRejectedValueOnce(
      new Error(
        `Error invoking remote method 'voice-conversation:${stage}': Error: [VOICE_SPEECH_TIMEOUT] Speech timed out`,
      ),
    );
    audio.play.mockImplementationOnce(async (read) => {
      await read();
    });
    renderSettings();
    const menu = await openVoices();
    if (input === 'manual') {
      fireEvent.click(menu.getByRole('button', { name: 'bots.voiceMode.manualVoice' }));
      fireEvent.click(await screen.findByRole('button', { name: 'bots.voiceMode.preview' }));
    } else {
      fireEvent.click(menu.getByRole('button', { name: 'bots.voiceMode.previewVoice: Bella' }));
    }
    await screen.findByText('bots.voiceMode.errors.speechTimeout');
    expect(screen.queryByText('bots.voiceMode.previewStatus.error')).toBeNull();
    expect(api.preview).toHaveBeenCalledOnce();
    expect(api.stopPreview).toHaveBeenCalledOnce();
    expect(audio.close).toHaveBeenCalled();
    expect(api.setPreference).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  },
);

it.each(['no-session', 'permission'] as const)(
  'keeps inline preview disabled with %s',
  async (reason) => {
    listedVoices();
    if (reason === 'permission') sessionState.value = { pendingPermission: {} };
    render(
      <CompanionVoiceSettings
        botId="bot"
        sessionId={reason === 'no-session' ? undefined : 'canonical'}
        onOpenProviders={openProviders}
      />,
    );
    if (reason === 'permission') {
      await screen.findByText('River');
      expect(voicePicker().disabled).toBe(true);
      fireEvent.click(voicePicker());
      expect(screen.queryByRole('dialog', { name: 'bots.voiceMode.voice' })).toBeNull();
      expect(window.electronAPI.voiceConversation.preview).not.toHaveBeenCalled();
      return;
    }
    const menu = await openVoices();
    const button = menu.getByRole('button', { name: 'bots.voiceMode.previewVoice: Bella' });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(button);
    expect(window.electronAPI.voiceConversation.preview).not.toHaveBeenCalled();
    expect(window.electronAPI.voiceConversation.setPreference).not.toHaveBeenCalled();
  },
);

// Unit tier: exercise the real numeric slider, persisted selection and preview
// boundary; previous settings could neither retain nor send a speed override.
it('saves speed by keyboard, previews it, reloads it and removes it on reset', async () => {
  models = [{ id: 'tts', name: 'Speech', defaultVoice: 'alloy' }];
  const view = renderSettings();
  const slider = await screen.findByRole('slider', { name: 'bots.voiceMode.speed' });
  expect(slider.getAttribute('aria-valuenow')).toBe('1');
  fireEvent.keyDown(slider, { key: 'ArrowRight' });
  await waitFor(() =>
    expect(window.electronAPI.voiceConversation.setPreference).toHaveBeenCalledWith(
      'bot',
      expect.objectContaining({ voice: 'alloy', speed: 1.05 }),
    ),
  );
  await waitFor(() => expect(slider.getAttribute('aria-disabled')).not.toBe('true'));
  fireEvent.click(screen.getByRole('button', { name: 'bots.voiceMode.preview' }));
  await waitFor(() =>
    expect(window.electronAPI.voiceConversation.preview).toHaveBeenCalledWith(
      expect.objectContaining({ speed: 1.05, voice: 'alloy' }),
    ),
  );
  view.unmount();
  vi.mocked(window.electronAPI.voiceConversation.preference).mockResolvedValueOnce({
    selection: { modelId: 'tts', voice: 'alloy', speed: 1.05 },
    customized: true,
  });
  renderSettings();
  expect((await screen.findByRole('slider')).getAttribute('aria-valuenow')).toBe('1.05');
  fireEvent.click(screen.getByRole('button', { name: 'bots.voiceMode.resetPreference' }));
  await waitFor(() => expect(screen.getByRole('slider').getAttribute('aria-valuenow')).toBe('1'));
  expect(window.electronAPI.voiceConversation.setPreference).toHaveBeenLastCalledWith(
    'bot',
    null,
    null,
  );
});

it('preserves a failed speed edit and retries it before leaving', async () => {
  models = [{ id: 'tts', name: 'Speech', defaultVoice: 'alloy' }];
  const beforeLeaveRef = { current: null as (() => Promise<boolean>) | null };
  render(
    <CompanionVoiceSettings
      botId="bot"
      sessionId="canonical"
      onOpenProviders={openProviders}
      beforeLeaveRef={beforeLeaveRef}
    />,
  );
  const slider = await screen.findByRole('slider');
  vi.mocked(window.electronAPI.voiceConversation.setPreference).mockRejectedValueOnce(
    new Error('disk'),
  );
  fireEvent.keyDown(slider, { key: 'ArrowRight' });
  await screen.findByRole('alert');
  expect(slider.getAttribute('aria-valuenow')).toBe('1.05');
  await act(async () => {
    expect(await beforeLeaveRef.current!()).toBe(true);
  });
  expect(window.electronAPI.voiceConversation.setPreference).toHaveBeenLastCalledWith(
    'bot',
    expect.objectContaining({ speed: 1.05 }),
  );
});

it('reconciles the saved speed on model changes and keeps it when changing the voice', async () => {
  const mini = {
    id: 'speech-02-hd',
    name: 'MiniMax',
    providerId: 'mini',
    agent: 'codex' as const,
    protocol: 'minimax' as const,
    protocolLocked: true,
    defaultVoice: 'voice',
  };
  const eleven = {
    ...mini,
    id: 'eleven_flash_v2_5',
    name: 'Flash',
    providerId: 'eleven',
    protocol: 'elevenlabs' as const,
  };
  const v3 = { ...eleven, id: 'eleven_v3', name: 'V3' };
  models = [mini, eleven, v3];
  vi.mocked(window.electronAPI.voiceConversation.preference).mockResolvedValueOnce({
    selection: {
      providerId: mini.providerId,
      agent: mini.agent,
      modelId: mini.id,
      voice: 'voice',
      speed: 1.8,
    },
    customized: true,
  });
  renderSettings();
  const model = await screen.findByLabelText('bots.voiceMode.model');
  await waitFor(() => expect((model as HTMLSelectElement).disabled).toBe(false));
  fireEvent.change(model, { target: { value: voiceModelKey(eleven) } });
  await waitFor(() =>
    expect(window.electronAPI.voiceConversation.setPreference).toHaveBeenLastCalledWith(
      'bot',
      expect.objectContaining({ modelId: eleven.id, speed: 1.2 }),
    ),
  );
  expect(screen.getByText('bots.voiceMode.speedAdjusted')).toBeTruthy();
  const voice = await screen.findByLabelText('bots.voiceMode.voiceId');
  await waitFor(() => expect((voice as HTMLInputElement).disabled).toBe(false));
  fireEvent.change(voice, { target: { value: 'another-voice' } });
  fireEvent.blur(voice);
  await waitFor(() =>
    expect(window.electronAPI.voiceConversation.setPreference).toHaveBeenLastCalledWith(
      'bot',
      expect.objectContaining({ voice: 'another-voice', speed: 1.2 }),
    ),
  );
  await waitFor(() => expect((model as HTMLSelectElement).disabled).toBe(false));
  fireEvent.change(model, { target: { value: voiceModelKey(v3) } });
  await screen.findByText('bots.voiceMode.speedUnavailable');
  expect(screen.queryByRole('slider')).toBeNull();
  const saved = vi.mocked(window.electronAPI.voiceConversation.setPreference).mock.calls.at(-1)![1];
  expect(saved).not.toHaveProperty('speed');
});

// Unit regression at the actual settings entry: Gateway Qwen accepts 0.5–2,
// although its transport is OpenAI-compatible. The old protocol-only range let
// users save 4x and receive a Gateway error; retain the existing adjustment flow.
it('clamps speed when switching to Gateway Qwen and previews the adjusted choice', async () => {
  const openai = {
    id: 'tts-1',
    name: 'OpenAI speech',
    providerId: 'xd',
    protocol: 'openai' as const,
    protocolLocked: true,
    defaultVoice: 'alloy',
  };
  const qwen = {
    ...openai,
    id: 'qwen/qwen-audio-3.1-tts-plus',
    name: 'Qwen speech',
    defaultVoice: 'longanlingxin_v3.1',
  };
  models = [openai, qwen];
  vi.mocked(window.electronAPI.voiceConversation.preference).mockResolvedValueOnce({
    selection: { providerId: 'xd', modelId: openai.id, voice: 'alloy', speed: 4 },
    customized: true,
  });
  renderSettings();
  const model = await screen.findByRole('combobox', { name: 'bots.voiceMode.model' });
  await waitFor(() => expect((model as HTMLSelectElement).disabled).toBe(false));
  fireEvent.change(model, { target: { value: voiceModelKey(qwen) } });
  await waitFor(() =>
    expect(window.electronAPI.voiceConversation.setPreference).toHaveBeenLastCalledWith(
      'bot',
      expect.objectContaining({ modelId: qwen.id, voice: qwen.defaultVoice, speed: 2 }),
    ),
  );
  const slider = await screen.findByRole('slider', { name: 'bots.voiceMode.speed' });
  expect(slider.getAttribute('aria-valuemin')).toBe('0.5');
  expect(slider.getAttribute('aria-valuemax')).toBe('2');
  expect(screen.getByText('bots.voiceMode.speedAdjusted')).toBeTruthy();
  fireEvent.click(await screen.findByRole('button', { name: 'bots.voiceMode.preview' }));
  await waitFor(() =>
    expect(window.electronAPI.voiceConversation.preview).toHaveBeenCalledWith(
      expect.objectContaining({ modelId: qwen.id, voice: qwen.defaultVoice, speed: 2 }),
    ),
  );
});

// OpenRouter uses OpenAI transport, but does not promise OpenAI's speed range.
// Exercise real settings save/preview and call-start resolution with an old saved speed.
it('honors route speed limits when reopening, editing and previewing an OpenRouter voice', async () => {
  const router: VoiceConversationModel = {
    id: 'elevenlabs/eleven-v3', name: 'Eleven v3', providerId: 'router', agent: 'codex',
    protocol: 'openai', protocolLocked: true, speedRange: null,
  };
  models = [router];
  const saved = { providerId: 'router', agent: 'codex' as const, modelId: router.id, voice: 'sarah', speed: 1.5 };
  vi.mocked(window.electronAPI.voiceConversation.preference).mockResolvedValue({ selection: saved, customized: true });
  renderSettings();
  await screen.findByText('bots.voiceMode.speedUnavailable');
  expect(screen.queryByRole('slider')).toBeNull();
  expect(resolveVoiceConfiguration(models, saved).selection).not.toHaveProperty('speed');
  const voice = await screen.findByLabelText('bots.voiceMode.voiceId');
  await waitFor(() => expect((voice as HTMLInputElement).disabled).toBe(false));
  fireEvent.change(voice, { target: { value: 'custom-voice-id' } });
  fireEvent.blur(voice);
  await waitFor(() => expect(window.electronAPI.voiceConversation.setPreference).toHaveBeenCalledWith(
    'bot', { providerId: 'router', agent: 'codex', modelId: router.id, voice: 'custom-voice-id' },
  ));
  const previewButton = await screen.findByRole('button', { name: 'bots.voiceMode.preview' });
  await waitFor(() => expect((previewButton as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(previewButton);
  await waitFor(() => expect(window.electronAPI.voiceConversation.preview).toHaveBeenCalled());
  expect(vi.mocked(window.electronAPI.voiceConversation.preview).mock.calls[0][0]).toMatchObject({ voice: 'custom-voice-id', modelId: router.id });
  expect(vi.mocked(window.electronAPI.voiceConversation.preview).mock.calls[0][0]).not.toHaveProperty('speed');
});

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
  await screen.findByRole('option', { name: 'Speech · Cindy AI' });
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

// Unit regression: the real settings component previously rendered the raw
// Gateway catalog name. Existing fixtures already used its localized display name.
it.each(['xd', undefined])(
  'localizes the Gateway name with provider %s while retaining BYOK names and route IDs',
  async (providerId) => {
    const gateway: VoiceConversationModel = {
      id: 'elevenlabs/eleven_v3',
      name: 'Eleven v3',
      providerId,
      providerName: 'XD Gateway',
      protocol: 'openai',
      defaultVoice: 'reference-voice',
    };
    const byok: VoiceConversationModel = {
      ...gateway,
      providerId: 'my-elevenlabs',
      providerName: '我的 ElevenLabs',
      agent: 'codex',
    };
    models = [byok, gateway];
    renderSettings();
    const field = await screen.findByRole('combobox', { name: 'bots.voiceMode.model' });
    await waitFor(() => expect((field as HTMLSelectElement).disabled).toBe(false));
    expect(within(field).getByRole('option', { name: 'Eleven v3 · Cindy AI' })).toBeTruthy();
    expect(within(field).getByRole('option', { name: 'Eleven v3 · 我的 ElevenLabs' })).toBeTruthy();
    expect(within(field).queryByRole('option', { name: 'Eleven v3 · XD Gateway' })).toBeNull();
    expect(window.electronAPI.voiceConversation.setPreference).not.toHaveBeenCalled();
    fireEvent.change(field, { target: { value: voiceModelKey(gateway) } });
    await waitFor(() =>
      expect(window.electronAPI.voiceConversation.setPreference).toHaveBeenCalledWith('bot', {
        providerId,
        agent: undefined,
        modelId: gateway.id,
        voice: gateway.defaultVoice,
      }),
    );
  },
);

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
  ).toEqual(['openai', 'elevenlabs', 'minimax', 'qwen-tts', 'dashscope-tts']);
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
  const picker = voicePicker();
  expect(picker.value).toBe('loading');
  expect(picker.disabled).toBe(true);
  expect(screen.queryByLabelText('bots.voiceMode.voiceId')).toBeNull();
  expect(screen.queryByText(voice)).toBeNull();
  await act(async () => release({ source: 'provider', voices: [{ id: voice, name }] }));
  const option = (await openVoices()).getByRole('button', {
    name,
  }) as HTMLButtonElement;
  expect(option.getAttribute('aria-pressed')).toBe('true');
  expect(option.value).toBe(`voice:${voice}`);
  expect(screen.queryByText('bots.voiceMode.voiceId')).toBeNull();
  expect(screen.queryByText(voice)).toBeNull();
  closeVoices();
  fireEvent.click(screen.getByRole('button', { name: 'bots.voiceMode.refreshVoices' }));
  await waitFor(() => expect(window.electronAPI.voiceConversation.voices).toHaveBeenCalledTimes(2));
  expect(picker.value).toBe(`voice:${voice}`);
  expect(picker.disabled).toBe(false);
  expect(picker.textContent).toBe(name);
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
  await screen.findByText('River');
  first.unmount();
  const reopened = renderSettings();
  await waitFor(() => expect(window.electronAPI.voiceConversation.voices).toHaveBeenCalledTimes(2));
  const picker = voicePicker();
  expect(picker.value).toBe(`voice:${voice}`);
  expect(picker.textContent).toBe('River');
  expect(screen.queryByLabelText('bots.voiceMode.voiceId')).toBeNull();
  expect(
    screen.getByRole('button', { name: 'bots.voiceMode.refreshVoices' }).getAttribute('aria-busy'),
  ).toBe('true');
  await act(async () =>
    release({ source: 'provider', voices: [{ id: voice, name: 'River Updated' }] }),
  );
  expect(picker.value).toBe(`voice:${voice}`);
  expect(picker.textContent).toBe('River Updated');
  reopened.unmount();
  renderSettings();
  await screen.findByText('bots.voiceMode.voicesError');
  expect(voicePicker().value).toBe(`voice:${voice}`);
  expect(voicePicker().textContent).toBe('River Updated');
  expect(screen.queryByLabelText('bots.voiceMode.voiceId')).toBeNull();
  // Name refreshes are derived metadata, not edits to the user's full-ID preference.
  expect(window.electronAPI.voiceConversation.setPreference).not.toHaveBeenCalled();
  expect(window.electronAPI.voiceConversation.preview).not.toHaveBeenCalled();
  expect(audio.start).not.toHaveBeenCalled();
});

// Unit tier: a partial private catalog is still a usable public catalog, but may
// omit the saved custom ID. Refresh must not silently select the first system voice.
it('keeps the saved custom ID and usable system choices after private discovery fails', async () => {
  models = [
    {
      id: 'cosyvoice-v3-flash',
      name: 'CosyVoice',
      providerId: 'mine',
      agent: 'codex',
      protocol: 'dashscope-tts',
    },
  ];
  vi.mocked(window.electronAPI.voiceConversation.preference).mockResolvedValue({
    selection: {
      providerId: 'mine',
      agent: 'codex',
      modelId: 'cosyvoice-v3-flash',
      voice: 'my-clone',
    },
    customized: true,
  });
  vi.mocked(window.electronAPI.voiceConversation.voices).mockResolvedValue({
    source: 'reference',
    customVoicesUnavailable: true,
    voices: [
      { id: 'longanyang', name: '龙安洋' },
      { id: 'longanhuan', name: '龙安欢' },
    ],
  });
  renderSettings();
  await screen.findByText('bots.voiceMode.voicesCustomError');
  expect((screen.getByLabelText('bots.voiceMode.voiceId') as HTMLInputElement).value).toBe(
    'my-clone',
  );
  const menu = await openVoices();
  expect(menu.getByRole('button', { name: '龙安欢' })).toBeTruthy();
  closeVoices();
  fireEvent.click(screen.getByRole('button', { name: 'bots.voiceMode.refreshVoices' }));
  await waitFor(() => expect(window.electronAPI.voiceConversation.voices).toHaveBeenCalledTimes(2));
  expect(window.electronAPI.voiceConversation.setPreference).not.toHaveBeenCalled();
  expect(window.electronAPI.voiceConversation.preview).not.toHaveBeenCalled();
});

it('retains the selected custom name and public options when a refresh returns a partial catalog', async () => {
  models = [
    {
      id: 'cosyvoice-v3-flash',
      name: 'CosyVoice',
      providerId: 'mine',
      agent: 'codex',
      protocol: 'dashscope-tts',
    },
  ];
  vi.mocked(window.electronAPI.voiceConversation.preference).mockResolvedValue({
    selection: {
      providerId: 'mine',
      agent: 'codex',
      modelId: 'cosyvoice-v3-flash',
      voice: 'my-clone',
    },
    customized: true,
  });
  vi.mocked(window.electronAPI.voiceConversation.voices)
    .mockResolvedValueOnce({
      source: 'mixed',
      voices: [
        { id: 'my-clone', name: 'My Voice' },
        { id: 'longanyang', name: '龙安洋' },
      ],
    })
    .mockResolvedValue({
      source: 'reference',
      customVoicesUnavailable: true,
      voices: [{ id: 'longanyang', name: '龙安洋' }],
    });
  const first = renderSettings();
  await screen.findByText('My Voice');
  fireEvent.click(screen.getByRole('button', { name: 'bots.voiceMode.refreshVoices' }));
  await screen.findByText('bots.voiceMode.voicesCustomError');
  expect(voicePicker().textContent).toBe('My Voice');
  expect(screen.queryByLabelText('bots.voiceMode.voiceId')).toBeNull();
  const menu = await openVoices();
  expect(menu.getByRole('button', { name: '龙安洋' })).toBeTruthy();
  expect(menu.getByRole('button', { name: 'My Voice' })).toBeTruthy();
  first.unmount();
  renderSettings();
  await screen.findByText('bots.voiceMode.voicesCustomError');
  expect(voicePicker().textContent).toBe('My Voice');
  expect(window.electronAPI.voiceConversation.setPreference).not.toHaveBeenCalled();
  expect(window.electronAPI.voiceConversation.preview).not.toHaveBeenCalled();
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
  expect(screen.queryByText('Private voice')).toBeNull();
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
  const menu = await openVoices();
  expect(menu.getByRole('button', { name: 'River · …a-123456' })).toBeTruthy();
  const other = menu.getByRole('button', {
    name: 'River · …b-123456',
  }) as HTMLButtonElement;
  expect(other.value).toBe('voice:voice-b-123456');
  expect(menu.getByRole('button', { name: 'unnamed-voice-id' })).toBeTruthy();
  expect(menu.getByRole('button', { name: 'already-the-name' })).toBeTruthy();
  fireEvent.click(other);
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
  fireEvent.click((await openVoices()).getByRole('button', { name: 'News Anchor' }));
  await waitFor(() =>
    expect(window.electronAPI.voiceConversation.setPreference).toHaveBeenCalledWith(
      'bot',
      expect.objectContaining({
        voice: 'Chinese (Mandarin)_News_Anchor',
        providerId: 'mine',
      }),
    ),
  );
  fireEvent.click(
    (await openVoices()).getByRole('button', { name: 'bots.voiceMode.previewVoice: News Anchor' }),
  );
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
  closeVoices();
  fireEvent.click(screen.getByRole('button', { name: 'bots.voiceMode.refreshVoices' }));
  await screen.findByText('bots.voiceMode.voicesError');
  expect(voicePicker().value).toBe('voice:Chinese (Mandarin)_News_Anchor');
  expect(voicePicker().textContent).toBe('News Anchor');
  expect(screen.queryByLabelText('bots.voiceMode.voiceId')).toBeNull();
  fireEvent.click((await openVoices()).getByRole('button', { name: 'bots.voiceMode.manualVoice' }));
  expect((screen.getByLabelText('bots.voiceMode.voiceId') as HTMLInputElement).value).toBe(
    'Chinese (Mandarin)_News_Anchor',
  );
});

it('selects the new model first voice and ignores a late catalog from the previous model', async () => {
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
  await screen.findByText('Old voice');
  fireEvent.click(screen.getByRole('button', { name: 'bots.voiceMode.refreshVoices' }));
  await waitFor(() => expect(window.electronAPI.voiceConversation.voices).toHaveBeenCalledTimes(2));
  fireEvent.change(screen.getByLabelText('bots.voiceMode.model'), {
    target: { value: voiceModelKey(models[1]) },
  });
  await waitFor(() => expect(window.electronAPI.voiceConversation.voices).toHaveBeenCalledTimes(3));
  expect(voicePicker().value).toBe('loading');
  expect(screen.queryByText('Old voice')).toBeNull();
  expect(screen.queryByLabelText('bots.voiceMode.voiceId')).toBeNull();
  await act(async () =>
    releaseOld({ source: 'provider', voices: [{ id: 'old', name: 'Old voice' }] }),
  );
  expect(voicePicker().value).toBe('loading');
  expect(screen.queryByText('Old voice')).toBeNull();
  await act(async () =>
    releaseNew({ source: 'provider', voices: [{ id: 'new', name: 'New voice' }] }),
  );
  expect((await openVoices()).getByRole('button', { name: 'New voice' })).toBeTruthy();
  expect(voicePicker().value).toBe('voice:new');
  expect(screen.queryByLabelText('bots.voiceMode.voiceId')).toBeNull();
  expect(window.electronAPI.voiceConversation.setPreference).toHaveBeenCalledExactlyOnceWith(
    'bot',
    { providerId: 'mine', agent: 'codex', modelId: 'second', voice: 'new' },
  );
});

// Unit regression: the real settings/picker must finish an explicit model switch
// when its asynchronous catalog has voices but defaultVoice is empty. Existing
// settings tests only saved static defaults or expected this switch to stay blank.
const modelSwitchFixture = () => {
  models = ['first', 'second'].map((id) => ({
    id, name: id, providerId: 'mine', agent: 'codex', protocol: 'openai', protocolLocked: true,
  }));
  vi.mocked(window.electronAPI.voiceConversation.preference).mockResolvedValue({
    selection: { providerId: 'mine', agent: 'codex', modelId: 'first', voice: 'saved' },
    customized: true,
  });
  vi.mocked(window.electronAPI.voiceConversation.voices).mockResolvedValueOnce({
    source: 'provider', voices: [{ id: 'saved', name: 'Saved voice' }],
  });
};
const switchToSecondModel = async () => {
  await screen.findByText('Saved voice');
  fireEvent.change(screen.getByLabelText('bots.voiceMode.model'), {
    target: { value: voiceModelKey(models[1]) },
  });
  await waitFor(() => expect(window.electronAPI.voiceConversation.voices).toHaveBeenCalledTimes(2));
};

it.each([
  { source: 'provider', defaultVoice: '', expected: 'first-voice' },
  { source: 'reference', defaultVoice: '', expected: 'first-voice' },
  { source: 'provider', defaultVoice: 'preferred', expected: 'preferred' },
] as const)('completes a model switch using $source voices and default "$defaultVoice", without previewing or reselecting on refresh', async ({ source, defaultVoice, expected }) => {
  modelSwitchFixture();
  models[1].defaultVoice = defaultVoice;
  const voices = [
    { id: 'first-voice', name: 'First voice' },
    { id: 'preferred', name: 'Preferred voice' },
  ];
  vi.mocked(window.electronAPI.voiceConversation.voices).mockResolvedValue({ source, voices });
  renderSettings();
  await switchToSecondModel();
  await waitFor(() => expect(voicePicker().value).toBe(`voice:${expected}`));
  expect(window.electronAPI.voiceConversation.setPreference).toHaveBeenCalledExactlyOnceWith(
    'bot', { providerId: 'mine', agent: 'codex', modelId: 'second', voice: expected },
  );
  vi.mocked(window.electronAPI.voiceConversation.voices).mockResolvedValue({ source, voices: [...voices].reverse() });
  fireEvent.click(screen.getByRole('button', { name: 'bots.voiceMode.refreshVoices' }));
  await waitFor(() => expect(window.electronAPI.voiceConversation.voices).toHaveBeenCalledTimes(3));
  expect(voicePicker().value).toBe(`voice:${expected}`);
  expect(window.electronAPI.voiceConversation.setPreference).toHaveBeenCalledTimes(1);
  expect(window.electronAPI.voiceConversation.preview).not.toHaveBeenCalled();
  expect(start).not.toHaveBeenCalled();
  expect(audio.start).not.toHaveBeenCalled();
});

it.each(['empty', 'failed'] as const)('keeps the previous saved route on a %s catalog and fills the pending model after a successful retry', async (outcome) => {
  modelSwitchFixture();
  if (outcome === 'failed')
    vi.mocked(window.electronAPI.voiceConversation.voices).mockRejectedValueOnce(new Error('offline'));
  else vi.mocked(window.electronAPI.voiceConversation.voices).mockResolvedValueOnce({ source: 'provider', voices: [] });
  renderSettings();
  await switchToSecondModel();
  expect((await screen.findByLabelText('bots.voiceMode.voiceId') as HTMLInputElement).value).toBe('');
  expect(window.electronAPI.voiceConversation.setPreference).not.toHaveBeenCalled();
  vi.mocked(window.electronAPI.voiceConversation.voices).mockResolvedValue({
    source: 'provider', voices: [{ id: 'available', name: 'Available voice' }],
  });
  fireEvent.click(screen.getByRole('button', { name: 'bots.voiceMode.refreshVoices' }));
  await waitFor(() => expect(voicePicker().value).toBe('voice:available'));
  expect(window.electronAPI.voiceConversation.setPreference).toHaveBeenCalledExactlyOnceWith(
    'bot', { providerId: 'mine', agent: 'codex', modelId: 'second', voice: 'available' },
  );
});

it.each(['private-voice', ''])('preserves a manual voice draft "%s" against the pending model catalog', async (manualVoice) => {
  modelSwitchFixture();
  vi.mocked(window.electronAPI.voiceConversation.voices).mockResolvedValueOnce({ source: 'provider', voices: [] });
  renderSettings();
  await switchToSecondModel();
  const input = await screen.findByLabelText('bots.voiceMode.voiceId');
  let release!: (catalog: SpeechVoiceCatalog) => void;
  vi.mocked(window.electronAPI.voiceConversation.voices).mockReturnValueOnce(new Promise(resolve => { release = resolve; }));
  fireEvent.click(screen.getByRole('button', { name: 'bots.voiceMode.refreshVoices' }));
  await waitFor(() => expect(window.electronAPI.voiceConversation.voices).toHaveBeenCalledTimes(3));
  fireEvent.change(input, { target: { value: 'typing' } });
  fireEvent.change(input, { target: { value: manualVoice } });
  await act(async () => release({ source: 'provider', voices: [{ id: 'default', name: 'Default voice' }] }));
  expect((screen.getByLabelText('bots.voiceMode.voiceId') as HTMLInputElement).value).toBe(manualVoice);
  expect(voicePicker().value).toBe('manual');
  expect(window.electronAPI.voiceConversation.setPreference).not.toHaveBeenCalled();
});

it('discards pending automatic selection on reset and does not save defaults on page load', async () => {
  modelSwitchFixture();
  let release!: (catalog: SpeechVoiceCatalog) => void;
  vi.mocked(window.electronAPI.voiceConversation.voices).mockReturnValueOnce(new Promise(resolve => { release = resolve; }));
  renderSettings();
  await switchToSecondModel();
  vi.mocked(window.electronAPI.voiceConversation.voices).mockResolvedValue({
    source: 'provider', voices: [{ id: 'saved', name: 'Saved voice' }],
  });
  fireEvent.click(screen.getByRole('button', { name: 'bots.voiceMode.resetPreference' }));
  await waitFor(() => expect(window.electronAPI.voiceConversation.voices).toHaveBeenCalledTimes(3));
  await act(async () => release({ source: 'provider', voices: [{ id: 'late', name: 'Late voice' }] }));
  expect(voicePicker().value).toBe('');
  expect(window.electronAPI.voiceConversation.setPreference).toHaveBeenCalledExactlyOnceWith('bot', null, null);
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
  // Linux CI can enable model configuration before the voice catalog resolves.
  const preview = await screen.findByRole('button', { name: 'bots.voiceMode.preview' });
  expect(preview.hasAttribute('disabled')).toBe(true);
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

// Review regression: visibility is picker policy, not saved-route eligibility.
// Existing UI tests had only visible or missing routes (Renderer unit, mock bridge).
it('does not default to or offer unchecked speech models, while restoring a saved hidden selection', async () => {
  models = [
    { id: 'hidden', name: 'Saved hidden speech', pickerVisible: false, defaultVoice: 'alloy' },
    { id: 'unchecked', name: 'Unchecked speech', pickerVisible: false, defaultVoice: 'alloy' },
    { id: 'visible', name: 'Visible speech', defaultVoice: 'alloy' },
  ];
  expect(resolveVoiceConfiguration(models, null).selection?.modelId).toBe('visible');
  const saved = { modelId: 'hidden', voice: 'nova' };
  expect(resolveVoiceConfiguration(models, saved).selection).toEqual(saved);
  vi.mocked(window.electronAPI.voiceConversation.preference).mockResolvedValue({ selection: saved, customized: true });
  renderSettings();
  const field = await screen.findByRole('combobox', { name: 'bots.voiceMode.model' });
  await waitFor(() => expect((field as HTMLSelectElement).value).toBe(voiceModelKey(saved)));
  // The saved value remains displayed; other unchecked models are not offered.
  expect(within(field).queryByRole('option', { name: 'Unchecked speech' })).toBeNull();
  expect(screen.queryByText('bots.voiceMode.modelUnavailable')).toBeNull();
  expect(window.electronAPI.voiceConversation.setPreference).not.toHaveBeenCalled();
});

it('shows setup guidance when all speech models are hidden and there is no saved choice', async () => {
  models = [{ id: 'unchecked', name: 'Unchecked speech', pickerVisible: false, defaultVoice: 'alloy' }];
  expect(resolveVoiceConfiguration(models, null).selection).toBeNull();
  renderSettings();
  await screen.findByText('bots.voiceMode.noModels');
  expect(screen.queryByRole('combobox', { name: 'bots.voiceMode.model' })).toBeNull();
});

// Unit tier, actual settings/preview entry with the host boundary mocked: switching
// to Qwen must discard an unsupported speed without losing the selected connection.
it.each([
  ['qwen-tts', 'qwen3-tts-flash', 'Cherry', undefined],
  ['dashscope-tts', 'cosyvoice-v3-flash', 'longanyang', 1.5],
] as const)(
  'saves and previews the %s proxy override with native parameter limits',
  async (protocol, modelId, voice, speed) => {
    models = [{ id: modelId, name: modelId, providerId: 'proxy', agent: 'codex' }];
    vi.mocked(window.electronAPI.voiceConversation.preference).mockResolvedValue({
      selection: {
        providerId: 'proxy',
        agent: 'codex',
        modelId,
        protocol: 'openai',
        voice: 'old-voice',
        speed: 1.5,
      },
      customized: true,
    });
    renderSettings();
    const field = await screen.findByLabelText('bots.voiceMode.protocol');
    await waitFor(() => expect((field as HTMLSelectElement).disabled).toBe(false));
    await act(async () => {
      fireEvent.change(field, { target: { value: protocol } });
    });
    await waitFor(() =>
      expect(window.electronAPI.voiceConversation.setPreference).toHaveBeenLastCalledWith('bot', {
        providerId: 'proxy',
        agent: 'codex',
        modelId,
        protocol,
        voice,
        ...(speed === undefined ? {} : { speed }),
      }),
    );
    const slider = screen.queryByRole('slider', { name: 'bots.voiceMode.speed' });
    if (speed === undefined) expect(slider).toBeNull();
    else {
      expect(slider?.getAttribute('aria-valuemin')).toBe('0.5');
      expect(slider?.getAttribute('aria-valuemax')).toBe('2');
    }
    fireEvent.click(await screen.findByRole('button', { name: 'bots.voiceMode.preview' }));
    await waitFor(() =>
      expect(window.electronAPI.voiceConversation.preview).toHaveBeenCalledWith(
        expect.objectContaining({
          providerId: 'proxy',
          agent: 'codex',
          modelId,
          protocol,
          voice,
        }),
      ),
    );
    expect(vi.mocked(window.electronAPI.voiceConversation.preview).mock.calls[0][0].speed).toBe(
      speed,
    );
    expect(audio.start).not.toHaveBeenCalled();
  },
);
