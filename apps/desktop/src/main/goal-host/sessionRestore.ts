import type { AgentKind, EngineKind, Session, SessionMeta } from '@cindy/maker-core';

import { getSessionRowSnapshot } from '../localDb/ipc/sessions.js';
import { markOrcaMcpHydratedIfNeeded } from '../maker-ipc/orcaMcpHydrationCache.js';
import { preparePersistedOrcaSessionStart } from '../maker-ipc/orcaSessionStartOptions.js';
import type { MakerSessionCreateOpts } from '../maker-ipc/sessionRequest.js';
import { wireSessionToIpc } from '../maker-ipc/register.js';
import { isPluginEngineTask } from '../maker-host/engineKind.js';
import { hydrateSessionProvider } from '../maker-host/session-provider-store.js';
import type { SessionLike } from './types.js';

/** A live Maker session may run on a plugin engine; Goal only accepts built-in ones. */
type GoalRestoreLiveSession = Omit<SessionLike, 'agentKind'> & { readonly agentKind: EngineKind };

const PLUGIN_ENGINE_GOAL_UNAVAILABLE = '[goal-host] goals are not available for plugin-engine tasks';

/**
 * Goals do not run on plugin engines (docs/plans/acp-plugin-bridge.md). Refuses only
 * those; every other session keeps its existing Goal path unchanged.
 */
function isGoalEngineSession<T extends { readonly agentKind: EngineKind }>(
  session: T,
): session is T & { readonly agentKind: AgentKind } {
  return !isPluginEngineTask(session);
}

interface GoalSessionRestoreMaker {
  getSession(sessionId: string): GoalRestoreLiveSession | undefined;
  getSessionMeta(sessionId: string): Promise<SessionMeta | null>;
  createSession(opts: MakerSessionCreateOpts): Promise<Session>;
}

interface GoalSessionRow {
  providerId: string | null;
}

/** Injectable seams keep the dormant-session restore ordering deterministic in tests. */
export interface RestoreGoalSessionDeps {
  maker: GoalSessionRestoreMaker;
  warn(message: string, meta: Record<string, unknown>): void;
  getSessionRow?: (sessionId: string) => Promise<GoalSessionRow | null>;
  hydrateProvider?: (sessionId: string, providerId: string | null) => void;
  prepareOrcaStart?: (sessionId: string, opts: MakerSessionCreateOpts) => Promise<boolean>;
  markOrcaHydrated?: (sessionId: string, opts: MakerSessionCreateOpts) => void;
  wireSession?: (session: Session) => void;
}

/**
 * Resume a dormant Goal session with the same persisted Orca context as SEND.
 * Orca options must be reconstructed before Maker's singleflight boundary so a
 * concurrent rehydrate can only join a correctly configured startup.
 */
export async function restoreSessionForGoal(
  sessionId: string,
  deps: RestoreGoalSessionDeps,
): Promise<SessionLike | undefined> {
  const live = deps.maker.getSession(sessionId);
  // A failed close leaves the Session in Maker's live map with status=error.
  // Do not hand that poisoned object back to Goal: Maker.createSession owns the
  // retry-close-then-rebuild boundary for this exact state.
  if (live && live.getStatus?.() !== 'error') {
    if (isGoalEngineSession(live)) return live;
    deps.warn(PLUGIN_ENGINE_GOAL_UNAVAILABLE, { sessionId });
    return undefined;
  }

  const meta = await deps.maker.getSessionMeta(sessionId).catch(() => null);
  if (!meta) {
    deps.warn('[goal-host] cannot resume session (no meta)', { sessionId });
    return undefined;
  }
  // Goals are not available on plugin engines (docs/plans/acp-plugin-bridge.md):
  // never resume such a task, and never resume it on a built-in engine instead.
  if (isPluginEngineTask(meta)) {
    deps.warn(PLUGIN_ENGINE_GOAL_UNAVAILABLE, { sessionId });
    return undefined;
  }

  try {
    const row = await (deps.getSessionRow ?? getSessionRowSnapshot)(sessionId);
    const opts: MakerSessionCreateOpts = {
      id: sessionId,
      agentKind: meta.agentKind,
      workingDir: meta.workDir,
      model: meta.model,
      effort: meta.effort,
      permissionMode: meta.permissionMode,
      fastMode: meta.fastMode,
      resumeSessionId: meta.sdkSessionId,
      remoteHostId: meta.remoteHostId,
      // A persisted null explicitly selects the Cindy default route for Pi;
      // only a missing row has no route value to pass through.
      providerId: row?.providerId,
    };

    await (deps.prepareOrcaStart ?? preparePersistedOrcaSessionStart)(sessionId, opts);
    (deps.hydrateProvider ?? hydrateSessionProvider)(sessionId, row?.providerId ?? null);

    const session = await deps.maker.createSession(opts);
    (deps.markOrcaHydrated ?? markOrcaMcpHydratedIfNeeded)(session.id, opts);
    (deps.wireSession ?? wireSessionToIpc)(session);
    if (!isGoalEngineSession(session)) {
      deps.warn(PLUGIN_ENGINE_GOAL_UNAVAILABLE, { sessionId });
      return undefined;
    }
    return session;
  } catch (err) {
    deps.warn('[goal-host] ensureSession createSession failed', {
      sessionId,
      error: String(err),
    });
    return undefined;
  }
}
