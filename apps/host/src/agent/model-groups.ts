import { randomUUID } from 'node:crypto';
import { and, asc, eq } from 'drizzle-orm';
import type { ProviderView } from '@cindy/model-providers';
import { dbToMakerEngineKind, makerToDbEngineKind } from '../../../desktop/src/shared/agentKindConversion.js';
import {
  modelGroupCandidateKey,
  type ModelGroupSessionBindingView,
} from '../../../desktop/src/shared/modelGroups.js';
import type { ModelPricingCatalog } from '../../../desktop/src/shared/regionalMoney.js';
import { activeOwnerScopeKey } from '../../../desktop/src/main/appSessionState.js';
import {
  isDeviceLinkInvoke,
  readDeviceLinkModelSelectionOrigin,
  runOutsideDeviceLinkInvokeContext,
} from '../../../desktop/src/main/device-link/invoke-context.js';
import { createMainI18n } from '../../../desktop/src/main/i18n.js';
import { getDbClient } from '../../../desktop/src/main/localDb/client/current.js';
import { messages, sessions } from '../../../desktop/src/main/localDb/schema.js';
import { getSessionRowSnapshot, getSessionRowSnapshotStrict } from '../../../desktop/src/main/localDb/sessionDispatchSnapshot.js';
import { createLogger } from '../../../desktop/src/main/logger.js';
import {
  recordFailedSessionRuntimeFallbackCandidate,
  type SessionRuntimeProfile,
} from '../../../desktop/src/main/maker-ipc/sessionRuntimeControl.js';
import type { ModelGroupRecovery } from '../../../desktop/src/main/maker-ipc/sessionRuntimeFallback.js';
import type { RunModelGroupBeforeSendSessionRow } from '../../../desktop/src/main/model-groups/applyTurnRouting.js';
import {
  createModelGroupHandlers,
  type ModelGroupHandlersPorts,
} from '../../../desktop/src/main/model-groups/handlersCore.js';
import type { ModelGroupRouteNotePorts } from '../../../desktop/src/main/model-groups/routeNote.js';
import { createModelGroupRuntime } from '../../../desktop/src/main/model-groups/runtimeCore.js';
import {
  bindModelGroupSession,
  peekModelGroupSessionBinding,
  projectModelGroupSessionBinding,
  readModelGroupBindingForDispatch,
  subscribeModelGroupSessionBindings,
} from '../../../desktop/src/main/model-groups/sessionBindings.js';
import { createModelGroupSessionStart } from '../../../desktop/src/main/model-groups/sessionStart.js';
import { registerModelGroupStartBridge } from '../../../desktop/src/main/model-groups/startBridge.js';
import { readModelGroupsConfigForSelected } from '../../../desktop/src/main/model-groups/store.js';
import {
  isModelGroupRecoverySource,
  type ModelGroupSwitchOfferSessionRow,
} from '../../../desktop/src/main/model-groups/switchOffer.js';
import type { ModelGroupTurnDecisionSwitch } from '../../../desktop/src/main/model-groups/turnRouting.js';
import { createAuxiliaryRouteRefs } from '../../../desktop/src/main/utility-model/auxiliaryRouteRefsCore.js';

const log = createLogger('host-model-groups');

export interface HostModelGroupsPorts {
  listProviderViews(): Promise<ProviderView[]>;
  listLocalAgents(): readonly string[];
  readPricing(): Promise<{ gateway: ModelPricingCatalog | null; reference: ModelPricingCatalog | null }>;
  createDbMessage(sessionId: string, body: Record<string, unknown>): Promise<unknown>;
  readPendingSessionTarget?: ModelGroupHandlersPorts['readPendingSessionTarget'];
  markPendingModelGroupPick?: ModelGroupHandlersPorts['markPendingModelGroupPick'];
  onBindingChanged?(sessionId: string): void;
}

function parseCreatedAtMs(value: unknown): number | null {
  const at = value instanceof Date
    ? value.getTime()
    : typeof value === 'number'
      ? value
      : typeof value === 'string'
        ? Date.parse(value)
        : Number.NaN;
  return Number.isFinite(at) ? at : null;
}

async function readUserMessageAt(sessionId: string, clientId: string): Promise<number | null> {
  const [row] = await getDbClient().drizzle.select({ createdAt: messages.createdAt }).from(messages)
    .where(and(eq(messages.sessionId, sessionId), eq(messages.clientId, clientId), eq(messages.role, 'user')))
    .limit(1);
  return parseCreatedAtMs(row?.createdAt);
}

/**
 * Node Host assembly of Smart Routing (`model-groups`), built over the exact same
 * pure-Node cores as Desktop (`runtimeCore`, `handlersCore`, `sessionStart`, `auxiliaryRouteRefsCore`).
 */
export function createHostModelGroups(ports: HostModelGroupsPorts) {
  const locale = () => Intl.DateTimeFormat().resolvedOptions().locale;
  const i18n = createMainI18n(() => [locale()]);

  async function readSwitchOfferSessionRow(sessionId: string): Promise<ModelGroupSwitchOfferSessionRow | null> {
    const [row] = await getDbClient().drizzle.select({
      source: sessions.source,
      agentKind: sessions.agentKind,
      providerId: sessions.providerId,
      model: sessions.model,
      fastMode: sessions.fastMode,
      agentDeviceId: sessions.agentDeviceId,
      remoteHostId: sessions.remoteHostId,
    }).from(sessions).where(eq(sessions.id, sessionId)).limit(1);
    if (!row) return null;
    return {
      source: row.source,
      agentKind: row.agentKind,
      providerId: row.providerId,
      model: row.model,
      agentDeviceId: row.agentDeviceId,
      remoteHostId: row.remoteHostId,
    };
  }

  async function readBeforeSendSessionRow(sessionId: string): Promise<RunModelGroupBeforeSendSessionRow | null> {
    const [row] = await getDbClient().drizzle.select({
      source: sessions.source,
      agentKind: sessions.agentKind,
      providerId: sessions.providerId,
      model: sessions.model,
      effort: sessions.effort,
      fastMode: sessions.fastMode,
      agentDeviceId: sessions.agentDeviceId,
      remoteHostId: sessions.remoteHostId,
      lastTurnEndedAt: sessions.lastTurnEndedAt,
      contextTokens: sessions.contextTokens,
      scheduledModelBaseline: sessions.scheduledModelBaseline,
    }).from(sessions).where(eq(sessions.id, sessionId)).limit(1);
    if (!row || row.scheduledModelBaseline) return null;
    return {
      source: row.source,
      agentKind: row.agentKind,
      providerId: row.providerId,
      model: row.model,
      effort: row.effort,
      fastMode: row.fastMode === 'ultrafast' ? 'ultrafast' : row.fastMode === true,
      agentDeviceId: row.agentDeviceId,
      remoteHostId: row.remoteHostId,
      lastTurnEndedAt: row.lastTurnEndedAt,
      contextTokens: row.contextTokens,
    };
  }

  const runtime = createModelGroupRuntime({
    scope: () => activeOwnerScopeKey(),
    localViews: () => ports.listProviderViews(),
    localAgents: () => ports.listLocalAgents(),
    harnessInstalled: async (agent, agentDeviceId) => {
      if (agentDeviceId) return false;
      const makerAgent = agent === 'cc' ? 'claude-code' : agent;
      return ports.listLocalAgents().includes(makerAgent);
    },
    quotaWindows: async () => new Map(),
    pricing: () => ports.readPricing(),
    readSession: readSwitchOfferSessionRow,
    isShared: () => false,
    hasGoal: async () => false,
  });

  const routeNotePorts: ModelGroupRouteNotePorts = {
    async sessionExists(sessionId) {
      return !!(await getSessionRowSnapshotStrict(sessionId));
    },
    async firstUserMessageAt(sessionId) {
      const [row] = await getDbClient().drizzle.select({ createdAt: messages.createdAt }).from(messages)
        .where(and(eq(messages.sessionId, sessionId), eq(messages.role, 'user')))
        .orderBy(asc(messages.createdAt)).limit(1);
      return parseCreatedAtMs(row?.createdAt);
    },
    async createNote(sessionId, row) {
      await ports.createDbMessage(sessionId, {
        clientId: row.clientId,
        role: 'assistant',
        content: '',
        agentMeta: { pluginModelRoute: row.note },
        ...(row.createdAt !== undefined ? { createdAt: row.createdAt } : {}),
      });
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };

  const handlers = createModelGroupHandlers({
    runtime: () => runtime,
    isDeviceLink: () => isDeviceLinkInvoke(),
    deviceLinkOrigin: () => readDeviceLinkModelSelectionOrigin(),
    readSessionTarget: (sessionId) => getSessionRowSnapshot(sessionId),
    readPendingSessionTarget: (sessionId) => ports.readPendingSessionTarget?.(sessionId) ?? null,
    markPendingModelGroupPick: (sessionId, pickedKey) => ports.markPendingModelGroupPick?.(sessionId, pickedKey),
    routeNotePorts,
  });

  const sessionStart = createModelGroupSessionStart({
    resolve: (request) => runtime.resolver.resolve(request),
    commit: (decisionId) => {
      try {
        runtime.resolver.commit(decisionId);
      } catch (error) {
        log.warn('model group start commit failed', { error: String(error) });
      }
    },
    bind: (sessionId, selection, pickedKey) => bindModelGroupSession(sessionId, selection, pickedKey),
    writeNote: (sessionId, note, { clientId, anchorClientId }) => {
      void (async () => {
        const userAt = await readUserMessageAt(sessionId, anchorClientId).catch(() => null);
        await ports.createDbMessage(sessionId, {
          clientId,
          role: 'assistant',
          content: '',
          agentMeta: { pluginModelRoute: note },
          ...(userAt !== null ? { createdAt: userAt + 1 } : {}),
        });
      })().catch((error: unknown) => log.warn('model group start note failed', { sessionId, error: String(error) }));
    },
    t: (key, values) => i18n.t(key as never, values as never) as string,
    locale,
    locationName: () => i18n.t('bots.cloud.unknownDevice' as never) as string,
    now: () => Date.now(),
    createToken: () => randomUUID(),
  });

  const auxRefs = createAuxiliaryRouteRefs({
    resolveLocalRoute: (request) => runtime.resolver.resolve(request),
  });

  registerModelGroupStartBridge({
    resolve: (request) => runtime.resolver.resolve(request),
    refresh: () => runtime.refreshAutoModelGroupRoutes({ waitRemote: false }),
    prepare: sessionStart.prepare,
    attach: sessionStart.attach,
    dispatched: sessionStart.dispatched,
  });

  const offBindingChanged = subscribeModelGroupSessionBindings((sessionId) => {
    ports.onBindingChanged?.(sessionId);
  });

  function projectBinding(
    sessionId: string,
    target: { agentKind?: string | null; providerId?: string | null; model?: string | null; agentDeviceId?: string | null },
  ): ModelGroupSessionBindingView | null {
    try {
      const binding = peekModelGroupSessionBinding(sessionId);
      if (!binding) return null;
      return projectModelGroupSessionBinding({
        binding,
        config: readModelGroupsConfigForSelected(),
        current: target,
        pending: ports.readPendingSessionTarget?.(sessionId) ?? null,
      });
    } catch {
      return null;
    }
  }

  async function readAutoSwitchMode(
    sessionId: string,
    createOpts?: { agentKind?: string | null; providerId?: string | null; model?: string | null },
  ): Promise<'enabled' | 'disabled' | null> {
    try {
      const row = await getSessionRowSnapshot(sessionId);
      if (!row || !isModelGroupRecoverySource(row.source)) return null;
      const binding = await readModelGroupBindingForDispatch(sessionId);
      if (!binding) return null;
      const projected = projectModelGroupSessionBinding({
        binding,
        config: readModelGroupsConfigForSelected(),
        current: {
          agentKind: row.agentKind ?? createOpts?.agentKind ?? null,
          providerId: row.providerId ?? createOpts?.providerId ?? null,
          model: row.model ?? createOpts?.model ?? null,
          agentDeviceId: row.agentDeviceId ?? null,
        },
        pending: ports.readPendingSessionTarget?.(sessionId) ?? null,
      });
      if (!projected) return null;
      return projected.autoSwitch ? 'enabled' : 'disabled';
    } catch {
      return null;
    }
  }

  async function readFallbackCandidate(
    sessionId: string,
    current: SessionRuntimeProfile,
    visited: readonly string[],
    recovery: ModelGroupRecovery,
    generation: number,
  ) {
    const row = await getSessionRowSnapshot(sessionId);
    const currentProviderId = current.providerId;
    if (!row || !isModelGroupRecoverySource(row.source) || !currentProviderId) return null;
    const binding = await readModelGroupBindingForDispatch(sessionId);
    if (!binding) return null;
    const excluded = new Set(visited.map((key) => key.replace(/^claude-code\u0000/, 'cc\u0000')));

    const offer = await runOutsideDeviceLinkInvokeContext(() => runtime.readModelGroupRecoveryOffer(sessionId, {
      visited: excluded,
      ...recovery,
      recordUnavailable: (candidate) => {
        if (candidate.agentKind === 'acp') return;
        recordFailedSessionRuntimeFallbackCandidate(sessionId, generation, {
          ...current,
          agentKind: dbToMakerEngineKind(candidate.agentKind),
          providerId: candidate.providerId,
          model: candidate.model,
          agentDeviceId: candidate.agentDeviceId ?? null,
        });
      },
      current: {
        agentKind: makerToDbEngineKind(current.agentKind),
        providerId: currentProviderId,
        model: current.model,
        agentDeviceId: current.agentDeviceId ?? null,
        effort: current.effort,
        fastMode: current.fastMode,
      },
    }));

    if (
      !offer
      || offer.agentDeviceId
      || offer.agentKind === 'acp'
      || (
        dbToMakerEngineKind(offer.agentKind) === current.agentKind
        && offer.providerId === current.providerId
        && offer.model === current.model
        && (offer.agentDeviceId ?? null) === (current.agentDeviceId ?? null)
      )
    ) {
      return { candidate: null };
    }

    return {
      candidate: {
        agentKind: dbToMakerEngineKind(offer.agentKind),
        model: offer.model,
        providerId: offer.providerId,
        agentDeviceId: null,
        effort: (offer.effort as SessionRuntimeProfile['effort']) ?? null,
        fastMode: offer.fastMode ?? false,
      },
      labels: { from: offer.fromLabel ?? current.model, to: `${offer.modelName} · ${offer.sourceName}` },
      bindCommittedRoute: (profile: SessionRuntimeProfile) => {
        if (profile.providerId) {
          bindModelGroupSession(sessionId, binding.selection, modelGroupCandidateKey({
            agentKind: makerToDbEngineKind(profile.agentKind),
            model: profile.model,
            providerId: profile.providerId,
            agentDeviceId: profile.agentDeviceId || undefined,
          }));
        }
      },
    };
  }

  function describeTurnSwitchCause(cause: ModelGroupTurnDecisionSwitch['cause']): string {
    if (cause === 'preflight-unavailable') return i18n.t('modelGroups.turnSwitch.preflightUnavailable' as never) as string;
    if (cause === 'image-input') return i18n.t('modelGroups.turnSwitch.imageInput' as never) as string;
    return i18n.t('modelGroups.turnSwitch.cacheExpired' as never) as string;
  }

  return {
    handlers,
    sessionStart,
    refresh: () => runtime.refreshAutoModelGroupRoutes({ waitRemote: false }),
    projectBinding,
    readAutoSwitchMode,
    readFallbackCandidate,
    readBeforeSendSessionRow,
    evaluateTurnRouting: runtime.evaluateTurnRouting,
    describeTurnSwitchCause,
    expandAuxiliaryRouteRef: auxRefs.expandAuxiliaryRouteRef,
    subagentRouteMembers: (routeId: string) =>
      auxRefs.localRouteCandidatesInPickOrder(routeId)
        .filter((candidate) => candidate.agentKind === 'cc')
        .map((candidate) => ({ providerId: candidate.providerId, model: candidate.model })),
    resetForOwner() {
      auxRefs.clear();
      runtime.dispose();
    },
    dispose() {
      offBindingChanged();
      registerModelGroupStartBridge(null);
      auxRefs.clear();
      runtime.dispose();
    },
  };
}

export type HostModelGroups = ReturnType<typeof createHostModelGroups>;
