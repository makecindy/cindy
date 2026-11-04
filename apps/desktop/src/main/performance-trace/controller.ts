import { createIpcError } from '../../shared/ipc-errors';
import {
  TRACE_MAX_DURATION_MS,
  TRACE_MAX_EVENTS,
  type PerformanceTraceState,
} from '../../shared/performanceTrace';
import { projectTraceEvent, type TraceReport, type TraceSample } from './report';
import { setTraceOperationObserver } from './measure';

export interface TraceCapture {
  stop(options?: {
    discard: boolean;
  }): Promise<{ profiles: TraceReport['profiles']; partial: boolean }>;
}
export interface TraceControllerDeps {
  now(): number;
  owner(): string;
  reportId(): string;
  environment(): Pick<TraceReport, 'appVersion' | 'platform' | 'arch'>;
  begin(id: string, startedAt: number, isCurrent: () => boolean): Promise<TraceCapture>;
  save(report: TraceReport): Promise<void>;
  upload(report: TraceReport, note: string): Promise<void>;
  reveal(id: string): Promise<void>;
  changed(state: PerformanceTraceState): void;
}
const idle = (): PerformanceTraceState => ({
  phase: 'idle',
  startedAt: null,
  reportId: null,
  uploaded: false,
  partial: false,
  durationMs: 0,
});

export class PerformanceTraceController {
  private state = idle();
  private report: TraceReport | null = null;
  private capture: TraceCapture | null = null;
  private owner = '';
  private timer: ReturnType<typeof setTimeout> | null = null;
  private starting: Promise<PerformanceTraceState> | null = null;
  private cancellation = new AbortController();
  private stopping: Promise<PerformanceTraceState> | null = null;
  private revealing = false;
  constructor(private readonly deps: TraceControllerDeps) {}
  canStart(): boolean {
    return !this.revealing && ['idle', 'ready'].includes(this.state.phase);
  }
  snapshot(): PerformanceTraceState {
    return this.owner && !this.isCurrent() ? idle() : { ...this.state };
  }
  private emit(patch: Partial<PerformanceTraceState>) {
    this.state = { ...this.state, ...patch };
    this.deps.changed(this.snapshot());
  }
  private assertOwner() {
    if (!this.isCurrent())
      throw createIpcError('PRECONDITION_FAILED', 'Recording belongs to another app session');
  }
  private isCurrent() {
    return !this.cancellation.signal.aborted && this.owner === this.deps.owner();
  }
  start(): Promise<PerformanceTraceState> {
    if (!this.canStart())
      return Promise.reject(createIpcError('PRECONDITION_FAILED', 'A recording is already active'));
    this.starting = this.startCapture().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }
  private async startCapture(): Promise<PerformanceTraceState> {
    this.owner = this.deps.owner();
    this.cancellation = new AbortController();
    const owner = this.owner,
      signal = this.cancellation.signal;
    const startedAt = this.deps.now(),
      reportId = this.deps.reportId();
    this.report = {
      version: 1,
      reportId,
      startedAt,
      durationMs: 0,
      ...this.deps.environment(),
      scope: 'local-desktop',
      remoteHostCaptured: false,
      partial: false,
      droppedEvents: 0,
      events: [],
      samples: [],
      profiles: [],
    };
    this.emit({ ...idle(), phase: 'starting', startedAt, reportId });
    try {
      this.capture = await this.deps.begin(
        reportId,
        startedAt,
        () => !signal.aborted && owner === this.deps.owner(),
      );
      this.assertOwner();
      this.emit({ phase: 'recording' });
      setTraceOperationObserver((event) => this.events([event]));
      this.timer = setTimeout(
        () => {
          void this.stop().catch(() => {});
        },
        Math.max(0, TRACE_MAX_DURATION_MS - (this.deps.now() - startedAt)),
      );
      this.timer.unref?.();
      return this.snapshot();
    } catch (error) {
      await this.capture?.stop({ discard: true }).catch(() => {});
      this.capture = null;
      this.report = null;
      this.emit(idle());
      throw error;
    }
  }
  events(values: unknown[]): void {
    if (!['recording', 'saving'].includes(this.state.phase) || !this.report || !this.isCurrent())
      return;
    for (const value of values.slice(0, 100)) {
      const event = projectTraceEvent(
        value,
        this.report.startedAt,
        this.state.phase === 'saving'
          ? this.report.startedAt + this.report.durationMs
          : this.deps.now(),
      );
      if (!event) continue;
      if (this.report.events.length >= TRACE_MAX_EVENTS) {
        this.report.droppedEvents++;
        continue;
      }
      this.report.events.push(event);
    }
  }
  sample(sample: TraceSample): void {
    if (this.state.phase === 'recording' && this.report && this.report.samples.length < 65)
      this.report.samples.push(sample);
  }
  /** Owner invalidation discards potentially mixed-account evidence. Window loss still saves. */
  stop(): Promise<PerformanceTraceState> {
    if (this.stopping) return this.stopping;
    if (this.state.phase === 'ready') return Promise.resolve(this.snapshot());
    if (this.state.phase !== 'recording' || !this.report || !this.capture)
      return Promise.reject(createIpcError('PRECONDITION_FAILED', 'No active recording'));
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    setTraceOperationObserver(null);
    this.emit({ phase: 'saving' });
    const report = this.report,
      capture = this.capture;
    report.durationMs = this.deps.now() - report.startedAt;
    this.stopping = (async () => {
      try {
        const result = await capture.stop({ discard: !this.isCurrent() });
        report.profiles = result.profiles;
        report.partial = result.partial || report.droppedEvents > 0;
      } catch {
        report.partial = true;
      }
      this.capture = null;
      if (!this.isCurrent()) {
        this.report = null;
        this.emit(idle());
        return this.snapshot();
      }
      try {
        await this.deps.save(report);
      } catch (error) {
        if (!this.isCurrent()) {
          this.report = null;
          this.emit(idle());
          return this.snapshot();
        }
        // Preserve the in-memory result so reveal/upload can retry saving it.
        report.partial = true;
        this.emit({ phase: 'ready', partial: true, durationMs: report.durationMs });
        throw error;
      }
      if (!this.isCurrent()) {
        this.report = null;
        this.emit(idle());
        return this.snapshot();
      }
      this.emit({ phase: 'ready', durationMs: report.durationMs, partial: report.partial });
      return this.snapshot();
    })().finally(() => {
      this.stopping = null;
    });
    return this.stopping;
  }
  async reveal(): Promise<PerformanceTraceState> {
    this.assertOwner();
    if (this.revealing || this.state.phase !== 'ready' || !this.report)
      throw createIpcError('PRECONDITION_FAILED', 'Recording is not ready');
    this.revealing = true;
    try {
      await this.deps.save(this.report);
      this.assertOwner();
      await this.deps.reveal(this.report.reportId);
      return this.snapshot();
    } finally {
      this.revealing = false;
    }
  }
  async upload(note: string): Promise<PerformanceTraceState> {
    this.assertOwner();
    if (this.revealing || this.state.phase !== 'ready' || !this.report)
      throw createIpcError('PRECONDITION_FAILED', 'Recording is not ready');
    if (this.state.uploaded) return this.snapshot();
    this.emit({ phase: 'uploading' });
    try {
      await this.deps.save(this.report);
      this.assertOwner();
      await this.deps.upload(this.report, note);
      this.assertOwner();
      this.emit({ uploaded: true });
    } finally {
      this.emit({ phase: 'ready' });
    }
    return this.snapshot();
  }
  async close(): Promise<void> {
    if (this.starting) await this.starting.catch(() => {});
    if (this.stopping) await this.stopping.catch(() => {});
    else if (this.state.phase === 'recording') await this.stop().catch(() => {});
  }
  invalidate(): Promise<void> {
    this.cancellation.abort();
    return this.close();
  }
  /** Retention must not delete an active capture/upload or resurrect an expired in-memory report. */
  releaseExpiredReport(id: string): boolean {
    if (this.state.reportId !== id) return true;
    if (this.revealing || this.state.phase !== 'ready') return false;
    this.report = null;
    this.emit(idle());
    return true;
  }
}
