import { useCallback, useImperativeHandle, useMemo, useRef, useState, type ReactNode, type Ref } from 'react';
import { useMessageViewport } from './useMessageViewport';

export type MessageViewportApi = Pick<ReturnType<typeof useMessageViewport>, 'syncViewport' | 'reconcileViewport' | 'getViewportTopRow'> & {
  connect: () => void;
};

/** Own viewport state below MessageStream: mounting rows must not rerun the
 * thread's metadata projections and scroll-coordination layout effects.
 * The render function preserves the existing DOM and keyed card identities.
 */
export function MessageViewport({ apiRef, options, children }: {
  apiRef: Ref<MessageViewportApi>;
  options: Parameters<typeof useMessageViewport>[0];
  children: (viewport: ReturnType<typeof useMessageViewport> & {
    renderBody: (key: string, render: () => ReactNode) => ReactNode;
  }) => ReactNode;
}) {
  const [connection, setConnection] = useState(0);
  const connected = useRef<{ root: HTMLElement; items: HTMLElement } | null>(null);
  const viewport = useMessageViewport({ ...options, connection });
  // Keep element identity through viewport-only updates; child state/context still update.
  // Owner inputs invalidate the cache, and bodies replaced by placeholders are released.
  const bodies = useMemo(() => new Map<string, ReactNode>(), [children, options]);
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
    getViewportTopRow: viewport.getViewportTopRow,
    connect,
  }), [viewport.syncViewport, viewport.reconcileViewport, viewport.getViewportTopRow, connect]);
  const renderedBodies = new Set<string>();
  const content = children({ ...viewport, renderBody: (key, render) => {
    renderedBodies.add(key);
    if (!bodies.has(key)) bodies.set(key, render());
    return bodies.get(key);
  } });
  for (const key of bodies.keys()) {
    if (!renderedBodies.has(key)) bodies.delete(key);
  }
  return content;
}
