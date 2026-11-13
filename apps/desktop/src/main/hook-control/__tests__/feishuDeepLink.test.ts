/**
 * 测试价值
 * - 生产入口与可观察结果: feishuDeepLink 的三个公开函数 —— 官方飞书 / Lark 绑定链接
 *   进入 renderer 可见快照前的校验(parseFeishuConnectUrl, manager 的 pending 归一)
 *   与交给 shell.openExternal 前的校验(validateFeishuExternalUrl / feishuBotUrlOrNull)。
 * - 规则依据: docs/dev-rules/electron-security-and-process-boundaries.md §6「外链」——
 *   shell.openExternal 只接受经 URL 解析与白名单验证的目标; 服务端下发的链接不可信,
 *   主机白名单必须精确。与 xDeepLink / telegramDeepLink 同构但不共用。
 * - 现有覆盖缺口: 新模块, 无既有覆盖。
 * - 最小失败输入: 见下方拒绝矩阵(主机仿冒、端口、凭证、fragment、参数走私等)。
 * - tier: unit(纯函数, node 环境)。
 * - 实测耗时: vitest 单文件约 0.25s。
 */
import { describe, expect, it } from 'vitest';

import {
  feishuBotUrlOrNull,
  parseFeishuBotUrl,
  parseFeishuConnectUrl,
  validateFeishuExternalUrl,
} from '../feishuDeepLink';

const AUTHORIZE_QS =
  'client_id=cli_a1b2c3d4e5f6&redirect_uri=https%3A%2F%2Ffeishu-hook.example%2Ffeishu%2Foauth%2Fcallback&state=state-abc_123';
const VALID_AUTHORIZE = `https://accounts.feishu.cn/open-apis/authen/v1/authorize?${AUTHORIZE_QS}`;
const VALID_BOT = 'https://applink.feishu.cn/client/bot/open?appId=cli_a1b2c3d4e5f6';

describe('parseFeishuConnectUrl', () => {
  it.each([
    ['Feishu authorize page', VALID_AUTHORIZE],
    ['Lark authorize page', VALID_AUTHORIZE.replace('accounts.feishu.cn', 'accounts.larksuite.com')],
    ['optional scope', `${VALID_AUTHORIZE}&scope=contact%3Auser.base%3Areadonly`],
    // feishu-hook-server issues the documented response_type=code right after client_id.
    [
      'server-issued response_type=code',
      VALID_AUTHORIZE.replace('client_id=cli_a1b2c3d4e5f6&', 'client_id=cli_a1b2c3d4e5f6&response_type=code&'),
    ],
    ['S256 PKCE pair', `${VALID_AUTHORIZE}&code_challenge=abc_123&code_challenge_method=S256`],
    [
      'localhost http callback in development',
      VALID_AUTHORIZE.replace(
        'https%3A%2F%2Ffeishu-hook.example%2Ffeishu%2Foauth%2Fcallback',
        'http%3A%2F%2Flocalhost%3A8794%2Ffeishu%2Foauth%2Fcallback',
      ),
    ],
  ])('accepts the %s', (_label, input) => {
    const link = parseFeishuConnectUrl(input);
    expect(link.appId).toBe('cli_a1b2c3d4e5f6');
    expect(link.url).toMatch(/\/open-apis\/authen\/v1\/authorize\?client_id=cli_a1b2c3d4e5f6&/);
  });

  it.each([
    ['whitespace padding', ` ${VALID_AUTHORIZE}`],
    ['http downgrade', VALID_AUTHORIZE.replace('https:', 'http:')],
    ['wrong host', VALID_AUTHORIZE.replace('accounts.feishu.cn', 'open.feishu.cn')],
    ['host lookalike', VALID_AUTHORIZE.replace('accounts.feishu.cn', 'accounts.feishu.cn.evil.example')],
    ['bot host for authorize', VALID_AUTHORIZE.replace('accounts.feishu.cn', 'applink.feishu.cn')],
    [
      'embedded credentials',
      VALID_AUTHORIZE.replace('https://accounts.feishu.cn', 'https://user:pw@accounts.feishu.cn'),
    ],
    [
      'explicit default port',
      VALID_AUTHORIZE.replace('https://accounts.feishu.cn', 'https://accounts.feishu.cn:443'),
    ],
    ['fragment', `${VALID_AUTHORIZE}#frag`],
    ['empty fragment delimiter', `${VALID_AUTHORIZE}#`],
    ['wrong path', VALID_AUTHORIZE.replace('/authen/v1/authorize', '/authen/v1/index')],
    ['unexpected parameter', `${VALID_AUTHORIZE}&prompt=none`],
    ['repeated parameter', `${VALID_AUTHORIZE}&state=state-2`],
    ['missing state', VALID_AUTHORIZE.replace('&state=state-abc_123', '')],
    ['missing redirect_uri', VALID_AUTHORIZE.replace(/&redirect_uri=[^&]+/, '')],
    ['empty parameter', VALID_AUTHORIZE.replace('state=state-abc_123', 'state=')],
    ['non-app client_id', VALID_AUTHORIZE.replace('client_id=cli_a1b2c3d4e5f6', 'client_id=evil')],
    [
      'non-http redirect_uri',
      VALID_AUTHORIZE.replace(/redirect_uri=[^&]+/, 'redirect_uri=javascript%3Aalert(1)'),
    ],
    ['relative redirect_uri', VALID_AUTHORIZE.replace(/redirect_uri=[^&]+/, 'redirect_uri=%2Fcallback')],
    ['implicit-grant response_type', `${VALID_AUTHORIZE}&response_type=token`],
    ['half a PKCE pair', `${VALID_AUTHORIZE}&code_challenge=abc_123`],
    ['plain PKCE challenge', `${VALID_AUTHORIZE}&code_challenge=abc&code_challenge_method=plain`],
    ['not a URL', 'not a url'],
  ])('rejects %s', (_label, input) => {
    expect(() => parseFeishuConnectUrl(input)).toThrow(/Feishu (binding URL|link)/);
  });
});

describe('Feishu bot AppLink', () => {
  it('accepts the Feishu and Lark open-bot AppLinks only', () => {
    expect(parseFeishuBotUrl(VALID_BOT)).toBe(VALID_BOT);
    const lark = VALID_BOT.replace('applink.feishu.cn', 'applink.larksuite.com');
    expect(parseFeishuBotUrl(lark)).toBe(lark);
    for (const bad of [
      VALID_BOT.replace('https:', 'http:'),
      VALID_BOT.replace('applink.feishu.cn', 'applink.feishu.cn.evil.example'),
      VALID_BOT.replace('/client/bot/open', '/client/chat/open'),
      VALID_BOT.replace('appId=cli_a1b2c3d4e5f6', 'appId=evil'),
      `${VALID_BOT}&openId=ou_1`,
      `${VALID_BOT}#x`,
      VALID_BOT.replace('https://applink.feishu.cn', 'https://applink.feishu.cn:443'),
    ]) {
      expect(() => parseFeishuBotUrl(bad)).toThrow(/Feishu bot link|Feishu link/);
      expect(feishuBotUrlOrNull(bad, 'cli_a1b2c3d4e5f6')).toBeNull();
    }
    expect(feishuBotUrlOrNull(null, 'cli_a1b2c3d4e5f6')).toBeNull();
    expect(feishuBotUrlOrNull(VALID_BOT, 'cli_a1b2c3d4e5f6')).toBe(VALID_BOT);
    // 多个组织共用服务: 别家应用的机器人链接、或不知道绑定的是哪个应用时都不给。
    expect(feishuBotUrlOrNull(VALID_BOT, 'cli_other_org')).toBeNull();
    expect(feishuBotUrlOrNull(VALID_BOT, null)).toBeNull();
  });
});

describe('validateFeishuExternalUrl', () => {
  it('routes by host and accepts only the authorize page or the bot AppLink', () => {
    expect(validateFeishuExternalUrl(VALID_AUTHORIZE)).toContain('/open-apis/authen/v1/authorize?');
    expect(validateFeishuExternalUrl(VALID_BOT)).toBe(VALID_BOT);
    expect(() => validateFeishuExternalUrl('https://www.feishu.cn/')).toThrow();
    expect(() => validateFeishuExternalUrl('https://t.me/CindyBot')).toThrow();
    expect(() => validateFeishuExternalUrl('https://x.com/CindyBot')).toThrow();
  });
});
