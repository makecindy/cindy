import { declaredPluginConsent, pluginConsentAllowance, type PluginConsentAllowance, type PluginConsentExpectation } from './pluginConsentAllowance';
import { randomUUID } from 'expo-crypto';
import type { PluginPromptDisplay } from './pluginPromptReads';
import { subscribeMobileAuthOwner } from '@/auth/authOwnerGeneration';
import type { PluginOperationHold, PluginSlotEntry, PluginSlotHolder } from './pluginManagementSlot';
import { PluginManagementRequestError, pluginManagementErrorCode,
  type PluginManagementBegin, type PluginManagementClient } from './pluginManagementClient';
import { marketItemMatchesPlugin, pluginApprovalToken, samePluginMarketSourceIdentity, type ManagedMarketDetail, type ManagedPlugin,
  type PluginManagementReceipt, type PluginManagementSnapshot, type PluginMarketSourceIdentity, type PluginUiConsentItem, type PluginUiConsentSnapshot } from './pluginManagementTypes';

export interface PluginManagementState {
  capability: 'unknown' | 'supported' | 'unsupported';
  snapshot: PluginManagementSnapshot | null;
  uiConsent?: PluginUiConsentSnapshot | null;
  receipt: PluginManagementReceipt | null;
  operationId: string | null;
  busy: boolean;
  online: boolean;
  outcome: 'idle' | 'running' | 'confirmation' | 'succeeded' | 'cancelled' | 'failed' | 'unknown';
  errorCode: string | null;
  /**
   * The installed snapshot read right after the Host reported the original operation gone (NOT_FOUND).
   * Callers that settle a lost receipt use only these facts, never a snapshot read earlier. Cleared on a
   * new operation or outcome; absent when that read failed.
   */
  missingReceiptFacts?: PluginManagementSnapshot | null;
  /**
   * After a final receipt, whether `snapshot` is from after the result (the facts "Open" is decided from; maintainer
   * review 03:52 of c6efda5691). Settled only where a snapshot is published: `read` is set in the same publish as the
   * first snapshot whose read was issued after the result arrived (by issue order, not by reply order: the controller's
   * own read, a reconnect refresh, a plugin-change refresh or a manual one); a read issued before the result never
   * counts, and nothing that is not published counts. `pending` while such a read is still out; `failed` once none is
   * (every one failed, was superseded or dropped) or the computer went offline: recoverable, the next such snapshot
   * published makes it `read`. Views decide on `read` and wait only while `pending`.
   */
  finalReadback?: 'pending' | 'read' | 'failed';
  /**
   * The request id of the consent on screen when an answer to it is in flight or was written: Allow and Reject stay
   * unavailable, so one consent request never gets two answers (maintainer review 11:45).
   */
  answerHeld?: string | null;
  /**
   * Custom-market installs and updates started here: the full source identity the person chose. The consent's
   * `originSource` must equal it exactly before Allow is offered (the Host may pack another source under the same
   * name after the last detail read). Absent for server items and consents not started here.
   */
  expectedSource?: PluginMarketSourceIdentity | null;
  /** What the person chose when this operation started (dispatcher O-4); a consent may be allowed only if it matches. */
  expectedConsent?: PluginConsentExpectation | null;
}
export interface PluginManagementControllerOptions {
  /** Optional shared chat hint. Never used by readSnapshot or mutation validation. */
  readDisplay?: () => Promise<PluginPromptDisplay>;
  online?: boolean;
  onChange?: (state: PluginManagementState) => void;
  /** Testable identity source; production uses the existing Expo UUID implementation. */
  createOperationId?: () => string;
  pollIntervalMs?: number;
  /** Timer for the next automatic lookup (tests observe it); defaults to setTimeout / clearTimeout. */
  scheduler?: { set(run: () => void, delayMs: number): unknown; clear(handle: unknown): void };
  /** Only for callers that already confirmed paged-catalog support; default stays the v1 full snapshot. */
  snapshotRead?: 'installed';
}
type BeginIntent = PluginManagementBegin extends infer T ? T extends PluginManagementBegin ? Omit<T, 'operationId'> : never : never;
type ConsentIntent = { kind: 'approve-ui' | 'defer-ui'; installed: PluginUiConsentItem };
const terminal = (receipt: PluginManagementReceipt) => ['succeeded', 'cancelled', 'failed'].includes(receipt.phase);
/** What the person chose, as a consent must declare it (dispatcher O-4); null for operations that never ask. */
function expectationOf(intent: BeginIntent | ConsentIntent, deviceId: string): PluginConsentExpectation | null {
  if (intent.kind === 'install') {
    const { detail } = intent;
    return { kind: intent.installed ? 'update' : 'install', deviceId, pluginId: detail.pluginId, ghostId: detail.ghostId,
      version: detail.version, releaseId: detail.releaseId, sourceType: detail.sourceType, source: detail.sourceIdentity ?? null };
  }
  // A page approval started from the installed detail names the instance's plugin and version; one started from a chat
  // prompt knows only the instance (nothing chosen to compare: the declaration rules apply).
  if (intent.kind === 'approve-ui' && 'manifest' in intent.installed)
    return { kind: 'ui-capability', deviceId, ghostId: intent.installed.manifest.id, version: intent.installed.manifest.version };
  return null;
}
const AUTO_LOOKUP_FAILURES = 4;
/** Cap of the automatic lookup delay: the Host reports the operation running (work under way, a result soon). */
const AUTO_LOOKUP_RUNNING_MAX_DELAY_MS = 5_000;
/** Cap otherwise: failed lookups, an answered consent the Host still shows, any other result still unknown. */
const AUTO_LOOKUP_MAX_DELAY_MS = 30_000;
/** Lookup failures a later automatic lookup can get past (the link or the computer was slow or briefly away). */
const TRANSIENT_LOOKUP_ERRORS = new Set(['INVOKE_TIMEOUT', 'TIMEOUT', 'DEVICE_OFFLINE', 'NOT_CONNECTED', 'LINK_NOT_OPEN',
  'BACKPRESSURE', 'PEER_RESET', 'REMOTE_DISABLED', 'PLUGIN_MANAGEMENT_STALE']);

/** One controller per selected Host/owner. Dispose when changing targets. No persisted writes or replay queue. */
export function createPluginManagementController(client: PluginManagementClient, options: PluginManagementControllerOptions = {}) {
  let state: PluginManagementState = { capability: 'unknown', snapshot: null, uiConsent: null, receipt: null,
    operationId: null, busy: false, online: options.online ?? true, outcome: 'idle', errorCode: null };
  let disposed = false, epoch = 0, refreshSequence = 0, snapshotSequence = 0;
  // Display reads cannot erase the full Host facts used for queued write guards.
  let facts: PluginManagementSnapshot | null = null, factsSequence = 0;
  /**
   * `finalReadback`: the snapshot sequence when the final receipt arrived (a read counts when issued after it), and the
   * sequences of the reads still out (installed snapshots and display reads alike), to know whether one can still land.
   */
  let resultReadAfter: number | null = null;
  const readsOut = new Set<number>();
  let pendingDisplay: { token: number; sequence: number; promise: Promise<PluginPromptDisplay> } | undefined;
  let timer: unknown;
  const scheduler = options.scheduler ?? { set: (run: () => void, delayMs: number) => setTimeout(run, delayMs),
    clear: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>) };
  /**
   * Automatic lookups, one rule (maintainer reviews 14:18 and 15:37): only progress the phone observes resets the
   * pace, meaning a receipt ranked above what is shown (see `rankOf`: a new phase, a new consent, the answer's
   * outcome, a final result). Every lookup that brings nothing new counts as one without progress: a failed lookup,
   * the same answered consent again, the same running state again, an older receipt. Each doubles the delay from the
   * poll interval, up to AUTO_LOOKUP_RUNNING_MAX_DELAY_MS while the Host reports the operation running and
   * AUTO_LOOKUP_MAX_DELAY_MS otherwise; within one run of lookups without progress the delay never shrinks (the cap
   * reached stays). Lookups without progress that succeed never stop (the operation may really be slow, or wait for
   * someone at the computer): their rate is bounded by the cap. Failed lookups stop after AUTO_LOOKUP_FAILURES in a
   * row, or at once for an error retrying cannot fix (a protocol error such as INVALID_RESPONSE): the result waits for
   * "Check result". Progress, coming back online or to the foreground, and a new operation start over.
   */
  let lookupFailures = 0, autoLookupStopped = false;
  let quietLookups = 0, quietDelay = 0, quietCap = 0;
  const resetPace = () => { quietLookups = 0; quietDelay = 0; quietCap = 0; };
  let receiver: ManagedPlugin | undefined;
  let uiConsentOperation = false;
  /**
   * The page slot held for this operation (maintainer review 15:37), if its entry gave one: every write of the
   * operation (begin, Allow / Reject, cancel) first checks the slot is still held, and the slot is released once, when
   * the operation is over (a final result, or stopped before begin), or when the controller goes.
   */
  let opHold: PluginOperationHold | null = null;
  /**
   * The entry and plugin the operation was started for (from its hold), kept for the whole operation: a pending check
   * (see `pendingCheck`) is listed by them after the slot went.
   */
  let opEntry: PluginSlotEntry | undefined, opWho: PluginSlotHolder | undefined;
  /**
   * The hold released while the operation waits for the person to check it (maintainer review 18:45; see `waitsForCheck`):
   * other plugins on the computer may start meanwhile. Before this operation writes again, or once it moves on by
   * itself again, it takes the computer's slot back through it; while someone else holds the slot it writes nothing.
   */
  let releasedHold: PluginOperationHold | null = null;
  /**
   * One operation's life on this phone (maintainer review 17:43): a cancel is one of its states, never a side effect of
   * going away. At most one management:cancel per operation, and only while its consent is shown and this phone has
   * never written an answer to it (Allow or Reject, reply received or not). Disposing never writes anything.
   */
  let answerWrittenEver = false, cancelAttempted = false;
  /**
   * The consent request this phone actually put on screen (the confirmation sheet marks it when it shows it; dispatcher
   * L-2). Leaving an unanswered consent cancels it only if it is this one: a consent found by a lookup the person never
   * saw (a begin whose reply was lost, a check from the list of pending checks, a reattached view) is never cancelled
   * by anything but the person; it stays read-only until they open it and answer.
   */
  let shownConsent: string | null = null;
  const opGuard = () => {
    if (!opHold && releasedHold && state.operationId) takeSlotBack();
    return opHold ? opHold.guard() : !releasedHold;
  };
  const final = (outcome: PluginManagementState['outcome']) => ['succeeded', 'cancelled', 'failed'].includes(outcome);
  /**
   * The operation's result waits for the person to check it: nothing moves it on by itself anymore (automatic lookups
   * stopped, the receipt is gone, or the one cancel of a shown consent could not be sent). Going offline is not such
   * a state: the computer's slot stays held, and the result is looked up when it is back.
   */
  function waitsForCheck() {
    if (!state.operationId || final(state.outcome)) return false;
    if (state.outcome === 'unknown') return autoLookupStopped || !!missingReceipt || !!state.missingReceiptFacts;
    return state.outcome === 'confirmation' && cancelAttempted && cancelling === null;
  }
  /**
   * The held slot goes once the operation is over (no write on its way, and a final result or no operation at all),
   * or, with no write on its way, while its result waits for the person to check it.
   */
  function settleHoldIfOver() {
    if (!opHold || state.busy || writesInFlight !== 0) return;
    if (state.operationId ? final(state.outcome) : state.outcome !== 'running') settleHold();
    else if (waitsForCheck()) { const hold = opHold; settleHold(); releasedHold = hold; }
  }
  /** Moving on by itself again (or about to write): take the computer's slot back, if nobody else holds it. */
  function takeSlotBack() {
    const again = releasedHold && state.operationId ? releasedHold.reacquire(state.operationId) : null;
    if (again) { opHold = again; releasedHold = null; }
  }
  const settleHold = () => { const hold = opHold; opHold = null; releasedHold = null; hold?.onSettled(); };
  let installDetail: ManagedMarketDetail | undefined;
  const listeners = new Set<() => void>();
  const current = (token: number) => !disposed && epoch === token && client.isCurrent();
  /**
   * A result about operation `id` belongs to this account, computer and operation, not to a connection epoch: going
   * offline (or coming back) between a request and its result must not discard it. Only a changed account or target
   * (client.isCurrent), disposal, or another operation drops it. Once the operation has a final outcome, nothing later
   * (a late query, receipt or failure) changes it again.
   */
  const undecided = (id: string | null) => !disposed && client.isCurrent() && !!id && state.operationId === id
    && !['succeeded', 'cancelled', 'failed'].includes(state.outcome);
  /** The request was definitely never written (the transport reported no write): its operation did not change. */
  const notWritten = (error: unknown) => error instanceof PluginManagementRequestError && !error.outcomeUnknown;
  /**
   * Two layers (maintainer review 11:45). Request layer: `busy`, the request's own error and resumed polling belong to
   * the one request that holds busy (a begin, answer, cancel or lookup); only that holder releases it, and going
   * offline or changing account releases it for everyone. Operation layer: results about an operation (a begin never
   * written, a final outcome, the Host's receipt) land by operation id (`undecided`), whoever holds busy.
   */
  let busyHolder = 0, holderSequence = 0;
  const hold = () => (busyHolder = ++holderSequence);
  const holds = (holder: number) => holder !== 0 && busyHolder === holder;
  /** Release busy with the request's own `patch` if `holder` still holds it. */
  const release = (holder: number, patch: Partial<PluginManagementState> = {}) => {
    if (!holds(holder)) return false;
    busyHolder = 0;
    publish({ ...patch, busy: false });
    return true;
  };
  /** A request ended without a state change of its own: release its hold if it still has one, and check progress. */
  const drop = (holder: number) => { if (!release(holder)) ensureProgress(); };
  /** Apply an operation result: with the release when `holder` holds busy, otherwise without touching busy. */
  const conclude = (holder: number, patch: Partial<PluginManagementState>) => { if (!release(holder, patch)) publish(patch); };
  /** Answers by consent request id: in flight, or written (the Host may have it). At most one per request id. */
  const answers = new Map<string, 'pending' | 'written'>();
  /** A cancel of this operation in flight or written: the consent may be gone on the Host, so it is not offered. */
  let cancelling: 'pending' | 'written' | null = null;
  /**
   * The operation's progress on the Host only moves forward (maintainer review 13:02). Its receipt carries no sequence,
   * so the phone ranks receipts by the operation's stages: running before the first consent < consent 1 < running after
   * consent 1 was answered < consent 2 < … < a final outcome. A consent ranks by its order of first appearance. A
   * `running` receipt ranks right after the newest consent this phone had already answered when the request was sent
   * (the Host leaves a consent only through this phone's answer), otherwise below every consent. A receipt ranked below
   * the progress already shown is older than it and never lands; a final outcome always does.
   */
  let receiptClock = 0, shownRank = -1, appliedReceiptAt = 0;
  const consentOrder: string[] = [];
  const answerSentAt = new Map<string, number>();
  const consentIndex = (requestId: string) => {
    if (!consentOrder.includes(requestId)) consentOrder.push(requestId);
    return consentOrder.indexOf(requestId);
  };
  function rankOf(receipt: PluginManagementReceipt, issuedAt: number): number {
    if (terminal(receipt)) return Number.MAX_SAFE_INTEGER;
    if (receipt.phase === 'confirmation' && receipt.consent) return 2 * consentIndex(receipt.consent.requestId) + 1;
    let rank = 0;
    for (const [requestId, sentAt] of answerSentAt) if (sentAt < issuedAt) rank = Math.max(rank, 2 * consentIndex(requestId) + 2);
    return rank;
  }
  /** Requests to the Host for this operation still waiting for their result (see `ensureProgress`). */
  let requestsInFlight = 0;
  /**
   * Writes of this operation (begin, Allow / Reject, cancel) not settled yet, whatever `busy` says (going offline clears
   * `busy`, but a write already on the link may still reach the computer). The page slot never goes while one is out.
   */
  let writesInFlight = 0;
  async function tracked<T>(request: () => Promise<T>, write = false): Promise<T> {
    requestsInFlight += 1;
    if (write) writesInFlight += 1;
    // Settled before the caller handles the result; the caller's next state change (or release) checks progress.
    try { return await request(); } finally {
      requestsInFlight -= 1;
      if (write) {
        writesInFlight -= 1;
        // The last write settled: the slot may go now, and whoever waits for it (a view that went away) looks again.
        if (writesInFlight === 0) { settleHoldIfOver(); listeners.forEach((listener) => listener()); }
      }
    }
  }
  /** One lookup in flight at a time; a lookup asked for meanwhile runs once it settles. */
  let lookupInFlight = false, lookupWanted = false;
  /**
   * Set while an unknown result's receipt is gone (NOT_FOUND): every installed snapshot that lands afterwards and is
   * the newest read issued becomes the facts for that result. A newer read replaces older facts (so a market check
   * still reading on them stops), and while the newest read is in flight no facts are published.
   */
  let missingReceipt: { token: number; after: number } | null = null;
  /** Sequence of the installed read the published missing-receipt facts came from. */
  let missingFactsSequence = 0;
  const publish = (patch: Partial<PluginManagementState>) => {
    if (disposed) return;
    state = { ...state, ...patch };
    const requestId = state.receipt?.consent?.requestId;
    state.answerHeld = requestId && (answers.has(requestId) || cancelling) ? requestId : null;
    // A consent counts as shown only while it stays on screen. Once the result is something else (also only unknown
    // for now: the computer dropped, the app was in the background, lookups stopped), no sheet shows it any more; a
    // view that goes away after that did not leave a consent, so the same consent found again later is not cancelled
    // for it. The sheet that puts it on screen again marks it again (`markConsentShown`). Only for operations the
    // plugins page keeps as a pending check (found again, they wait in its list for "View and decide"). One started
    // elsewhere (the chat's page prompt) is kept by nobody once its view goes: it keeps the earlier rule, so leaving
    // it still cancels the consent it showed instead of leaving it on the computer with nothing here to answer it.
    if (state.outcome !== 'confirmation' && opEntry) shownConsent = null;
    // Facts about a missing receipt belong to that unknown result only.
    if ((patch.outcome !== undefined && patch.outcome !== 'unknown') || patch.operationId !== undefined) {
      state.missingReceiptFacts = null;
      missingReceipt = null;
    }
    settleHoldIfOver();
    if (!opHold && releasedHold && state.operationId && !final(state.outcome) && !waitsForCheck()) takeSlotBack();
    options.onChange?.(state);
    listeners.forEach((listener) => listener());
    ensureProgress();
  };
  const stopPolling = () => { if (timer !== undefined) scheduler.clear(timer); timer = undefined; };
  /**
   * Liveness, in one place (maintainer review 13:02), checked after every state change and when a request settles: an
   * operation that is not final, with nothing in flight on an online computer, always has a way forward. Running, or an
   * unknown result a lookup can settle: the next lookup is scheduled. A consent: Allow or Reject can be tapped, except
   * when this phone already wrote its answer and lost the reply, which makes it an unknown result (the answer stays
   * locked) that the next lookup settles. A result whose receipt the Host no longer has is settled from the computer's
   * facts instead (missing receipt), and an offline computer is looked up on reconnect.
   */
  function ensureProgress() {
    if (disposed || !client.isCurrent()) return;
    const open = !!state.operationId && ['running', 'confirmation', 'unknown'].includes(state.outcome);
    if (!open || !state.online) { stopPolling(); return; }
    if (requestsInFlight > 0 || state.busy || lookupInFlight) return;
    if (state.outcome === 'confirmation') {
      // Held right now (the published `answerHeld` may predate a release still being handled).
      const requestId = state.receipt?.consent?.requestId;
      if (requestId && (answers.get(requestId) === 'written' || cancelling === 'written')) publish({ outcome: 'unknown' });
      return;
    }
    if (state.outcome === 'unknown' && (missingReceipt || autoLookupStopped)) return;
    if (timer !== undefined) return;
    const interval = Math.max(250, options.pollIntervalMs ?? 1000);
    quietCap = Math.max(quietCap, state.outcome === 'running' ? AUTO_LOOKUP_RUNNING_MAX_DELAY_MS : AUTO_LOOKUP_MAX_DELAY_MS);
    quietDelay = Math.max(quietDelay, Math.min(interval * 2 ** quietLookups, quietCap));
    timer = scheduler.set(() => { timer = undefined; void reconcile(); }, quietDelay);
  }
  function matchesReceiver(live: ManagedPlugin): boolean {
    return !!receiver && live.instanceKey === receiver.instanceKey
      && live.manifest.id === receiver.manifest.id && live.namespace === receiver.namespace
      && pluginApprovalToken(live) === pluginApprovalToken(receiver);
  }
  function receiverCurrent(snapshot: PluginManagementSnapshot): boolean {
    if (receiver) return snapshot.ghosts.some(matchesReceiver);
    return !installDetail || !snapshot.ghosts.some((g) => marketItemMatchesPlugin(installDetail!, g));
  }
  /** Sequence of the snapshot currently in state (readSnapshot, refresh or display read). */
  let publishedSnapshotSequence = 0;
  /**
   * Issue the sequence of a new installed (or display) read. After a missing receipt, the facts published so far are
   * withdrawn right away: the newer read replaces them, so nothing may settle on them while it is in flight.
   */
  function issueSnapshotRead(): number {
    const sequence = ++snapshotSequence;
    if (missingReceipt && state.missingReceiptFacts) publish({ missingReceiptFacts: null });
    return sequence;
  }
  /**
   * The missing-receipt facts that may settle a result right now: only facts read by the newest installed read issued.
   * Derived when asked (not stored), so a read issued in the meantime invalidates them even before anything publishes.
   */
  function currentMissingReceiptFacts(): PluginManagementSnapshot | null {
    if (!missingReceipt || missingReceipt.token !== epoch || state.outcome !== 'unknown') return null;
    return missingFactsSequence === snapshotSequence ? state.missingReceiptFacts ?? null : null;
  }
  /** Publish the newest installed snapshot; after a missing receipt it is also that result's facts. */
  function publishSnapshot(sequence: number, token: number, snapshot: PluginManagementSnapshot, patch: Partial<PluginManagementState>) {
    publishedSnapshotSequence = sequence;
    const asFacts = !!missingReceipt && missingReceipt.token === token && sequence > missingReceipt.after && state.outcome === 'unknown';
    if (asFacts) missingFactsSequence = sequence;
    // The one place a final result's read is settled: this snapshot was read after the result arrived.
    const settles = resultReadAfter !== null && sequence > resultReadAfter
      && (state.finalReadback === 'pending' || state.finalReadback === 'failed');
    publish({ ...patch, snapshot, ...(asFacts ? { missingReceiptFacts: snapshot } : {}),
      // A read error from before no longer stands; the operation's own error (a failed receipt's) does.
      ...(settles ? { finalReadback: 'read' as const, errorCode: state.receipt?.errorCode ?? null } : {}) });
  }
  /** A read went out (`sequence`); `readDone` when it is over, however it ended. */
  function readOut(sequence: number) { readsOut.add(sequence); }
  /**
   * A read is over (landed, failed, superseded or dropped): if the result still waits for a read issued after it and
   * none is out anymore, nothing can settle it by itself: `failed` (recoverable).
   */
  function readDone(sequence: number) {
    readsOut.delete(sequence);
    if (state.finalReadback !== 'pending' || resultReadAfter === null) return;
    for (const out of readsOut) if (out > resultReadAfter) return;
    publish({ finalReadback: 'failed' });
  }
  async function readSnapshot(token: number) {
    const sequence = issueSnapshotRead();
    const factsToken = ++factsSequence;
    readOut(sequence);
    try {
      const snapshot = await client.snapshot(options.snapshotRead);
      if (current(token) && factsToken === factsSequence) facts = snapshot;
      // Both display reads and full snapshots share this sequence. A current full
      // read replaces the older hint; a later lightweight read can replace it again.
      if (current(token) && sequence === snapshotSequence) publishSnapshot(sequence, token, snapshot, { uiConsent: null });
      return snapshot;
    } finally { readDone(sequence); }
  }
  /**
   * `holder`: the request that got this receipt; `issuedAt`: when it was sent (see `rankOf`). A receipt is the Host's
   * state of the operation: it lands by operation id even after the connection epoch moved, unless it is older than
   * the progress already shown.
   */
  async function acceptReceipt(receipt: PluginManagementReceipt, token: number, holder: number, issuedAt: number) {
    if (!undecided(receipt.operationId)) { drop(holder); return; }
    const rank = rankOf(receipt, issuedAt);
    // Older than what is shown: not applied. The write it answers is over all the same, so this is said (as when a
    // reply is lost): whoever waited for that write to end looks now.
    if (rank < shownRank) { drop(holder); if (!disposed) publish({}); return; }
    if (rank > shownRank) resetPace();
    shownRank = rank;
    appliedReceiptAt = ++receiptClock;
    // The Host still shows a consent this phone already answered (written, reply lost): never offer it again; the
    // result stays unknown until the Host reports the answer's outcome.
    const answered = receipt.phase === 'confirmation' && !!receipt.consent
      && (answers.get(receipt.consent.requestId) === 'written' || cancelling === 'written');
    const consumed = receipt.phase === 'succeeded' && uiConsentOperation ? receiver : undefined;
    // Keep only the latest in-flight display read displaced by this successful
    // receipt. It is a fallback for failed readback, never a new remote request.
    // (As of now, not as of the request that brought the receipt: a receipt lands by its operation id whatever the
    // connection did since, and what follows it is judged by the connection as it is.)
    const landed = epoch;
    const displacedDisplay = consumed && pendingDisplay?.token === landed
      && pendingDisplay.sequence === snapshotSequence ? pendingDisplay.promise : undefined;
    const prompt: Partial<PluginManagementState> = {};
    if (receipt.phase === 'succeeded' && uiConsentOperation && receiver) {
      // The committed decision consumes this revision, even if readback fails.
      // Fence older display reads before publishing; later reads remain authoritative.
      ++snapshotSequence;
      const item = state.uiConsent?.item;
      // The compact contract carries the physical instance key (including namespace).
      if (item?.instanceKey === receiver.instanceKey && item.approvalToken === pluginApprovalToken(receiver)) prompt.uiConsent = null;
      // The pre-operation snapshot may now supply the chat hint instead of uiConsent.
      // This display-only suppression follows the receipt, never grants a capability.
      if (options.readDisplay && state.snapshot) prompt.snapshot = { ...state.snapshot,
        ghosts: state.snapshot.ghosts.map(ghost => matchesReceiver(ghost) ? { ...ghost, uiPromptSuppressed: true } : ghost) };
    }
    // The result is known from here on: only reads issued after this sequence can settle its read.
    if (terminal(receipt) && !answered) resultReadAfter = snapshotSequence;
    conclude(holder, { ...prompt, receipt, outcome: answered ? 'unknown' : receipt.phase, errorCode: receipt.errorCode ?? null,
      ...(terminal(receipt) && !answered ? { finalReadback: 'pending' as const } : {}) });
    if (terminal(receipt)) {
      // A cancel racing commit must still show succeeded. Refresh facts, without changing the receipt on read failure.
      // The read settles `finalReadback` only where its snapshot is published (publishSnapshot / readDone).
      stopPolling();
      // Read as of now, not as of the request that brought the result: a receipt lands by its operation id whatever the
      // connection did since (the app was in the background for a moment, the computer dropped and came back), and so
      // must the read that follows it. With the request's own token that read was thrown away and the result's read
      // counted as failed, though every read had answered.
      const readback = readSnapshot(landed), readbackSequence = snapshotSequence;
      try {
        await readback;
      } catch (error) {
        if (current(landed) && state.finalReadback !== 'read') publish({ errorCode: pluginManagementErrorCode(error) });
        if (displacedDisplay && consumed) {
          try {
            const display = await displacedDisplay;
            const item = display.uiConsent?.item;
            // A later read/operation still wins. Only an unrelated pending item
            // can be recovered; the committed instance revision cannot revive.
            if (current(landed) && snapshotSequence === readbackSequence && item
              && (item.instanceKey !== consumed.instanceKey || item.approvalToken !== pluginApprovalToken(consumed))) {
              publish({ ...display });
            }
          } catch { /* Preserve the readback error; neither failed read retries itself. */ }
        }
      }
    }
  }
  async function refresh() {
    if (disposed || !state.online || !client.isCurrent()) return;
    const token = epoch, sequence = ++refreshSequence;
    try {
      if (options.readDisplay) {
        const snapshotToken = issueSnapshotRead();
        readOut(snapshotToken);
        const reading = { token, sequence: snapshotToken, promise: options.readDisplay() };
        pendingDisplay = reading;
        try {
          const display = await reading.promise;
          if (current(token) && sequence === refreshSequence && snapshotToken === snapshotSequence) {
            publishedSnapshotSequence = snapshotToken;
            publish({ ...display, uiConsent: display.uiConsent ?? null, errorCode: null });
          }
        } finally { if (pendingDisplay === reading) pendingDisplay = undefined; readDone(snapshotToken); }
        return;
      }
      const capability = await client.capability();
      if (!current(token) || sequence !== refreshSequence) return;
      publish({ capability, uiConsent: null, errorCode: null, ...(capability === 'unsupported' ? { snapshot: null } : {}) });
      if (capability === 'supported') {
        const snapshotToken = issueSnapshotRead();
        const factsToken = ++factsSequence;
        readOut(snapshotToken);
        try {
          const snapshot = await client.snapshot(options.snapshotRead);
          if (current(token) && factsToken === factsSequence) facts = snapshot;
          if (current(token) && sequence === refreshSequence && snapshotToken === snapshotSequence)
            publishSnapshot(snapshotToken, token, snapshot, {});
        } finally { readDone(snapshotToken); }
      }
    } catch (error) {
      if (current(token) && sequence === refreshSequence) publish({ errorCode: pluginManagementErrorCode(error) });
    }
  }
  async function start(intent: BeginIntent | ConsentIntent, slotHold?: PluginOperationHold) {
    // Not started (nothing sent): the entry's slot goes at once.
    const refuse = (patch?: Partial<PluginManagementState>) => { if (patch) publish(patch); slotHold?.onSettled(); };
    if (disposed || !client.isCurrent() || (slotHold && !slotHold.guard())) { refuse(); return; }
    if (!state.online) { refuse({ errorCode: 'DEVICE_OFFLINE' }); return; }
    if (state.busy || (state.operationId && !['succeeded', 'cancelled', 'failed'].includes(state.outcome))) { refuse(); return; }
    if (state.capability !== 'supported') { refuse({ errorCode: state.capability === 'unsupported' ? 'PLUGIN_MANAGEMENT_UNSUPPORTED' : 'PLUGIN_MANAGEMENT_NOT_READY' }); return; }
    settleHold();
    opHold = slotHold ?? null;
    opEntry = slotHold?.entry; opWho = slotHold?.who;
    const token = ++epoch;
    let began = false, operationId: string | null = null;
    const holder = hold();
    answers.clear(); cancelling = null; consentOrder.length = 0; answerSentAt.clear(); shownRank = -1;
    lookupFailures = 0; autoLookupStopped = false; resetPace(); answerWrittenEver = false; cancelAttempted = false; shownConsent = null;
    resultReadAfter = null;
    publish({ busy: true, errorCode: null, operationId: null, receipt: null, outcome: 'idle', finalReadback: undefined,
      expectedSource: intent.kind === 'install' && intent.detail.sourceType !== 'server' ? intent.detail.sourceIdentity ?? null : null,
      expectedConsent: expectationOf(intent, slotHold?.who.deviceId ?? client.deviceId) });
    const installed = intent.installed;
    if (!installed && intent.kind !== 'install') { release(holder, { outcome: 'failed', errorCode: 'PLUGIN_INSTALL_CHANGED' }); return; }
    receiver = installed && 'manifest' in installed ? installed : undefined;
    uiConsentOperation = intent.kind === 'approve-ui' || intent.kind === 'defer-ui';
    installDetail = intent.kind === 'install' ? intent.detail : undefined;
    try {
      let request: BeginIntent = intent as BeginIntent;
      if (intent.kind === 'install') {
        const detail = await client.detail(intent.detail.pluginId);
        if (!current(token)) { drop(holder); return; }
        if (detail.releaseId !== intent.detail.releaseId || detail.namespace !== intent.detail.namespace
          || detail.sourceType !== intent.detail.sourceType || (detail.sourceType !== 'server'
            && JSON.stringify(detail.manifest) !== JSON.stringify(intent.detail.manifest))) throw new Error('PLUGIN_RELEASE_CHANGED');
        // Custom markets: this is the last detail read before begin. A Host that does not name the source (older Host,
        // or a Git market not refreshed since the Host was updated) cannot be checked: stop and send the person to the
        // computer. A source that differs from the one chosen (a same-name market now pointing to another repository or
        // folder with the same id, release and manifest) has really changed: stop and let them choose again.
        if (detail.sourceType !== 'server') {
          if (!detail.sourceIdentity || !intent.detail.sourceIdentity) throw new Error('PLUGIN_SOURCE_UNVERIFIED');
          if (!samePluginMarketSourceIdentity(detail.sourceIdentity, intent.detail.sourceIdentity)) throw new Error('PLUGIN_SOURCE_CHANGED');
        }
        request = { ...intent, detail };
      }
      const snapshot = await readSnapshot(token);
      if (!current(token)) { drop(holder); return; }
      if (!receiver && installed && !('manifest' in installed)) {
        receiver = snapshot.ghosts.find(g => g.instanceKey === installed.instanceKey);
        if (!receiver || pluginApprovalToken(receiver) !== installed.approvalToken) throw new Error('PLUGIN_INSTALL_CHANGED');
        request = { ...intent, installed: receiver } as BeginIntent;
      }
      if (!receiverCurrent(snapshot)) throw new Error('PLUGIN_INSTALL_CHANGED');
      if ((intent.kind === 'approve-ui' || intent.kind === 'defer-ui') && !snapshot.uiCapabilityApproval)
        throw new PluginManagementRequestError('PLUGIN_UI_APPROVAL_UNSUPPORTED');
      operationId = (options.createOperationId ?? randomUUID)();
      publish({ operationId, outcome: 'running' });
      began = true;
      const issuedAt = ++receiptClock;
      const reply = await tracked(() => client.begin({ ...request, operationId: operationId!,
        ...(snapshot.uiCapabilityApproval ? { uiConsentVersion: 1 } : {}) }, () => current(token)
        && state.online && opGuard() && !!facts && receiverCurrent(facts)), true);
      await acceptReceipt(reply, token, holder, issuedAt);
    } catch (error) {
      // Maintainer review 10:36 #1: a begin stopped before it was written (for example by the last check after the
      // computer went offline while it was queued) is a plain failure of this operation, even though going offline
      // moved the epoch and marked it unknown meanwhile; it frees the management slot, and a later query cannot
      // turn it back into an unknown result.
      if (began && notWritten(error) && undecided(operationId)) {
        conclude(holder, { outcome: 'failed', errorCode: pluginManagementErrorCode(error) });
        return;
      }
      if (!current(token) || (began && !undecided(operationId))) {
        drop(holder);
        // The write is over and changed nothing here (its reply was lost after the connection moved on): said again, so
        // whoever waited for the write to end looks now (a result to settle from the computer's facts, "Stop tracking").
        if (began && !disposed) publish({});
        return;
      }
      const unknown = began && !notWritten(error);
      release(holder, { outcome: unknown ? 'unknown' : 'failed', errorCode: pluginManagementErrorCode(error) });
    }
  }
  async function reconcile() {
    if (disposed || !state.online || !client.isCurrent()) return;
    if (lookupInFlight) { lookupWanted = true; return; }
    if (state.busy) return;
    const id = state.operationId;
    if (!id || ['succeeded', 'cancelled', 'failed'].includes(state.outcome)) { await refresh(); return; }
    const token = epoch;
    stopPolling();
    // A new verification round starts now: facts from an earlier round must not settle anything while its
    // operation query is still in flight.
    missingReceipt = null;
    const holder = hold(), lookupAt = ++receiptClock;
    lookupInFlight = true;
    publish({ busy: true, missingReceiptFacts: null });
    try { await lookup(id, token, holder, lookupAt); }
    finally {
      lookupInFlight = false;
      if (lookupWanted) { lookupWanted = false; void reconcile(); } else ensureProgress();
    }
  }
  async function lookup(id: string, token: number, holder: number, lookupAt: number) {
    try {
      const reply = await tracked(() => client.operation(id));
      lookupFailures = 0; autoLookupStopped = false;
      const shownBefore = shownRank;
      // No progress unless the receipt ranks above what was shown (acceptReceipt resets the pace then).
      if (rankOf(reply, lookupAt) <= shownBefore) quietLookups += 1;
      await acceptReceipt(reply, token, holder, lookupAt);
    } catch (error) {
      // A late lookup never reopens an operation that has a final outcome meanwhile (see `undecided`), and a lookup
      // overtaken by a receipt (the Host's newer state) says nothing anymore.
      if (!current(token) || !undecided(id) || appliedReceiptAt > lookupAt) { drop(holder); return; }
      // NOT_FOUND can mean Host restart or its 15-minute memory expiry. Never infer rollback or send begin again.
      const code = pluginManagementErrorCode(error);
      const gone = code === 'NOT_FOUND';
      if (!gone) {
        // A failed lookup says nothing about the computer's plugins: no snapshot is read here (only after NOT_FOUND,
        // when the facts settle a result whose receipt is gone). The next automatic lookup backs off, or stops.
        lookupFailures += 1; quietLookups += 1;
        if (!TRANSIENT_LOOKUP_ERRORS.has(code) || lookupFailures >= AUTO_LOOKUP_FAILURES) autoLookupStopped = true;
        release(holder, { outcome: 'unknown', errorCode: code, missingReceiptFacts: null });
        return;
      }
      // While the facts after a missing receipt are read, stay busy: the snapshot already in state predates them.
      publish({ outcome: 'unknown', errorCode: code, missingReceiptFacts: null });
      const notFoundSequence = snapshotSequence;
      if (gone) missingReceipt = { token, after: notFoundSequence };
      const ours = snapshotSequence + 1; // readSnapshot takes the next sequence synchronously
      let fresh: PluginManagementSnapshot | null = null;
      try { fresh = await readSnapshot(token); } catch { /* Keep the original unknown-result reason. */ }
      if (gone && current(token) && missingReceipt?.token === token) {
        // A read started after ours (e.g. a plugin-change refresh) replaces it. Only the newest read issued
        // counts: if it already landed after NOT_FOUND, use it; while it is in flight stay unconfirmed, and it
        // becomes the facts when it lands (publishSnapshot).
        const latestLanded = publishedSnapshotSequence === snapshotSequence && publishedSnapshotSequence > notFoundSequence;
        const facts = ours === snapshotSequence ? fresh : latestLanded ? state.snapshot : null;
        if (facts) missingFactsSequence = snapshotSequence;
        conclude(holder, { missingReceiptFacts: facts });
      }
      drop(holder);
    }
  }
  function consentAllowance(): PluginConsentAllowance | null {
    const consent = state.receipt?.consent;
    return consent ? pluginConsentAllowance(state.expectedConsent ?? null, declaredPluginConsent(consent, client.deviceId)) : null;
  }
  async function answer(confirmed: boolean) {
    const receipt = state.receipt;
    if (!receipt?.consent || state.outcome !== 'confirmation' || !state.online || state.busy || disposed || !client.isCurrent() || !opGuard()) return;
    // One answer per consent request: none while another is in flight or was written (maintainer review 11:45).
    const requestId = receipt.consent.requestId;
    if (answers.has(requestId)) return;
    const token = epoch, holder = hold();
    let sentAt = Number.POSITIVE_INFINITY;
    answers.set(requestId, 'pending');
    publish({ busy: true, errorCode: null });
    // Stopped here before anything was sent: the consent can be answered again.
    const unsent = (patch: Partial<PluginManagementState> = {}) => {
      if (answers.get(requestId) === 'pending') { answers.delete(requestId); answerSentAt.delete(requestId); }
      conclude(holder, patch);
    };
    try {
      // The same decision as the sheet's Allow (dispatcher O-4), for every caller, right before anything is written.
      const allowance = confirmed ? consentAllowance() : null;
      if (allowance && !allowance.allow) {
        unsent({ errorCode: allowance.reason === 'source-unverified' ? 'PLUGIN_SOURCE_UNVERIFIED'
          : allowance.reason === 'source-changed' ? 'PLUGIN_SOURCE_CHANGED' : 'PLUGIN_CONSENT_CHANGED' });
        return;
      }
      if (confirmed) {
        const snapshot = await readSnapshot(token);
        if (!current(token)) { unsent(); return; }
        if (!receiverCurrent(snapshot)) throw new PluginManagementRequestError('PLUGIN_INSTALL_CHANGED');
      }
      // A result whose receipt is later gone is confirmed from the Host's own evidence (contract V2.9:
      // `installedOperationId` equals this operation id), never from whether this Allow was written.
      if (!current(token)) { unsent(); return; }
      sentAt = ++receiptClock;
      answerSentAt.set(requestId, sentAt);
      const reply = await tracked(() => client.answer(receipt.operationId, requestId, confirmed,
        () => current(token) && state.online && opGuard() && (!confirmed || (!!facts && receiverCurrent(facts)))), true);
      answers.set(requestId, 'written'); answerWrittenEver = true;
      // The answer's own reply describes the Host after it took this answer.
      await acceptReceipt(reply, token, holder, ++receiptClock);
    } catch (error) {
      // Never written: the operation still waits for this answer on the computer, unchanged; the consent can be
      // answered again. Only this request's own hold is released (a newer request may hold busy by now).
      if (notWritten(error)) {
        unsent(current(token) && undecided(receipt.operationId) ? { errorCode: pluginManagementErrorCode(error) } : {});
        return;
      }
      // Written, reply lost: this consent request is answered as far as the phone knows; it is never offered again, and
      // the operation's result is unknown whatever the connection epoch is now.
      answers.set(requestId, 'written'); answerWrittenEver = true;
      // Unknown unless a receipt applied after this answer was sent already tells the Host took it (running, or the
      // next consent). A later lookup that still found this very consent does not: the answer may arrive yet, so the
      // consent is not offered again and the result is looked up (maintainer review 13:02 #2).
      const sameConsent = state.outcome === 'confirmation' && state.receipt?.consent?.requestId === requestId;
      if (undecided(receipt.operationId) && (sameConsent || appliedReceiptAt < sentAt)) conclude(holder, { outcome: 'unknown', errorCode: pluginManagementErrorCode(error) });
      else conclude(holder, {});
    }
  }
  /**
   * The one place deciding whether anything but the person's tap may write (dispatcher L-2): a cancel, and only of the
   * consent this phone showed (`shownConsent`), never answered (no answer ever written or in flight), never cancelled
   * before. Nothing else in a controller writes by itself: lookups, checks, reconnects and reattached views only read.
   */
  function mayCancel() {
    return !!state.operationId && state.outcome === 'confirmation' && !cancelAttempted && !answerWrittenEver
      && !!shownConsent && state.receipt?.consent?.requestId === shownConsent
      && ![...answers.values()].includes('pending') && !state.busy;
  }
  async function cancel() {
    const id = state.operationId;
    if (!id || !state.online || disposed || !client.isCurrent() || !opGuard() || !mayCancel()) return;
    cancelAttempted = true;
    // Cancellation may race a queued/read request. Its newer result invalidates that request's late response.
    const token = ++epoch, holder = hold();
    stopPolling();
    cancelling = 'pending';
    publish({ busy: true, errorCode: null });
    const sentAt = ++receiptClock;
    try {
      const reply = await tracked(() => client.cancel(id, () => current(token) && state.online && opGuard()), true);
      cancelling = 'written';
      await acceptReceipt(reply, token, holder, sentAt);
    } catch (error) {
      // Never written: the operation runs on as before (same rule as an unwritten answer). Only while this cancel
      // still holds busy does it release it, set its error and resume polling.
      if (notWritten(error)) {
        if (cancelling === 'pending') cancelling = null;
        if (!release(holder, current(token) && undecided(id) ? { errorCode: pluginManagementErrorCode(error) } : {})) publish({});
        return;
      }
      // Written, reply lost: the Host may have cancelled it; the result is unknown whatever the epoch is now.
      cancelling = 'written';
      if (undecided(id) && appliedReceiptAt < sentAt) conclude(holder, { outcome: 'unknown', errorCode: pluginManagementErrorCode(error) });
      else conclude(holder, {});
    }
  }
  const unsubscribeOwner = subscribeMobileAuthOwner(() => {
    if (client.isCurrent()) return;
    ++epoch; stopPolling(); busyHolder = 0; answers.clear(); cancelling = null; consentOrder.length = 0; answerSentAt.clear(); shownRank = -1;
    resultReadAfter = null;
    publish({ capability: 'unknown', snapshot: null, uiConsent: null, receipt: null, operationId: null, busy: false, outcome: 'idle', errorCode: null,
      finalReadback: undefined,
    });
  });
  return {
    getState: () => state,
    currentMissingReceiptFacts,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    refresh,
    install: (detail: ManagedMarketDetail, installed?: ManagedPlugin, slotHold?: PluginOperationHold) => start({ kind: 'install', detail, installed }, slotHold),
    uninstall: (installed: ManagedPlugin, slotHold?: PluginOperationHold) => start({ kind: 'uninstall', installed }, slotHold),
    setEnabled: (installed: ManagedPlugin, enabled: boolean) => start({ kind: enabled ? 'enable' : 'disable', installed }),
    approveUi: (installed: ManagedPlugin, slotHold?: PluginOperationHold) => start({ kind: 'approve-ui', installed }, slotHold),
    deferUi: (installed: ManagedPlugin) => start({ kind: 'defer-ui', installed }),
    approveUiFromConsent: (installed: PluginUiConsentItem) => start({ kind: 'approve-ui', installed }),
    deferUiFromConsent: (installed: PluginUiConsentItem) => start({ kind: 'defer-ui', installed }),
    answer, cancel, reconcile, mayCancel,
    /** `cancel()` would write now: the consent may be cancelled and this operation holds (or takes back) its computer's slot. */
    canCancelNow: () => mayCancel() && opGuard(),
    /** The confirmation sheet put this consent on screen (see `shownConsent`). */
    markConsentShown(requestId: string) {
      // (Nothing is published for it: a sheet marks its consent in its own effect, before the page holds the entry for
      // that sheet in a later effect of the same commit; a change announced in between would read as a view that left.)
      if (!disposed && state.outcome === 'confirmation' && state.receipt?.consent?.requestId === requestId) shownConsent = requestId;
    },
    /**
     * No view shows this operation's consent any more and nothing was cancelled for it (it was answered once already,
     * or it was not on screen when its view went): found waiting on the computer, it is the person's to open again
     * from the list of checks.
     */
    consentOffScreen() {
      if (disposed || !shownConsent || !opEntry) return;
      shownConsent = null;
      publish({});
    },
    /** A consent is on the computer that this phone never showed (found by a lookup): the person has to open it. */
    consentUnseen: () => state.outcome === 'confirmation' && !!state.receipt?.consent && state.receipt.consent.requestId !== shownConsent
      && !state.answerHeld,
    /**
     * Before the person opens a consent from the list of pending checks (dispatcher L-2): the operation holds its
     * computer's slot, taking it back if it went; false when someone else holds it (nothing may be answered then).
     */
    ensureHold(): boolean {
      if (!opHold && releasedHold && state.operationId) takeSlotBack();
      return opHold ? opHold.guard() : !releasedHold;
    },
    /** The one cancel of this operation: not tried, in flight, or over (written or not). */
    cancelPhase: (): 'none' | 'inflight' | 'over' => !cancelAttempted ? 'none' : cancelling === 'pending' ? 'inflight' : 'over',
    /**
     * No write of this operation is on its way (begin, Allow / Reject and cancel each hold `busy` until they settle). A
     * lookup still out is a read: letting go drops its reply.
     */
    idle: () => !state.busy && writesInFlight === 0,
    /** An operation is under way: neither final nor stopped before begin (see usePluginManagement's retention). */
    hasOpenOperation: () => !disposed && (state.busy || (!!state.operationId && !['succeeded', 'cancelled', 'failed'].includes(state.outcome))),
    /**
     * Nothing moves an unknown result on by itself anymore: automatic lookups stopped, or the receipt is gone and the
     * result is being settled from the computer's facts by whoever shows it.
     */
    lookupsStopped: () => autoLookupStopped || !!missingReceipt || !!state.missingReceiptFacts,
    /**
     * This phone wrote this operation (its begin at least) and its result is not settled (maintainer review 18:45): what
     * the pending-check list shows, by the entry and plugin it was started for. Null otherwise, or when no entry of the
     * plugins page started it. `waiting`: the result waits for the person to check it (the computer's slot went).
     */
    pendingCheck(): { operationId: string; entry: PluginSlotEntry; who: PluginSlotHolder; detail?: ManagedMarketDetail; waiting: boolean } | null {
      if (disposed || !opEntry || !opWho || !state.operationId || final(state.outcome)) return null;
      return { operationId: state.operationId, entry: opEntry, who: opWho, detail: installDetail,
        waiting: !state.busy && writesInFlight === 0 && waitsForCheck() };
    },
    /**
     * Stop following the operation on this phone only ("Stop tracking", or a result settled from the computer's facts):
     * nothing is written to the computer; the view goes back to no operation, its slot goes. Not while a write of it is
     * on its way (the slot never goes then).
     */
    /**
     * The operation this controller ran, once it has a final result (dispatcher O-2): what `pluginOperationOpens` needs
     * to decide whether a view opens an instance after it. Null while not final, or when no entry of the page started it.
     */
    /** Whether the consent on screen can be allowed here (`pluginConsentAllowance`; null without one). */
    consentAllowance,
    finishedOperation(): { operationId: string; entry: PluginSlotEntry; who: PluginSlotHolder; detail?: ManagedMarketDetail } | null {
      if (disposed || !opEntry || !opWho || !state.operationId || !final(state.outcome)) return null;
      return { operationId: state.operationId, entry: opEntry, who: opWho, detail: installDetail };
    },
    untrack(): boolean {
      if (disposed || writesInFlight > 0) return false;
      ++epoch; stopPolling(); busyHolder = 0; answers.clear(); cancelling = null;
      resultReadAfter = null;
      publish({ operationId: null, receipt: null, outcome: 'idle', busy: false, errorCode: null, finalReadback: undefined });
      settleHold();
      return true;
    },
    setOnline(online: boolean) {
      if (disposed || state.online === online) return;
      ++epoch; stopPolling(); busyHolder = 0;
      // Back online or in the foreground: automatic lookups start over.
      if (online) { lookupFailures = 0; autoLookupStopped = false; resetPace(); }
      const active = state.operationId && !['succeeded', 'cancelled', 'failed'].includes(state.outcome);
      // Offline: a result still waiting for its read cannot be read now; it is `failed` (recoverable: the snapshot the
      // reconnect refresh publishes settles it), so no view waits on it.
      publish({ online, busy: false, ...(active ? { outcome: 'unknown' as const } : {}),
        ...(!online && state.finalReadback === 'pending' ? { finalReadback: 'failed' as const } : {}) });
      if (online) void reconcile();
    },
    dispose() {
      if (disposed) return;
      releasedHold = null;
      // Only this phone's tracking ends: nothing is written to the Host (an answered operation must go on; an unanswered
      // consent left behind was cancelled, once, before getting here, or expires on the computer).
      disposed = true; ++epoch; stopPolling(); unsubscribeOwner(); listeners.clear();
      settleHold();
    },
  };
}
export type PluginManagementController = ReturnType<typeof createPluginManagementController>;

/**
 * What a controller whose view went away does next (maintainer review 17:43), decided from its state alone each time it
 * changes, so it cannot re-enter: wait while anything is in flight; cancel an unanswered consent once (the slot stays
 * held until that cancel is over); after that, or when an unknown result can no longer move on by itself, let go:
 * only this phone's tracking ends, nothing is written. An operation whose answer was written is never cancelled.
 */
export type DetachedStep = "wait" | "cancel" | "letGo" | "keep";
export function nextDetachedStep(controller: PluginManagementController): DetachedStep {
  const state = controller.getState();
  if (!controller.hasOpenOperation()) return "letGo";
  if (!controller.idle()) return "wait";
  // (Only when the cancel would be written: with the computer's slot held by another operation it would not, and
  // the consent then waits in the list of checks like any other no view shows.)
  if (state.outcome === "confirmation" && !state.answerHeld && state.online && controller.canCancelNow()) return "cancel";
  // Maintainer review 18:45: an operation an entry of the plugins page wrote stays a pending check whatever else happens
  // (offline, lookups stopped, the receipt gone): only a final result, a result settled from the computer's facts, or
  // the person's "Stop tracking" ends it.
  if (controller.pendingCheck()) return "keep";
  // Operations started elsewhere (the chat's page prompt) keep the earlier rule: nobody here can move them on.
  if (state.outcome === "confirmation" && !state.answerHeld) return "letGo";
  if (state.outcome === "unknown" && (controller.lookupsStopped() || !state.online)) return "letGo";
  return "keep";
}
