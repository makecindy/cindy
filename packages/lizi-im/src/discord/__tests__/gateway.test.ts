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
    readonly ws = {
      destroy: vi.fn(async () => undefined),
    };

    destroyed = false;
    ready = false;
    user: { id: string; tag: string } | null = { id: 'bot-id', tag: 'bot#0000' };

    constructor() {
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
  ChannelType: { DM: 1 },
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
  GatewayIntentBits: { DirectMessages: 2, Guilds: 1 },
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

  it('reuses the existing client while discord.js is reconnecting', async () => {
    const { gateway, statuses } = createGatewayHarness();

    await gateway.connect('token');
    const client = discordMock.MockDiscordClient.instances[0];
    emitReady(client, 'helper#0000');

    client.emit('shardReconnecting');
    expect(gateway.ingressOpen).toBe(false);
    expect(statuses.at(-1)).toEqual({ kind: 'connecting' });

    await gateway.connect('token');

    expect(discordMock.MockDiscordClient.instances).toHaveLength(1);
    expect(gateway.client).toBe(client);

    await gateway.destroy();
  });

  it('keeps ingress close best-effort when websocket destroy fails', async () => {
    const { gateway } = createGatewayHarness();

    await gateway.connect('token');
    const client = discordMock.MockDiscordClient.instances[0];
    client.ws.destroy.mockRejectedValueOnce(new Error('socket already closed'));

    await expect(gateway.closeIngress()).resolves.toBeUndefined();
    expect(gateway.ingressOpen).toBe(false);

    await gateway.destroy();
    expect(client.destroy).toHaveBeenCalledOnce();
  });

  it('does not reopen ingress when Gateway readiness arrives after forced close', async () => {
    const { gateway, statuses } = createGatewayHarness();

    await gateway.connect('token');
    const client = discordMock.MockDiscordClient.instances[0];
    await gateway.closeIngress();

    emitReady(client, 'late#0000');
    client.emit('shardResume');
    client.emit('shardReady');

    expect(gateway.ingressOpen).toBe(false);
    expect(statuses).not.toContainEqual({ kind: 'connected', appId: 'late#0000' });

    await gateway.destroy();
  });

  it('releases the client after a terminal runtime disconnect', async () => {
    const { gateway, statuses } = createGatewayHarness();

    await gateway.connect('token');
    const client = discordMock.MockDiscordClient.instances[0];
    emitReady(client, 'helper#0000');

    client.emit('shardDisconnect', { code: 4004 });

    expect(gateway.client).toBeNull();
    expect(gateway.appId).toBe('');
    expect(gateway.botTag).toBe('');
    expect(client.destroy).toHaveBeenCalledOnce();
    expect(statuses.at(-1)).toEqual({
      kind: 'error',
      reason: 'Discord authentication failed: invalid bot token',
    });
  });

  it('does not flip a ready client to connecting for transient errors', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { gateway, statuses } = createGatewayHarness();

    try {
      await gateway.connect('token');
      const client = discordMock.MockDiscordClient.instances[0];
      emitReady(client, 'helper#0000');

      statuses.length = 0;
      expect(() => client.emit('error', new Error('rate limit hiccup'))).not.toThrow();
      expect(() => client.emit('shardError', new Error('ws hiccup'), 2)).not.toThrow();

      // A healthy, ready client should keep reporting connected for transient
      // errors; only ShardDisconnect / ShardReconnecting / login failures may
      // move the status off `connected`. See GitHub issue #2971.
      expect(statuses).toEqual([]);
      expect(warn).toHaveBeenCalledWith('[im:discord:gateway]', 'client error: rate limit hiccup');
      expect(warn).toHaveBeenCalledWith('[im:discord:gateway]', 'shard error shard=2: ws hiccup');
    } finally {
      warn.mockRestore();
      await gateway.destroy();
    }
  });

  it('does not throw from discord error handlers when status callbacks fail', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    let rejectStatus = false;
    const gateway = createDiscordGateway({
      onButtonInteraction: vi.fn(),
      onDmMessage: vi.fn(),
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

  it('publishes button acceptance before the Discord ACK settles', async () => {
    const acknowledged = deferred<void>();
    const onButtonInteraction = vi.fn();
    const gateway = createDiscordGateway({
      onButtonInteraction,
      onDmMessage: vi.fn(),
      onStatus: vi.fn(),
    });

    await gateway.connect('token');
    const client = discordMock.MockDiscordClient.instances[0];
    const interaction = {
      isButton: () => true,
      deferUpdate: vi.fn(() => acknowledged.promise),
    };

    client.emit('interactionCreate', interaction);

    expect(onButtonInteraction).toHaveBeenCalledOnce();
    const acceptedAck = onButtonInteraction.mock.calls[0]?.[1] as Promise<void> | undefined;
    let ackSettled = false;
    void acceptedAck?.then(() => {
      ackSettled = true;
    });
    await Promise.resolve();
    expect(ackSettled).toBe(false);

    acknowledged.resolve(undefined);
    await acceptedAck;
    expect(ackSettled).toBe(true);
    expect(interaction.deferUpdate).toHaveBeenCalledOnce();

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
});
