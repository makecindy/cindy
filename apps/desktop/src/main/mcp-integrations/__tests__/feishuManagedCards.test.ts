/** #10050. Unit tier, production host port. Existing resolver tests never invoke cards.
 * Minimal regression: a routine with no inbound lease must use its own connection's owner.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LiziMcpSessionContext } from '@cindy/mcps';
import type { FeishuToolScope, FeishuToolTransport } from '../../im/shared/channelToolScope';
import { createManagedFeishuCardHost } from '../feishuManagedCards';

const card = { schema: '2.0', body: { elements: [] } };
const context: LiziMcpSessionContext = {
  agentKind: 'codex',
  workingDir: '/test',
  sessionId: 'task',
  sessionInstanceId: 'instance',
};
const send = vi.fn(async () => ({ messageId: 'om_card', registered: true }));
const update = vi.fn(async () => undefined);
const im = {
  getOwnerOpenId: () => 'ou_this_app_owner',
  sendManagedCard: send,
  updateManagedCard: update,
} as unknown as FeishuToolTransport;
let scope: FeishuToolScope | null;
const assertCurrent = vi.fn();
const resolve = vi.fn(async () => ({ im, assertCurrent }));
const host = createManagedFeishuCardHost({ resolve, readScope: () => scope });
beforeEach(() => {
  scope = null;
  vi.clearAllMocks();
});

describe('managed Feishu card host routing', () => {
  it('sends a background card to the resolved connection owner, without an inbound scope', async () => {
    expect(await host.send(card, 'request-1', context)).toMatchObject({ registered: true });
    expect(send).toHaveBeenCalledWith('ou_this_app_owner', card, 'request-1');
    expect(resolve).toHaveBeenCalledWith(context);
  });
  it('pins both send and update to the actual topic, including member-triggered turns', async () => {
    scope = { im, laneUserId: 'g/oc_group/omt_topic', requesterIsOwner: false } as FeishuToolScope;
    await host.send(card, 'request-2', context);
    await host.update('om_card', card, context);
    expect(send).toHaveBeenCalledWith('g/oc_group/omt_topic', card, 'request-2');
    expect(update).toHaveBeenCalledWith('g/oc_group/omt_topic', 'om_card', card);
  });
  it('rejects missing task identity and a lease that expires while resolving transport', async () => {
    await expect(
      host.send(card, 'request-3', { ...context, sessionId: undefined }),
    ).rejects.toThrow('NO_SESSION_CONTEXT');
    scope = { im, laneUserId: 'g/oc_group' } as FeishuToolScope;
    resolve.mockImplementationOnce(async () => {
      scope = null;
      return { im, assertCurrent };
    });
    await expect(host.send(card, 'request-3', context)).rejects.toThrow('FEISHU_SCOPE_CHANGED');
    expect(send).not.toHaveBeenCalled();
  });
});
