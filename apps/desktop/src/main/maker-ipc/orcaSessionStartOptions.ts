import { LOCAL_AGENT_CLIENT } from '@cindy/maker-core';
import {
  parseOrcaInitialWorkerRef,
  renderOrcaLeadSystemPrompt,
  renderOrcaWorkerSystemPrompt,
} from '@cindy/orca-workflow';

import {
  getSessionOrcaRole, getWorkerLink, getRemoteOrcaSession, listWorkersByLead, type OrcaWorkerRecord,
} from '../localDb/orcaTeamStore.js';
import type { OrcaRemoteLead } from '../../shared/orcaRemoteWorker.js';
import { createLogger } from '../logger.js';
import type { SessionRowSnapshot } from '../localDb/sessionDispatchSnapshot.js';
import { collabProjectUnavailableReason } from './collabProjectPolicy.js';
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
}

export interface OrcaSessionStartOptionsDeps {
  getSessionRole(sessionId: string): Promise<OrcaRole | null>;
  getWorkerLink(workerSessionId: string): Promise<OrcaWorkerLink | null>;
  getRemoteLead?(sessionId: string): Promise<OrcaRemoteLead | null>;
  listWorkersByLead?(sessionId: string): Promise<ReadonlyArray<Pick<OrcaWorkerRecord, 'id' | 'sessionId' | 'teamId'>>>;
  warn(message: string, meta: Record<string, unknown>): void;
}

const log = createLogger('maker-ipc:orca-session-start');

const defaultDeps: OrcaSessionStartOptionsDeps = {
  getSessionRole: getSessionOrcaRole,
  getWorkerLink: (workerSessionId) => getWorkerLink({ workerSessionId }),
  getRemoteLead: async sessionId => (await getRemoteOrcaSession(sessionId))?.orcaRemoteLead ?? null,
  listWorkersByLead,
  warn: (message, meta) => log.warn(message, meta),
};

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
    };
    return true;
  }
  if (!hasExplicitRole) {
    const lead = await deps.getRemoteLead?.(sessionId);
    if (lead && lead.releasedAt === undefined) {
      // Enable the bridge for Claude too, without inventing a local Worker/team role.
      o.vendorOptions = { ...(o.vendorOptions ?? {}), orcaRemoteWorker: true, orcaRemoteLead: lead };
      return true;
    }
    knownNonOrcaSessionIds.add(sessionId);
  }
  return false;
}

const orcaDiscoveryPrompt =
  'Cindy Orca teams have independent Worker sessions the user can see and follow up with. ' +
  'When the user asks to start a collaboration team or to use Orca Workers, use start_team on cindy_orca. ' +
  'When they ask for a subagent, use the engine’s native subagent capability; if unavailable, tell the user.';

// Only the interactive create-session handler can assert a new ordinary task
// before Maker has persisted its row. Never infer this from a database error.
export const ORCA_DIRECT_TASK_CREATE = Symbol('orca-direct-task-create');

type OrcaDiscoveryStartOptions = Pick<MakerSessionCreateOpts,
  'agentKind' | 'reviewMode' | 'botRuntimeProfile' | 'orcaRole' | 'vendorOptions' |
  'workingDir' | 'workspaceKind' | 'remoteHostId' | 'agentDeviceId' | 'userPrompt' | 'resumeSessionId' | typeof LOCAL_AGENT_CLIENT
> & { [ORCA_DIRECT_TASK_CREATE]?: true };

/** Runs on the startup copy of options, after resolving the persisted role. */
export function appendOrcaDiscoveryPrompt(
  opts: OrcaDiscoveryStartOptions,
  row: Pick<SessionRowSnapshot, 'workingDir' | 'workspaceKind' | 'remoteHostId' | 'source' | 'orcaRole' | 'orcaRemoteLead'> | null | undefined,
  isPluginEnabled: (pluginId: 'collab', workingDir?: string) => boolean,
  isManagedDialogueWorkspace: (workingDir: string) => boolean,
): void {
  if (row === null && opts[ORCA_DIRECT_TASK_CREATE] && !opts.resumeSessionId) {
    row = { source: 'desktop', workingDir: null, workspaceKind: null };
  }
  if (!row || opts.reviewMode || opts.botRuntimeProfile || opts[LOCAL_AGENT_CLIENT] || opts.agentKind === 'acp' ||
      opts.orcaRole || opts.vendorOptions?.orcaRole || opts.vendorOptions?.orcaRemoteWorker ||
      row.orcaRole || row.orcaRemoteLead ||
      (row.source !== 'desktop' && row.source !== 'side-chat')) return;
  const context = {
    workingDir: row.workingDir ?? opts.workingDir,
    workspaceKind: opts.workspaceKind ?? row.workspaceKind,
    remoteHostId: opts.remoteHostId ?? row.remoteHostId,
  };
  if (collabProjectUnavailableReason(context, isPluginEnabled, isManagedDialogueWorkspace)) return;
  // The Pi MCP bridge serves Pi and all device-hosted engines; it also
  // requires the global switch when a local project overrides the user default.
  if ((opts.agentKind === 'pi' || opts.agentDeviceId) && !context.remoteHostId && !isPluginEnabled('collab')) return;
  opts.userPrompt = opts.userPrompt ? `${opts.userPrompt}\n\n${orcaDiscoveryPrompt}` : orcaDiscoveryPrompt;
}

/** The role-specific Orca instructions for this session, or null when it has no complete role. */
export function renderOrcaRoleInstructions(o: MakerSessionCreateOpts): string | null {
  const vendorOptions = o.vendorOptions;
  if (!vendorOptions) return null;
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
  if (prompt && o.agentKind === 'pi') {
    prompt += '\nFor a named Orca tool, inspect its schema once with cindy_mcp_list_tools using both server and tool, then invoke it with cindy_mcp_call_tool.';
  }
  return prompt;
}

/** Inject the role-specific Orca instructions into the stable session startup prompt. */
export async function applyOrcaInstructions(
  o: MakerSessionCreateOpts,
  deps: OrcaSessionStartOptionsDeps = defaultDeps,
): Promise<boolean> {
  let prompt = renderOrcaRoleInstructions(o);
  if (!prompt) return false;
  if (o.userPrompt && `\n\n${o.userPrompt}\n\n`.includes(`\n\n${prompt}\n\n`)) return true;
  const vendor = o.vendorOptions;
  if (vendor?.orcaRole === 'lead' && o.id && vendor.orcaLeadSessionId === o.id && deps.listWorkersByLead) {
    let route = null;
    try {
      const active = await deps.listWorkersByLead(o.id);
      const team = vendor.orcaWorkflowId ? active.filter(w => w.teamId === vendor.orcaWorkflowId) : active;
      const initial = parseOrcaInitialWorkerRef(vendor.initialWorker);
      const soleWorker = team.length === 1 ? team[0] : undefined;
      const target = initial ? team.find(w => w.id === initial.workerId && w.sessionId === initial.sessionId) : soleWorker;
      if (target) {
        // Roles and labels can change while this Lead's startup prompt remains cached.
        route = parseOrcaInitialWorkerRef({ workerId: target.id, sessionId: target.sessionId });
      }
    } catch {
      deps.warn('orca lead startup: could not read the active Worker route', { sessionId: o.id });
    }
    o.vendorOptions = { ...vendor, initialWorker: route };
    prompt = renderOrcaRoleInstructions(o) ?? prompt;
  }
  o.userPrompt = o.userPrompt ? `${o.userPrompt}\n\n${prompt}` : prompt;
  return true;
}

export async function preparePersistedOrcaSessionStart(
  sessionId: string,
  o: MakerSessionCreateOpts,
  deps: OrcaSessionStartOptionsDeps = defaultDeps,
): Promise<boolean> {
  await synthesizeOrcaVendorOptionsFromDb(sessionId, o, deps);
  return applyOrcaInstructions(o, deps);
}
