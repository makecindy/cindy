/**
 * useExpandedBlockMemory
 * ---------------------------------------------------------------------------
 * Per-block expand/collapse state, kept only in module memory. Default state
 * for every key is **collapsed**; the user's manual expansions are lost when
 * the renderer reloads (app restart, hard refresh). This is intentional —
 * persistence across restarts caused tool blocks to greet the user pre-opened
 * which felt noisy.
 *
 * API:
 *   const [expanded, setExpanded] = useExpandedBlockMemory(blockId);
 *   setExpanded(true | false | (prev) => !prev)
 *
 * Single source of truth: a module-level `ExpandedBlockStore`
 * (`@cindy/maker-shared/expanded-block-memory` — the same core the mobile
 * client uses, so both ends keep identical semantics) shared across all hook
 * instances; its pub/sub keeps every consumer in sync.
 */

import { useCallback, useEffect, useState } from 'react';
import { createExpandedBlockStore } from '@cindy/maker-shared/expanded-block-memory';
import { createLogger } from '@/lib/logger';

const log = createLogger('UseExpandedBlockMemory');

const store = createExpandedBlockStore({
  onSubscriberError: (err) => log.warn('subscriber error:', err),
});

export interface UseExpandedBlockMemoryReturn {
  /** Whether this block is currently expanded. Default: false (collapsed). */
  expanded: boolean;
  /** Imperatively set or toggle expansion. Session-only. */
  setExpanded: (next: boolean | ((prev: boolean) => boolean)) => void;
}

/**
 * Hook: subscribes a component to a single block's expanded state.
 *
 * @param blockId  Stable key that uniquely identifies this block. Convention:
 *                 `<role>:<messageClientId>[:<segmentIdx>]` so a thinking
 *                 block, a tool segment, or even multiple segments belonging
 *                 to the same message can coexist without collision.
 */
export function useExpandedBlockMemory(blockId: string): UseExpandedBlockMemoryReturn {
  const [expanded, setExpandedState] = useState<boolean>(() => store.isExpanded(blockId));

  useEffect(() => {
    setExpandedState(store.isExpanded(blockId));
    return store.subscribe(() => {
      setExpandedState(store.isExpanded(blockId));
    });
  }, [blockId]);

  const setExpanded = useCallback(
    (next: boolean | ((prev: boolean) => boolean)) => {
      const current = store.isExpanded(blockId);
      const resolved = typeof next === 'function' ? next(current) : next;
      store.setExpanded(blockId, resolved);
    },
    [blockId],
  );

  return { expanded, setExpanded };
}

// ── Test internals ──────────────────────────────────────────────────────────
// Exposed for unit tests only; do NOT consume from production code.

export const __test_internals = {
  reset(): void {
    store.reset();
  },
  setExpanded(blockId: string, expanded: boolean): void {
    store.setExpanded(blockId, expanded);
  },
  isExpanded(blockId: string): boolean {
    return store.isExpanded(blockId);
  },
};
