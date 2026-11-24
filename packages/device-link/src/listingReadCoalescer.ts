import {
  CONTROLLER_COALESCIBLE_LISTING_CHANNELS,
  normalizeRemoteListingArgsKey,
  type InvokePriority,
} from './invokePolicy.js';
import { DeviceLinkError, isScopedPeer, type InvokePayload, type InvokeResultPayload } from './protocol.js';

const MAX_FLIGHT_SLOTS = 256;

interface ListingWaiter {
  settled: boolean;
  dispatchedChecked: boolean;
  enqueuedAt: number;
  timeoutMs: number;
  /** Immutable caller deadline from initial `run()` invocation (`enqueuedAt + timeoutMs`). */
  callDeadlineAt: number;
  /** Active wire deadline on the currently dispatched flight (`dispatchAt + budget`). */
  activeDeadlineAt: number;
  /** True once this waiter waited behind an earlier flight (follow-up or post-timeout continuation). */
  waitedBehindPriorFlight: boolean;
  /** True if attached while `flight.dispatched` was already true. */
  joinedAfterDispatch: boolean;
  /** True once at least one flight carrying this waiter has been dispatched. */
  everDispatched: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  preSend?: () => void;
  beforeDispatch?: () => void;
  canRerouteBeforeWrite?: () => boolean;
  resolve: (value: InvokeResultPayload) => void;
  reject: (error: unknown) => void;
}

export interface ListingUnderlyingControls {
  cancel(): void;
  isInFlight(): boolean;
}

interface ListingFlight {
  slotKey: string;
  dst: string;
  priority: InvokePriority;
  basePayload: InvokePayload;
  requireFresh: boolean;
  dispatched: boolean;
  wireDeadlineAt: number | null;
  settled: boolean;
  waiters: ListingWaiter[];
  scheduleAndExecute: (
    flightPriority: InvokePriority,
    slotBudgetMs: number,
    execute: () => Promise<InvokeResultPayload>,
  ) => Promise<InvokeResultPayload>;
  runWire: (ctx: ListingCoalesceExecutionContext) => Promise<InvokeResultPayload>;
  underlyingControls?: ListingUnderlyingControls;
}

interface ListingSlot {
  key: string;
  dst: string;
  active: ListingFlight;
  followUp: ListingFlight | null;
}

class ListingFlightAllCancelledError extends Error {
  constructor() {
    super('all listing waiters cancelled before dispatch');
  }
}

function cloneInvokeResult(result: InvokeResultPayload): InvokeResultPayload {
  if (typeof globalThis.structuredClone === 'function') {
    try {
      return globalThis.structuredClone(result);
    } catch {
      // Fall back to JSON round-trip below if a host value is not structured-cloneable.
    }
  }
  return JSON.parse(JSON.stringify(result)) as InvokeResultPayload;
}

function ensureFreshSessionListPayload(payload: InvokePayload, requireFresh: boolean): InvokePayload {
  if (!requireFresh || payload.channel !== 'local-db:sessions:list') return payload;
  const rawArgs = payload.args ? [...payload.args] : [];
  const opts = rawArgs[2];
  if (opts && typeof opts === 'object' && !Array.isArray(opts)) {
    if ((opts as { fresh?: unknown }).fresh === true) return payload;
    rawArgs[2] = { ...(opts as Record<string, unknown>), fresh: true };
  } else if (opts === undefined || opts === null) {
    while (rawArgs.length < 2) rawArgs.push(null);
    rawArgs[2] = { fresh: true };
  } else {
    return payload;
  }
  return { ...payload, args: rawArgs };
}

export interface ListingCoalesceCallerOptions {
  preSend?: () => void;
  beforeDispatch?: () => void;
  canRerouteBeforeWrite?: () => boolean;
  noResultCache?: boolean;
}

export interface ListingCoalesceExecutionContext {
  payload: InvokePayload;
  timeoutMs: number;
  canRerouteBeforeWrite?: () => boolean;
  recheckBeforeRetry(): void;
  setUnderlyingControls(controls: ListingUnderlyingControls): void;
}

/**
 * Controller-side single-flight coalescer for idempotent listing reads
 * (`local-db:sessions:list` and `maker:schedule:list-sidebar-index-runs`).
 *
 * - Isolation: keyed by `(scopeKey, dst, normalizedArgsKey, priority)`.
 * - Per-caller exact budgets: every caller keeps its own `callDeadlineAt = enqueuedAt + timeoutMs`
 *   with no join-gap heuristics, no clock-equality checks, and no minimum floor that could
 *   extend a caller past its deadline. When an earlier shorter-budget flight times out, any
 *   co-waiting caller whose `activeDeadlineAt` exceeded that flight's wire deadline continues
 *   in `followUp` with its exact remaining budget (`callDeadlineAt - now`).
 */
export class RemoteListingReadCoalescer {
  private readonly slots = new Map<string, ListingSlot>();

  constructor(private readonly now: () => number = () => globalThis.performance?.now?.() ?? Date.now()) {}

  run(
    scopeKey: string,
    dst: string,
    payload: InvokePayload,
    priority: InvokePriority,
    effectiveTimeoutMs: number,
    options: ListingCoalesceCallerOptions | undefined,
    scheduleAndExecute: (
      flightPriority: InvokePriority,
      slotBudgetMs: number,
      execute: () => Promise<InvokeResultPayload>,
    ) => Promise<InvokeResultPayload>,
    runWire: (ctx: ListingCoalesceExecutionContext) => Promise<InvokeResultPayload>,
  ): Promise<InvokeResultPayload> | null {
    if (options?.noResultCache || priority === 'interactive' || isScopedPeer(dst)) return null;
    const normalized = normalizeRemoteListingArgsKey(payload.channel, payload.args, {
      allowedChannels: CONTROLLER_COALESCIBLE_LISTING_CHANNELS,
    });
    if (!normalized) return null;

    const baseKey = `${scopeKey}\u0000${dst}\u0000${normalized.key}`;
    const fgKey = `${baseKey}\u0000foreground`;
    const bgKey = `${baseKey}\u0000background`;

    const existingSlot =
      priority === 'background'
        ? (this.slots.get(fgKey) ?? this.slots.get(bgKey))
        : this.slots.get(fgKey);

    if (existingSlot && !existingSlot.active.settled) {
      if (!existingSlot.active.dispatched) {
        if (normalized.fresh) existingSlot.active.requireFresh = true;
        return this.attachWaiter(existingSlot, existingSlot.active, effectiveTimeoutMs, options, false);
      }
      if (!normalized.fresh && !existingSlot.followUp) {
        return this.attachWaiter(existingSlot, existingSlot.active, effectiveTimeoutMs, options, false);
      }
      if (!existingSlot.followUp) {
        existingSlot.followUp = this.createFlight(
          existingSlot.key,
          dst,
          existingSlot.active.priority,
          payload,
          normalized.fresh,
          scheduleAndExecute,
          runWire,
        );
      } else if (normalized.fresh) {
        existingSlot.followUp.requireFresh = true;
      }
      return this.attachWaiter(existingSlot, existingSlot.followUp, effectiveTimeoutMs, options, true);
    }

    if (this.slots.size >= MAX_FLIGHT_SLOTS) return null;

    const flightPriority: InvokePriority = priority === 'background' ? 'background' : 'foreground';
    const slotKey = flightPriority === 'background' ? bgKey : fgKey;
    const flight = this.createFlight(
      slotKey,
      dst,
      flightPriority,
      payload,
      normalized.fresh,
      scheduleAndExecute,
      runWire,
    );
    const slot: ListingSlot = { key: slotKey, dst, active: flight, followUp: null };
    this.slots.set(slotKey, slot);

    const waiterPromise = this.attachWaiter(slot, flight, effectiveTimeoutMs, options, false);
    this.launchFlight(slot, flight);
    return waiterPromise;
  }

  cancelPeer(dst: string, error: DeviceLinkError): void {
    for (const [key, slot] of this.slots) {
      if (slot.dst !== dst) continue;
      if (slot.followUp) {
        this.rejectFlightWaiters(slot.followUp, error);
        slot.followUp = null;
      }
      if (!slot.active.dispatched) {
        this.rejectFlightWaiters(slot.active, error);
        this.slots.delete(key);
      }
    }
  }

  clear(error: DeviceLinkError): void {
    for (const [, slot] of this.slots) {
      this.rejectFlightWaiters(slot.active, error);
      if (slot.followUp) this.rejectFlightWaiters(slot.followUp, error);
    }
    this.slots.clear();
  }

  private createFlight(
    slotKey: string,
    dst: string,
    priority: InvokePriority,
    basePayload: InvokePayload,
    requireFresh: boolean,
    scheduleAndExecute: ListingFlight['scheduleAndExecute'],
    runWire: ListingFlight['runWire'],
  ): ListingFlight {
    return {
      slotKey,
      dst,
      priority,
      basePayload,
      requireFresh,
      dispatched: false,
      wireDeadlineAt: null,
      settled: false,
      waiters: [],
      scheduleAndExecute,
      runWire,
    };
  }

  private waiterRemainingBudgetMs(waiter: ListingWaiter, now: number): number {
    return waiter.waitedBehindPriorFlight
      ? waiter.callDeadlineAt - now
      : waiter.timeoutMs;
  }

  private launchFlight(slot: ListingSlot, flight: ListingFlight): void {
    const now = this.now();
    this.expireOverdueWaiters(flight, now);
    const live = flight.waiters.filter((w) => !w.settled);
    if (live.length === 0) {
      this.advanceSlot(slot, flight);
      return;
    }

    const admissionBudgets = live.map((w) => Math.min(Math.max(1, Math.round(this.waiterRemainingBudgetMs(w, now))), 30_000));
    const slotBudgetMs = Math.max(...admissionBudgets);
    if (live.length > 1) {
      live.forEach((waiter, idx) => {
        const budget = admissionBudgets[idx]!;
        if (budget < slotBudgetMs) {
          this.armWaiterTimer(slot, flight, waiter, budget, waiter.everDispatched);
        }
      });
    }

    void flight.scheduleAndExecute(flight.priority, slotBudgetMs, async () => {
      const dispatchNow = this.now();
      flight.dispatched = true;
      const active = this.validateAndPrepareDispatchedWaiters(flight, dispatchNow);
      if (active.length === 0) {
        throw new ListingFlightAllCancelledError();
      }
      const wireBudgets = active.map((w) => Math.max(1, Math.round(w.activeDeadlineAt - dispatchNow)));
      const initialWireTimeoutMs = Math.max(...wireBudgets);
      flight.wireDeadlineAt = dispatchNow + initialWireTimeoutMs;
      this.syncDispatchedWaiterTimers(slot, flight, dispatchNow);

      const reroute = active.every((w) => typeof w.canRerouteBeforeWrite === 'function')
        ? () => flight.waiters.filter((w) => !w.settled).every((w) => w.canRerouteBeforeWrite?.() === true)
        : undefined;
      return flight.runWire({
        payload: ensureFreshSessionListPayload(flight.basePayload, flight.requireFresh),
        timeoutMs: initialWireTimeoutMs,
        canRerouteBeforeWrite: reroute,
        recheckBeforeRetry: () => {
          const surviving = this.recheckWaitersForRetry(flight);
          if (surviving.length === 0) throw new ListingFlightAllCancelledError();
        },
        setUnderlyingControls: (controls) => {
          flight.underlyingControls = controls;
          if (flight.waiters.every((w) => w.settled)) {
            controls.cancel();
            return;
          }
          this.syncDispatchedWaiterTimers(slot, flight, this.now());
        },
      });
    }).then(
      (result) => {
        flight.settled = true;
        const surviving = flight.waiters.filter((w) => !w.settled);
        surviving.forEach((waiter, index) => {
          this.clearWaiterTimer(waiter);
          waiter.settled = true;
          waiter.resolve(surviving.length > 1 && index < surviving.length - 1 ? cloneInvokeResult(result) : result);
        });
        this.advanceSlot(slot, flight);
      },
      (error: unknown) => {
        flight.settled = true;
        if (!(error instanceof ListingFlightAllCancelledError)) {
          const settledAt = this.now();
          const isTimeout = error instanceof DeviceLinkError && error.code === 'INVOKE_TIMEOUT';
          const isPreWriteBackpressure =
            error instanceof DeviceLinkError && error.code === 'BACKPRESSURE' && !error.inFlight;
          const wireDeadlineAt = flight.wireDeadlineAt;
          for (const waiter of flight.waiters) {
            if (waiter.settled) continue;
            this.clearWaiterTimer(waiter);
            const remainingMs = waiter.callDeadlineAt - settledAt;
            const outlivedFlightBudget =
              isTimeout
                ? wireDeadlineAt !== null && waiter.activeDeadlineAt > wireDeadlineAt && remainingMs > 0
                : isPreWriteBackpressure && remainingMs >= 1;
            if (outlivedFlightBudget) {
              waiter.waitedBehindPriorFlight = true;
              if (!slot.followUp) {
                slot.followUp = this.createFlight(
                  slot.key,
                  slot.dst,
                  flight.priority,
                  flight.basePayload,
                  flight.requireFresh,
                  flight.scheduleAndExecute,
                  flight.runWire,
                );
              }
              slot.followUp.waiters.push(waiter);
              this.armWaiterTimer(slot, slot.followUp, waiter, Math.max(1, Math.round(remainingMs)), waiter.everDispatched);
              continue;
            }
            waiter.settled = true;
            waiter.reject(
              error instanceof DeviceLinkError
                ? Object.assign(new DeviceLinkError(error.code, error.message), {
                    ...(error.inFlight !== undefined ? { inFlight: error.inFlight } : {}),
                  })
                : error,
            );
          }
        }
        this.advanceSlot(slot, flight);
      },
    );
  }

  private advanceSlot(slot: ListingSlot, finished: ListingFlight): void {
    if (this.slots.get(slot.key) !== slot || slot.active !== finished) return;
    finished.settled = true;
    while (slot.followUp) {
      const next = slot.followUp;
      slot.followUp = null;
      this.expireOverdueWaiters(next, this.now());
      const live = next.waiters.filter((w) => !w.settled);
      if (live.length === 0) {
        next.settled = true;
        continue;
      }
      slot.active = next;
      this.launchFlight(slot, next);
      return;
    }
    this.slots.delete(slot.key);
  }

  private rejectFlightWaiters(flight: ListingFlight, error: DeviceLinkError): void {
    flight.settled = true;
    for (const waiter of flight.waiters) {
      if (waiter.settled) continue;
      this.clearWaiterTimer(waiter);
      waiter.settled = true;
      waiter.reject(new DeviceLinkError(error.code, error.message));
    }
  }

  private attachWaiter(
    slot: ListingSlot,
    flight: ListingFlight,
    timeoutMs: number,
    options: ListingCoalesceCallerOptions | undefined,
    isFollowUp: boolean,
  ): Promise<InvokeResultPayload> {
    if (flight.dispatched) {
      try {
        options?.preSend?.();
        options?.beforeDispatch?.();
      } catch (err) {
        return Promise.reject(err);
      }
    }
    const enqueuedAt = this.now();
    if (timeoutMs <= 0) {
      const inFlight = flight.dispatched && (flight.underlyingControls ? flight.underlyingControls.isInFlight() : true);
      const err = new DeviceLinkError(
        inFlight ? 'INVOKE_TIMEOUT' : 'BACKPRESSURE',
        `no invoke-result within ${timeoutMs}ms`,
      );
      err.inFlight = inFlight;
      return Promise.reject(err);
    }
    return new Promise<InvokeResultPayload>((resolve, reject) => {
      const callDeadlineAt = enqueuedAt + timeoutMs;
      const waiter: ListingWaiter = {
        settled: false,
        dispatchedChecked: flight.dispatched,
        enqueuedAt,
        timeoutMs,
        callDeadlineAt,
        activeDeadlineAt: callDeadlineAt,
        waitedBehindPriorFlight: isFollowUp,
        joinedAfterDispatch: flight.dispatched,
        everDispatched: flight.dispatched,
        timer: null,
        preSend: options?.preSend,
        beforeDispatch: options?.beforeDispatch,
        canRerouteBeforeWrite: options?.canRerouteBeforeWrite,
        resolve,
        reject,
      };
      flight.waiters.push(waiter);
      if (flight.dispatched) {
        this.syncDispatchedWaiterTimers(slot, flight, enqueuedAt);
      } else if (isFollowUp) {
        this.armWaiterTimer(slot, flight, waiter, Math.max(1, Math.round(timeoutMs)), false);
      } else if (flight.waiters.filter((w) => !w.settled).length > 1) {
        const live = flight.waiters.filter((w) => !w.settled);
        const maxAdmission = Math.max(...live.map((w) => Math.min(Math.max(1, Math.round(w.callDeadlineAt - enqueuedAt)), 30_000)));
        for (const w of live) {
          const remaining = Math.min(Math.max(1, Math.round(w.callDeadlineAt - enqueuedAt)), 30_000);
          if (remaining < maxAdmission && !w.timer) {
            this.armWaiterTimer(slot, flight, w, remaining, w.everDispatched);
          }
        }
      }
    });
  }

  private syncDispatchedWaiterTimers(
    slot: ListingSlot,
    flight: ListingFlight,
    now: number,
  ): void {
    const live = flight.waiters.filter((w) => !w.settled);
    if (live.length === 0) return;
    const wireDeadlineAt = flight.wireDeadlineAt;
    const hasUnderlyingControls = flight.underlyingControls !== undefined;
    for (const waiter of live) {
      const remaining = Math.round(waiter.activeDeadlineAt - now);
      if (remaining <= 0) {
        this.expireWaiterNow(
          slot,
          flight,
          waiter,
          flight.underlyingControls ? flight.underlyingControls.isInFlight() : true,
        );
        continue;
      }
      if (
        hasUnderlyingControls
        && wireDeadlineAt !== null
        && !waiter.joinedAfterDispatch
        && waiter.activeDeadlineAt >= wireDeadlineAt
      ) {
        this.clearWaiterTimer(waiter);
      } else {
        this.armWaiterTimer(slot, flight, waiter, remaining, true);
      }
    }
  }

  private expireOverdueWaiters(flight: ListingFlight, now: number): void {
    for (const waiter of flight.waiters) {
      if (waiter.settled) continue;
      if (this.waiterRemainingBudgetMs(waiter, now) > 0) continue;
      this.clearWaiterTimer(waiter);
      waiter.settled = true;
      const err = waiter.everDispatched
        ? new DeviceLinkError('INVOKE_TIMEOUT', `no invoke-result within ${waiter.timeoutMs}ms`)
        : new DeviceLinkError('BACKPRESSURE', `request expired before socket write within ${waiter.timeoutMs}ms`);
      err.inFlight = waiter.everDispatched;
      waiter.reject(err);
    }
  }

  private validateAndPrepareDispatchedWaiters(flight: ListingFlight, dispatchNow: number): ListingWaiter[] {
    const active: ListingWaiter[] = [];
    for (const waiter of flight.waiters) {
      if (waiter.settled) continue;
      const budgetMs = this.waiterRemainingBudgetMs(waiter, dispatchNow);
      if (budgetMs <= 0) {
        this.clearWaiterTimer(waiter);
        waiter.settled = true;
        const err = waiter.everDispatched
          ? new DeviceLinkError('INVOKE_TIMEOUT', `no invoke-result within ${waiter.timeoutMs}ms`)
          : new DeviceLinkError('BACKPRESSURE', `request expired before socket write within ${waiter.timeoutMs}ms`);
        err.inFlight = waiter.everDispatched;
        waiter.reject(err);
        continue;
      }
      if (!waiter.dispatchedChecked) {
        waiter.dispatchedChecked = true;
        try {
          waiter.preSend?.();
          waiter.beforeDispatch?.();
        } catch (err) {
          this.clearWaiterTimer(waiter);
          waiter.settled = true;
          waiter.reject(err);
          continue;
        }
      }
      waiter.everDispatched = true;
      waiter.activeDeadlineAt = dispatchNow + budgetMs;
      active.push(waiter);
    }
    return active;
  }

  private recheckWaitersForRetry(flight: ListingFlight): ListingWaiter[] {
    const active: ListingWaiter[] = [];
    for (const waiter of flight.waiters) {
      if (waiter.settled) continue;
      try {
        waiter.preSend?.();
        waiter.beforeDispatch?.();
        active.push(waiter);
      } catch (err) {
        this.clearWaiterTimer(waiter);
        waiter.settled = true;
        waiter.reject(err);
      }
    }
    return active;
  }

  private expireWaiterNow(
    slot: ListingSlot,
    flight: ListingFlight,
    waiter: ListingWaiter,
    inFlight: boolean,
  ): void {
    this.clearWaiterTimer(waiter);
    if (waiter.settled || flight.settled) return;
    waiter.settled = true;
    const effectiveInFlight = flight.dispatched
      ? (flight.underlyingControls ? flight.underlyingControls.isInFlight() : inFlight)
      : inFlight;
    const err = effectiveInFlight
      ? new DeviceLinkError('INVOKE_TIMEOUT', `no invoke-result within ${waiter.timeoutMs}ms`)
      : new DeviceLinkError('BACKPRESSURE', `request expired before socket write within ${waiter.timeoutMs}ms`);
    err.inFlight = effectiveInFlight;
    waiter.reject(err);
    if (flight.waiters.every((w) => w.settled)) {
      if (flight === slot.active && flight.dispatched) {
        flight.settled = true;
        flight.underlyingControls?.cancel();
        this.advanceSlot(slot, flight);
      } else if (flight === slot.followUp) {
        flight.settled = true;
        slot.followUp = null;
      }
    }
  }

  private armWaiterTimer(
    slot: ListingSlot,
    flight: ListingFlight,
    waiter: ListingWaiter,
    delayMs: number,
    inFlight: boolean,
  ): void {
    this.clearWaiterTimer(waiter);
    waiter.timer = setTimeout(() => {
      waiter.timer = null;
      this.expireWaiterNow(slot, flight, waiter, inFlight);
    }, Math.max(0, delayMs));
    (waiter.timer as unknown as { unref?: () => void }).unref?.();
  }

  private clearWaiterTimer(waiter: ListingWaiter): void {
    if (!waiter.timer) return;
    clearTimeout(waiter.timer);
    waiter.timer = null;
  }
}
