export const BOT_SESSION_CONTROL_MODES = ['none', 'observe', 'coordinate'] as const;

export type BotSessionControlMode = (typeof BOT_SESSION_CONTROL_MODES)[number];

export function normalizeBotSessionControlMode(value: unknown): BotSessionControlMode {
  return value === 'observe' || value === 'coordinate' ? value : 'none';
}

/**
 * A Profile permission declaration, not a replacement for cindy_helper's
 * runtime authorization. The control plane still verifies sender identity,
 * target state, queue ownership and provider support for every operation.
 */
export function buildBotSessionControlContext(mode: BotSessionControlMode): string {
  if (mode === 'none') return '';
  const observation = [
    '## Cindy Task Control',
    'You may observe other local Cindy tasks through cindy_helper when its task-control tools are available.',
    'Before acting on an inbox event, inspect the current task runtime and queue; treat the event as a notification rather than current truth.',
    'Do not claim that an action succeeded unless the tool returned a structured acknowledgement.',
  ];
  if (mode === 'observe') {
    return [
      ...observation,
      'Your Profile permits observation only. Do not send, steer, stop, edit, or cancel work in another task.',
    ].join('\n');
  }
  return [
    ...observation,
    'Your Profile permits coordination: send work, steer an active turn, request a graceful stop, and edit or cancel only queue messages created by this task.',
    'Never hard-kill a task or bypass a tool rejection. Remote task control remains unavailable unless the control plane explicitly reports support.',
  ].join('\n');
}
