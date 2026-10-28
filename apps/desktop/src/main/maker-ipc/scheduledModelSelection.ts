import type { AgentKind, Effort } from '@cindy/maker-core';
import { connectedProvidersForAgent, effectiveSourceIdForModel, findCatalogModel, isModelSelectableForNewRoute, type ProviderView } from '@cindy/model-providers';
import { resolveCompatibleSessionRuntimeEffort } from './sessionRuntimeControl';
import { parseScheduledModelBaseline, type ScheduledModelBaseline } from '../../shared/scheduledModelBaseline';
import { throwIpcError } from '../utils/ipcValidate';
import { isIpcError } from '../../shared/ipc-errors';

/** A saved automation choice, applied only while its target's send lock is held. */
export interface ScheduledModelSelection {
  agentKind: AgentKind;
  /** Undefined inherits a bound task; null explicitly selects the task host. */
  agentDeviceId?: string | null;
  model: string;
  providerId: string | null;
  effort: Effort | null;
  fastMode: boolean | 'ultrafast';
}

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
  write: (sessionId: string, baseline: ScheduledModelBaseline | null, profileRevision?: string | null, expectedBaseline?: string | null) => Promise<void | boolean>;
  isBusy: (sessionId: string) => boolean;
  apply: (sessionId: string, profile: ScheduledModelSelection) => Promise<void>;
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
      try {
        await deps.apply(sessionId, baseline);
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
      const written = await deps.write(sessionId, null, row!.profileRevision, row!.baseline);
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

interface ScheduledModelTarget {
  agentKind: AgentKind;
  agentDeviceId?: string | null;
  status: string;
  remoteHostId?: string | null;
  orcaRole?: string | null;
}

/** Enforce the existing runtime boundary at save time as well as dispatch. */
export function assertScheduledHarnessSupported(
  target: ScheduledModelTarget | null,
  agentKind: AgentKind | undefined,
  agentDeviceId?: string | null,
): void {
  if (target?.status !== 'active') return;
  const changesHarness = agentKind && target.agentKind !== agentKind;
  const changesDevice = agentDeviceId !== undefined && agentDeviceId !== (target.agentDeviceId ?? null);
  if (!changesHarness && !changesDevice) return;
  // Ordinary Orca Lead/Worker use the existing handoff for both axes, including
  // restoration before the next manual send. SSH still cannot change either.
  if (target.remoteHostId) {
    throwIpcError('SSH_HARNESS_SWITCH_UNSUPPORTED', 'SSH automation targets must keep their current Harness');
  }
}

/** Saved selections may outlive catalog effort/Fast support; resolve the actual route first. */
export function resolveScheduledModelSelection(
  selection: ScheduledModelSelection,
  providers: ProviderView[],
): ScheduledModelSelection {
  const providerId = selection.providerId ??
    effectiveSourceIdForModel(providers, null, selection.model, selection.agentKind);
  const provider = connectedProvidersForAgent(providers, selection.agentKind)
    .find((candidate) => candidate.id === providerId);
  const model = findCatalogModel(provider, selection.model, selection.agentKind, { exact: true });
  if (!provider || !model ||
    !isModelSelectableForNewRoute(model, { userProvider: provider.source === 'user' })) {
    throwIpcError('MODEL_SELECTION_UNAVAILABLE', `Scheduled model "${selection.model}" is unavailable from provider "${providerId ?? 'default'}"`);
  }
  return {
    ...selection,
    providerId,
    effort: resolveCompatibleSessionRuntimeEffort(model, selection.effort),
    fastMode: model.supportsFastMode === true && (selection.fastMode !== 'ultrafast' || (selection.agentKind === 'codex' && model.supportsUltrafastMode === true)) ? selection.fastMode : false,
  };
}

/** Resolve against the bound execution computer; the runner owns inactive-target recovery. */
export function createScheduledModelSelectionResolver(deps: {
  readRemoteProviders: (deviceId: string, agent: AgentKind, model: string, providerId: string | null) => Promise<ProviderView[]>;
  readSshCodexProviders: (hostId: string) => Promise<ProviderView[]>;
  resolveLocalSelection: (selection: ScheduledModelSelection) => Promise<ScheduledModelSelection>;
}) {
  return async (selection: ScheduledModelSelection, target?: ScheduledModelTarget | null): Promise<ScheduledModelSelection> => {
    // SSH Codex discovers native models on its host. A controller's catalog
    // cannot establish that a frozen remote choice is obsolete.
    if (target?.remoteHostId && selection.agentKind === 'codex') {
      return resolveScheduledModelSelection(selection, await deps.readSshCodexProviders(target.remoteHostId));
    }
    const agentDeviceId = selection.agentDeviceId === undefined
      ? target?.agentDeviceId : selection.agentDeviceId;
    if (agentDeviceId && !target?.remoteHostId) {
      const providers = await deps.readRemoteProviders(
        agentDeviceId, selection.agentKind, selection.model, selection.providerId,
      );
      return resolveScheduledModelSelection(selection, providers);
    }
    return deps.resolveLocalSelection(selection);
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
  assertScheduledHarnessSupported(target, selection.agentKind, selection.agentDeviceId);
  const resolved = await deps.resolveSelection({ ...selection,
    ...(selection.agentDeviceId === undefined && target.agentDeviceId !== undefined
      ? { agentDeviceId: target.agentDeviceId } : {}),
  }, target);
  const changesDevice = (target.agentDeviceId ?? null) !== (resolved.agentDeviceId ?? null);
  if (target.agentKind !== resolved.agentKind || changesDevice) {
    // The handoff treats an explicit location as a relocation request. Preserve
    // engine-only switching for execution-device Workers without relaxing that boundary.
    const { agentDeviceId: _location, ...harnessSelection } = resolved;
    const result = await deps.switchHarness(changesDevice ? resolved : harnessSelection);
    if (!result.engineReady || result.retryPending) throwIpcError('HARNESS_SWITCH_NOT_READY', 'Scheduled Harness switch did not become ready');
  }
  await deps.applyModel(resolved);
  return resolved;
}
