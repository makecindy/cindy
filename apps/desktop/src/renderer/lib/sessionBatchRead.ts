/** Shared bounded metadata reads. Transport selection never changes query semantics. */
import type { Session } from './ccAgent.types';
import type { RemoteSessionListSessionLike } from '@cindy/maker-shared/session-list';
import { DEVICE_LINK_RECONCILIATION_PROBE_MARKER } from '@cindy/maker-shared/device-link-contract';
import { extractIpcError } from '@/utils/ipcError';
import { getStickySessionDeviceId } from '@/features/device-link/stickySessionOrigin';

import { SESSION_READ_BATCH_LIMIT } from '../../shared/sessionRead';
export type SessionReadResult = { sessionId: string; value?: Session; errorCode?: string };

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function hasOptionalNullableString(record: Record<string, unknown>, key: string): boolean {
  return record[key] === undefined || isNullableString(record[key]);
}

function hasOptionalBoolean(record: Record<string, unknown>, key: string): boolean {
  return record[key] === undefined || typeof record[key] === 'boolean';
}

function hasOptionalFiniteNumber(record: Record<string, unknown>, key: string): boolean {
  const value = record[key];
  return (
    value === undefined || value === null || (typeof value === 'number' && Number.isFinite(value))
  );
}

export function isSessionListRow(
  value: unknown,
  expectedStatus: 'active' | 'archived' | 'deleted',
): value is RemoteSessionListSessionLike {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const session = value as Record<string, unknown>;
  const count = session._count;
  return (
    typeof session.id === 'string' &&
    session.id.length > 0 &&
    typeof session.title === 'string' &&
    isNullableString(session.workingDir) &&
    typeof session.model === 'string' &&
    session.status === expectedStatus &&
    typeof session.agentKind === 'string' &&
    typeof session.createdAt === 'string' &&
    typeof session.updatedAt === 'string' &&
    (session.userId === undefined || typeof session.userId === 'string') &&
    hasOptionalNullableString(session, 'workspaceKind') &&
    hasOptionalNullableString(session, 'effort') &&
    hasOptionalNullableString(session, 'permissionMode') &&
    hasOptionalNullableString(session, 'sdkSessionId') &&
    hasOptionalNullableString(session, 'clearedAt') &&
    hasOptionalNullableString(session, 'pinnedAt') &&
    hasOptionalNullableString(session, 'userSendAt') &&
    hasOptionalNullableString(session, 'source') &&
    hasOptionalNullableString(session, 'orcaRole') &&
    hasOptionalNullableString(session, 'providerId') &&
    hasOptionalNullableString(session, 'parentSessionId') &&
    hasOptionalNullableString(session, 'forkedAtMessageId') &&
    hasOptionalNullableString(session, 'worktreePath') &&
    hasOptionalNullableString(session, 'remoteHostId') &&
    hasOptionalNullableString(session, 'preview') &&
    hasOptionalNullableString(session, 'summary') &&
    hasOptionalBoolean(session, 'fastMode') &&
    hasOptionalBoolean(session, 'planModeEnabled') &&
    hasOptionalBoolean(session, 'usedProjectContext') &&
    hasOptionalFiniteNumber(session, 'totalTokenUsage') &&
    hasOptionalFiniteNumber(session, 'totalCostUsd') &&
    hasOptionalFiniteNumber(session, 'contextTokens') &&
    hasOptionalFiniteNumber(session, 'contextWindow') &&
    hasOptionalFiniteNumber(session, 'activeTurnStartedAt') &&
    hasOptionalFiniteNumber(session, 'lastTurnEndedAt') &&
    (session.extraDirs === undefined ||
      (Array.isArray(session.extraDirs) &&
        session.extraDirs.every((dir) => typeof dir === 'string'))) &&
    (session.writableDirs === undefined ||
      (Array.isArray(session.writableDirs) &&
        session.writableDirs.every((dir) => typeof dir === 'string'))) &&
    (count === undefined ||
      count === null ||
      (isRecord(count) &&
        (count.messages === undefined ||
          (typeof count.messages === 'number' && Number.isFinite(count.messages)))))
  );
}


async function readChunk(ids: string[], deviceId?: string): Promise<SessionReadResult[]> {
  const getMany = window.electronAPI.localDb?.sessions?.getMany;
  if (deviceId || getMany) {
    try {
      const value = deviceId
        ? await window.electronAPI.deviceLink.invoke(deviceId, 'local-db:sessions:get-many', [ids])
        : await getMany(ids);
      if (!Array.isArray(value) || value.some((row) => !isRecord(row)
        || typeof row.id !== 'string' || !ids.includes(row.id)
        || !(row.status === 'active' || row.status === 'archived' || row.status === 'deleted')
        || !isSessionListRow(row, row.status))) return ids.map((sessionId) => ({ sessionId }));
      const rows = new Map(value.map((row) => [row.id, row as Session]));
      if (rows.size !== value.length) return ids.map((sessionId) => ({ sessionId }));
      return ids.map((sessionId) => rows.has(sessionId)
        ? { sessionId, value: rows.get(sessionId) } : { sessionId, errorCode: 'NOT_FOUND' });
    } catch (error) {
      const ipcError = extractIpcError(error);
      const code = ipcError?.code;
      const oversized = code === 'PRECONDITION_FAILED' && ipcError?.message === 'REMOTE_SESSION_BATCH_TOO_LARGE';
      // Only transport compatibility failures permit bounded single-read fallback.
      if (!deviceId || (code !== 'DEVICE_LINK_CHANNEL_NOT_ALLOWED' && !oversized)) {
        return ids.map((sessionId) => ({ sessionId, errorCode: code === 'NOT_FOUND' ? undefined : code }));
      }
    }
  }
  return Promise.all(ids.map(async (sessionId) => {
    try {
      const value = deviceId
        ? await window.electronAPI.deviceLink.invoke(deviceId, 'local-db:sessions:get', [sessionId, DEVICE_LINK_RECONCILIATION_PROBE_MARKER])
        : await window.electronAPI.localDb.sessions.get(sessionId);
      return { sessionId, value: value as Session };
    } catch (error) {
      return { sessionId, errorCode: extractIpcError(error)?.code };
    }
  }));
}

/** One target per batch, sequential bounded chunks, no persistent result cache. */
export async function readSessionBatch(ids: readonly string[], deviceId?: string): Promise<SessionReadResult[]> {
  const unique = [...new Set(ids)];
  const results: SessionReadResult[] = [];
  for (let offset = 0; offset < unique.length; offset += SESSION_READ_BATCH_LIMIT) {
    results.push(...await readChunk(unique.slice(offset, offset + SESSION_READ_BATCH_LIMIT), deviceId));
  }
  return results;
}

/** Capture ownership before starting I/O; never read a remote id from the local database. */
export async function readSessionBatchFor(ids: readonly string[]): Promise<SessionReadResult[]> {
  const groups = new Map<string | undefined, string[]>();
  for (const id of new Set(ids)) {
    const device = getStickySessionDeviceId(id) ?? undefined;
    const group = groups.get(device) ?? [];
    group.push(id);
    groups.set(device, group);
  }
  return (await Promise.all([...groups].map(([device, group]) => readSessionBatch(group, device)))).flat();
}
