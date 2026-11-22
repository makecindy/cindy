import type { AcpLeadSupport } from '@cindy/maker-core';

export interface AcpLeadRefusal {
  code: 'UNSUPPORTED_CAPABILITY' | 'PROVIDER_ROUTE_UNAVAILABLE';
  message: string;
}

const ENGINE_UNAVAILABLE: AcpLeadRefusal = {
  code: 'PROVIDER_ROUTE_UNAVAILABLE',
  message: 'this plugin engine is currently unavailable, so it cannot start collaboration',
};

const ENGINE_NOT_VERIFIED: AcpLeadRefusal = {
  code: 'UNSUPPORTED_CAPABILITY',
  message: '[PLUGIN_ENGINE_LEAD_TOOLS_UNSUPPORTED] could not verify the collaboration support of this plugin engine',
};

/**
 * Judges a dormant plugin-engine task (no live session) that is about to become a collaboration Lead.
 * The team and its first Worker are committed before the Lead is started, so the engine has to be
 * judged beforehand: it must take the cindy_orca HTTP MCP server and, for a task that already has a
 * native session, reopen it. A Lead that cannot be woken would be left holding a team.
 */
export function dormantAcpLeadRefusal(support: AcpLeadSupport, hasStoredSession: boolean): AcpLeadRefusal | null {
  if (!support.httpMcp) {
    return {
      code: 'UNSUPPORTED_CAPABILITY',
      message: '[PLUGIN_ENGINE_LEAD_TOOLS_UNSUPPORTED] this plugin engine does not support HTTP MCP collaboration tools, so it cannot act as a collaboration Lead',
    };
  }
  if (hasStoredSession && !support.resume) {
    return {
      code: 'UNSUPPORTED_CAPABILITY',
      message: '[PLUGIN_ENGINE_LEAD_TOOLS_UNSUPPORTED] this plugin engine cannot reopen this task (it offers neither session resume nor session load), so it cannot act as a collaboration Lead',
    };
  }
  return null;
}

export interface DormantAcpLeadPreflightDeps {
  /** The state the plugin registry gives the engine now; undefined when the engine is not listed. */
  engineState(harnessKey: string): 'available' | 'unavailable' | 'unknown' | undefined;
  /** Starts the engine, asks it what it offers a Lead, and waits for its process to stop. */
  probe(harnessKey: string): Promise<AcpLeadSupport>;
  onProbeFailed?(harnessKey: string, error: unknown): void;
}

/**
 * The whole preflight of a dormant plugin-engine task that is about to become a Lead: the engine must be
 * available before it is probed and still available once its probe process has stopped, and what it offers
 * must suit a Lead. Nothing is kept or shared between calls: a plugin can be replaced between two of them,
 * and each call takes about as long as one probe. A probe the broker refuses (an engine already running its
 * maximum number of processes) is reported as not verified, and the request can be repeated.
 */
export function createDormantAcpLeadPreflight(deps: DormantAcpLeadPreflightDeps) {
  const withdrawn = (harnessKey: string): boolean => {
    const state = deps.engineState(harnessKey);
    return state === undefined || state === 'unavailable';
  };
  return async (harnessKey: string | null | undefined, hasStoredSession: boolean): Promise<AcpLeadRefusal | null> => {
    if (!harnessKey || withdrawn(harnessKey)) return ENGINE_UNAVAILABLE;
    let support: AcpLeadSupport;
    try {
      support = await deps.probe(harnessKey);
    } catch (error) {
      deps.onProbeFailed?.(harnessKey, error);
      return withdrawn(harnessKey) ? ENGINE_UNAVAILABLE : ENGINE_NOT_VERIFIED;
    }
    // The engine can be withdrawn while its probe process is being stopped; a team made now could never wake its Lead.
    if (withdrawn(harnessKey)) return ENGINE_UNAVAILABLE;
    return dormantAcpLeadRefusal(support, hasStoredSession);
  };
}

export interface AcpLeadTeamFenceDeps {
  /** Whether the Lead has an active team now. */
  hasActiveTeam(): Promise<boolean>;
  /** Takes the Lead role, and the briefing still waiting to be sent, out of the open runtime. */
  revokeRole(): Promise<void>;
}

/**
 * A plugin-engine Lead is briefed for the team read before its engine opens, and the runtime is published only
 * after the open. A team that ends meanwhile finds no runtime to clear, so the runtime would send its first
 * ordinary message with the instructions of a team that is gone. Called once the session is open: a Lead that
 * has no active team any more has its role taken back out, like the same check made before the open. A Lead
 * whose team was replaced by another one is left as it was. Returns whether the role was taken out.
 */
export async function revokeAcpLeadIfTeamEnded(deps: AcpLeadTeamFenceDeps): Promise<boolean> {
  if (await deps.hasActiveTeam()) return false;
  await deps.revokeRole();
  return true;
}
