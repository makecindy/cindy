import { randomUUID } from 'expo-crypto';
import { subscribeMobileAuthOwner } from '@/auth/authOwnerGeneration';
import { PluginManagementRequestError, pluginManagementErrorCode,
  type PluginManagementBegin, type PluginManagementClient } from './pluginManagementClient';
import { marketItemMatchesPlugin, pluginApprovalToken, type ManagedMarketDetail, type ManagedPlugin,
  type PluginManagementReceipt, type PluginManagementSnapshot } from './pluginManagementTypes';

export interface PluginManagementState {
  capability: 'unknown' | 'supported' | 'unsupported';
  snapshot: PluginManagementSnapshot | null;
  receipt: PluginManagementReceipt | null;
  operationId: string | null;
  busy: boolean;
  online: boolean;
  outcome: 'idle' | 'running' | 'confirmation' | 'succeeded' | 'cancelled' | 'failed' | 'unknown';
  errorCode: string | null;
}
export interface PluginManagementControllerOptions {
  online?: boolean;
  onChange?: (state: PluginManagementState) => void;
  /** Testable identity source; production uses the existing Expo UUID implementation. */
  createOperationId?: () => string;
  pollIntervalMs?: number;
}
type BeginIntent = PluginManagementBegin extends infer T ? T extends PluginManagementBegin ? Omit<T, 'operationId'> : never : never;
const terminal = (receipt: PluginManagementReceipt) => ['succeeded', 'cancelled', 'failed'].includes(receipt.phase);

/** One controller per selected Host/owner. Dispose when changing targets. No persisted writes or replay queue. */
export function createPluginManagementController(client: PluginManagementClient, options: PluginManagementControllerOptions = {}) {
  let state: PluginManagementState = { capability: 'unknown', snapshot: null, receipt: null,
    operationId: null, busy: false, online: options.online ?? true, outcome: 'idle', errorCode: null };
  let disposed = false, epoch = 0, refreshSequence = 0, snapshotSequence = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let receiver: ManagedPlugin | undefined;
  let installDetail: ManagedMarketDetail | undefined;
  const listeners = new Set<() => void>();
  const current = (token: number) => !disposed && epoch === token && client.isCurrent();
  const publish = (patch: Partial<PluginManagementState>) => {
    if (disposed) return;
    state = { ...state, ...patch };
    options.onChange?.(state);
    listeners.forEach((listener) => listener());
  };
  const stopPolling = () => { if (timer !== undefined) clearTimeout(timer); timer = undefined; };
  function schedulePoll() {
    stopPolling();
    if (state.online && state.operationId && state.outcome === 'running' && !state.busy && !disposed)
      timer = setTimeout(() => { timer = undefined; void reconcile(); }, Math.max(250, options.pollIntervalMs ?? 1000));
  }
  function receiverCurrent(snapshot: PluginManagementSnapshot): boolean {
    if (receiver) {
      const live = snapshot.ghosts.find((g) => g.instanceKey === receiver!.instanceKey);
      return !!live && live.manifest.id === receiver.manifest.id && live.namespace === receiver.namespace
        && pluginApprovalToken(live) === pluginApprovalToken(receiver);
    }
    return !installDetail || !snapshot.ghosts.some((g) => marketItemMatchesPlugin(installDetail!, g));
  }
  async function readSnapshot(token: number) {
    const sequence = ++snapshotSequence;
    const snapshot = await client.snapshot();
    if (current(token) && sequence === snapshotSequence) publish({ snapshot });
    return snapshot;
  }
  async function acceptReceipt(receipt: PluginManagementReceipt, token: number) {
    if (!current(token) || receipt.operationId !== state.operationId) return;
    publish({ receipt, outcome: receipt.phase, busy: false, errorCode: receipt.errorCode ?? null });
    if (terminal(receipt)) {
      // A cancel racing commit must still show succeeded. Refresh facts, without changing the receipt on read failure.
      stopPolling();
      try { await readSnapshot(token); } catch (error) { if (current(token)) publish({ errorCode: pluginManagementErrorCode(error) }); }
    } else schedulePoll();
  }
  async function refresh() {
    if (disposed || !state.online || !client.isCurrent()) return;
    const token = epoch, sequence = ++refreshSequence;
    try {
      const capability = await client.capability();
      if (!current(token) || sequence !== refreshSequence) return;
      publish({ capability, errorCode: null, ...(capability === 'unsupported' ? { snapshot: null } : {}) });
      if (capability === 'supported') {
        const snapshotToken = ++snapshotSequence;
        const snapshot = await client.snapshot();
        if (current(token) && sequence === refreshSequence && snapshotToken === snapshotSequence) publish({ snapshot });
      }
    } catch (error) {
      if (current(token) && sequence === refreshSequence) publish({ errorCode: pluginManagementErrorCode(error) });
    }
  }
  async function start(intent: BeginIntent) {
    if (disposed || !client.isCurrent()) return;
    if (!state.online) { publish({ errorCode: 'DEVICE_OFFLINE' }); return; }
    if (state.busy || (state.operationId && !['succeeded', 'cancelled', 'failed'].includes(state.outcome))) return;
    if (state.capability !== 'supported') { publish({ errorCode: state.capability === 'unsupported' ? 'PLUGIN_MANAGEMENT_UNSUPPORTED' : 'PLUGIN_MANAGEMENT_NOT_READY' }); return; }
    const token = ++epoch;
    let began = false;
    publish({ busy: true, errorCode: null, operationId: null, receipt: null, outcome: 'idle' });
    receiver = intent.installed;
    installDetail = intent.kind === 'install' ? intent.detail : undefined;
    try {
      let request: BeginIntent = intent;
      if (intent.kind === 'install') {
        const detail = await client.detail(intent.detail.pluginId);
        if (!current(token)) return;
        if (detail.releaseId !== intent.detail.releaseId || detail.namespace !== intent.detail.namespace
          || detail.sourceType !== intent.detail.sourceType || (detail.sourceType !== 'server'
            && JSON.stringify(detail.manifest) !== JSON.stringify(intent.detail.manifest))) throw new Error('PLUGIN_RELEASE_CHANGED');
        request = { ...intent, detail };
      }
      const snapshot = await readSnapshot(token);
      if (!current(token)) return;
      if (!receiverCurrent(snapshot)) throw new Error('PLUGIN_INSTALL_CHANGED');
      const operationId = (options.createOperationId ?? randomUUID)();
      publish({ operationId, outcome: 'running' });
      began = true;
      await acceptReceipt(await client.begin({ ...request, operationId }, () => current(token)
        && state.online && !!state.snapshot && receiverCurrent(state.snapshot)), token);
    } catch (error) {
      if (!current(token)) return;
      const unknown = began && (!(error instanceof PluginManagementRequestError) || error.outcomeUnknown);
      publish({ busy: false, outcome: unknown ? 'unknown' : 'failed', errorCode: pluginManagementErrorCode(error) });
    }
  }
  async function reconcile() {
    if (disposed || !state.online || state.busy || !client.isCurrent()) return;
    const id = state.operationId;
    if (!id || ['succeeded', 'cancelled', 'failed'].includes(state.outcome)) { await refresh(); return; }
    const token = epoch;
    stopPolling();
    publish({ busy: true });
    try { await acceptReceipt(await client.operation(id), token); }
    catch (error) {
      if (!current(token)) return;
      // NOT_FOUND can mean Host restart or its 15-minute memory expiry. Never infer rollback or send begin again.
      publish({ busy: false, outcome: 'unknown', errorCode: pluginManagementErrorCode(error) });
      try { await readSnapshot(token); } catch { /* Keep the original unknown-result reason. */ }
    }
  }
  async function answer(confirmed: boolean) {
    const receipt = state.receipt;
    if (!receipt?.consent || state.outcome !== 'confirmation' || !state.online || state.busy || disposed || !client.isCurrent()) return;
    const token = epoch;
    publish({ busy: true, errorCode: null });
    try {
      if (confirmed) {
        const snapshot = await readSnapshot(token);
        if (!current(token)) return;
        if (!receiverCurrent(snapshot)) throw new PluginManagementRequestError('PLUGIN_INSTALL_CHANGED');
      }
      if (current(token)) await acceptReceipt(await client.answer(receipt.operationId, receipt.consent.requestId, confirmed,
        () => current(token) && state.online && (!confirmed || (!!state.snapshot && receiverCurrent(state.snapshot)))), token);
    } catch (error) {
      if (current(token)) publish({ busy: false, outcome: 'unknown', errorCode: pluginManagementErrorCode(error) });
    }
  }
  async function cancel() {
    const id = state.operationId;
    if (!id || !state.online || disposed || !client.isCurrent() || ['succeeded', 'cancelled', 'failed'].includes(state.outcome)) return;
    // Cancellation may race a queued/read request. Its newer result invalidates that request's late response.
    const token = ++epoch;
    stopPolling();
    publish({ busy: true, errorCode: null });
    try { await acceptReceipt(await client.cancel(id, () => current(token) && state.online), token); }
    catch (error) { if (current(token)) publish({ busy: false, outcome: 'unknown', errorCode: pluginManagementErrorCode(error) }); }
  }
  const unsubscribeOwner = subscribeMobileAuthOwner(() => {
    if (client.isCurrent()) return;
    ++epoch; stopPolling();
    publish({ capability: 'unknown', snapshot: null, receipt: null, operationId: null, busy: false, outcome: 'idle', errorCode: null });
  });
  return {
    getState: () => state,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    refresh,
    install: (detail: ManagedMarketDetail, installed?: ManagedPlugin) => start({ kind: 'install', detail, installed }),
    uninstall: (installed: ManagedPlugin) => start({ kind: 'uninstall', installed }),
    setEnabled: (installed: ManagedPlugin, enabled: boolean) => start({ kind: enabled ? 'enable' : 'disable', installed }),
    answer, cancel, reconcile,
    setOnline(online: boolean) {
      if (disposed || state.online === online) return;
      ++epoch; stopPolling();
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
