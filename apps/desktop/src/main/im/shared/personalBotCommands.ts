/**
 * Personal IM bot command registry.
 *
 * This is the client-side source of truth for the personal bot command set,
 * Telegram owner menu copy keys, locale policy, aliases and card capability.
 * The official bot keeps its server-owned command surface until the later
 * bridge cutover in #1855.
 */

export const PERSONAL_BOT_COMMAND_LOCALE_POLICY = 'desktop-app' as const;

export interface PersonalBotCommandDefinition {
  /** Canonical command without the leading slash. */
  command: string;
  /** Desktop i18n key used to render the personal Telegram owner menu. */
  menuDescriptionKey: `settings.telegramBot.commandMenu.${string}`;
  /** Whether the command needs a rich-card capable channel. */
  interactive: boolean;
  /** Accepted spellings that stay hidden from the Telegram command menu. */
  aliases?: readonly string[];
}

export const PERSONAL_BOT_COMMANDS = [
  {
    command: 'start',
    menuDescriptionKey: 'settings.telegramBot.commandMenu.start',
    interactive: false,
  },
  {
    command: 'new',
    menuDescriptionKey: 'settings.telegramBot.commandMenu.new',
    interactive: false,
  },
  {
    command: 'help',
    menuDescriptionKey: 'settings.telegramBot.commandMenu.help',
    interactive: false,
  },
  {
    command: 'stop',
    menuDescriptionKey: 'settings.telegramBot.commandMenu.stop',
    interactive: false,
  },
  {
    command: 'session',
    menuDescriptionKey: 'settings.telegramBot.commandMenu.session',
    interactive: true,
  },
  {
    command: 'project',
    menuDescriptionKey: 'settings.telegramBot.commandMenu.project',
    interactive: true,
  },
  {
    command: 'model',
    menuDescriptionKey: 'settings.telegramBot.commandMenu.model',
    interactive: true,
  },
  {
    command: 'permission',
    menuDescriptionKey: 'settings.telegramBot.commandMenu.permission',
    interactive: true,
  },
  {
    command: 'ctr',
    menuDescriptionKey: 'settings.telegramBot.commandMenu.ctr',
    interactive: true,
  },
  {
    command: 'exctr',
    menuDescriptionKey: 'settings.telegramBot.commandMenu.exctr',
    interactive: false,
    aliases: ['exitctr'],
  },
] as const satisfies readonly PersonalBotCommandDefinition[];

export type PersonalBotCommandName = (typeof PERSONAL_BOT_COMMANDS)[number]['command'];

const commandByInvocation = new Map<string, (typeof PERSONAL_BOT_COMMANDS)[number]>();
for (const definition of PERSONAL_BOT_COMMANDS) {
  commandByInvocation.set(`/${definition.command}`, definition);
  for (const alias of 'aliases' in definition ? (definition.aliases ?? []) : []) {
    commandByInvocation.set(`/${alias}`, definition);
  }
}

export interface ParsedPersonalBotCommand {
  definition: (typeof PERSONAL_BOT_COMMANDS)[number];
  /** Exact spelling supplied by the user, including the leading slash. */
  invocation: string;
  args: readonly string[];
}

/** Parse a known personal bot command without changing legacy case sensitivity. */
export function parsePersonalBotCommand(text: string): ParsedPersonalBotCommand | null {
  const [invocation, ...args] = text.trim().split(/\s+/);
  const definition = commandByInvocation.get(invocation);
  return definition ? { definition, invocation, args } : null;
}

/** Render the owner-scoped Telegram menu using the desktop application's locale. */
export function buildPersonalBotCommandMenu(
  translate: (key: PersonalBotCommandDefinition['menuDescriptionKey']) => string,
): ReadonlyArray<{ command: string; description: string }> {
  return PERSONAL_BOT_COMMANDS.map(({ command, menuDescriptionKey }) => ({
    command,
    description: translate(menuDescriptionKey),
  }));
}
