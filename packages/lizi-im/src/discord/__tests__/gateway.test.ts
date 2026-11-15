import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { IMStatus } from '../../types.js';

const discordMock = vi.hoisted(() => {
  type EventHandler = (...args: unknown[]) => Promise<void> | void;
  type Listener = { handler: EventHandler; once: boolean };

  const loginResults: Array<Promise<string>> = [];

  class MockDiscordClient {
    static instances: MockDiscordClient[] = [];

    readonly listeners = new Map<string, Listener[]>();
    readonly login = vi.fn((token: string) => loginResults.shift() ?? Promise.resolve(token));
    readonly destroy = vi.fn(() => {
      this.destroyed = true;
    });

    destroyed = false;
    ready = false;
    user: { id: string; tag: string } | null = { id: 'bot-id', tag: 'bot#0000' };

    constructor(readonly options: Record<string, unknown> = {}) {
      MockDiscordClient.instances.push(this);
    }

    isReady(): boolean {
      return this.ready;
    }

    once(event: string, handler: EventHandler): this {
      this.addListener(event, handler, true);
      return this;
    }

    on(event: string, handler: EventHandler): this {
      this.addListener(event, handler, false);
      return this;
    }

    emit(event: string, ...args: unknown[]): void {
      const listeners = this.listeners.get(event) ?? [];
      this.listeners.set(
        event,
        listeners.filter((listener) => !listener.once),
      );
      for (const listener of listeners) {
        void listener.handler(...args);
      }
    }

    private addListener(event: string, handler: EventHandler, once: boolean): void {
      const listeners = this.listeners.get(event) ?? [];
      listeners.push({ handler, once });
      this.listeners.set(event, listeners);
    }
  }

  return { loginResults, MockDiscordClient };
});

vi.mock('discord.js', () => ({
  ChannelType: {
    DM: 1,
    GuildText: 0,
    GuildVoice: 2,
    AnnouncementThread: 10,
    PublicThread: 11,
    PrivateThread: 12,
    GuildForum: 15,
  },
  MessageType: { Default: 0, Reply: 19, ThreadCreated: 18 },
  Client: discordMock.MockDiscordClient,
  Events: {
    ClientReady: 'clientReady',
    Error: 'error',
    InteractionCreate: 'interactionCreate',
    MessageCreate: 'messageCreate',
    ShardDisconnect: 'shardDisconnect',
    ShardError: 'shardError',
    ShardReady: 'shardReady',
    ShardReconnecting: 'shardReconnecting',
    ShardResume: 'shardResume',
  },
  GatewayIntentBits: { DirectMessages: 4096, GuildMessages: 512, Guilds: 1 },
  Partials: { Channel: 1 },
}));

import {
  connectedStatusForBotTag,
  createDiscordGateway,
  createDedup,
  mapDiscordCloseCodeToStatus,
  mapDiscordLoginErrorToStatus,
} from '../gateway.js';

type Deferred<T> = {
  promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
  reject(reason?: unknown): void;
};

function deferred<T>(): Deferred<T> {
  let resolve: Deferred<T>['resolve'] = () => {};
  let reject: Deferred<T>['reject'] = () => {};
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createGatewayHarness(): { gateway: ReturnType<typeof createDiscordGateway>; statuses: IMStatus[] } {
  const statuses: IMStatus[] = [];
  const gateway = createDiscordGateway({
    onButtonInteraction: vi.fn(),
    onDmMessage: vi.fn(),
    onGuildMessage: vi.fn(),
    onStatus(status) {
      statuses.push(status);
    },
  });
  return { gateway, statuses };
}

function emitReady(client: InstanceType<typeof discordMock.MockDiscordClient>, tag: string): void {
  client.ready = true;
  client.user = { id: `bot-${tag}`, tag };
  client.emit('clientReady', {
    application: { id: `app-${tag}` },
    user: { id: `bot-${tag}`, tag },
  });
}

beforeEach(() => {
  discordMock.loginResults.length = 0;
  discordMock.MockDiscordClient.instances.length = 0;
});

describe('discord gateway pure logic', () => {
  it('deduplicates ids and evicts by insertion order', () => {
    const dedup = createDedup(2);

    expect(dedup.seen('m1')).toBe(false);
    expect(dedup.seen('m1')).toBe(true);
    expect(dedup.seen('m2')).toBe(false);
    expect(dedup.seen('m3')).toBe(false);
    expect(dedup.seen('m1')).toBe(false);
  });

  it('maps invalid token close code to a readable error', () => {
    expect(mapDiscordCloseCodeToStatus(4004)).toEqual({
      kind: 'error',
      reason: 'Discord authentication failed: invalid bot token',
    });
  });

  it('maps invalid intents close code to a readable error', () => {
    expect(mapDiscordCloseCodeToStatus(4013)).toEqual({
      kind: 'error',
      reason: 'Discord gateway rejected configured intents',
    });
  });

  it('maps disallowed intents close code to a readable error', () => {
    expect(mapDiscordCloseCodeToStatus(4014)).toEqual({
      kind: 'error',
      reason: 'Discord gateway rejected configured intents',
    });
  });

  it('maps normal close to connecting for discord.js retry', () => {
    expect(mapDiscordCloseCodeToStatus(1000)).toEqual({ kind: 'connecting' });
  });

  it('maps unknown close codes to connecting', () => {
    expect(mapDiscordCloseCodeToStatus(4999)).toEqual({ kind: 'connecting' });
  });

  it('maps discord.js TokenInvalid login errors to error status', () => {
    expect(mapDiscordLoginErrorToStatus({ code: 'TokenInvalid' })).toEqual({
      kind: 'error',
      reason: 'Discord authentication failed: invalid bot token',
    });
  });

  it('maps discord.js InvalidIntents login errors to error status', () => {
    for (const code of ['InvalidIntents', 4013]) {
      expect(mapDiscordLoginErrorToStatus({ code })).toEqual({
        kind: 'error',
        reason: 'Discord gateway rejected configured intents',
      });
    }
  });

  it('maps discord.js DisallowedIntents login errors to error status', () => {
    expect(mapDiscordLoginErrorToStatus({ code: 'DisallowedIntents' })).toEqual({
      kind: 'error',
      reason: 'Discord gateway rejected configured intents',
    });
  });

  it('maps unknown login failures to error status with message', () => {
    expect(mapDiscordLoginErrorToStatus(new Error('network down'))).toEqual({
      kind: 'error',
      reason: 'network down',
    });
  });

  it('maps shard resume to connected when bot tag is known', () => {
    expect(connectedStatusForBotTag('helper#0000')).toEqual({
      kind: 'connected',
      appId: 'helper#0000',
    });
  });

  it('handles discord client error events as transient connecting status', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { gateway, statuses } = createGatewayHarness();

    await gateway.connect('token');
    const client = discordMock.MockDiscordClient.instances[0];

    expect(() => client.emit('error', new Error('gateway hiccup'))).not.toThrow();
    expect(() => client.emit('shardError', new Error('ws hiccup'), 2)).not.toThrow();

    expect(statuses).toEqual([{ kind: 'connecting' }, { kind: 'connecting' }, { kind: 'connecting' }]);
    expect(warn).toHaveBeenCalledWith('[im:discord:gateway]', 'client error: gateway hiccup');
    expect(warn).toHaveBeenCalledWith('[im:discord:gateway]', 'shard error shard=2: ws hiccup');

    warn.mockRestore();
    await gateway.destroy();
  });

  it('does not throw from discord error handlers when status callbacks fail', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    let rejectStatus = false;
    const gateway = createDiscordGateway({
      onButtonInteraction: vi.fn(),
      onDmMessage: vi.fn(),
      onGuildMessage: vi.fn(),
      onStatus() {
        if (rejectStatus) throw new Error('status callback failed');
      },
    });

    await gateway.connect('token');
    const client = discordMock.MockDiscordClient.instances[0];
    rejectStatus = true;

    expect(() => client.emit('error', new Error('gateway hiccup'))).not.toThrow();

    warn.mockRestore();
    await gateway.destroy();
  });

  it('keeps a newer client when an older login rejects after reconnect', async () => {
    const loginA = deferred<string>();
    const loginB = deferred<string>();
    discordMock.loginResults.push(loginA.promise, loginB.promise);
    const { gateway, statuses } = createGatewayHarness();

    const connectA = gateway.connect('token-a').catch((error: unknown) => error);
    const clientA = discordMock.MockDiscordClient.instances[0];
    await gateway.destroy();

    const connectB = gateway.connect('token-b');
    const clientB = discordMock.MockDiscordClient.instances[1];
    loginB.resolve('token-b');
    await connectB;
    emitReady(clientB, 'helper#0000');

    clientA.emit('clientReady', {
      application: { id: 'app-stale' },
      user: { id: 'bot-stale', tag: 'stale#0000' },
    });
    loginA.reject(new Error('stale token failed'));
    const staleError = await connectA;

    expect(staleError).toBeInstanceOf(Error);
    expect(gateway.client).toBe(clientB);
    expect(gateway.appId).toBe('app-helper#0000');
    expect(gateway.botTag).toBe('helper#0000');
    expect(clientB.destroy).not.toHaveBeenCalled();
    expect(statuses).not.toContainEqual({
      kind: 'error',
      reason: 'stale token failed',
    });
    expect(statuses.at(-1)).toEqual({ kind: 'connected', appId: 'helper#0000' });

    await gateway.destroy();
  });

  it('keeps the replacement connect promise when a stale login settles', async () => {
    const loginA = deferred<string>();
    const loginB = deferred<string>();
    discordMock.loginResults.push(loginA.promise, loginB.promise);
    const { gateway, statuses } = createGatewayHarness();

    const connectA = gateway.connect('token-a').catch((error: unknown) => error);
    await gateway.destroy();

    const connectB = gateway.connect('token-b');
    const clientB = discordMock.MockDiscordClient.instances[1];
    loginA.reject(new Error('stale token failed'));
    await connectA;

    void gateway.connect('token-b-again');

    expect(discordMock.MockDiscordClient.instances).toHaveLength(2);
    expect(gateway.client).toBe(clientB);
    expect(statuses).not.toContainEqual({
      kind: 'error',
      reason: 'stale token failed',
    });

    loginB.resolve('token-b');
    await connectB;
    emitReady(clientB, 'helper#0000');
    expect(statuses.at(-1)).toEqual({ kind: 'connected', appId: 'helper#0000' });

    await gateway.destroy();
  });

  it.each(['resolved', 'rejected'] as const)(
    'drops a button from a replaced connection after its acknowledgement %s',
    async (outcome) => {
      const ack = deferred<void>();
      const onButtonInteraction = vi.fn();
      const gateway = createDiscordGateway({
        onButtonInteraction,
        onDmMessage: vi.fn(),
        onGuildMessage: vi.fn(),
        onStatus: vi.fn(),
      });
      await gateway.connect('token-a');
      const oldClient = discordMock.MockDiscordClient.instances[0];
      oldClient.emit('interactionCreate', {
        isButton: () => true,
        deferUpdate: () => ack.promise,
      });

      await gateway.destroy();
      await gateway.connect('token-b');
      if (outcome === 'resolved') ack.resolve();
      else ack.reject(new Error('expired acknowledgement'));
      await ack.promise.catch(() => undefined);

      expect(onButtonInteraction).not.toHaveBeenCalled();
      await gateway.destroy();
    },
  );
});

describe('discord gateway guild messages', () => {
  function harness() {
    const onDmMessage = vi.fn();
    const onGuildMessage = vi.fn();
    const gateway = createDiscordGateway({
      onButtonInteraction: vi.fn(),
      onDmMessage,
      onGuildMessage,
      onStatus: vi.fn(),
    });
    return { gateway, onDmMessage, onGuildMessage };
  }
  const guildMessage = (overrides: Record<string, unknown> = {}) => ({
    id: 'm1',
    guildId: 'g1',
    system: false,
    webhookId: null,
    type: 0,
    author: { id: 'u1', bot: false },
    channel: { type: 0 },
    ...overrides,
  });

  it('requests only the standard GuildMessages intent, never MessageContent', async () => {
    const { gateway } = harness();
    await gateway.connect('token');
    const intents = discordMock.MockDiscordClient.instances[0].options.intents as number[];

    expect(intents).toEqual([1, 512, 4096]);
    expect(discordMock.MockDiscordClient.instances[0].options.allowedMentions).toEqual({
      parse: [],
      repliedUser: false,
    });
    await gateway.destroy();
  });

  it('forwards text channels and their threads, ignoring other parents, bots, webhooks and system messages', async () => {
    const { gateway, onDmMessage, onGuildMessage } = harness();
    await gateway.connect('token');
    const client = discordMock.MockDiscordClient.instances[0];

    client.emit('messageCreate', guildMessage({ id: 'text' }));
    client.emit('messageCreate', guildMessage({ id: 'thread', channel: { type: 11, parent: { type: 0 } } }));
    client.emit('messageCreate', guildMessage({ id: 'private-thread', channel: { type: 12, parent: { type: 0 } } }));
    client.emit('messageCreate', guildMessage({ id: 'forum-post', channel: { type: 11, parent: { type: 15 } } }));
    client.emit('messageCreate', guildMessage({ id: 'announcement-thread', channel: { type: 10, parent: { type: 5 } } }));
    client.emit('messageCreate', guildMessage({ id: 'unknown-parent', channel: { type: 11, parent: null } }));
    client.emit('messageCreate', guildMessage({ id: 'voice', channel: { type: 2 } }));
    client.emit('messageCreate', guildMessage({ id: 'forum', channel: { type: 15 } }));
    client.emit('messageCreate', guildMessage({ id: 'bot', author: { id: 'u2', bot: true } }));
    client.emit('messageCreate', guildMessage({ id: 'self', author: { id: 'bot-id', bot: false } }));
    client.emit('messageCreate', guildMessage({ id: 'hook', webhookId: 'w1' }));
    client.emit('messageCreate', guildMessage({ id: 'sys', system: true, type: 18 }));
    client.emit('messageCreate', guildMessage({ id: 'noguild', guildId: null }));

    expect(onGuildMessage.mock.calls.map(([m]) => (m as { id: string }).id)).toEqual(['text', 'thread', 'private-thread']);
    expect(onDmMessage).not.toHaveBeenCalled();
    await gateway.destroy();
  });

  it('delivers a replayed guild message once and routes DMs separately', async () => {
    const { gateway, onDmMessage, onGuildMessage } = harness();
    await gateway.connect('token');
    const client = discordMock.MockDiscordClient.instances[0];

    client.emit('messageCreate', guildMessage({ id: 'replay' }));
    client.emit('messageCreate', guildMessage({ id: 'replay' }));
    client.emit('messageCreate', { id: 'dm', author: { id: 'u1', bot: false }, channel: { type: 1 } });

    expect(onGuildMessage).toHaveBeenCalledTimes(1);
    expect(onDmMessage).toHaveBeenCalledTimes(1);
    await gateway.destroy();
  });
});
