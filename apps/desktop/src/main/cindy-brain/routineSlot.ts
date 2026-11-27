import type { InstalledGhost } from '../../shared/ghost.js';
import { installedGhostStoragePart } from '../../shared/pluginIdentity.js';
import { parseRoutineEvent, RoutineEventAdmission } from '@cindy/maker-scheduler';
import { createLogger } from '../logger.js';
import { Buffer } from 'node:buffer';
import type { PluginEventSubscription } from '@cindy/maker-scheduler';
import {
  pluginEventSubscriptionsFor,
  publishPluginEvent,
  reportPluginEventStatus,
  type PluginEventListenState,
} from '../scheduler-host/webhook/pluginEvents.js';

const log = createLogger('routines:plugin');

/*
 * Plugin events (`routineEvents` declaration, `routine-request` pipe). Teammate routines were removed;
 * since 2026-11-23 published events wake the automations whose trigger chose this plugin
 * (docs/product-rules/plugin-event-triggers.md). Validation and bounds are unchanged, so plugins built
 * for routines keep working without reinstalling or re-approving.
 */

// Publishing and status reports have separate per-plugin and host-wide rate budgets;
// reading subscriptions shares the status budget.
const publishAdmission = new RoutineEventAdmission();
const statusAdmission = new RoutineEventAdmission();

// Host-wide: status and publish share these slots.
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

// Exact host-authored rejections only. Never echo arbitrary errors across the plugin boundary.
const PUBLIC_REJECTIONS = [
  'Routine request is too large or invalid',
  'Routine request intake is busy; retry later',
  'Routine request rate limit reached; retry after 60 seconds',
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

/** A plugin may only report or publish its own declared events; the host derives the source from its identity. */
export async function handleRoutineRequest(
  ghost: InstalledGhost | undefined,
  payload: unknown,
  isCurrent: () => boolean,
): Promise<{
  ok: boolean;
  accepted?: number;
  duplicate?: boolean;
  subscriptions?: PluginEventSubscription[];
  message?: string;
}> {
  if (!ghost?.enabled || !ghost.manifest.routineEvents)
    return { ok: false, message: 'Routine events are not declared or the plugin is disabled' };
  if (!payload || typeof payload !== 'object' || Array.isArray(payload))
    return { ok: false, message: 'Invalid routine request' };
  const request = payload as Record<string, unknown>;
  const plugin = installedGhostStoragePart(ghost);
  let release: (() => void) | undefined;
  let releaseRate: (() => void) | undefined;
  try {
    release = reserveRequest(plugin);
    validateRequestSize(request);
    if (request.action !== 'status' && request.action !== 'publish' && request.action !== 'subscriptions')
      return { ok: false, message: 'Unknown routine operation' };
    if (request.action === 'status' && (typeof request.status !== 'string' || !['listening', 'disconnected', 'error'].includes(request.status)))
      return { ok: false, message: 'Invalid source status' };
    // Rate limits apply before parsing the event and before durable writes; repeated status counts too.
    releaseRate = (request.action === 'publish' ? publishAdmission : statusAdmission).acquire(plugin, Date.now());
    if (request.action === 'subscriptions') {
      if (!isCurrent()) return { ok: false, message: 'Plugin owner or installation changed' };
      // Only the event types and conditions automations chose for this plugin; no automation identity or prompt.
      return { ok: true, subscriptions: pluginEventSubscriptionsFor(plugin) };
    }
    if (request.action === 'status') {
      if (!isCurrent()) return { ok: false, message: 'Plugin owner or installation changed' };
      reportPluginEventStatus(plugin, request.status as PluginEventListenState);
      return { ok: true };
    }
    const event = parseRoutineEvent(request.event);
    if (!ghost.manifest.routineEvents.events.some((declared) => declared.type === event.type))
      return { ok: false, message: 'Event type is undeclared' };
    if (!isCurrent()) return { ok: false, message: 'Plugin owner or installation changed' };
    // accepted counts automations that durably queued it; it does not mean a run succeeded.
    const { accepted, duplicate } = await publishPluginEvent(plugin, {
      id: event.id,
      type: event.type,
      occurredAt: event.occurredAt,
      ...(event.subject !== undefined ? { subject: event.subject } : {}),
      data: event.data,
    });
    return { ok: true, accepted, duplicate };
  } catch (error) {
    const publicMessage = error instanceof Error
      ? PUBLIC_REJECTIONS.find((message) => message === error.message)
      : undefined;
    if (publicMessage) return { ok: false, message: publicMessage };
    log.warn('routine plugin request failed', {
      ghostId: ghost.manifest.id,
      error: error instanceof Error ? error.message : String(error),
    });
    return { ok: false, message: 'Routine request failed; please retry later' };
  } finally {
    releaseRate?.();
    release?.();
  }
}
