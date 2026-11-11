/**
 * Teammate routines were removed, but installed plugins built for them keep calling the
 * `routine-request` pipe (plugin-security-and-authoring.md §5: upgrades must not break them).
 * The host still validates and bounds each request, then answers it as a no-op.
 * Unit tier: the production slot handler with in-memory plugin facts.
 */
import { afterEach, expect, it, vi } from 'vitest';
import type { InstalledGhost } from '../../../shared/ghost.js';
import { handleRoutineRequest } from '../routineSlot.js';

const warn = vi.hoisted(() => vi.fn());
vi.mock('../../logger.js', () => ({ createLogger: () => ({ warn }) }));
afterEach(() => { warn.mockClear(); });

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

it('answers declared status reports and events as a no-op without any listener', async () => {
  expect(await handleRoutineRequest(ghost, listening, () => true)).toEqual({ ok: true });
  expect(await handleRoutineRequest(ghost, publish, () => true)).toEqual({ ok: true, accepted: 0, duplicate: false });
  expect(await handleRoutineRequest(ghost, { ...publish, event: { ...publish.event, type: 'undeclared' } }, () => true))
    .toEqual({ ok: false, message: 'Event type is undeclared' });
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
