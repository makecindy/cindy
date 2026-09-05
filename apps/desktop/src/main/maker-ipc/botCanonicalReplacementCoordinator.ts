type BotCanonicalReplacementOperation<T> = () => Promise<T>;
type BotCanonicalReplacementCoordinator = <T>(
  sessionId: string,
  operation: BotCanonicalReplacementOperation<T>,
) => Promise<T>;

// Before Maker wiring there cannot be a live Agent runtime to race. The
// composition root installs the send-lock + busy guard as soon as maker IPC is
// loaded; keeping this leaf module dependency-free also lets LocalDB tests run
// without importing Electron/device-link runtime side effects.
let coordinator: BotCanonicalReplacementCoordinator = async (_sessionId, operation) =>
  operation();

export function configureBotCanonicalReplacementCoordinator(
  next: BotCanonicalReplacementCoordinator,
): void {
  coordinator = next;
}

export function coordinateBotCanonicalReplacement<T>(
  sessionId: string,
  operation: BotCanonicalReplacementOperation<T>,
): Promise<T> {
  return coordinator(sessionId, operation);
}
