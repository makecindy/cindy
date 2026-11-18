import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { BROWSER_PARTITION } from '@/../shared/webviewPartition';
import { pathToFileUrl } from '@/features/right-sidebar/lib/openInSidebarBrowser';
import { resolveSessionFileOrigin } from '@/lib/sessionFileOrigin';
import { toOsAbsolutePath } from '@/features/cc-agent/workdir-browse/lib/fileMeta';

export function InlineHtmlPreview({ workdir, relPath, deviceId, remoteHostId }: {
  workdir: string; relPath: string; deviceId?: string | null; remoteHostId?: string | null;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'failed'>('loading');
  const { t } = useTranslation();
  useEffect(() => {
    const target = host.current;
    if (!target) return;
    const origin = resolveSessionFileOrigin(deviceId ?? undefined, remoteHostId);
    const absPath = toOsAbsolutePath(workdir, relPath);
    const requestId = crypto.randomUUID();
    let disposed = false;
    const guest = document.createElement('webview');
    guest.setAttribute('partition', BROWSER_PARTITION);
    guest.setAttribute('title', relPath);
    guest.style.cssText = 'display:flex;width:100%;height:100%';
    const ready = () => setStatus('ready');
    const failed = (event: Event) => {
      const failure = event as Electron.DidFailLoadEvent;
      if (failure.isMainFrame && failure.errorCode !== -3) setStatus('failed');
    };
    setStatus('loading');
    guest.addEventListener('did-finish-load', ready);
    guest.addEventListener('did-fail-load', failed);
    void (async () => {
      const url = origin.kind === 'local' ? pathToFileUrl(absPath) :
        (await window.electronAPI.fileBrowser.previewHtml({ origin, absPath, workdir, requestId })).url;
      if (disposed) return;
      guest.setAttribute('src', url);
      target.appendChild(guest);
    })().catch(() => { if (!disposed) setStatus('failed'); });
    return () => {
      disposed = true;
      guest.removeEventListener('did-finish-load', ready);
      guest.removeEventListener('did-fail-load', failed);
      guest.remove();
      if (origin.kind !== 'local') void window.electronAPI.fileBrowser.cancelHtmlPreview(requestId).catch(() => {});
    };
  }, [deviceId, relPath, remoteHostId, workdir]);
  return <div className="relative min-h-0 flex-1">
    <div ref={host} className="absolute inset-0" />
    {status !== 'ready' && <div role="status" className="absolute inset-0 grid place-items-center bg-content-area p-3 text-sm text-muted-foreground">
      {t(status === 'failed' ? 'ccAgent.common.openFailed' : 'ccAgent.workdirBrowse.treeLoading')}
    </div>}
  </div>;
}
