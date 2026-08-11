/**
 * Harness-neutral lifecycle marker for Cindy's durable Subagent workspace.
 *
 * This marker is deliberately nested on the existing live `agent_task_update`
 * event. The live card may still represent provider control calls, background
 * shell tasks, or workflows; only updates carrying a valid marker are durable
 * Subagent observations.
 */

export type SubagentObservationKind = 'spawn' | 'progress' | 'terminal';

export interface SubagentObservation {
  /** Only spawn observations may create a durable run or add provider ids. */
  kind: SubagentObservationKind;
  /** Stable Cindy identity for one delegated unit of work. */
  logicalSubagentId: string;
  /** Parent task tool call that launched this delegated work, when known. */
  parentToolUseId?: string;
  /** Additional stable card/task aliases, never filesystem paths. */
  identityAliases?: string[];
  /** Opaque native child session/thread ids, supplied by spawn observations only. */
  providerRunIds?: string[];
}

const MAX_ID_LENGTH = 512;
const MAX_IDENTITY_ALIASES = 128;
const MAX_PROVIDER_RUN_IDS = 64;

function normalizedId(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_ID_LENGTH) return undefined;
  return trimmed;
}

function normalizedIds(value: unknown, max: number): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return undefined;
  const ids = new Set<string>();
  for (const raw of value) {
    const id = normalizedId(raw);
    if (!id) continue;
    ids.add(id);
    if (ids.size >= max) break;
  }
  return [...ids];
}

/** Validate an untrusted event marker. Invalid markers fail closed. */
export function normalizeSubagentObservation(value: unknown): SubagentObservation | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (raw.kind !== 'spawn' && raw.kind !== 'progress' && raw.kind !== 'terminal') return null;
  const logicalSubagentId = normalizedId(raw.logicalSubagentId);
  if (!logicalSubagentId) return null;
  const parentToolUseId = normalizedId(raw.parentToolUseId);
  const identityAliases = normalizedIds(raw.identityAliases, MAX_IDENTITY_ALIASES);
  const providerRunIds = normalizedIds(raw.providerRunIds, MAX_PROVIDER_RUN_IDS);
  return {
    kind: raw.kind,
    logicalSubagentId,
    ...(parentToolUseId ? { parentToolUseId } : {}),
    ...(identityAliases !== undefined ? { identityAliases } : {}),
    ...(providerRunIds !== undefined ? { providerRunIds } : {}),
  };
}
