import { useCallback, useRef, useState } from 'react';

import type { QueueEntry } from './queueModel';

interface Selection { key: string; nonce: number }

/**
 * Explicit selection by request identity. Nothing is selected by default, and nothing is selected
 * on the user's behalf after a decision, a removal or a list change: if the selected request is no
 * longer pending (decided, dismissed or replaced by a new requestId) the selection is simply cleared.
 */
export function useApprovalSelection(entries: QueueEntry[]) {
  const [selection, setSelection] = useState<Selection | null>(null);
  const nonce = useRef(0);
  const entriesRef = useRef(entries);
  entriesRef.current = entries;

  const live = selection !== null
    && entries.some((entry) => entry.key === selection.key && entry.phase === 'pending');
  if (selection !== null && !live) setSelection(null);

  const select = useCallback((key: string) => {
    if (!entriesRef.current.some((entry) => entry.key === key && entry.phase === 'pending')) return;
    setSelection((current) => (current?.key === key ? current : { key, nonce: ++nonce.current }));
  }, []);
  const clear = useCallback(() => setSelection(null), []);

  const active = live ? selection : null;
  return {
    selectedKey: active?.key ?? null,
    /** Changes on every new selection, so the decision gate re-arms even for a request chosen before. */
    selectionId: active ? `${active.key}#${active.nonce}` : null,
    select,
    clear,
  };
}
