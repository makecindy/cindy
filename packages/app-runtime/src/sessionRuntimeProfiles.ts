import { eq } from 'drizzle-orm';
import { sessions } from '@cindy/runtime-db/schema';
import { dbToMakerAgentKind } from '@cindy/maker-shared/agent-kind-conversion';
import { pendingHarnessRuntimeMutation } from './pendingHarnessRuntimeMutation.js';
import type { SessionRuntimeProfile } from './sessionRuntimeControl.js';
import type { SessionModelSelectionHost } from './sessionModelSelectionHost.js';
/** Original profile reader: persisted baseline, live route, and pending native selection. */
export function createSessionRuntimeProfiles(host: {maker: Pick<SessionModelSelectionHost['maker'], 'getSession' | 'getSessionMeta'>} & Pick<SessionModelSelectionHost,
 'getDbClient' | 'log' | 'getSessionRuntimeControlSnapshot' | 'hasSessionProvider' |
 'getSessionProvider' | 'getSessionEffort' | 'getSessionFastMode' | 'agentSwitchPending'>) {
 const { maker, getDbClient, log, getSessionRuntimeControlSnapshot, hasSessionProvider, getSessionProvider, getSessionEffort, getSessionFastMode, agentSwitchPending } = host;
  const readSessionRuntimeProfiles = async (sessionId: string) => {
    const meta = await maker.getSessionMeta(sessionId);
    if (!meta) return null;
    let baseline: SessionRuntimeProfile = {
      agentKind: meta.agentKind,
      model: meta.model,
      providerId: null,
      effort: meta.effort ?? null,
      fastMode: (meta.fastMode === 'ultrafast' ? 'ultrafast' : meta.fastMode === true),
    };
    try {
      const [row] = await getDbClient()
        .drizzle.select({
          agentKind: sessions.agentKind,
          agentDeviceId: sessions.agentDeviceId,
          model: sessions.model,
          providerId: sessions.providerId,
          effort: sessions.effort,
          fastMode: sessions.fastMode,
        })
        .from(sessions)
        .where(eq(sessions.id, sessionId))
        .limit(1);
      if (row) {
        baseline = {
          agentKind: dbToMakerAgentKind(row.agentKind),
          agentDeviceId: row.agentDeviceId,
          model: row.model,
          providerId: row.providerId?.trim() || null,
          effort: row.effort,
          fastMode: (row.fastMode === 'ultrafast' ? 'ultrafast' : row.fastMode === true),
        };
      }
    } catch (error) {
      log.debug('session runtime baseline lookup failed', {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    const control = getSessionRuntimeControlSnapshot(sessionId);
    const live = maker.getSession(sessionId);
    const effective: SessionRuntimeProfile = control.effectiveOverride ?? {
      agentDeviceId: baseline.agentDeviceId,
      agentKind: live?.agentKind ?? meta.agentKind,
      model: live?.model ?? meta.model,
      providerId: hasSessionProvider(sessionId)
        ? getSessionProvider(sessionId)
        : baseline.providerId,
      effort:
        (getSessionEffort(sessionId) as SessionRuntimeProfile['effort']) ?? meta.effort ?? null,
      fastMode: live ? getSessionFastMode(sessionId) : (meta.fastMode ?? false),
    };
    const pendingMutation = pendingHarnessRuntimeMutation(agentSwitchPending.get(sessionId), control.generation)
      ?? control.pending;
    return { baseline, effective, control, pendingMutation };
  };

 return readSessionRuntimeProfiles;
}
