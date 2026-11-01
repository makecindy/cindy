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
    speakerFiltered: false,
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
  coordinator.publish(HOST, { ready: true });
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

// Review rounds 2-4 all broke the same invariant: the line stays held from an accepted
// start until the call is closed. Any frame, including the host's not-yet-open one,
// used to release it. Interleaving of two windows and the host's frames.
it('holds the line from an accepted start through the host bringing the call up', () => {
  vi.useFakeTimers();
  const start = (id: string) =>
    ({ type: 'start', sessionId: id, bot: { id: `b-${id}`, name: id } }) as const;
  expect(coordinator.command(start('first'))).toBe(true);
  expect(coordinator.command(start('second'))).toBe(false); // before any host frame
  coordinator.publish(HOST, { status: status(false) }); // host mounted, not open yet
  vi.advanceTimersByTime(60_000); // a slow bring-up must not lapse the hold
  expect(coordinator.command(start('third'))).toBe(false);
  coordinator.publish(HOST, { level: 0.2 });
  expect(coordinator.command(start('fourth'))).toBe(false);
  coordinator.publish(HOST, { status: status(true) });
  expect(coordinator.command(start('fifth'))).toBe(false); // live
  coordinator.publish(HOST, { status: status(false) }); // closing
  expect(coordinator.command(start('sixth'))).toBe(true);
  coordinator.publish(HOST, { status: null }); // rejected or ended: released
  expect(coordinator.command(start('seventh'))).toBe(true);
  vi.useRealTimers();
});

it('releases a start the host never reacted to, but not one it acknowledged', () => {
  vi.useFakeTimers();
  const start = { type: 'start', sessionId: 's', bot: { id: 'b', name: 'B' } } as const;
  expect(coordinator.command(start)).toBe(true);
  vi.advanceTimersByTime(10_000);
  expect(coordinator.command(start)).toBe(true);
  vi.useRealTimers();
});

// Review finding: a start sent while the main window boots would be dropped
// yet acknowledged, reserving the line for nothing.
it('refuses a start until the host listens and again after it is gone', () => {
  const start = { type: 'start', sessionId: 's', bot: { id: 'b', name: 'B' } } as const;
  const fresh = new VoiceCallCoordinator();
  fresh.configure({ hostSender: () => HOST, send, onActiveChange });
  expect(fresh.command(start)).toBe(false);
  expect(send).not.toHaveBeenCalled();
  fresh.publish(HOST, { ready: true });
  expect(fresh.command(start)).toBe(true);
  fresh.windowGone(HOST);
  expect(fresh.command(start)).toBe(false);
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
  // The destroyed window no longer resolves as the host.
  coordinator.configure({ hostSender: () => null, send, onActiveChange });
  coordinator.windowGone(HOST);
  expect(onActiveChange).toHaveBeenLastCalledWith(false);
  expect(send).toHaveBeenLastCalledWith(OTHER, 'voice-conversation:call-status-changed', {
    status: null,
  });
});
