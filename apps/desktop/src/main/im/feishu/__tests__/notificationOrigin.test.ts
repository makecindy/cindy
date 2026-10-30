import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FeishuIM, IMMessageEvent } from '@cindy/im';

const mocks = vi.hoisted(() => ({
  values: vi.fn(), origin: null as null | { sessionId: string },
  session: { workingDir: '/tmp/task', status: 'active' } as Record<string, unknown>,
  where: vi.fn(),
}));
vi.mock('../../../logger', () => ({ createLogger: () => ({ info: vi.fn(), error: vi.fn() }) }));
vi.mock('drizzle-orm', () => ({
  eq: (column: unknown, value: unknown) => [column, value],
  and: (...conditions: unknown[]) => conditions,
}));
vi.mock('../../../localDb/schema', () => ({
  imNotificationOrigins: { channel: 'channel', botContextId: 'bot', userId: 'user', messageId: 'message', chatId: 'chat' },
  sessions: { id: 'session' },
}));
vi.mock('../../../localDb/client/current', () => ({
  getDbClient: () => ({ drizzle: {
    insert: () => ({ values: mocks.values }),
    select: () => ({ from: (table: { id?: string }) => ({ where: (condition: unknown) => {
      mocks.where(condition);
      return { limit: async () => table.id ? [mocks.session] : mocks.origin ? [mocks.origin] : [] };
    } }) }),
  } }),
}));
import { activateImAccountBoundary, deactivateImAccountBoundary } from '../../accountBoundary';
import { resolveFeishuNotificationReply, sendFeishuSessionNotification } from '../notificationOrigin';

const sendNotification = vi.fn();
const im = {
  getStatus: () => ({ kind: 'connected', appId: 'cli_bot' }),
  getOwnerOpenId: () => 'ou_owner', sendNotification,
} as unknown as FeishuIM;
const event = {
  senderId: 'ou_owner', contextId: 'cli_bot', chatId: 'oc_chat',
  replyThread: { rootMessageId: 'om_root', threadId: 'omt_topic' },
} as IMMessageEvent;

beforeEach(() => {
  vi.clearAllMocks();
  activateImAccountBoundary();
  mocks.origin = { sessionId: 'original' };
  mocks.session = { workingDir: '/tmp/task', status: 'active' };
  mocks.values.mockResolvedValue(undefined);
  sendNotification.mockResolvedValue({ messageId: 'om_root', chatId: 'oc_chat' });
});

describe('Feishu notification origins', () => {
  it('stores the provider receipt and resolves the original session by bot, owner, chat and root', async () => {
    await expect(sendFeishuSessionNotification(im, 'original', 'done')).resolves.toEqual({
      messageId: 'om_root', chatId: 'oc_chat', sessionLinked: true,
    });
    expect(mocks.values).toHaveBeenCalledWith(expect.objectContaining({
      botContextId: 'cli_bot', userId: 'ou_owner', chatId: 'oc_chat', messageId: 'om_root', sessionId: 'original',
    }));
    await expect(resolveFeishuNotificationReply(im, event)).resolves.toBe('original');
    expect(mocks.where).toHaveBeenCalledWith([
      ['channel', 'feishu'], ['bot', 'cli_bot'], ['user', 'ou_owner'], ['message', 'om_root'], ['chat', 'oc_chat'],
    ]);
  });

  it('waits for an in-flight receipt before looking up a fast reply', async () => {
    let release!: (value: { messageId: string; chatId: string }) => void;
    sendNotification.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    mocks.origin = null;
    const send = sendFeishuSessionNotification(im, 'original', 'done');
    await Promise.resolve();
    const reply = resolveFeishuNotificationReply(im, event);
    await vi.waitFor(() => expect(mocks.where).toHaveBeenCalledTimes(1));
    mocks.origin = { sessionId: 'original' };
    release({ messageId: 'om_root', chatId: 'oc_chat' });
    await send;
    await expect(reply).resolves.toBe('original');
  });

  it('ignores another owner or bot and an unlinked legacy notification', async () => {
    await expect(resolveFeishuNotificationReply(im, { ...event, senderId: 'ou_other' })).resolves.toBeNull();
    await expect(resolveFeishuNotificationReply(im, { ...event, contextId: 'cli_other' })).resolves.toBeNull();
    expect(mocks.where).not.toHaveBeenCalled();
    mocks.origin = null;
    await expect(resolveFeishuNotificationReply(im, event)).resolves.toBeNull();
  });

  it('rejects a deleted original without treating its notification as unlinked', async () => {
    mocks.session = { workingDir: '/tmp/task', status: 'deleted' };
    await expect(resolveFeishuNotificationReply(im, event)).rejects.toThrow('unavailable');
  });

  it('does not persist a receipt into a replaced account', async () => {
    sendNotification.mockImplementationOnce(async () => {
      deactivateImAccountBoundary();
      return { messageId: 'om_root', chatId: 'oc_chat' };
    });
    await expect(sendFeishuSessionNotification(im, 'original', 'done')).resolves.toEqual({
      messageId: 'om_root', chatId: 'oc_chat', sessionLinked: false,
    });
    expect(mocks.values).not.toHaveBeenCalled();
  });

  it('returns the delivered receipt when persistence fails, without resending', async () => {
    mocks.values.mockRejectedValueOnce(new Error('SQLITE_FULL'));
    await expect(sendFeishuSessionNotification(im, 'original', 'done')).resolves.toEqual({
      messageId: 'om_root', chatId: 'oc_chat', sessionLinked: false,
    });
    expect(sendNotification).toHaveBeenCalledTimes(1);
    expect(mocks.values).toHaveBeenCalledTimes(1);
  });

  it('returns the delivered receipt even if its chat id is absent', async () => {
    sendNotification.mockResolvedValueOnce({ messageId: 'om_root' });
    await expect(sendFeishuSessionNotification(im, 'original', 'done')).resolves.toEqual({
      messageId: 'om_root', sessionLinked: false,
    });
    expect(mocks.values).not.toHaveBeenCalled();
  });

  it('does not block an existing link on an unrelated send', async () => {
    let finish!: (value: { messageId: string; chatId: string }) => void;
    sendNotification.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const unrelated = sendFeishuSessionNotification(im, 'other', 'other');
    try {
      await expect(resolveFeishuNotificationReply(im, event)).resolves.toBe('original');
    } finally {
      finish({ messageId: 'om_other', chatId: 'oc_chat' });
      await unrelated;
    }
  });

  it('keeps an unlinked topic on its normal route when an unrelated send times out', async () => {
    vi.useFakeTimers();
    let finish!: (value: { messageId: string; chatId: string }) => void;
    sendNotification.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    mocks.origin = null;
    const send = sendFeishuSessionNotification(im, 'other', 'other');
    try {
      const reply = resolveFeishuNotificationReply(im, event);
      const assertion = expect(reply).resolves.toBeNull();
      await vi.advanceTimersByTimeAsync(10_000);
      await assertion;
      expect(mocks.where).toHaveBeenCalledTimes(2);
    } finally {
      finish({ messageId: 'om_other', chatId: 'oc_chat' });
      await send;
      vi.useRealTimers();
    }
  });

  it('rechecks a fast reply as soon as its send finishes, even while another is pending', async () => {
    let finishOther!: (value: { messageId: string; chatId: string }) => void;
    let finishTarget!: (value: { messageId: string; chatId: string }) => void;
    mocks.origin = null;
    sendNotification.mockImplementationOnce(() => new Promise((resolve) => { finishOther = resolve; }));
    sendNotification.mockImplementationOnce(() => new Promise((resolve) => { finishTarget = resolve; }));
    const other = sendFeishuSessionNotification(im, 'other', 'other');
    const target = sendFeishuSessionNotification(im, 'original', 'done');
    const reply = resolveFeishuNotificationReply(im, event);
    await vi.waitFor(() => expect(mocks.where).toHaveBeenCalledTimes(1));
    mocks.origin = { sessionId: 'original' };
    finishTarget({ messageId: 'om_root', chatId: 'oc_chat' });
    try {
      await target;
      await expect(reply).resolves.toBe('original');
    } finally {
      finishOther({ messageId: 'om_other', chatId: 'oc_chat' });
      await other;
    }
  });

});
