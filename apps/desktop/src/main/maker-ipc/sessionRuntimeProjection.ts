/**
 * The runtime projection of a task that the desktop broadcasts after a runtime change (model,
 * provider, effort, fast mode), and the update of a scheduled task's saved preferences. Moved
 * verbatim out of register.ts so the Node Host runs the same steps; register.ts binds the ports.
 *
 * - A task with a saved scheduled baseline projects that baseline (scheduled preferences win over the
 *   task row); otherwise the task row, or the caller's baseline, through projectSessionRuntimeControl.
 * - updateScheduledPreference writes the saved baseline only when it is still the one the caller read
 *   (or when the caller passed none), then broadcasts the projection.
 *
 * The broadcast itself (localDb/ipc/sessions.ts, which loads Electron) comes in as a port.
 */
import { and, eq } from 'drizzle-orm';
import { dbToMakerAgentKind, makerToDbAgentKind } from '../../shared/agentKindConversion.js';
import { parseScheduledModelBaseline, type ScheduledModelBaseline } from '../../shared/scheduledModelBaseline';
import { getDbClient } from '../localDb/client/current.js';
import { sessions } from '../localDb/schema.js';
import type { ScheduledModelSelection } from './scheduledModelSelection';
import { projectSessionRuntimeControl, type SessionRuntimeProfile } from './sessionRuntimeControl.js';

export interface SessionRuntimeProjectionPorts {
  broadcastSessionPatched: typeof import('../localDb/ipc/sessions.js').broadcastSessionPatched;
}

/** broadcastSessionRuntimeProjection and projectScheduledPreferences, as register.ts declared them. */
export function createSessionRuntimeProjection(ports: SessionRuntimeProjectionPorts) {
  const { broadcastSessionPatched } = ports;

  const broadcastSessionRuntimeProjection = async (
    sessionId: string,
    baselineOverride?: SessionRuntimeProfile,
  ): Promise<void> => {
    const [saved] = await getDbClient().drizzle
      .select({ value: sessions.scheduledModelBaseline }).from(sessions)
      .where(eq(sessions.id, sessionId)).limit(1);
    const scheduledBaseline = parseScheduledModelBaseline(saved?.value);
    if (scheduledBaseline) {
      broadcastSessionPatched(sessionId, projectScheduledPreferences(sessionId, scheduledBaseline));
      return;
    }
    let baseline = baselineOverride;
    if (!baseline) {
      const [row] = await getDbClient()
        .drizzle.select({
          agentKind: sessions.agentKind,
          model: sessions.model,
          providerId: sessions.providerId,
          effort: sessions.effort,
          fastMode: sessions.fastMode,
        })
        .from(sessions)
        .where(eq(sessions.id, sessionId))
        .limit(1);
      if (!row) return;
      baseline = {
        agentKind: dbToMakerAgentKind(row.agentKind),
        model: row.model,
        providerId: row.providerId?.trim() || null,
        effort: row.effort,
        fastMode: (row.fastMode === 'ultrafast' ? 'ultrafast' : row.fastMode === true),
      };
    }
    broadcastSessionPatched(
      sessionId,
      projectSessionRuntimeControl(sessionId, baseline) as Record<string, unknown>,
    );
  };
  const projectScheduledPreferences = (sessionId: string, saved: ScheduledModelBaseline) => {
    const baseline: ScheduledModelSelection = {
      agentKind: saved.agentKind, model: saved.model, providerId: saved.providerId,
      ...(saved.agentDeviceId !== undefined ? { agentDeviceId: saved.agentDeviceId } : {}),
      effort: saved.effort, fastMode: saved.fastMode,
    };
    return {
      ...projectSessionRuntimeControl(sessionId, baseline),
      agentKind: makerToDbAgentKind(baseline.agentKind),
      ...(baseline.agentDeviceId !== undefined ? { agentDeviceId: baseline.agentDeviceId } : {}),
      model: baseline.model,
      providerId: baseline.providerId,
      effort: baseline.effort ?? '',
      fastMode: baseline.fastMode,
      runtimeBaseline: baseline,
      runtimeEffective: baseline,
      runtimePending: null,
      runtimeBaselineRecoveryPending: !saved.pendingBotProfileVersion,
    };
  };
  return { broadcastSessionRuntimeProjection, projectScheduledPreferences };
}

/** updateScheduledPreference, as register.ts declared it. */
export function createUpdateScheduledPreference(ports: {
  broadcastSessionRuntimeProjection: ReturnType<typeof createSessionRuntimeProjection>['broadcastSessionRuntimeProjection'];
}) {
  const { broadcastSessionRuntimeProjection } = ports;
  const updateScheduledPreference = async (
    sessionId: string, patch: { effort?: ScheduledModelSelection['effort']; fastMode?: ScheduledModelSelection['fastMode'] } | null,
    expectedBaseline?: string | null,
  ) => {
    const db = getDbClient().drizzle;
    const [row] = await db.select({ baseline: sessions.scheduledModelBaseline }).from(sessions)
      .where(eq(sessions.id, sessionId)).limit(1);
    const baseline = parseScheduledModelBaseline(row?.baseline);
    if (expectedBaseline !== undefined && row?.baseline !== expectedBaseline) return false;
    if (!baseline) return true;
    const updated = await db.update(sessions).set({
      scheduledModelBaseline: patch ? JSON.stringify({ ...baseline, ...patch }) : null,
    }).where(and(eq(sessions.id, sessionId), eq(sessions.scheduledModelBaseline, row.baseline!)))
      .returning({ id: sessions.id });
    if (!updated.length) return false;
    await broadcastSessionRuntimeProjection(sessionId);
    return true;
  };
  return updateScheduledPreference;
}
