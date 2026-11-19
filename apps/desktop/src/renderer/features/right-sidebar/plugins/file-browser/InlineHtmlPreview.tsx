import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { BROWSER_PARTITION } from '@/../shared/webviewPartition';
import { pathToFileUrl } from '@/features/right-sidebar/lib/openInSidebarBrowser';
import { resolveSessionFileOrigin } from '@/lib/sessionFileOrigin';
import { toOsAbsolutePath } from '@/features/cc-agent/workdir-browse/lib/fileMeta';
import { useLocalHtmlAutoReload } from '../web-browser/useLocalHtmlAutoReload';
import { useHiddenPageAudioMute } from '../web-browser/useHiddenPageAudioMute';
import { closeTab } from '../../store';
import { createLogger } from '@/lib/logger';

const log = createLogger('rightSidebar.inlineHtmlPreview');

export function InlineHtmlPreview({ workdir, relPath, deviceId, remoteHostId, sessionId, tabId, active }: {
  workdir: string; relPath: string; deviceId?: string | null; remoteHostId?: string | null;
  sessionId: string; tabId: string; active: boolean;
}) {
  const host = useRef<HTMLDivElement>(null);
  const reloadGuest = useRef<(() => void) | null>(null);
  const [webview, setWebview] = useState<Electron.WebviewTag | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'failed'>('loading');
  const { t } = useTranslation();
  const origin = useMemo(() => deviceId === undefined && !remoteHostId ? null :
    resolveSessionFileOrigin(deviceId ?? undefined, remoteHostId), [deviceId, remoteHostId]);
  const absPath = toOsAbsolutePath(workdir, relPath);
  const localUrl = origin?.kind === 'local' ? pathToFileUrl(absPath) : '';
  useHiddenPageAudioMute(webview, active);
  useLocalHtmlAutoReload({
    sessionId, workdir, url: localUrl, enabled: active && !!localUrl, reload: () => reloadGuest.current?.(),
  });
  useEffect(() => {
    if (!active || !webview) return;
    return window.electronAPI.onRsbBrowserCommand(({ command }) => {
      if (document.activeElement !== webview) return;
      if (command === 'close-tab') {
        void closeTab(sessionId, tabId).catch(error => log.warn('Could not close file preview tab', error));
      } else if (command === 'reload') {
        reloadGuest.current?.();
      } else {
        // Electron history APIs can throw while the guest is attaching or being removed.
        try {
          if (command === 'go-back' && webview.canGoBack()) webview.goBack();
          if (command === 'go-forward' && webview.canGoForward()) webview.goForward();
        } catch (error) {
          log.warn('Could not navigate file preview history', error);
        }
      }
    });
  }, [active, sessionId, tabId, webview]);
  useEffect(() => {
    const target = host.current;
    setStatus('loading');
    setWebview(null);
    if (!target || !origin) return;
    const requestId = crypto.randomUUID();
    let disposed = false;
    const guest = document.createElement('webview') as Electron.WebviewTag;
    guest.setAttribute('partition', BROWSER_PARTITION);
    guest.setAttribute('title', relPath);
    guest.style.cssText = 'display:flex;width:100%;height:100%';
    let canReload = false;
    let pendingReload = false;
    reloadGuest.current = () => {
      if (canReload) guest.reload();
      else pendingReload = true;
    };
    const finishLoad = (result: 'ready' | 'failed') => {
      canReload = true;
      setStatus(result);
      if (pendingReload) {
        pendingReload = false;
        guest.reload();
      }
    };
    const ready = () => finishLoad('ready');
    const failed = (event: Event) => {
      const failure = event as Electron.DidFailLoadEvent;
      if (failure.isMainFrame && failure.errorCode !== -3) finishLoad('failed');
    };
    guest.addEventListener('did-finish-load', ready);
    guest.addEventListener('did-fail-load', failed);
    void (async () => {
      const url = origin.kind === 'local' ? localUrl :
        (await window.electronAPI.fileBrowser.previewHtml({ origin, absPath, workdir, requestId })).url;
      if (disposed) return;
      guest.setAttribute('src', url);
      target.appendChild(guest);
      setWebview(guest);
    })().catch(() => { if (!disposed) setStatus('failed'); });
    return () => {
      disposed = true;
      reloadGuest.current = null;
      guest.removeEventListener('did-finish-load', ready);
      guest.removeEventListener('did-fail-load', failed);
      guest.remove();
      if (origin.kind !== 'local') void window.electronAPI.fileBrowser.cancelHtmlPreview(requestId).catch(() => {});
    };
  }, [absPath, localUrl, origin, relPath, workdir]);
  return <div className="relative min-h-0 flex-1">
    <div ref={host} className="absolute inset-0" />
    {status !== 'ready' && <div role="status" className="absolute inset-0 grid place-items-center bg-content-area p-3 text-sm text-muted-foreground">
      {t(status === 'failed' ? 'ccAgent.common.openFailed' : 'ccAgent.workdirBrowse.treeLoading')}
    </div>}
  </div>;
}
