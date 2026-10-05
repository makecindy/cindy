import { afterEach, describe, expect, it, vi } from 'vitest';

import { DiscordIM } from '../discord/index.js';
import { FeishuIM } from '../feishu/index.js';
import { TelegramIM } from '../telegram/index.js';
import * as feishuOutbound from '../feishu/outbound.js';

afterEach(() => vi.restoreAllMocks());

describe('processing reaction transport tokens', () => {
  it('propagates Discord and Telegram removal failures to the turn owner', async () => {
    const error = new Error('reaction removal failed');
    const discord = {
      fetchChannel: vi.fn(async () => ({ messages: { fetch: vi.fn(async () => ({
        reactions: { resolve: () => ({ users: { remove: vi.fn().mockRejectedValue(error) } }) },
      })) } })),
      gateway: { client: { user: { id: 'bot' } } },
    } as unknown as DiscordIM;
    await expect(DiscordIM.prototype.removeMessageReaction.call(discord, '123|456', '🤓')).rejects.toBe(error);
    const telegram = { api: { call: vi.fn().mockRejectedValue(error) } } as unknown as TelegramIM;
    await expect(TelegramIM.prototype.removeMessageReaction.call(telegram, '123|456')).rejects.toBe(error);
  });

  it.each(['👨‍💻', '🤔', '🤓', '✍'])(
    'Discord removes the selected %s rather than the requested base emoji',
    async (emoji) => {
      const variants = ['👨‍💻', '🤔', '🤓', '✍'];
      vi.spyOn(Math, 'random').mockReturnValue(variants.indexOf(emoji) / 4);
      const remove = vi.fn();
      const resolve = vi.fn(() => ({ users: { remove } }));
      const react = vi.fn();
      const im = {
        fetchChannel: vi.fn(async () => ({
          messages: { fetch: vi.fn(async () => ({ react, reactions: { resolve } })) },
        })),
        gateway: { client: { user: { id: 'bot' } } },
      } as unknown as DiscordIM;
      const token = await DiscordIM.prototype.reactToMessage.call(im, '123|456', '👨‍💻');
      expect(react).toHaveBeenCalledWith(emoji);
      expect(token).toBe(emoji);
      await DiscordIM.prototype.removeMessageReaction.call(im, '123|456', token!);
      expect(resolve).toHaveBeenCalledWith(emoji);
      expect(remove).toHaveBeenCalledWith('bot');
    },
  );

  it.each(['Typing', 'THINKING', 'SMART', 'OnIt'])(
    'Feishu uses native %s and removes its returned reaction id',
    async (emoji) => {
      const variants = ['Typing', 'THINKING', 'SMART', 'OnIt'];
      vi.spyOn(Math, 'random').mockReturnValue(variants.indexOf(emoji) / 4);
      const add = vi.spyOn(feishuOutbound, 'addReaction').mockResolvedValue('reaction-id');
      const remove = vi.spyOn(feishuOutbound, 'removeReaction').mockResolvedValue(undefined);
      const token = await FeishuIM.prototype.reactToMessage('message-id', 'Typing');
      expect(add).toHaveBeenCalledWith('message-id', emoji);
      await FeishuIM.prototype.removeMessageReaction('message-id', token!);
      expect(remove).toHaveBeenCalledWith('message-id', 'reaction-id');
      await FeishuIM.prototype.reactToMessage('message-id', 'OneSecond');
      expect(add).toHaveBeenLastCalledWith('message-id', 'OneSecond');
    },
  );
});
