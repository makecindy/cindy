import type { Session, SessionMeta } from '@cindy/maker-core';

import { getSessionRowSnapshot } from '../localDb/ipc/sessions.js';
import { markOrcaMcpHydratedIfNeeded } from '../maker-ipc/orcaMcpHydrationCache.js';
import { preparePersistedOrcaSessionStart } from '../maker-ipc/orcaSessionStartOptions.js';
import type { MakerSessionCreateOpts } from '../maker-ipc/sessionRequest.js';
import { wireSessionToIpc } from '../maker-ipc/register.js';
import { hydrateSessionProvider } from '../maker-host/session-provider-store.js';
import type { SessionLike } from './types.js';

interface GoalSessionRestoreMaker {
  getSession(sessionId: string): SessionLike | undefined;
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
  if (live) return live;

  const meta = await deps.maker.getSessionMeta(sessionId).catch(() => null);
  if (!meta) {
    deps.warn('[goal-host] cannot resume session (no meta)', { sessionId });
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
      providerId: row?.providerId ?? undefined,
    };

    await (deps.prepareOrcaStart ?? preparePersistedOrcaSessionStart)(sessionId, opts);
    (deps.hydrateProvider ?? hydrateSessionProvider)(sessionId, row?.providerId ?? null);

    const session = await deps.maker.createSession(opts);
    (deps.markOrcaHydrated ?? markOrcaMcpHydratedIfNeeded)(session.id, opts);
    (deps.wireSession ?? wireSessionToIpc)(session);
    return session;
  } catch (err) {
    deps.warn('[goal-host] ensureSession createSession failed', {
      sessionId,
      error: String(err),
    });
    return undefined;
  }
}
