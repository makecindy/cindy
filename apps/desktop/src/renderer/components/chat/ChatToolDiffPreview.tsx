import { createContext, useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';

import { getDataOwnerGeneration, subscribeDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';

import { ToolPayloadLightbox, type ToolPayloadMode } from './ToolPayloadLightbox';

export type ToolDiffPayload = Extract<ToolPayloadMode, { kind: 'diff' }>;

export const ChatToolDiffPreviewContext = createContext<
  ((payload: ToolDiffPayload, trigger: HTMLElement) => void) | null
>(null);

export function ChatToolDiffPreviewProvider({ scope, children }: {
  scope: string | undefined;
  children: ReactNode;
}) {
  const owner = useSyncExternalStore(subscribeDataOwnerGeneration, getDataOwnerGeneration);
  const nextId = useRef(0);
  const [preview, setPreview] = useState<{
    id: number;
    scope: string;
    owner: typeof owner;
    payload: ToolDiffPayload;
    triggerRef: { current: HTMLElement };
  } | null>(null);

  const open = useCallback((payload: ToolDiffPayload, trigger: HTMLElement) => {
    if (scope === undefined) return;
    // The clicked call supplies a snapshot. A live activity can leave the
    // render window while the user is still reading that same diff.
    setPreview({ id: ++nextId.current, scope, owner, payload, triggerRef: { current: trigger } });
  }, [scope, owner]);

  useEffect(() => {
    setPreview(current => current && current.scope === scope && current.owner === owner ? current : null);
  }, [scope, owner]);

  return (
    <ChatToolDiffPreviewContext.Provider value={scope === undefined ? null : open}>
      {children}
      {preview && preview.scope === scope && preview.owner === owner && (
        <ToolPayloadLightbox
          key={preview.id}
          payload={preview.payload}
          triggerRef={preview.triggerRef}
          onClose={() => setPreview(current => current === preview ? null : current)}
        />
      )}
    </ChatToolDiffPreviewContext.Provider>
  );
}
