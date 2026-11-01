import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { redact } from '../log-upload/redact';
import type { PerformanceTraceEvent } from '../../shared/performanceTrace';
import { TRACE_MAX_EVENTS } from '../../shared/performanceTrace';
import { TRACE_OPERATIONS } from './measure';

const LABELS: Record<PerformanceTraceEvent['kind'], ReadonlySet<string>> = {
  'long-task': new Set(['main-thread']),
  input: new Set(['click', 'pointerdown', 'keydown']),
  composition: new Set(['start', 'end']),
  visibility: new Set(['visible', 'hidden', 'focused', 'blurred', 'minimized', 'restored']),
  ipc: TRACE_OPERATIONS,
};
export function projectTraceEvent(
  value: unknown,
  start: number,
  now: number,
): PerformanceTraceEvent | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (
    typeof v.kind !== 'string' ||
    !Object.hasOwn(LABELS, v.kind) ||
    typeof v.label !== 'string' ||
    !LABELS[v.kind as PerformanceTraceEvent['kind']].has(v.label) ||
    typeof v.at !== 'number' ||
    !Number.isFinite(v.at) ||
    v.at < start ||
    v.at > now + 1000 ||
    typeof v.durationMs !== 'number' ||
    !Number.isFinite(v.durationMs) ||
    v.durationMs < 0 ||
    v.durationMs > 120_000
  )
    return null;
  const event: PerformanceTraceEvent = {
    at: Math.round(v.at),
    kind: v.kind as PerformanceTraceEvent['kind'],
    label: v.label,
    durationMs: Math.round(v.durationMs * 100) / 100,
  };
  if (event.kind === 'input')
    for (const key of ['inputDelayMs', 'processingMs'] as const) {
      if (typeof v[key] === 'number' && Number.isFinite(v[key]) && v[key] >= 0 && v[key] <= 120_000)
        event[key] = Math.round(v[key]);
    }
  return event;
}
export interface CpuProfile {
  nodes: Array<{
    id: number;
    callFrame: { functionName: string; url: string; lineNumber: number; columnNumber: number };
    children?: number[];
  }>;
  startTime: number;
  endTime: number;
  samples?: number[];
  timeDeltas?: number[];
  truncated?: boolean;
}
export interface TraceSample {
  at: number;
  loopDelayMs: number;
  processes: Array<{ pid: number; type: string; cpu: number; memoryKB: number }>;
}
export interface TraceReport {
  version: 1;
  reportId: string;
  startedAt: number;
  durationMs: number;
  appVersion: string;
  platform: string;
  arch: string;
  scope: 'local-desktop';
  remoteHostCaptured: false;
  partial: boolean;
  droppedEvents: number;
  events: PerformanceTraceEvent[];
  samples: TraceSample[];
  profiles: Array<{ process: 'main' | 'renderer'; offsetMs: number; profile: CpuProfile }>;
}

/** Only Cindy-owned bundled code gets names/locations. External and evaluated code stays opaque.
 * No source text, full paths, script ids or arbitrary profiler properties enter the report. */
export function projectCpuProfile(
  profile: CpuProfile,
  appRoot: string,
  devOrigin?: string,
): CpuProfile {
  const root = path.resolve(appRoot);
  const nodes = profile.nodes.slice(0, 20_000).map((node) => {
    const frame = node.callFrame;
    let source = '';
    try {
      const url = new URL(frame.url);
      if (url.protocol === 'file:') {
        const relative = path.relative(root, fileURLToPath(url));
        if (!relative.startsWith('..') && !path.isAbsolute(relative))
          source = path.basename(relative);
      } else if (devOrigin && url.origin === devOrigin) source = path.posix.basename(url.pathname);
    } catch {
      if (path.isAbsolute(frame.url)) {
        const relative = path.relative(root, frame.url);
        if (!relative.startsWith('..') && !path.isAbsolute(relative))
          source = path.basename(relative);
      }
    }
    if (!/^[\w.-]{1,120}\.[cm]?[jt]sx?$/.test(source)) source = '';
    const internal = ['(root)', '(idle)', '(program)', '(garbage collector)'].includes(
      frame.functionName,
    );
    const name = internal
      ? frame.functionName
      : source && /^[\w.$ <>:-]{1,120}$/.test(frame.functionName)
        ? redact(frame.functionName)
        : '(external or anonymous)';
    return {
      id: node.id,
      callFrame: {
        functionName: name,
        url: source,
        lineNumber: source ? frame.lineNumber : -1,
        columnNumber: source ? frame.columnNumber : -1,
      },
      children: node.children?.slice(0, 20_000),
    };
  });
  const ids = new Set(nodes.map((n) => n.id));
  for (const node of nodes) node.children = node.children?.filter((id) => ids.has(id));
  // Preserve timeline gaps for omitted nodes instead of making later samples appear earlier.
  const samples: number[] = [],
    timeDeltas: number[] = [];
  let delta = 0;
  for (let i = 0; i < Math.min(profile.samples?.length ?? 0, 30_000); i++) {
    delta += profile.timeDeltas?.[i] ?? 0;
    if (ids.has(profile.samples![i])) {
      samples.push(profile.samples![i]);
      timeDeltas.push(delta);
      delta = 0;
    }
  }
  return {
    nodes,
    startTime: profile.startTime,
    endTime: profile.endTime,
    samples,
    timeDeltas,
    truncated:
      nodes.length < profile.nodes.length || samples.length < (profile.samples?.length ?? 0),
  };
}
