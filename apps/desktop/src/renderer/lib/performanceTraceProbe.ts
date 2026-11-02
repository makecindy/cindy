import type { PerformanceTraceEvent } from '../../shared/performanceTrace';

/** No key values, DOM target/text, URLs or composition data are read. */
export function installPerformanceTraceProbe(
  send: (events: PerformanceTraceEvent[]) => void,
): () => void {
  let pending: PerformanceTraceEvent[] = [];
  const observers: PerformanceObserver[] = [];
  const flush = () => {
    if (pending.length) {
      const batch = pending;
      pending = [];
      send(batch);
    }
  };
  const record = (event: PerformanceTraceEvent) => {
    pending.push(event);
    if (pending.length >= 100) flush();
  };
  const observe = (type: string, callback: (entries: PerformanceEntry[]) => void) => {
    try {
      const observer = new PerformanceObserver((list) => callback(list.getEntries()));
      observer.observe({ type, buffered: false, durationThreshold: 16 } as PerformanceObserverInit);
      observers.push(observer);
    } catch {
      /* Unsupported entry types do not disable the other probes. */
    }
  };
  observe('longtask', (entries) => {
    for (const entry of entries)
      record({
        at: performance.timeOrigin + entry.startTime,
        kind: 'long-task',
        label: 'main-thread',
        durationMs: entry.duration,
      });
  });
  observe('event', (entries) => {
    for (const entry of entries)
      if (['click', 'pointerdown', 'keydown'].includes(entry.name)) {
        const timing = entry as PerformanceEventTiming;
        record({
          at: performance.timeOrigin + entry.startTime,
          kind: 'input',
          label: entry.name,
          durationMs: entry.duration,
          inputDelayMs: timing.processingStart - entry.startTime,
          processingMs: timing.processingEnd - timing.processingStart,
        });
      }
  });
  const visibility = () =>
    record({
      at: Date.now(),
      kind: 'visibility',
      label: document.visibilityState === 'hidden' ? 'hidden' : 'visible',
      durationMs: 0,
    });
  const focus = () =>
    record({ at: Date.now(), kind: 'visibility', label: 'focused', durationMs: 0 });
  const blur = () =>
    record({ at: Date.now(), kind: 'visibility', label: 'blurred', durationMs: 0 });
  const compositionStart = () =>
    record({ at: Date.now(), kind: 'composition', label: 'start', durationMs: 0 });
  const compositionEnd = () =>
    record({ at: Date.now(), kind: 'composition', label: 'end', durationMs: 0 });
  document.addEventListener('visibilitychange', visibility);
  window.addEventListener('focus', focus);
  window.addEventListener('blur', blur);
  document.addEventListener('compositionstart', compositionStart);
  document.addEventListener('compositionend', compositionEnd);
  visibility();
  const timer = setInterval(flush, 1000);
  return () => {
    clearInterval(timer);
    for (const observer of observers) observer.disconnect();
    document.removeEventListener('visibilitychange', visibility);
    window.removeEventListener('focus', focus);
    window.removeEventListener('blur', blur);
    document.removeEventListener('compositionstart', compositionStart);
    document.removeEventListener('compositionend', compositionEnd);
    flush();
  };
}
