import type { TextChannelIM } from '@cindy/im';
import { describe, expect, it, vi } from 'vitest';

import type { BotChannelConnection } from '../../../shared/botChannelRegistry';
import type { ImOrchestrator } from '../shared/orchestrator';
import {
  deliverBotRouteMessageWithDeps,
  type BotRouteDeliveryDeps,
  type BotRouteDeliveryInput,
} from '../index';

function connection(accountKey: string): BotChannelConnection {
  return {
    id: `local:telegram:${accountKey}`,
    kind: 'telegram',
    ownership: 'local-adapter',
    status: 'connected',
    connected: true,
    accountKey,
    accountName: null,
    scopeKey: accountKey,
    routable: true,
    features: [],
  };
}

function localTelegramOrchestrator(commitFinal: ReturnType<typeof vi.fn>): ImOrchestrator {
  const im = {} as TextChannelIM;
  return {
    channel: 'telegram',
    adapter: {
      channel: 'telegram',
      im,
      output: { kind: 'chunked-text', im, commitFinal },
    },
  } as unknown as ImOrchestrator;
}

function input(overrides: Partial<BotRouteDeliveryInput> = {}): BotRouteDeliveryInput {
  return {
    channel: 'telegram',
    ownership: 'local-adapter',
    accountKey: 'telegram-account-a',
    principalKey: 'owner-1',
    threadKey: 'topic-42',
    idempotencyKey: 'bot-delivery-1',
    text: 'Bot result',
    ...overrides,
  };
}

function setup(connections: BotChannelConnection[] = [connection('telegram-account-a')]) {
  const commitFinal = vi.fn(async () => undefined);
  const sendRelay = vi.fn(async () => ({ ok: true as const, messageId: 'relay-message-1' }));
  const listConnections = vi.fn(() => connections);
  const getOrchestrator = vi.fn(() => localTelegramOrchestrator(commitFinal));
  const materializeImages = vi.fn(async (params: { text: string }) => ({
    text: params.text,
    absPaths: [],
  })) as BotRouteDeliveryDeps['materializeImages'];
  const deps: BotRouteDeliveryDeps = {
    listConnections,
    getOrchestrator,
    sendRelay,
    materializeImages,
  };
  const deliver = (deliveryInput: BotRouteDeliveryInput) =>
    deliverBotRouteMessageWithDeps(deliveryInput, deps);
  return { deliver, commitFinal, sendRelay, listConnections, getOrchestrator };
}

describe('deliverBotRouteMessage', () => {
  it('sends through the exact mounted local Telegram identity and preserves the topic', async () => {
    const h = setup([
      connection('telegram-account-b'),
      connection('telegram-account-a'),
    ]);

    await expect(h.deliver(input())).resolves.toEqual({
      ok: true,
      receipt: { channel: 'telegram', accepted: true },
    });
    expect(h.commitFinal).toHaveBeenCalledWith({
      userId: 'owner-1',
      text: 'Bot result',
      terminal: 'done',
      threadTs: 'topic-42',
    });
  });

  it('fails closed when the mounted local Telegram account no longer exists', async () => {
    const h = setup([connection('telegram-account-b')]);

    await expect(h.deliver(input())).resolves.toEqual(
      expect.objectContaining({
        ok: false,
        retryable: false,
        errorCode: 'CHANNEL_IDENTITY_MISMATCH',
      }),
    );
    expect(h.getOrchestrator).not.toHaveBeenCalled();
    expect(h.commitFinal).not.toHaveBeenCalled();
  });

  it('forwards the durable relay address and outbox idempotency key as opId', async () => {
    const h = setup([]);

    await expect(
      h.deliver(
        input({
          ownership: 'server-relay',
          accountKey: 'official-telegram-bot',
          deliveryKey: 'telegram:topic:official-telegram-bot:-100:42:owner:g3',
        }),
      ),
    ).resolves.toEqual({
      ok: true,
      receipt: { channel: 'telegram', messageId: 'relay-message-1' },
    });
    expect(h.sendRelay).toHaveBeenCalledWith({
      provider: 'telegram',
      accountKey: 'official-telegram-bot',
      externalKey: 'telegram:topic:official-telegram-bot:-100:42:owner:g3',
      opId: 'bot-delivery-1',
      text: 'Bot result',
    });
    expect(h.listConnections).not.toHaveBeenCalled();
    expect(h.getOrchestrator).not.toHaveBeenCalled();
  });

  it('does not fall back to a local adapter when the relay route is unaddressable', async () => {
    const h = setup([connection('official-telegram-bot')]);

    await expect(
      h.deliver(
        input({
          ownership: 'server-relay',
          accountKey: 'official-telegram-bot',
          deliveryKey: null,
        }),
      ),
    ).resolves.toEqual(
      expect.objectContaining({
        ok: false,
        retryable: false,
        errorCode: 'RELAY_ROUTE_UNADDRESSABLE',
      }),
    );
    expect(h.sendRelay).not.toHaveBeenCalled();
    expect(h.listConnections).not.toHaveBeenCalled();
    expect(h.getOrchestrator).not.toHaveBeenCalled();
  });
});
