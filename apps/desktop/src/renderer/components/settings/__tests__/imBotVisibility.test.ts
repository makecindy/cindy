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
