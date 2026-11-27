import { holdError } from './agent/profile-hold.ts';
import { clientErrorMessage } from './client-error.mjs';
import { HOST_BROWSER_SETTINGS_ACTIONS } from '@cindy/maker-shared/host-channel-contract';
import { throwIpcError } from '../../desktop/src/main/utils/ipcValidate.ts';

/**
 * What still runs while a desktop that opens this profile's database is live (coexistence plan A,
 * agent/profile-coexistence.ts). Everything else is refused, typed, before its handler runs; a path
 * added later is refused too until it is listed here. Allowed are reads, and what a running turn
 * needs to end: stopping it, and answering its permission requests, questions and plugin prompts.
 * Without those the turn would not end and the profile could never be released.
 */
export const HOST_PATHS_ALLOWED_WHILE_HELD = Object.freeze({
  // Reads: they answer from what this process holds or read the shared files; none writes. Not
  // /api/browser-backend/get-health: a failed embedded-browser probe recovers the backend
  // (health-service.ts getHealth), so it is refused like other writes.
  read: Object.freeze([
    '/api/me', '/api/auth/state', '/api/profile', '/api/runtime/sessions', '/api/conversations/search',
    '/api/sessions/list', '/api/sessions/get', '/api/sessions/messages', '/api/sessions/agent-switch-intent',
    '/api/sessions/interrupted-pending', '/api/sessions/error-tail-pending', '/api/sessions/interrupted-candidates',
    '/api/messages/list', '/api/messages/history-view', '/api/messages/work-details', '/api/messages/estimated-value',
    '/api/turn-change-sets/list', '/api/project-info/get', '/api/project-info/image', '/api/project-aliases/list',
    '/api/recent-workdirs/list', '/api/ghosts', '/api/ghosts/runtime-states', '/api/ghosts/card', '/api/ghosts/cards',
    '/api/plugins/list', '/api/providers', '/api/agents', '/api/agents/auth-state', '/api/agents/status',
    '/api/agents/codex-runtime-route', '/api/model-access', '/api/usage/model-pricing', '/api/usage/reference-model-pricing',
    '/api/interactions/pending', '/api/input/projection', '/api/agent-commands', '/api/agent-skills', '/api/capabilities',
    '/api/right-sidebar-tabs/list', '/api/browser-backend/get-state', '/api/notifications/clear-session-attention',
    '/api/model-groups/get', '/api/model-groups/resolve', '/api/model-groups/get-session-binding',
    '/api/model-groups/switch-offer', '/api/model-groups/decisions',
  ]),
  // Stopping or interrupting the running turn.
  stop: Object.freeze(['/api/input/stop']),
  // Answering the running turn: its permission requests and questions, and its plugin prompts. An
  // install consent is answered only with a refusal (below): accepting installs into the shared profile.
  answer: Object.freeze(['/api/interactions/respond', '/api/ghosts/confirm/resolve', '/api/ghosts/install-consent/resolve']),
  // Renewing the account session (reviewer, 2026-11-17): the one shared credential the Host writes
  // while held, because it would sign itself out otherwise (auth/refresh.mjs). A window in client
  // mode asks the Host to renew through this path; refused, the window takes it as a failed renewal.
  renew: Object.freeze(['/api/auth/refresh']),
});
const ALLOWED_WHILE_HELD = new Set(Object.values(HOST_PATHS_ALLOWED_WHILE_HELD).flat());

/** Owner business operations shared by HTTP and authenticated Device Link.
 * Transport admission and owner leases belong to the caller. No synthetic HTTP
 * request, loopback bearer or renderer sender is created for remote clients.
 */
export function createHostService(deps) {
  return async function invoke(pathname, body = {}, context = {}) {
    const url = { pathname };
    const held = deps.profileHold?.();
    if (held && !ALLOWED_WHILE_HELD.has(pathname)) throw holdError(held);
    if (held && pathname === '/api/ghosts/install-consent/resolve' && body?.confirmed !== false)
      throw holdError(held);

    for (const [action, handler] of Object.entries(HOST_BROWSER_SETTINGS_ACTIONS)) {
      if (pathname === `/api/browser-backend/${action}`)
        return { status: 200, body: await deps.browserBackend(handler, body) };
    }

    for (const action of ['list', 'ensure-singleton', 'upsert', 'close', 'setActive', 'reorder']) {
      if (url.pathname === `/api/right-sidebar-tabs/${action}`)
        return { status: 200, body: await deps.rightSidebarTabs[action](body) };
    }
    if (url.pathname === '/api/task-tags/execute') {
        return { status: 200, body: await deps.executeTaskTags(body.request) };
    }
    if (url.pathname === '/api/conversations/search') {
        return { status: 200, body: await deps.searchConversations(body.request) };
    }

    if (url.pathname === '/api/runtime/sessions') {
        return { status: 200, body: await deps.listRunningSessions(body.options) };
    }
    // Settings the browser client renders: read from, and written to, the
    // Desktop's own files so both clients show one copy of the account.
    if (url.pathname === '/api/profile') {
        return { status: 200, body: await deps.profile() };
    }
    if (url.pathname === '/api/settings/appearance/set') {
        return { status: 200, body: await deps.settings.setAppearance(body.patch ?? body) };
    }
    if (url.pathname === '/api/settings/appearance/reset') {
        return { status: 200, body: await deps.settings.resetAppearance() };
    }
    if (url.pathname === '/api/settings/layout/set') {
        return { status: 200, body: await deps.settings.setLayout(body.layout ?? body) };
    }
    if (url.pathname === '/api/settings/layout/reset') {
        return { status: 200, body: await deps.settings.resetLayout() };
    }
    if (url.pathname === '/api/settings/sidebar/set') {
        return { status: 200, body: await deps.settings.setSidebar(body.value ?? body) };
    }
    if (url.pathname === '/api/settings/shortcuts/set') {
        return { status: 200, body: await deps.settings.setShortcuts(body.overrides ?? body ?? {}) };
    }
    if (url.pathname === '/api/me') {
        return { status: 200, body: await deps.me() };
    }
    if (url.pathname === '/api/auth/state') {
        return { status: 200, body: await (deps.getAuthState ? deps.getAuthState() : deps.me()) };
    }
    if (url.pathname === '/api/auth/refresh') {
        return { status: 200, body: await (deps.refreshAuth ? deps.refreshAuth() : { ok: true }) };
    }
    // The preload contract for `localDb.sessions.list()` is a bare array.
    if (url.pathname === '/api/sessions/list') {
        return { status: 200, body: await deps.listSessions(body) };
    }
    if (pathname === '/api/runtime-plugins') {
      if (!context.trustedNativeClient) throwIpcError('PERMISSION_DENIED', 'A trusted desktop renderer is required');
      return { status: 200, body: await deps.runtimePluginSettings(body.sessionId, body.value) };
    }
    if (url.pathname === '/api/project-info/auto-icon') return { status: 200, body: await deps.resolveAutomaticProjectIcon(body) };
    if (url.pathname === '/api/project-info/image') return { status: 200, body: await deps.readProjectIconImage(body) };
    if (url.pathname === '/api/project-info/get') return { status: 200, body: await deps.readProjectInfo() };
    if (pathname === '/api/project-info/desktop-set') {
      if (!context.caller?.startsWith('local-api:') || typeof body?.requestId !== 'string' || !body.requestId)
        return { status: 403, body: { error: 'desktop_project_request_required' } };
      return { status: 200, body: await deps.updateProjectInfo(body.input, { desktopRequest: body.requestId }) };
    }
    if (pathname === '/api/project-info/set') {
      // Older Desktop proxies forward page input with the local bearer. They can edit
      // existing metadata, but cannot introduce a new filesystem or credential grant.
      return { status: 200, body: await deps.updateProjectInfo(body, { legacyDesktop: context.caller?.startsWith('local-api:') }) };
    }
    if (url.pathname === '/api/project-aliases/list') {
        return { status: 200, body: await deps.listProjectAliases() };
    }
    if (url.pathname === '/api/project-aliases/set') {
        return { status: 200, body: await deps.setProjectAlias(body) };
    }
    if (url.pathname === '/api/project-aliases/delete') {
        return { status: 200, body: await deps.deleteProjectAlias(body) };
    }
    if (url.pathname === '/api/recent-workdirs/list') {
        return { status: 200, body: await deps.listRecentWorkdirs() };
    }
    if (url.pathname === '/api/sessions/create') {
        return { status: 201, body: await deps.createSession(body) };
    }
    if (url.pathname === '/api/sessions/update') {
        return { status: 200, body: await deps.updateSession(String(body.sessionId ?? ''), body.patch ?? {}, body.deleteTarget !== undefined ? { deleteTarget: body.deleteTarget } : undefined) };
    }
    if (url.pathname === '/api/sessions/set-effort') {
      // The desktop's set-effort, set-fast-mode and set-thinking-enabled, with their IPC arguments.
      return { status: 200, body: (await deps.setSessionEffort(body.sessionId, body.effort)) ?? null };
    }
    if (url.pathname === '/api/sessions/set-fast-mode') {
      return { status: 200, body: (await deps.setSessionFastMode(body.sessionId, body.fastMode)) ?? null };
    }
    if (url.pathname === '/api/sessions/set-thinking-enabled') {
      return { status: 200, body: (await deps.setSessionThinkingEnabled(body.sessionId, body.enabled)) ?? null };
    }
    if (url.pathname === '/api/sessions/set-permission-mode') {
      // The desktop's set-permission-mode and set-plan-mode, with their IPC arguments.
      return { status: 200, body: (await deps.setSessionPermissionMode(body.sessionId, body.mode)) ?? null };
    }
    if (url.pathname === '/api/sessions/set-plan-mode') {
      return { status: 200, body: (await deps.setSessionPlanMode(body.sessionId, body.enabled)) ?? null };
    }
    if (url.pathname === '/api/sessions/set-model') {
      // The desktop's set-model, with its IPC arguments (the web client passes them through).
      return { status: 200, body: await deps.setSessionModel(String(body.sessionId ?? ''), body.model, body.providerId, body.revision, body.selection) };
    }
    if (url.pathname === '/api/sessions/switch-agent') {
        return { status: 200, body: await deps.switchSessionAgent(String(body.sessionId ?? ''), String(body.targetAgentKind ?? ''), String(body.model ?? ''), body.providerId ?? null, body.effort, body.fastMode, body.options, body.thinking) };
    }
    if (url.pathname === '/api/sessions/agent-switch-intent') {
        return { status: 200, body: await deps.getSessionAgentSwitchIntent(String(body.sessionId ?? '')) };
    }
    if (url.pathname === '/api/sessions/auto-title') {
        return { status: 200, body: await deps.autoTitle(body) };
    }
    if (url.pathname === '/api/sessions/delete') {
        return { status: 200, body: await deps.deleteSession(String(body.sessionId ?? '')) };
    }
    if (url.pathname === '/api/sessions/get') {
        return { status: 200, body: await deps.getSession(String(body.sessionId ?? '')) };
    }
    if (url.pathname === '/api/sessions/discard') {
        return { status: 200, body: await deps.discardProvisionalSession(String(body.sessionId ?? '')) };
    }
    if (url.pathname === '/api/sessions/interrupted-pending') {
        return { status: 200, body: await deps.interruptedPending() };
    }
    if (url.pathname === '/api/sessions/error-tail-pending') {
        return { status: 200, body: await deps.errorTailPending() };
    }
    if (url.pathname === '/api/sessions/interrupted-candidates') {
        return { status: 200, body: await deps.interruptedCandidates() };
    }
    if (url.pathname === '/api/sessions/commit') {
        return { status: 200, body: await deps.commitProvisionalSession(String(body.sessionId ?? '')) };
    }
    if (url.pathname === '/api/sessions/messages') {
        return { status: 200, body: { messages: await deps.history(String(body.sessionId ?? ''), Number(body.limit ?? 200)) } };
    }
    if (url.pathname === '/api/messages/estimated-value') {
        return { status: 200, body: await deps.estimatedSessionValue(String(body.sessionId ?? '')) };
    }
    if (url.pathname === '/api/messages/history-view') {
        return { status: 200, body: await deps.historyView(String(body.sessionId ?? ''), body.before ?? null, body.opts) };
    }
    if (url.pathname === '/api/messages/work-details') {
        return { status: 200, body: await deps.workDetails(String(body.sessionId ?? ''), body.ref, body.after ?? null) };
    }
    if (url.pathname === '/api/sessions/ack-interrupted') {
        return { status: 200, body: await deps.ackInterrupted(body.sessionId) };
    }
    if (url.pathname === '/api/notifications/clear-session-attention') {
        return { status: 200, body: await deps.clearSessionAttention(body.sessionId, body.intent) };
    }
    if (url.pathname === '/api/messages/dismiss-error') {
        return { status: 200, body: await deps.dismissError(body.sessionId, body.clientId) };
    }
    if (url.pathname === '/api/messages/create') {
        return { status: 201, body: await deps.createMessage(String(body.sessionId ?? ''), body.message ?? {}) };
    }
    // The preload contract for `localDb.messages.list()` is a bare array.
    if (url.pathname === '/api/messages/list') {
        return { status: 200, body: await (deps.messagesList ? deps.messagesList(String(body.sessionId ?? ''), Number(body.limit ?? 200), body.before ?? null) : deps.history(String(body.sessionId ?? ''), Number(body.limit ?? 200))) };
    }
    if (url.pathname === '/api/turn-change-sets/list') {
        return { status: 200, body: await deps.turnChangeSets(String(body.sessionId ?? '')) };
    }
    for (const action of ['list', 'detail', 'transcript']) {
        if (url.pathname === `/api/subagent-runs/${action}`) {
            return { status: 200, body: await deps.subagentRuns[action](body) };
        }
    }
    if (url.pathname === '/api/ghosts') {
        return { status: 200, body: await deps.ghosts() };
    }
    if (url.pathname === '/api/ghosts/runtime-states') {
        return { status: 200, body: await deps.pluginRuntimeStates() };
    }
    if (url.pathname === '/api/ghosts/card') {
        return { status: 200, body: await deps.getPluginCard(String(body.callId ?? '')) };
    }
    if (url.pathname === '/api/ghosts/cards') {
        return { status: 200, body: await deps.listPluginCards(String(body.sessionId ?? '')) };
    }
    if (url.pathname === '/api/ghosts/set-enabled') {
        if (typeof body.id !== 'string' || !body.id || typeof body.enabled !== 'boolean'
          || (body.expectedInstalledApproval !== undefined && typeof body.expectedInstalledApproval !== 'string'))
            return { status: 400, body: { error: 'invalid_plugin_enable_request' } };
        return { status: 200, body: await deps.setPluginEnabled(body.id, body.enabled, body.expectedInstalledApproval) };
    }
    if (url.pathname === '/api/ghosts/confirm/resolve' || url.pathname === '/api/ghosts/install-consent/resolve') {
        if (!context.caller) return { status: 403, body: { error: 'authenticated_controller_required' } };
        if (typeof body.requestId !== 'string' || typeof body.confirmed !== 'boolean')
            return { status: 400, body: { error: 'invalid_confirmation' } };
        return { status: 200, body: { handled: deps.resolvePluginConfirmation(context.caller,
            url.pathname === '/api/ghosts/confirm/resolve' ? 'confirm' : 'install', body.requestId, body.confirmed) } };
    }
    if (url.pathname === '/api/plugins/list') {
        return { status: 200, body: await deps.listPlugins() };
    }
    if (url.pathname === '/api/providers') {
        return { status: 200, body: await deps.providers() };
    }
    if (url.pathname === '/api/agents/auth-state') {
        return { status: 200, body: await deps.agentAuthState(body.agentKind) };
    }
    if (url.pathname === '/api/agents/status') {
        return { status: 200, body: await deps.agentStatus(body.agentKind) };
    }
    const authChannel = {
      '/api/agents/login': 'maker:auth:trigger-login',
      '/api/agents/cancel-login': 'maker:auth:cancel-login',
      '/api/agents/logout': 'maker:auth:logout',
    }[pathname];
    if (authChannel) {
        if (!context.caller) return { status: 403, body: { error: 'authenticated_controller_required' } };
        return { status: 200, body: await deps.agentAuthInvoke(authChannel,
          [body.agentKind, pathname === '/api/agents/logout' ? body.ownerScope : body.options], context.caller) };
    }
    if (url.pathname === '/api/model-visibility/claim') {
        return { status: 200, body: await deps.modelVisibilityClaim() };
    }
    if (url.pathname === '/api/model-access') {
        return { status: 200, body: await deps.modelAccess() };
    }
    if (url.pathname === '/api/model-access/retry') {
        return { status: 200, body: await deps.retryModelAccess() };
    }
    if (url.pathname === '/api/agents/codex-runtime-route') {
        return { status: 200, body: await deps.codexRuntimeRoute() };
    }
    if (url.pathname === '/api/usage/model-pricing') {
        return { status: 200, body: await deps.modelPricing() };
    }
    if (url.pathname === '/api/usage/reference-model-pricing') {
        return { status: 200, body: await deps.referenceModelPricing() };
    }
    if (url.pathname === '/api/model-groups/get') {
        return { status: 200, body: await deps.modelGroups.get(body) };
    }
    if (url.pathname === '/api/model-groups/set') {
        return { status: 200, body: await deps.modelGroups.set(body.config ?? body) };
    }
    if (url.pathname === '/api/model-groups/resolve') {
        return { status: 200, body: await deps.modelGroups.resolve(body) };
    }
    if (url.pathname === '/api/model-groups/commit') {
        return { status: 200, body: await deps.modelGroups.commit(body.decisionId) };
    }
    if (url.pathname === '/api/model-groups/bind-session') {
        return { status: 200, body: (await deps.modelGroups.bindSession(body)) ?? null };
    }
    if (url.pathname === '/api/model-groups/unbind-session') {
        return { status: 200, body: await deps.modelGroups.unbindSession(body) };
    }
    if (url.pathname === '/api/model-groups/get-session-binding') {
        return { status: 200, body: await deps.modelGroups.getSessionBinding(body) };
    }
    if (url.pathname === '/api/model-groups/switch-offer') {
        return { status: 200, body: await deps.modelGroups.switchOffer(body) };
    }
    if (url.pathname === '/api/model-groups/route-note') {
        return { status: 200, body: (await deps.modelGroups.routeNote(body)) ?? null };
    }
    if (url.pathname === '/api/model-groups/decisions') {
        return { status: 200, body: await deps.modelGroups.decisions() };
    }
    if (url.pathname === '/api/agents') {
        return { status: 200, body: await deps.agents() };
    }
    if (url.pathname === '/api/interactions/pending') {
        return { status: 200, body: await deps.interactions.pending(String(body.sessionId ?? '')) };
    }
    if (url.pathname === '/api/interactions/respond') {
        const accepted = deps.interactions.respond(body.sessionId ? String(body.sessionId) : null, String(body.requestId ?? ''), body.decision);
        return { status: accepted ? 200 : 404, body: { ok: accepted, accepted } };
    }
    if (url.pathname === '/api/input/projection') {
        return { status: 200, body: await deps.input.projection(String(body.sessionId ?? '')) };
    }
    if (url.pathname === '/api/input/enqueue') {
        return { status: 200, body: await deps.input.enqueue(String(body.sessionId ?? ''), body.item ?? {}) };
    }
    if (url.pathname === '/api/input/stop') {
        return { status: 200, body: await deps.input.stop(String(body.sessionId ?? '')) };
    }
    if (url.pathname === '/api/input/steer') {
        const result = await deps.input.steer(String(body.sessionId ?? ''), body.item ?? {});
        return { status: 200, body: await (typeof result === 'boolean' ? { ok: result } : { ok: true, projection: result }) };
    }
    if (url.pathname === '/api/input/remove') {
        return { status: 200, body: await deps.input.remove(String(body.sessionId ?? ''), String(body.clientId ?? '')) };
    }
    if (url.pathname === '/api/input/update-content') {
        return { status: 200, body: await deps.input.updateContent(String(body.sessionId ?? ''), String(body.clientId ?? ''), body.item ?? {}) };
    }
    if (url.pathname === '/api/input/update-text') {
        return { status: 200, body: await deps.input.updateText(String(body.sessionId ?? ''), String(body.clientId ?? ''), body.newText) };
    }
    if (url.pathname === '/api/input/move') {
        return { status: 200, body: await deps.input.move(String(body.sessionId ?? ''), String(body.clientId ?? ''), Number(body.targetIndex ?? 0)) };
    }
    if (url.pathname === '/api/input/set-expanded') {
        return { status: 200, body: await deps.input.setExpanded(String(body.sessionId ?? ''), Boolean(body.expanded)) };
    }
    if (url.pathname === '/api/input/set-interaction-lock') {
        return { status: 200, body: await deps.input.setInteractionLock(String(body.sessionId ?? ''), String(body.lockId ?? ''), Boolean(body.locked)) };
    }
    if (url.pathname === '/api/input/set-edit-lock') {
        return { status: 200, body: await deps.input.setEditLock(String(body.sessionId ?? ''), String(body.clientId ?? ''), Boolean(body.locked)) };
    }
    if (url.pathname === '/api/input/clear-session') {
        return { status: 200, body: await deps.input.clearSession(String(body.sessionId ?? '')) };
    }
    if (url.pathname === '/api/input/resume') {
        return { status: 200, body: await deps.input.resume(String(body.sessionId ?? '')) };
    }
    if (url.pathname === '/api/input/retry-last-error') {
        return { status: 200, body: await deps.input.retryLastError(String(body.sessionId ?? '')) };
    }
    if (url.pathname === '/api/input/clear-error') {
        return { status: 200, body: await deps.input.clearError(String(body.sessionId ?? '')) };
    }
    if (url.pathname === '/api/agent-commands') {
        return { status: 200, body: await deps.agentCommands(body) };
    }
    if (url.pathname === '/api/agent-skills') {
        return { status: 200, body: await deps.agentSkills(body) };
    }
    if (url.pathname === '/api/capabilities') {
        try {
            return { status: 200, body: await deps.capabilities(String(body.agentKind ?? '')) };
        }
        catch (error) {
            const agentKind = String(body.agentKind ?? '');
            const message = clientErrorMessage(error);
            return { status: 404, body: { error: 'agent_not_registered', message: agentKind === 'pi' ? "Agent 'pi' is not registered" : message } };
        }
    }
    return { status: 404, body: { error: 'not_found' } };

  };
}
