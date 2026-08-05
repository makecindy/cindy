// imBotVisibility —— 「IM 机器人」分栏/渠道可见性规则:
//  - 国区构建(cn/dev)+ 个人账号 cloud 登录:无 Cindy 分栏、无 Discord
//  - 企业账号 / global 构建:全量
//  - 本地模式:无 Cindy 分栏(既有规则),Discord 保留
import { describe, expect, it } from 'vitest';

import {
  isCnPersonalIdentity,
  showCindyGroup,
  showDiscordBot,
  type ImBotIdentity,
} from '../imBotVisibility';

function identity(overrides: Partial<ImBotIdentity>): ImBotIdentity {
  return { region: 'cn', mode: 'cloud', membershipKind: 'personal', ...overrides };
}

describe('imBotVisibility', () => {
  it('hides both the Cindy group and Discord for cn-build personal cloud accounts', () => {
    const cnPersonal = identity({});
    expect(isCnPersonalIdentity(cnPersonal)).toBe(true);
    expect(showCindyGroup(cnPersonal)).toBe(false);
    expect(showDiscordBot(cnPersonal)).toBe(false);
  });

  it('treats the dev region as cn for the personal-account rule', () => {
    const devPersonal = identity({ region: 'dev' });
    expect(showCindyGroup(devPersonal)).toBe(false);
    expect(showDiscordBot(devPersonal)).toBe(false);
  });

  it('keeps everything for cn-build org accounts', () => {
    const cnOrg = identity({ membershipKind: 'org' });
    expect(isCnPersonalIdentity(cnOrg)).toBe(false);
    expect(showCindyGroup(cnOrg)).toBe(true);
    expect(showDiscordBot(cnOrg)).toBe(true);
  });

  it('keeps everything for global-build personal accounts', () => {
    const globalPersonal = identity({ region: 'global' });
    expect(showCindyGroup(globalPersonal)).toBe(true);
    expect(showDiscordBot(globalPersonal)).toBe(true);
  });

  it('keeps the existing local-mode rule: no Cindy group, Discord stays', () => {
    const cnLocal = identity({ mode: 'local', membershipKind: null });
    expect(isCnPersonalIdentity(cnLocal)).toBe(false);
    expect(showCindyGroup(cnLocal)).toBe(false);
    expect(showDiscordBot(cnLocal)).toBe(true);

    const globalLocal = identity({ region: 'global', mode: 'local', membershipKind: null });
    expect(showCindyGroup(globalLocal)).toBe(false);
    expect(showDiscordBot(globalLocal)).toBe(true);
  });
});
