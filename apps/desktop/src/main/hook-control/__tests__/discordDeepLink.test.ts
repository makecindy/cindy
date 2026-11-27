/**
 * 测试价值
 * - 生产入口与可观察结果: discordDeepLink 的公开解析 / 生成函数, 即 main 在 shell.openExternal
 *   前与 pending 快照进入 renderer 前的唯一 URL 闸门; 返回规范链接或抛 DiscordLinkValidationError。
 * - 规则依据: Electron 安全边界(renderer 不是 URL 权威)与官方 Discord 关联契约
 *   (connectUrl 只能是本应用的「添加应用」页, 机器人 / 加服务器链接由 scopeId 生成)。
 * - 现有覆盖缺口: Telegram / X / 飞书各有自己的白名单, Discord 是新模块, 没有任何覆盖。
 * - 最小失败输入: 换主机 / 带端口 / 带凭据 / 带片段 / 多余或重复参数 / 非 snowflake 的应用 id。
 * - tier: unit(纯函数, 无 I/O)。
 */
import { describe, expect, it } from 'vitest';

import {
  discordAddToServerUrl,
  discordAddToServerUrlOrNull,
  discordBotUrlOrNull,
  parseDiscordConnectUrl,
  validateDiscordExternalUrl,
} from '../discordDeepLink';

const APP_ID = '100000000000000001';
const CONNECT = `https://discord.com/oauth2/authorize?client_id=${APP_ID}`;
const ADD_TO_SERVER =
  `https://discord.com/oauth2/authorize?client_id=${APP_ID}` +
  '&scope=bot+applications.commands&permissions=274878024768&integration_type=0';
const BOT = `https://discord.com/users/${APP_ID}`;

describe('parseDiscordConnectUrl', () => {
  it('accepts only the canonical add-app link and reports its application id', () => {
    expect(parseDiscordConnectUrl(CONNECT)).toEqual({ url: CONNECT, applicationId: APP_ID });
  });

  it.each([
    ['whitespace padding', ` ${CONNECT}`],
    ['http downgrade', CONNECT.replace('https:', 'http:')],
    ['legacy host', CONNECT.replace('discord.com', 'discordapp.com')],
    ['subdomain', CONNECT.replace('discord.com', 'ptb.discord.com')],
    ['host lookalike', CONNECT.replace('discord.com', 'discord.com.evil.example')],
    ['embedded credentials', CONNECT.replace('https://discord.com', 'https://user:pw@discord.com')],
    ['explicit default port', CONNECT.replace('https://discord.com', 'https://discord.com:443')],
    ['fragment', `${CONNECT}#x`],
    ['empty fragment delimiter', `${CONNECT}#`],
    ['wrong path', CONNECT.replace('/oauth2/authorize', '/oauth2/authorize/extra')],
    ['extra parameter (a smuggled redirect)', `${CONNECT}&redirect_uri=https%3A%2F%2Fevil.example`],
    ['repeated client_id', `${CONNECT}&client_id=${APP_ID}`],
    ['non-snowflake client_id', CONNECT.replace(APP_ID, 'abc')],
    ['too short client_id', CONNECT.replace(APP_ID, '1234')],
    ['not a URL', 'not a url'],
  ])('rejects %s', (_label, input) => {
    expect(() => parseDiscordConnectUrl(input)).toThrow(/Discord/);
  });
});

describe('Discord bot / add-to-server links', () => {
  it('builds both links from the application id and refuses malformed scopes', () => {
    expect(discordBotUrlOrNull(APP_ID)).toBe(BOT);
    expect(discordAddToServerUrl(APP_ID)).toBe(ADD_TO_SERVER);
    for (const scope of [null, '', 'cli_app', '1'.repeat(21), `${APP_ID}/x`]) {
      expect(discordBotUrlOrNull(scope)).toBeNull();
      expect(discordAddToServerUrlOrNull(scope)).toBeNull();
    }
  });
});

describe('validateDiscordExternalUrl', () => {
  it('passes exactly the three shapes the Settings actions open', () => {
    expect(validateDiscordExternalUrl(CONNECT)).toBe(CONNECT);
    expect(validateDiscordExternalUrl(ADD_TO_SERVER)).toBe(ADD_TO_SERVER);
    expect(validateDiscordExternalUrl(BOT)).toBe(BOT);
  });

  it.each([
    ['add-to-server with widened permissions', ADD_TO_SERVER.replace('274878024768', '8')],
    ['add-to-server with reordered parameters', `https://discord.com/oauth2/authorize?scope=bot+applications.commands&client_id=${APP_ID}&permissions=274878024768&integration_type=0`],
    ['bot link with a query', `${BOT}?ref=1`],
    ['encoded bot path', `https://discord.com/users/%31${APP_ID.slice(1)}`],
    ['other Discord page', `https://discord.com/channels/@me/${APP_ID}`],
    ['non-snowflake user', 'https://discord.com/users/cindy'],
    ['other provider', 'https://t.me/CindyBot'],
  ])('rejects %s', (_label, input) => {
    expect(() => validateDiscordExternalUrl(input)).toThrow(/Discord/);
  });
});
