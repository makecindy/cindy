// imBotVisibility —— 「IM 机器人」分栏/渠道可见性规则:
//  - 国区构建(cn/dev)+ 个人账号 cloud 登录:无 Cindy 分栏、无 Discord/Lark
//  - 企业账号 / global 构建:全量
//  - 国区本地模式 / 未登录:Lark 隐藏;global 仍显示
import { describe, expect, it } from 'vitest';

import {
  isCnPersonalIdentity,
  showCindyGroup,
  showDiscordBot,
  showLarkBot,
  unreachableImBotTarget,
  type ImBotIdentity,
} from '../imBotVisibility';

function identity(overrides: Partial<ImBotIdentity>): ImBotIdentity {
  return { region: 'cn', mode: 'cloud', membershipKind: 'personal', ...overrides };
}

describe('imBotVisibility', () => {
  it('hides the Cindy group, Discord, and Lark for cn-build personal cloud accounts', () => {
    const cnPersonal = identity({});
    expect(isCnPersonalIdentity(cnPersonal)).toBe(true);
    expect(showCindyGroup(cnPersonal)).toBe(false);
    expect(showDiscordBot(cnPersonal)).toBe(false);
    expect(showLarkBot(cnPersonal)).toBe(false);
  });

  it('treats the dev region as cn for the personal-account rule', () => {
    const devPersonal = identity({ region: 'dev' });
    expect(showCindyGroup(devPersonal)).toBe(false);
    expect(showDiscordBot(devPersonal)).toBe(false);
    expect(showLarkBot(devPersonal)).toBe(false);
  });

  it('keeps everything for cn-build org accounts', () => {
    const cnOrg = identity({ membershipKind: 'org' });
    expect(isCnPersonalIdentity(cnOrg)).toBe(false);
    expect(showCindyGroup(cnOrg)).toBe(true);
    expect(showDiscordBot(cnOrg)).toBe(true);
    expect(showLarkBot(cnOrg)).toBe(true);
  });

  it('keeps everything for global-build personal accounts', () => {
    const globalPersonal = identity({ region: 'global' });
    expect(showCindyGroup(globalPersonal)).toBe(true);
    expect(showDiscordBot(globalPersonal)).toBe(true);
    expect(showLarkBot(globalPersonal)).toBe(true);
  });

  it('hides Lark for cn local mode while keeping the existing Discord rule', () => {
    const cnLocal = identity({ mode: 'local', membershipKind: null });
    expect(isCnPersonalIdentity(cnLocal)).toBe(false);
    expect(showCindyGroup(cnLocal)).toBe(false);
    expect(showDiscordBot(cnLocal)).toBe(true);
    expect(showLarkBot(cnLocal)).toBe(false);

    const devLocal = identity({ region: 'dev', mode: 'local', membershipKind: null });
    expect(showLarkBot(devLocal)).toBe(false);

    const globalLocal = identity({ region: 'global', mode: 'local', membershipKind: null });
    expect(showCindyGroup(globalLocal)).toBe(false);
    expect(showDiscordBot(globalLocal)).toBe(true);
    expect(showLarkBot(globalLocal)).toBe(true);
  });

  it('hides Lark when signed out in cn/dev and keeps it visible in global', () => {
    expect(showLarkBot(identity({ mode: 'signed-out', membershipKind: null }))).toBe(false);
    expect(showLarkBot(identity({ region: 'dev', mode: 'signed-out', membershipKind: null }))).toBe(
      false,
    );
    expect(
      showLarkBot(identity({ region: 'global', mode: 'signed-out', membershipKind: null })),
    ).toBe(true);
  });
});

/*
  深链落空。能力墙上「连接 Telegram」这颗按钮只按渠道给路由、不判可见性 ——
  判了就会在两处各留一份判据、必然漂移。于是国区个人账号点它会跳到这一页,
  而那张卡压根没渲染;Slack 更远,它指向的整个「官方」分区都不存在。

  收口点在设置页(可见性的权威在它手里),这里钉住「什么时候该说、说的是哪一条」。
*/
describe('深链指名了不存在的东西', () => {
  it('国区个人账号:Telegram / Discord / 官方分区都判为落空', () => {
    const cnPersonal = identity({});
    expect(unreachableImBotTarget(cnPersonal, { channel: 'telegram' })).toEqual({
      name: 'telegram',
      reason: 'cn-personal',
    });
    expect(unreachableImBotTarget(cnPersonal, { channel: 'discord' })).toEqual({
      name: 'discord',
      reason: 'cn-personal',
    });
    expect(unreachableImBotTarget(cnPersonal, { group: 'cindy' })).toEqual({
      name: 'cindy-group',
      reason: 'cn-personal',
    });
  });

  it('本地模式没有官方分区,但原因不是账号类型', () => {
    const local = identity({ mode: 'local', membershipKind: null });
    expect(unreachableImBotTarget(local, { group: 'cindy' })).toEqual({
      name: 'cindy-group',
      reason: 'local-mode',
    });
    // 本地模式下 Telegram 照常可见,不该报落空。
    expect(unreachableImBotTarget(local, { channel: 'telegram' })).toBeNull();
  });

  it('能看到的目标一律不报落空', () => {
    const org = identity({ membershipKind: 'org' });
    expect(unreachableImBotTarget(org, { channel: 'telegram' })).toBeNull();
    expect(unreachableImBotTarget(org, { group: 'cindy' })).toBeNull();
    // 飞书、微信这些在任何身份下都渲染,深链不会落空。
    expect(unreachableImBotTarget(identity({}), { channel: 'feishu' })).toBeNull();
    expect(unreachableImBotTarget(identity({}), { channel: 'wechat' })).toBeNull();
    expect(unreachableImBotTarget(identity({}), { group: 'personal' })).toBeNull();
  });

  it('渠道比分区具体:两个都不可达时报渠道', () => {
    expect(unreachableImBotTarget(identity({}), { group: 'cindy', channel: 'telegram' })).toEqual({
      name: 'telegram',
      reason: 'cn-personal',
    });
  });
});
