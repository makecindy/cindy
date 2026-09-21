import { describe, expect, it } from 'vitest';

import en from '../../../../renderer/i18n/locales/en/common.json';
import ja from '../../../../renderer/i18n/locales/ja/common.json';
import ko from '../../../../renderer/i18n/locales/ko/common.json';
import zhCN from '../../../../renderer/i18n/locales/zh-CN/common.json';
import zhTW from '../../../../renderer/i18n/locales/zh-TW/common.json';

import {
  BOT_COMMANDS,
  type BotCommandDefinition,
  buildPersonalBotCommandMenu,
  isBotCommandAvailableOnChannel,
  OFFICIAL_BOT_COMMANDS,
  parsePersonalBotCommand,
  PERSONAL_BOT_COMMAND_LOCALE_POLICY,
  PERSONAL_BOT_COMMANDS,
  tokenizeBotCommand,
} from '../botCommands';

/**
 * 服务端 `telegram-hook-server/src/telegram/i18n.ts` 的 `TELEGRAM_COMMANDS` 全集,
 * 抄写于本 PR 提交时。
 *
 * 它挡的是**同仓内**的漂移: 有人改了注册表却没同步这份清单, 断言先红, 于是
 * 「客户端镜像与服务端对齐」这件事至少有一个显式的落点。
 *
 * 它**挡不住服务端单方面加减命令** —— 那边一改, 这边两份都不动, 测试照样绿。
 * 真要防住跨仓漂移得有一份可消费的共享契约(把 `TELEGRAM_COMMANDS` 放进
 * 两仓本地协议 package，两侧分别生成），或者在服务端加反向校验；两条路都要跨仓
 * 改动与一次协议版本推进, 另立 PR。这里不宣称自己做到了那件事。
 */
const OFFICIAL_SERVER_COMMANDS = [
  'project',
  'ctr',
  'exctr',
  'workspace',
  'unbind',
  'session',
  'new',
  'stop',
  'model',
  'effort',
  'agent',
  'permission',
  'settings',
  'status',
  'unlink',
  'help',
] as const;

describe('bot command registry', () => {
  it('Telegram /new menu copy says it creates a session/task in every locale', () => {
    expect([
      en.settings.telegramBot.commandMenu.new,
      zhCN.settings.telegramBot.commandMenu.new,
      zhTW.settings.telegramBot.commandMenu.new,
      ja.settings.telegramBot.commandMenu.new,
      ko.settings.telegramBot.commandMenu.new,
    ]).toEqual([
      'Create a new session',
      '创建新任务',
      '建立新任務',
      '新しいセッションを作成',
      '새 세션 만들기',
    ]);
  });

  it('个人 bot 菜单顺序、文案 key 与别名逐字节不变', () => {
    expect(PERSONAL_BOT_COMMAND_LOCALE_POLICY).toBe('desktop-app');
    expect(
      PERSONAL_BOT_COMMANDS.map(({ command, requiresRichCards, aliases }) => [
        command,
        requiresRichCards,
        aliases ?? null,
      ]),
    ).toEqual([
      ['start', false, null],
      ['new', false, null],
      ['help', false, null],
      ['stop', false, null],
      ['session', true, null],
      ['project', true, ['workspace']],
      ['model', true, null],
      ['permission', true, null],
      ['settings', false, null],
      ['ctr', true, null],
      ['exctr', false, ['exitctr']],
    ]);

    // 菜单是用户唯一能看见的产物 —— 硬写期望值(而不是从表里再算一遍), 这样
    // 表结构怎么重构都拦得住渲染结果的漂移。
    expect(buildPersonalBotCommandMenu((key) => `translated:${key}`)).toEqual([
      { command: 'start', description: 'translated:settings.telegramBot.commandMenu.start' },
      { command: 'new', description: 'translated:settings.telegramBot.commandMenu.new' },
      { command: 'help', description: 'translated:settings.telegramBot.commandMenu.help' },
      { command: 'stop', description: 'translated:settings.telegramBot.commandMenu.stop' },
      { command: 'session', description: 'translated:settings.telegramBot.commandMenu.session' },
      { command: 'project', description: 'translated:settings.telegramBot.commandMenu.project' },
      { command: 'model', description: 'translated:settings.telegramBot.commandMenu.model' },
      {
        command: 'permission',
        description: 'translated:settings.telegramBot.commandMenu.permission',
      },
      { command: 'settings', description: 'translated:settings.telegramBot.commandMenu.settings' },
      { command: 'ctr', description: 'translated:settings.telegramBot.commandMenu.ctr' },
      { command: 'exctr', description: 'translated:settings.telegramBot.commandMenu.exctr' },
    ]);
  });

  it('归一化隐藏别名 /exitctr, 同时保留原始拼写与参数', () => {
    expect(parsePersonalBotCommand('/exitctr now')).toMatchObject({
      definition: { command: 'exctr', requiresRichCards: false },
      invocation: '/exitctr',
      args: ['now'],
    });
    expect(parsePersonalBotCommand('/HELP')).toBeNull();
    expect(parsePersonalBotCommand('/unknown')).toBeNull();
  });

  it('官方的 /workspace 拼写在个人 bot 上归一到 /project', () => {
    // 用户从官方 bot 沿用这个拼写过来不该撞「未知命令」—— parityNote 声称个人侧
    // 用别名接住它, 这条钉住那句话是真的。
    expect(parsePersonalBotCommand('/workspace')).toMatchObject({
      definition: { command: 'project' },
      invocation: '/workspace',
    });
  });

  it('分词唯一入口: 未登记命令也返回同一份分词结果', () => {
    // dispatcher 曾经自己 split 一遍、注册表内部再 split 一遍; 未登记命令走的是
    // dispatcher 那份。合成单一入口后, 两条路径的 invocation/args 必须同源。
    expect(tokenizeBotCommand('/unknown  a   b')).toEqual({
      definition: null,
      invocation: '/unknown',
      args: ['a', 'b'],
    });
    const known = tokenizeBotCommand('  /model  gpt-5.6  ');
    expect(known.invocation).toBe('/model');
    expect(known.args).toEqual(['gpt-5.6']);
    expect(known.definition?.command).toBe('model');
  });

  it('单侧独有的命令必须写明为什么另一侧没有', () => {
    // 这条是本表存在的理由: 两个 bot 的差异可以有, 但不能没人说得清。
    const undocumented = (BOT_COMMANDS as readonly BotCommandDefinition[])
      .filter(
        (definition) =>
          definition.surfaces.length === 1 && (definition.parityNote ?? '').trim().length === 0,
      )
      .map((definition) => definition.command);
    expect(undocumented).toEqual([]);
  });

  it('个人 bot 的每条命令都有菜单文案 key', () => {
    // buildPersonalBotCommandMenu 对 personal 子集用了非空断言, 由这条守住。
    const missing = PERSONAL_BOT_COMMANDS.filter(
      (definition) => !definition.telegramMenuDescriptionKey,
    ).map((definition) => definition.command);
    expect(missing).toEqual([]);
  });

  it('官方镜像与服务端 TELEGRAM_COMMANDS 一一对应', () => {
    expect([...OFFICIAL_BOT_COMMANDS.map((definition) => definition.command)].sort()).toEqual(
      [...OFFICIAL_SERVER_COMMANDS].sort(),
    );
  });

  it('登记了当前两个 bot 的全部能力缺口', () => {
    const personal = new Set(PERSONAL_BOT_COMMANDS.map((definition) => definition.command));
    const official = new Set(OFFICIAL_BOT_COMMANDS.map((definition) => definition.command));
    expect(BOT_COMMANDS.filter((d) => !personal.has(d.command)).map((d) => d.command)).toEqual([
      'workspace',
      'unbind',
      'effort',
      'agent',
      'status',
      'unlink',
    ]);
    expect(BOT_COMMANDS.filter((d) => !official.has(d.command)).map((d) => d.command)).toEqual([
      'start',
    ]);
  });

  it('渠道能力判据: 富卡命令在纯文本渠道不可用, 登记了降级的除外', () => {
    const permission = PERSONAL_BOT_COMMANDS.find((d) => d.command === 'permission')!;
    const model = PERSONAL_BOT_COMMANDS.find((d) => d.command === 'model')!;
    const help = PERSONAL_BOT_COMMANDS.find((d) => d.command === 'help')!;

    // 等价于 dispatcher 里被删掉的 `channel === 'wecom' && cmd === '/permission'`。
    expect(isBotCommandAvailableOnChannel(permission, 'wecom', false)).toBe(true);
    expect(isBotCommandAvailableOnChannel(permission, 'wechat', false)).toBe(false);
    expect(isBotCommandAvailableOnChannel(model, 'wecom', false)).toBe(false);
    // 不需要富卡的命令在任何渠道都放行。
    expect(isBotCommandAvailableOnChannel(help, 'wechat', false)).toBe(true);
    // 渠道支持富卡时一律放行。
    expect(isBotCommandAvailableOnChannel(model, 'telegram', true)).toBe(true);
  });
});
