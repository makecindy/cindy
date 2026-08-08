import { describe, expect, it } from 'vitest';

import {
  buildPersonalBotCommandMenu,
  parsePersonalBotCommand,
  PERSONAL_BOT_COMMAND_LOCALE_POLICY,
  PERSONAL_BOT_COMMANDS,
} from '../personalBotCommands';

describe('personal bot command registry', () => {
  it('keeps the existing personal Telegram menu order and desktop-locale keys', () => {
    expect(PERSONAL_BOT_COMMAND_LOCALE_POLICY).toBe('desktop-app');
    expect(PERSONAL_BOT_COMMANDS).toEqual(
      [
        ['start', false],
        ['new', false],
        ['help', false],
        ['stop', false],
        ['session', true],
        ['project', true],
        ['model', true],
        ['permission', true],
        ['ctr', true],
        ['exctr', false],
      ].map(([command, interactive]) => ({
        command,
        menuDescriptionKey: `settings.telegramBot.commandMenu.${command}`,
        interactive,
        ...(command === 'exctr' ? { aliases: ['exitctr'] } : {}),
      })),
    );

    expect(buildPersonalBotCommandMenu((key) => `translated:${key}`)).toEqual(
      PERSONAL_BOT_COMMANDS.map(({ command, menuDescriptionKey }) => ({
        command,
        description: `translated:${menuDescriptionKey}`,
      })),
    );
  });

  it('normalizes the hidden /exitctr alias while preserving its invocation and arguments', () => {
    expect(parsePersonalBotCommand('/exitctr now')).toMatchObject({
      definition: { command: 'exctr', interactive: false },
      invocation: '/exitctr',
      args: ['now'],
    });
    expect(parsePersonalBotCommand('/HELP')).toBeNull();
    expect(parsePersonalBotCommand('/unknown')).toBeNull();
  });
});
