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
import { eq } from 'drizzle-orm';
import { dbToMakerAgentKind } from '../../shared/agentKindConversion.js';
import { getDbClient } from '../localDb/client/current.js';
import { persistableSessionEffort } from '../localDb/mapper.js';
import { sessions } from '../localDb/schema.js';
import { getActiveCatalog } from '../maker-host/active-catalog.js';
import { setSessionProvider } from '../maker-host/session-provider-store.js';
import { setSessionEffort, setSessionFastMode } from '../maker-host/session-effort-store.js';
import type { Logger } from '../logger.js';
import type { AgentInputCoordinator } from './agent-input-coordinator.desktop.js';
import { MAKER_PUSH } from './channels.js';
import { lookupVerifiedContextWindow } from './contextOverflowRollover.js';
import { PendingCredentialSwitchService, type PendingCredentialSwitchDeps } from './pendingCredentialSwitch.js';
import { isSupportedRuntimeEffort } from './runtimeSelectionAxes.js';
import { withSendToSessionLock } from './sendToSessionLock.js';
import { resolveSessionRuntimeAxes, sessionRuntimeControlOwnerEpochMatches } from './sessionRuntimeControl.js';
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
  getSessionDbAgentKind: (sessionId: string) => 'cc' | 'codex' | 'pi' | null;
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
    applyPiPending: (sessionId, target, resolved, isCurrent) =>
      applyPiPendingSelection(sessionId, target, resolved, isCurrent),
    broadcastFailed: (payload) => {
      broadcastToAllWindows(MAKER_PUSH.SESSION_CREDENTIAL_SWITCH_FAILED, payload);
    },
    broadcastApplied: (payload) => {
      broadcastToAllWindows(MAKER_PUSH.SESSION_CREDENTIAL_SWITCH_APPLIED, payload);
    },
    onApplied: (sessionId) => {
      inputCoordinator.wakeSession(sessionId, 'pending-credential-switch-applied');
    },
    // 停用轴:deferred 切换收口前重裁决(SET_MODEL 时刻裁决过,但生效可能在数分钟
    // 后,期间目标可能被停用;PR #744 review 第七轮,第十四轮换宽松降级形态 ——
    // 目标全停时连模型一起换到启用兜底)。
    resolveRoute: resolveLenientSessionRoute,
    // 裁决改道 / 清空显式来源 / 全停换模型时回写 DB + 广播 patch:renderer 在
    // deferred 接受时已按请求值落盘,不纠正则下一次懒 resume 按停用路由重建
    // (PR #744 review 第十、十四轮)。
    persistRoute: async (sessionId, route) => {
      const target = pendingCredentialSwitchHolder?.get(sessionId);
      const ownerEpoch = target?.ownerEpoch;
      const assertPendingOwner = () => {
        if (ports.settlementPermit && (!target || pendingCredentialSwitchHolder?.get(sessionId) !== target ||
            !ports.settlementPermit.allows(sessionId, target))) {
          throw new Error('credential settlement deferred');
        }
        if (ownerEpoch && !sessionRuntimeControlOwnerEpochMatches(ownerEpoch)) {
          throw new Error('pending model switch account changed');
        }
      };
      assertPendingOwner();
      const pendingDb = getDbClient();
      const agentKind = getSessionDbAgentKind(sessionId);
      const [desiredRow] = await pendingDb
        .drizzle.select({
          model: sessions.model,
          effort: sessions.effort,
          fastMode: sessions.fastMode,
        })
        .from(sessions)
        .where(eq(sessions.id, sessionId))
        .limit(1);
      assertPendingOwner();
      const finalModel = route.model ?? desiredRow?.model ?? null;
      const previousRoute = pendingCredentialSwitchHolder?.get(sessionId)?.previousRoute;
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
            finalEffort = axes.effort;
            finalFastMode = axes.fastMode;
          }
        }
      }
      const patch: Record<string, unknown> = {
        providerId: route.providerId,
        fastMode: finalFastMode,
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
      if (ports.settlementPermit) {
        // Host owns an in-process SQLite handle. Keep the last permit check, UPDATE
        // and provider mirror in the same synchronous turn.
        pendingDb.drizzle.update(sessions).set(patch).where(eq(sessions.id, sessionId)).run();
        setSessionProvider(sessionId, route.providerId);
      } else {
        await pendingDb.drizzle.update(sessions).set(patch).where(eq(sessions.id, sessionId));
      }
      assertPendingOwner();
      setSessionEffort(sessionId, finalEffort);
      setSessionFastMode(sessionId, finalFastMode);
      if (finalModel) {
        agentInputCoordinatorHolder?.refreshQueuedRoute(sessionId, {
          model: finalModel,
          providerId: route.providerId,
          effort: finalEffort ?? undefined,
          fastMode: finalFastMode,
        });
      }
      broadcastSessionPatched(sessionId, patch);
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
