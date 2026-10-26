/**
 * Rebuild live sessions after a Claude account switch.
 *
 * A CLI process gets its env (and so its account) at spawn, so a switch only reaches a live
 * session through a rebuild that resumes the same session id. The host's `rebuild` reuses
 * the credential-switch path: an idle session is closed now and resumes on the next send; a
 * busy one registers a pending rebuild that runs when its turn ends. A running turn always
 * finishes on its original account.
 *
 * Not affected: SSH remote sessions (their config dir belongs to the remote host),
 * non-subscription routes (API key / provider) and other harnesses.
 */
export interface LiveSessionInfo {
  id: string;
  agentKind: string;
  remoteHostId: string | null | undefined;
  providerId: string | null;
}

export interface AccountSwitchRebuildDeps {
  listLiveSessions: () => LiveSessionInfo[];
  isSubscriptionRoute: (session: LiveSessionInfo) => boolean;
  rebuild: (sessionId: string) => Promise<'applied' | 'deferred'>;
  log?: { warn: (message: string, meta?: Record<string, unknown>) => void };
}

export async function rebuildSessionsForAccountSwitch(
  deps: AccountSwitchRebuildDeps,
): Promise<{ applied: string[]; deferred: string[]; failed: string[] }> {
  const result = { applied: [] as string[], deferred: [] as string[], failed: [] as string[] };
  const targets = deps
    .listLiveSessions()
    .filter((s) => s.agentKind === 'claude-code' && !s.remoteHostId && deps.isSubscriptionRoute(s));
  for (const session of targets) {
    try {
      result[await deps.rebuild(session.id)].push(session.id);
    } catch (err) {
      result.failed.push(session.id);
      deps.log?.warn('claude account switch: session rebuild failed', {
        sessionId: session.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return result;
}
