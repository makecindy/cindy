import { clientErrorMessage } from './client-error.mjs';

/** Owner business operations shared by HTTP and authenticated Device Link.
 * Transport admission and owner leases belong to the caller. No synthetic HTTP
 * request, loopback bearer or renderer sender is created for remote clients.
 */
export function createHostService(deps) {
  return async function invoke(pathname, body = {}, context = {}) {
    const url = { pathname };

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
        return { status: 200, body: await deps.updateSession(String(body.sessionId ?? ''), body.patch ?? {}) };
    }
    if (url.pathname === '/api/sessions/switch-agent') {
        return { status: 200, body: await deps.switchSessionAgent(String(body.sessionId ?? ''), String(body.targetAgentKind ?? ''), String(body.model ?? ''), body.providerId ?? null, body.effort, body.fastMode) };
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
        return { status: 200, body: await deps.historyView(String(body.sessionId ?? ''), body.before ?? null) };
    }
    if (url.pathname === '/api/messages/work-details') {
        return { status: 200, body: await deps.workDetails(String(body.sessionId ?? ''), body.ref, body.after ?? null) };
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
