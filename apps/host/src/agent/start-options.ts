/**
 * Host's Maker `prepareStartOptions` / close cleanup: the parts of the desktop's
 * start hook (apps/desktop/src/main/maker-host/index.ts, `lifecycleHooks`) that
 * apply to a task the Host runs, in the desktop's order.
 *
 * Deliberately absent here, with where they land:
 * - remote-device lookup, Orca and teammate preparation: Host rejects those tasks
 *   before start (send-preflight.ts); they arrive with M3;
 * - the teammate parts of the shared Skill links and disabled plugin ids (bot
 *   toolsets) and the bot workspace runtime arrive with M3;
 * - account-model discovery barrier: the desktop waits for its account provider
 *   discovery (ensureCurrentAccountProviderReadiness). The Host's equivalent is its
 *   provider catalog refresh, which applies the account's gateway models to the
 *   active catalog; `ensureProviderCatalog` waits for it, so a task restored right
 *   after startup does not resolve against an incomplete catalog.
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
import { getSessionFastMode, setSessionEffort, setSessionFastMode } from '../../../desktop/src/main/maker-host/session-effort-store.js';
import { resolveCompatibleSessionRuntimeEffort } from '../../../desktop/src/main/maker-ipc/sessionRuntimeControl.js';
import type { createSubscriptionFastPolicies } from '../../../desktop/src/main/maker-host/subscriptionFastPolicyCore.js';
import type { SessionStartFailureContext } from '@cindy/maker-core';
import type { WorktreeRuntimeLease } from '../../../desktop/src/main/worktree/runtimeLeases.js';
import { hostPrecreatedCancellation, hostWorktreeRuntimeLeases } from './worktree-leases.js';
import { ownerScopedPath } from '../../../desktop/src/main/ownerContext.js';
import { ACCOUNT_PROVIDER_NOT_READY_CODE } from '../../../desktop/src/shared/accountProviderReadiness.js';
import { prepareSharedProjectSkillLinks } from '../../../desktop/src/main/maker-host/shared-global-skills.js';
import { createPluginRegistry } from '../../../desktop/src/main/maker-host/plugins/index.js';
import { CODEX_DISABLED_BUILTIN_PLUGIN_IDS_KEY } from '../../../desktop/src/main/mcp-integrations/codexBuiltinToolPolicy.js';
import type { HostModelContext } from './model-context.js';

export interface HostStartOptionsPorts {
  modelContext: HostModelContext;
  /** Subscription Fast policies of the Host's provider groups; absent without a Codex runtime. */
  fastPolicies?: Pick<ReturnType<typeof createSubscriptionFastPolicies>, 'createSubscriptionFastPolicy'> | null;
  logger: { warn(message: string, fields?: Record<string, unknown>): void };
  /** Applies the account's provider models to the active catalog (Host listProviders). */
  ensureProviderCatalog?: () => Promise<unknown>;
  /** Re-derives each engine's model list from the selectable catalog. */
  refreshModels?: () => void;
  /** Codex caches skills/list per cwd; drop it after new shared Skill links. */
  reloadCodexSkills?: (workingDir: string) => Promise<unknown>;
}

function providerNotReady(): Error {
  return Object.assign(
    new Error(
      `${ACCOUNT_PROVIDER_NOT_READY_CODE}: account provider models are not ready `
      + '(usually not signed in, or an account switch is in flight)',
    ),
    { code: ACCOUNT_PROVIDER_NOT_READY_CODE },
  );
}

export function createHostStartOptions(ports: HostStartOptionsPorts) {
  const owner = activeOwnerScopeKey();
  // Same root as the desktop (index.ts configureSessionModelInterfaceStorage).
  configureSessionModelInterfaceStorage(() => ownerScopedPath('model-interface-snapshots'));
  // The desktop's worktree runtime leases (maker-host/index.ts worktreeRuntimeLeases): one per
  // start, released when the start fails without a live runtime, when its cleanup succeeds and
  // on close; a window recycling worktrees in the same profile treats a held one as in use.
  const worktreeRuntimeLeases = new WeakMap<object, WorktreeRuntimeLease>();
  const releaseLease = async (sessionId: string, options: CreateSessionOptions) => {
    const lease = worktreeRuntimeLeases.get(options);
    if (lease) {
      await hostWorktreeRuntimeLeases.releaseWorktreeRuntimeLease(lease).catch((error) => {
        ports.logger.warn('worktree runtime lease release postponed', { sessionId, code: (error as NodeJS.ErrnoException).code });
      });
    }
  };
  const budget = createSessionContextBudget({
    resolveContextProviderId: ports.modelContext.resolveContextProviderId,
    readSessionContextWindowBudget,
    logger: ports.logger,
  });

  async function prepareStartOptions(sessionId: string, opts: CreateSessionOptions): Promise<void> {
    // The desktop reports this when signed out or during an account switch; keep
    // its marker so callers can tell "sign in again" from a transient failure.
    const ownerCurrent = () => activeOwnerScopeKey() === owner && !isAppSessionBoundaryPending();
    if (!ownerCurrent()) throw providerNotReady();
    if (ports.ensureProviderCatalog) {
      try { await ports.ensureProviderCatalog(); }
      catch { throw providerNotReady(); }
      // The desktop rechecks the owner after its wait; so does the Host.
      if (!ownerCurrent()) throw providerNotReady();
    }
    // The desktop refreshes these lists on every catalog change; the Host at least
    // before each start, against the catalog it just applied.
    ports.refreshModels?.();
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
    // The proxy's provider bridges read the task's effort from this store; the desktop
    // hydrates it at start against the current model's capabilities (register.ts).
    setSessionEffort(sessionId, interfaceModel
      ? resolveCompatibleSessionRuntimeEffort(interfaceModel, (opts.effort ?? null) as Parameters<typeof resolveCompatibleSessionRuntimeEffort>[1])
      : opts.effort ?? null);
    if (opts.agentKind === 'codex' || opts.agentKind === 'pi') {
      opts.resolveUsagePriceVariant = registerUsagePricing(sessionId);
    }
    if (opts.agentKind === 'pi') {
      opts.getPriceVariant = () => (getSessionFastMode(sessionId) ? 'priority' : 'standard');
    }
    // As the desktop, before the shared Skill links. The desktop first fills createOpts.id and
    // prepares the bot workspace runtime, which reads that id; both arrive with M3.
    const createOpts = opts;
    if (!createOpts.remoteHostId && createOpts.workingDir) {
      const lease = await hostWorktreeRuntimeLeases.acquireWorktreeRuntimeLease(sessionId, createOpts.workingDir);
      if (lease) worktreeRuntimeLeases.set(opts, lease);
      // Recheck after acquiring the directory lease: cancellation may have
      // arrived during preparation or through another local instance.
      hostPrecreatedCancellation.assertPrecreatedSessionNotCancelled(sessionId);
    }
    if (!opts.remoteHostId && opts.workingDir) {
      const result = await prepareSharedProjectSkillLinks({ workingDir: opts.workingDir });
      for (const warning of result.warnings) {
        ports.logger.warn('shared project skill link warning', { workingDir: opts.workingDir, warning });
      }
    }
    // Plugins the user disabled for this workdir; the desktop adds a teammate's toolsets (M3).
    const disabledPluginIds = [...new Set(createPluginRegistry().getDisabledRuntimePluginIds(opts.workingDir))];
    opts.vendorOptions = {
      ...(opts.vendorOptions ?? {}),
      [CODEX_DISABLED_BUILTIN_PLUGIN_IDS_KEY]: disabledPluginIds,
    };
  }

  /** The desktop's onBeforeStart Skill-link step (its Codex deferred restart lives in the Host input queue). */
  async function onBeforeStart(context: { agentKind: string; workingDir?: string; remoteHostId?: string }): Promise<void> {
    if (context.remoteHostId || !context.workingDir) return;
    const result = await prepareSharedProjectSkillLinks({ workingDir: context.workingDir });
    for (const warning of result.warnings) {
      ports.logger.warn('shared project skill link warning', { workingDir: context.workingDir, warning });
    }
    if (context.agentKind === 'codex' && result.changed) await ports.reloadCodexSkills?.(context.workingDir);
  }

  return {
    prepareStartOptions,
    onBeforeStart,
    async onStartFailed({ sessionId, options, runtimeMayBeAlive }: SessionStartFailureContext): Promise<void> {
      if (!runtimeMayBeAlive) await releaseLease(sessionId, options);
    },
    async onStartCleanupSucceeded(sessionId: string, options: CreateSessionOptions): Promise<void> {
      await releaseLease(sessionId, options);
    },
    async onClose(sessionId: string, options?: CreateSessionOptions): Promise<void> {
      clearUsagePricing(sessionId);
      if (options) await releaseLease(sessionId, options);
    },
  };
}
