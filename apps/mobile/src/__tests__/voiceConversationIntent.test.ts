import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const native = vi.hoisted(() => ({ platform: 'ios' }));
vi.mock('react-native', () => ({ Platform: { get OS() { return native.platform; } } }));

import { invalidateMobileAuthOwnerForSwitch, setMobileAuthOwner } from '@/auth/authOwnerGeneration';
import {
  clearVoiceConversationIntent,
  clearUntransferredVoiceConversationIntent,
  getPendingVoiceConversationIntent,
  receiveVoiceConversationIntent,
  subscribeVoiceConversationIntent,
  takeVoiceConversationIntent,
  takeVoiceConversationSessionHandoff,
  transferVoiceConversationToSession,
} from '@/session/voiceConversationIntent';

// Test value: exercise the production launch/claim/handoff API. The new shortcut
// contract must preserve the first login, isolate account changes and never reopen
// a mic from restored route state. Existing nativeIntent tests cover navigation,
// not these consumption races. Minimal inputs: one launch ID, one owner change,
// or a stale destination. Unit tier uses memory and fake timers only.

beforeEach(() => {
  vi.useFakeTimers();
  native.platform = 'ios';
  clearVoiceConversationIntent();
  setMobileAuthOwner(null);
});
afterEach(() => {
  clearVoiceConversationIntent();
  vi.useRealTimers();
});

describe('voice conversation launch ownership', () => {
  // iOS-only scope: even an inherited launch/handoff ID cannot enable capture
  // on another platform. Existing ownership tests only exercise signed-in iOS.
  it.each(['android', 'web'])('refuses launch reception, claims and handoff on %s', platform => {
    setMobileAuthOwner('first');
    const intent = receiveVoiceConversationIntent('/voice')!;
    native.platform = platform;
    expect(receiveVoiceConversationIntent('/voice')).toBeNull();
    expect(getPendingVoiceConversationIntent()).toBeNull();
    expect(takeVoiceConversationIntent(intent.id)).toBe(false);
    const target = { sessionId: 'task-1', deviceId: 'computer-1', clientId: 'message-1' };
    expect(transferVoiceConversationToSession(intent.id, target)).toBe(false);
    native.platform = 'ios';
    expect(takeVoiceConversationIntent(intent.id)).toBe(true);
    expect(transferVoiceConversationToSession(intent.id, target)).toBe(true);
    native.platform = platform;
    expect(takeVoiceConversationSessionHandoff(intent.id, target)).toBeNull();
  });

  it('survives the first login and grants only one microphone start', () => {
    const intent = receiveVoiceConversationIntent('cindy://voice')!;
    expect(takeVoiceConversationIntent(intent.id)).toBe(false);
    expect(getPendingVoiceConversationIntent()).toBe(intent);
    setMobileAuthOwner('first', 'global');
    expect(takeVoiceConversationIntent(intent.id)).toBe(true);
    expect(getPendingVoiceConversationIntent()).toBeNull();
    expect(takeVoiceConversationIntent(intent.id)).toBe(false);
  });

  it('gives repeated shortcut events different IDs and ignores cleanup from an older page', () => {
    setMobileAuthOwner('first');
    const first = receiveVoiceConversationIntent('/voice')!;
    const next = receiveVoiceConversationIntent('/voice')!;
    expect(next.id).not.toBe(first.id);
    clearVoiceConversationIntent(first.id);
    expect(takeVoiceConversationIntent(first.id)).toBe(false);
    expect(takeVoiceConversationIntent(next.id)).toBe(true);
  });

  it.each(['logout', 'switch', 'realm'] as const)('invalidates an unclaimed launch on %s', change => {
    setMobileAuthOwner('first');
    const intent = receiveVoiceConversationIntent('/voice')!;
    if (change === 'logout') setMobileAuthOwner(null);
    else if (change === 'switch') invalidateMobileAuthOwnerForSwitch();
    else setMobileAuthOwner('first', 'cn');
    expect(getPendingVoiceConversationIntent()).toBeNull();
    setMobileAuthOwner('next');
    expect(takeVoiceConversationIntent(intent.id)).toBe(false);
  });

  it('expires a pending launch and publishes cancellation to subscribers', () => {
    setMobileAuthOwner('first');
    const changed = vi.fn();
    const unsubscribe = subscribeVoiceConversationIntent(changed);
    try {
      const intent = receiveVoiceConversationIntent('/voice')!;
      changed.mockClear();
      vi.advanceTimersByTime(intent.expiresAt - Date.now());
      expect(changed).toHaveBeenCalledOnce();
      expect(getPendingVoiceConversationIntent()).toBeNull();
      expect(takeVoiceConversationIntent(intent.id)).toBe(false);
    } finally {
      unsubscribe();
    }
  });

  it('rejects a delayed timer launch after its wall-clock expiry', () => {
    setMobileAuthOwner('first');
    const intent = receiveVoiceConversationIntent('/voice')!;
    vi.setSystemTime(intent.expiresAt);
    expect(takeVoiceConversationIntent(intent.id)).toBe(false);
    expect(getPendingVoiceConversationIntent()).toBeNull();
  });
});

describe('voice conversation task handoff', () => {
  const target = { sessionId: 'task-1', deviceId: 'computer-1', clientId: 'message-1' };

  it('cancels an unfinished launch but preserves a transferred handoff during screen cleanup', () => {
    setMobileAuthOwner('first');
    const first = receiveVoiceConversationIntent('/voice')!;
    takeVoiceConversationIntent(first.id);
    clearUntransferredVoiceConversationIntent(first.id);
    expect(transferVoiceConversationToSession(first.id, target)).toBe(false);
    const second = receiveVoiceConversationIntent('/voice')!;
    takeVoiceConversationIntent(second.id);
    transferVoiceConversationToSession(second.id, target);
    clearUntransferredVoiceConversationIntent(second.id);
    expect(takeVoiceConversationSessionHandoff(second.id, target)).toEqual(target);
  });

  it('hands the first sent message to its exact task and device once', () => {
    setMobileAuthOwner('first');
    const intent = receiveVoiceConversationIntent('/voice')!;
    expect(transferVoiceConversationToSession(intent.id, target)).toBe(false);
    expect(takeVoiceConversationIntent(intent.id)).toBe(true);
    expect(transferVoiceConversationToSession(intent.id, target)).toBe(true);
    expect(transferVoiceConversationToSession(intent.id, target)).toBe(false);
    expect(takeVoiceConversationSessionHandoff(intent.id, { ...target, deviceId: 'other' })).toBeNull();
    expect(takeVoiceConversationSessionHandoff(intent.id, { ...target, sessionId: 'other' })).toBeNull();
    expect(takeVoiceConversationSessionHandoff(intent.id, target)).toEqual(target);
    expect(takeVoiceConversationSessionHandoff(intent.id, target)).toBeNull();
    expect(takeVoiceConversationIntent(intent.id)).toBe(false);
  });

  it.each(['claimed', 'handoff'] as const)('does not carry a %s launch across accounts', phase => {
    setMobileAuthOwner('first');
    const intent = receiveVoiceConversationIntent('/voice')!;
    takeVoiceConversationIntent(intent.id);
    if (phase === 'handoff') transferVoiceConversationToSession(intent.id, target);
    invalidateMobileAuthOwnerForSwitch();
    setMobileAuthOwner('next');
    expect(transferVoiceConversationToSession(intent.id, target)).toBe(false);
    expect(takeVoiceConversationSessionHandoff(intent.id, target)).toBeNull();
  });

  it('expires an abandoned handoff without allowing a restored task route to resume it', () => {
    setMobileAuthOwner('first');
    const intent = receiveVoiceConversationIntent('/voice')!;
    takeVoiceConversationIntent(intent.id);
    transferVoiceConversationToSession(intent.id, target);
    vi.runAllTimers();
    expect(takeVoiceConversationSessionHandoff(intent.id, target)).toBeNull();
  });
});
