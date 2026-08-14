import type { Transaction } from '@tiptap/pm/state';

import type { UnifiedCommand } from '@/lib/slashCommands';

const PLAN_MODE_COMPOSER_COMMAND = 'plan';

export function addPlanModeComposerCommand(
  commands: UnifiedCommand[],
  description: string | null,
): UnifiedCommand[] {
  if (
    !description ||
    commands.some((command) => command.name.toLowerCase() === PLAN_MODE_COMPOSER_COMMAND)
  ) {
    return commands;
  }
  return [
    {
      kind: 'desktop',
      name: PLAN_MODE_COMPOSER_COMMAND,
      description,
    },
    ...commands,
  ];
}

export function consumePlanModeComposerCommand(
  tr: Transaction,
  from: number,
  to: number,
  command: UnifiedCommand,
  available: boolean,
): boolean {
  if (!available || command.kind !== 'desktop') return false;
  if (command.name.toLowerCase() !== PLAN_MODE_COMPOSER_COMMAND) return false;
  tr.delete(from, to);
  return true;
}

export function isPlanModeComposerCommandText(
  text: string,
  available: boolean,
  commands: readonly UnifiedCommand[] | null,
): boolean {
  return (
    available &&
    commands !== null &&
    !commands.some((command) => command.name.toLowerCase() === PLAN_MODE_COMPOSER_COMMAND) &&
    text.trim().toLowerCase() === `/${PLAN_MODE_COMPOSER_COMMAND}`
  );
}

export function shouldPreservePlanModeComposerDraft(
  attachmentCount: number,
  browserCommentCount: number,
): boolean {
  return attachmentCount > 0 || browserCommentCount > 0;
}
