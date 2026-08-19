/**
 * 「还没有 X 账号」的那一行点下去要去哪里。
 *
 * 之前它是一句「先在设置里连接 X 账号」的踢皮球话术 + 一个点不动的按钮。
 * 这份映射表是它的替代品:每一条都必须落在客户端里**真实存在**的连接界面上。
 */
import { describe, expect, it } from 'vitest';

import { MOUNTABLE_BOT_CHANNEL_KINDS } from '../botChannelChips';
import {
  botChannelConnectPath,
  botChannelHasConnectUi,
  parseImBotPersonalChannel,
} from '../botChannelConnectRoutes';

describe('渠道 → 连接入口', () => {
  it('能力墙上列出的每一个可挂载渠道都有真实入口', () => {
    for (const kind of MOUNTABLE_BOT_CHANNEL_KINDS) {
      expect(botChannelHasConnectUi(kind), kind).toBe(true);
    }
  });

  it('逐渠道钉死目标分区与要展开的那张卡', () => {
    // 个人分区(用户自配凭证的本地适配器)。
    expect(botChannelConnectPath('feishu')).toBe(
      '/settings?tab=im-bot&imGroup=personal&imChannel=feishu',
    );
    expect(botChannelConnectPath('telegram')).toBe(
      '/settings?tab=im-bot&imGroup=personal&imChannel=telegram',
    );
    expect(botChannelConnectPath('wechat')).toBe(
      '/settings?tab=im-bot&imGroup=personal&imChannel=wechat',
    );
    expect(botChannelConnectPath('wecom')).toBe(
      '/settings?tab=im-bot&imGroup=personal&imChannel=wecom',
    );
    expect(botChannelConnectPath('discord')).toBe(
      '/settings?tab=im-bot&imGroup=personal&imChannel=discord',
    );
    expect(botChannelConnectPath('dingtalk')).toBe(
      '/settings?tab=im-bot&imGroup=personal&imChannel=dingtalk',
    );
    // Slack 只有官方中转一条路(hookViewToBotChannelConnections 只从 Cindy 侧
    // 产出 slack 连接),所以它没有「个人」分区的卡片可展开。
    expect(botChannelConnectPath('slack')).toBe('/settings?tab=im-bot&imGroup=cindy');
  });

  it('没有界面入口的渠道如实返回 null,由调用方说真话而不是把人支走', () => {
    expect(botChannelConnectPath('local')).toBeNull();
    expect(botChannelConnectPath('x')).toBeNull();
    expect(botChannelHasConnectUi('local')).toBe(false);
  });
});

describe('?imChannel= 的解析', () => {
  it('认得每一张个人分区卡片', () => {
    for (const value of ['wechat', 'wecom', 'feishu', 'discord', 'telegram', 'dingtalk']) {
      expect(parseImBotPersonalChannel(value)).toBe(value);
    }
  });

  it('未知值一律 null,不抛 —— 深链是用户可以随手改的东西', () => {
    expect(parseImBotPersonalChannel('slack')).toBeNull();
    expect(parseImBotPersonalChannel('')).toBeNull();
    expect(parseImBotPersonalChannel(null)).toBeNull();
    expect(parseImBotPersonalChannel(undefined)).toBeNull();
  });
});
