import { app, BrowserWindow, contentTracing, type WebContents } from 'electron';
import { Session } from 'node:inspector';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { writeFile, copyFile, rm } from 'node:fs/promises';
import path from 'node:path';
import type { PerformanceTraceEvent } from '../../shared/performanceTrace';
import type { TraceCapture } from './controller';
import { projectCpuProfile, type CpuProfile, type TraceReport, type TraceSample } from './report';

const TRACE_BUFFER_KB = 32 * 1024;
const PROCESS_TYPES = new Set([
  'Browser',
  'Tab',
  'GPU',
  'Utility',
  'Zygote',
  'Sandbox helper',
  'Pepper Plugin',
  'Pepper Plugin Broker',
]);
let traceBusy = false;

function bounded<T>(work: Promise<T>, ms = 10_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    work,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Profiler timed out')), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

function post(session: Session, method: string, params = {}): Promise<Record<string, unknown>> {
  return bounded(
    new Promise((resolve, reject) =>
      session.post(method, params, (error, value) =>
        error ? reject(error) : resolve((value ?? {}) as Record<string, unknown>),
      ),
    ),
  );
}

export async function beginNativeTrace({
  dir,
  source,
  startedAt,
  isCurrent,
  onSample,
  onEvent,
  onStop,
}: {
  dir: string;
  source: WebContents;
  startedAt: number;
  isCurrent(): boolean;
  onSample(sample: TraceSample): void;
  onEvent(events: PerformanceTraceEvent[]): void;
  onStop(): Promise<void>;
}): Promise<TraceCapture> {
  const sender = source;
  const window = BrowserWindow.fromWebContents(sender);
  const assertCurrent = () => {
    if (!isCurrent()) throw new Error('Recording session changed');
  };
  assertCurrent();
  const inspector = new Session();
  let mainStarted = false,
    rendererStarted = false,
    attached = false,
    traceStarted = false;
  let mainOffset = 0,
    rendererOffset = 0;
  let partial = false;
  const profiles: TraceReport['profiles'] = [];
  try {
    inspector.connect();
    await post(inspector, 'Profiler.enable');
    assertCurrent();
    await post(inspector, 'Profiler.setSamplingInterval', { interval: 4000 });
    assertCurrent();
    mainOffset = Date.now() - startedAt;
    await post(inspector, 'Profiler.start');
    mainStarted = true;
  } catch {
    partial = true;
    inspector.disconnect();
  }
  try {
    assertCurrent();
    // Never steal an existing debugger/DevTools connection.
    if (sender.debugger.isAttached()) throw new Error('Debugger already attached');
    sender.debugger.attach('1.3');
    attached = true;
    await bounded(sender.debugger.sendCommand('Profiler.enable'));
    assertCurrent();
    await bounded(sender.debugger.sendCommand('Profiler.setSamplingInterval', { interval: 4000 }));
    assertCurrent();
    rendererOffset = Date.now() - startedAt;
    await bounded(sender.debugger.sendCommand('Profiler.start'));
    rendererStarted = true;
  } catch {
    partial = true;
  }
  const previousTraceBusy = traceBusy;
  let startPending = false;
  try {
    assertCurrent();
    if (previousTraceBusy) throw new Error('Previous Chromium trace is still saving');
    traceBusy = true;
    const starting = contentTracing.startRecording({
      recording_mode: 'record-until-full',
      trace_buffer_size_in_kb: TRACE_BUFFER_KB,
      included_categories: [
        'devtools.timeline',
        'v8',
        'latencyInfo',
        'blink.user_timing',
        'disabled-by-default-v8.cpu_profiler',
      ],
    });
    startPending = true;
    try {
      await bounded(starting);
    } catch (error) {
      // A late start must not leave tracing active forever or stop a newer recording.
      void starting
        .then(() => contentTracing.stopRecording())
        .then((file) => rm(file, { force: true }))
        .catch(() => {})
        .finally(() => {
          traceBusy = false;
        });
      throw error;
    }
    traceStarted = true;
  } catch {
    partial = true;
    if (!previousTraceBusy && !startPending) traceBusy = false;
  }
  const loopDelay = monitorEventLoopDelay({ resolution: 20 });
  loopDelay.enable();
  let capacityPending = false;
  const interval = setInterval(() => {
    if (!isCurrent() || sender.isDestroyed()) {
      void onStop();
      return;
    }
    try {
      onSample({
        at: Date.now(),
        loopDelayMs: Math.max(0, loopDelay.max / 1e6 - 20),
        processes: app
          .getAppMetrics()
          .slice(0, 64)
          .map((metric) => ({
            pid: metric.pid,
            type: PROCESS_TYPES.has(metric.type) ? metric.type : 'Other',
            cpu: metric.cpu.percentCPUUsage,
            memoryKB: metric.memory.workingSetSize,
          })),
      });
    } catch {
      partial = true;
    }
    loopDelay.reset();
    if (traceStarted && !capacityPending) {
      capacityPending = true;
      void contentTracing
        .getTraceBufferUsage()
        .then(({ percentage }) => {
          if (percentage >= 0.95) void onStop();
        })
        .catch(() => {
          partial = true;
        })
        .finally(() => {
          capacityPending = false;
        });
    }
  }, 1000);
  interval.unref();
  const onDestroyed = () => {
    void onStop();
  };
  sender.once('destroyed', onDestroyed);
  const onMinimize = () =>
    onEvent([{ at: Date.now(), kind: 'visibility', label: 'minimized', durationMs: 0 }]);
  const onRestore = () =>
    onEvent([{ at: Date.now(), kind: 'visibility', label: 'restored', durationMs: 0 }]);
  window?.on('minimize', onMinimize);
  window?.on('restore', onRestore);
  let stopped = false;
  return {
    stop: async ({ discard } = { discard: false }) => {
      if (stopped) return { profiles, partial };
      stopped = true;
      clearInterval(interval);
      loopDelay.disable();
      sender.removeListener('destroyed', onDestroyed);
      window?.removeListener('minimize', onMinimize);
      window?.removeListener('restore', onRestore);
      const collect = async (
        process: 'main' | 'renderer',
        offsetMs: number,
        get: () => Promise<Record<string, unknown>>,
      ) => {
        try {
          const result = await get();
          if (discard || !isCurrent()) return;
          const profile = result.profile as CpuProfile;
          await writeFile(path.join(dir, `${process}.cpuprofile`), JSON.stringify(profile), {
            mode: 0o600,
          });
          if (!isCurrent()) return;
          const projected = projectCpuProfile(
            profile,
            app.getAppPath(),
            MAIN_WINDOW_VITE_DEV_SERVER_URL
              ? new URL(MAIN_WINDOW_VITE_DEV_SERVER_URL).origin
              : undefined,
          );
          partial ||= projected.truncated === true;
          profiles.push({ process, offsetMs, profile: projected });
        } catch {
          partial = true;
        }
      };
      await Promise.all([
        mainStarted
          ? collect('main', mainOffset, () => post(inspector, 'Profiler.stop')).finally(() =>
              inspector.disconnect(),
            )
          : Promise.resolve(),
        rendererStarted
          ? collect('renderer', rendererOffset, () =>
              bounded(sender.debugger.sendCommand('Profiler.stop')),
            )
          : Promise.resolve(),
        traceStarted
          ? bounded(
              contentTracing
                .stopRecording()
                .then(async (file) => {
                  // Chromium first writes its own temporary file. Never send an invalidated
                  // capture directly to an account directory, including a late native stop.
                  const target = path.join(dir, 'chromium-trace.json');
                  try {
                    if (!discard && isCurrent()) {
                      await copyFile(file, target);
                      if (!isCurrent()) await rm(target, { force: true });
                    }
                  } finally {
                    await rm(file, { force: true });
                  }
                })
                .finally(() => {
                  traceBusy = false;
                }),
              15_000,
            ).catch(() => {
              partial = true;
            })
          : Promise.resolve(),
      ]);
      try {
        if (attached && !sender.isDestroyed() && sender.debugger.isAttached())
          sender.debugger.detach();
      } catch {
        partial = true;
      }
      if (discard || !isCurrent()) {
        profiles.length = 0;
        await Promise.all(
          ['main.cpuprofile', 'renderer.cpuprofile', 'chromium-trace.json'].map((name) =>
            rm(path.join(dir, name), { force: true }),
          ),
        );
      }
      return { profiles, partial };
    },
  };
}
