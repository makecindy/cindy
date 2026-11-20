import type { PerformanceTraceEvent, TraceUiOperation } from '../../shared/performanceTrace';

let operationSink: ((event: PerformanceTraceEvent) => void) | undefined;

export function beginTraceOperation(label: TraceUiOperation) {
  const sink = operationSink;
  if (!sink) return;
  const start = performance.now();
  const mark = (stage: TraceUiOperation, end: number) => {
    const name = `cindy.${stage}`;
    performance.mark(name);
    performance.clearMarks(name);
    sink({ at: performance.timeOrigin + start, kind: 'operation', label: stage, durationMs: end - start });
  };
  mark(label, start);
  return (stage: TraceUiOperation) => {
    if (operationSink === sink) mark(stage, performance.now());
  };
}

/** Only fixed interaction labels and timings leave the renderer. */
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
  operationSink = record;
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
  const sidebarFrames = new Map<string, number>();
  const cancelSidebarFrames = () => {
    for (const frame of sidebarFrames.values()) cancelAnimationFrame(frame);
    sidebarFrames.clear();
  };
  const visibility = () => {
    if (document.hidden) cancelSidebarFrames();
    record({
      at: Date.now(),
      kind: 'visibility',
      label: document.visibilityState === 'hidden' ? 'hidden' : 'visible',
      durationMs: 0,
    });
  };
  const focus = () =>
    record({ at: Date.now(), kind: 'visibility', label: 'focused', durationMs: 0 });
  const blur = () =>
    record({ at: Date.now(), kind: 'visibility', label: 'blurred', durationMs: 0 });
  const compositionStart = () =>
    record({ at: Date.now(), kind: 'composition', label: 'start', durationMs: 0 });
  const compositionEnd = () =>
    record({ at: Date.now(), kind: 'composition', label: 'end', durationMs: 0 });
  // Continuous input has no Event Timing entries. Sample the next animation
  // callback, including time spent waiting for dispatch, while recording only.
  const sampledAt = new Map<string, number>();
  const sampleSidebar = (event: Event) => {
    const type = event.type;
    const now = performance.now();
    if (document.hidden || sidebarFrames.has(type) || now - (sampledAt.get(type) ?? -Infinity) < 250) return;
    if (!(event.target instanceof Element) || !event.target.closest('[data-trace-sidebar-list]')) return;
    const start = event.timeStamp;
    sampledAt.set(type, now);
    sidebarFrames.set(type, requestAnimationFrame(() => {
      sidebarFrames.delete(type);
      record({ at: performance.timeOrigin + start, kind: 'input',
        label: type === 'wheel' ? 'sidebar-wheel-to-frame' : 'sidebar-pointermove-to-frame',
        durationMs: performance.now() - start, inputDelayMs: now - start });
    }));
  };
  for (const type of ['wheel', 'pointermove']) {
    document.addEventListener(type, sampleSidebar, { capture: true, passive: true });
  }
  document.addEventListener('visibilitychange', visibility);
  window.addEventListener('focus', focus);
  window.addEventListener('blur', blur);
  document.addEventListener('compositionstart', compositionStart);
  document.addEventListener('compositionend', compositionEnd);
  visibility();
  const timer = setInterval(flush, 1000);
  return () => {
    if (operationSink === record) operationSink = undefined;
    for (const type of ['wheel', 'pointermove']) document.removeEventListener(type, sampleSidebar, true);
    cancelSidebarFrames();
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
