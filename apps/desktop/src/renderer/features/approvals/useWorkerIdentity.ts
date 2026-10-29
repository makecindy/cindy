import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { shouldShowWorkerLabel } from '@cindy/maker-shared/orca-team';

import { getDataOwnerGeneration, isDataOwnerGenerationCurrent } from '@/contexts/dataOwnerGeneration';
import { getSessionDisplayTitle } from '@/features/cc-agent/lib/sessionDisplayTitle';
import type { Session } from '@/lib/ccAgent.types';
import { getSessionFor, orcaWorkflowsFor } from '@/lib/makerTransport';

import { pathBaseName } from './approvalFormat';

/**
 * Who is asking. Shape and cost (measured from the code, not guessed):
 *   getSessionFor(sessionId)                              1 call per session (sticky device aware)
 *   orcaWorkflowsFor(id).getByWorkerSession(id)           1 call per Worker -> { leadSessionId }, no team name
 *   orcaWorkflowsFor(id).listWorkersByLead(leadId)        1 call per Lead, shared by all its Workers
 *   getSessionFor(leadSessionId)                          1 call per Lead; its title is the "parent task"
 *   electronAPI.localDb.orcaWorkflows.projectLabel(id)    1 local call per Worker -> { name, path } | null
 * Every step tolerates null / rejection, so a failed lookup only removes that line of detail.
 * Results are cached per data owner and cleared by Refresh.
 */
export interface RawIdentity {
  session: Session | null;
  role: string | null;
  label: string | null;
  leadSession: Session | null;
  project: { name: string; path: string | null } | null;
}

interface WorkerRecordLike { sessionId?: string; role?: string; label?: string | null }

const identities = new Map<string, Promise<RawIdentity>>();
/** Settled results, so a row that remounts (queue <-> detail, replacement request) never flashes an empty name. */
const resolved = new Map<string, RawIdentity>();
const leadWorkers = new Map<string, Promise<WorkerRecordLike[]>>();
const leadSessions = new Map<string, Promise<Session | null>>();

const scope = () => {
  const owner = getDataOwnerGeneration();
  return `${owner.dataOwnerId}|${owner.generation}|`;
};

export function invalidateWorkerIdentity(): void {
  identities.clear();
  resolved.clear();
  leadWorkers.clear();
  leadSessions.clear();
}

function once<T>(cache: Map<string, Promise<T>>, key: string, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit) return hit;
  const created = load();
  cache.set(key, created);
  return created;
}

async function loadIdentity(sessionId: string, prefix: string): Promise<RawIdentity> {
  const session = await getSessionFor(sessionId).catch(() => null);
  const result: RawIdentity = {
    session, role: null, label: null, leadSession: null,
    project: pathBaseName(session?.workingDir)
      ? { name: pathBaseName(session?.workingDir)!, path: session?.workingDir ?? null }
      : null,
  };
  if (session?.orcaRole !== 'worker') return result;

  const orca = orcaWorkflowsFor(sessionId);
  const [team, label] = await Promise.all([
    Promise.resolve(orca.getByWorkerSession(sessionId)).catch(() => null) as Promise<{ leadSessionId?: string } | null>,
    Promise.resolve(window.electronAPI?.localDb?.orcaWorkflows?.projectLabel?.(sessionId)).catch(() => null) as
      Promise<{ name?: string; path?: string } | null | undefined>,
  ]);
  if (label?.name) result.project = { name: label.name, path: label.path ?? result.project?.path ?? null };
  const leadId = team?.leadSessionId;
  if (!leadId) return result;

  const [workers, lead] = await Promise.all([
    once(leadWorkers, prefix + leadId, () =>
      Promise.resolve(orca.listWorkersByLead(leadId)).then((list) => (Array.isArray(list) ? list as WorkerRecordLike[] : []))
        .catch(() => [])),
    once(leadSessions, prefix + leadId, () => getSessionFor(leadId).catch(() => null)),
  ]);
  const me = workers.find((worker) => worker.sessionId === sessionId);
  result.role = me?.role || null;
  result.label = me?.label ?? null;
  result.leadSession = lead;
  return result;
}

export function loadWorkerIdentity(sessionId: string): Promise<RawIdentity> {
  const prefix = scope();
  return once(identities, prefix + sessionId, () => loadIdentity(sessionId, prefix).then((value) => {
    resolved.set(prefix + sessionId, value);
    return value;
  }));
}

export interface WorkerIdentity {
  loading: boolean;
  name: string;
  role: string | null;
  parentTitle: string | null;
  projectName: string | null;
  projectPath: string | null;
  session: Session | null;
}

/** Lazily resolved identity of the session behind a request; `version` forces a fresh lookup. */
export function useWorkerIdentity(sessionId: string, version = 0): WorkerIdentity {
  const { t } = useTranslation();
  const [raw, setRaw] = useState<RawIdentity | null>(() => resolved.get(scope() + sessionId) ?? null);
  useEffect(() => {
    let cancelled = false;
    const owner = getDataOwnerGeneration();
    void loadWorkerIdentity(sessionId).then((value) => {
      if (!cancelled && isDataOwnerGenerationCurrent(owner)) setRaw(value);
    });
    return () => { cancelled = true; };
  }, [sessionId, version]);

  const unnamed = t('approvalsInbox.unnamed');
  const named = raw?.role
    ? (shouldShowWorkerLabel(raw.role, raw.label) ? `${raw.role} #${raw.label}` : raw.role)
    : raw?.session ? getSessionDisplayTitle(raw.session, unnamed, t) : unnamed;
  return {
    loading: raw === null,
    name: raw === null ? '' : named,
    role: raw?.role ?? null,
    parentTitle: raw?.leadSession ? getSessionDisplayTitle(raw.leadSession, unnamed, t) : null,
    projectName: raw?.project?.name ?? null,
    projectPath: raw?.project?.path ?? null,
    session: raw?.session ?? null,
  };
}
