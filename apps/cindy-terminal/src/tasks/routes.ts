import { createSameAgentModelSelection, createPendingPiModelSelection } from '@cindy/app-runtime/sessionModelSelectionAdapters';
import type { createTerminalModelSelection } from './model-selection.js';
import type { createSessionRuntimeControl } from '@cindy/app-runtime/sessionRuntimeControl';
import { modelSupportsFastMode, sourcesForModel } from '@cindy/model-providers';
import { createSessionProviderStore } from '@cindy/app-runtime/sessionProviderStore';
import { createRuntimeSetModel } from '@cindy/app-runtime/runtimeSetModel';
import { PendingCredentialSwitchService } from '@cindy/app-runtime/pendingCredentialSwitch';
import { createCredentialModeSwitch } from '@cindy/app-runtime/credentialModeSwitch';
import { createCodexProviderIdentity } from '@cindy/app-runtime/codexProviderIdentity';
import type { AppliedCodexProviderRoute } from '@cindy/app-runtime/codexProviderIdentity';
import { resolveLenientRoute } from '@cindy/model-providers/model-route-guard';
import { createSessionSendLocks } from '@cindy/app-runtime/sessionSendLocks';
import { randomUUID } from 'node:crypto';
import type { AgentKind, Logger, Session } from '@cindy/maker-core';
import type { ResolvedRoute } from '@cindy/model-providers';
import { shouldApplyExclusiveProviderReroute } from '@cindy/model-providers/model-route-guard';
import { dbToMakerAgentKind, makerToDbAgentKind } from '@cindy/maker-shared/agent-kind-conversion';
import {
  applyPendingAgentSwitchIfIdle, createPendingAgentSwitchRegistry, performSessionAgentSwitch,
  projectPendingAgentSwitchIntent, settleSystemRouteSwitchIntent, type AgentSwitchBoundaryContent, type MakerSessionAgentSwitchHandlerDeps,
} from '@cindy/im-runtime/sessionAgentSwitch';
import { buildImManualRouteOverrideRecord } from '@cindy/im-runtime/channelDefaultRoute';
import type { ImDefaultRouteHost } from '@cindy/im-runtime/channelDefaultRouteSync';
import type { TerminalModelConfig, ModelSelection } from '../models/config.js';
import type { TerminalTaskStorage, TerminalTaskMeta } from './storage.js';
import type { TerminalTaskContext } from './context.js';
import { TerminalTaskRecovery } from './recovery.js';
import type { ContextOverflowRolloverDeps, OverflowSourceMessage } from '@cindy/im-runtime/contextOverflowRollover';

type RouteRow = OverflowSourceMessage & { rowid: number };
type RoutePatch = Parameters<MakerSessionAgentSwitchHandlerDeps['applyAgentSwitchToDb']>[1];

/** One send/model mutation lane per persistent task. The shared switch state
 * machine decides when a choice applies; this adapter owns files and runtimes. */
export class TerminalTaskRoutes {
  private modelSelection?: ReturnType<typeof createTerminalModelSelection>;
  private runtimeControl?: ReturnType<typeof createSessionRuntimeControl>;
  connectModelSelection(service: ReturnType<typeof createTerminalModelSelection>, control: ReturnType<typeof createSessionRuntimeControl>) { this.modelSelection = service; this.runtimeControl = control; }
  applyRuntimeSelection: import('@cindy/app-runtime/sessionRuntimeSelectionTypes').ApplySessionRuntimeSelection = (...args) => {
    if (!this.modelSelection) throw new Error('Model selection service is not ready');
    return this.modelSelection.apply(...args);
  };
  setRuntimeAxis(channel: string, id: unknown, value: unknown) {
    if (!this.modelSelection) throw new Error('Model selection service is not ready');
    return this.modelSelection.setRuntimeAxis(channel, id, value);
  }
  configureModelContext(channel: string, args: unknown[]) {
    if (!this.modelSelection) throw new Error('Model selection service is not ready');
    return this.modelSelection.configureModelContext(channel, args);
  }
  readonly pending = createPendingAgentSwitchRegistry();
  restoreScheduledPreferences?: (id: string) => Promise<void>;
  clearScheduledPreference?: (id: string) => Promise<void>;
  readonly locks: ReturnType<typeof createSessionSendLocks>;
  readonly providers = createSessionProviderStore();
  readonly runtime: ReturnType<typeof createRuntimeSetModel>;
  readonly credentials: PendingCredentialSwitchService;
  readonly deps: MakerSessionAgentSwitchHandlerDeps;
  readonly recovery: TerminalTaskRecovery;
  constructor(private readonly host: {
    storage: TerminalTaskStorage; context: TerminalTaskContext; models: TerminalModelConfig; logger: Logger;
    assertCurrent(): void;
    appliedCodexRoutes(): readonly AppliedCodexProviderRoute[];
    listActiveSessions(): Session[];
    wakeSession(id: string): void;
    credentialApplied(payload: {sessionId: string; model: string; providerId: string | null}): void;
    credentialFailed(payload: {sessionId: string; reason: 'apply-failed' | 'rollback-failed'}): void;
    getSession(id: string): Session | undefined;
    closeSession(id: string): Promise<void>;
    bootstrap(id: string): Promise<void>;
    messages(id: string): Promise<RouteRow[]>;
    select(input: Record<string, unknown>): Promise<{ selection: ModelSelection; route: ResolvedRoute }>;
    withCloseSuppressed<T>(id: string, run: () => Promise<T>): Promise<T>;
    changed(id: string): Promise<void>;
    pendingChanged(id: string, intent: ReturnType<typeof projectPendingAgentSwitchIntent>): void;
    replay: ContextOverflowRolloverDeps['replayUserMessage'];
    hasExternalOwner(id: string): boolean;
    hasPendingInteraction(id: string): boolean;
    onRebuilt(id: string): void;
    getRecoveryAbortSignal(id: string): AbortSignal;
  }) {
    this.locks = createSessionSendLocks(host.logger);
    this.recovery = new TerminalTaskRecovery({ ...host, withLock: (id, run) => this.withLock(id, run) });
    const identity = createCodexProviderIdentity({ appliedRoutes: host.appliedCodexRoutes, allAppliedRoutes: host.appliedCodexRoutes });
    const credentialMode = createCredentialModeSwitch({ ...identity, getActiveCatalog: () => host.models.activeCatalog(),
      hasClaudeNativeLogin: () => !!host.models.nativeClaude?.usageAccount(), withRehydrateCloseSuppressed: host.withCloseSuppressed });
    const runtimeHost = { ...this.providers, ...credentialMode, withRehydrateCloseSuppressed: host.withCloseSuppressed };
    this.runtime = createRuntimeSetModel(runtimeHost);
    this.credentials = new PendingCredentialSwitchService({
      maker: { listActiveSessions: host.listActiveSessions, closeSession: host.closeSession },
      isSessionInTurn: id => host.getSession(id)?.isTurnRunning() === true || host.hasPendingInteraction(id),
      broadcastApplied: host.credentialApplied, broadcastFailed: host.credentialFailed, onApplied: host.wakeSession,
      withPiSessionLock: (id, run) => this.withLock(id, run),
      isPiOwnerCurrent: epoch => this.runtimeControl?.sessionRuntimeControlOwnerEpochMatches(epoch) === true,
      applyPiPending: (...args) => {
        if (!this.modelSelection || !this.runtimeControl) throw new Error('Model selection service is not ready');
        return createPendingPiModelSelection(this.modelSelection.handle, this.runtimeControl.sessionRuntimeControlOwnerEpochMatches)(...args);
      },
      resolveRoute: async (kind, model, providerId, options) => {
        host.assertCurrent(); const views = await host.models.views(); host.assertCurrent();
        const route: {model?: string; providerId: string | null; degraded: boolean; effort?: string; fastMode?: boolean | 'ultrafast'} = resolveLenientRoute(views, kind, model, providerId);
        if (options?.desiredFastMode && route.model && (route.model !== model || route.providerId !== providerId)) {
          const provider = route.providerId ? views.find(row => row.id === route.providerId) : sourcesForModel(views, route.model, kind)[0];
          route.fastMode = provider && modelSupportsFastMode(provider, route.model, kind)
            && (options.desiredFastMode !== 'ultrafast' || kind === 'codex' && provider.models.codex?.some(row => row.id === route.model && row.supportsUltrafastMode)) ? options.desiredFastMode : false;
        }
        return route;
      },
      persistRoute: (...args) => {
        if (!this.modelSelection) throw new Error('Model selection service is not ready');
        return this.modelSelection.persistCredentialRoute(...args);
      }, logger: host.logger,
    }, runtimeHost);
    const current = async (id: string) => { host.assertCurrent(); const row = await host.storage.get(id); host.assertCurrent(); if (!row || row.deleted || row.archived) throw new Error('TASK_NOT_FOUND'); this.providers.hydrateSessionProvider(id, row.providerId ?? null); return row; };
    const resolve = async (id: string, kind: AgentKind, model: string, providerId: string | null | undefined, device?: string | null, effort?: string) => {
      const row = await current(id);
      const chosen = await host.select({ agentKind: kind, model, providerId: providerId === undefined && kind === row.agentKind ? row.providerId : providerId, agentDeviceId: device === undefined ? row.agentDeviceId : device, ...(effort ? { effort } : {}) });
      host.assertCurrent(); return chosen;
    };
    const metadata = async (id: string, patch: RoutePatch): Promise<Partial<TerminalTaskMeta>> => {
      const chosen = await resolve(id, dbToMakerAgentKind(patch.agentKind), patch.model, patch.providerId, patch.agentDeviceId, patch.effort);
      return { ...chosen.selection, sdkSessionId: patch.sdkSessionId ?? undefined,
        thinkingEnabled: patch.thinkingEnabled,
        ...(patch.agentDeviceId !== undefined ? { agentDeviceId: patch.agentDeviceId ?? undefined } : {}),
        ...(patch.fastMode !== undefined ? { fastMode: patch.fastMode } : {}) };
    };
    this.deps = {
      pendingSwitches: this.pending, log: host.logger,
      shouldApplyExclusiveProviderReroute: provider => shouldApplyExclusiveProviderReroute(provider, host.models.providerSources()),
      getSessionRow: async id => { const row = await current(id); return { ...row, agentKind: makerToDbAgentKind(row.agentKind), model: row.model, providerId: row.providerId ?? null, sdkSessionId: row.sdkSessionId ?? null, status: 'active', remoteHostId: row.remoteHostId ?? null, orcaRole: row.orcaRole ?? null, orcaRemoteLead: row.orcaRemoteLead ? JSON.stringify(row.orcaRemoteLead) : null }; },
      getLiveSession: host.getSession,
      closeSession: host.closeSession,
      withCloseSuppressed: host.withCloseSuppressed,
      withSessionLock: (id, run) => this.withLock(id, run),
      assertModelRouteUsable: async (kind, model, provider, id, device) => (await resolve(id!, kind, model, provider, device)).selection.providerId,
      assertAgentDeviceRouteUsable: async (device, kind, model, provider) => { await host.select({ agentDeviceId: device, agentKind: kind, model, providerId: provider }); host.assertCurrent(); },
      listMessagesForHandoff: async (id, after) => (await host.storage.runtime()).messages.listMessagesForAgentHandoff(id, null, after),
      findParkedEngineSession: async (id, kind) => (await host.storage.runtime()).messages.findParkedEngineSession(id, kind),
      applyAgentSwitchToDb: async (id, patch) => {
        const selected = await metadata(id, patch);
        host.assertCurrent();
        await (await host.storage.runtime()).agentSwitch.applyAgentSwitchToSessionRow(id, {
          ...patch, model: selected.model!, providerId: selected.providerId,
        });
        await host.changed(id);
      },
      setSessionProvider: (id, provider) => { host.assertCurrent(); this.providers.setSessionProvider(id, provider); },
      insertBoundaryMessage: async (id, boundary) => {
        host.assertCurrent();
        const clientId = `agent-switch:${randomUUID()}`;
        await (await host.storage.runtime()).messages.createMessage(id, { clientId, role: 'agent_switch', content: boundary });
        return clientId;
      },
      applyResumeFallbackAtomically: async (id, clientId, boundary) => {
        host.assertCurrent();
        await (await host.storage.runtime()).agentSwitch.applyAgentSwitchResumeFallbackAtomically(id, clientId, boundary);
        await host.changed(id);
      },
      setPendingHandoff: (id, text, generation) => host.context.handoff.set(id, text, generation),
      readPendingHandoffGeneration: id => host.context.handoff.readGeneration(id),
      bootstrapSwitchedSession: id => host.bootstrap(id),
      onPendingSwitchChanged: host.pendingChanged,
      onUserRouteSelectionLanded: async id => {
        await this.clearScheduledPreference?.(id);
        const row = await current(id);
        await host.storage.updateIf(id, row => !row.deleted, { imDefaultRoute: buildImManualRouteOverrideRecord({ agentKind: row.agentKind, model: row.model, providerId: row.providerId ?? null, agentDeviceId: row.agentDeviceId ?? null, effort: row.effort ?? null }) }, host.assertCurrent);
      },
      selectSameAgentModel: createSameAgentModelSelection((...args) => this.applyRuntimeSelection(...args)),
    };
  }
  clearProvider(id: string) { this.providers.clearSessionProvider(id); }
  provider(id: string) { return this.providers.getSessionProvider(id); }
  hydrateProvider(id: string, provider: string | null) { this.host.assertCurrent(); this.providers.setSessionProvider(id, provider); }
  intent(id: string) { return projectPendingAgentSwitchIntent(this.pending.get(id)); }
  pendingRoute: ImDefaultRouteHost['readPendingAgentSwitchRoute'] = id => {
    const intent = this.pending.get(id);
    return intent ? { agentKind: intent.targetAgentKind, model: intent.model, providerId: intent.providerId ?? null,
      agentDeviceId: intent.targetAgentDeviceId, effort: intent.effort ?? null, rev: this.pending.revision?.(id) } : undefined;
  };
  cancel(id: string) { this.host.assertCurrent(); this.credentials.clear(id); this.pending.clear(id); this.host.pendingChanged(id, null); }
  private idleForSystemRoute(id: string) {
    const live = this.host.getSession(id);
    return !live?.isTurnRunning() && !live?.listBackgroundTasks().length && !this.host.hasPendingInteraction(id);
  }
  /** Called with the task's send lane held. Follow configuration without
   * closing a runtime that still owns background work or an interaction. */
  applySystemUnderLock: ImDefaultRouteHost['applySessionRouteUnderSendLock'] = async (id, route) => {
    let staged = this.pending.get(id);
    try {
      if (route) {
        await performSessionAgentSwitch(this.deps, { sessionId: id, targetAgentKind: route.agentKind, model: route.model,
          providerId: route.providerId, agentDeviceId: route.agentDeviceId, effort: route.effort ?? undefined, fastMode: route.fastMode, configStaged: true });
        staged = this.pending.get(id);
      }
      if (!staged) return 'applied';
      if (!this.idleForSystemRoute(id)) return 'staged';
      await applyPendingAgentSwitchIfIdle(this.deps, id, { bootstrapAfterSwitch: true });
    } catch (error) {
      if (staged && this.pending.get(id) === staged) this.cancel(id);
      throw error;
    }
    const outcome = settleSystemRouteSwitchIntent({ stagedIntent: staged, remainingIntent: this.pending.get(id), sessionIdle: this.idleForSystemRoute(id) });
    if (outcome === 'failed') { this.cancel(id); throw new Error('TASK_DEFAULT_ROUTE_NOT_APPLIED'); }
    return outcome;
  };
  async acquire(id: string): Promise<() => void> {
    this.host.assertCurrent();
    const release = await this.locks.acquireSendToSessionLock(id);
    try { this.host.assertCurrent(); return release; }
    catch (error) { release(); throw error; }
  }
  isLocked(id: string) { return this.locks.hasSendToSessionLock(id); }
  withLock<T>(id: string, run: () => Promise<T>) {
    this.host.assertCurrent();
    return this.locks.withSendToSessionLock(id, async () => { this.host.assertCurrent(); return run(); });
  }
  select(params: Parameters<typeof performSessionAgentSwitch>[1]) {
    if (typeof params.sessionId !== 'string') return performSessionAgentSwitch(this.deps, params);
    return this.withLock(params.sessionId, () => performSessionAgentSwitch(this.deps, params));
  }
  selectModel(id: string, model: string, providerId: unknown, options: Record<string, unknown>, expectedRevision: unknown, guard: () => void) {
    return this.withLock(id, () => this.selectModelUnderLock(id, model, providerId, options, expectedRevision, guard));
  }
  async selectModelUnderLock(id: string, model: string, providerId: unknown, options: Record<string, unknown>, expectedRevision: unknown, guard: () => void) {
    guard();
    if (!this.modelSelection) throw new Error('Model selection service is not ready');
    const selection = Object.keys(options).length ? options : undefined;
    return this.modelSelection.handle(id, model, providerId, expectedRevision, selection, {source: 'user', sessionLockHeld: true, assertSelectionCurrent: guard});
  }
  async acquireForSend(id: string, synchronize?: () => Promise<boolean>, preserveScheduledModel = false): Promise<() => void> {
    const release = await this.acquire(id);
    try {
      const deferred = await synchronize?.();
      if (!deferred) {
        if (!preserveScheduledModel) await this.restoreScheduledPreferences?.(id);
        await applyPendingAgentSwitchIfIdle(this.deps, id);
      }
      this.host.assertCurrent();
      // The legacy Desktop switch helper retains a failed cross-engine intent.
      // A terminal send must report that state instead of using the old route.
      if (!deferred && this.pending.get(id)) throw new Error('TASK_MODEL_SWITCH_NOT_READY');
      await this.recovery.runtime.prepareUnhealthySession(id);
      return release;
    }
    catch (error) { release(); throw error; }
  }
}
