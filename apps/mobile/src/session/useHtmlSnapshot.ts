import { useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import type { WebViewNavigation } from 'react-native-webview/lib/WebViewTypes';
import type { HtmlPreviewProgress, MobileHtmlPreview, PrepareMobileHtmlPreview } from './mobileHtmlPreview';
import { htmlSnapshotLocation } from './htmlDirectorySnapshot';
import { errorText } from '@/debug/fileDiagnostics';
import { mobileDebugLog } from '@/debug/mobileDebugLog';

/** Where the reader was in a snapshot: a same-origin document path ('' = entry) and CSS scroll offsets. */
export interface HtmlReadingPosition { path: string; x: number; y: number }
interface Shown { preview: MobileHtmlPreview; url: string; x: number; y: number }

/** Snapshot origins change on every rebuild; only the document path carries over. */
function readingPath(url: string, bootstrap: string): string {
  try {
    const target = new URL(url);
    if (target.origin !== new URL(bootstrap).origin || target.pathname.startsWith('/__cindy/')) return '';
    return target.pathname + target.search + target.hash;
  } catch { return ''; }
}
const positionOf = (shown: Shown): HtmlReadingPosition => ({ path: readingPath(shown.url, shown.preview.url), x: shown.x, y: shown.y });

/**
 * Visible rendered page owns the listener. Resuming rebuilds a fresh snapshot after suspension
 * (the native server stops in the background); the rebuilt page reopens where the reader left off.
 */
export function useHtmlSnapshot(absPath: string, enabled: boolean, prepare: PrepareMobileHtmlPreview) {
  const [foreground, setForeground] = useState(AppState.currentState === 'active');
  const [epoch, setEpoch] = useState(0);
  const navigation = useRef<Shown | null>(null);
  const suspended = useRef(false);
  // Survives the teardown caused by suspension; consumed by the next snapshot of the same file.
  const resume = useRef<HtmlReadingPosition & { absPath: string } | null>(null);
  const [result, setResult] = useState<{
    preview?: MobileHtmlPreview; error?: unknown; path?: string; prepare?: PrepareMobileHtmlPreview; epoch?: number;
    progress?: HtmlPreviewProgress; restore?: HtmlReadingPosition;
  }>({});
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      suspended.current = state !== 'active';
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
      const restore = resume.current?.absPath === absPath
        ? { path: resume.current.path, x: resume.current.x, y: resume.current.y } : undefined;
      resume.current = null;
      navigation.current = { preview: value, url: value.url, x: restore?.x ?? 0, y: restore?.y ?? 0 };
      setResult((previous) => ({ ...previous, preview: value, path: absPath, prepare, epoch, restore }));
      const fresh = await value.updated;
      if (fresh) {
        // Reuse the completed background snapshot. No second remote download and
        // no recursive refresh: this is one check for this opening only.
        if (controller.signal.aborted) void fresh.close().catch(() => {});
        else {
          const shown = navigation.current;
          const target = new URL(shown?.url ?? value.url);
          const bootstrap = new URL(value.url);
          const atEntry = target.origin === bootstrap.origin && (target.pathname === bootstrap.pathname
            || decodeURIComponent(target.pathname) === '/' + htmlSnapshotLocation(absPath).entry);
          // A delayed update must not pull an inner page back to the entry. The
          // visit still owns both copies and releases them together on exit.
          if (atEntry) {
            const position = shown ? positionOf(shown) : undefined;
            navigation.current = { preview: fresh, url: fresh.url, x: position?.x ?? 0, y: position?.y ?? 0 };
            setResult({ preview: fresh, path: absPath, prepare, epoch, restore: position });
          }
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
      if (suspended.current && navigation.current) resume.current = { absPath, ...positionOf(navigation.current) };
      navigation.current = null;
      void preview?.close().catch(() => {});
    };
  }, [absPath, enabled, foreground, prepare, epoch]);
  const current = enabled && foreground && result.path === absPath && result.prepare === prepare && result.epoch === epoch;
  return {
    preview: current ? result.preview : undefined,
    error: current ? result.error : undefined,
    progress: current ? result.progress : undefined,
    /** Position to reopen for the current preview; tied to that preview only. */
    restore: current ? result.restore : undefined,
    onNavigationStateChange: (preview: MobileHtmlPreview, state: Pick<WebViewNavigation, 'url'>) => {
      const shown = navigation.current;
      if (shown?.preview !== preview || !state.url || state.url === shown.url) return;
      // A different document starts at its top; same-document anchors and the
      // bootstrap redirect to the entry keep the (possibly restored) scroll.
      const document = (url: string) => url.split('#')[0];
      if (readingPath(shown.url, preview.url) && document(state.url) !== document(shown.url)) { shown.x = 0; shown.y = 0; }
      shown.url = state.url;
    },
    onScroll: (preview: MobileHtmlPreview, x: number, y: number) => {
      const shown = navigation.current;
      if (shown?.preview === preview && Number.isFinite(x) && Number.isFinite(y)) { shown.x = x; shown.y = y; }
    },
    foreground, retry: () => setEpoch((value) => value + 1),
  };
}
