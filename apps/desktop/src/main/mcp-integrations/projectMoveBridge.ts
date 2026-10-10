/** Neutral bridge: send/turn delivery must not import the DB move implementation. */
let hooks: {
  beforeSend(sessionId: string): Promise<void>;
  onIdle(): void;
  hasPending(sessionId: string): boolean;
} | null = null;

export function setProjectMoveHooks(next: typeof hooks): void {
  hooks = next;
}

/** Caller owns the session route lock; runs before reading cwd or creating a runtime. */
export async function applyProjectMoveBeforeSend(sessionId: string): Promise<void> {
  await hooks?.beforeSend(sessionId);
}

export function settleProjectMovesAfterIdle(): void {
  hooks?.onIdle();
}

/** Queue admission stays quiet until the host has committed or rolled back the move. */
export function hasPendingProjectMove(sessionId: string): boolean {
  return hooks?.hasPending(sessionId) ?? false;
}
