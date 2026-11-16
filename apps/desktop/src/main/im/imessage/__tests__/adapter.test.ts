import { expect, it, vi } from 'vitest';
import { BlueBubblesIM, type IMMessageEvent } from '@cindy/im';
import type { InteractionRequest } from '@cindy/maker-core';
import type { SharedPermission } from '../../../maker-ipc/sharedPermission';
import { beginInteractionRoute, installDesktopInteractionHandler, requestHostInteraction } from '../../../maker-ipc/interactionRouter';
import type { ImChannelAdapter } from '../../shared/types';
import { wireIMessageOrchestrator } from '../adapter';

vi.mock('../../shared/orchestrator', () => ({ createImOrchestrator: (adapter: ImChannelAdapter) => adapter }));
vi.mock('../../shared/channelGroupWindow', () => ({ IMESSAGE_GROUP_WINDOW: {}, sanitizeGroupWindowName: (name: string) => name }));
vi.mock('../../shared/botImConnectionStore', () => ({ readBotImConnection: vi.fn() }));

// Tier 1: production adapter policy contract consumed by the shared turn runner.
// Review #9250: guest DM/group + Full access previously failed provider preflight.
// Shared runner tests cover dispatch, but cannot detect a missing channel hook.
it('honors Full access for guest DMs/groups while retaining policy in other modes and guest tool scope', () => {
  const acknowledgeIncoming = vi.fn();
  const adapter = wireIMessageOrchestrator({
    acknowledgeIncoming,
    isGroup: (id: string) => id.startsWith('any;+;'),
  } as never, {} as never, {
    instanceKey: 'test', companionBotId: 'bot-test', connectionId: 'connection-test',
  }) as unknown as ImChannelAdapter;
  for (const chatId of ['any;-;guest@example.test', 'any;+;group']) {
    const event = { contextId: 'bot-test', chatId, senderId: chatId, messageId: 'guest-message',
      speaker: { id: 'guest@example.test', name: 'Guest', isOwner: false } } as IMMessageEvent;
    const policy = adapter.turnPermissionPolicyFor!(event)!;
    expect(policy.autoReviewContext).toMatchObject({ requesterAuthority: 'guest' });
    expect(adapter.turnPolicyOptionalForMode?.('bypassPermissions', policy)).toBe(true);
    for (const mode of ['auto', 'ask', 'acceptEdits'] as const) {
      expect(adapter.turnPolicyOptionalForMode?.(mode, policy)).toBe(false);
    }
    expect(adapter.channelToolScopeFor?.(event)).toMatchObject({ chatId, requesterIsOwner: false });
    expect(adapter.turnPermissionPolicyFor!({ ...event, speaker: { ...event.speaker!, isOwner: true } })).toBeUndefined();
  }
  void adapter.onUserMessagePersisted!({ sessionId: 'session', userMessageId: 'failed', persisted: false });
  expect(acknowledgeIncoming).not.toHaveBeenCalled();
  void adapter.onUserMessagePersisted!({ sessionId: 'session', userMessageId: 'accepted', persisted: true });
  expect(acknowledgeIncoming).toHaveBeenCalledWith('accepted');
});

// Tier 1, #9250: exercise the production transport, adapter, text helper and shared router.
// Previous adapter policy tests did not cover presentation failure closing the Desktop decision.
it.each(['send-failed', 'group-only'])('keeps Desktop permission available when iMessage presentation is %s', async scenario => {
  const im = new BlueBubblesIM({} as never, {} as never);
  vi.spyOn(im, 'getOwnerUserId').mockReturnValue(scenario === 'group-only' ? null : 'owner');
  const send = vi.spyOn(im, 'sendText').mockRejectedValue(new Error('channel unavailable'));
  const adapter = wireIMessageOrchestrator(im, {} as never, {
    instanceKey: 'test', companionBotId: 'bot-test', connectionId: 'connection-test',
  }) as unknown as ImChannelAdapter;
  const session = { id: `imessage-permission-${scenario}`, setInteractionListener: vi.fn() };
  let desktop!: SharedPermission;
  installDesktopInteractionHandler(session, (_request, shared) => { desktop = shared!; return shared!.result; });
  const lease = beginInteractionRoute(session, {
    route: { sessionId: session.id, turnId: 'turn', origin: { kind: 'im', channel: 'imessage' }, interactionSurface: 'channel-card' },
    handle: (request, shared) => adapter.handleTextInteraction!('group', request, { sharedPermission: shared }),
  });
  try {
    const request = { kind: 'permission', requestId: `permission-${scenario}`, toolName: 'Read', input: {} } as InteractionRequest;
    const decision = requestHostInteraction(session, request, new AbortController().signal);
    // Drain the current event-loop turn, including presentation failure; no real timed wait.
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(send).toHaveBeenCalledTimes(scenario === 'group-only' ? 0 : 1);
    expect(desktop.decision).toBeUndefined();
    expect(desktop.decide({ kind: 'permission', behavior: 'allow' })).toBe(true);
    await expect(decision).resolves.toMatchObject({ kind: 'permission', behavior: 'allow' });
  } finally { lease.release(); await im.dispose(); }
});

// Tier 1, #9250: the real router must notify the adapter on route teardown.
// Existing shared-permission tests do not cancel non-shared multi-question text requests.
it.each(['abort', 'release'])('clears the matching question waiter on host %s', async action => {
  const im = new BlueBubblesIM({} as never, {} as never);
  vi.spyOn(im, 'sendText').mockResolvedValue({ messageId: 'question-prompt' });
  const requestReply = vi.spyOn(im, 'requestTextReply');
  const adapter = wireIMessageOrchestrator(im, {} as never, {
    instanceKey: 'cancel-test', companionBotId: 'bot-test', connectionId: 'connection-test',
  }) as unknown as ImChannelAdapter;
  const session = { id: `question-${action}`, setInteractionListener: vi.fn() };
  const controller = new AbortController();
  const lease = beginInteractionRoute(session, {
    route: { sessionId: session.id, turnId: 'turn', origin: { kind: 'im', channel: 'imessage' }, interactionSurface: 'channel-card' },
    handle: (request, shared) => adapter.handleTextInteraction!('group', request, { sharedPermission: shared }),
    onCancel: (id, decision) => adapter.cancelTextInteraction?.('group', id, decision),
  });
  try {
    const decision = requestHostInteraction(session, { kind: 'ask_user_question', requestId: 'abandoned',
      questions: [{ question: 'First?' }, { question: 'Second?' }] } as InteractionRequest, controller.signal);
    let settled = false;
    void decision.then(() => { settled = true; });
    await new Promise<void>(resolve => setImmediate(resolve));
    adapter.cancelTextInteraction?.('other-group', 'abandoned', { kind: 'ask_user_question', answers: {} });
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(settled).toBe(false);
    if (action === 'abort') controller.abort(); else lease.release();
    await expect(decision).resolves.toMatchObject({ kind: 'ask_user_question', answers: {} });
    // A fresh question can use the same chat; the abandoned one cannot create its next waiter.
    const fresh = im.requestTextReply('group', 'Fresh?', text => text, 1000);
    const cancelled = expect(fresh).rejects.toThrow('BLUEBUBBLES_INTERACTION_CANCELLED');
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(requestReply).toHaveBeenCalledTimes(2);
    await im.dispose();
    await cancelled;
  } finally { lease.release(); await im.dispose(); }
});
