import { useEffect, useState } from 'react';
import { AppState } from 'react-native';
import type { MobileHtmlPreview, PrepareMobileHtmlPreview } from './mobileHtmlPreview';
import { errorText } from '@/debug/fileDiagnostics';
import { mobileDebugLog } from '@/debug/mobileDebugLog';

/** Visible rendered page owns the listener. Resuming rebuilds a fresh snapshot after suspension. */
export function useHtmlSnapshot(absPath: string, enabled: boolean, prepare: PrepareMobileHtmlPreview) {
  const [foreground, setForeground] = useState(AppState.currentState === 'active');
  const [epoch, setEpoch] = useState(0);
  const [result, setResult] = useState<{
    preview?: MobileHtmlPreview; error?: unknown; path?: string; prepare?: PrepareMobileHtmlPreview; epoch?: number;
  }>({});
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      setForeground(state === 'active');
      if (state === 'active') setEpoch((value) => value + 1);
    });
    return () => subscription.remove();
  }, []);
  useEffect(() => {
    setResult({});
    if (!enabled || !foreground) return;
    const controller = new AbortController();
    const startedAt = Date.now();
    let preview: MobileHtmlPreview | undefined;
    void prepare(absPath, controller.signal).then((value) => {
      preview = value;
      mobileDebugLog('debug', 'files', 'html preview prepared', {
        ms: Date.now() - startedAt, onDemand: value.onDemand === true, aborted: controller.signal.aborted,
      });
      if (controller.signal.aborted) void value.close().catch(() => {});
      else setResult({ preview: value, path: absPath, prepare, epoch });
    }).catch((error: unknown) => {
      mobileDebugLog(controller.signal.aborted ? 'debug' : 'warn', 'files', 'html preview prepare failed', {
        ms: Date.now() - startedAt, aborted: controller.signal.aborted, error: errorText(error),
      });
      if (!controller.signal.aborted) setResult({ error, path: absPath, prepare, epoch });
    });
    return () => {
      controller.abort();
      void preview?.close().catch(() => {});
    };
  }, [absPath, enabled, foreground, prepare, epoch]);
  const current = enabled && foreground && result.path === absPath && result.prepare === prepare && result.epoch === epoch;
  return {
    preview: current ? result.preview : undefined,
    error: current ? result.error : undefined,
    foreground, retry: () => setEpoch((value) => value + 1),
  };
}
