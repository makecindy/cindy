/**
 * Process-local evidence that Windows is ending the current login session.
 *
 * The flag is intentionally monotonic: once Windows starts shutdown, restart,
 * or logoff, Cindy immediately enters its normal bounded shutdown path.
 */
let windowsSessionEnding = false;
const interruptedSessionIds = new Set<string>();

export function markWindowsSessionEnding(activeSessionIds: Iterable<string>): void {
  windowsSessionEnding = true;
  for (const sessionId of activeSessionIds) interruptedSessionIds.add(sessionId);
}

export function shouldSuppressWindowsSessionEndClaudeError(context: {
  sessionId: string;
  source: string | undefined;
  isTerminalError: boolean;
}): boolean {
  return (
    windowsSessionEnding &&
    interruptedSessionIds.has(context.sessionId) &&
    context.source === 'claude-code' &&
    context.isTerminalError
  );
}
