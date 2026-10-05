import { useCallback, useImperativeHandle, useRef, useState, type ReactNode, type Ref } from 'react';
import { useMessageViewport } from './useMessageViewport';

export type MessageViewportApi = Pick<ReturnType<typeof useMessageViewport>, 'syncViewport' | 'reconcileViewport'> & {
  connect: () => void;
};

/** Own viewport state below MessageStream: mounting rows must not rerun the
 * thread's metadata projections and scroll-coordination layout effects.
 * The render function preserves the existing DOM and keyed card identities.
 */
export function MessageViewport({ apiRef, options, children }: {
  apiRef: Ref<MessageViewportApi>;
  options: Parameters<typeof useMessageViewport>[0];
  children: (viewport: ReturnType<typeof useMessageViewport>) => ReactNode;
}) {
  const [connection, setConnection] = useState(0);
  const connected = useRef<{ root: HTMLElement; items: HTMLElement } | null>(null);
  const viewport = useMessageViewport({ ...options, connection });
  const layout = useRef(viewport.connectViewport);
  layout.current = viewport.connectViewport;
  const connect = useCallback(() => {
    const root = options.scrollRef.current, items = options.itemsRef.current;
    if (!root || !items || (connected.current?.root === root && connected.current.items === items)) return;
    connected.current = { root, items };
    // Initialize before the owner's later layout effects restore its precise
    // reading offset. Deferring this until our next commit overwrites restoration.
    layout.current();
    setConnection(value => value + 1);
  }, [options.scrollRef, options.itemsRef]);
  useImperativeHandle(apiRef, () => ({
    syncViewport: viewport.syncViewport,
    reconcileViewport: viewport.reconcileViewport,
    connect,
  }), [viewport.syncViewport, viewport.reconcileViewport, connect]);
  return children(viewport);
}
