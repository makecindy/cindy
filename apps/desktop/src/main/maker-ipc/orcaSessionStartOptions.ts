import { LOCAL_AGENT_CLIENT, type EngineKind } from '@cindy/maker-core';
import {
  parseOrcaInitialWorkerRef,
  renderOrcaLeadSystemPrompt,
  renderOrcaWorkerSystemPrompt,
} from '@cindy/orca-workflow';

import {
  getActiveTeamByLead, getSessionOrcaRole, getWorkerLink, getRemoteOrcaSession, listWorkersByLead, type OrcaWorkerRecord,
} from '../localDb/orcaTeamStore.js';
import type { OrcaRemoteLead } from '../../shared/orcaRemoteWorker.js';
import { createLogger } from '../logger.js';
import { activeOwnerScopeKey, isAppSessionBoundaryPending } from '../appSessionState.js';
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
  'workingDir' | 'workspaceKind' | 'remoteHostId' | 'agentDeviceId' | 'deviceHosted' |
  'userPrompt' | 'bindPluginEngineOrcaDiscoveryBriefing' | 'resumeSessionId' | 'id' | typeof LOCAL_AGENT_CLIENT
> & { [ORCA_DIRECT_TASK_CREATE]?: true };

/** ACP discovery is local; a native resume can only use an existing handoff. */
export function isLocalAcpOrcaDiscoveryStartup(opts: OrcaDiscoveryStartOptions): boolean {
  return opts.agentKind === 'acp' && !opts.remoteHostId && !opts.agentDeviceId &&
    !opts.deviceHosted && !opts.reviewMode && !opts.botRuntimeProfile && !opts[LOCAL_AGENT_CLIENT] &&
    !opts.orcaRole && !opts.vendorOptions?.orcaRole && !opts.vendorOptions?.orcaRemoteWorker;
}

/** Like the Lead handoff, this is owner-scoped, in memory and consumed only at a known boundary. */
export function createAcpOrcaDiscoveryHandoff(currentOwner: () => string | null) {
  let owner: string | null = null;
  const pending = new Map<string, { nativeId: string }>();
  const scope = () => {
    const next = currentOwner();
    if (next !== owner) pending.clear();
    owner = next;
    return next;
  };
  return {
    hasPending(id: string) { return scope() !== null && pending.has(id); },
    consume(id: string) {
      scope();
      pending.delete(id);
    },
    forStart(id: string, eligible: boolean, mayStage: boolean): OrcaDiscoveryStartOptions['bindPluginEngineOrcaDiscoveryBriefing'] {
      const capturedOwner = scope();
      if (capturedOwner === null || (!mayStage && !pending.has(id))) return;
      return ({ nativeId, fresh, hasOrca }) => {
        if (scope() !== capturedOwner) return;
        if (mayStage && fresh && hasOrca) pending.set(id, { nativeId });
        const entry = pending.get(id);
        if (entry?.nativeId !== nativeId) return;
        return () => {
          if (scope() !== capturedOwner || pending.get(id) !== entry) return;
          return {
            // Still consume on the first ordinary write if this replacement
            // cannot expose the note; a later resume is no longer a new task.
            text: eligible && hasOrca ? orcaDiscoveryPrompt : '',
            onSent: () => { if (pending.get(id) === entry) pending.delete(id); },
          };
        };
      };
    },
  };
}

export const acpOrcaDiscoveryHandoff = createAcpOrcaDiscoveryHandoff(
  () => isAppSessionBoundaryPending() ? null : activeOwnerScopeKey(),
);

/** Runs on the startup copy of options, after resolving the persisted role. */
export function appendOrcaDiscoveryPrompt(
  opts: OrcaDiscoveryStartOptions,
  row: Pick<SessionRowSnapshot, 'workingDir' | 'workspaceKind' | 'remoteHostId' | 'agentDeviceId' |
    'source' | 'orcaRole' | 'orcaRemoteLead' | 'sdkSessionId'> | null | undefined,
  isPluginEnabled: (pluginId: 'collab', workingDir?: string) => boolean,
  isManagedDialogueWorkspace: (workingDir: string) => boolean,
  sessionId = opts.id,
  discoveryHandoff = acpOrcaDiscoveryHandoff,
): void {
  if (row === null && opts[ORCA_DIRECT_TASK_CREATE] && !opts.resumeSessionId) {
    row = { source: 'desktop', workingDir: null, workspaceKind: null };
  }
  const acp = opts.agentKind === 'acp';
  if (acp) {
    delete opts.bindPluginEngineOrcaDiscoveryBriefing;
    if (sessionId && (opts.orcaRole || opts.vendorOptions?.orcaRole || row?.orcaRole)) discoveryHandoff.consume(sessionId);
    if (row === undefined && sessionId && opts.resumeSessionId && isLocalAcpOrcaDiscoveryStartup(opts)) {
      // An unreadable task row cannot authorize text. Keep only the write
      // receipt for an existing handoff, so a later restore cannot add it late.
      opts.bindPluginEngineOrcaDiscoveryBriefing = discoveryHandoff.forStart(sessionId, false, false);
    }
  }
  if (!row || opts.reviewMode || opts.botRuntimeProfile || opts[LOCAL_AGENT_CLIENT] ||
      opts.orcaRole || opts.vendorOptions?.orcaRole || opts.vendorOptions?.orcaRemoteWorker ||
      row.orcaRole || row.orcaRemoteLead ||
      (row.source !== 'desktop' && row.source !== 'side-chat')) return;
  if (acp && (!isLocalAcpOrcaDiscoveryStartup(opts) || row.agentDeviceId || row.remoteHostId)) return;
  const context = {
    workingDir: row.workingDir ?? opts.workingDir,
    workspaceKind: opts.workspaceKind ?? row.workspaceKind,
    remoteHostId: opts.remoteHostId ?? row.remoteHostId,
  };
  const projectUnavailable = collabProjectUnavailableReason(context, isPluginEnabled, isManagedDialogueWorkspace);
  if (acp) {
    const eligible = !projectUnavailable && isPluginEnabled('collab');
    // The composer updates userSendAt before starting the engine, even for
    // its first input. Only native history makes this a non-fresh start.
    if (sessionId) opts.bindPluginEngineOrcaDiscoveryBriefing = discoveryHandoff.forStart(
      sessionId, eligible, eligible && !opts.resumeSessionId && !row.sdkSessionId,
    );
    return;
  }
  if (projectUnavailable) return;
  // The Pi MCP bridge serves Pi, local ACP and device-hosted engines; it also
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

/** A live promotion is not in native history yet. Share its pending state
 * between the old runtime and a replacement without replaying old teams. */
export function createAcpLeadBriefingHandoff(deps: {
  currentOwner(): string | null;
  readActiveTeamId(sessionId: string): Promise<string | undefined>;
  readRole(sessionId: string): Promise<OrcaRole | null>;
}) {
  const pendingBySession = new Map<string, { owner: string; teamId: string }>();
  function makeReader(id: string, pending: { owner: string; teamId: string }, text: string) {
    return () => {
      if (pendingBySession.get(id) !== pending || pending.owner !== deps.currentOwner()) return;
      return { text, onSent: () => {
        if (pendingBySession.get(id) === pending) pendingBySession.delete(id);
      } };
    };
  }
  return {
    hasPending(id: string) {
      const pending = pendingBySession.get(id);
      return pending !== undefined && pending.owner === deps.currentOwner();
    },
    stage(id: string, teamId: string, text?: string) {
      const owner = deps.currentOwner();
      if (owner === null) return;
      const pending = { owner, teamId };
      pendingBySession.set(id, pending);
      return text ? makeReader(id, pending, text) : undefined;
    },
    revoke(id: string) { pendingBySession.delete(id); },
    async forStart(id: string, text: string) {
      const pending = pendingBySession.get(id);
      if (!pending || deps.currentOwner() !== pending.owner) return;
      const teamId = await deps.readActiveTeamId(id);
      const role = teamId === pending.teamId ? await deps.readRole(id) : null;
      if (pendingBySession.get(id) !== pending || deps.currentOwner() !== pending.owner) return;
      if (role === 'lead') return makeReader(id, pending, text);
      pendingBySession.delete(id);
    },
  };
}

type AcpLeadBriefingHandoff = ReturnType<typeof createAcpLeadBriefingHandoff>;

// One pending promotion per task, shared by IPC promotion and every Desktop start.
export const acpLeadBriefings = createAcpLeadBriefingHandoff({
  currentOwner: () => isAppSessionBoundaryPending() ? null : activeOwnerScopeKey(),
  readActiveTeamId: async id => (await getActiveTeamByLead(id))?.id,
  readRole: getSessionOrcaRole,
});

export async function applyLeadVendorOptions(
  handoff: AcpLeadBriefingHandoff,
  input: { leadSessionId: string; teamId: string; newTeam?: true; admittedLeadAgentKind?: EngineKind;
    workerId?: string; workerSessionId?: string },
  live: { agentKind: EngineKind; workDir: string; agentDeviceId?: string | null;
    setVendorOptions(patch: Record<string, unknown>): Promise<void> } | null | undefined,
  clearOrcaMcpHydrated: (sessionId: string) => void,
): Promise<void> {
  const { leadSessionId, teamId, workerId, workerSessionId } = input;
  const agentKind = live?.agentKind ?? input.admittedLeadAgentKind;
  if (agentKind === 'acp' && isAppSessionBoundaryPending()) return;
  const patch: Record<string, unknown> = {
    orcaRole: 'lead', orcaWorkflowId: teamId, orcaLeadSessionId: leadSessionId,
    ...(workerId && workerSessionId ? { initialWorker: { workerId, sessionId: workerSessionId } } : {}),
  };
  if (live?.agentKind === 'acp' && live.agentDeviceId) {
    // Keep the legacy remote RPC; only the local runtime uses the handoff.
    const briefing = renderOrcaRoleInstructions({
      id: leadSessionId, agentKind: 'acp', workingDir: live.workDir, model: '', vendorOptions: patch,
    });
    if (briefing) patch.pluginEngineRoleBriefing = briefing;
  } else if (agentKind === 'acp' && input.newTeam) {
    acpOrcaDiscoveryHandoff.consume(leadSessionId);
    clearOrcaMcpHydrated(leadSessionId);
    const briefing = live ? renderOrcaRoleInstructions({
      id: leadSessionId, agentKind: 'acp', workingDir: live.workDir, model: '', vendorOptions: patch,
    }) : undefined;
    const read = handoff.stage(leadSessionId, teamId, briefing ?? undefined);
    if (read) patch.pluginEngineRoleBriefing = read;
  }
  await live?.setVendorOptions(patch);
}

/** Bind the pending promotion to the current runtime route, without serializing its reader. */
export async function prepareAcpRoleBriefingForStart(o: MakerSessionCreateOpts, handoff: AcpLeadBriefingHandoff) {
  delete o.readPluginEngineRoleBriefing;
  if (o.agentKind !== 'acp' || o.reviewMode === true) return;
  if (o.vendorOptions?.orcaRole !== 'worker' && o.vendorOptions?.orcaRole !== 'lead') return;
  const briefing = renderOrcaRoleInstructions(o);
  if (!briefing) return;
  const read = o.id && !o.agentDeviceId && o.vendorOptions.orcaRole === 'lead' ? await handoff.forStart(o.id, briefing) : undefined;
  o.pluginEngineBriefing = read ? undefined : briefing;
  if (!o.agentDeviceId) o.readPluginEngineRoleBriefing = read;
  o.pluginEngineTrustedCaller = true;
  return read;
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
  handoff: AcpLeadBriefingHandoff = acpLeadBriefings,
): Promise<boolean> {
  await synthesizeOrcaVendorOptionsFromDb(sessionId, o, deps);
  const injected = await applyOrcaInstructions(o, deps);
  // Dormant starts such as Goal restore do not pass through bootstrapSession.
  // Reuse its reader when present; otherwise attach only an undelivered local
  // promotion. Neither the role nor the options alone can authorize a replay.
  if (injected && o.agentKind === 'acp' && o.vendorOptions?.orcaRole === 'lead'
    && !o.agentDeviceId && !o.remoteHostId && !o.deviceHosted && !o.reviewMode
    && !o.readPluginEngineRoleBriefing && handoff.hasPending(sessionId)) {
    const briefing = renderOrcaRoleInstructions(o);
    const read = briefing ? await handoff.forStart(sessionId, briefing) : undefined;
    if (read) {
      o.readPluginEngineRoleBriefing = read;
      o.pluginEngineBriefing = undefined;
    }
  }
  return injected;
}
