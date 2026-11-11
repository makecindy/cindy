import { describe, expect, it } from 'vitest';

import { normalizeDiscordChannelAccess } from '../../../../../../packages/lizi-im/src/discord/lane';
import type { BotImDiscordChannelAccess as Access } from '../../../shared/botImConnection';
import {
  enabledGuildCount,
  guildState,
  removeChannel,
  removeGuild,
  setChannelMembersAllowed,
  setChannelSelected,
  setGuildEnabled,
  setGuildMembersAllowed,
  setGuildMode,
} from '../discordChannelAccess';

const G = '200000000000000001';
const G2 = '200000000000000002';
const A = '300000000000000001';
const B = '300000000000000002';

/** 每个变换的结果必须已经是主进程规范形状（再规范化不变）。 */
const canonical = (access: Access): Access => {
  expect(normalizeDiscordChannelAccess(access)).toEqual(access);
  return access;
};

describe('discord server-level access transforms', () => {
  const legacy: Access = {
    channels: [
      { guildId: G, channelId: A },
      { guildId: G, channelId: B },
    ],
  };

  it('reads a legacy channel list as "enabled, selected channels" without any change', () => {
    const state = guildState(legacy, G);
    expect(state).toMatchObject({ enabled: true, mode: 'selected' });
    expect([...state.selectedChannelIds]).toEqual([A, B]);
    expect(guildState(legacy, G2).enabled).toBe(false);
    expect(enabledGuildCount(legacy)).toBe(1);
  });

  it('first enable of an unknown server opens all channels; turning it off and on again restores that', () => {
    const on = canonical(setGuildEnabled({ channels: [] }, G, true));
    expect(guildState(on, G)).toMatchObject({ enabled: true, mode: 'all' });
    const off = canonical(setGuildEnabled(on, G, false));
    expect(guildState(off, G).enabled).toBe(false);
    expect(guildState(canonical(setGuildEnabled(off, G, true)), G)).toMatchObject({
      enabled: true,
      mode: 'all',
    });
  });

  it('a server deliberately set to "selected, none chosen" stays that way across off and on (not the first-enable default)', () => {
    let access = canonical(setGuildEnabled({ channels: [] }, G, true));
    access = canonical(setGuildMode(access, G, 'selected'));
    expect(guildState(access, G)).toMatchObject({ enabled: true, mode: 'selected' });
    access = canonical(setGuildEnabled(access, G, false));
    expect(guildState(access, G).enabled).toBe(false);
    access = canonical(setGuildEnabled(access, G, true));
    expect(guildState(access, G)).toMatchObject({ enabled: true, mode: 'selected' });
    expect(guildState(access, G).selectedChannelIds.size).toBe(0);
    expect(access.channels).toEqual([]);
  });

  it('closing a selected server keeps the selection (outside channels) and reopening restores it', () => {
    const off = canonical(setGuildEnabled(legacy, G, false));
    expect(off.channels).toEqual([]);
    expect(off.guilds?.[0]?.savedChannels).toEqual([{ channelId: A }, { channelId: B }]);
    const back = canonical(setGuildEnabled(off, G, true));
    expect(back.channels).toEqual(legacy.channels);
    expect(guildState(back, G)).toMatchObject({ enabled: true, mode: 'selected' });
  });

  it('switching to all channels stashes the selection and switching back restores it; other servers are untouched', () => {
    const two: Access = { channels: [...legacy.channels, { guildId: G2, channelId: A }] };
    const all = canonical(setGuildMode(two, G, 'all'));
    expect(all.channels).toEqual([{ guildId: G2, channelId: A }]);
    expect(guildState(all, G)).toMatchObject({ enabled: true, mode: 'all' });
    const selected = canonical(setGuildMode(all, G, 'selected'));
    expect(selected.channels).toEqual(
      expect.arrayContaining([...legacy.channels, { guildId: G2, channelId: A }]),
    );
    expect(guildState(selected, G2).enabled).toBe(true);
  });

  it('deselecting the last channel keeps the server enabled (selected, empty) instead of turning it off', () => {
    let access: Access = { channels: [{ guildId: G, channelId: A }] };
    access = canonical(setChannelSelected(access, G, A, false));
    expect(guildState(access, G)).toMatchObject({ enabled: true, mode: 'selected' });
    expect(guildState(access, G).selectedChannelIds.size).toBe(0);
    access = canonical(setChannelSelected(access, G, B, true));
    expect([...guildState(access, G).selectedChannelIds]).toEqual([B]);
  });

  it('member admission: guild-level only in all mode, per channel only in selected mode, reset when a channel is re-selected', () => {
    let access = canonical(setGuildEnabled({ channels: [] }, G, true));
    access = canonical(setGuildMembersAllowed(access, G, true));
    expect(guildState(access, G).allowMembers).toBe(true);
    // 指定频道模式里服务器级开关不可用。
    const selectedMode = canonical(setGuildMode(access, G, 'selected'));
    expect(setGuildMembersAllowed(selectedMode, G, false)).toBe(selectedMode);

    let selected = canonical(setChannelSelected({ channels: [] }, G, A, true));
    selected = canonical(setChannelMembersAllowed(selected, G, A, true));
    expect(selected.channels).toEqual([{ guildId: G, channelId: A, allowMembers: true }]);
    selected = canonical(setChannelSelected(setChannelSelected(selected, G, A, false), G, A, true));
    expect(selected.channels).toEqual([{ guildId: G, channelId: A }]);
    // 没选中的频道不能单独放行成员。
    expect(setChannelMembersAllowed(selected, G, B, true)).toBe(selected);
  });

  it('removes an unavailable server or channel, including retained selections', () => {
    const closed = setGuildEnabled(legacy, G, false);
    expect(canonical(removeGuild(closed, G))).toEqual({ channels: [] });
    const withoutA = canonical(removeChannel(closed, G, A));
    expect(withoutA.guilds?.[0]?.savedChannels).toEqual([{ channelId: B }]);
    expect(canonical(removeChannel(legacy, G, A)).channels).toEqual([{ guildId: G, channelId: B }]);
  });

  it('removing the last legacy channel preserves selected-empty across closing and reopening', () => {
    let access = canonical(removeChannel({ channels: [
      { guildId: G, channelId: A }, { guildId: G2, channelId: B },
    ] }, G, A));
    expect(guildState(access, G)).toMatchObject({ enabled: true, mode: 'selected' });
    expect(guildState(access, G).selectedChannelIds.size).toBe(0);

    access = canonical(setGuildEnabled(access, G, false));
    access = canonical(setGuildEnabled(access, G, true));
    expect(guildState(access, G)).toMatchObject({ enabled: true, mode: 'selected' });
    expect(access.channels).toEqual([{ guildId: G2, channelId: B }]);
  });
});
