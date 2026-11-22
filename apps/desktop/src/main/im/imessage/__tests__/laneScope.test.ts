import { describe, expect, it } from 'vitest';
import { resolveIMessageLaneScope, type IMessageLaneScopeDeps } from '../laneScope';

// Authorization boundary for iMessage tools without an inbound turn (owner 2026-11-22): only the
// owner's own input in Cindy or a scheduled run in a live iMessage channel lane gets that lane's
// chat; relayed work, other lanes and stale instances get nothing. Unit tier, injected host state.
const im = { sendText: async () => ({ messageId: 'm' }), sendFile: async () => ({ ok: true as const, messageId: 'f' }),
  readHistory: async () => [], listChats: () => [], health: () => ({ lastCatchUpAt: null, lastWebhookAt: null, uncertainInputs: 0, uncertainSends: 0 }),
  isGroup: (chat: string) => chat.startsWith('any;+;'), botContextId: 'ctx' } as unknown as NonNullable<ReturnType<IMessageLaneScopeDeps['target']>>['im'];

function deps(overrides: {
  origin?: string | null; ownerInput?: boolean; routeKey?: string | null; instanceId?: string; chat?: string | null;
} = {}, turn = { key: 'turn-1', runId: 'run-1' }): IMessageLaneScopeDeps {
  return {
    session: () => ({ instanceId: overrides.instanceId ?? 'i',
      getCurrentTurnOrigin: () => overrides.origin ? { kind: overrides.origin, runId: turn.runId } : null }),
    input: () => ({ ownerInput: overrides.ownerInput ?? false, key: turn.key, boundary: 1 }),
    channelLink: async () => overrides.routeKey === null ? null : { botId: 'bot', routeKey: overrides.routeKey ?? 'im:imessage:ctx:dm:any;-;+100' },
    target: () => overrides.chat === null ? null : { im, chat: overrides.chat ?? 'any;-;+100' },
    boundary: () => 'owner',
  };
}
const context = { sessionId: 's', sessionInstanceId: 'i' };

describe('resolveIMessageLaneScope', () => {
  it('scopes the owner input in Cindy to the lane chat as the owner', async () => {
    expect(await resolveIMessageLaneScope(context, deps({ ownerInput: true }))).toMatchObject({
      channel: 'imessage', chatId: 'any;-;+100', chatKind: 'direct', requesterIsOwner: true });
  });

  it('scopes a scheduled run to the lane chat without owner authority', async () => {
    expect(await resolveIMessageLaneScope(context, deps({ origin: 'scheduler', chat: 'any;+;chat1' }))).toMatchObject({
      chatId: 'any;+;chat1', chatKind: 'group', requesterIsOwner: false });
  });

  // Review (#12143): the owner's turn can end while the lane link is looked up, or after the scope was
  // handed to a tool that is still checking a file path. Either way the old turn's authority is gone.
  it('drops the scope when the checked turn changes during or after resolution', async () => {
    const turn = { key: 'turn-1', runId: 'run-1' };
    const during = deps({ ownerInput: true }, turn);
    const lookup = during.channelLink;
    during.channelLink = async id => { turn.key = 'turn-2'; return lookup(id); };
    expect(await resolveIMessageLaneScope(context, during)).toBeNull();

    turn.key = 'turn-1';
    const after = deps({ ownerInput: true }, turn);
    const scope = (await resolveIMessageLaneScope(context, after))!;
    expect(() => scope.assertCurrent?.()).not.toThrow();
    turn.key = 'turn-2';
    expect(() => scope.assertCurrent?.()).toThrow('IMESSAGE_LANE_TURN_CHANGED');

    const scheduledTurn = { key: 'k', runId: 'run-1' };
    const scheduled = (await resolveIMessageLaneScope(context, deps({ origin: 'scheduler' }, scheduledTurn)))!;
    scheduledTurn.runId = 'run-2';
    expect(() => scheduled.assertCurrent?.()).toThrow('IMESSAGE_LANE_TURN_CHANGED');
  });

  it.each([
    ['relayed or provider-initiated work', {}],
    ['a lane that is not an iMessage channel lane', { ownerInput: true, routeKey: 'im:telegram:1:dm:2' }],
    ['a session that is not a channel lane', { ownerInput: true, routeKey: null }],
    ['a stale session instance', { ownerInput: true, instanceId: 'old' }],
    ['a disconnected chat', { ownerInput: true, chat: null }],
  ] as const)('gives no scope for %s', async (_case, overrides) => {
    expect(await resolveIMessageLaneScope(context, deps(overrides))).toBeNull();
  });
});
