import { useMemo, useRef } from 'react';
import { useStableValue } from '@/utils/useStableValue';
import { mapContentEqual } from '@/utils/valueEquality';
import { remoteSessionStore } from './remoteSessionStore';
import type { RemoteSession } from './types';

type SessionSignals = Pick<typeof remoteSessionStore,
  'getPendingInteractions' | 'getSessionLiveActivity'>;

/** Derive list badges and tap destinations from the same device-scoped snapshot. */
export function projectOrcaQuestionRows(sessions: readonly RemoteSession[], signals: SessionSignals) {
  const pendingCounts = new Map<string, number>();
  const workerTargets = new Map<string, RemoteSession>();
  const visibleWorkers = new Set<string>();
  const leads = new Map(sessions.filter(s => s.orcaRole === 'lead' && s.status === 'active').map(s => [s.id, s]));
  const ownQuestions = new Set<string>();
  for (const session of sessions) {
    const device = session.deviceLinkDeviceId;
    const pending = signals.getPendingInteractions(session.id, device);
    if (pending.length) pendingCounts.set(session.id, (pendingCounts.get(session.id) ?? 0) + pending.length);
    const remote = session.orcaRemoteLead;
    if (session.status !== 'active' || (!session.orcaRole && !remote)) continue;
    if (session.orcaHasPendingQuestion === false) continue;
    const live = signals.getSessionLiveActivity(session.id, device);
    const waiting = session.orcaHasPendingQuestion ??
      (live?.phase === 'needs-interaction' && (!live.interactionKind || live.interactionKind === 'ask_user_question'));
    const questions = pending.filter(item => item.request.kind === 'ask_user_question').length || Number(waiting);
    if (!questions) continue;
    if (session.orcaRole === 'lead') {
      ownQuestions.add(session.id);
      continue;
    }
    if (remote?.releasedAt) continue;
    const leadId = remote?.leadSessionId ?? session.orcaLeadSessionId;
    const lead = leadId ? leads.get(leadId) : undefined;
    const ownerDevice = remote?.leadDeviceId ?? device;
    if (!lead || (lead.deviceLinkDeviceId !== ownerDevice && lead.canonicalDeviceId !== ownerDevice)) {
      // Old Hosts and partial lists may omit team membership. Keep the actionable row reachable.
      if (session.orcaRole === 'worker') {
        visibleWorkers.add(session.id);
        pendingCounts.set(session.id, Math.max(questions, pending.length));
      }
      continue;
    }
    pendingCounts.set(lead.id, (pendingCounts.get(lead.id) ?? 0) + questions);
    if (!workerTargets.has(lead.id)) workerTargets.set(lead.id, session);
  }
  for (const id of ownQuestions) workerTargets.delete(id);
  return { pendingCounts, workerTargets, visibleWorkers };
}

export function useOrcaQuestionRows(sessions: readonly RemoteSession[], homeStatusVersion: number) {
  const rows = useMemo(() => projectOrcaQuestionRows(sessions, remoteSessionStore), [sessions, homeStatusVersion]);
  const pendingInteractionIndex = useStableValue(rows.pendingCounts, mapContentEqual);
  const visibleWorkerIds = useStableValue(rows.visibleWorkers, (a, b) => a.size === b.size && [...a].every(id => b.has(id)));
  // Row callbacks stay stable as activity changes. Read the current destination only on tap.
  const workerTargets = useRef(rows.workerTargets);
  workerTargets.current = rows.workerTargets;
  return { pendingInteractionIndex, visibleWorkerIds, workerTargets };
}
