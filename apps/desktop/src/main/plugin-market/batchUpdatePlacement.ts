// Each market install retains its inspected package while waiting for review.
// Once approved, wait for the preceding installation to finish, including its
// final inspection and cleanup. Never occupy a slot while waiting for a user.
let previousPlacement: Promise<void> = Promise.resolve();

export async function withBatchUpdatePlacement<T>(
  install: (waitForTurn: () => Promise<void>) => Promise<T>,
): Promise<T> {
  let release: (() => void) | undefined;
  let turn: Promise<void> | undefined;
  function waitForTurn() {
    if (!turn) {
      turn = previousPlacement;
      previousPlacement = new Promise<void>(resolve => { release = resolve; });
    }
    return turn;
  }
  try {
    return await install(waitForTurn);
  } finally {
    release?.();
  }
}
