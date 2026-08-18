import { describe, expect, it } from 'vitest';

import {
  botChannelDisplayName,
  buildBotChannelChips,
  MOUNTABLE_BOT_CHANNEL_KINDS,
} from '../botChannelChips';
import type { BotChannelConnection } from '../botStore';

function connection(overrides: Partial<BotChannelConnection> = {}): BotChannelConnection {
  return {
    id: 'conn-1',
    kind: 'feishu',
    ownership: 'local-adapter',
    status: 'connected',
    connected: true,
    accountKey: 'acct-1',
    accountName: 'Work Feishu',
    scopeKey: null,
    routable: true,
    features: [],
    ...overrides,
  };
}

describe('capability wall channel chips', () => {
  it('gives every mountable channel a chip, even with nothing connected', () => {
    const chips = buildBotChannelChips([], () => false);

    expect(chips.map((chip) => chip.kind)).toEqual([...MOUNTABLE_BOT_CHANNEL_KINDS]);
    // 未连接账号的渠道芯片是死的:用户点不动它,只能先去设置里连账号。
    for (const chip of chips) {
      expect(chip.connection).toBeNull();
      expect(chip.disabled).toBe(true);
      expect(chip.mounted).toBe(false);
    }
  });

  it('replaces the placeholder with a real, flippable chip once an account exists', () => {
    const feishu = connection();
    const chips = buildBotChannelChips([feishu], (item) => item.id === 'conn-1');

    const chip = chips.find((item) => item.kind === 'feishu');
    expect(chip).toMatchObject({
      id: 'conn-1',
      accountLabel: 'Work Feishu',
      mounted: true,
      disabled: false,
    });
    // 只有该 kind 的占位被顶掉,其余渠道仍然各有一个置灰芯片。
    expect(chips).toHaveLength(MOUNTABLE_BOT_CHANNEL_KINDS.length);
    expect(chips.filter((item) => item.connection === null)).toHaveLength(
      MOUNTABLE_BOT_CHANNEL_KINDS.length - 1,
    );
  });

  it('keeps a non-routable account visible but not flippable', () => {
    const chips = buildBotChannelChips([connection({ routable: false })], () => false);
    expect(chips.find((chip) => chip.kind === 'feishu')?.disabled).toBe(true);
  });

  it('lists several accounts of the same channel, mounted ones first', () => {
    const chips = buildBotChannelChips(
      [
        connection({ id: 'a', accountKey: 'a', accountName: 'Alpha' }),
        connection({ id: 'b', accountKey: 'b', accountName: 'Beta' }),
      ],
      (item) => item.id === 'b',
    );

    expect(chips.slice(0, 2).map((chip) => chip.id)).toEqual(['b', 'a']);
  });

  it('names channels the same way the Channels tab does', () => {
    expect(botChannelDisplayName('feishu')).toBe('Feishu');
    expect(botChannelDisplayName('telegram')).toBe('Telegram');
  });
});
