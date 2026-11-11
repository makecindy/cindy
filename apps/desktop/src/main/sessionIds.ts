/**
 * Session id helpers for desktop-owned business sessions.
 *
 * Keep local session ids in the same UUID format used by maker-core's
 * generateSessionId(). Existing non-UUID rows (IM deterministic ids, older
 * cuid2 rows) remain valid because session ids are stored and routed as opaque
 * strings; this helper only controls newly-created desktop sessions.
 */
import { randomUUID } from 'node:crypto';
import path from 'node:path';

/** Caller-supplied task IDs also become directory/permission-file segments. */
export function isSafeSessionPathSegment(value: string): boolean {
  return value !== '.' && value !== '..' && !/[\\/\0]/.test(value) && path.basename(value) === value;
}

export function createBusinessSessionId(): string {
  return randomUUID();
}

export function resolveBusinessSessionId(explicitId: unknown): string {
  if (typeof explicitId === 'string' && explicitId && !isSafeSessionPathSegment(explicitId)) {
    throw new Error('[INVALID_PARAMS] session id must be a safe path segment');
  }
  return typeof explicitId === 'string' && explicitId.length > 0
    ? explicitId
    : createBusinessSessionId();
}
