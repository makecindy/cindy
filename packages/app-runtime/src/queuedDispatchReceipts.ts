/** Ephemeral observers only: the input coordinator remains the lifecycle authority. */
export function createQueuedDispatchReceipts() {
  let closed = false;
  const pending = new Map<string, { promise: Promise<boolean>; resolve: (accepted: boolean) => void }>();
  const keyOf = (sessionId: string, clientId: string) => JSON.stringify([sessionId, clientId]);
  const settle = (sessionId: string, clientId: string | undefined, accepted: boolean): void => {
    if (!clientId) return;
    const key = keyOf(sessionId, clientId);
    const receipt = pending.get(key);
    pending.delete(key);
    receipt?.resolve(accepted);
  };
  return {
    async dispatch(sessionId: string, clientId: string, enqueue: () => unknown): Promise<boolean> {
      if (closed) return false;
      const key = keyOf(sessionId, clientId);
      const existing = pending.get(key);
      if (existing) return existing.promise;
      let resolve!: (accepted: boolean) => void;
      const promise = new Promise<boolean>((done) => { resolve = done; });
      pending.set(key, { promise, resolve });
      try {
        enqueue();
        return await promise;
      } catch (error) {
        settle(sessionId, clientId, false);
        throw error;
      }
    },
    settle,
    close(): void {
      closed = true;
      const receipts = [...pending.values()];
      pending.clear();
      for (const receipt of receipts) receipt.resolve(false);
    },
  };
}
