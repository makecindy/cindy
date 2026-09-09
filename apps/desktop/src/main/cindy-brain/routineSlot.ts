import type { InstalledGhost } from '../../shared/ghost.js';
import { parseRoutineEvent, type RoutineEngine } from '@cindy/maker-scheduler';
import { createLogger } from '../logger.js';
import { Buffer } from 'node:buffer';

const log = createLogger('routines:plugin');

// Host-wide, across engine startup/replacement: status and publish share these slots.
// Engine-local rate and persistence quotas remain independent of this outer concurrency bound.
const pendingByPlugin = new Map<string, number>();
let totalPending = 0;

/** Bound the whole JSON envelope, including ignored fields, without serializing a huge value. */
function validateRequestSize(payload: unknown): void {
  let remaining = 128 * 1024;
  let nodes = 4096;
  const ancestors = new Set<object>();
  const invalid = () => { throw new Error('Routine request is too large or invalid'); };
  const spend = (bytes: number) => { remaining -= bytes; if (remaining < 0) invalid(); };
  const text = (value: string) => {
    if (value.length > remaining) invalid();
    spend(Buffer.byteLength(JSON.stringify(value), 'utf8'));
  };
  const visit = (value: unknown, depth: number): void => {
    if (--nodes < 0 || depth > 16) invalid();
    if (typeof value === 'string') { text(value); return; }
    if (value == null) { spend(4); return; }
    if (typeof value === 'boolean') { spend(5); return; }
    if (typeof value === 'number' && Number.isFinite(value)) { spend(String(value).length); return; }
    if (typeof value !== 'object' || value === null) return invalid();
    if (ancestors.has(value)) invalid();
    ancestors.add(value);
    spend(2);
    if (Array.isArray(value)) {
      if (value.length > nodes) invalid();
    } else {
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) invalid();
    }
    // Include enumerable array properties too: structured clone retains them even though JSON ignores them.
    for (const key in value) {
      if (!Object.hasOwn(value, key)) continue;
      text(key);
      spend(2);
      visit((value as Record<string, unknown>)[key], depth + 1);
    }
    ancestors.delete(value);
  };
  visit(payload, 0);
}

function reserveRequest(pluginId: string): () => void {
  const pending = pendingByPlugin.get(pluginId) ?? 0;
  if (pending >= 8 || totalPending >= 32)
    throw new Error('Routine request intake is busy; retry later');
  pendingByPlugin.set(pluginId, pending + 1);
  totalPending += 1;
  return () => {
    const remaining = pendingByPlugin.get(pluginId)! - 1;
    if (remaining) pendingByPlugin.set(pluginId, remaining);
    else pendingByPlugin.delete(pluginId);
    totalPending -= 1;
  };
}

// Exact host-authored rejections only. Never echo arbitrary storage errors across the plugin boundary.
const PUBLIC_REJECTIONS = [
  'Routine request is too large or invalid',
  'Routine request rate limit reached; retry after 60 seconds',
  'Routine request intake is busy; retry later',
  'Routine receipt storage is full; retry after receipts expire (24 hours)',
  'Routine queue is full; retry this event later',
  'Routine service is stopped',
  'Event source is not listening',
  'Event type is undeclared',
  'Event publisher is no longer active',
  'Expected an object',
  'Too many event fields',
  'Event fields must be strings, finite numbers or booleans',
  'Invalid event field',
  'Event payload is too large',
  'Invalid event timestamp',
  'Expected nonempty text of at most 128 characters',
  'Expected nonempty text of at most 200 characters',
  'Expected nonempty text of at most 256 characters',
  'Expected nonempty text of at most 1000 characters',
] as const;

/** Host-authenticated publisher: a plugin may only publish its own declared event types. */
export async function handleRoutineRequest(
  ghost: InstalledGhost | undefined,
  payload: unknown,
  getEngine: () => Promise<RoutineEngine>,
  isCurrent: () => boolean,
): Promise<{ ok: boolean; accepted?: number; duplicate?: boolean; message?: string }> {
  if (!ghost?.enabled || !ghost.manifest.routineEvents)
    return { ok: false, message: 'Routine events are not declared or the plugin is disabled' };
  if (!payload || typeof payload !== 'object' || Array.isArray(payload))
    return { ok: false, message: 'Invalid routine request' };
  const request = payload as Record<string, unknown>;
  let release: (() => void) | undefined;
  try {
    release = reserveRequest(ghost.manifest.id);
    validateRequestSize(request);
    if (request.action !== 'status' && request.action !== 'publish')
      return { ok: false, message: 'Unknown routine operation' };
    if (request.action === 'status' && (typeof request.status !== 'string' || !['listening', 'disconnected', 'error'].includes(request.status)))
      return { ok: false, message: 'Invalid source status' };
    // Reject malformed/oversized events before any startup wait, using the engine's validator.
    const event = request.action === 'publish' ? parseRoutineEvent(request.event) : undefined;
    const engine = await getEngine();
    if (!isCurrent()) return { ok: false, message: 'Plugin owner or installation changed' };
    const sourceId = `plugin:${ghost.manifest.id}`;
    if (request.action === 'status') {
      engine.registerSource({
        id: sourceId,
        name: ghost.manifest.name,
        events: ghost.manifest.routineEvents.events,
        status: request.status as 'listening' | 'disconnected' | 'error',
      });
      return { ok: true };
    }
    return { ok: true, ...(await engine.publish(sourceId, event, isCurrent)) };
  } catch (error) {
    const publicMessage = error instanceof Error
      ? PUBLIC_REJECTIONS.find((message) => message === error.message)
      : undefined;
    if (publicMessage) return { ok: false, message: publicMessage };
    log.warn('routine plugin request failed', {
      ghostId: ghost.manifest.id,
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      ok: false,
      message: 'Routine request failed; please retry later',
    };
  } finally {
    release?.();
  }
}
