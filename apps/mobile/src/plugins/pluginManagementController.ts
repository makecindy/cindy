import { randomUUID } from 'expo-crypto';
import type { PluginPromptDisplay } from './pluginPromptReads';
import { subscribeMobileAuthOwner } from '@/auth/authOwnerGeneration';
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
}
export interface PluginManagementControllerOptions {
  /** Optional shared chat hint. Never used by readSnapshot or mutation validation. */
  readDisplay?: () => Promise<PluginPromptDisplay>;
  online?: boolean;
  onChange?: (state: PluginManagementState) => void;
  /** Testable identity source; production uses the existing Expo UUID implementation. */
  createOperationId?: () => string;
  pollIntervalMs?: number;
  /** Only for callers that already confirmed paged-catalog support; default stays the v1 full snapshot. */
  snapshotRead?: 'installed';
}
type BeginIntent = PluginManagementBegin extends infer T ? T extends PluginManagementBegin ? Omit<T, 'operationId'> : never : never;
type ConsentIntent = { kind: 'approve-ui' | 'defer-ui'; installed: PluginUiConsentItem };
const terminal = (receipt: PluginManagementReceipt) => ['succeeded', 'cancelled', 'failed'].includes(receipt.phase);

/** One controller per selected Host/owner. Dispose when changing targets. No persisted writes or replay queue. */
export function createPluginManagementController(client: PluginManagementClient, options: PluginManagementControllerOptions = {}) {
  let state: PluginManagementState = { capability: 'unknown', snapshot: null, uiConsent: null, receipt: null,
    operationId: null, busy: false, online: options.online ?? true, outcome: 'idle', errorCode: null };
  let disposed = false, epoch = 0, refreshSequence = 0, snapshotSequence = 0;
  // Display reads cannot erase the full Host facts used for queued write guards.
  let facts: PluginManagementSnapshot | null = null, factsSequence = 0;
  let pendingDisplay: { token: number; sequence: number; promise: Promise<PluginPromptDisplay> } | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let receiver: ManagedPlugin | undefined;
  let uiConsentOperation = false;
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
  /** Apply an operation result: with the release when `holder` holds busy, otherwise without touching busy. */
  const conclude = (holder: number, patch: Partial<PluginManagementState>) => { if (!release(holder, patch)) publish(patch); };
  /** Answers by consent request id: in flight, or written (the Host may have it). At most one per request id. */
  const answers = new Map<string, 'pending' | 'written'>();
  /** A cancel of this operation in flight or written: the consent may be gone on the Host, so it is not offered. */
  let cancelling: 'pending' | 'written' | null = null;
  /**
   * Lookups and receipts on one clock: a lookup's reply applies only while it is the newest lookup and no receipt was
   * applied after it was sent, so a late, older reply never reopens a confirmation already left.
   */
  let receiptClock = 0, newestLookup = 0, appliedReceiptAt = 0, mutationSentAt = 0;
  /** A lookup sent before the newest receipt or the newest write (answer, cancel) no longer describes the operation. */
  const lookupStale = (lookupAt: number) => lookupAt !== newestLookup || appliedReceiptAt > lookupAt || mutationSentAt > lookupAt;
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
    // Facts about a missing receipt belong to that unknown result only.
    if ((patch.outcome !== undefined && patch.outcome !== 'unknown') || patch.operationId !== undefined) {
      state.missingReceiptFacts = null;
      missingReceipt = null;
    }
    options.onChange?.(state);
    listeners.forEach((listener) => listener());
  };
  const stopPolling = () => { if (timer !== undefined) clearTimeout(timer); timer = undefined; };
  function schedulePoll() {
    stopPolling();
    if (state.online && state.operationId && state.outcome === 'running' && !state.busy && !disposed)
      timer = setTimeout(() => { timer = undefined; void reconcile(); }, Math.max(250, options.pollIntervalMs ?? 1000));
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
    publish({ ...patch, snapshot, ...(asFacts ? { missingReceiptFacts: snapshot } : {}) });
  }
  async function readSnapshot(token: number) {
    const sequence = issueSnapshotRead();
    const factsToken = ++factsSequence;
    const snapshot = await client.snapshot(options.snapshotRead);
    if (current(token) && factsToken === factsSequence) facts = snapshot;
    // Both display reads and full snapshots share this sequence. A current full
    // read replaces the older hint; a later lightweight read can replace it again.
    if (current(token) && sequence === snapshotSequence) publishSnapshot(sequence, token, snapshot, { uiConsent: null });
    return snapshot;
  }
  /** `holder`: the request that got this receipt; `lookupAt`: set for a lookup's reply (see `receiptClock`). */
  // A receipt is the Host's state of the operation: it lands by operation id even after the connection epoch moved
  // (a cancel reply dropped for its epoch let an older lookup reopen a consent the Host had already cancelled).
  async function acceptReceipt(receipt: PluginManagementReceipt, token: number, holder: number, lookupAt?: number) {
    if (!undecided(receipt.operationId)
      || (lookupAt !== undefined && lookupStale(lookupAt))) {
      if (lookupAt !== undefined && undecided(receipt.operationId) && state.outcome === 'unknown') lookupWanted = true;
      release(holder);
      return;
    }
    appliedReceiptAt = ++receiptClock;
    // The Host still shows a consent this phone already answered (written, reply lost): never offer it again; the
    // result stays unknown until the Host reports the answer's outcome.
    const answered = receipt.phase === 'confirmation' && !!receipt.consent
      && (answers.get(receipt.consent.requestId) === 'written' || cancelling === 'written');
    const consumed = receipt.phase === 'succeeded' && uiConsentOperation ? receiver : undefined;
    // Keep only the latest in-flight display read displaced by this successful
    // receipt. It is a fallback for failed readback, never a new remote request.
    const displacedDisplay = consumed && pendingDisplay?.token === token
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
    conclude(holder, { ...prompt, receipt, outcome: answered ? 'unknown' : receipt.phase, errorCode: receipt.errorCode ?? null });
    if (terminal(receipt)) {
      // A cancel racing commit must still show succeeded. Refresh facts, without changing the receipt on read failure.
      stopPolling();
      const readback = readSnapshot(token), readbackSequence = snapshotSequence;
      try { await readback; } catch (error) {
        if (current(token)) publish({ errorCode: pluginManagementErrorCode(error) });
        if (displacedDisplay && consumed) {
          try {
            const display = await displacedDisplay;
            const item = display.uiConsent?.item;
            // A later read/operation still wins. Only an unrelated pending item
            // can be recovered; the committed instance revision cannot revive.
            if (current(token) && snapshotSequence === readbackSequence && item
              && (item.instanceKey !== consumed.instanceKey || item.approvalToken !== pluginApprovalToken(consumed))) {
              publish({ ...display });
            }
          } catch { /* Preserve the readback error; neither failed read retries itself. */ }
        }
      }
    } else schedulePoll();
  }
  async function refresh() {
    if (disposed || !state.online || !client.isCurrent()) return;
    const token = epoch, sequence = ++refreshSequence;
    try {
      if (options.readDisplay) {
        const snapshotToken = issueSnapshotRead();
        const reading = { token, sequence: snapshotToken, promise: options.readDisplay() };
        pendingDisplay = reading;
        try {
          const display = await reading.promise;
          if (current(token) && sequence === refreshSequence && snapshotToken === snapshotSequence) {
            publishedSnapshotSequence = snapshotToken;
            publish({ ...display, uiConsent: display.uiConsent ?? null, errorCode: null });
          }
        } finally { if (pendingDisplay === reading) pendingDisplay = undefined; }
        return;
      }
      const capability = await client.capability();
      if (!current(token) || sequence !== refreshSequence) return;
      publish({ capability, uiConsent: null, errorCode: null, ...(capability === 'unsupported' ? { snapshot: null } : {}) });
      if (capability === 'supported') {
        const snapshotToken = issueSnapshotRead();
        const factsToken = ++factsSequence;
        const snapshot = await client.snapshot(options.snapshotRead);
        if (current(token) && factsToken === factsSequence) facts = snapshot;
        if (current(token) && sequence === refreshSequence && snapshotToken === snapshotSequence)
          publishSnapshot(snapshotToken, token, snapshot, {});
      }
    } catch (error) {
      if (current(token) && sequence === refreshSequence) publish({ errorCode: pluginManagementErrorCode(error) });
    }
  }
  async function start(intent: BeginIntent | ConsentIntent) {
    if (disposed || !client.isCurrent()) return;
    if (!state.online) { publish({ errorCode: 'DEVICE_OFFLINE' }); return; }
    if (state.busy || (state.operationId && !['succeeded', 'cancelled', 'failed'].includes(state.outcome))) return;
    if (state.capability !== 'supported') { publish({ errorCode: state.capability === 'unsupported' ? 'PLUGIN_MANAGEMENT_UNSUPPORTED' : 'PLUGIN_MANAGEMENT_NOT_READY' }); return; }
    const token = ++epoch;
    let began = false, operationId: string | null = null;
    const holder = hold();
    answers.clear(); cancelling = null;
    publish({ busy: true, errorCode: null, operationId: null, receipt: null, outcome: 'idle',
      expectedSource: intent.kind === 'install' && intent.detail.sourceType !== 'server' ? intent.detail.sourceIdentity ?? null : null });
    const installed = intent.installed;
    if (!installed && intent.kind !== 'install') { release(holder, { outcome: 'failed', errorCode: 'PLUGIN_INSTALL_CHANGED' }); return; }
    receiver = installed && 'manifest' in installed ? installed : undefined;
    uiConsentOperation = intent.kind === 'approve-ui' || intent.kind === 'defer-ui';
    installDetail = intent.kind === 'install' ? intent.detail : undefined;
    try {
      let request: BeginIntent = intent as BeginIntent;
      if (intent.kind === 'install') {
        const detail = await client.detail(intent.detail.pluginId);
        if (!current(token)) { release(holder); return; }
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
      if (!current(token)) { release(holder); return; }
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
      await acceptReceipt(await client.begin({ ...request, operationId,
        ...(snapshot.uiCapabilityApproval ? { uiConsentVersion: 1 } : {}) }, () => current(token)
        && state.online && !!facts && receiverCurrent(facts)), token, holder);
    } catch (error) {
      // Maintainer review 10:36 #1: a begin stopped before it was written (for example by the last check after the
      // computer went offline while it was queued) is a plain failure of this operation, even though going offline
      // moved the epoch and marked it unknown meanwhile; it frees the management slot, and a later query cannot
      // turn it back into an unknown result.
      if (began && notWritten(error) && undecided(operationId)) {
        conclude(holder, { outcome: 'failed', errorCode: pluginManagementErrorCode(error) });
        return;
      }
      if (!current(token) || (began && !undecided(operationId))) { release(holder); return; }
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
    const holder = hold(), lookupAt = newestLookup = ++receiptClock;
    lookupInFlight = true;
    publish({ busy: true, missingReceiptFacts: null });
    try { await lookup(id, token, holder, lookupAt); }
    finally {
      lookupInFlight = false;
      if (lookupWanted) { lookupWanted = false; void reconcile(); }
    }
  }
  async function lookup(id: string, token: number, holder: number, lookupAt: number) {
    try { await acceptReceipt(await client.operation(id), token, holder, lookupAt); }
    catch (error) {
      // A late lookup never reopens an operation that has a final outcome meanwhile (see `undecided`), and an older
      // lookup or one overtaken by a receipt says nothing anymore.
      if (!current(token) || !undecided(id) || lookupStale(lookupAt)) {
        if (undecided(id) && lookupStale(lookupAt) && state.outcome === 'unknown') lookupWanted = true;
        release(holder);
        return;
      }
      // NOT_FOUND can mean Host restart or its 15-minute memory expiry. Never infer rollback or send begin again.
      const code = pluginManagementErrorCode(error);
      const gone = code === 'NOT_FOUND';
      // While the facts after a missing receipt are read, stay busy: the snapshot already in state predates them.
      if (gone) publish({ outcome: 'unknown', errorCode: code, missingReceiptFacts: null });
      else { release(holder, { outcome: 'unknown', errorCode: code, missingReceiptFacts: null }); }
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
      release(holder);
    }
  }
  async function answer(confirmed: boolean) {
    const receipt = state.receipt;
    if (!receipt?.consent || state.outcome !== 'confirmation' || !state.online || state.busy || disposed || !client.isCurrent()) return;
    // One answer per consent request: none while another is in flight or was written (maintainer review 11:45).
    const requestId = receipt.consent.requestId;
    if (answers.has(requestId)) return;
    const token = epoch, holder = hold();
    let sentAt = Number.POSITIVE_INFINITY;
    answers.set(requestId, 'pending');
    publish({ busy: true, errorCode: null });
    // Stopped here before anything was sent: the consent can be answered again.
    const unsent = (patch: Partial<PluginManagementState> = {}) => {
      if (answers.get(requestId) === 'pending') answers.delete(requestId);
      conclude(holder, patch);
    };
    try {
      const consent = receipt.consent;
      if (confirmed && consent.origin === 'custom-market') {
        // Never allow a custom-market consent the phone cannot tie to the chosen source (the sheet already keeps
        // Allow unavailable; this guards every caller).
        if (!consent.originSource) { unsent({ errorCode: 'PLUGIN_SOURCE_UNVERIFIED' }); return; }
        if (state.expectedSource && !samePluginMarketSourceIdentity(consent.originSource, state.expectedSource)) {
          unsent({ errorCode: 'PLUGIN_SOURCE_CHANGED' });
          return;
        }
      }
      if (confirmed) {
        const snapshot = await readSnapshot(token);
        if (!current(token)) { unsent(); return; }
        if (!receiverCurrent(snapshot)) throw new PluginManagementRequestError('PLUGIN_INSTALL_CHANGED');
      }
      // A result whose receipt is later gone is confirmed from the Host's own evidence (contract V2.9:
      // `installedOperationId` equals this operation id), never from whether this Allow was written.
      if (!current(token)) { unsent(); return; }
      sentAt = mutationSentAt = ++receiptClock;
      const reply = await client.answer(receipt.operationId, requestId, confirmed,
        () => current(token) && state.online && (!confirmed || (!!facts && receiverCurrent(facts))));
      answers.set(requestId, 'written');
      await acceptReceipt(reply, token, holder);
    } catch (error) {
      // Never written: the operation still waits for this answer on the computer, unchanged; the consent can be
      // answered again. Only this request's own hold is released (a newer request may hold busy by now).
      if (notWritten(error)) {
        unsent(current(token) && undecided(receipt.operationId) ? { errorCode: pluginManagementErrorCode(error) } : {});
        return;
      }
      // Written, reply lost: this consent request is answered as far as the phone knows; it is never offered again, and
      // the operation's result is unknown whatever the connection epoch is now.
      answers.set(requestId, 'written');
      // A receipt applied after this answer was sent (a newer lookup) already tells the operation's state.
      if (undecided(receipt.operationId) && appliedReceiptAt < sentAt) conclude(holder, { outcome: 'unknown', errorCode: pluginManagementErrorCode(error) });
      else conclude(holder, {});
    }
  }
  async function cancel() {
    const id = state.operationId;
    if (!id || !state.online || disposed || !client.isCurrent() || ['succeeded', 'cancelled', 'failed'].includes(state.outcome)) return;
    // Cancellation may race a queued/read request. Its newer result invalidates that request's late response.
    const token = ++epoch, holder = hold();
    stopPolling();
    cancelling = 'pending';
    publish({ busy: true, errorCode: null });
    const sentAt = (mutationSentAt = ++receiptClock);
    try {
      const reply = await client.cancel(id, () => current(token) && state.online);
      cancelling = 'written';
      await acceptReceipt(reply, token, holder);
    } catch (error) {
      // Never written: the operation runs on as before (same rule as an unwritten answer). Only while this cancel
      // still holds busy does it release it, set its error and resume polling.
      if (notWritten(error)) {
        if (cancelling === 'pending') cancelling = null;
        if (release(holder, current(token) && undecided(id) ? { errorCode: pluginManagementErrorCode(error) } : {})) schedulePoll();
        else publish({});
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
    ++epoch; stopPolling(); busyHolder = 0; answers.clear(); cancelling = null;
    publish({ capability: 'unknown', snapshot: null, uiConsent: null, receipt: null, operationId: null, busy: false, outcome: 'idle', errorCode: null,
    });
  });
  return {
    getState: () => state,
    currentMissingReceiptFacts,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    refresh,
    install: (detail: ManagedMarketDetail, installed?: ManagedPlugin) => start({ kind: 'install', detail, installed }),
    uninstall: (installed: ManagedPlugin) => start({ kind: 'uninstall', installed }),
    setEnabled: (installed: ManagedPlugin, enabled: boolean) => start({ kind: enabled ? 'enable' : 'disable', installed }),
    approveUi: (installed: ManagedPlugin) => start({ kind: 'approve-ui', installed }),
    deferUi: (installed: ManagedPlugin) => start({ kind: 'defer-ui', installed }),
    approveUiFromConsent: (installed: PluginUiConsentItem) => start({ kind: 'approve-ui', installed }),
    deferUiFromConsent: (installed: PluginUiConsentItem) => start({ kind: 'defer-ui', installed }),
    answer, cancel, reconcile,
    setOnline(online: boolean) {
      if (disposed || state.online === online) return;
      ++epoch; stopPolling(); busyHolder = 0;
      const active = state.operationId && !['succeeded', 'cancelled', 'failed'].includes(state.outcome);
      publish({ online, busy: false, ...(active ? { outcome: 'unknown' as const } : {}) });
      if (online) void reconcile();
    },
    dispose() {
      if (disposed) return;
      const id = state.operationId;
      const active = id && !['succeeded', 'cancelled', 'failed'].includes(state.outcome);
      disposed = true; ++epoch; stopPolling(); unsubscribeOwner(); listeners.clear();
      if (active && state.online) void client.cancelForCleanup(id).catch(() => {});
    },
  };
}
export type PluginManagementController = ReturnType<typeof createPluginManagementController>;
