/** Starter choices a Market teammate offers with its opening line (stored in agentMeta.botStarterOptions). */
const BOT_STARTER_OPTIONS_MAX = 4;
const BOT_STARTER_OPTION_MAX_CHARS = 60;

export function readBotStarterOptions(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const options = raw.filter((option): option is string => typeof option === 'string'
    && option.trim().length > 0 && option.length <= BOT_STARTER_OPTION_MAX_CHARS);
  return options.length === raw.length ? options.slice(0, BOT_STARTER_OPTIONS_MAX) : [];
}

const optionList = (options: readonly string[]) => `\n\n${options.map(option => `- ${option}`).join('\n')}`;

/**
 * The host stores the options as a plain list after the greeting so mobile and older clients still show them;
 * where they render as buttons, `stripStarterOptionList` hides that exact trailing list.
 */
export function withStarterOptionList(greeting: string, options: readonly string[]): string {
  return options.length ? greeting + optionList(options) : greeting;
}

export function stripStarterOptionList(content: string, options: readonly string[]): string {
  if (!options.length) return content;
  const list = optionList(options);
  return content.endsWith(list) ? content.slice(0, -list.length) : content;
}
