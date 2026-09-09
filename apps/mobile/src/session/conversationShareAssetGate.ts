export interface ConversationShareAssetGate {
  markReady(asset: string): void;
  markFailed(asset: string): void;
  waitUntilSettled(): Promise<void>;
  finish(): ReadonlySet<string>;
}

/**
 * One prepared export owns this latch. The first result for each asset wins;
 * finish freezes the successful subset, including when the decode deadline
 * expires. Late native callbacks cannot change the capture layout.
 */
export function createConversationShareAssetGate(
  keys: readonly string[],
): ConversationShareAssetGate {
  const pending = new Set(keys);
  const ready = new Set<string>();
  let finished = false;
  let resolveSettled = () => {};
  const settled = new Promise<void>((resolve) => {
    resolveSettled = resolve;
  });
  const mark = (asset: string, success: boolean) => {
    if (finished || !pending.delete(asset)) return;
    if (success) ready.add(asset);
    if (pending.size === 0) resolveSettled();
  };
  if (pending.size === 0) resolveSettled();

  return {
    markReady: (asset) => mark(asset, true),
    markFailed: (asset) => mark(asset, false),
    waitUntilSettled: () => settled,
    finish() {
      finished = true;
      resolveSettled();
      return ready;
    },
  };
}
