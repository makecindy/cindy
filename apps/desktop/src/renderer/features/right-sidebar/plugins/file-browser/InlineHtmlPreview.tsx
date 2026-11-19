import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useBrowserWebview } from '../../hooks/useBrowserWebview';
import { browserWebviewPool } from '../../lib/browserWebviewPool';
import { pathToFileUrl } from '@/features/right-sidebar/lib/openInSidebarBrowser';
import { resolveSessionFileOrigin } from '@/lib/sessionFileOrigin';
import { toOsAbsolutePath } from '@/features/cc-agent/workdir-browse/lib/fileMeta';
import { BrowserResourceNotices } from '../web-browser/BrowserResourceNotices';
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
  const editedWhileHidden = useRef(false);
  const [status, setStatus] = useState<'loading' | 'ready' | 'failed'>('loading');
  const { t } = useTranslation();
  const origin = useMemo(() => deviceId === undefined && !remoteHostId ? null :
    resolveSessionFileOrigin(deviceId ?? undefined, remoteHostId), [deviceId, remoteHostId]);
  const absPath = toOsAbsolutePath(workdir, relPath);
  const localUrl = origin?.kind === 'local' ? pathToFileUrl(absPath) : '';
  // File guests share the browser's bounded lifetime. Only their popup owner
  // and visibility are reported to main, outside the browser automation registry.
  const browser = useBrowserWebview(tabId, undefined, active, !!origin);
  const { wrapper, webview } = browser;
  useLayoutEffect(() => {
    if (!host.current || !wrapper) return;
    host.current.appendChild(wrapper);
    return () => {
      if (browserWebviewPool.peek(tabId)?.wrapper === wrapper) browserWebviewPool.release(tabId);
    };
  }, [wrapper, tabId]);
  useHiddenPageAudioMute(webview, active);
  useLocalHtmlAutoReload({
    sessionId, workdir, url: localUrl, enabled: !!webview && !!localUrl,
    // The chat store reports edits in memory. Keep watching the live guest's
    // file while hidden and defer the actual navigation until it is visible.
    reload: () => {
      if (active) reloadGuest.current?.();
      else editedWhileHidden.current = true;
    },
  });
  useEffect(() => {
    if (active && editedWhileHidden.current) {
      editedWhileHidden.current = false;
      reloadGuest.current?.();
    }
  }, [active]);
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
    if (!webview) return;
    let reportedId: number | undefined;
    const reportOpener = () => {
      const bridge = window.electronAPI.rsbBrowserBridge;
      if (!bridge?.reportPreviewOpener) return;
      try {
        const webContentsId = webview.getWebContentsId();
        if (reportedId === webContentsId) return;
        reportedId = webContentsId;
        void bridge.reportPreviewOpener({ sessionId, tabId, webContentsId, visible: active }).catch(error => {
          if (reportedId === webContentsId) reportedId = undefined;
          log.warn('File preview opener report failed', error);
        });
      } catch {
        // The id is available after attachment. dom-ready retries early reports.
      }
    };
    webview.addEventListener('did-attach', reportOpener);
    webview.addEventListener('dom-ready', reportOpener);
    reportOpener();
    return () => {
      webview.removeEventListener('did-attach', reportOpener);
      webview.removeEventListener('dom-ready', reportOpener);
    };
  }, [webview, sessionId, tabId, active]);
  useEffect(() => {
    setStatus('loading');
    if (!webview || !origin) return;
    const requestId = crypto.randomUUID();
    let disposed = false;
    const guest = webview;
    guest.setAttribute('title', relPath);
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
    })().catch(() => { if (!disposed) setStatus('failed'); });
    return () => {
      disposed = true;
      editedWhileHidden.current = false;
      reloadGuest.current = null;
      guest.removeEventListener('did-finish-load', ready);
      guest.removeEventListener('did-fail-load', failed);
      if (origin.kind !== 'local') void window.electronAPI.fileBrowser.cancelHtmlPreview(requestId).catch(() => {});
    };
  }, [absPath, localUrl, origin, relPath, sessionId, tabId, webview, workdir]);
  return <div className="relative min-h-0 flex-1">
    <div ref={host} className="absolute inset-0" />
    {!browser.crash && status !== 'ready' && <div role="status" className="absolute inset-0 grid place-items-center bg-content-area p-3 text-sm text-muted-foreground">
      {t(status === 'failed' ? 'ccAgent.common.openFailed' : 'ccAgent.workdirBrowse.treeLoading')}
    </div>}
    <BrowserResourceNotices tabId={tabId} tabVisible={active} crash={browser.crash}
      resourceAlert={browser.resourceAlert} dismissResourceAlert={browser.dismissResourceAlert}
      onRecover={() => {
        const src = webview?.getAttribute('src');
        if (browser.crash?.reason === 'unresponsive' || browser.crash?.reason === 'navigation-loop') browser.reload();
        else if (src) browser.navigate(src);
      }} />
  </div>;
}
