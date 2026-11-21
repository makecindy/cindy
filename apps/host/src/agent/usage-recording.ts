import { AsyncLocalStorage } from 'node:async_hooks';
import type { AgentEvent, Session } from '@cindy/maker-core';
import { isTurnContinuationBoundaryEvent } from '@cindy/maker-shared/turn-continuation';
import { bindUsageBroadcastPorts } from '../../../desktop/src/main/usageBroadcastPorts.ts';
import { bindTurnUsagePorts } from '../../../desktop/src/main/maker-ipc/turnUsagePorts.ts';
import { recordSessionTurnSpend, recordSessionTurnTokens } from '../../../desktop/src/main/sessionSpendBroadcasterCore.ts';
import {
  codexUsageToTokens,
  piUsageToTokens,
  recordSchedulerTurnCost,
  recordTurnCostOnMessage,
  recordTurnUsageOnMessage,
  type TurnCostDeps,
} from '../../../desktop/src/main/turnCostBroadcasterCore.ts';
import { recordModelMismatchOnMessage } from '../../../desktop/src/main/modelMismatchBroadcasterCore.ts';
import { recordCodexTurnUsage, recordModelTurnUsage, recordTurnSpend } from '../../../desktop/src/main/usageBroadcasterCore.ts';
import { recordSessionClaudeTurnUsage } from '../../../desktop/src/main/maker-ipc/sessionClaudeTurnUsageCore.ts';
import { recordSessionCodexTurnUsage } from '../../../desktop/src/main/maker-ipc/sessionCodexTurnUsageCore.ts';
import { recordSessionPiTurnUsage } from '../../../desktop/src/main/maker-ipc/sessionPiTurnUsageCore.ts';
import { captureTurnUsageContext, type TurnUsageContext } from '../../../desktop/src/main/maker-ipc/turnUsageContextCore.ts';
import { flushSessionPiTurnUsage, retryPendingPiUsageReceipts } from '../../../desktop/src/main/maker-ipc/piUsageReceiptsCore.ts';
import { ProductTurnUsageTargetTracker, ProductTurnWallClockTracker } from '../../../desktop/src/main/maker-ipc/turnWallClock.ts';
import { readSessionModelForUsage, unpricedSubscriptionValueMarker } from '../../../desktop/src/main/maker-ipc/turnUsageSessionDefaults.ts';
import { ClaudeOutputLagTimingGuard, type ModelUsageCumulative } from '../../../desktop/src/main/usage/modelUsageDelta.ts';
import { getModelPriceQuote } from '../../../desktop/src/main/usage/modelPricingCore.ts';
import { readPriorUserRoundCost } from '../../../desktop/src/main/localDb/ipc/localHistoryViewReader.ts';
import { patchMessageAgentMetaWithResultRow } from '../../../desktop/src/main/localDb/messageMutations.ts';
import { getCurrentDbClientSnapshot, type CurrentDbClientSnapshot } from '../../../desktop/src/main/localDb/client/current.ts';
import { applyScheduleRunCostMetaChange, recordScheduleRunCostDirect } from '../../../desktop/src/main/scheduler-host/runCostLedger.ts';
import { onUsagePricingChanged } from '../../../desktop/src/main/usage/pricingChanges.ts';
import type { CodexProxyAuthInjection } from '../../../desktop/src/main/maker-host/codex-proxy-host.ts';
import { createLogger } from '../../../desktop/src/main/logger.ts';
import type { HostUsagePricing } from './usage-pricing.ts';

const log = createLogger('host-usage-recording');

/**
 * The Host's turn usage recording (release table row 13, 3d): the desktop's three turn recorders
 * (sessionClaudeTurnUsageCore.ts, sessionCodexTurnUsageCore.ts, sessionPiTurnUsageCore.ts) and the
 * write cores they call, over the Host's own owner database, prices and accounts. turn-executor.mjs
 * feeds them each event where the desktop's pipeline does (sessionEventPipeline.ts).
 *
 * What the Host does itself (release table §七):
 * - Task context. The recorders' ports (usageBroadcastPorts.ts, turnUsagePorts.ts) are process-wide,
 *   but a task's message writes go through that task's durable write queue (event-persistence.ts).
 *   Every recorder call runs inside an AsyncLocalStorage context holding the task's queue and its
 *   owner; the ports read it there, also those without a task id (recordTurnSpend(money)). A write
 *   port called outside any context is dropped and logged; it never falls back to the current owner.
 * - Owner. The context owner is the owner database the input runtime was bound to when its turns
 *   started (input-queue.mjs assertCurrent), not the one current when an event arrives; late events
 *   without a turn record use the same runtime owner. A write port runs only while that owner is the
 *   current one (the Host writes by the account that started the turn; the desktop writes into
 *   whichever database is current: release table §二, desktop item 9).
 * - Owner teardown. A core may take getDbClient() again after an await inside one port call
 *   (recordModelTurnUsage: incrementDailyModelUsage, then incrementDailySessionUsage). So every write
 *   port call is tracked, and `drain()`, which the Host's owner teardown awaits before closing the
 *   owner database (main.ts disposeOwnerRuntime), first stops new recordings and port calls, then
 *   waits for the tracked ones and the Pi receipt writes. The Host installs the next owner database
 *   only after closing this one, so a tracked write cannot reach another account's database. A recording
 *   still waiting for prices or the turn's model when the teardown begins is refused its later write
 *   ports, so that turn may be recorded only in part (its tokens without its money; release table §二).
 * - A write inside a started port call (a message patch, a scheduled run's cost) checks the owner that
 *   call captured, not the store: a paused task write queue replays it later outside any context.
 * - Pi receipts. Their writes use the database captured when the session's first receipt was recorded
 *   (piUsageReceiptsCore.ts); pending ones live in that account's own database (pi_usage_receipts,
 *   priced = 0), so a retry only ever prices that account's rows. While a desktop uses the profile
 *   (coexistence plan A) the Host does not retry; it retries once the profile is released.
 * - Nothing is pushed to windows (the Host has none) and nothing on the recording path asks a server:
 *   the four quota refreshes and the scheduler change push are bound empty (phase 2 binds them;
 *   desktop-module-setters.ts). Per-party usage (provider-usage-by-party.json) is not written in phase 1
 *   (release table row 13): the desktop's `recordProviderPartyUsage` is optional and absent here.
 */

type HistoryQueue = { enqueueDurableWrite<T>(label: string, fn: () => Promise<T> | T): Promise<T> };
interface RecordingContext {
  sessionId: string;
  owner: CurrentDbClientSnapshot;
  history: HistoryQueue;
}

export interface HostUsageRecordingOptions {
  pricing: Pick<HostUsagePricing, 'getGatewayModelPricing' | 'getGatewayModelPricingForModel' | 'getGatewayAccountCurrency'>;
  isOpenAiSubscriptionProviderId(providerId?: string | null): boolean;
  /** The Cindy AI key held in memory (the desktop's readClaudeApiKey), or null. */
  readGatewayKey(): string | null;
  /** The local Codex proxy's credential mode, in memory (the desktop's getCodexProxyAuthInjection). */
  codexProxyAuthInjection(): CodexProxyAuthInjection;
  /** Coexistence plan A (input-queue.mjs isHeldForDesktop): a desktop uses this profile. */
  isProfileHeld(): boolean;
  /** The owner database now (main.ts: getCurrentDbClientSnapshot). */
  getOwner?: () => CurrentDbClientSnapshot | null;
}

export function createHostUsageRecording(options: HostUsageRecordingOptions) {
  const getOwner = options.getOwner ?? getCurrentDbClientSnapshot;
  const context = new AsyncLocalStorage<RecordingContext>();
  let accepting = true;
  const tracked = new Set<Promise<unknown>>();
  let retryDeferred = false;

  /** Whether a write port may run now: inside a task context, for the current owner, before drain. */
  function writeAllowed(port: string): RecordingContext | null {
    const current = context.getStore();
    if (!current) {
      log.warn('usage write outside a task context dropped', { port });
      return null;
    }
    if (!accepting) {
      log.info('usage write dropped: the owner teardown began', { port });
      return null;
    }
    return ownerHolds(current, port) ? current : null;
  }
  /**
   * A write inside a port call already started (a message patch, a scheduled run's cost), for the owner
   * that call captured. It may run later outside any context: a paused task write queue replays it
   * (retryFailedWrites), so it compares the captured owner, not the store; drain lets a started call finish.
   */
  function ownerHolds(current: RecordingContext, port: string): boolean {
    if (current.owner === getOwner()) return true;
    log.info('usage write dropped: the account changed', { port });
    return false;
  }
  function track<T>(promise: Promise<T>): Promise<T> {
    tracked.add(promise);
    void promise.then(() => tracked.delete(promise), () => tracked.delete(promise));
    return promise;
  }
  const guardedWrite = <A extends unknown[], R>(port: string, write: (...args: A) => Promise<R>, dropped: R) =>
    (...args: A): Promise<R> => (writeAllowed(port) ? track(write(...args)) : Promise.resolve(dropped));

  /** The desktop's turn cost deps (turnCostBroadcasterCore.ts defaultDeps) for the task in context. */
  const turnCostDeps = (current: RecordingContext): TurnCostDeps => ({
    patchAgentMeta: (sessionId, clientId, patch) => (ownerHolds(current, 'patchAgentMeta')
      ? patchMessageAgentMetaWithResultRow(current.owner.client, sessionId, clientId, patch) : Promise.resolve(null)),
    applyScheduleRunCostChange: (previous, next) => (ownerHolds(current, 'applyScheduleRunCostChange')
      ? applyScheduleRunCostMetaChange(previous, next) : Promise.resolve()),
    readPriorUserRoundCost: (sessionId, clientId) => readPriorUserRoundCost(sessionId, clientId, current.owner.client),
    enqueue: (label, fn) => current.history.enqueueDurableWrite(label, fn),
    // Phase 1 pushes no usage (release table row 13, 3f; §二).
    broadcast() {},
    broadcastWithOwnerScope() {},
  });
  /** A message write port: the task in context, its owner, its queue; dropped (resolving `dropped`) otherwise. */
  const messageWrite = <A, R>(port: string, write: (args: A, current: RecordingContext) => Promise<R>, dropped: R) =>
    (args: A): Promise<R> => {
      const current = writeAllowed(port);
      return current ? track(write(args, current)) : Promise.resolve(dropped);
    };

  bindUsageBroadcastPorts({
    getAllWindows: () => [],
    getGatewayModelPricing: () => options.pricing.getGatewayModelPricing(),
  });
  bindTurnUsagePorts({
    isOpenAiSubscriptionProviderId: providerId => options.isOpenAiSubscriptionProviderId(providerId),
    readClaudeApiKey: () => options.readGatewayKey(),
    getCodexProxyAuthInjection: () => options.codexProxyAuthInjection(),
    recordSessionTurnSpend: guardedWrite('recordSessionTurnSpend', recordSessionTurnSpend, undefined),
    recordSessionTurnTokens: guardedWrite('recordSessionTurnTokens', recordSessionTurnTokens, undefined),
    recordModelTurnUsage: guardedWrite('recordModelTurnUsage', recordModelTurnUsage, undefined),
    recordTurnSpend: guardedWrite('recordTurnSpend', recordTurnSpend, undefined),
    recordSchedulerTurnCost: messageWrite('recordSchedulerTurnCost', (args: Parameters<typeof recordSchedulerTurnCost>[0], current) =>
      recordSchedulerTurnCost(args, {
        recordOnMessage: messageArgs => recordTurnCostOnMessage(messageArgs, turnCostDeps(current)),
        recordDirect: direct => (ownerHolds(current, 'recordScheduleRunCostDirect') ? recordScheduleRunCostDirect(direct) : Promise.resolve(null)),
      }), null),
    recordTurnUsageOnMessage: messageWrite('recordTurnUsageOnMessage', (args: Parameters<typeof recordTurnUsageOnMessage>[0], current) =>
      recordTurnUsageOnMessage(args, turnCostDeps(current)), false),
    recordModelMismatchOnMessage: messageWrite('recordModelMismatchOnMessage',
      (args: Parameters<typeof recordModelMismatchOnMessage>[0], current) => recordModelMismatchOnMessage(args, {
        patchAgentMeta: async (sessionId, clientId, patch) => (await turnCostDeps(current).patchAgentMeta(sessionId, clientId, patch)) !== null,
        enqueue: (label, fn) => current.history.enqueueDurableWrite(label, fn),
        broadcast() {},
      }), undefined),
    // The day's Codex token snapshot is process memory the desktop pushes to its windows; no database write.
    recordCodexTurnUsage: usage => { if (writeAllowed('recordCodexTurnUsage')) recordCodexTurnUsage(usage); },
    // Reads.
    getGatewayAccountCurrency: (...args) => options.pricing.getGatewayAccountCurrency(...args),
    getGatewayModelPricing: () => options.pricing.getGatewayModelPricing(),
    getGatewayModelPricingForModel: () => options.pricing.getGatewayModelPricingForModel(),
    codexUsageToTokens,
    piUsageToTokens,
    getModelPriceQuote,
    // Pushes: none in phase 1 (release table row 13, 3f).
    broadcastSessionSpend: () => {},
    broadcastSessionTokens: () => {},
    rebroadcastTodaySpend: async () => {},
    rebroadcastCodexTodayUsage: () => {},
    broadcastSchedulerChanged: () => {},
    // No request on the recording path in phase 1 (desktop-module-setters.ts).
    triggerClaudeAccountUsageRefresh: async () => {},
    triggerClaudeSubscriptionUsageRefresh: () => {},
    triggerCodexAccountUsageRefresh: () => {},
    triggerXaiSubscriptionUsageRefresh: () => {},
  });

  // The desktop's per-task usage tables (register.ts :4229–4284, :4802–4804), cleared on close (:6064–6070).
  const lastReportedCostUsdBySession = new Map<string, number>();
  const lastReportedModelUsageBySession = new Map<string, Map<string, ModelUsageCumulative>>();
  const turnModelPromiseBySession = new Map<string, Promise<string>>();
  const turnUsageContextBySession = new Map<string, TurnUsageContext>();
  const productTurnWallClockTracker = new ProductTurnWallClockTracker();
  const productTurnUsageTargetTracker = new ProductTurnUsageTargetTracker();
  const claudeOutputLagTimingGuard = new ClaudeOutputLagTimingGuard();
  /** The desktop's sessionTurnActivityTracker.isSessionInTurn, for the turn-start steps (release table §七). */
  const inTurn = new Set<string>();
  const recorderDeps = {
    turnUsageContextBySession,
    turnModelPromiseBySession,
    readSessionModelForUsage,
    lastReportedModelUsageBySession,
    claudeOutputLagTimingGuard,
    lastReportedCostUsdBySession,
    log,
    unpricedSubscriptionValueMarker,
  };

  /** Pending Pi receipts are priced again, unless a desktop uses the profile (then after its release). */
  function retryPending(): Promise<void> {
    if (!accepting) return Promise.resolve();
    if (options.isProfileHeld()) {
      retryDeferred = true;
      return Promise.resolve();
    }
    retryDeferred = false;
    return retryPendingPiUsageReceipts();
  }
  const stopPricingRecovery = onUsagePricingChanged(() => { void retryPending(); });

  return {
    /** The trackers the silent-stop steps clear and preserve (silentStopSettle.ts, silentStopTurnEnd.ts). */
    productTurnWallClockTracker,
    productTurnUsageTargetTracker,

    /**
     * A foreground running status (sessionEventPreparation.ts :266–304): the product turn's wall clock
     * for Claude, then the turn's model and billing identity for the three engines.
     */
    noteRunningStatus(session: Session, event: AgentEvent): void {
      const wasInTurn = inTurn.has(session.id);
      if (!wasInTurn && event.source === 'claude-code') {
        const startedProductTurn = productTurnWallClockTracker.start(session.id);
        if (startedProductTurn) productTurnUsageTargetTracker.clear(session.id);
      }
      if ((event.data as { isRunning?: boolean } | undefined)?.isRunning) inTurn.add(session.id);
      else inTurn.delete(session.id);
      if ((event.source === 'claude-code' || event.source === 'codex' || event.source === 'pi')
        && !turnModelPromiseBySession.has(session.id)) {
        turnModelPromiseBySession.set(session.id, readSessionModelForUsage(session.id));
      }
      if ((event.source === 'pi' || event.source === 'codex' || event.source === 'claude-code')
        && (!wasInTurn || !turnUsageContextBySession.has(session.id))) {
        turnUsageContextBySession.set(
          session.id,
          captureTurnUsageContext(session.id, undefined, event.source, session.model),
        );
      }
    },

    /** The foreground turn ended (a final done, a terminal error, a not-running status). */
    noteTurnEnded(sessionId: string): void { inTurn.delete(sessionId); },

    /**
     * A terminal error (sessionEventPreparation.ts :391–395): the turn's model goes, its billing
     * identity stays for the paired done.
     */
    noteTerminalError(event: AgentEvent, sessionId: string): void {
      if (event.source === 'claude-code' || event.source === 'codex' || event.source === 'pi') {
        turnModelPromiseBySession.delete(sessionId);
      }
    },

    /**
     * The usage target of a done or terminal error (sessionEventTerminal.ts :186–221): the last assistant
     * message the event consumed; a failed turn hands it to its paired done; a Claude continuation
     * boundary keeps it for the final segment. `consumed` is undefined for a late event, which takes only
     * the handed-over id (release table row 13: a late event must not take the next turn's message).
     */
    usageTarget(sessionId: string, event: AgentEvent, consumed: string | undefined, pendingFailed: Map<string, string>,
      isTerminalError: boolean): string | undefined {
      let target = consumed;
      if (isTerminalError && event.type !== 'done') {
        if (target) pendingFailed.set(sessionId, target);
      } else {
        const handedOver = pendingFailed.get(sessionId);
        if (!target && handedOver) target = handedOver;
        pendingFailed.delete(sessionId);
      }
      if (event.type === 'done' && event.source === 'claude-code') {
        if (isTurnContinuationBoundaryEvent(event)) productTurnUsageTargetTracker.remember(sessionId, target);
        else target = productTurnUsageTargetTracker.finish(sessionId, target);
      }
      return target;
    },

    /**
     * The three recorders, in the desktop's order (sessionEventPipeline.ts :61–71), for the task's queue and
     * the runtime's owner. The Claude product turn's wall clock is read at its final done, as the desktop's
     * preparation reads it (sessionEventPreparation.ts :326–328). Nothing is recorded without an owner, for
     * an owner that is no longer current, or once the owner teardown began (drain).
     */
    record(session: Session, event: AgentEvent, persistId: string | undefined, history: HistoryQueue,
      owner: CurrentDbClientSnapshot | null | undefined): void {
      const isContinuationBoundary = isTurnContinuationBoundaryEvent(event);
      const silentStopDone = event.type === 'done' && (event.data as { silentStop?: boolean } | null | undefined)?.silentStop === true;
      const completedTurnWallClockMs = event.type === 'done' && event.source === 'claude-code' && !isContinuationBoundary && !silentStopDone
        ? productTurnWallClockTracker.finish(session.id) : undefined;
      if (!accepting || !owner || owner !== getOwner()) return;
      context.run({ sessionId: session.id, owner, history }, () => {
        recordSessionClaudeTurnUsage(recorderDeps, session, event, persistId, completedTurnWallClockMs, isContinuationBoundary);
        recordSessionCodexTurnUsage(recorderDeps, session, event, persistId);
        recordSessionPiTurnUsage(recorderDeps, session, event, persistId);
      });
    },

    /** The task's runtime closed (register.ts :6064–6070). */
    clear(sessionId: string): void {
      lastReportedCostUsdBySession.delete(sessionId);
      lastReportedModelUsageBySession.delete(sessionId);
      turnModelPromiseBySession.delete(sessionId);
      turnUsageContextBySession.delete(sessionId);
      productTurnWallClockTracker.clear(sessionId);
      productTurnUsageTargetTracker.clear(sessionId);
      claudeOutputLagTimingGuard.clear(sessionId);
      inTurn.delete(sessionId);
    },

    /** Pending Pi receipts once prices are ready (bootstrap-electron.ts :10384) or the profile is released. */
    retryPending,
    /** The desktop released the profile: a retry held meanwhile runs now. */
    onProfileReleased(): void { if (retryDeferred) void retryPending(); },

    /**
     * Before the owner database closes (bootstrap-electron.ts :2639, :2667, :11275 flush the Pi writes
     * there): no new recording or write port call starts; the started ones and the Pi writes finish.
     */
    async drain(): Promise<void> {
      accepting = false;
      while (tracked.size) await Promise.allSettled([...tracked]);
      await flushSessionPiTurnUsage();
    },
    /** A new owner database is installed: recording resumes. */
    open(): void { accepting = true; },
    close(): void { stopPricingRecovery(); },
  };
}

export type HostUsageRecording = ReturnType<typeof createHostUsageRecording>;
