export type ConversationShareFooterAsset = "character" | "logo";

export interface ConversationShareFooterAssetGate {
  markReady(asset: ConversationShareFooterAsset): void;
  waitUntilReady(): Promise<void>;
}

/**
 * The SVG footer contains two independently decoded bundled images. Keep the
 * readiness latch separate from React so export can wait for both assets and
 * the ordering/duplicate-load behavior stays unit-testable.
 */
export function createConversationShareFooterAssetGate(): ConversationShareFooterAssetGate {
  const pending = new Set<ConversationShareFooterAsset>(["character", "logo"]);
  let resolveReady = () => {};
  const ready = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });

  return {
    markReady(asset) {
      pending.delete(asset);
      if (pending.size === 0) resolveReady();
    },
    waitUntilReady() {
      return ready;
    },
  };
}
