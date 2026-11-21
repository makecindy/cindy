/**
 * The pending credential switch service of the desktop (register.ts): its assembly, with the route
 * persistence a switch ends with (persistRoute), and the Pi transaction a pending Pi switch applies
 * through (applyPiPendingSelection). Moved verbatim out of register.ts so the Node Host registers,
 * applies and persists a pending credential switch the same way; register.ts binds the ports.
 *
 * - createPendingCredentialSwitchService is called where register.ts constructed the service.
 *   persistRoute reads the service as pendingCredentialSwitchHolder: register.ts assigned it the
 *   statement after construction, once, and persistRoute only runs in later callbacks; here the
 *   factory's own holder is assigned the same way before it returns.
 * - applyPiPending stays late-bound: the service is constructed before handleSetModel exists, so the
 *   applyPiPendingSelection port is a function register.ts reads at call time, and
 *   createApplyPiPendingSelection is called where register.ts assigned it, after handleSetModel.
 * - agentInputCoordinatorHolder comes in by value: register.ts assigned it once, before this
 *   assembly (a guard test keeps that order).
 */
import { effectiveSourceIdForModel, findCatalogModel } from '@cindy/model-providers';
import { and, eq } from 'drizzle-orm';
import { dbToMakerAgentKind, makerToDbAgentKind, type DbEngineKind } from '../../shared/agentKindConversion.js';
import { createDbTransportError, DB_TRANSPORT_NOT_SENT, DB_TRANSPORT_OUTCOME_UNKNOWN } from '../localDb/client/DbTransport.js';
import { getCurrentDbClientSnapshot, getDbClient } from '../localDb/client/current.js';
import { persistableSessionEffort } from '../localDb/mapper.js';
import { sessions } from '../localDb/schema.js';
import { getActiveCatalog } from '../maker-host/active-catalog.js';
import { setSessionProvider } from '../maker-host/session-provider-store.js';
import { setSessionEffort, setSessionFastMode } from '../maker-host/session-effort-store.js';
import type { Logger } from '../logger.js';
import type { AgentInputCoordinator } from './agent-input-coordinator.desktop.js';
import { MAKER_PUSH } from './channels.js';
import { lookupVerifiedContextWindow } from './contextOverflowRollover.js';
import {
  CredentialRouteNotCommittedError,
  CredentialSettlementDeferredError,
  PendingCredentialSwitchService,
  type PendingCredentialSwitchDeps,
} from './pendingCredentialSwitch.js';
import { readCredentialTaskSettings, readEffectiveCredentialSettings } from './pendingCredentialSwitchAccess.js';
import { isSupportedRuntimeEffort } from './runtimeSelectionAxes.js';
import { withSendToSessionLock } from './sendToSessionLock.js';
import {
  projectSessionRuntimeControl, recordUserSessionRuntimeMutation, resolveSessionRuntimeAxes,
  sessionRuntimeControlOwnerEpochMatches,
} from './sessionRuntimeControl.js';
import type { createHandleSetModel } from './sessionRuntimeSelectionApply.js';

export interface PendingCredentialSwitchAssemblyPorts {
  settlementPermit?: PendingCredentialSwitchDeps['settlementPermit'];
  maker: PendingCredentialSwitchDeps['maker'];
  isSessionInTurn: (sessionId: string) => boolean;
  /** Read at call time: register.ts assigns it after this assembly. */
  applyPiPendingSelection: NonNullable<PendingCredentialSwitchDeps['applyPiPending']>;
  broadcastToAllWindows: (channel: string, payload: unknown) => void;
  inputCoordinator: Pick<AgentInputCoordinator, 'wakeSession'>;
  resolveLenientSessionRoute: typeof import('../maker-host/model-route-guard-live.js').resolveLenientSessionRoute;
  getSessionDbAgentKind: (sessionId: string) => DbEngineKind | null;
  getDesktopProviderService: () => Pick<ReturnType<typeof import('../maker-host/createDesktopProviderService.js').getDesktopProviderService>, 'listProviders'>;
  resolveConfiguredContextWindow: typeof import('../maker-host/model-context-settings.js').resolveConfiguredContextWindow;
  agentInputCoordinatorHolder: Pick<AgentInputCoordinator, 'refreshQueuedRoute'> | null;
  broadcastSessionPatched: typeof import('../localDb/ipc/sessions.js').broadcastSessionPatched;
  log: Logger;
}

/** register.ts's pendingCredentialSwitchService, as register.ts constructed it. */
export function createPendingCredentialSwitchService(ports: PendingCredentialSwitchAssemblyPorts): PendingCredentialSwitchService {
  const {
    maker, isSessionInTurn, applyPiPendingSelection, broadcastToAllWindows, inputCoordinator,
    resolveLenientSessionRoute, getSessionDbAgentKind, getDesktopProviderService, resolveConfiguredContextWindow,
    agentInputCoordinatorHolder, broadcastSessionPatched, log,
  } = ports;
  let pendingCredentialSwitchHolder: PendingCredentialSwitchService | null = null;

  const pendingCredentialSwitchService = new PendingCredentialSwitchService({
    maker,
    settlementPermit: ports.settlementPermit,
    isSessionInTurn,
    isPiOwnerCurrent: sessionRuntimeControlOwnerEpochMatches,
    withPiSessionLock: withSendToSessionLock,
    withDeferredSelectionLock: withSendToSessionLock,
    applyPiPending: (sessionId, target, resolved, isCurrent) =>
      applyPiPendingSelection(sessionId, target, resolved, isCurrent),
    broadcastFailed: (payload) => {
      broadcastToAllWindows(MAKER_PUSH.SESSION_CREDENTIAL_SWITCH_FAILED, payload);
    },
    broadcastApplied: (payload) => {
      broadcastToAllWindows(MAKER_PUSH.SESSION_CREDENTIAL_SWITCH_APPLIED, payload);
    },
    onDeferredSelectionCleared: (sessionId, settings) => {
      const patch: Record<string, unknown> = { agentSwitchIntent: null };
      if (settings) {
        const { model, providerId, effort, fastMode } = settings;
        agentInputCoordinatorHolder?.refreshQueuedRoute(sessionId, {
          model, providerId, effort: isSupportedRuntimeEffort(effort) ? effort : undefined, fastMode,
        });
        Object.assign(patch, { model, providerId, effort, fastMode });
      }
      broadcastSessionPatched(sessionId, patch);
    },
    readDeferredFailure: async (sessionId, target) => {
      const state = target.deferredState;
      if (!state) return {};
      const db = getCurrentDbClientSnapshot();
      if (!db || db.userId !== state.db.userId) return { scopeChanged: true };
      try {
        const row = await readCredentialTaskSettings(db.client, sessionId);
        if (db !== getCurrentDbClientSnapshot()) return { scopeChanged: true };
        if (!row || row.status !== 'active' || row.createdAt !== state.createdAt) return { taskRetired: true };
        const effective = readEffectiveCredentialSettings(sessionId, row);
        return {
          settings: row,
          retained: db === state.db && row.model === state.before.model && row.providerId === state.before.providerId &&
            row.effort === state.before.effort && row.fastMode === state.before.fastMode &&
            effective.providerId === state.effectiveBefore.providerId &&
            effective.effort === state.effectiveBefore.effort &&
            effective.fastMode === state.effectiveBefore.fastMode,
        };
      } catch (error) {
        if (db !== getCurrentDbClientSnapshot()) return { scopeChanged: true };
        log.warn('deferred credential failure settings could not be read', { sessionId, error: String(error) });
        return {};
      }
    },
    onApplied: (sessionId) => {
      inputCoordinator.wakeSession(sessionId, 'pending-credential-switch-applied');
    },
    // 停用轴:deferred 切换收口前重裁决(SET_MODEL 时刻裁决过,但生效可能在数分钟
    // 后,期间目标可能被停用;PR #744 review 第七轮,第十四轮换宽松降级形态 ——
    // 目标全停时连模型一起换到启用兜底)。
    resolveRoute: resolveLenientSessionRoute,
    persistRoute: async (sessionId, route) => {
      const target = pendingCredentialSwitchHolder?.get(sessionId);
      const staged = target?.deferredSelection;
      const ownerEpoch = target?.ownerEpoch;
      const state = target?.deferredState;
      const db = getCurrentDbClientSnapshot();
      const assertPendingOwner = () => {
        if ((staged && (pendingCredentialSwitchHolder?.get(sessionId) !== target || db !== getCurrentDbClientSnapshot() ||
            (state && db?.userId !== state.db.userId))) ||
            (ports.settlementPermit && (!target || pendingCredentialSwitchHolder?.get(sessionId) !== target ||
              !ports.settlementPermit.allows(sessionId, target)))) {
          throw new CredentialSettlementDeferredError('credential settlement deferred');
        }
        if (ownerEpoch && !sessionRuntimeControlOwnerEpochMatches(ownerEpoch)) {
          throw new CredentialSettlementDeferredError('pending model switch account changed');
        }
      };
      const { pendingDb, desiredRow, where, finalModel, finalEffort, finalFastMode, patch } = await (async () => {
        assertPendingOwner();
        const pendingDb = db?.client ?? getDbClient();
        const agentKind = staged ? makerToDbAgentKind(staged.agentKind) : getSessionDbAgentKind(sessionId);
        if (agentKind === 'acp') throw new Error('Plugin engines manage their own credentials');
        const desiredRow = await readCredentialTaskSettings(pendingDb, sessionId);
        assertPendingOwner();
        const finalModel = route.model ?? desiredRow?.model ?? null;
        if (staged && (!desiredRow || desiredRow.status !== 'active' || desiredRow.createdAt !== state?.createdAt)) {
          throw new CredentialRouteNotCommittedError('pending model switch no longer has its active task');
        }
        const previousRoute = target?.previousRoute;
        const restoringPreviousRoute =
          !!route.model &&
          route.model === previousRoute?.model &&
          route.providerId === previousRoute.providerId;
        let finalEffort = restoringPreviousRoute && route.effort && isSupportedRuntimeEffort(route.effort)
          ? route.effort
          : isSupportedRuntimeEffort(desiredRow?.effort)
            ? desiredRow.effort
            : !desiredRow && route.effort && isSupportedRuntimeEffort(route.effort)
              ? route.effort
              : null;
        let finalFastMode = restoringPreviousRoute && route.fastMode !== undefined
          ? route.fastMode
          : desiredRow
            ? desiredRow.fastMode ?? false
            : route.fastMode ?? false;
        const effortEdited = !!state && (state.written.effort || desiredRow?.effort !== state.before.effort);
        const fastEdited = !!state && (state.written.fastMode !== undefined || desiredRow?.fastMode !== state.before.fastMode);
        if (staged && (staged.explicitAxes?.effort ?? true) && !effortEdited) {
          finalEffort = isSupportedRuntimeEffort(staged.effort) ? staged.effort : null;
        }
        if (staged && (staged.explicitAxes?.fastMode ?? true) && !fastEdited) finalFastMode = staged.fastMode;
        if (agentKind && finalModel) {
          const runtimeAgentKind = dbToMakerAgentKind(agentKind);
          const providers = await getDesktopProviderService().listProviders({
            allowSideEffects: false,
            catalog: getActiveCatalog(),
          });
          const finalProviderId = route.providerId ?? effectiveSourceIdForModel(
            providers,
            null,
            finalModel,
            runtimeAgentKind,
          );
          const finalProvider = providers.find((provider) => provider.id === finalProviderId);
          const catalogModel = findCatalogModel(finalProvider, finalModel, runtimeAgentKind, {
            exact: true,
          });
          if (catalogModel) {
            const axes = resolveSessionRuntimeAxes({
              model: catalogModel,
              effort: finalEffort,
              fastMode: finalFastMode,
              effortExplicit: false,
              fastExplicit: false,
            });
            if (axes.ok) {
              if ((effortEdited && axes.effort !== finalEffort) || (fastEdited && axes.fastMode !== finalFastMode)) {
                throw new CredentialRouteNotCommittedError('route cannot honour the latest runtime axis selection');
              }
              finalEffort = axes.effort;
              finalFastMode = axes.fastMode;
            }
          }
        }
        const patch: Record<string, unknown> = {
          providerId: route.providerId,
          fastMode: finalFastMode,
          ...(staged?.clearScheduledBaseline ? { scheduledModelBaseline: null } : {}),
        };
        // sessions.effort is NOT NULL. A target model without effort levels resolves to null: keep the
        // column's last value, as persistSessionFieldsWith does (persistableSessionEffort). Writing null
        // failed the write, so the switch never landed and the task's queue stayed gated.
        const persistableEffort = persistableSessionEffort(finalEffort);
        if (persistableEffort !== undefined) patch.effort = persistableEffort;
        if (route.model) patch.model = route.model;
        if (route.model && agentKind) {
          const verifiedWindow = lookupVerifiedContextWindow(
            (resolvedAgentKind, modelId, pid) =>
              resolveConfiguredContextWindow(
                getActiveCatalog(),
                dbToMakerAgentKind(resolvedAgentKind || agentKind),
                pid,
                modelId,
              ),
            route.model,
            route.providerId ?? null,
            dbToMakerAgentKind(agentKind),
          );
          if (verifiedWindow) patch.contextWindow = verifiedWindow;
        }
        assertPendingOwner();
        const where = state
          ? and(eq(sessions.id, sessionId), eq(sessions.createdAt, state.createdAt), eq(sessions.status, 'active'))
          : eq(sessions.id, sessionId);
        return { pendingDb, desiredRow, where, finalModel, finalEffort, finalFastMode, patch };
      })().catch(error => {
        if (!staged || error instanceof CredentialRouteNotCommittedError || error instanceof CredentialSettlementDeferredError) {
          throw error;
        }
        throw new CredentialRouteNotCommittedError('credential route preparation failed before the write', { cause: error });
      });
      assertPendingOwner();
      // Host holds the SQLite handle in-process. Do not yield after the final permit check.
      try {
        const update = pendingDb.drizzle.update(sessions).set(patch).where(where);
        const result = ports.settlementPermit ? update.run() : await update.run();
        if (staged && result.changes === 0) throw new CredentialRouteNotCommittedError('credential route did not update its task');
      } catch (error) {
        if (!staged || error instanceof CredentialRouteNotCommittedError) throw error;
        const code = (error as { code?: unknown } | null)?.code;
        if (code === DB_TRANSPORT_NOT_SENT) {
          throw new CredentialRouteNotCommittedError('credential route write was not sent', { cause: error });
        }
        if (desiredRow && typeof code === 'string' && code.startsWith('SQLITE_CONSTRAINT')) {
          // A trigger may use FAIL instead of ABORT. Verify every column this
          // statement could change before treating the SQLite refusal as a rollback.
          const readback = await readCredentialTaskSettings(pendingDb, sessionId);
          assertPendingOwner();
          if (readback && Object.entries(desiredRow).every(([key, value]) =>
            readback[key as keyof typeof readback] === value)) {
            throw new CredentialRouteNotCommittedError('SQLite rejected the credential route update', { cause: error });
          }
        }
        throw error;
      }
      try {
        assertPendingOwner();
      } catch (error) {
        // The write already returned. A lost owner or connection cannot prove that the old route remains.
        if (staged) throw createDbTransportError(DB_TRANSPORT_OUTCOME_UNKNOWN, 'credential route receipt is no longer current', error);
        throw error;
      }
      if (staged || ports.settlementPermit) setSessionProvider(sessionId, route.providerId);
      setSessionEffort(sessionId, finalEffort);
      setSessionFastMode(sessionId, finalFastMode);
      if (staged && finalModel) {
        recordUserSessionRuntimeMutation(sessionId);
        Object.assign(patch, projectSessionRuntimeControl(sessionId, {
          agentKind: staged.agentKind,
          model: finalModel,
          providerId: route.providerId,
          effort: finalEffort,
          fastMode: finalFastMode,
        }));
      }
      // A downstream queue or client observer cannot turn a committed write
      // into a persistence failure or yield the "still using old settings" notice.
      try {
        if (finalModel) {
          agentInputCoordinatorHolder?.refreshQueuedRoute(sessionId, {
            model: finalModel,
            providerId: route.providerId,
            effort: finalEffort ?? undefined,
            fastMode: finalFastMode,
          });
        }
        broadcastSessionPatched(sessionId, patch);
        if (staged?.onCommitted) await staged.onCommitted();
      } catch (error) {
        if (!staged) throw error;
        log.warn('committed credential switch projection delivery failed', { sessionId, error: String(error) });
      }
    },
    logger: log,
  });
  pendingCredentialSwitchHolder = pendingCredentialSwitchService;
  return pendingCredentialSwitchService;
}

/** register.ts's applyPiPendingSelection, as register.ts assigned it (after handleSetModel). */
export function createApplyPiPendingSelection(ports: { handleSetModel: ReturnType<typeof createHandleSetModel> }) {
  const { handleSetModel } = ports;
  const applyPiPendingSelection: NonNullable<PendingCredentialSwitchDeps['applyPiPending']> = async (sessionId, target, resolved, isCurrent) => {
    const assertPendingCurrent = () => {
      if (!isCurrent() || !target.ownerEpoch ||
          !sessionRuntimeControlOwnerEpochMatches(target.ownerEpoch)) {
        throw new Error('Pi pending model switch was superseded or its account changed');
      }
    };
    assertPendingCurrent();
    const result = await handleSetModel(sessionId, resolved.model, resolved.providerId,
      undefined, undefined, {
        source: target.selectionSource ?? 'user', applyingUserSelectionOnSend: true,
        applyingPiCredentialPending: true, refreshPiConfiguration: true,
        ...(target.previousRoute ? { previousPiRoute: target.previousRoute } : {}),
        assertSelectionCurrent: assertPendingCurrent,
      });
    if (result.superseded) throw new Error('Pi pending model switch was superseded');
    if (result.contextWindowConfirmationRequired) {
      throw new Error('Pi model switch needs confirmation for its smaller context window');
    }
    return result.deferred ? 'deferred' : 'applied';
  };
  return applyPiPendingSelection;
}

/** register.ts's reader of a task's pending switch for the proxy's routing (setPendingCredentialSwitchReader). */
export function createPendingCredentialSwitchRouteReader(pendingCredentialSwitchService: PendingCredentialSwitchService) {
  return (sessionId: string) => {
    const pending = pendingCredentialSwitchService.get(sessionId);
    return pending
      ? {
          model: pending.model,
          providerId: pending.providerId,
          ...(pending.previousRoute?.model ? { previousModel: pending.previousRoute.model } : {}),
        }
      : undefined;
  };
}
