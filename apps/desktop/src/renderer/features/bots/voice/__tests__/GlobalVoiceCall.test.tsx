// @vitest-environment jsdom
import { useState } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    i18n: { language: 'en', resolvedLanguage: 'en' },
    t: (key: string) => key,
  }),
}));
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn() }),
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
    close = vi.fn();
    pause() {}
    resume() {}
    cancel() {}
    async play() {}
  },
}));
const chat = vi.hoisted(() => ({
  light: { pendingPermission: null as unknown, pendingAskUser: null as unknown },
  full: { messages: [] },
  listeners: new Set<() => void>(),
}));
vi.mock('@/lib/makerChatStore', () => ({
  makerChatStore: {
    subscribeLight: (_id: string, listener: () => void) => {
      chat.listeners.add(listener);
      return () => chat.listeners.delete(listener);
    },
    subscribe: () => () => {},
    getLightSnapshot: () => chat.light,
    getSnapshot: () => chat.full,
  },
}));
vi.mock('@/hooks/useSessionBinding', () => ({
  useSessionBinding: () => ({ attached: false }),
}));

import type { VoiceCallCommand } from '@/../shared/voiceConversation';
import {
  GlobalVoiceCallHost,
  RemoteVoiceCallSurface,
  VoiceCallComposerSlot,
  VoiceCallFloatingSlot,
} from '../GlobalVoiceCall';
import { sendVoiceCallCommand } from '../voiceCallStore';

const start = vi.fn(async (input: { callId: string }) => ({ callId: input.callId }));
const end = vi.fn(async () => {});
const publishCallStatus = vi.fn();
const bridge = { current: null };
const startCommand = (sessionId: string, name = 'Partner'): VoiceCallCommand => ({
  type: 'start',
  sessionId,
  bot: { id: `bot-${sessionId}`, name },
});

beforeEach(() => {
  vi.clearAllMocks();
  chat.light = { pendingPermission: null, pendingAskUser: null };
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      voiceConversation: {
        models: async () => [{ id: 'tts', name: 'Speech', defaultVoice: 'alloy' }],
        preference: async () => ({ selection: null, customized: false }),
        start,
        end,
        interrupt: vi.fn(async () => {}),
        onEvent: () => () => {},
        callStatus: async () => null,
        publishCallStatus,
        callCommand: vi.fn(async () => ({ ok: true })),
        onCallStatus: () => () => {},
        onCallCommand: () => () => {},
        submitTurn: vi.fn(async () => true),
      },
      voiceInput: { onPowerStateChange: () => () => {} },
      onAuthStateChange: () => () => {},
    },
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

/** The main window: a host beside a route that can swap task pages. */
function MainWindow() {
  const [page, setPage] = useState<string | null>('a');
  return (
    <MemoryRouter>
      <VoiceCallFloatingSlot />
      <GlobalVoiceCallHost />
      <button onClick={() => setPage('b')}>go-b</button>
      <button onClick={() => setPage(null)}>go-settings</button>
      <button onClick={() => setPage('a')}>go-a</button>
      {page ? (
        <section key={page} data-testid={`page-${page}`}>
          <VoiceCallComposerSlot sessionId={page} questionBridge={bridge} openTask={vi.fn()} />
        </section>
      ) : null}
    </MemoryRouter>
  );
}

const begin = async (sessionId = 'a') => {
  let accepted = false;
  await act(async () => {
    accepted = await sendVoiceCallCommand(startCommand(sessionId));
  });
  await act(async () => {});
  return accepted;
};
const phase = () => screen.getByRole('status').textContent;

// User requirement 2026-11-01: a call is independent of the task page, and only
// one exists at a time. The old panel lived in the page, so route unmount ended
// it. jsdom with the real host, panel and controller; fake audio and IPC.
it('keeps capture running while task pages unmount and draws the bar where it can', async () => {
  render(<MainWindow />);
  expect(await begin()).toBe(true);
  expect(start).toHaveBeenCalledTimes(1);
  expect(audio.start).toHaveBeenCalledTimes(1);
  expect(screen.getByTestId('page-a').querySelector('.companion-voice-toolbar')).toBeTruthy();

  fireEvent.click(screen.getByText('go-b'));
  await act(async () => {});
  expect(screen.queryByTestId('page-a')).toBeNull();
  expect(screen.getByTestId('page-b').querySelector('.companion-voice-toolbar')).toBeNull();
  expect(
    document.querySelector('.companion-voice-floating-slot .companion-voice-toolbar'),
  ).toBeTruthy();
  expect(screen.getByRole('button', { name: 'bots.voiceMode.openConversation' })).toBeTruthy();

  fireEvent.click(screen.getByText('go-a'));
  await act(async () => {});
  expect(screen.getByTestId('page-a').querySelector('.companion-voice-toolbar')).toBeTruthy();
  expect(start).toHaveBeenCalledTimes(1);
  expect(audio.start).toHaveBeenCalledTimes(1);
  expect(audio.stop).not.toHaveBeenCalled();
  expect(end).not.toHaveBeenCalled();
});

it('refuses a second call and ends the first only when asked', async () => {
  vi.useFakeTimers();
  render(<MainWindow />);
  await begin();
  await act(async () => {
    expect(await sendVoiceCallCommand(startCommand('b', 'Second'))).toBe(false);
  });
  expect(start).toHaveBeenCalledTimes(1);
  expect(screen.getByTestId('page-a').querySelector('.companion-voice-toolbar')).toBeTruthy();

  fireEvent.click(screen.getByRole('button', { name: /bots.voiceMode.end/ }));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(400);
  });
  expect(end).toHaveBeenCalledTimes(1);
  expect(audio.stop).toHaveBeenCalled();
  expect(publishCallStatus).toHaveBeenLastCalledWith({ status: null });
  expect(document.querySelector('.companion-voice-toolbar')).toBeNull();
  expect(await begin('b')).toBe(true);
  expect(start).toHaveBeenCalledTimes(2);
});

// With the page gone nothing else would release the microphone for a pending
// approval: the host has to read that from the store.
it('pauses for a permission prompt of a task that is not on screen', async () => {
  render(<MainWindow />);
  await begin();
  fireEvent.click(screen.getByText('go-settings'));
  await act(async () => {});
  await act(async () => {
    chat.light = { ...chat.light, pendingPermission: { id: 'p' } };
    for (const listener of chat.listeners) listener();
  });
  expect(phase()).toBe('bots.voiceMode.status.confirmation');
  expect(audio.stop).toHaveBeenCalled();
});

it('routes speech normally while the question card is off screen', async () => {
  render(<MainWindow />);
  await begin();
  fireEvent.click(screen.getByText('go-settings'));
  await act(async () => {});
  await act(async () => {
    chat.light = { ...chat.light, pendingAskUser: { id: 'q' } };
    for (const listener of chat.listeners) listener();
  });
  expect(phase()).toBe('bots.voiceMode.status.questionElsewhere');
  expect(audio.stop).not.toHaveBeenCalled();
});

// A secondary window has no capture: its controls must reach the main window.
it('forwards operations from a window that only shows the call', async () => {
  let receive: (update: unknown) => void = () => {};
  window.electronAPI.voiceConversation.onCallStatus = (callback) => {
    receive = callback as typeof receive;
    return () => {};
  };
  render(
    <MemoryRouter>
      <VoiceCallFloatingSlot />
      <RemoteVoiceCallSurface />
    </MemoryRouter>,
  );
  await act(async () => {});
  expect(document.querySelector('.companion-voice-toolbar')).toBeNull();
  await act(async () => {
    receive({
      status: {
        open: true,
        bot: { id: 'bot-a', name: 'Partner' },
        sessionId: 'a',
        callId: 'call',
        state: {
          phase: 'listening',
          transcript: '',
          unsent: '',
          level: 0,
          error: null,
          muted: false,
          microphonePending: false,
          microphoneError: false,
          exitCountdown: null,
        },
        loading: false,
        blocked: false,
        configurationError: false,
        questionPending: false,
        questionElsewhere: false,
      },
    });
  });
  await act(async () => {});
  fireEvent.click(screen.getByRole('button', { name: /bots.voiceMode.end/ }));
  expect(window.electronAPI.voiceConversation.callCommand).toHaveBeenCalledWith({
    type: 'end',
    sessionId: 'a',
  });
  expect(start).not.toHaveBeenCalled();
});
