import type { InvokePriority } from "./invokePolicy.js";
import { DeviceLinkError } from "./protocol.js";
import { parseSharedTaskPeer } from "./sharedTaskPeer.js";
import { diagnosticChannel, diagnosticRef } from './stallDiagnostics.js';

export interface InvokeDiagnostic {
  channel: string;
  request: string;
  source?: 'renderer' | 'main' | 'mobile' | 'client';
}

const MAX_ACTIVE = 12;
const MAX_BACKGROUND_ACTIVE = 4;
/**
 * Interactive writes (send / steer / stop / answer) may run beyond MAX_ACTIVE by this
 * many. The ordinary limit stays exactly where it was for reads, so a task view that
 * keeps twelve history and list reads in flight can never make a send wait for one of
 * them to settle. The allowance is small on purpose: it only has to cover what a person
 * can trigger by hand, and it is local admission only, not transport capacity.
 */
const INTERACTIVE_EXTRA_ACTIVE = 2;
const MAX_QUEUED = 128;
// Background refreshes cannot consume the last waiting positions for user actions.
const MAX_BACKGROUND_QUEUED = 96;

interface Job {
  peerId: string;
  priority: InvokePriority;
  diagnostic?: InvokeDiagnostic;
  queuedAt: number;
  startedAt?: number;
  start(): void;
  cancel(error: DeviceLinkError): void;
}
interface PeerQueue {
  active: number;
  background: number;
  jobs: Job[];
  running: Set<Job>;
}

/** Local admission only: never retries or cancels an operation already sent. */
export class InvokeScheduler {
  private readonly peers = new Map<string, PeerQueue>();

  constructor(private readonly isPressured: (peerId: string) => boolean = () => false,
    private readonly observe?: (peer: string, reason: 'full' | 'expired' | 'slow', snapshot: Record<string, unknown>) => void,
    private readonly now: () => number = () => performance.now()) {}

  snapshot(peerId: string): Record<string, unknown> {
    const peer = this.peers.get(parseSharedTaskPeer(peerId)?.deviceId ?? peerId);
    const now = this.now();
    const summarize = (jobs: Iterable<Job>) => {
      const groups = new Map<string, { channel: string; priority: InvokePriority; count: number; oldestMs: number; request: string; source: string }>();
      for (const job of jobs) {
        const channel = diagnosticChannel(job.diagnostic?.channel ?? 'unknown');
        const key = `${channel}:${job.priority}:${job.diagnostic?.source ?? 'client'}`;
        const age = Math.round(Math.max(0, now - (job.startedAt ?? job.queuedAt)));
        const group = groups.get(key) ?? { channel, priority: job.priority, count: 0, oldestMs: -1, request: 'unknown', source: job.diagnostic?.source ?? 'client' };
        group.count++;
        if (age > group.oldestMs) { group.oldestMs = age; group.request = diagnosticRef(job.diagnostic?.request); }
        groups.set(key, group);
      }
      const ranked = [...groups.values()].sort((a, b) => b.oldestMs - a.oldestMs || b.count - a.count);
      return { top: ranked.slice(0, 3), omittedGroups: Math.max(0, ranked.length - 3) };
    };
    return { active: peer?.active ?? 0, backgroundActive: peer?.background ?? 0, queued: peer?.jobs.length ?? 0,
      running: summarize(peer?.running ?? []), waiting: summarize(peer?.jobs ?? []) };
  }

  private report(peer: string, reason: 'full' | 'expired' | 'slow', diagnostic?: InvokeDiagnostic, waitMs?: number): void {
    if (!this.observe) return;
    try { this.observe(peer, reason, { ...this.snapshot(peer), channel: diagnosticChannel(diagnostic?.channel ?? 'unknown'),
      request: diagnosticRef(diagnostic?.request), source: diagnostic?.source ?? 'client', waitMs }); } catch { /* Diagnostics cannot reject work. */ }
  }

  run<T>(
    peerId: string,
    priority: InvokePriority | boolean,
    waitMs: number,
    run: () => Promise<T>,
    diagnostic?: InvokeDiagnostic,
  ): Promise<T> {
    // Older callers pass the background flag; keep that contract.
    const resolved: InvokePriority = typeof priority === "boolean"
      ? (priority ? "background" : "foreground")
      : priority;
    const background = resolved === "background";
    // Shared-task handles share the physical host's capacity, but keep their
    // scoped peer identity for cancellation and all transport bookkeeping.
    const deviceId = parseSharedTaskPeer(peerId)?.deviceId ?? peerId;
    let peer = this.peers.get(deviceId);
    if (!peer) {
      peer = { active: 0, background: 0, jobs: [], running: new Set() };
      this.peers.set(deviceId, peer);
    }
    const state = peer;
    if (
      state.jobs.length >= (background ? MAX_BACKGROUND_QUEUED : MAX_QUEUED)
    ) {
      this.report(peerId, 'full', diagnostic);
      return Promise.reject(
        new DeviceLinkError(
          "BACKPRESSURE",
          "local remote invoke queue is full",
        ),
      );
    }
    return new Promise<T>((resolve, reject) => {
      const queuedAt = Date.now();
      const job: Job = {
        peerId,
        priority: resolved,
        diagnostic,
        queuedAt: this.now(),
        cancel: (error) => {
          clearTimeout(timer);
          // The transport may mark its error inFlight later; queued calls were never sent.
          reject(new DeviceLinkError(error.code, error.message));
        },
        start: () => {
          clearTimeout(timer);
          // A suspended app may resume before its expired timers run. Never send stale work.
          if (Date.now() - queuedAt >= waitMs) {
            this.report(peerId, 'expired', diagnostic, Math.round(this.now() - job.queuedAt));
            reject(
              new DeviceLinkError(
                "BACKPRESSURE",
                "remote invoke expired before dispatch",
              ),
            );
            return;
          }
          state.active++;
          job.startedAt = this.now();
          state.running.add(job);
          if (background) state.background++;
          if (job.startedAt - job.queuedAt >= 1_000) this.report(peerId, 'slow', diagnostic, Math.round(job.startedAt - job.queuedAt));
          let result: Promise<T>;
          try {
            result = run();
          } catch (error) {
            result = Promise.reject(error);
          }
          void result.then(resolve, reject).finally(() => {
            state.active--;
            state.running.delete(job);
            if (background) state.background--;
            this.drain(deviceId, state);
          });
        },
      };
      const timer = setTimeout(() => {
        const index = state.jobs.indexOf(job);
        if (index < 0) return;
        this.report(peerId, 'expired', diagnostic, Math.round(this.now() - job.queuedAt));
        state.jobs.splice(index, 1);
        job.cancel(
          new DeviceLinkError(
            "BACKPRESSURE",
            "remote invoke expired before dispatch",
          ),
        );
        this.drain(deviceId, state);
      }, waitMs);
      state.jobs.push(job);
      this.drain(deviceId, state);
    });
  }

  /** Keep active slots until their promises settle, including across reconnects. */
  cancel(peerId: string, error: DeviceLinkError): void {
    const deviceId = parseSharedTaskPeer(peerId)?.deviceId ?? peerId;
    const state = this.peers.get(deviceId);
    if (!state) return;
    const cancelled = state.jobs.filter((job) => job.peerId === peerId);
    state.jobs = state.jobs.filter((job) => job.peerId !== peerId);
    for (const job of cancelled) job.cancel(error);
    this.drain(deviceId, state);
  }

  clear(error: DeviceLinkError, keep?: (peerId: string) => boolean): void {
    for (const [deviceId, state] of this.peers) {
      for (const job of state.jobs.splice(0)) {
        if (keep?.(job.peerId)) state.jobs.push(job);
        else job.cancel(error);
      }
      this.drain(deviceId, state);
    }
  }

  /**
   * Admission order: interactive (own allowance, always first), then foreground, then
   * background under its own cap. A queue is drained front to back within one priority,
   * so two sends still go out in the order they were made.
   */
  private drain(deviceId: string, state: PeerQueue): void {
    while (state.jobs.length) {
      let index = -1;
      if (state.active < MAX_ACTIVE + INTERACTIVE_EXTRA_ACTIVE) {
        index = state.jobs.findIndex((job) => job.priority === "interactive");
      }
      if (index < 0 && state.active < MAX_ACTIVE) {
        index = state.jobs.findIndex((job) => job.priority === "foreground");
        if (index < 0) {
          index = state.jobs.findIndex((job) => job.priority === "background");
          // Keep one background read progressing, but do not refill a slow
          // transport with four new reads every time old requests time out.
          const limit = index >= 0 && this.isPressured(state.jobs[index].peerId) ? 1 : MAX_BACKGROUND_ACTIVE;
          if (index >= 0 && state.background >= limit) index = -1;
        }
      }
      if (index < 0) break;
      state.jobs.splice(index, 1)[0].start();
    }
    if (!state.active && !state.jobs.length) this.peers.delete(deviceId);
  }
}
