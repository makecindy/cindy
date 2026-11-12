/**
 * Host's Maker `prepareStartOptions` / close cleanup: the parts of the desktop's
 * start hook (apps/desktop/src/main/maker-host/index.ts, `lifecycleHooks`) that
 * apply to a task the Host runs, in the desktop's order.
 *
 * Deliberately absent here, with where they land:
 * - remote-device lookup, Orca and teammate preparation: Host rejects those tasks
 *   before start (send-preflight.ts); they arrive with M3;
 * - worktree runtime lease, shared project Skill links and disabled plugin ids:
 *   later M1 steps;
 * - account-model discovery barrier: the desktop waits for its account provider
 *   discovery; the Host has no such task and reads its provider catalog on demand,
 *   so only the owner part of that check applies.
 */

import type { CreateSessionOptions } from '@cindy/maker-core';

import { activeOwnerScopeKey, isAppSessionBoundaryPending } from '../../../desktop/src/main/appSessionState.js';
import { getActiveCatalog } from '../../../desktop/src/main/maker-host/active-catalog.js';
import { freezeSessionProviderAtStart, getSessionProvider } from '../../../desktop/src/main/maker-host/session-provider-store.js';
import { configureSessionModelInterfaceStorage, sessionModelInterface } from '../../../desktop/src/main/maker-host/session-model-interface.js';
import { createSessionContextBudget } from '../../../desktop/src/main/maker-host/sessionContextBudgetCore.js';
import { readSessionContextWindowBudget } from '../../../desktop/src/main/maker-host/session-context-budget-store.js';
import { getThinkingEnabledFromMemory } from '../../../desktop/src/main/maker-host/newMakerDefaultsCache.js';
import { clearUsagePricing, registerUsagePricing } from '../../../desktop/src/main/maker-host/model-usage-pricing.js';
import { getSessionFastMode, setSessionFastMode } from '../../../desktop/src/main/maker-host/session-effort-store.js';
import type { createSubscriptionFastPolicies } from '../../../desktop/src/main/maker-host/subscriptionFastPolicyCore.js';
import { ownerScopedPath } from '../../../desktop/src/main/ownerContext.js';
import { ACCOUNT_PROVIDER_NOT_READY_CODE } from '../../../desktop/src/shared/accountProviderReadiness.js';
import type { HostModelContext } from './model-context.js';

export interface HostStartOptionsPorts {
  modelContext: HostModelContext;
  /** Subscription Fast policies of the Host's provider groups; absent without a Codex runtime. */
  fastPolicies?: Pick<ReturnType<typeof createSubscriptionFastPolicies>, 'createSubscriptionFastPolicy'> | null;
  logger: { warn(message: string, fields?: Record<string, unknown>): void };
}

export function createHostStartOptions(ports: HostStartOptionsPorts) {
  const owner = activeOwnerScopeKey();
  // Same root as the desktop (index.ts configureSessionModelInterfaceStorage).
  configureSessionModelInterfaceStorage(() => ownerScopedPath('model-interface-snapshots'));
  const budget = createSessionContextBudget({
    resolveContextProviderId: ports.modelContext.resolveContextProviderId,
    readSessionContextWindowBudget,
    logger: ports.logger,
  });

  async function prepareStartOptions(sessionId: string, opts: CreateSessionOptions): Promise<void> {
    // The desktop reports this when signed out or during an account switch; keep
    // its marker so callers can tell "sign in again" from a transient failure.
    if (activeOwnerScopeKey() !== owner || isAppSessionBoundaryPending()) {
      throw Object.assign(
        new Error(
          `${ACCOUNT_PROVIDER_NOT_READY_CODE}: account provider models are not ready `
          + '(usually not signed in, or an account switch is in flight)',
        ),
        { code: ACCOUNT_PROVIDER_NOT_READY_CODE },
      );
    }
    // The dispatch boundary every creation path shares; providerId is final here.
    freezeSessionProviderAtStart(sessionId, opts.providerId);
    const interfaceProvider = getActiveCatalog().providers.find(p => p.id === opts.providerId);
    const interfaceModel = interfaceProvider?.models[opts.agentKind]?.find(m => m.id === opts.model);
    if (interfaceProvider && interfaceModel) sessionModelInterface(sessionId, interfaceProvider.id, opts.agentKind,
      interfaceModel, getActiveCatalog().modelRegistry,
      opts.resumeSessionId ? interfaceProvider.routing[opts.agentKind]?.wireProtocol : undefined);

    if (!opts.remoteHostId && !opts.agentDeviceId && ports.fastPolicies) {
      opts.fastModePolicy = ports.fastPolicies.createSubscriptionFastPolicy(sessionId, () => getSessionProvider(sessionId)
        ?? ports.modelContext.resolveContextProviderId(ports.modelContext.getSelectableCatalog(), opts.agentKind, null, opts.model));
    }
    // The task's working context budget, settled against the catalog and model limits.
    await budget.applySessionContextWindowBudgetToCreateOpts(sessionId, opts, getActiveCatalog());
    if (opts.agentKind === 'pi' && opts.thinkingEnabled === undefined) {
      const thinkingEnabled = getThinkingEnabledFromMemory(opts.agentKind, opts.providerId, opts.model);
      if (thinkingEnabled !== undefined) opts.thinkingEnabled = thinkingEnabled;
    }
    // The desktop reads the session's Fast axis from this store; the Host starts it
    // from the options it is about to run and keeps it in step with later changes.
    setSessionFastMode(sessionId, opts.fastMode ?? false);
    if (opts.agentKind === 'codex' || opts.agentKind === 'pi') {
      opts.resolveUsagePriceVariant = registerUsagePricing(sessionId);
    }
    if (opts.agentKind === 'pi') {
      opts.getPriceVariant = () => (getSessionFastMode(sessionId) ? 'priority' : 'standard');
    }
  }

  return {
    prepareStartOptions,
    onClose(sessionId: string): void {
      clearUsagePricing(sessionId);
    },
  };
}
