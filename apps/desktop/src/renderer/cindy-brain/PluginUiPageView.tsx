import { useEffect, useRef, useState, type ReactNode } from 'react';
import { getDataOwnerGeneration, isDataOwnerGenerationCurrent } from '@/contexts/dataOwnerGeneration';

const pageIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** The main process supplies the page; this component owns only its visible lifetime. */
export function PluginUiPageView({ sessionId, viewId, revision, title, fallback, children }: {
  sessionId: string; viewId: string; revision: string; title: string; fallback: ReactNode; children?: ReactNode;
}) {
  const owner = getDataOwnerGeneration();
  const key = JSON.stringify([owner.dataOwnerId, owner.generation, sessionId, viewId, revision]);
  const [page, setPage] = useState<{ key: string; id: string }>();
  const frame = useRef<HTMLIFrameElement>(null);
  useEffect(() => {
    let closed = false, id: string | undefined;
    const close = () => {
      if (!id) return;
      const old = id; id = undefined;
      void window.electronAPI.ghosts.ui.closePage({ pageId: old }).catch(() => {});
    };
    const receive = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow) return;
      if (event.data?.method !== 'ui/notifications/sandbox-failed') return;
      close();
      if (!closed) setPage(undefined);
    };
    window.addEventListener('message', receive);
    void window.electronAPI.ghosts.ui.openPage({ sessionId, viewId, revision }).then(result => {
      if (typeof result !== 'string' || !pageIdPattern.test(result)) return;
      id = result;
      if (closed || !isDataOwnerGenerationCurrent(owner)) { close(); return; }
      setPage({ key, id });
    }).catch(() => { if (!closed) setPage(undefined); });
    return () => { closed = true; window.removeEventListener('message', receive); close(); };
  }, [key]);
  if (!page || page.key !== key) return fallback;
  return <>
    <iframe ref={frame} title={title} src={`cindy-mcp-app://${page.id}/sandbox`}
      sandbox="allow-scripts allow-same-origin allow-forms"
      allow="camera 'none'; microphone 'none'; geolocation 'none'; clipboard-write 'none'"
      className="block h-80 w-full max-w-full border-0" />
    {children}
  </>;
}
