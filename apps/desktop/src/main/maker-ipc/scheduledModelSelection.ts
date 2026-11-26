import type { AgentKind, Effort, EngineKind } from '@cindy/maker-core';
import { actualSourceIdForModel, connectedProvidersForAgent, effectiveSourceIdForModel, findCatalogModel, isModelSelectableForNewRoute, type ProviderView } from '@cindy/model-providers';
import { resolveCompatibleSessionRuntimeEffort } from './sessionRuntimeControl';
import { parseScheduledModelBaseline, type ScheduledModelBaseline } from '../../shared/scheduledModelBaseline';
import { throwIpcError } from '../utils/ipcValidate';
import { isIpcError } from '../../shared/ipc-errors';

/** A saved automation choice, applied only while its target's send lock is held. */
export interface ScheduledModelSelection {
  agentKind: EngineKind;
  /** Undefined inherits a bound task; null explicitly selects the task host. */
  agentDeviceId?: string | null;
  model: string;
  providerId: string | null;
  effort: Effort | null;
  fastMode: boolean | 'ultrafast';
  /** Restored when returning from a temporary scheduled switch that narrowed permissionMode. */
  permissionMode?: ScheduledModelBaseline['permissionMode'];
}

export type BuiltinScheduledModelSelection = Omit<ScheduledModelSelection, 'agentKind'> & {
  agentKind: AgentKind;
};

export interface ScheduledModelSelectionLease {
  release: () => void;
  selection: ScheduledModelSelection;
}

/** Send-boundary operations only. The saved preference survives idle time and restart. */
export function createScheduledModelScope(deps: {
  read: (sessionId: string) => Promise<{
    profile: Omit<ScheduledModelSelection, 'effort'> & {
      effort: ScheduledModelSelection['effort'] | '';
    };
    baseline: string | null;
    profileRevision?: string | null;
  } | null>;
  write: (sessionId: string, baseline: ScheduledModelBaseline | null, profileRevision?: string | null, expectedBaseline?: string | null, restoredProfile?: ScheduledModelSelection) => Promise<void | boolean>;
  isBusy: (sessionId: string) => boolean;
  apply: (sessionId: string, profile: ScheduledModelSelection) => Promise<void | ScheduledModelSelection>;
  createId: () => string;
  ownerEpoch?: () => string;
  prepareBaseline?: (sessionId: string) => Promise<void>;
  /** Caller holds the send lock; true means the saved companion route was
   * applied and the exact failed baseline was retired without restoring it. */
  recoverUnavailableBaseline?: (sessionId: string, expectedBaseline: string) => Promise<boolean>;
}) {
  const assertOwner = (owner: string | undefined) => {
    if (owner !== deps.ownerEpoch?.()) throw new Error('Account changed during scheduled model selection');
  };
  return {
    async begin(sessionId: string): Promise<string | undefined> {
      const owner = deps.ownerEpoch?.();
      let row = await deps.read(sessionId);
      assertOwner(owner);
      if (!row) return undefined;
      const reuseBaseline = async (existing: ScheduledModelBaseline, captured: NonNullable<typeof row>) => {
        // Older baselines predate location overrides. Capture the current location
        // before this automation can move it, without replacing the owner's model.
        if (existing.agentDeviceId === undefined) {
          const written = await deps.write(sessionId,
            { ...existing, agentDeviceId: captured.profile.agentDeviceId ?? null }, captured.profileRevision, captured.baseline);
          assertOwner(owner);
          if (written === false) {
            throw new ScheduledModelSelectionBusyError('Companion profile changed during baseline upgrade');
          }
        }
        return existing.scopeId;
      };
      const existing = parseScheduledModelBaseline(row.baseline);
      if (existing && !existing.pendingBotProfileVersion) return reuseBaseline(existing, row);
      const profileRevision = row.profileRevision;
      // Settings may have committed while their asynchronous runtime refresh is
      // still queued. Align the owner under this same send lease before capture.
      if (deps.prepareBaseline) {
        await deps.prepareBaseline(sessionId);
        assertOwner(owner);
        row = await deps.read(sessionId);
        assertOwner(owner);
        if (!row) return undefined;
      }
      if (row.profileRevision !== profileRevision) {
        throw new ScheduledModelSelectionBusyError('Companion profile changed during baseline preparation');
      }
      const prepared = parseScheduledModelBaseline(row.baseline);
      if (prepared?.pendingBotProfileVersion) {
        throw new ScheduledModelSelectionBusyError('Permanent model selection is still pending');
      }
      if (prepared) return reuseBaseline(prepared, row);
      const scopeId = deps.createId();
      const written = await deps.write(sessionId, { ...row.profile, agentDeviceId: row.profile.agentDeviceId ?? null,
        effort: row.profile.effort || null, scopeId }, profileRevision, row.baseline);
      assertOwner(owner);
      if (written === false) throw new ScheduledModelSelectionBusyError('Scheduled model selection changed before scope creation');
      return scopeId;
    },
    async restore(sessionId: string, expectedScopeId?: string): Promise<void> {
      if (deps.isBusy(sessionId)) return;
      const owner = deps.ownerEpoch?.();
      const row = await deps.read(sessionId);
      assertOwner(owner);
      const baseline = parseScheduledModelBaseline(row?.baseline);
      if (!baseline || (expectedScopeId && baseline.scopeId !== expectedScopeId)) return;
      // A permanent save owns the next selection, including across restart.
      // Keep its old baseline for retries until reconciliation accepts the save.
      if (baseline.pendingBotProfileVersion) return;
      let restoredProfile: void | ScheduledModelSelection;
      try {
        restoredProfile = await deps.apply(sessionId, baseline);
      } catch (error) {
        assertOwner(owner);
        // Only catalog/route validation marks a selection unavailable. Network,
        // permission and runtime-switch failures must retain the saved choice.
        if (isIpcError(error) && error.code === 'MODEL_SELECTION_UNAVAILABLE' &&
          await deps.recoverUnavailableBaseline?.(sessionId, row!.baseline!)) {
          assertOwner(owner);
          return;
        }
        throw error;
      }
      assertOwner(owner);
      const written = await deps.write(sessionId, null, row!.profileRevision, row!.baseline, restoredProfile || undefined);
      assertOwner(owner);
      if (written === false) throw new ScheduledModelSelectionBusyError('Scheduled model selection changed before scope cleanup');
    },
  };
}

/** Fence even lanes linked after the settings save took its send-lock snapshot.
 * The revision is read with the route; checking and writing are one DB statement.
 * Ordinary sessions use null, so acquiring a companion link also invalidates capture.
 */
export async function writeScheduledModelBaselineIfProfileCurrent(
  db: { exec: (sql: string, params: unknown[]) => Promise<{ changes: number }> },
  sessionId: string,
  baseline: ScheduledModelBaseline,
  profileRevision: string | null,
  expectedBaseline: string | null = null,
): Promise<boolean> {
  const result = await db.exec(`UPDATE sessions SET scheduled_model_baseline = ?
    WHERE id = ? AND status = 'active' AND scheduled_model_baseline IS ?
      AND (SELECT json_array(p.id, p.current_version)
           FROM bot_session_links l JOIN bot_profiles p ON p.id = l.bot_id
           WHERE l.session_id = sessions.id AND l.archived_at IS NULL
             AND l.role IN ('canonical', 'group', 'channel', 'thread', 'routine') LIMIT 1) IS ?`,
  [JSON.stringify(baseline), sessionId, expectedBaseline, profileRevision]);
  return result.changes === 1;
}

export class ScheduledModelSelectionBusyError extends Error {}

/** Settle a registered route under the caller's send lease before capturing its baseline.
 * Reuses the pending-switch path from PR #9680; unresolved state uses the runner's
 * existing deferred outcome rather than failing a run on a normal transition.
 */
export async function reconcileScheduledModelRouteBeforeBaseline(deps: {
  reconcile: () => Promise<void>;
  hasPendingRoute: () => boolean;
  hasPendingSwitch: () => boolean;
  isIdle: () => boolean;
  applyPendingSwitch: () => Promise<'applied' | 'staged' | 'failed'>;
}): Promise<void> {
  await deps.reconcile();
  if (!deps.hasPendingRoute()) return;
  if (!deps.isIdle()) {
    throw new ScheduledModelSelectionBusyError('Scheduled model selection waits for the saved companion route');
  }
  if (deps.hasPendingSwitch() && await deps.applyPendingSwitch() === 'failed') {
    throwIpcError('HARNESS_SWITCH_NOT_READY', 'Saved companion route could not be applied');
  }
  if (deps.hasPendingRoute()) {
    throw new ScheduledModelSelectionBusyError('Scheduled model selection waits for the saved companion route');
  }
}

interface ScheduledModelTarget {
  agentKind: EngineKind;
  providerId?: string | null;
  agentDeviceId?: string | null;
  status: string;
  source?: string | null;
  remoteHostId?: string | null;
  orcaRole?: string | null;
  orcaRemoteLead?: string | null;
}

/** Enforce the existing runtime boundary at save time as well as dispatch. */
export function assertScheduledHarnessSupported(
  target: ScheduledModelTarget | null,
  agentKind: EngineKind | undefined,
  agentDeviceId?: string | null,
  providerId?: string | null,
): void {
  if (target?.status !== 'active') return;
  const changesHarness = agentKind && target.agentKind !== agentKind;
  const changesPluginEngine = agentKind === 'acp' && target.agentKind === 'acp'
    && providerId !== undefined && (target.providerId ?? null) !== (providerId ?? null);
  const changesDevice = agentDeviceId !== undefined && agentDeviceId !== (target.agentDeviceId ?? null);
  if (!changesHarness && !changesDevice && !changesPluginEngine) return;
  // Ordinary Orca Lead/Worker use the existing handoff for both built-in axes, including
  // restoration before the next manual send. SSH still cannot change either.
  if (target.remoteHostId) {
    throwIpcError('SSH_HARNESS_SWITCH_UNSUPPORTED', 'SSH automation targets must keep their current Harness');
  }
  if (target.agentKind === 'acp' || agentKind === 'acp') {
    if (target.source === 'bot') {
      throwIpcError('UNSUPPORTED_CAPABILITY', 'Teammate routines cannot switch to or from a plugin engine');
    }
    if (target.orcaRole || target.orcaRemoteLead) {
      throwIpcError('UNSUPPORTED_CAPABILITY', 'Collaborative tasks cannot switch to or from a plugin engine');
    }
    if (target.source && target.source !== 'desktop') {
      throwIpcError('UNSUPPORTED_CAPABILITY', 'This task cannot switch to or from a plugin engine');
    }
    if (target.agentKind === 'acp' && target.agentDeviceId) {
      throwIpcError('UNSUPPORTED_CAPABILITY', 'The linked plugin engine task must run on this computer');
    }
    if (agentKind === 'acp' && agentDeviceId) {
      throwIpcError('UNSUPPORTED_CAPABILITY', 'Plugin engines run on the automation host only');
    }
  }
}

function scheduledModelProviderId(
  selection: BuiltinScheduledModelSelection,
  providers: ProviderView[],
): string | null {
  return selection.providerId ??
    // If admission removed every implicit source, retain the existing source only
    // for rejection classification; the selectable-model check below still applies.
    effectiveSourceIdForModel(providers, null, selection.model, selection.agentKind) ??
    actualSourceIdForModel(providers, null, selection.model, selection.agentKind);
}

/** Saved selections may outlive catalog effort/Fast support; resolve the actual route first. */
export function resolveScheduledModelSelection(
  selection: ScheduledModelSelection,
  providers: ProviderView[],
): BuiltinScheduledModelSelection {
  if (selection.agentKind === 'acp') {
    throwIpcError('UNSUPPORTED_CAPABILITY', 'Plugin engines are not resolved through the built-in catalog');
  }
  const builtinSelection: BuiltinScheduledModelSelection = { ...selection, agentKind: selection.agentKind };
  const providerId = scheduledModelProviderId(builtinSelection, providers);
  const connected = connectedProvidersForAgent(providers, builtinSelection.agentKind);
  const provider = connected.find((candidate) => candidate.id === providerId);
  const model = findCatalogModel(provider, builtinSelection.model, builtinSelection.agentKind, { exact: true });
  // Payment admission is not evidence that a saved model has been removed.
  // Preserve the local guard's error class so restoration cannot replace it.
  if (model?.availability === 'requires_payment') {
    throwIpcError('INVALID_PARAMS', `Scheduled model "${builtinSelection.model}" requires payment from provider "${providerId ?? 'default'}"`);
  }
  // A legacy implicit choice has no source to classify until a catalog contains it.
  // Unknown eligible catalogs cannot prove removal; never guess a replacement source.
  const candidates = provider ? [provider] : providerId === null ? connected : [];
  if (!model && candidates.some(candidate => candidate.subscriptionReadUnavailable && !candidate.removed)) {
    throwIpcError('MODEL_CATALOG_UNCONFIRMED', 'The model list could not be confirmed. The saved model selection has been kept.');
  }
  if (!provider || !model ||
    !isModelSelectableForNewRoute(model, { userProvider: provider.source === 'user' })) {
    throwIpcError('MODEL_SELECTION_UNAVAILABLE', `Scheduled model "${builtinSelection.model}" is unavailable from provider "${providerId ?? 'default'}"`);
  }
  return {
    ...builtinSelection,
    providerId,
    effort: resolveCompatibleSessionRuntimeEffort(model, builtinSelection.effort),
    fastMode: model.supportsFastMode === true && (builtinSelection.fastMode !== 'ultrafast' || (builtinSelection.agentKind === 'codex' && model.supportsUltrafastMode === true)) ? builtinSelection.fastMode : false,
  };
}

/** One read-only recovery attempt, shared with the provider's existing discovery flight.
 * Never change the saved route or replay a send; only resolve the same selection again.
 */
export async function resolveScheduledModelSelectionWithRefresh(
  selection: ScheduledModelSelection,
  deps: {
    readProviders: () => Promise<ProviderView[]>;
    refreshProvider: (providerId: string) => Promise<unknown>;
    assertCurrent: () => void;
  },
): Promise<BuiltinScheduledModelSelection> {
  if (selection.agentKind === 'acp') {
    throwIpcError('UNSUPPORTED_CAPABILITY', 'Plugin engines are not resolved through the built-in catalog');
  }
  const builtinSelection: BuiltinScheduledModelSelection = { ...selection, agentKind: selection.agentKind };
  let providers = await deps.readProviders();
  deps.assertCurrent();
  const providerId = scheduledModelProviderId(builtinSelection, providers);
  const candidates = connectedProvidersForAgent(providers, builtinSelection.agentKind).filter(provider =>
    (providerId === null || provider.id === providerId) && !provider.removed &&
    provider.subscriptionAccountPool === 'openai' &&
    !findCatalogModel(provider, builtinSelection.model, builtinSelection.agentKind, { exact: true }));
  if (candidates.length) {
    // The native discovery routine retains the last success and marks failed reads.
    // If recovery itself throws, re-read that state rather than treating it as removal.
    await Promise.all(candidates.map(async provider => {
      try { await deps.refreshProvider(provider.id); } catch { deps.assertCurrent(); }
    }));
    deps.assertCurrent();
    providers = await deps.readProviders();
    deps.assertCurrent();
  }
  return resolveScheduledModelSelection(builtinSelection, providers);
}

/** Resolve against the bound execution computer; the runner owns inactive-target recovery. */
export function createScheduledModelSelectionResolver(deps: {
  readRemoteProviders: (deviceId: string, agent: AgentKind, model: string, providerId: string | null) => Promise<ProviderView[]>;
  readSshCodexProviders: (hostId: string) => Promise<ProviderView[]>;
  resolveLocalSelection: (selection: BuiltinScheduledModelSelection) => Promise<ScheduledModelSelection>;
  resolvePluginEngineSelection?: (selection: ScheduledModelSelection) => Promise<ScheduledModelSelection>;
}) {
  return async (selection: ScheduledModelSelection, target?: ScheduledModelTarget | null): Promise<ScheduledModelSelection> => {
    if (selection.agentKind === 'acp') {
      if (selection.agentDeviceId) {
        throwIpcError('UNSUPPORTED_CAPABILITY', 'Plugin engines run on the automation host only');
      }
      if (!deps.resolvePluginEngineSelection) {
        throwIpcError('UNSUPPORTED_CAPABILITY', 'Plugin engines are not available here');
      }
      return deps.resolvePluginEngineSelection({ ...selection, agentDeviceId: null, fastMode: false });
    }
    const builtinSelection: BuiltinScheduledModelSelection = { ...selection, agentKind: selection.agentKind };
    // SSH Codex discovers native models on its host. A controller's catalog
    // cannot establish that a frozen remote choice is obsolete.
    if (target?.remoteHostId && builtinSelection.agentKind === 'codex') {
      return resolveScheduledModelSelection(builtinSelection, await deps.readSshCodexProviders(target.remoteHostId));
    }
    const agentDeviceId = builtinSelection.agentDeviceId === undefined
      ? target?.agentDeviceId : builtinSelection.agentDeviceId;
    if (agentDeviceId && !target?.remoteHostId) {
      const providers = await deps.readRemoteProviders(
        agentDeviceId, builtinSelection.agentKind, builtinSelection.model, builtinSelection.providerId,
      );
      return resolveScheduledModelSelection(builtinSelection, providers);
    }
    return deps.resolveLocalSelection(builtinSelection);
  };
}

/** Reuse the ordinary history handoff; never stage an automation intent on a busy task. */
export async function applyScheduledModelSelection(
  selection: ScheduledModelSelection,
  deps: {
    getTarget: () => Promise<ScheduledModelTarget | null>;
    isBusy: () => boolean;
    resolveSelection: (selection: ScheduledModelSelection, target?: ScheduledModelTarget | null) => Promise<ScheduledModelSelection>;
    switchHarness: (selection: ScheduledModelSelection) => Promise<{ engineReady: boolean; retryPending?: boolean }>;
    applyModel: (selection: ScheduledModelSelection) => Promise<void>;
  },
): Promise<ScheduledModelSelection> {
  const target = await deps.getTarget();
  // The runner restores ordinary archived targets before selection and owns
  // deleted/missing-target rebinding for persistent tasks.
  // Its replacement resolves at the schedule's saved location. Do not query the old
  // target's catalog: that device may be offline or its provider share revoked.
  if (!target || target.status === 'archived' || target.status === 'deleted') {
    return selection;
  }
  if (deps.isBusy()) throw new ScheduledModelSelectionBusyError('Scheduled model selection waits for the current turn');
  assertScheduledHarnessSupported(target, selection.agentKind, selection.agentDeviceId, selection.providerId);
  const resolved = await deps.resolveSelection({ ...selection,
    ...(selection.agentKind === 'acp'
      ? { agentDeviceId: null, fastMode: false }
      : selection.agentDeviceId === undefined && target.agentDeviceId !== undefined
        ? { agentDeviceId: target.agentDeviceId } : {}),
  }, target);
  const changesDevice = (target.agentDeviceId ?? null) !== (resolved.agentDeviceId ?? null);
  const changesPluginEngine = target.agentKind === 'acp' && resolved.agentKind === 'acp'
    && (target.providerId ?? null) !== (resolved.providerId ?? null);
  const needsSwitch = target.agentKind !== resolved.agentKind || changesDevice || changesPluginEngine;
  if (needsSwitch) {
    // The handoff treats an explicit location as a relocation request. Preserve
    // engine-only switching for execution-device Workers without relaxing that boundary.
    const { agentDeviceId: _location, ...harnessSelection } = resolved;
    const result = await deps.switchHarness(changesDevice ? resolved : harnessSelection);
    if (!result.engineReady || result.retryPending) throwIpcError('HARNESS_SWITCH_NOT_READY', 'Scheduled Harness switch did not become ready');
  }
  // performSessionAgentSwitch already persisted the new plugin-engine route and starts it lazily on send.
  if (!needsSwitch || resolved.agentKind !== 'acp') {
    await deps.applyModel(resolved);
  }
  return resolved;
}
