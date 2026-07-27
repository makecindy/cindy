import {
  parseOrcaInitialWorkerRef,
  renderOrcaLeadSystemPrompt,
  renderOrcaWorkerSystemPrompt,
} from '@cindy/orca-workflow';

import { getSessionOrcaRole, getWorkerLink } from '../localDb/orcaTeamStore.js';
import { createLogger } from '../logger.js';
import type { MakerSessionCreateOpts } from './sessionRequest.js';
import {
  knownNonOrcaSessionIds,
  readOrcaRoleFromVendorOptions,
} from './orcaMcpHydrationCache.js';

type OrcaRole = 'lead' | 'worker';

interface OrcaWorkerLink {
  workerId: string;
  teamId: string;
  leadSessionId: string;
  idleSince: string | null;
  updatedAt: string;
}

export interface OrcaSessionStartOptionsDeps {
  getSessionRole(sessionId: string): Promise<OrcaRole | null>;
  getWorkerLink(workerSessionId: string): Promise<OrcaWorkerLink | null>;
  warn(message: string, meta: Record<string, unknown>): void;
  now?(): number;
}

const log = createLogger('maker-ipc:orca-session-start');

const defaultDeps: OrcaSessionStartOptionsDeps = {
  getSessionRole: getSessionOrcaRole,
  getWorkerLink: (workerSessionId) => getWorkerLink({ workerSessionId }),
  warn: (message, meta) => log.warn(message, meta),
  now: Date.now,
};

function runtimeReleaseVendorOptions(
  link: OrcaWorkerLink,
  now: number,
): Record<string, unknown> {
  if (link.idleSince === null) return { orcaRuntimeReleased: false };
  const expectedIdleSince = Date.parse(link.idleSince);
  const expectedUpdatedAt = Date.parse(link.updatedAt);
  return {
    orcaRuntimeReleased: true,
    orcaRuntimeReleaseIdleSince: expectedIdleSince,
    orcaRuntimeReleaseUpdatedAt: expectedUpdatedAt,
    orcaRuntimeResumedAt: Math.max(now, expectedUpdatedAt + 1),
  };
}

/**
 * 从持久化 role/link 恢复 Orca session 启动参数。所有 dormant resume 入口必须在
 * maker.createSession 前调用，避免普通后台恢复抢先创建出缺 Orca MCP context 的 handle。
 */
export async function synthesizeOrcaVendorOptionsFromDb(
  sessionId: string,
  o: MakerSessionCreateOpts,
  deps: OrcaSessionStartOptionsDeps = defaultDeps,
): Promise<boolean> {
  const existingRole = readOrcaRoleFromVendorOptions(o.vendorOptions);
  if (existingRole === 'lead') {
    o.orcaRole ??= 'lead';
    if (typeof o.vendorOptions?.orcaLeadSessionId !== 'string') {
      o.vendorOptions = { ...(o.vendorOptions ?? {}), orcaLeadSessionId: sessionId };
    }
    return true;
  }
  if (existingRole === 'worker') {
    o.orcaRole ??= 'worker';
    if (o.resumeSessionId) {
      const link = await deps.getWorkerLink(sessionId);
      if (link) {
        o.vendorOptions = {
          ...(o.vendorOptions ?? {}),
          ...runtimeReleaseVendorOptions(link, deps.now?.() ?? Date.now()),
        };
      }
    }
    return true;
  }

  const hasExplicitRole = o.orcaRole === 'lead' || o.orcaRole === 'worker';
  if (hasExplicitRole) {
    knownNonOrcaSessionIds.delete(sessionId);
  } else if (knownNonOrcaSessionIds.has(sessionId)) {
    return false;
  }

  const persistedRole = await deps.getSessionRole(sessionId);
  if (persistedRole === 'lead') {
    o.orcaRole = 'lead';
    o.vendorOptions = {
      ...(o.vendorOptions ?? {}),
      orcaRole: 'lead',
      orcaLeadSessionId: sessionId,
    };
    return true;
  }
  if (persistedRole === 'worker') {
    const link = await deps.getWorkerLink(sessionId);
    if (!link) {
      deps.warn('orca resume: worker link missing for persisted worker session', { sessionId });
      return false;
    }
    o.orcaRole = 'worker';
    o.vendorOptions = {
      ...(o.vendorOptions ?? {}),
      orcaRole: 'worker',
      orcaWorkflowId: link.teamId,
      orcaLeadSessionId: link.leadSessionId,
      orcaWorkerId: link.workerId,
      orcaWorkerSessionId: sessionId,
      ...runtimeReleaseVendorOptions(link, deps.now?.() ?? Date.now()),
    };
    return true;
  }
  if (!hasExplicitRole) {
    knownNonOrcaSessionIds.add(sessionId);
  }
  return false;
}

/** Inject the role-specific Orca instructions into the stable session startup prompt. */
export function applyOrcaInstructions(o: MakerSessionCreateOpts): boolean {
  const vendorOptions = o.vendorOptions;
  if (!vendorOptions) return false;
  const role = vendorOptions.orcaRole;
  let prompt: string | null = null;
  if (role === 'lead') {
    const initialWorker = parseOrcaInitialWorkerRef(vendorOptions.initialWorker);
    prompt = renderOrcaLeadSystemPrompt(initialWorker);
  } else if (role === 'worker') {
    const workerId = typeof vendorOptions.orcaWorkerId === 'string'
      ? vendorOptions.orcaWorkerId
      : null;
    const sessionId = typeof vendorOptions.orcaWorkerSessionId === 'string'
      ? vendorOptions.orcaWorkerSessionId
      : typeof o.id === 'string'
        ? o.id
        : null;
    const teamId = typeof vendorOptions.orcaWorkflowId === 'string'
      ? vendorOptions.orcaWorkflowId
      : null;
    const leadSessionId = typeof vendorOptions.orcaLeadSessionId === 'string'
      ? vendorOptions.orcaLeadSessionId
      : null;
    if (workerId && sessionId && teamId && leadSessionId) {
      prompt = renderOrcaWorkerSystemPrompt({
        workerId,
        sessionId,
        workflowId: teamId,
        leadSessionId,
      });
    }
  }
  if (!prompt) return false;
  if (o.userPrompt && `\n\n${o.userPrompt}\n\n`.includes(`\n\n${prompt}\n\n`)) return true;
  o.userPrompt = o.userPrompt ? `${o.userPrompt}\n\n${prompt}` : prompt;
  return true;
}

export async function preparePersistedOrcaSessionStart(
  sessionId: string,
  o: MakerSessionCreateOpts,
  deps: OrcaSessionStartOptionsDeps = defaultDeps,
): Promise<boolean> {
  await synthesizeOrcaVendorOptionsFromDb(sessionId, o, deps);
  return applyOrcaInstructions(o);
}
