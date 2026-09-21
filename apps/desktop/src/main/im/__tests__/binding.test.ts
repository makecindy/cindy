import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { BindingChangeEvent, IdentityKey } from '@cindy/im';

const mocks = vi.hoisted(() => ({
  rows: [] as Array<{
    channel: string;
    botContextId: string;
    userId: string;
    scopeKey: string;
    targetSessionId: string;
    attachedAt: number;
    attachedViaCardMessageId: string | null;
  }>,
  deleteWhere: vi.fn(async () => undefined),
  tx: vi.fn(async () => undefined),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('drizzle-orm', () => ({
  and: vi.fn((...conditions: unknown[]) => conditions),
  eq: vi.fn((column: unknown, value: unknown) => ({ column, value })),
}));
vi.mock('../../logger', () => ({ createLogger: () => mocks.logger }));
vi.mock('../../localDb/schema', () => ({
  imBindings: {
    channel: 'channel',
    botContextId: 'botContextId',
    userId: 'userId',
    scopeKey: 'scopeKey',
    targetSessionId: 'targetSessionId',
  },
}));
vi.mock('../../localDb/client/current', () => ({
  getDbClient: () => ({
    tx: mocks.tx,
    drizzle: {
      select: () => ({ from: async () => [...mocks.rows] }),
      delete: () => ({ where: mocks.deleteWhere }),
    },
  }),
}));

import { SqliteBindingStore } from '../binding';

const feishuIdentity: IdentityKey = {
  channel: 'feishu',
  botContextId: 'feishu-bot',
  userId: 'ou_owner',
};
const discordIdentity: IdentityKey = {
  channel: 'discord',
  botContextId: 'discord-bot',
  userId: '123456',
};

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('SqliteBindingStore single-owner reverse index', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.rows.length = 0;
  });

  it('replaces the previous channel when another identity attaches the same session', async () => {
    const store = new SqliteBindingStore();
    const events: BindingChangeEvent<string>[] = [];
    store.onChange((event) => events.push(event));
    await store.preload();

    await store.attach(feishuIdentity, 'desktop-session', {
      attachedViaCardMessageId: 'feishu-card',
    });
    const attachResult = await store.attachWithResult(discordIdentity, 'desktop-session');

    expect(store.get(feishuIdentity)).toBeNull();
    expect(store.get(discordIdentity)).toBe('desktop-session');
    expect(store.findByTarget('desktop-session')).toEqual(discordIdentity);
    expect(store.listAttachedTargets()).toEqual(['desktop-session']);
    expect(attachResult).toEqual({
      displaced: {
        identity: feishuIdentity,
        attachedViaCardMessageId: 'feishu-card',
      },
    });
    expect(events).toEqual([
      { identity: feishuIdentity, value: 'desktop-session', prevValue: null },
      { identity: feishuIdentity, value: null, prevValue: 'desktop-session' },
      { identity: discordIdentity, value: 'desktop-session', prevValue: null },
    ]);

    await store.detach(discordIdentity);
    expect(store.findByTarget('desktop-session')).toBeNull();
    expect(store.listAttachedTargets()).toEqual([]);
  });

  it('keeps the previous binding and emits no events when replacement persistence fails', async () => {
    const store = new SqliteBindingStore();
    const events: BindingChangeEvent<string>[] = [];
    store.onChange((event) => events.push(event));
    await store.preload();
    await store.attach(feishuIdentity, 'desktop-session', {
      attachedViaCardMessageId: 'feishu-card',
    });
    const eventsBeforeReplacement = [...events];
    mocks.tx.mockRejectedValueOnce(new Error('db locked'));

    await expect(
      store.attach(discordIdentity, 'desktop-session', {
        attachedViaCardMessageId: 'discord-card',
      }),
    ).rejects.toThrow('db locked');

    expect(store.get(feishuIdentity)).toBe('desktop-session');
    expect(store.get(discordIdentity)).toBeNull();
    expect(store.findByTarget('desktop-session')).toEqual(feishuIdentity);
    expect(store.getAttachCardMessageId(feishuIdentity)).toBe('feishu-card');
    expect(events).toEqual(eventsBeforeReplacement);
  });

  it('serializes concurrent attachments before reading and updating the indexes', async () => {
    const store = new SqliteBindingStore();
    const events: BindingChangeEvent<string>[] = [];
    const firstTransaction = deferred<undefined>();
    store.onChange((event) => events.push(event));
    await store.preload();
    mocks.tx.mockImplementationOnce(() => firstTransaction.promise);

    const firstAttach = store.attach(feishuIdentity, 'desktop-session', {
      attachedViaCardMessageId: 'feishu-card',
    });
    const secondAttach = store.attach(discordIdentity, 'desktop-session', {
      attachedViaCardMessageId: 'discord-card',
    });

    await vi.waitFor(() => expect(mocks.tx).toHaveBeenCalledTimes(1));
    expect(store.findByTarget('desktop-session')).toBeNull();

    firstTransaction.resolve(undefined);
    await firstAttach;
    await secondAttach;

    expect(mocks.tx).toHaveBeenCalledTimes(2);
    expect(store.get(feishuIdentity)).toBeNull();
    expect(store.get(discordIdentity)).toBe('desktop-session');
    expect(store.findByTarget('desktop-session')).toEqual(discordIdentity);
    expect(store.getAttachCardMessageId(feishuIdentity)).toBeNull();
    expect(store.getAttachCardMessageId(discordIdentity)).toBe('discord-card');
    expect(events).toEqual([
      { identity: feishuIdentity, value: 'desktop-session', prevValue: null },
      { identity: feishuIdentity, value: null, prevValue: 'desktop-session' },
      { identity: discordIdentity, value: 'desktop-session', prevValue: null },
    ]);
  });

  it('ignores a queued detach after the identity moves to another target', async () => {
    const store = new SqliteBindingStore();
    await store.preload();
    await store.attach(feishuIdentity, 'desktop-session-a');
    mocks.deleteWhere.mockClear();
    const moveTransaction = deferred<undefined>();
    mocks.tx.mockImplementationOnce(() => moveTransaction.promise);

    const move = store.attach(feishuIdentity, 'desktop-session-b');
    await vi.waitFor(() => expect(mocks.tx).toHaveBeenCalledTimes(2));
    const staleDetach = store.detachIfTarget(feishuIdentity, 'desktop-session-a');

    moveTransaction.resolve(undefined);
    await move;
    await expect(staleDetach).resolves.toBe(false);

    expect(store.get(feishuIdentity)).toBe('desktop-session-b');
    expect(store.findByTarget('desktop-session-a')).toBeNull();
    expect(store.findByTarget('desktop-session-b')).toEqual(feishuIdentity);
    expect(mocks.deleteWhere).not.toHaveBeenCalled();
  });

  it('mirrors an externally committed detach without a second database delete', async () => {
    const store = new SqliteBindingStore();
    const events: BindingChangeEvent<string>[] = [];
    store.onChange((event) => events.push(event));
    await store.preload();
    await store.attach(feishuIdentity, 'desktop-session');
    mocks.deleteWhere.mockClear();

    await expect(
      store.applyPersistedDetach(feishuIdentity, 'desktop-session'),
    ).resolves.toBe(true);

    expect(store.get(feishuIdentity)).toBeNull();
    expect(store.findByTarget('desktop-session')).toBeNull();
    expect(mocks.deleteWhere).not.toHaveBeenCalled();
    expect(events.at(-1)).toEqual({
      identity: feishuIdentity,
      value: null,
      prevValue: 'desktop-session',
    });
  });

  it('repairs persisted duplicate targets by keeping the latest takeover', async () => {
    mocks.rows.push(
      {
        channel: 'feishu',
        botContextId: 'feishu-bot',
        userId: 'ou_owner',
        scopeKey: '',
        targetSessionId: 'desktop-session',
        attachedAt: 100,
        attachedViaCardMessageId: 'feishu-card',
      },
      {
        channel: 'discord',
        botContextId: 'discord-bot',
        userId: '123456',
        scopeKey: '',
        targetSessionId: 'desktop-session',
        attachedAt: 200,
        attachedViaCardMessageId: 'discord-card',
      },
    );
    const store = new SqliteBindingStore();

    await store.preload();

    expect(store.get(feishuIdentity)).toBeNull();
    expect(store.get(discordIdentity)).toBe('desktop-session');
    expect(store.findByTarget('desktop-session')).toEqual(discordIdentity);
    expect(store.getAttachCardMessageId(discordIdentity)).toBe('discord-card');
    expect(mocks.tx).toHaveBeenCalledWith('im.deleteBindings', {
      identities: [
        {
          channel: 'feishu',
          botContextId: 'feishu-bot',
          userId: 'ou_owner',
          scopeKey: '',
        },
      ],
    });
    expect(mocks.deleteWhere).not.toHaveBeenCalled();
  });

  it('publishes winner indexes and allows retry when duplicate cleanup fails', async () => {
    mocks.rows.push(
      {
        channel: 'feishu',
        botContextId: 'feishu-bot',
        userId: 'ou_owner',
        scopeKey: '',
        targetSessionId: 'desktop-session',
        attachedAt: 100,
        attachedViaCardMessageId: 'feishu-card',
      },
      {
        channel: 'discord',
        botContextId: 'discord-bot',
        userId: '123456',
        scopeKey: '',
        targetSessionId: 'desktop-session',
        attachedAt: 200,
        attachedViaCardMessageId: 'discord-card',
      },
    );
    mocks.tx.mockRejectedValueOnce(new Error('db locked'));
    const store = new SqliteBindingStore();

    await expect(store.preload()).rejects.toThrow('db locked');

    expect(store.get(feishuIdentity)).toBeNull();
    expect(store.get(discordIdentity)).toBe('desktop-session');
    expect(store.findByTarget('desktop-session')).toEqual(discordIdentity);
    expect(store.getAttachCardMessageId(discordIdentity)).toBe('discord-card');

    await store.preload();

    expect(mocks.tx).toHaveBeenCalledTimes(2);
    expect(store.get(discordIdentity)).toBe('desktop-session');
    expect(store.findByTarget('desktop-session')).toEqual(discordIdentity);
  });

  it('purges every persisted owner of a target when its visible winner detaches', async () => {
    mocks.rows.push(
      {
        channel: 'feishu',
        botContextId: 'feishu-bot',
        userId: 'ou_owner',
        scopeKey: '',
        targetSessionId: 'desktop-session',
        attachedAt: 100,
        attachedViaCardMessageId: 'feishu-card',
      },
      {
        channel: 'discord',
        botContextId: 'discord-bot',
        userId: '123456',
        scopeKey: '',
        targetSessionId: 'desktop-session',
        attachedAt: 200,
        attachedViaCardMessageId: 'discord-card',
      },
    );
    mocks.tx.mockRejectedValueOnce(new Error('db locked'));
    const store = new SqliteBindingStore();
    await expect(store.preload()).rejects.toThrow('db locked');

    await expect(
      store.detachIfTarget(discordIdentity, 'desktop-session'),
    ).resolves.toBe(true);

    expect(mocks.deleteWhere).toHaveBeenCalledWith({
      column: 'targetSessionId',
      value: 'desktop-session',
    });
    expect(store.findByTarget('desktop-session')).toBeNull();
    expect(store.get(discordIdentity)).toBeNull();
  });
});
