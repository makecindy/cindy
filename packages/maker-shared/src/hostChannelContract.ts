/**
 * Shared contract for channels proxied to cindy-host.
 * Used by both desktop host delegation (IPC main) and web client (browser shim).
 */

export interface HostChannelDef {
  /** IPC channel name used by desktop main / preload (e.g. 'local-db:sessions:list') */
  readonly desktopChannel: string;
  /** Browser shim dot-notation path (e.g. 'localDb.sessions.list') */
  readonly webPath: string;
  /** Host HTTP API path */
  readonly hostPath: string;
  /** HTTP method */
  readonly method?: 'POST' | 'GET';
  /** How arguments from client invoke map to request body */
  readonly body?: (args: unknown[]) => unknown;
  /** How host response maps to client expected format */
  readonly map?: (response: unknown) => unknown;
  /** Desktop-only settings: preserve trusted-renderer admission; no web shim. */
  readonly trustedRenderer?: boolean;
}

export const HOST_BROWSER_SETTINGS_ACTIONS = {
  'get-state': 'getState', 'set-kind': 'setKind', 'set-use-real-profile': 'setUseRealProfile',
  reset: 'reset', 'get-health': 'getHealth', recover: 'recover',
  'probe-source-read': 'probeSourceRead', 'open-extension-store': 'openExtensionStore',
} as const;

export const HOST_CONTRACT_CHANNELS: readonly HostChannelDef[] = [
  ...Object.entries(HOST_BROWSER_SETTINGS_ACTIONS).map(([action, handler]) => ({
    desktopChannel: `browser-backend:${action}`,
    webPath: `browserBackend.${handler}`,
    hostPath: `/api/browser-backend/${action}`,
    trustedRenderer: true,
    body: ([payload]: unknown[]) => payload ?? {},
  })),
  {
    desktopChannel: 'local-db:task-tags:execute',
    webPath: 'localDb.taskTags.execute',
    hostPath: '/api/task-tags/execute',
    body: ([request]) => ({ request }),
  },
  {
    desktopChannel: 'local-db:conversations:search',
    webPath: 'localDb.conversations.search',
    hostPath: '/api/conversations/search',
    body: ([request]) => ({ request }),
  },
  ...(['list', 'ensure-singleton', 'upsert', 'close', 'setActive', 'reorder'] as const).map(action => ({
    desktopChannel: `local-db:right-sidebar-tabs:${action}`,
    webPath: `localDb.rightSidebarTabs.${action === 'ensure-singleton' ? 'ensureSingleton' : action}`,
    hostPath: `/api/right-sidebar-tabs/${action}`,
    body: ([payload]: unknown[]) => payload ?? {},
  })),
  // --- Sessions ---
  {
    desktopChannel: 'local-db:sessions:list',
    webPath: 'localDb.sessions.list',
    hostPath: '/api/sessions/list',
    body: ([limit, status, options] = []) =>
      limit !== undefined || status !== undefined || options !== undefined
        ? { limit, status, options }
        : null,
  },
  {
    desktopChannel: 'local-db:sessions:get',
    webPath: 'localDb.sessions.get',
    hostPath: '/api/sessions/get',
    body: ([sessionId]) => ({ sessionId }),
  },
  {
    desktopChannel: 'local-db:sessions:update',
    webPath: 'localDb.sessions.update',
    hostPath: '/api/sessions/update',
    body: ([sessionId, patch]) => ({ sessionId, patch: patch ?? {} }),
  },
  {
    desktopChannel: 'local-db:sessions:create',
    webPath: 'localDb.sessions.create',
    hostPath: '/api/sessions/create',
    body: ([body]) => body ?? {},
  },
  {
    desktopChannel: 'local-db:sessions:interrupted-pending',
    webPath: 'localDb.sessions.interruptedPending',
    hostPath: '/api/sessions/interrupted-pending',
    body: () => null,
  },
  {
    desktopChannel: 'local-db:sessions:error-tail-pending',
    webPath: 'localDb.sessions.errorTailPending',
    hostPath: '/api/sessions/error-tail-pending',
    body: () => null,
  },
  {
    desktopChannel: 'local-db:sessions:interrupted-resume-candidates',
    webPath: 'localDb.sessions.interruptedResumeCandidates',
    hostPath: '/api/sessions/interrupted-candidates',
    body: () => null,
  },
  {
    desktopChannel: 'maker:discard-provisional-session',
    webPath: 'maker.discardProvisionalSession',
    hostPath: '/api/sessions/discard',
    body: ([sessionId]) => ({ sessionId }),
  },
  {
    desktopChannel: 'maker:commit-provisional-session',
    webPath: 'maker.commitProvisionalSession',
    hostPath: '/api/sessions/commit',
    body: ([sessionId]) => ({ sessionId }),
  },

  // --- Messages ---
  {
    desktopChannel: 'local-db:messages:list',
    webPath: 'localDb.messages.list',
    hostPath: '/api/messages/list',
    body: ([sessionId, opts]) => ({
      sessionId,
      limit: (opts as { limit?: number } | undefined)?.limit,
      before: (opts as { before?: string | null } | undefined)?.before ?? null,
    }),
  },
  {
    desktopChannel: 'local-db:messages:view',
    webPath: 'localDb.messages.historyView',
    hostPath: '/api/messages/history-view',
    body: ([sessionId, opts]) => ({
      sessionId,
      before: (opts as { before?: string | null } | undefined)?.before ?? null,
    }),
  },
  {
    desktopChannel: 'local-db:messages:create',
    webPath: 'localDb.messages.create',
    hostPath: '/api/messages/create',
    body: ([sessionId, message]) => ({ sessionId, message }),
  },
  {
    // Note: corrected from P3 dead channel name 'local-db:messages:estimated-value'
    desktopChannel: 'local-db:messages:estimatedSessionValue',
    webPath: 'localDb.messages.estimatedSessionValue',
    hostPath: '/api/messages/estimated-value',
    body: ([sessionId]) => ({ sessionId }),
  },

  // --- Durable Subagent work ---
  ...(['list', 'detail', 'transcript'] as const).map(action => ({
    desktopChannel: `local-db:subagent-runs:${action}`,
    webPath: `localDb.subagentRuns.${action}`,
    hostPath: `/api/subagent-runs/${action}`,
    body: ([input]: unknown[]) => input ?? {},
  })),

  // --- Maker & Agents ---
  {
    desktopChannel: 'maker:list-active',
    webPath: 'maker.listActive',
    hostPath: '/api/runtime/sessions',
    body: ([options]) => ({ options }),
  },
  {
    desktopChannel: 'maker:list-available-agents',
    webPath: 'maker.listAvailableAgents',
    hostPath: '/api/agents',
    body: () => null,
  },
  {
    desktopChannel: 'maker:provider:list',
    webPath: 'maker.listProviders',
    hostPath: '/api/providers',
    body: () => null,
  },
  {
    desktopChannel: 'maker:auth:get-state',
    webPath: 'maker.auth.getState',
    hostPath: '/api/agents/auth-state',
    body: ([agentKind]) => ({ agentKind }),
  },
  {
    desktopChannel: 'maker:agent:status',
    webPath: 'maker.agent.getStatus',
    hostPath: '/api/agents/status',
    body: ([agentKind]) => ({ agentKind }),
  },
  {
    desktopChannel: 'maker:auth:trigger-login',
    webPath: 'maker.auth.triggerLogin',
    hostPath: '/api/agents/login',
    body: ([agentKind, options]) => ({ agentKind, options }),
  },
  {
    desktopChannel: 'maker:auth:cancel-login',
    webPath: 'maker.auth.cancelLogin',
    hostPath: '/api/agents/cancel-login',
    body: ([agentKind, options]) => ({ agentKind, options }),
  },
  {
    desktopChannel: 'maker:auth:logout',
    webPath: 'maker.auth.logout',
    hostPath: '/api/agents/logout',
    body: ([agentKind, ownerScope]) => ({ agentKind, ownerScope }),
  },
  {
    desktopChannel: 'maker:get-capabilities',
    webPath: 'maker.getCapabilities',
    hostPath: '/api/capabilities',
    body: ([agentKind]) => ({ agentKind }),
    map: (response) => {
      const result = response as { capabilities?: Record<string, unknown> } | null;
      return result?.capabilities ? { ...result.capabilities, ...result } : response;
    },
  },
  {
    desktopChannel: 'maker:list-agent-commands',
    webPath: 'maker.listAgentCommands',
    hostPath: '/api/agent-commands',
    body: ([agentKind, params]) => ({
      agentKind,
      sessionId: (params as { sessionId?: string } | undefined)?.sessionId,
    }),
  },
  {
    desktopChannel: 'maker:list-agent-skills',
    webPath: 'maker.listAgentSkills',
    hostPath: '/api/agent-skills',
    body: ([agentKind, params]) => ({
      agentKind,
      workingDir: (params as { workingDir?: string } | undefined)?.workingDir,
      sessionId: (params as { sessionId?: string } | undefined)?.sessionId,
      forceReload: (params as { forceReload?: boolean } | undefined)?.forceReload === true,
    }),
  },
  {
    desktopChannel: 'maker:turn-change-sets:list',
    webPath: 'maker.listTurnChangeSets',
    hostPath: '/api/turn-change-sets/list',
    body: ([sessionId]) => ({ sessionId }),
  },

  // --- Input Queue ---
  {
    desktopChannel: 'maker:input:get-projection',
    webPath: 'maker.input.getProjection',
    hostPath: '/api/input/projection',
    body: ([sessionId]) => ({ sessionId }),
  },
  {
    desktopChannel: 'maker:input:enqueue',
    webPath: 'maker.input.enqueue',
    hostPath: '/api/input/enqueue',
    body: ([sessionId, item]) => ({ sessionId, item }),
  },
  {
    desktopChannel: 'maker:input:stop',
    webPath: 'maker.input.stop',
    hostPath: '/api/input/stop',
    body: ([sessionId]) => ({ sessionId }),
  },
  {
    desktopChannel: 'maker:input:steer',
    webPath: 'maker.input.steer',
    hostPath: '/api/input/steer',
    body: ([sessionId, item]) => ({ sessionId, item }),
    map: (response) => {
      const result = response as { ok?: boolean; projection?: unknown } | null;
      return result?.projection ?? (result?.ok === true);
    },
  },
  {
    desktopChannel: 'maker:input:resume',
    webPath: 'maker.input.resume',
    hostPath: '/api/input/resume',
    body: ([sessionId]) => ({ sessionId }),
  },
  {
    desktopChannel: 'maker:input:remove',
    webPath: 'maker.input.remove',
    hostPath: '/api/input/remove',
    body: ([sessionId, clientId]) => ({ sessionId, clientId }),
  },
  {
    desktopChannel: 'maker:input:retry-last-error',
    webPath: 'maker.input.retryLastError',
    hostPath: '/api/input/retry-last-error',
    body: ([sessionId]) => ({ sessionId }),
  },
  {
    desktopChannel: 'maker:input:clear-error',
    webPath: 'maker.input.clearError',
    hostPath: '/api/input/clear-error',
    body: ([sessionId]) => ({ sessionId }),
  },

  // --- Interactions ---
  {
    desktopChannel: 'maker:get-pending-interactions',
    webPath: 'maker.getPendingInteractions',
    hostPath: '/api/interactions/pending',
    body: ([sessionId]) => ({ sessionId }),
  },
  {
    desktopChannel: 'maker:resolve-interaction',
    webPath: 'maker.resolveInteraction',
    hostPath: '/api/interactions/respond',
    body: ([requestId, decision]) => ({ requestId, decision }),
    map: (response) => ({ accepted: (response as { accepted?: boolean } | null)?.accepted === true }),
  },

  // --- Usage & Pricing ---
  {
    desktopChannel: 'maker:usage:model-pricing',
    webPath: 'maker.usage.getModelPricing',
    hostPath: '/api/usage/model-pricing',
    body: () => null,
  },
  {
    desktopChannel: 'maker:usage:model-pricing-v2',
    webPath: 'maker.usage.getModelPricingV2',
    hostPath: '/api/usage/model-pricing',
    body: () => null,
  },
  {
    desktopChannel: 'maker:usage:reference-model-pricing',
    webPath: 'maker.usage.getReferenceModelPricing',
    hostPath: '/api/usage/reference-model-pricing',
    body: () => null,
  },
  {
    desktopChannel: 'model-access:get-status',
    webPath: 'modelAccess.getStatus',
    hostPath: '/api/model-access',
    body: () => null,
  },
  {
    desktopChannel: 'model-access:retry',
    webPath: 'modelAccess.retry',
    hostPath: '/api/model-access/retry',
    body: () => null,
  },
  {
    desktopChannel: 'maker:codex-runtime-route:get',
    webPath: 'maker.codexRuntimeRouteGet',
    hostPath: '/api/agents/codex-runtime-route',
    body: () => null,
  },

  // --- Project Aliases ---
  {
    desktopChannel: 'local-db:project-aliases:list',
    webPath: 'localDb.projectAliases.list',
    hostPath: '/api/project-aliases/list',
    body: () => null,
  },
  {
    desktopChannel: 'local-db:project-aliases:set',
    webPath: 'localDb.projectAliases.set',
    hostPath: '/api/project-aliases/set',
    body: ([input]) => input ?? {},
  },
  {
    desktopChannel: 'local-db:project-aliases:delete',
    webPath: 'localDb.projectAliases.delete',
    hostPath: '/api/project-aliases/delete',
    body: ([projectKey]) => (typeof projectKey === 'string' ? { projectKey } : projectKey ?? {}),
  },
  {
    desktopChannel: 'local-db:recent-workdirs:list',
    webPath: 'localDb.recentWorkdirs.list',
    hostPath: '/api/recent-workdirs/list',
    body: () => null,
  },

  // --- Settings ---
  {
    desktopChannel: 'appearance-settings:set-patch',
    webPath: 'appearanceSettings.setPatch',
    hostPath: '/api/settings/appearance/set',
    body: ([patch]) => ({ patch: patch ?? {} }),
  },
  {
    desktopChannel: 'appearance-settings:reset',
    webPath: 'appearanceSettings.reset',
    hostPath: '/api/settings/appearance/reset',
    body: () => ({}),
  },
  {
    desktopChannel: 'layout:set',
    webPath: 'layout.set',
    hostPath: '/api/settings/layout/set',
    body: ([layout]) => ({ layout: layout ?? {} }),
    map: (response) => ({ layout: response, persisted: true }),
  },
  {
    desktopChannel: 'layout:reset',
    webPath: 'layout.reset',
    hostPath: '/api/settings/layout/reset',
    body: () => ({}),
    map: (response) => ({ layout: response, persisted: true }),
  },

  // --- Auth (Single Writer) ---
  {
    desktopChannel: 'auth:logout',
    webPath: 'auth.logout',
    hostPath: '/api/auth/logout',
    body: () => ({}),
  },
  {
    desktopChannel: 'auth:refresh',
    webPath: 'auth.refresh',
    hostPath: '/api/auth/refresh',
    body: () => ({}),
    map: (response) => {
      const state = response as { isAuthenticated?: boolean; authenticated?: boolean } | null;
      return (state?.isAuthenticated ?? state?.authenticated) === true;
    },
  },
  {
    desktopChannel: 'auth:get-state',
    webPath: 'auth.getState',
    hostPath: '/api/auth/state',
    body: () => ({}),
  },

  // --- Plugins / Ghosts ---
  {
    desktopChannel: 'plugin-market:list-installed',
    webPath: 'pluginMarket.listInstalled',
    hostPath: '/api/plugins/list',
    body: () => null,
  },
  {
    desktopChannel: 'ghosts:list',
    webPath: 'ghosts.listSync',
    hostPath: '/api/ghosts',
    body: () => null,
  },
  {
    desktopChannel: 'ghosts:runtime-states',
    webPath: 'ghosts.runtimeStates',
    hostPath: '/api/ghosts/runtime-states',
    body: () => null,
  },
  {
    desktopChannel: 'ghosts:card:get',
    webPath: 'ghosts.getCard',
    hostPath: '/api/ghosts/card',
    body: ([callId]) => ({ callId }),
  },
  {
    desktopChannel: 'ghosts:card:list-by-session',
    webPath: 'ghosts.listCardsBySession',
    hostPath: '/api/ghosts/cards',
    body: ([sessionId]) => ({ sessionId }),
  },
  {
    desktopChannel: 'ghosts:set-enabled',
    webPath: 'ghosts.setEnabled',
    hostPath: '/api/ghosts/set-enabled',
    body: ([id, enabled, expectedInstalledApproval]) => ({ id, enabled, expectedInstalledApproval }),
  },
  {
    desktopChannel: 'ghosts:request-task-approval',
    webPath: 'ghosts.requestTaskApproval',
    hostPath: '/api/ghosts/request-task-approval',
    body: ([id, capability]) => ({ id, capability }),
  },
  {
    desktopChannel: 'ghosts:confirm:resolve',
    webPath: 'ghosts.resolveConfirm',
    hostPath: '/api/ghosts/confirm/resolve',
    body: ([requestId, confirmed]) => requestId && typeof requestId === 'object' ? requestId : ({ requestId, confirmed }),
  },
  {
    desktopChannel: 'ghosts:install-consent:resolve',
    webPath: 'ghosts.resolveInstallConsent',
    hostPath: '/api/ghosts/install-consent/resolve',
    body: ([requestId, confirmed]) => requestId && typeof requestId === 'object' ? requestId : ({ requestId, confirmed }),
  },
];

/** Transport stays with the caller: web uses its paired cookie, main its token. */
export function createHostChannelHandlers(
  request: (path: string, body: unknown, method: 'POST' | 'GET') => Promise<unknown>,
): Record<string, (args?: unknown[]) => Promise<unknown>> {
  return Object.fromEntries(HOST_CONTRACT_CHANNELS.filter(def => !def.trustedRenderer).map(def => [
    def.webPath,
    async (args: unknown[] = []) => {
      const response = await request(def.hostPath, def.body?.(args) ?? null, def.method ?? 'POST');
      return def.map ? def.map(response) : response;
    },
  ]));
}

/** Stable code for the browser adapter; never includes arguments or secrets. */
export function unsupportedHostChannel(path: string): Error & { code: string } {
  return Object.assign(new Error(`HOST_CHANNEL_UNSUPPORTED: ${path}`), {
    code: 'HOST_CHANNEL_UNSUPPORTED',
  });
}
