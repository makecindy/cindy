/** Optional Desktop-only group routing context. This never authorizes a cross-account guest. */
import { isScopedPeer } from '@cindy/device-link';

export const GROUP_CONTINUITY_MS = 30 * 60_000;
export interface GroupContinuityGrant {
  id: string;
  group: string;
  controller: string;
  providerId: string;
  agentKind: 'claude-code' | 'codex' | 'pi';
  model: string;
  fastPolicyRequired: boolean;
  remainingMs: number;
}
export type GroupContinuityRequest =
  | { action: 'continuity-prepare'; grant: GroupContinuityGrant }
  | { action: 'continuity-revoke'; id: string }
  | { action: 'continuity-inspect' | 'continuity-admit'; id: string; ownerDeviceId: string; sessionId: string };
export interface GroupContinuityAck { id: string; remainingMs: number; running?: number }

const ordinaryDevice = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(v) && !isScopedPeer(v);
const text = (v: unknown, max = 512): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;
export function isGroupContinuityRequest(value: unknown): value is { action: string } {
  return !!value && typeof value === 'object' && 'action' in value
    && typeof value.action === 'string' && value.action.startsWith('continuity-');
}
export function parseGroupContinuityRequest(value: unknown): GroupContinuityRequest {
  const invalid = (): never => { throw new Error('[INVALID_PARAMS] Invalid group continuity request'); };
  if (!value || typeof value !== 'object') return invalid();
  const row = value as Record<string, unknown>;
  if (row.action === 'continuity-prepare') {
    const grant = row.grant as GroupContinuityGrant | undefined;
    if (!grant || !text(grant.id, 128) || !text(grant.group, 128) || !ordinaryDevice(grant.controller)
      || !text(grant.providerId, 128) || !['claude-code', 'codex', 'pi'].includes(grant.agentKind)
      || !text(grant.model) || typeof grant.fastPolicyRequired !== 'boolean'
      || !Number.isFinite(grant.remainingMs) || grant.remainingMs <= 0 || grant.remainingMs > GROUP_CONTINUITY_MS) return invalid();
    return { action: row.action, grant: { id: grant.id, group: grant.group, controller: grant.controller,
      providerId: grant.providerId, agentKind: grant.agentKind, model: grant.model,
      fastPolicyRequired: grant.fastPolicyRequired, remainingMs: grant.remainingMs } };
  }
  if (row.action === 'continuity-revoke' && text(row.id, 128)) return { action: row.action, id: row.id };
  if ((row.action === 'continuity-inspect' || row.action === 'continuity-admit')
    && text(row.id, 128) && ordinaryDevice(row.ownerDeviceId) && ordinaryDevice(row.sessionId)) {
    return { action: row.action, id: row.id, ownerDeviceId: row.ownerDeviceId, sessionId: row.sessionId };
  }
  return invalid();
}

export function parseGroupContinuityAck(value: unknown, id: string): GroupContinuityAck | null {
  const row = value as Partial<GroupContinuityAck> | null;
  return row?.id === id && typeof row.remainingMs === 'number' && Number.isFinite(row.remainingMs)
    && row.remainingMs > 0 && row.remainingMs <= GROUP_CONTINUITY_MS
    && (row.running === undefined || (Number.isSafeInteger(row.running) && row.running >= 0))
    ? { id, remainingMs: row.remainingMs, ...(row.running === undefined ? {} : { running: row.running }) } : null;
}
