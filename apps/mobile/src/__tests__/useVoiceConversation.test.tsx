// @vitest-environment jsdom
import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => ({
  platform: 'ios', state: 'active', listeners: new Set<(state: string) => void>(),
  speechAvailable: true, speak: vi.fn(), language: 'en',
  translate: (key: string) => key,
}));
vi.mock('react-native', () => ({ Platform: { get OS() { return native.platform; } }, AppState: {
  get currentState() { return native.state; },
  addEventListener: (_event: string, listener: (state: string) => void) => {
    native.listeners.add(listener);
    return { remove: () => { native.listeners.delete(listener); } };
  },
} }));
vi.mock('react-i18next', async importOriginal => ({ ...await importOriginal<typeof import('react-i18next')>(), useTranslation: () => ({
  t: native.translate, i18n: { language: native.language },
}) }));
vi.mock('@/session/mobileVoiceSpeech', () => ({
  isMobileVoiceSpeechAvailable: () => native.speechAvailable,
  speakMobileVoiceReply: native.speak,
}));

import { useVoiceConversation } from '@/session/useVoiceConversation';
import { setMobileAuthOwner } from '@/auth/authOwnerGeneration';
import {
  clearVoiceConversationIntent, getPendingVoiceConversationIntent, receiveVoiceConversationIntent,
  takeVoiceConversationIntent, transferVoiceConversationToSession,
} from '@/session/voiceConversationIntent';
import { buildMobileMessageRenderItems } from '@/session/messageRenderModel';
import type { RemoteMessage } from '@/session/types';

/**
 * Test value: render the production hook with its real controller/intent/reply
 * adapters. This closes the screen ownership gap not covered by controller-only
 * tests: delayed scope cleanup, AppState/permission timing, one-shot login claims,
 * direct ASR callbacks and stop during navigation. Minimal failures are one
 * deferred native start/send/playback or a late prior-turn answer. Unit tier uses
 * DOM hook mounting, in-memory messages and fake timers; no native audio/network.
 */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function replyItems(clientId: string, answer = 'Answer', replyId = 'reply-1', streaming = false) {
  const row = (id: string, role: RemoteMessage['role'], content: string): RemoteMessage => ({
    id, clientId: id, sessionId: 'task-1', role, content, toolUseId: null,
    agentMeta: role === 'assistant' ? { isStreaming: streaming, turnCompleted: !streaming } : null,
    createdAt: '2026-10-20T00:00:00Z',
  });
  return buildMobileMessageRenderItems([row(clientId, 'user', 'Question'), row(replyId, 'assistant', answer)]);
}

type Options = Parameters<typeof useVoiceConversation>[0];
let options: Options;
let api: ReturnType<typeof useVoiceConversation>;
let root: Root;
let host: HTMLDivElement;
let draft = '';
let strict = false;
const target = { sessionId: 'task-1', deviceId: 'computer-1', clientId: 'message-1' };
function Screen() {
  api = useVoiceConversation(options);
  return <output>{`${api.visible}:${api.state}:${api.error ?? ''}`}</output>;
}
async function render(changes: Partial<Options> = {}) {
  options = { ...options, ...changes };
  await act(async () => { root.render(strict ? <StrictMode><Screen /></StrictMode> : <Screen />); });
}
async function foreground(state: string) {
  await act(async () => {
    native.state = state;
    for (const listener of native.listeners) listener(state);
  });
}
async function transcript(value: string) {
  draft = value;
  // The session composer updates outside React; exercise its direct ASR hook.
  await act(async () => { api.onTranscriptChanged(value); });
}
function handoff() {
  const id = options.requestId!;
  expect(takeVoiceConversationIntent(id)).toBe(true);
  expect(transferVoiceConversationToSession(id, target)).toBe(true);
  options = { ...options, sessionId: target.sessionId, scope: 'owner:computer-1:task-1' };
}
function holdSpeech() {
  const playback = deferred<'done' | 'cancelled'>();
  native.speak.mockImplementation((_value: string, input: { signal: AbortSignal }) => {
    input.signal.addEventListener('abort', () => playback.resolve('cancelled'), { once: true });
    return playback.promise;
  });
  return playback;
}
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  clearVoiceConversationIntent();
  setMobileAuthOwner('owner');
  native.platform = 'ios'; native.state = 'active'; native.listeners.clear(); native.speechAvailable = true;
  native.language = 'en'; native.speak.mockReset().mockResolvedValue('done');
  strict = false; draft = '';
  options = {
    requestId: receiveVoiceConversationIntent('/voice')!.id,
    scope: 'owner:new:computer-1', deviceId: 'computer-1', ready: true, focused: true,
    draft: '', getDraft: () => draft, voiceError: null,
    startListening: vi.fn(async () => undefined),
    finishListening: vi.fn(async () => draft || 'Question'),
    cancelListening: vi.fn(async () => undefined),
    send: vi.fn(async () => { draft = ''; return 'message-1'; }),
  };
  host = document.createElement('div'); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => { root.unmount(); });
  clearVoiceConversationIntent();
  vi.clearAllTimers(); vi.useRealTimers();
});

describe('voice conversation screen ownership', () => {
  // iOS-only scope: a restored route must not turn unsupported native speech
  // into an update prompt or take ownership of Android's ordinary dictation.
  it.each(['android', 'web'])('ignores a restored voice route and ordinary dictation on %s', async platform => {
    native.platform = platform;
    native.speechAvailable = false;
    await render();
    await act(async () => { api.resume(); api.submit(); api.onTranscriptChanged('Manual dictation'); });
    await render({ scope: 'owner:new:computer-2', deviceId: 'computer-2' });
    await act(async () => { root.unmount(); });
    root = createRoot(host);
    expect(api.visible).toBe(false);
    expect(api.error).toBeNull();
    expect(options.startListening).not.toHaveBeenCalled();
    expect(options.finishListening).not.toHaveBeenCalled();
    expect(options.send).not.toHaveBeenCalled();
    expect(options.cancelListening).not.toHaveBeenCalled();
    expect(native.speak).not.toHaveBeenCalled();
  });

  it('does not cancel ordinary dictation when an unclaimed task page changes scope or unmounts', async () => {
    const cancel = options.cancelListening;
    await render({ requestId: null });
    await render({ scope: 'owner:new:computer-2', deviceId: 'computer-2' });
    await act(async () => { root.unmount(); });
    root = createRoot(host);
    expect(cancel).not.toHaveBeenCalled();
    expect(options.startListening).not.toHaveBeenCalled();
  });

  it('keeps a launch through device discovery and waits for foreground, focus and unblocked readiness', async () => {
    native.state = 'inactive';
    await render({ scope: 'owner:new:', deviceId: '', ready: false });
    await render({ scope: 'owner:new:computer-1', deviceId: 'computer-1', ready: true, focused: false });
    expect(getPendingVoiceConversationIntent()?.id).toBe(options.requestId);
    await foreground('active');
    await render({ focused: true, blocked: true });
    await render({ blocked: false, voiceError: 'Old ASR error' });
    expect(options.startListening).not.toHaveBeenCalled();
    await render({ voiceError: null });
    await render();
    expect(options.startListening).toHaveBeenCalledOnce();
    expect(api.state).toBe('listening');
  });

  it('starts once under StrictMode and cannot replay a consumed route after remount', async () => {
    strict = true;
    await render();
    expect(options.startListening).toHaveBeenCalledOnce();
    expect(api.state).toBe('listening');
    native.language = 'zh-CN';
    await render();
    expect(options.startListening).toHaveBeenCalledOnce();
    await act(async () => { root.unmount(); });
    root = createRoot(host);
    await render();
    expect(api.visible).toBe(false);
    expect(options.startListening).toHaveBeenCalledOnce();
  });

  it('cancels a launch when the user leaves while device readiness is still pending', async () => {
    await render({ ready: false });
    await render({ focused: false });
    await render({ focused: true, ready: true });
    expect(getPendingVoiceConversationIntent()).toBeNull();
    expect(options.startListening).not.toHaveBeenCalled();
  });

  it.each(['draft', 'native'] as const)('leaves the composer untouched when %s blocks activation', async reason => {
    strict = true;
    if (reason === 'draft') draft = 'Unsent typed message';
    else native.speechAvailable = false;
    await render();
    expect(options.startListening).not.toHaveBeenCalled();
    expect(api.visible).toBe(true);
    expect(api.error).toBe(`session.voiceConversation.${reason === 'draft' ? 'existingDraft' : 'updateRequired'}`);
    await act(async () => { api.resume(); });
    expect(options.send).not.toHaveBeenCalled();
    expect(draft).toBe(reason === 'draft' ? 'Unsent typed message' : '');
  });

  it.each(['focus', 'background'] as const)('pauses for %s loss and requires an explicit resume', async reason => {
    await render();
    if (reason === 'focus') await render({ focused: false });
    else await foreground('background');
    expect(api.state).toBe('paused');
    expect(options.cancelListening).toHaveBeenCalledOnce();
    if (reason === 'focus') await render({ focused: true });
    else await foreground('active');
    expect(options.startListening).toHaveBeenCalledOnce();
    await act(async () => { api.resume(); });
    expect(options.startListening).toHaveBeenCalledTimes(2);
  });

  it.each([true, false])('allows a permission sheet but checks foreground again after startup (returns=%s)', async returns => {
    const starting = deferred<void>();
    options.startListening = vi.fn(() => starting.promise);
    await render();
    await foreground('background');
    expect(options.cancelListening).not.toHaveBeenCalled();
    if (returns) await foreground('active');
    await act(async () => { starting.resolve(); });
    expect(api.state).toBe(returns ? 'listening' : 'paused');
    expect(options.send).not.toHaveBeenCalled();
  });

  it('pauses on ASR failure and preserves the partial draft instead of sending it', async () => {
    await render();
    await transcript('Keep these words');
    await render({ voiceError: 'Recognition failed' });
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(api.error).toBe('Recognition failed');
    expect(api.state).toBe('paused');
    expect(options.send).not.toHaveBeenCalled();
    expect(draft).toBe('Keep these words');
    await act(async () => { api.resume(); });
    expect(options.startListening).toHaveBeenCalledOnce();
  });

  it('finishes old-scope capture cleanup before starting the replacement and never cancels its adapters', async () => {
    const starting = deferred<void>();
    const order: string[] = [];
    const oldCancel = vi.fn(async () => { order.push('cancel-old'); });
    await render({ startListening: vi.fn(() => starting.promise), cancelListening: oldCancel });
    const newCancel = vi.fn(async () => { order.push('cancel-new'); });
    const newStart = vi.fn(async () => { order.push('start-new'); });
    await render({ requestId: receiveVoiceConversationIntent('/voice')!.id, scope: 'owner:new:computer-2',
      deviceId: 'computer-2', startListening: newStart, cancelListening: newCancel });
    expect(newStart).not.toHaveBeenCalled();
    await act(async () => { starting.resolve(); });
    expect(newStart).toHaveBeenCalledOnce();
    expect(newCancel).not.toHaveBeenCalled();
    expect(order.at(-1)).toBe('start-new');
    expect(api.state).toBe('listening');
  });

  it.each(['stop', 'focus', 'background'] as const)('cannot transfer a first send after %s ends its ownership', async action => {
    const sending = deferred<string>();
    options.send = vi.fn(() => sending.promise);
    await render();
    await transcript('Question');
    await act(async () => { api.submit(); });
    expect(api.canHandoff()).toBe(true);
    if (action === 'stop') await act(async () => { api.stop(); });
    else if (action === 'focus') await render({ focused: false });
    else await foreground('background');
    expect(api.canHandoff()).toBe(false);
    expect(transferVoiceConversationToSession(options.requestId!, target)).toBe(false);
    await act(async () => { sending.resolve('message-1'); });
    expect(api.visible).toBe(false);
    expect(native.speak).not.toHaveBeenCalled();
  });
});

describe('voice conversation reply handoff', () => {
  it('keeps a transferred first message through the actual new-to-task scope change', async () => {
    const id = options.requestId!;
    options.send = vi.fn(async () => {
      draft = '';
      expect(transferVoiceConversationToSession(id, target)).toBe(true);
      return target.clientId;
    });
    await render();
    await transcript('Question');
    await act(async () => { api.submit(); });
    await render({ scope: 'owner:computer-1:task-1', sessionId: target.sessionId });
    expect(api.visible).toBe(true);
    expect(api.state).toBe('waiting');
    expect(options.startListening).toHaveBeenCalledOnce();
  });

  it('waits for the completed associated answer, speaks it, then captures exactly one new turn', async () => {
    handoff();
    const playback = holdSpeech();
    await render();
    expect(api.state).toBe('waiting');
    expect(options.startListening).not.toHaveBeenCalled();
    await render({ items: replyItems('message-1', 'Partial', 'reply-1', true) });
    await render({ items: replyItems('message-1'), running: true });
    expect(native.speak).not.toHaveBeenCalled();
    await render({ running: false });
    expect(api.state).toBe('speaking');
    expect(native.speak.mock.calls[0]?.[0]).toBe('Answer');
    expect(options.startListening).not.toHaveBeenCalled();
    await act(async () => { playback.resolve('done'); });
    expect(api.state).toBe('listening');
    expect(options.startListening).toHaveBeenCalledOnce();
    await render();
    expect(native.speak).toHaveBeenCalledOnce();
  });

  it('aborts only its own playback on End and does not reopen the microphone', async () => {
    handoff(); holdSpeech();
    await render({ items: replyItems('message-1') });
    const signal = native.speak.mock.calls[0]?.[1].signal as AbortSignal;
    await act(async () => { api.stop(); });
    expect(signal.aborted).toBe(true);
    expect(api.visible).toBe(false);
    expect(options.startListening).not.toHaveBeenCalled();
  });

  it('keeps text typed during playback out of the next automatic capture', async () => {
    handoff(); const playback = holdSpeech();
    await render({ items: replyItems('message-1') });
    draft = 'Typed while waiting';
    await act(async () => { playback.resolve('done'); });
    expect(api.state).toBe('paused');
    expect(api.error).toBe('session.voiceConversation.existingDraft');
    expect(options.startListening).not.toHaveBeenCalled();
    expect(draft).toBe('Typed while waiting');
  });

  it('uses direct ASR updates and rejects a late old answer while waiting for the next send ID', async () => {
    handoff();
    await render({ items: replyItems('message-1') });
    expect(options.startListening).toHaveBeenCalledOnce();
    const sending = deferred<string>();
    options.send = vi.fn(() => sending.promise);
    await render();
    await transcript('Next question');
    await act(async () => { await vi.advanceTimersByTimeAsync(1_800); });
    expect(options.send).toHaveBeenCalledExactlyOnceWith('Next question');
    await render({ items: replyItems('message-1', 'Late old answer', 'reply-old-late') });
    expect(native.speak).toHaveBeenCalledOnce();
    draft = '';
    await act(async () => { sending.resolve('message-2'); });
    await render({ items: replyItems('message-2', 'Next answer', 'reply-2') });
    expect(native.speak).toHaveBeenCalledTimes(2);
    expect(native.speak.mock.calls[1]?.[0]).toBe('Next answer');
  });
});
