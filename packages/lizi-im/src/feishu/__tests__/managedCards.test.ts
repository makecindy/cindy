/** Issue #10050: registered business cards must outlive the sending turn.
 * Integration tier: real scope, registry and callback ingress; only provider I/O is mocked.
 * Previously a checker without value.id was discarded, including owner submissions.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createFeishuScope, runInScope } from '../moduleScope.js';
import type { IMHost, IMMessageEvent } from '../../types.js';
import {
  sendManagedCard,
  updateManagedCard,
  receiveManagedCardAction,
} from '../managedCards.js';

const api = vi.hoisted(() => ({
  call: vi.fn(),
  send: vi.fn(),
  epoch: 1,
  owner: 'ou_owner',
}));
vi.mock('../outbound.js', () => ({
  callApi: api.call,
  getAccountEpoch: () => api.epoch,
  pushReplyAnchor: vi.fn(),
  sendCardRaw: api.send,
  getMessage: async () => ({ chat_id: 'oc_direct' }),
}));
vi.mock('../ownerGuard.js', () => ({
  firstAllowed: () => api.owner,
  check: (id: string) => id === api.owner,
}));
vi.mock('../storage.js', () => ({ readAppId: () => 'cli_example' }));

let stored: string | null;
let failWrite: boolean;
const store = {
  read: () => stored,
  write: (_key: string, value: string) => {
    if (failWrite) throw new Error('DISK_FULL');
    stored = value;
  },
  clear: () => {
    stored = null;
  },
};
const scope = () =>
  createFeishuScope({
    host: { managedCards: store } as unknown as IMHost,
    guests: true,
  });
const card = {
  schema: '2.0',
  body: { elements: [{ tag: 'checker', name: 'done' }] },
};
function callback(
  action: Record<string, unknown> = { tag: 'checker', checked: false },
) {
  return {
    token: 'test-callback-token',
    operator: { open_id: 'ou_member' },
    context: { open_message_id: 'om_card', open_chat_id: 'oc_group' },
    action: {
      ...action,
      value: { __cindy_managed_card: true, original: action.value },
    },
  };
}
beforeEach(() => {
  stored = null;
  failWrite = false;
  api.epoch = 1;
  api.owner = 'ou_owner';
  api.call.mockReset().mockResolvedValue({
    code: 0,
    data: { message_id: 'om_card', chat_id: 'oc_group' },
  });
  api.send.mockReset().mockImplementation(async () => {
    const result = await api.call();
    return { messageId: result.data.message_id };
  });
});

describe('managed Feishu cards', () => {
  it('restores a topic lane after scope recreation and preserves checker false and the real member', async () => {
    await runInScope(scope(), () =>
      sendManagedCard('g/oc_group/omt_topic', card, 'request-1'),
    );
    expect(api.send.mock.calls[0]![0]).toBe('g/oc_group/omt_topic');
    expect(api.send.mock.calls[0]![1].body.elements[0].behaviors).toEqual([
      { type: 'callback', value: { __cindy_managed_card: true } },
    ]);
    const restored = scope();
    const received: IMMessageEvent[] = [];
    restored.events.on('message', (event) => received.push(event));
    await runInScope(restored, async () => {
      expect(receiveManagedCardAction(callback(), () => true)).toBe(true);
      await new Promise((resolve) => setImmediate(resolve));
    });
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      senderId: 'g/oc_group/omt_topic',
      speaker: { id: 'ou_member', isOwner: false },
      contextId: 'cli_example',
    });
    expect(JSON.parse(received[0]!.text)).toMatchObject({
      type: 'feishu_card_action',
      requestId: 'request-1',
      action: { checked: false },
    });
    expect(stored).not.toContain(callback().token);
  });

  it('retains form fields, string value and options, and deduplicates a redelivery across restarts', async () => {
    const first = scope();
    await runInScope(first, () =>
      sendManagedCard('g/oc_group', card, 'request-1'),
    );
    const received: IMMessageEvent[] = [];
    first.events.on('message', (event) => received.push(event));
    const raw = callback({
      tag: 'button',
      value: 'submit',
      option: 'base',
      form_value: { name: 'Example' },
    });
    await runInScope(first, async () => {
      receiveManagedCardAction(raw, () => true);
      receiveManagedCardAction(raw, () => true);
      await new Promise((resolve) => setImmediate(resolve));
    });
    const second = scope();
    second.events.on('message', (event) => received.push(event));
    await runInScope(second, async () => {
      receiveManagedCardAction(raw, () => true);
      await new Promise((resolve) => setImmediate(resolve));
    });
    expect(received).toHaveLength(1);
    expect(JSON.parse(received[0]!.text).action).toEqual({
      tag: 'button',
      value: 'submit',
      option: 'base',
      form_value: { name: 'Example' },
    });
  });

  it('rejects unknown, cross-chat, expired and rebound-owner cards', async () => {
    const current = scope();
    current.events.on('message', () => {
      throw new Error('must not dispatch');
    });
    await runInScope(current, async () => {
      expect(receiveManagedCardAction(callback(), () => true)).toBe(false);
      await sendManagedCard('g/oc_group', card, 'request-1');
      expect(
        receiveManagedCardAction(
          {
            ...callback(),
            context: { open_message_id: 'om_card', open_chat_id: 'oc_other' },
          },
          () => true,
        ),
      ).toBe(false);
      api.owner = 'ou_other';
      expect(receiveManagedCardAction(callback(), () => true)).toBe(false);
      api.owner = 'ou_owner';
      vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 31 * 86400_000);
      try {
        expect(receiveManagedCardAction(callback(), () => true)).toBe(false);
      } finally {
        vi.restoreAllMocks();
      }
    });
  });

  it('cannot update another lane or turn a business button into a system control event', async () => {
    const current = scope();
    const messages: IMMessageEvent[] = [];
    const controls = vi.fn();
    current.events.on('message', (event) => messages.push(event));
    current.events.on('cardAction', controls);
    await runInScope(current, async () => {
      await sendManagedCard('g/oc_group', card, 'request-1');
      await expect(
        updateManagedCard('g/oc_other', 'om_card', card),
      ).rejects.toThrow('CARD_NOT_REGISTERED');
      await updateManagedCard('g/oc_group', 'om_card', card);
      receiveManagedCardAction(
        callback({ value: { id: 'permission:allow', isOwner: true } }),
        () => true,
      );
      await new Promise((resolve) => setImmediate(resolve));
    });
    expect(controls).not.toHaveBeenCalled();
    expect(messages[0]!.speaker!.isOwner).toBe(false);
    expect(api.call).toHaveBeenLastCalledWith(
      expect.objectContaining({
        method: 'PATCH',
        path: '/open-apis/im/v1/messages/om_card',
      }),
    );
  });

  it('reports delivery separately when registration persistence fails; never retries a send', async () => {
    const current = scope();
    await runInScope(current, async () => {
      // Let the preflight write succeed, then fail after the remote receipt.
      api.call.mockImplementationOnce(async () => {
        failWrite = true;
        return {
          code: 0,
          data: { message_id: 'om_card', chat_id: 'oc_group' },
        };
      });
      expect(
        await sendManagedCard('g/oc_group', card, 'request-1'),
      ).toMatchObject({
        messageId: 'om_card',
        registered: false,
      });
    });
    expect(api.call).toHaveBeenCalledTimes(1);
  });

  it('does not dispatch after connection shutdown between callback ACK and the next tick', async () => {
    const current = scope();
    const received = vi.fn();
    current.events.on('message', received);
    let active = true;
    await runInScope(current, async () => {
      await sendManagedCard('g/oc_group', card, 'request-1');
      receiveManagedCardAction(callback(), () => active);
      active = false;
      await new Promise((resolve) => setImmediate(resolve));
    });
    expect(received).not.toHaveBeenCalled();
  });

  it('accepts an owner DM after the sending turn has ended, and preserves successive checker toggles', async () => {
    await runInScope(scope(), () =>
      sendManagedCard('ou_owner', card, 'daily-1'),
    );
    const restored = scope();
    const received: IMMessageEvent[] = [];
    restored.events.on('message', (event) => received.push(event));
    await runInScope(restored, async () => {
      const raw = {
        ...callback({ tag: 'checker', checked: true }),
        operator: { open_id: 'ou_owner' },
        context: { open_message_id: 'om_card', open_chat_id: 'oc_direct' },
      };
      expect(receiveManagedCardAction(raw, () => true)).toBe(true);
      expect(
        receiveManagedCardAction(
          {
            ...raw,
            token: 'second-click',
            action: { ...raw.action, checked: false },
          },
          () => true,
        ),
      ).toBe(true);
      await new Promise((resolve) => setImmediate(resolve));
    });
    expect(
      received.map((event) => JSON.parse(event.text).action.checked),
    ).toEqual([true, false]);
    expect(received[0]).toMatchObject({
      senderId: 'ou_owner',
      chatId: 'oc_direct',
    });
    expect(JSON.parse(received[0]!.text).isOwner).toBe(true);
  });

  it('keeps system cards independent of unavailable business state and refuses marked unknown cards', () => {
    runInScope(scope(), () => {
      stored = 'corrupt';
      expect(
        receiveManagedCardAction(
          { action: { value: { id: 'permission:allow' } } },
          () => true,
        ),
      ).toBe(null);
      expect(() => receiveManagedCardAction(callback(), () => true)).toThrow();
      stored = null;
      expect(receiveManagedCardAction(callback(), () => true)).toBe(false);
    });
  });

  it('reuses a successful receipt and refuses to resend an ambiguous send with the same request id', async () => {
    await runInScope(scope(), async () => {
      const first = await sendManagedCard('g/oc_group', card, 'request-1');
      expect(await sendManagedCard('g/oc_group', card, 'request-1')).toEqual(
        first,
      );
      expect(api.send).toHaveBeenCalledTimes(1);
      api.send.mockRejectedValueOnce(new Error('NETWORK_TIMEOUT'));
      await expect(
        sendManagedCard('g/oc_group', card, 'request-2'),
      ).rejects.toThrow('NETWORK_TIMEOUT');
      await expect(
        sendManagedCard('g/oc_group', card, 'request-2'),
      ).rejects.toThrow('CARD_DELIVERY_UNKNOWN');
      expect(api.send).toHaveBeenCalledTimes(2);
    });
  });

  it('does not register an old send in a replacement Cindy account with the same bot identity', async () => {
    let account = 1;
    const current = scope();
    current.host!.accountScope = {
      capture: () => account,
      isCurrent: (token) => token === account,
      run: async (_token, operation) => operation(),
    };
    api.send.mockImplementationOnce(async () => {
      account = 2;
      return { messageId: 'om_old_account' };
    });
    const result = await runInScope(current, () =>
      sendManagedCard('g/oc_group', card, 'request-1'),
    );
    expect(result).toMatchObject({
      messageId: 'om_old_account',
      registered: false,
    });
    expect(JSON.parse(stored!).cards[0].messageId).toBeUndefined();
  });
});
