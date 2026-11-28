/**
 * Installed plugins built for teammate routines keep calling the `routine-request` pipe
 * (plugin-security-and-authoring.md §5: upgrades must not break them). Since 2026-11-23 a published
 * event is handed to the automations that chose this plugin (docs/product-rules/plugin-event-triggers.md);
 * the host still validates and bounds each request first and derives the source from the plugin identity.
 * Unit tier: the production slot handler with in-memory plugin facts and the real hand-off module.
 */
import { afterEach, expect, it, vi } from 'vitest';
import type { InstalledGhost } from '../../../shared/ghost.js';
import { installedGhostStoragePart } from '../../../shared/pluginIdentity.js';
import { handleRoutineRequest } from '../routineSlot.js';
import {
  onPluginEventSubscriptionsChanged,
  pluginEventSourceStatus,
  resetPluginEventsForTest,
  setPluginEventSink,
  setPluginEventSubscriptions,
} from '../../scheduler-host/webhook/pluginEvents.js';

const warn = vi.hoisted(() => vi.fn());
vi.mock('../../logger.js', () => ({ createLogger: () => ({ warn }) }));
afterEach(() => { warn.mockClear(); resetPluginEventsForTest(); });

const ghost = {
  enabled: true,
  manifest: {
    id: 'mail',
    name: 'Mail',
    routineEvents: { events: [{ type: 'new', name: 'New Mail', fields: ['label'] }] },
  },
} as InstalledGhost;
const listening = { action: 'status', status: 'listening' };
const publish = { action: 'publish', event: { id: 'event', type: 'new', occurredAt: 1, data: { label: 'inbox' } } };

it('hands declared events to automations under the host-derived source and records listening status', async () => {
  // No automation host (passive instance or not started): the event was valid, nothing can run it.
  expect(await handleRoutineRequest(ghost, publish, () => true)).toEqual({ ok: true, accepted: 0, duplicate: false });
  const sink = vi.fn(async () => ({ accepted: 2, duplicate: false }));
  setPluginEventSink(sink);
  expect(await handleRoutineRequest(ghost, listening, () => true)).toEqual({ ok: true });
  expect(pluginEventSourceStatus(installedGhostStoragePart(ghost)).state).toBe('listening');
  expect(await handleRoutineRequest(ghost, { ...publish, sourceId: 'plugin:someone-else' }, () => true))
    .toEqual({ ok: true, accepted: 2, duplicate: false });
  expect(sink).toHaveBeenCalledWith(installedGhostStoragePart(ghost), { id: 'event', type: 'new', occurredAt: 1, data: { label: 'inbox' } });
  expect(await handleRoutineRequest(ghost, { ...publish, event: { ...publish.event, type: 'undeclared' } }, () => true))
    .toEqual({ ok: false, message: 'Event type is undeclared' });
  expect(await handleRoutineRequest(ghost, publish, () => false)).toEqual({ ok: false, message: 'Plugin owner or installation changed' });
  expect(sink).toHaveBeenCalledOnce();
  // A failed durable write is retryable and never leaks the underlying error to the plugin.
  sink.mockRejectedValueOnce(new Error('/private/path EIO'));
  expect(await handleRoutineRequest(ghost, publish, () => true)).toEqual({ ok: false, message: 'Routine request failed; please retry later' });
});

it('tells a plugin only its own subscriptions, so it can watch just the chosen objects', async () => {
  const plugin = installedGhostStoragePart(ghost);
  const subscriptions = { subscriptions: { action: 'subscriptions' } }.subscriptions;
  expect(await handleRoutineRequest(ghost, subscriptions, () => true)).toEqual({ ok: true, subscriptions: [] });
  setPluginEventSubscriptions(new Map([
    [plugin, [{ events: ['new'], filters: [{ field: 'label', operator: 'equals', value: 'inbox' }] }]],
    ['someone-else', [{ events: ['secret'] }]],
  ]));
  expect(await handleRoutineRequest(ghost, subscriptions, () => true)).toEqual({
    ok: true,
    subscriptions: [{ events: ['new'], filters: [{ field: 'label', operator: 'equals', value: 'inbox' }] }],
  });
  expect(await handleRoutineRequest(ghost, subscriptions, () => false)).toEqual({ ok: false, message: 'Plugin owner or installation changed' });
});

it('announces a plugin\'s new subscriptions only when they actually change', () => {
  const seen: Array<[string, unknown]> = [];
  onPluginEventSubscriptionsChanged((plugin, subscriptions) => seen.push([plugin, subscriptions]));
  const gitlab = [{ events: ['merge_request.merged'] }];
  const both = new Map<string, Array<{ events?: string[] }>>([['gitlab', gitlab], ['chat', [{}]]]);
  setPluginEventSubscriptions(both);
  setPluginEventSubscriptions(new Map(both));
  // The last automation for chat was removed: chat hears about it, gitlab does not.
  setPluginEventSubscriptions(new Map([['gitlab', gitlab]]));
  expect(seen).toEqual([['gitlab', gitlab], ['chat', [{}]], ['chat', []]]);
});

it('rate-limits publishing per plugin before events reach the queue', async () => {
  const sink = vi.fn(async () => ({ accepted: 1, duplicate: false }));
  setPluginEventSink(sink);
  const busy = { ...ghost, manifest: { ...ghost.manifest, id: 'busy-mail' } } as InstalledGhost;
  for (let i = 0; i < 60; i++) expect((await handleRoutineRequest(busy, publish, () => true)).ok).toBe(true);
  expect(await handleRoutineRequest(busy, publish, () => true))
    .toEqual({ ok: false, message: 'Routine request rate limit reached; retry after 60 seconds' });
  expect(sink).toHaveBeenCalledTimes(60);
});

it('rejects disabled plugins, missing declarations and stale owners', async () => {
  expect((await handleRoutineRequest({ ...ghost, enabled: false }, listening, () => true)).ok).toBe(false);
  expect((await handleRoutineRequest({ ...ghost, manifest: { ...ghost.manifest, routineEvents: undefined } }, listening, () => true)).ok).toBe(false);
  expect(await handleRoutineRequest(ghost, listening, () => false)).toEqual({ ok: false, message: 'Plugin owner or installation changed' });
});

it('keeps the request bounds, including ignored fields and UTF-8 accounting, without leaking slots', async () => {
  const invalid: unknown[] = [
    { ...listening, extra: 'x'.repeat(128 * 1024) },
    { ...listening, extra: { nested: '字'.repeat(45_000) } },
    { ...listening, extra: Array(5000).fill(null) },
    { ...listening, extra: Object.assign([], { hiddenFromJson: 'x'.repeat(128 * 1024) }) },
  ];
  const cycle: Record<string, unknown> = { ...listening };
  cycle.extra = cycle;
  invalid.push(cycle);
  for (let round = 0; round < 12; round++) {
    for (const payload of invalid) {
      expect(await handleRoutineRequest(ghost, payload, () => true))
        .toEqual({ ok: false, message: 'Routine request is too large or invalid' });
    }
    expect((await handleRoutineRequest(ghost, { action: 'unknown' }, () => true)).ok).toBe(false);
    expect((await handleRoutineRequest(ghost, { action: 'status', status: 'unknown' }, () => true)).ok).toBe(false);
    expect((await handleRoutineRequest(ghost, { ...publish, event: { ...publish.event, data: { oversized: 'x'.repeat(8001) } } }, () => true)).ok)
      .toBe(false);
  }
  expect(warn).not.toHaveBeenCalled();
  // Rejections released their slots: a full batch of valid requests is still admitted.
  const replies = await Promise.all(Array.from({ length: 8 }, () => handleRoutineRequest(ghost, listening, () => true)));
  expect(replies.every((reply) => reply.ok)).toBe(true);
});
