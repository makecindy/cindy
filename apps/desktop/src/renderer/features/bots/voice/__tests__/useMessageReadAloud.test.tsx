// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { VoiceConversationApi } from '@/../shared/voiceConversation';
import { useMessageReadAloud } from '../useMessageReadAloud';

const h = vi.hoisted(() => ({
  close: vi.fn(),
  warning: vi.fn(),
  t: (key: string) => key,
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: h.t }) }));
vi.mock('@/lib/logger', () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn() }) }));
vi.mock('@/lib/toast', () => ({ toast: { warning: h.warning } }));
vi.mock('@/contexts/dataOwnerGeneration', () => ({
  getDataOwnerGeneration: () => ({ dataOwnerId: 'owner', generation: 1 }),
}));
vi.mock('../PcmSpeechPlayer', () => ({
  PcmSpeechPlayer: class {
    close = h.close;
    pause() {}
    resume() {}
    cancel() {}
    play(_read: unknown, _rate: number, onStarted: () => void) {
      onStarted();
      return new Promise<void>(() => {});
    }
  },
}));
const selection = { modelId: 'speech', voice: 'saved-voice' };
const options = { botId: 'bot', sessionId: 'task', enabled: true, voiceModeOpen: false };
let settingsChanged: () => void;
let providersChanged: () => void;
let powerChanged: () => void;
let authChanged: (state: {
  dataOwnerId: string;
  ownerGeneration: number;
  ownerBoundaryPending?: boolean;
}) => void;
let api: ReturnType<typeof makeApi>;
function makeApi() {
  return {
    models: vi.fn<VoiceConversationApi['models']>(async () => [
      { id: 'speech', name: 'Speech', protocol: 'openai' },
    ]),
    preference: vi.fn<VoiceConversationApi['preference']>(async () => ({
      selection,
      customized: true,
    })),
    startPlayback: vi.fn<VoiceConversationApi['startPlayback']>(async ({ callId }) => ({ callId })),
    end: vi.fn<VoiceConversationApi['end']>(async () => {}),
    speak: vi.fn<VoiceConversationApi['speak']>(async () => ({ sampleRate: 24000 })),
    readSpeech: vi.fn<VoiceConversationApi['readSpeech']>(async () => ({
      pcm: new ArrayBuffer(2),
      done: true,
    })),
    onEvent: vi.fn(() => () => {}),
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  api = makeApi();
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      voiceConversation: api,
      voiceInput: {
        onDataChanged: (callback: () => void) => {
          settingsChanged = callback;
          return () => {};
        },
        onPowerStateChange: (callback: () => void) => {
          powerChanged = callback;
          return () => {};
        },
      },
      maker: {
        onProvidersChanged: (callback: () => void) => {
          providersChanged = callback;
          return () => {};
        },
      },
      onAuthStateChange: (callback: typeof authChanged) => {
        authChanged = callback;
        return () => {};
      },
    },
  });
});
afterEach(cleanup);

it('advertises only a saved usable selection and rechecks it on every click', async () => {
  api.preference.mockResolvedValue({ selection: null, customized: false });
  const { result } = renderHook(() => useMessageReadAloud(options));
  await waitFor(() => expect(api.preference).toHaveBeenCalled());
  expect(result.current.value?.available).toBe(false);
  expect(api.startPlayback).not.toHaveBeenCalled();
  api.preference.mockResolvedValue({ selection, customized: true });
  act(() => settingsChanged());
  await waitFor(() => expect(result.current.value?.available).toBe(true));
  // The saved route has been disabled since the last display refresh.
  api.models.mockResolvedValue([]);
  act(() => result.current.value?.toggle('reply', 'hello'));
  await waitFor(() => expect(h.warning).toHaveBeenCalled());
  expect(api.startPlayback).not.toHaveBeenCalled();
  expect(result.current.value?.available).toBe(false);
});

it('updates discovery without defaulting to another connection with the same model ID', async () => {
  const { result } = renderHook(() => useMessageReadAloud(options));
  await waitFor(() => expect(result.current.value?.available).toBe(true));
  api.models.mockResolvedValue([
    {
      id: 'speech',
      name: 'Another',
      providerId: 'another',
      agent: 'codex',
      protocol: 'elevenlabs',
    },
  ]);
  act(() => providersChanged());
  await waitFor(() => expect(result.current.value?.available).toBe(false));
  expect(api.startPlayback).not.toHaveBeenCalled();
});

it('toggles the selected message, stops on leaving, and disables playback during voice mode', async () => {
  const { result, rerender } = renderHook((props) => useMessageReadAloud(props), {
    initialProps: options,
  });
  await waitFor(() => expect(result.current.value?.available).toBe(true));
  act(() => result.current.value?.toggle('reply', 'hello'));
  await waitFor(() => expect(result.current.value?.phase).toBe('playing'));
  expect(api.startPlayback).toHaveBeenCalledWith(
    expect.objectContaining({ ...selection, botId: 'bot', sessionId: 'task' }),
  );
  act(() => result.current.value?.toggle('reply', 'hello'));
  await waitFor(() => expect(result.current.value?.phase).toBe('idle'));
  expect(h.close).toHaveBeenCalledOnce();
  rerender({ ...options, voiceModeOpen: true });
  expect(result.current.value?.disabled).toBe(true);
  act(() => result.current.value?.toggle('reply', 'hello'));
  expect(api.startPlayback).toHaveBeenCalledOnce();
  rerender(options);
  act(() => result.current.value?.toggle('reply', 'hello'));
  await waitFor(() => expect(api.startPlayback).toHaveBeenCalledTimes(2));
  rerender({ ...options, enabled: false });
  expect(result.current.value).toBeNull();
  expect(h.close).toHaveBeenCalledTimes(2);
});

it.each(['account', 'suspend'] as const)(
  'cancels on %s and never resumes audio automatically',
  async (boundary) => {
    const { result } = renderHook(() => useMessageReadAloud(options));
    await waitFor(() => expect(result.current.value?.available).toBe(true));
    act(() => result.current.value?.toggle('reply', 'hello'));
    await waitFor(() => expect(result.current.value?.phase).toBe('playing'));
    act(() => {
      if (boundary === 'account') authChanged({ dataOwnerId: 'next', ownerGeneration: 2 });
      else powerChanged();
    });
    expect(h.close).toHaveBeenCalledOnce();
    expect(result.current.value?.phase).toBe('idle');
    expect(api.startPlayback).toHaveBeenCalledOnce();
  },
);

it('cancels a pending handover to microphone mode when the system suspends', async () => {
  const { result } = renderHook(() => useMessageReadAloud(options));
  await waitFor(() => expect(result.current.value?.available).toBe(true));
  act(() => result.current.value?.toggle('reply', 'hello'));
  await waitFor(() => expect(result.current.value?.phase).toBe('playing'));
  let release!: () => void;
  api.end.mockReturnValueOnce(
    new Promise<void>((resolve) => {
      release = resolve;
    }),
  );
  let handover!: Promise<boolean>;
  act(() => {
    handover = result.current.stopForVoiceMode();
  });
  act(() => powerChanged());
  release();
  await expect(handover).resolves.toBe(false);
});

it('ignores a late old-companion configuration result after navigating to another companion', async () => {
  const { result, rerender } = renderHook((props) => useMessageReadAloud(props), {
    initialProps: options,
  });
  await waitFor(() => expect(result.current.value?.available).toBe(true));
  let resolve!: (value: Awaited<ReturnType<VoiceConversationApi['preference']>>) => void;
  api.preference.mockReturnValueOnce(
    new Promise((done) => {
      resolve = done;
    }),
  );
  const previousReads = api.preference.mock.calls.length;
  act(() => result.current.value?.toggle('old-reply', 'hello'));
  await waitFor(() => expect(api.preference.mock.calls.length).toBeGreaterThan(previousReads));
  rerender({ ...options, botId: 'next-bot', sessionId: 'next-task' });
  await waitFor(() => expect(result.current.value?.available).toBe(true));
  await act(async () => {
    resolve({ selection, customized: true });
  });
  expect(result.current.value?.sessionId).toBe('next-task');
  expect(result.current.value?.available).toBe(true);
  expect(api.startPlayback).not.toHaveBeenCalled();
});
