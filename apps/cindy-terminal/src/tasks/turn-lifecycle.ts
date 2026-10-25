import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { AgentEvent, Logger, Session } from '@cindy/maker-core';
import type { DbClient } from '@cindy/runtime-db';
import type { AgentInputCoordinator } from '@cindy/app-runtime/agent-input-coordinator';
import { createSessionTurnObserver, type SessionTurnObserverHost } from '@cindy/app-runtime/sessionTurnObserver';
import { SessionTurnLeaseTracker, SilentStopTurnLeaseGate } from '@cindy/app-runtime/sessionTurnLease';
import { createSilentStopRuntime, type SilentStopRuntimeHost } from '@cindy/app-runtime/silentStopRuntime';
import { ProductTurnWallClockTracker, ProductTurnUsageTargetTracker } from '@cindy/app-runtime/turnWallClock';
import { SilentStopAutoResumeGuard } from '@cindy/remote-agent/host/silentStopAutoResume';

type Reason = 'exhausted' | 'skip' | 'send-failed';
type PendingContinuation = { session: Session; generation: number; leaseId: string; timer?: ReturnType<typeof setTimeout> };

/** Native host ports for the original turn leases, provider admission and empty
 * response continuation. The provider generation is always owned by Maker. */
export class TerminalTurnLifecycle {
  readonly guard: SilentStopAutoResumeGuard;
  readonly leaseGate = new SilentStopTurnLeaseGate();
  readonly leases: SessionTurnLeaseTracker;
  readonly wallClock = new ProductTurnWallClockTracker();
  readonly usageTargets = new ProductTurnUsageTargetTracker();
  readonly continuation: ReturnType<typeof createSilentStopRuntime>;
  private readonly observer;
  private readonly sessionIds = new Set<string>();
  private readonly pending = new Map<string, PendingContinuation>();
  private readonly listeners = new Map<string, Set<(id: string, reason: Reason) => void>>();
  constructor(private readonly host: {
    profileDir: string;
    logger: Logger;
    assertCurrent(): void;
    getDbClient(): DbClient;
    coordinator(): AgentInputCoordinator | null;
    observer: SessionTurnObserverHost;
    beforeStart(session: Session): Promise<void>;
    advanceRuntimeRecoveryNotice(session: Session): void;
    createDbMessage: SilentStopRuntimeHost['createDbMessage'];
    emit(channel: string, payload: unknown): void;
    settled(session: Session, reason: Reason): Promise<void>;
  }) {
    this.guard = new SilentStopAutoResumeGuard({ log: host.logger, isEnabled: () => {
      try { return JSON.parse(readFileSync(path.join(host.profileDir, 'silent-stop-auto-resume-settings.json'), 'utf8')).enabled !== false; }
      catch { return true; }
    } });
    this.leases = new SessionTurnLeaseTracker({ getDbClient: host.getDbClient,
      owner: { instanceId: randomUUID(), processId: process.pid }, createTurnId: randomUUID,
      now: Date.now, warn: (message, fields) => host.logger.warn(message, fields) });
    this.observer = createSessionTurnObserver(host.observer);
    this.continuation = createSilentStopRuntime({
      get agentInputCoordinatorHolder() { return host.coordinator(); },
      silentStopTurnLeaseGate: this.leaseGate, silentStopAutoResumeGuard: this.guard,
      productTurnWallClockTracker: this.wallClock,
      advanceRuntimeRecoveryNotice: host.advanceRuntimeRecoveryNotice, createDbMessage: host.createDbMessage,
      broadcastToAllWindows: host.emit, MAKER_PUSH: {EVENT:'maker:event'}, log:host.logger,
      settleSilentStopDone: async (id, reason, leaseId, session, generation) => {
        this.leaseGate.settle(id, leaseId);
        if (!await this.leases.markTurnEndedAndCheckIdle(id, leaseId, () => session.settleHostTurnContinuation(generation))) return;
        this.wallClock.clear(id); this.usageTargets.clear(id);
        await host.settled(session, reason);
        this.notify(id, reason);
      },
    });
  }
  running(id: string) { return this.pending.has(id); }
  noteUserSend(id: string) { this.guard.noteUserSend(id); }
  onSettled(id: string, listener: (id: string, reason: Reason) => void) {
    const listeners = this.listeners.get(id) ?? new Set(); listeners.add(listener); this.listeners.set(id, listeners);
    return () => { listeners.delete(listener); if (!listeners.size) this.listeners.delete(id); };
  }
  private notify(id: string, reason: Reason) {
    for (const listener of this.listeners.get(id) ?? []) {
      try { listener(id, reason); } catch { this.host.logger.warn('Channel continuation listener failed'); }
    }
  }
  private cancel(record: PendingContinuation) {
    clearTimeout(record.timer);
    if (this.pending.get(record.session.id) === record) this.pending.delete(record.session.id);
    record.session.settleHostTurnContinuation(record.generation);
  }
  bind(session: Session) {
    this.sessionIds.add(session.id);
    const removeObserver = this.observer.installSessionTurnObserver({
      log: this.host.logger, silentStopTurnLeaseGate: this.leaseGate, sessionTurnLeaseTracker: this.leases,
      providerTurnLeaseId: (instance, generation) => `${instance}:${generation}`,
      beforeLocalProviderStart: async () => {
        this.host.assertCurrent();
        await this.host.beforeStart(session);
        this.host.assertCurrent();
        const prior = this.pending.get(session.id);
        if (prior) this.cancel(prior);
        this.guard.noteTurnStarted(session.id);
      },
    }, session);
    const removeEvents = session.onEvent(event => this.observe(session, event));
    return () => {
      removeEvents();
      const prior = this.pending.get(session.id);
      if (prior?.session === session) this.cancel(prior);
      removeObserver();
    };
  }
  private observe(session: Session, event: AgentEvent) {
    if (event.turnScope === 'background') return;
    const leaseId = this.leaseGate.turnLeaseIdForEvent(event);
    if (!leaseId) return;
    const prior = this.pending.get(session.id);
    if (prior?.leaseId === leaseId) return;
    if (prior) this.cancel(prior);
    const generation = session.getTurnGeneration();
    const record = { session, generation, leaseId };
    this.pending.set(session.id, record);
  }
  async handleSilentStopTurnEnd(...args:Parameters<typeof this.continuation.handleSilentStopTurnEnd>) {
    const record=this.pending.get(args[0].id);
    try {await this.continuation.handleSilentStopTurnEnd(...args);}
    finally {if(this.pending.get(args[0].id)===record)this.pending.delete(args[0].id);}
  }
  async stop(session: Session) {
    const record = this.pending.get(session.id);
    this.guard.noteSessionReset(session.id);
    this.leaseGate.supersede(session.id);
    if (record) this.cancel(record);
    await session.abort();
    await this.leases.markTurnEnded(session.id);
    if (record) { await this.host.settled(session, 'skip'); this.notify(session.id, 'skip'); }
  }
  async flush() { await Promise.all([...this.sessionIds].map(id => this.leases.markTurnEnded(id))); }
  close() {
    for (const record of this.pending.values()) { this.leaseGate.supersede(record.session.id); this.cancel(record); }
    this.listeners.clear();
  }
}
