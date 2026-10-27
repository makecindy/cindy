/** Host-owned /goal semantics shared by Desktop and Mobile. */
export type GoalCommand =
  | { action: 'open-dialog' }
  | { action: 'clear' }
  | { action: 'set'; objective: string };

const CLEAR_ALIASES = new Set(['clear', 'stop', 'off', 'cancel', 'reset', 'none']);

export function parseGoalCommand(args: string): GoalCommand {
  const objective = args.trim();
  if (!objective) return { action: 'open-dialog' };
  if (CLEAR_ALIASES.has(objective.toLowerCase())) return { action: 'clear' };
  return { action: 'set', objective };
}
