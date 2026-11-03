import { useCallback, useMemo, useRef, useState } from 'react';
import type { ChatSessionFileContextValue } from '@/components/chat/ChatSessionFileContext';
import { generatedFilesCheckKey } from '@/components/chat/GeneratedFilesCard';
import type { RenderItem } from '@/components/chat/messageWorkGroups';

/** Feed the real file card's visibility back into the teammate projection.
 * Keep confirmations across viewport unmounts, but never across file-context or
 * candidate/time-window changes. No duplicate stat and no persisted chat edits.
 */
export function useBotGeneratedFileDeliveries(
  items: readonly RenderItem[],
  scope: ChatSessionFileContextValue,
) {
  const candidates = useMemo(() => new Map(items.flatMap((item) =>
    item.type === 'generated_files' ? [[item.key, generatedFilesCheckKey(
      item.files, item.turnStartMs, item.turnEndMs, item.turnSealed,
    )] as const] : [])), [items]);
  const current = useRef({ scope, candidates });
  current.current = { scope, candidates };
  const [checked, setChecked] = useState({ scope, visible: new Set<string>() });
  const onGeneratedFilesVisibilityChange = useCallback((checkKey: string, visible: boolean) => {
    // Ignore completion from a previous session/origin or replaced candidate.
    if (current.current.scope !== scope) return;
    const valid = new Set(current.current.candidates.values());
    if (!valid.has(checkKey)) return;
    setChecked((previous) => {
      const next = new Set(previous.scope === scope
        ? [...previous.visible].filter((key) => valid.has(key)) : []);
      if (visible) next.add(checkKey);
      else next.delete(checkKey);
      if (previous.scope === scope && next.size === previous.visible.size
        && [...next].every((key) => previous.visible.has(key))) return previous;
      return { scope, visible: next };
    });
  }, [scope]);
  const visibleGeneratedFileKeys = useMemo(() => new Set(
    [...candidates].flatMap(([key, fingerprint]) =>
      checked.scope === scope && checked.visible.has(fingerprint) ? [key] : []),
  ), [candidates, checked, scope]);
  return { visibleGeneratedFileKeys, onGeneratedFilesVisibilityChange };
}
