import { describe, expect, it, vi } from 'vitest';
import { ButtonStyle } from 'discord.js';

import { DiscordIM } from '../index.js';
import {
  DISCORD_CARD_PAGE_BUTTON_ID,
  buildCardMessage,
  parseInteraction,
} from '../components.js';
import type { IMHost, InteractiveCardSpec } from '../../types.js';

interface CardEditPayload {
  content?: string;
  embeds: Array<{ title?: string; description?: string }>;
  components: Array<{
    components: Array<{
      custom_id: string;
    }>;
  }>;
}

describe('discord components', () => {
  it('splits 6 buttons into rows of 5 + 1', () => {
    const msg = buildCardMessage(specWithButtons(6));

    expect(msg.components).toHaveLength(2);
    expect(msg.components[0].components).toHaveLength(5);
    expect(msg.components[1].components).toHaveLength(1);
  });

  it('paginates non-terminal overflow instead of dropping options', () => {
    const spec = specWithButtons(30);
    const firstPage = buildCardMessage(spec);
    const secondPage = buildCardMessage(spec, { page: 1 });

    const firstParsed = parseButtons(firstPage);
    const secondParsed = parseButtons(secondPage);

    expect(firstParsed).toHaveLength(24);
    expect(firstParsed.at(-1)?.buttonId).toBe(DISCORD_CARD_PAGE_BUTTON_ID);
    expect(firstParsed.at(-1)?.payload).toEqual({ page: 1 });
    expect(firstParsed.some((event) => event?.payload.i === 23)).toBe(false);

    expect(secondParsed.map((event) => event?.payload.i)).toEqual([
      23,
      24,
      25,
      26,
      27,
      28,
      29,
      undefined,
    ]);
    expect(secondParsed.at(-1)?.buttonId).toBe(DISCORD_CARD_PAGE_BUTTON_ID);
    expect(secondParsed.at(-1)?.payload).toEqual({ page: 0 });
  });

  it('keeps terminal control buttons when paginating overflow', () => {
    const msg = buildCardMessage({
      body: 'Pick a session',
      buttons: [
        ...Array.from({ length: 30 }, (_, i) => ({
          id: 'control:session-pick',
          label: `Session ${i}`,
          payload: { sessionId: `session-${i}` },
        })),
        { id: 'control:new', label: 'New', type: 'primary' as const },
        { id: 'control:back', label: 'Back' },
        { id: 'control:exit', label: 'Exit', type: 'danger' as const },
      ],
    });

    const parsed = parseButtons(msg);

    expect(parsed).toHaveLength(24);
    expect(parsed.slice(-3).map((event) => event?.buttonId)).toEqual([
      'control:new',
      'control:back',
      'control:exit',
    ]);
    expect(parsed[20]?.buttonId).toBe(DISCORD_CARD_PAGE_BUTTON_ID);
    expect(parsed[20]?.payload).toEqual({ page: 1 });
    expect(parsed.some((event) => event?.payload.sessionId === 'session-20')).toBe(false);
  });

  it('caps embed descriptions at Discord limit', () => {
    const msg = buildCardMessage({
      body: 'x'.repeat(5000),
      buttons: [],
    });

    expect(msg.embeds[0].description).toHaveLength(4094);
    expect(msg.embeds[0].description?.length).toBeLessThanOrEqual(4096);
    expect(msg.embeds[0].description?.endsWith('…')).toBe(true);
  });

  it('caps embed titles at Discord limit', () => {
    const msg = buildCardMessage({
      title: 'T'.repeat(300),
      body: 'Body',
      buttons: [],
    });

    expect(msg.embeds[0].title).toHaveLength(256);
    expect(msg.embeds[0].title?.endsWith('…')).toBe(true);
  });

  it('maps spec to embed and button styles', () => {
    const msg = buildCardMessage({
      title: 'Confirm',
      body: '**Allow** this?',
      buttons: [
        { id: 'allow', label: 'Allow', type: 'primary', payload: { ok: true } },
        { id: 'deny', label: 'Deny', type: 'danger' },
        { id: 'later', label: 'Later' },
      ],
    });

    expect(msg.embeds).toEqual([{ title: 'Confirm', description: '**Allow** this?' }]);
    const buttons = msg.components[0].components;
    expect(buttons.map((button) => button.style)).toEqual([
      ButtonStyle.Primary,
      ButtonStyle.Danger,
      ButtonStyle.Secondary,
    ]);
    expect(buttons.every((button) => typeof button.custom_id === 'string')).toBe(true);
  });

  it('parses button interactions back to card action events', () => {
    const msg = buildCardMessage({
      body: 'Pick',
      buttons: [{ id: 'model:pick', label: 'A', payload: { model: 'a' } }],
    });
    const customId = msg.components[0].components[0].custom_id;

    expect(parseInteraction(interaction(customId))).toEqual({
      channelName: 'discord',
      senderId: 'user-1',
      chatId: 'dm-1',
      messageId: 'dm-1|msg-1',
      buttonId: 'model:pick',
      payload: { model: 'a' },
      threadTs: undefined,
      scopeKey: undefined,
    });
  });

  it('returns null for expired refs', () => {
    expect(parseInteraction(interaction('ref:not-real'))).toBeNull();
  });
});

describe('DiscordIM card methods', () => {
  it('patchMarkdownCard clears embeds and components', async () => {
    const message = makeEditableMessage();
    const channel = makeChannel(message);
    const im = makeIm(channel);

    await im.patchMarkdownCard('dm-1|msg-1', '**done**');

    expect(message.edit).toHaveBeenCalledWith({
      content: '**done**',
      embeds: [],
      components: [],
    });
  });

  it('updateInteractiveCard clears stale content and caps title', async () => {
    const message = makeEditableMessage();
    const channel = makeChannel(message);
    const im = makeIm(channel);

    await im.updateInteractiveCard('dm-1|msg-1', {
      title: 'T'.repeat(300),
      body: 'Ready',
      buttons: [{ id: 'done', label: 'Done' }],
    });

    const payload = message.edit.mock.calls[0]?.[0] as CardEditPayload | undefined;
    if (!payload) throw new Error('missing edit payload');
    const embed = payload.embeds[0];
    if (!embed) throw new Error('missing edit embed');

    expect(payload.content).toBe('');
    expect(embed.title).toHaveLength(256);
    expect(embed.title?.endsWith('…')).toBe(true);
    expect(embed.description).toBe('Ready');
    expect(payload.components).toHaveLength(1);
  });

  it('uses the injected expired card notice', async () => {
    const followUp = vi.fn(async () => {});
    let onButtonInteraction: (value: unknown) => void = () => {};
    new DiscordIM(makeHost(), {
      expiredCardNotice: 'Card expired',
      gatewayFactory: (handlers) => {
        onButtonInteraction = handlers.onButtonInteraction as (value: unknown) => void;
        return {
          client: null,
          appId: 'app-1',
          botTag: 'bot#0000',
          connect: vi.fn(async () => {}),
          destroy: vi.fn(async () => {}),
        };
      },
    });

    onButtonInteraction?.({
      ...interaction('ref:not-real'),
      followUp,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(followUp).toHaveBeenCalledWith({
      content: 'Card expired',
      ephemeral: true,
    });
  });

  it('calls expired-card followUp with the interaction binding intact', async () => {
    class ThisSensitiveInteraction {
      customId = 'ref:not-real';
      user = { id: 'user-1' };
      channelId = 'dm-1';
      message = { id: 'msg-1' };
      delivered: unknown[] = [];

      async followUp(payload: unknown): Promise<void> {
        if (!(this instanceof ThisSensitiveInteraction)) {
          throw new Error('lost interaction binding');
        }
        this.delivered.push(payload);
      }
    }

    const interactionInstance = new ThisSensitiveInteraction();
    let onButtonInteraction: (value: unknown) => void = () => {};
    new DiscordIM(makeHost(), {
      expiredCardNotice: 'Card expired',
      gatewayFactory: (handlers) => {
        onButtonInteraction = handlers.onButtonInteraction as (value: unknown) => void;
        return {
          client: null,
          appId: 'app-1',
          botTag: 'bot#0000',
          connect: vi.fn(async () => {}),
          destroy: vi.fn(async () => {}),
        };
      },
    });

    onButtonInteraction(interactionInstance);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(interactionInstance.delivered).toEqual([
      { content: 'Card expired', ephemeral: true },
    ]);
  });

  it('falls back to DM when expired-card followUp throws', async () => {
    const message = makeEditableMessage();
    const channel = makeChannel(message);
    let onButtonInteraction: (value: unknown) => void = () => {};
    new DiscordIM(makeHost(), {
      expiredCardNotice: 'Card expired',
      gatewayFactory: (handlers) => {
        onButtonInteraction = handlers.onButtonInteraction as (value: unknown) => void;
        return {
          client: {
            user: { id: 'bot-1' },
            users: {
              fetch: vi.fn(async () => ({
                createDM: vi.fn(async () => channel),
              })),
            },
          } as never,
          appId: 'app-1',
          botTag: 'bot#0000',
          connect: vi.fn(async () => {}),
          destroy: vi.fn(async () => {}),
        };
      },
    });

    onButtonInteraction({
      ...interaction('ref:not-real'),
      followUp: vi.fn(async () => {
        throw new Error('webhook token expired');
      }),
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(channel.send).toHaveBeenCalledWith('Card expired');
  });

  it('edits Discord card pages without emitting business card actions', async () => {
    const message = makeEditableMessage();
    const channel = makeChannel(message);
    const host = makeHost({
      readSecret: (key) => (key === 'discord-owner-user-id' ? 'user-1' : null),
    });
    let onButtonInteraction: (value: unknown) => void = () => {};
    const im = new DiscordIM(host, {
      gatewayFactory: (handlers) => {
        onButtonInteraction = handlers.onButtonInteraction as (value: unknown) => void;
        return {
          client: {
            user: { id: 'bot-1' },
            users: {
              fetch: vi.fn(async () => ({
                createDM: vi.fn(async () => channel),
              })),
            },
            channels: { fetch: vi.fn(async () => channel) },
          } as never,
          appId: 'app-1',
          botTag: 'bot#0000',
          connect: vi.fn(async () => {}),
          destroy: vi.fn(async () => {}),
        };
      },
    });
    const actionHandler = vi.fn();
    im.onCardAction(actionHandler);
    await im.init();

    await im.sendInteractiveCard('user-1', specWithButtons(30));
    const firstPayload = channel.send.mock.calls[0]?.[0] as CardEditPayload | undefined;
    if (!firstPayload) throw new Error('missing first page payload');
    const nextButton = firstPayload.components
      .flatMap((row) => row.components)
      .find(
        (button) =>
          parseInteraction(interaction(button.custom_id))?.buttonId === DISCORD_CARD_PAGE_BUTTON_ID,
      );
    if (!nextButton) throw new Error('missing next page button');

    onButtonInteraction({
      ...interaction(nextButton.custom_id),
      message: { id: 'sent-1' },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(actionHandler).not.toHaveBeenCalled();
    expect(message.edit).toHaveBeenCalledTimes(1);
    const editPayload = message.edit.mock.calls[0]?.[0] as CardEditPayload | undefined;
    if (!editPayload) throw new Error('missing edit payload');
    expect(parseButtons(editPayload).map((event) => event?.payload.i)).toEqual([
      23,
      24,
      25,
      26,
      27,
      28,
      29,
      undefined,
    ]);
  });
});

function specWithButtons(count: number): InteractiveCardSpec {
  return {
    body: 'Body',
    buttons: Array.from({ length: count }, (_, i) => ({
      id: `button:${i}`,
      label: `B${i}`,
      payload: { i },
    })),
  };
}

function interaction(customId: string) {
  return {
    customId,
    user: { id: 'user-1' },
    channelId: 'dm-1',
    message: { id: 'msg-1' },
  };
}

function parseButtons(payload: { components: CardEditPayload['components'] }) {
  return payload.components.flatMap((row) =>
    row.components.map((button) => parseInteraction(interaction(button.custom_id))),
  );
}

function makeIm(channel: ReturnType<typeof makeChannel>): DiscordIM {
  return new DiscordIM(makeHost(), {
    gatewayFactory: () => ({
      client: {
        user: { id: 'bot-1' },
        users: {
          fetch: vi.fn(async () => ({
            createDM: vi.fn(async () => channel),
          })),
        },
        channels: { fetch: vi.fn(async () => channel) },
      } as never,
      appId: 'app-1',
      botTag: 'bot#0000',
      connect: vi.fn(async () => {}),
      destroy: vi.fn(async () => {}),
    }),
  });
}

function makeEditableMessage() {
  return {
    id: 'msg-1',
    edit: vi.fn(async (payload: unknown) => {
      void payload;
    }),
  };
}

function makeChannel(message: ReturnType<typeof makeEditableMessage>) {
  return {
    id: 'dm-1',
    send: vi.fn(async (payload: unknown) => {
      void payload;
      return { id: 'sent-1' };
    }),
    messages: { fetch: vi.fn(async () => message) },
  };
}

function makeHost(opts: { readSecret?: (key: string) => string | null } = {}): IMHost {
  return {
    paths: { feishuMediaDir: '/tmp/feishu', discordMediaDir: '/tmp/discord' },
    secrets: {
      write: () => true,
      read: (key) => opts.readSecret?.(key) ?? null,
      remove: () => {},
      isAvailable: () => true,
    },
    ipc: { handle: () => {}, broadcast: () => {} },
    httpPostForm: async () => ({ status: 200, body: {} }),
    createLogger: () => ({
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
      trace: () => {},
      fatal: () => {},
    }),
  };
}
