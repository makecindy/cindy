import { useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import type { WebViewNavigation } from 'react-native-webview/lib/WebViewTypes';
import type { HtmlPreviewProgress, MobileHtmlPreview, PrepareMobileHtmlPreview } from './mobileHtmlPreview';
import { htmlSnapshotLocation } from './htmlDirectorySnapshot';
import { errorText } from '@/debug/fileDiagnostics';
import { mobileDebugLog } from '@/debug/mobileDebugLog';

/** Visible rendered page owns the listener. Resuming rebuilds a fresh snapshot after suspension. */
export function useHtmlSnapshot(absPath: string, enabled: boolean, prepare: PrepareMobileHtmlPreview) {
  const [foreground, setForeground] = useState(AppState.currentState === 'active');
  const [epoch, setEpoch] = useState(0);
  const navigation = useRef<{ preview: MobileHtmlPreview; url: string } | null>(null);
  const [result, setResult] = useState<{
    preview?: MobileHtmlPreview; error?: unknown; path?: string; prepare?: PrepareMobileHtmlPreview; epoch?: number;
    progress?: HtmlPreviewProgress;
  }>({});
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      setForeground(state === 'active');
    });
    return () => subscription.remove();
  }, []);
  useEffect(() => {
    setResult({});
    if (!enabled || !foreground) {
      // A manual reload bypasses stale bytes only for this visit. Returning later
      // must still open the last available cache without waiting for a connection.
      setEpoch(0);
      return;
    }
    const controller = new AbortController();
    const startedAt = Date.now();
    let preview: MobileHtmlPreview | undefined;
    void prepare(absPath, controller.signal, (progress) => {
      if (!controller.signal.aborted) setResult((previous) => ({ ...previous, progress, path: absPath, prepare, epoch }));
    }, epoch === 0).then(async (value) => {
      preview = value;
      mobileDebugLog('debug', 'files', 'html preview prepared', {
        ms: Date.now() - startedAt, onDemand: value.onDemand === true, aborted: controller.signal.aborted,
      });
      if (controller.signal.aborted) { void value.close().catch(() => {}); return; }
      navigation.current = { preview: value, url: value.url };
      setResult((previous) => ({ ...previous, preview: value, path: absPath, prepare, epoch }));
      const fresh = await value.updated;
      if (fresh) {
        // Reuse the completed background snapshot. No second remote download and
        // no recursive refresh: this is one check for this opening only.
        if (controller.signal.aborted) void fresh.close().catch(() => {});
        else {
          const target = new URL(navigation.current?.url ?? value.url);
          const bootstrap = new URL(value.url);
          const atEntry = target.origin === bootstrap.origin && (target.pathname === bootstrap.pathname
            || decodeURIComponent(target.pathname) === '/' + htmlSnapshotLocation(absPath).entry);
          // A delayed update must not pull an inner page back to the entry. The
          // visit still owns both copies and releases them together on exit.
          if (atEntry) setResult({ preview: fresh, path: absPath, prepare, epoch });
        }
      }
    }).catch((error: unknown) => {
      mobileDebugLog(controller.signal.aborted ? 'debug' : 'warn', 'files', 'html preview prepare failed', {
        ms: Date.now() - startedAt, aborted: controller.signal.aborted, error: errorText(error),
      });
      if (!controller.signal.aborted) setResult((previous) => previous.preview ? previous : { error, path: absPath, prepare, epoch });
    });
    return () => {
      controller.abort();
      if (navigation.current?.preview === preview) navigation.current = null;
      void preview?.close().catch(() => {});
    };
  }, [absPath, enabled, foreground, prepare, epoch]);
  const current = enabled && foreground && result.path === absPath && result.prepare === prepare && result.epoch === epoch;
  return {
    preview: current ? result.preview : undefined,
    error: current ? result.error : undefined,
    progress: current ? result.progress : undefined,
    onNavigationStateChange: (preview: MobileHtmlPreview, state: Pick<WebViewNavigation, 'url'>) => {
      if (navigation.current?.preview === preview) navigation.current.url = state.url;
    },
    foreground, retry: () => setEpoch((value) => value + 1),
  };
}
