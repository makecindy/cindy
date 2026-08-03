import { buildPluginResourceReferenceHref } from '@cindy/maker-shared/agent-input-projection';

import type {
  GhostSetupAssessment,
  GhostToolCallResult,
  InstalledGhost,
} from '../../shared/ghost.js';

const QUERY_MAX_CHARS = 128;
const RESULT_LIMIT_MAX = 20;
const RESULT_MAX_BYTES = 64 * 1024;
const PROVIDER_LIMIT_MAX = 40;
const RESOURCE_HREF_MAX_CHARS = 1_500;
export const GHOST_AT_RESOURCE_QUERY_TIMEOUT_MS = 4_000;

export interface GhostAtResourceProviderItem {
  ghostId: string;
  name: string;
  description?: string;
}

export interface GhostAtResourceItem {
  id: string;
  label: string;
  description?: string;
  href: string;
}

export interface GhostAtResourceProviderDeps {
  listGhosts(): InstalledGhost[];
  isAvailable(ghostId: string): boolean;
  isDisabledForWorkdir(ghostId: string, workingDir?: string): boolean;
  getSetupAssessment(ghostId: string): GhostSetupAssessment;
  callTool(request: {
    ghostId: string;
    tool: string;
    args: Record<string, unknown>;
    timeoutMs: number;
  }): Promise<GhostToolCallResult>;
}

export type GhostAtResourceQueryResult =
  | { success: true; pluginName: string; items: GhostAtResourceItem[]; truncated: boolean }
  | { success: false; error: string; items: []; truncated: false };

interface ScheduledQuery {
  request: Parameters<typeof queryGhostAtResources>[1];
  resolve: (result: GhostAtResourceQueryResult) => void;
}

/** One running call plus one coalesced latest query per window/task/Plugin scope. */
export class GhostAtResourceQueryScheduler {
  private readonly states = new Map<string, { pending?: ScheduledQuery }>();

  constructor(private readonly deps: GhostAtResourceProviderDeps) {}

  query(
    scopeKey: string,
    request: Parameters<typeof queryGhostAtResources>[1],
  ): Promise<GhostAtResourceQueryResult> {
    return new Promise((resolve) => {
      const key = `${scopeKey}\u0000${request.ghostId}`;
      const active = this.states.get(key);
      if (active) {
        active.pending?.resolve({
          success: false,
          error: 'Plugin resource search superseded',
          items: [],
          truncated: false,
        });
        active.pending = { request, resolve };
        return;
      }
      const state: { pending?: ScheduledQuery } = {};
      this.states.set(key, state);
      void this.run(key, { request, resolve }, state);
    });
  }

  private async run(
    key: string,
    scheduled: ScheduledQuery,
    state: { pending?: ScheduledQuery },
  ): Promise<void> {
    let result: GhostAtResourceQueryResult;
    try {
      result = await queryGhostAtResources(this.deps, scheduled.request);
    } catch {
      result = {
        success: false,
        error: 'Plugin resource search failed',
        items: [],
        truncated: false,
      };
    }
    scheduled.resolve(result);
    const next = state.pending;
    if (next) {
      state.pending = undefined;
      void this.run(key, next, state);
      return;
    }
    this.states.delete(key);
  }
}

export interface GhostAtResourceSessionSnapshot {
  workingDir?: string | null;
  remoteHostId?: string | null;
}

/** Resolve Plugin execution scope without trusting a renderer-provided session workdir. */
export async function resolveGhostAtResourceWorkingDir(
  raw: Record<string, unknown>,
  getSessionSnapshot: (
    sessionId: string,
  ) => Promise<GhostAtResourceSessionSnapshot | null | undefined>,
): Promise<{ allowed: boolean; workingDir?: string }> {
  if (typeof raw.sessionId === 'string' && raw.sessionId.length > 0) {
    const snapshot = await getSessionSnapshot(raw.sessionId.slice(0, 256));
    // Local Plugin tools never run on behalf of remote execution contexts.
    if (!snapshot || snapshot.remoteHostId) return { allowed: false };
    return {
      allowed: true,
      ...(snapshot.workingDir ? { workingDir: snapshot.workingDir } : {}),
    };
  }
  // New-task drafts have no persisted session yet. The renderer's workingDir
  // cannot be used as a Plugin policy scope because it is not authoritative.
  return { allowed: false };
}

function oneLine(value: unknown, maxLength: number): string {
  return typeof value === 'string'
    ? value
        .replace(/[\u0000-\u001f\u007f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, maxLength)
    : '';
}

function eligibleGhost(
  deps: GhostAtResourceProviderDeps,
  ghostId: string,
  workingDir?: string,
  candidate?: InstalledGhost,
): InstalledGhost | null {
  if (!deps.isAvailable(ghostId)) return null;
  const ghost = candidate?.manifest.id === ghostId
    ? candidate
    : deps.listGhosts().find((item) => item.manifest.id === ghostId);
  if (
    !ghost?.enabled
    || !ghost.manifest.atResourceProvider
    || deps.isDisabledForWorkdir(ghostId, workingDir)
  ) return null;
  const tool = ghost.manifest.atResourceProvider.tool;
  if (!ghost.manifest.tools?.some((candidate) => candidate.name === tool)) return null;
  try {
    if (deps.getSetupAssessment(ghostId).state !== 'ready') return null;
  } catch {
    return null;
  }
  return ghost;
}

/** List metadata only. No Plugin tool runs until the user selects one provider. */
export function listGhostAtResourceProviders(
  deps: GhostAtResourceProviderDeps,
  workingDir?: string,
): GhostAtResourceProviderItem[] {
  const items: GhostAtResourceProviderItem[] = [];
  for (const ghost of deps.listGhosts()) {
    if (items.length >= PROVIDER_LIMIT_MAX) break;
    if (!eligibleGhost(deps, ghost.manifest.id, workingDir, ghost)) continue;
    const name = oneLine(ghost.manifest.name, 128);
    if (!name) continue;
    const description = oneLine(ghost.manifest.description, 256);
    items.push({
      ghostId: ghost.manifest.id,
      name,
      ...(description ? { description } : {}),
    });
  }
  return items;
}

export async function queryGhostAtResources(
  deps: GhostAtResourceProviderDeps,
  request: {
    ghostId: string;
    workingDir?: string;
    query?: string;
    limit?: number;
  },
): Promise<GhostAtResourceQueryResult> {
  const ghostId = oneLine(request.ghostId, 32);
  const ghost = ghostId ? eligibleGhost(deps, ghostId, request.workingDir) : null;
  if (!ghost) {
    return { success: false, error: 'Plugin resource provider unavailable', items: [], truncated: false };
  }

  const query = oneLine(request.query ?? '', QUERY_MAX_CHARS);
  const limit = Number.isFinite(request.limit)
    ? Math.max(1, Math.min(RESULT_LIMIT_MAX, Math.floor(request.limit as number)))
    : RESULT_LIMIT_MAX;
  const tool = ghost.manifest.atResourceProvider!.tool;
  const result = await deps.callTool({
    ghostId,
    tool,
    args: { query, limit },
    timeoutMs: GHOST_AT_RESOURCE_QUERY_TIMEOUT_MS,
  });
  if (!result.ok) {
    return {
      success: false,
      error: oneLine(result.message, 256) || 'Plugin resource search failed',
      items: [],
      truncated: false,
    };
  }

  if (!result.result || typeof result.result !== 'object' || Array.isArray(result.result)) {
    return { success: false, error: 'Plugin returned an invalid resource list', items: [], truncated: false };
  }
  let encoded: string | undefined;
  try {
    encoded = JSON.stringify(result.result);
  } catch {
    return { success: false, error: 'Plugin returned an invalid resource list', items: [], truncated: false };
  }
  if (!encoded) {
    return { success: false, error: 'Plugin returned an invalid resource list', items: [], truncated: false };
  }
  if (Buffer.byteLength(encoded, 'utf8') > RESULT_MAX_BYTES) {
    return { success: false, error: 'Plugin resource list is too large', items: [], truncated: false };
  }
  const rawItems = (result.result as Record<string, unknown>).items;
  if (!Array.isArray(rawItems)) {
    return { success: false, error: 'Plugin returned an invalid resource list', items: [], truncated: false };
  }

  const items: GhostAtResourceItem[] = [];
  const seen = new Set<string>();
  for (const rawItem of rawItems) {
    if (items.length >= limit) break;
    if (!rawItem || typeof rawItem !== 'object' || Array.isArray(rawItem)) continue;
    const record = rawItem as Record<string, unknown>;
    const id = typeof record.id === 'string' ? record.id : '';
    const label = oneLine(record.label, 128);
    if (
      !id.trim()
      || id.length > 256
      || /[\u0000-\u001f\u007f\u2028\u2029]/.test(id)
      || !label
      || seen.has(id)
    ) continue;
    seen.add(id);
    const description = oneLine(record.description, 256);
    const href = buildPluginResourceReferenceHref({ ghostId, tool, resourceId: id });
    if (href.length > RESOURCE_HREF_MAX_CHARS) continue;
    items.push({
      id,
      label,
      ...(description ? { description } : {}),
      href,
    });
  }
  return {
    success: true,
    pluginName: oneLine(ghost.manifest.name, 128) || ghostId,
    items,
    truncated: rawItems.length > items.length,
  };
}
