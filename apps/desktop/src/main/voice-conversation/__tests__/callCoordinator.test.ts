import { beforeEach, expect, it, vi } from 'vitest';
import type { VoiceCallStatus } from '../../../shared/voiceConversation.js';
import { VoiceCallCoordinator } from '../callCoordinator.js';

const HOST = 1;
const OTHER = 2;
const status = (open = true): VoiceCallStatus => ({
  open,
  bot: { id: 'bot', name: 'Partner' },
  sessionId: 'session',
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
});

const send = vi.fn();
const onActiveChange = vi.fn();
let coordinator: VoiceCallCoordinator;
beforeEach(() => {
  vi.clearAllMocks();
  coordinator = new VoiceCallCoordinator();
  coordinator.configure({ hostSender: () => HOST, send, onActiveChange });
});

// Product rule: one call per device, owned by the main window. Unit, real
// coordinator with fake senders. Standalone file validation: under 1s.
it('keeps the live call when another window tries to start a second one', () => {
  const start = { type: 'start', sessionId: 'other', bot: { id: 'b2', name: 'Second' } } as const;
  expect(coordinator.command(start)).toBe(true);
  coordinator.publish(HOST, { status: status() });
  send.mockClear();
  expect(coordinator.command(start)).toBe(false);
  expect(send).not.toHaveBeenCalled();
  expect(coordinator.command({ type: 'mute', sessionId: 'session' })).toBe(true);
  expect(send).toHaveBeenCalledWith(HOST, 'voice-conversation:call-command', {
    type: 'mute',
    sessionId: 'session',
  });
});

it('accepts status only from the main window and shows it only to windows that asked', () => {
  coordinator.publish(OTHER, { status: status() });
  expect(coordinator.subscribe(OTHER)).toBeNull();
  coordinator.subscribe(HOST);
  coordinator.publish(HOST, { status: status() });
  expect(send.mock.calls.map(([target]) => target)).toEqual([OTHER]);
  coordinator.publish(HOST, { level: 0.5 });
  const lateWindow = coordinator.subscribe(3);
  expect(lateWindow?.state.level).toBe(0.5);
  expect(send).toHaveBeenLastCalledWith(OTHER, 'voice-conversation:call-status-changed', {
    level: 0.5,
  });
});

// A reload or crash of the main window loses capture. Without this the other
// windows would keep showing a call and throttling would stay off.
it('clears a call whose main window is gone but not when another window closes', () => {
  coordinator.subscribe(OTHER);
  coordinator.subscribe(3);
  coordinator.publish(HOST, { status: status() });
  expect(onActiveChange).toHaveBeenLastCalledWith(true);
  coordinator.windowGone(3);
  expect(onActiveChange).toHaveBeenCalledTimes(1);
  coordinator.windowGone(HOST);
  expect(onActiveChange).toHaveBeenLastCalledWith(false);
  expect(send).toHaveBeenLastCalledWith(OTHER, 'voice-conversation:call-status-changed', {
    status: null,
  });
});
