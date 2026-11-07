import { expect, it, vi } from 'vitest';
import type { IMMessageEvent } from '@cindy/im';
import type { ImChannelAdapter } from '../../shared/types';
import { wireIMessageOrchestrator } from '../adapter';

vi.mock('../../shared/orchestrator', () => ({ createImOrchestrator: (adapter: ImChannelAdapter) => adapter }));
vi.mock('../../shared/channelGroupWindow', () => ({ IMESSAGE_GROUP_WINDOW: {}, sanitizeGroupWindowName: (name: string) => name }));
vi.mock('../../shared/botImConnectionStore', () => ({ readBotImConnection: vi.fn() }));
vi.mock('../../dingtalk/interaction', () => ({ handleDingTalkTextInteraction: vi.fn() }));

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
