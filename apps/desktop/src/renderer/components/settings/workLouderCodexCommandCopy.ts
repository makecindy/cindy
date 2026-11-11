/**
 * Localized names and descriptions for the commands a Codex Micro key can fire.
 *
 * The board itself carries no lettering, so this copy is the only place a user
 * finds out what a key does — it feeds the hover tooltip on the layout as well
 * as the action pickers.
 */
import type { TFunction } from 'i18next';

const COMMAND_COPY_PREFIX = 'settings.shortcuts.workLouderCodex.commands';

/**
 * Falls back to the command id split into words. Only reachable if a command
 * ships without copy, which the i18n gate would normally catch first.
 */
function humanizeCommandId(commandId: string): string {
  return commandId
    .split('.')
    .at(-1)!
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/^./, (character) => character.toUpperCase());
}

export function workLouderCodexCommandName(t: TFunction, commandId: string): string {
  const key = `${COMMAND_COPY_PREFIX}.${commandId}.name`;
  const translated = t(key);
  return translated === key ? humanizeCommandId(commandId) : translated;
}

export function workLouderCodexCommandDescription(t: TFunction, commandId: string): string | null {
  const key = `${COMMAND_COPY_PREFIX}.${commandId}.description`;
  const translated = t(key);
  return translated === key ? null : translated;
}
