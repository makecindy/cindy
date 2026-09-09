import { afterEach, describe, it, expect, vi } from 'vitest';
import { RoutineEngine } from '@cindy/maker-scheduler';
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

describe('Plugin routine publisher', () => {
  it('uses the authenticated plugin identity and accepts only declared, listening events', async () => {
    const engine = new RoutineEngine({
      load: async () => null,
      save: vi.fn(async () => {}),
      execute: vi.fn(async () => ({})),
      id: () => 'id',
      now: () => 1,
      changed: vi.fn(),
      onError: vi.fn(),
    });
    await engine.start();
    const request = (payload: unknown) =>
      handleRoutineRequest(
        ghost,
        payload,
        async () => engine,
        () => true,
      );
    const event = { id: 'event', type: 'new', occurredAt: 1, data: { label: 'inbox' } };
    expect((await request({ action: 'publish', event })).ok).toBe(false);
    expect(await request({ action: 'status', status: 'listening', sourceId: 'other' })).toEqual({
      ok: true,
    });
    expect(engine.listSources().map((source) => source.id)).toEqual(['plugin:mail']);
    expect(await request({ action: 'publish', event })).toEqual({
      ok: true,
      accepted: 0,
      duplicate: false,
    });
    expect(await request({ action: 'publish', event })).toEqual({
      ok: true,
      accepted: 0,
      duplicate: true,
    });
    expect((await request({ action: 'publish', event: { ...event, type: 'undeclared' } })).ok).toBe(
      false,
    );
    await request({ action: 'status', status: 'disconnected' });
    expect((await request({ action: 'publish', event: { ...event, id: 'next' } })).ok).toBe(false);
    await engine.stop();
  });

  it('rejects disabled plugins, missing declarations and stale owners before entering the engine', async () => {
    const getEngine = vi.fn();
    expect(
      (await handleRoutineRequest({ ...ghost, enabled: false }, {}, getEngine, () => true)).ok,
    ).toBe(false);
    expect(getEngine).not.toHaveBeenCalled();
    expect(
      (
        await handleRoutineRequest(
          ghost,
          { action: 'status', status: 'listening' },
          getEngine,
          () => false,
        )
      ).ok,
    ).toBe(false);
  });
});

async function statusFixture() {
  let now = 1000;
  const changed = vi.fn();
  const engine = new RoutineEngine({
    load: async () => null, save: vi.fn(async () => {}), execute: vi.fn(async () => ({})),
    id: () => 'id', now: () => now, changed, onError: vi.fn(),
  });
  await engine.start();
  return {
    engine, changed,
    advance: () => { now += 60_000; },
    request: (payload: unknown, plugin = ghost) => handleRoutineRequest(plugin, payload, async () => engine, () => true),
  };
}

it('does not broadcast unchanged source reports or erase runtime event metadata', async () => {
  const f = await statusFixture();
  await f.request({ action: 'status', status: 'listening' });
  await f.request({ action: 'publish', event: { id: 'first', type: 'new', occurredAt: 1, data: {} } });
  f.changed.mockClear();
  f.advance();
  expect(await f.request({ action: 'status', status: 'listening' })).toEqual({ ok: true });
  expect(f.changed).not.toHaveBeenCalled();
  expect(f.engine.listSources()[0].lastEventAt).toBe(1000);
  const renamed = { ...ghost, manifest: { ...ghost.manifest, name: 'Renamed Mail' } };
  expect(await f.request({ action: 'status', status: 'listening' }, renamed)).toEqual({ ok: true });
  expect(f.changed).toHaveBeenCalledOnce();
  expect(f.engine.listSources()[0]).toMatchObject({ name: 'Renamed Mail', lastEventAt: 1000 });
  await f.request({ action: 'status', status: 'disconnected' }, renamed);
  await f.request({ action: 'status', status: 'disconnected' }, renamed);
  expect(f.changed).toHaveBeenCalledTimes(2);
  await f.engine.stop();
});

it('limits repeated status requests without starving events or blocking host disconnects', async () => {
  const f = await statusFixture();
  for (let i = 0; i < 60; i++) expect(await f.request({ action: 'status', status: 'listening' })).toEqual({ ok: true });
  expect(f.changed).toHaveBeenCalledOnce();
  expect(await f.request({ action: 'status', status: 'error' })).toMatchObject({ ok: false, message: expect.stringContaining('rate limit') });
  expect(f.changed).toHaveBeenCalledOnce();
  expect(f.engine.listSources()[0].status).toBe('listening');
  expect(await f.request({ action: 'publish', event: { id: 'first', type: 'new', occurredAt: 1, data: {} } })).toMatchObject({ ok: true });
  f.changed.mockClear();
  f.engine.removeSource('plugin:mail');
  f.engine.removeSource('plugin:mail');
  f.engine.removeSource('plugin:unknown');
  expect(f.changed).toHaveBeenCalledOnce();
  expect(f.engine.listSources()[0].status).toBe('disconnected');
  expect(await f.request({ action: 'status', status: 'listening' })).toMatchObject({ ok: false });
  const other = { ...ghost, manifest: { ...ghost.manifest, id: 'other' } };
  expect(await f.request({ action: 'status', status: 'listening' }, other)).toEqual({ ok: true });
  f.advance();
  expect(await f.request({ action: 'status', status: 'listening' })).toEqual({ ok: true });
  expect(f.engine.listSources()[0]).toMatchObject({ status: 'listening', lastEventAt: 1000 });
  await f.engine.stop();
});

it('caps aggregate status reports across plugin identities', async () => {
  const f = await statusFixture();
  for (let i = 0; i < 240; i++) {
    const plugin = { ...ghost, manifest: { ...ghost.manifest, id: `plugin-${Math.floor(i / 60)}` } };
    expect(await f.request({ action: 'status', status: 'listening' }, plugin)).toEqual({ ok: true });
  }
  expect(f.changed).toHaveBeenCalledTimes(4);
  expect(await f.request({ action: 'status', status: 'listening' })).toMatchObject({ ok: false, message: expect.stringContaining('rate limit') });
  expect(f.changed).toHaveBeenCalledTimes(4);
  f.advance();
  expect(await f.request({ action: 'status', status: 'listening' })).toEqual({ ok: true });
  expect(f.changed).toHaveBeenCalledTimes(5);
  await f.engine.stop();
});

it.each([
  new Error("EACCES: permission denied, open '/Users/private-user/Library/Application Support/Cindy/routines/routines.json'"),
  new Error("EBUSY: resource busy, rename 'C:\\Users\\private-user\\AppData\\Roaming\\Cindy\\routines\\private.tmp'"),
  new SyntaxError('Unexpected token in private routine instructions'),
  new Error('Routine request rate limit reached; retry after 60 seconds /private/internal-path'),
  'Unexpected failure at /private/internal-path',
])('keeps unexpected startup failure details in Main logs, not plugin replies: %s', async (error) => {
  const result = await handleRoutineRequest(
    ghost, { action: 'status', status: 'listening' }, async () => { throw error; }, () => true,
  );
  expect(result).toEqual({ ok: false, message: 'Routine request failed; please retry later' });
  expect(warn).toHaveBeenCalledWith('routine plugin request failed', {
    ghostId: 'mail', error: error instanceof Error ? error.message : error,
  });
});

it.each(['write', 'rename'])('hides %s failures and keeps the same event retryable until durable acceptance', async (operation) => {
  const save = vi.fn(async () => {});
  const engine = new RoutineEngine({
    load: async () => null, save, execute: vi.fn(async () => ({})),
    id: () => 'id', now: () => 1, changed: vi.fn(), onError: vi.fn(),
  });
  await engine.start();
  const request = (payload: unknown) => handleRoutineRequest(ghost, payload, async () => engine, () => true);
  await request({ action: 'status', status: 'listening' });
  const payload = { action: 'publish', event: { id: 'retry-me', type: 'new', occurredAt: 1, data: { label: 'private-event-data' } } };
  const error = new Error(`EACCES: ${operation} '/Users/private-user/Cindy/routines/private.tmp'`);
  save.mockRejectedValueOnce(error);
  expect(await request(payload)).toEqual({ ok: false, message: 'Routine request failed; please retry later' });
  expect(warn).toHaveBeenCalledWith('routine plugin request failed', { ghostId: 'mail', error: error.message });
  expect(JSON.stringify(warn.mock.calls)).not.toContain('private-event-data');
  expect(await request(payload)).toEqual({ ok: true, accepted: 0, duplicate: false });
  expect(await request(payload)).toEqual({ ok: true, accepted: 0, duplicate: true });
  await engine.stop();
});

it('keeps fixed validation and retry guidance without logging repeated expected rejections', async () => {
  const f = await statusFixture();
  await f.request({ action: 'status', status: 'listening' });
  expect(await f.request({ action: 'publish', event: { id: 'bad', type: 'new', occurredAt: -1, data: {} } }))
    .toEqual({ ok: false, message: 'Invalid event timestamp' });
  for (let i = 0; i < 80; i++) await f.request({ action: 'status', status: 'listening' });
  expect(warn).not.toHaveBeenCalled();
  await f.engine.stop();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const listening = { action: 'status', status: 'listening' };
const publish = { action: 'publish', event: { id: 'startup-event', type: 'new', occurredAt: 1, data: {} } };
const busy = { ok: false, message: 'Routine request intake is busy; retry later' };

it('bounds the entire request including ignored fields before waiting, with UTF-8 accounting', async () => {
  const getEngine = vi.fn();
  const invalid: unknown[] = [
    { ...listening, extra: 'x'.repeat(128 * 1024) },
    { ...publish, event: { ...publish.event, extra: 'x'.repeat(128 * 1024) } },
    { ...listening, extra: { nested: '字'.repeat(45_000) } },
    { ...listening, extra: { ['x'.repeat(128 * 1024)]: true } },
    { ...listening, extra: new Uint8Array(128 * 1024) },
    { ...listening, extra: Array(5000).fill(null) },
    { ...listening, extra: Object.assign([], { hiddenFromJson: 'x'.repeat(128 * 1024) }) },
  ];
  const cycle: Record<string, unknown> = { ...listening };
  cycle.extra = cycle;
  invalid.push(cycle);
  for (const payload of invalid) {
    expect(await handleRoutineRequest(ghost, payload, getEngine, () => true))
      .toEqual({ ok: false, message: 'Routine request is too large or invalid' });
  }
  expect(getEngine).not.toHaveBeenCalled();
  expect(warn).not.toHaveBeenCalled();
  const f = await statusFixture();
  try {
    // Small ignored fields remain compatible, and rejected payloads did not consume slots.
    const pending = Array.from({ length: 8 }, () => f.request({ ...listening, extra: { label: '字'.repeat(10_000) } }));
    expect((await Promise.all(pending)).every((reply) => reply.ok)).toBe(true);
    const data = Object.fromEntries(Array.from({ length: 4 }, (_, i) => [`field${i}`, '字'.repeat(7900)]));
    expect(await f.request({ ...publish, event: { ...publish.event, data } })).toMatchObject({ ok: true });
  } finally {
    await f.engine.stop();
  }
});

it('bounds mixed status/publish requests before startup and cannot bypass a plugin quota by self-reporting identity', async () => {
  const f = await statusFixture();
  const ready = deferred<RoutineEngine>();
  const getEngine = vi.fn(() => ready.promise);
  const request = (payload: unknown, plugin = ghost) => handleRoutineRequest(plugin, payload, getEngine, () => true);
  const pending = Array.from({ length: 8 }, (_, i) => request(i % 2 ? publish : listening));
  try {
    for (let i = 0; i < 20; i++) {
      expect(await request({ ...listening, sourceId: `forged-${i}` })).toEqual(busy);
      expect(await request({ ...publish, botId: `forged-${i}` })).toEqual(busy);
    }
    expect(getEngine).toHaveBeenCalledTimes(8);
    const other = { ...ghost, manifest: { ...ghost.manifest, id: 'other' } };
    pending.push(request(listening, other));
    expect(getEngine).toHaveBeenCalledTimes(9);
  } finally {
    ready.resolve(f.engine);
    expect((await Promise.all(pending)).every((reply) => reply.ok)).toBe(true);
    await f.engine.stop();
  }
});

it('caps all plugin startup requests at 32 and returns every slot after success', async () => {
  const f = await statusFixture();
  const ready = deferred<RoutineEngine>();
  const getEngine = vi.fn(() => ready.promise);
  const plugin = (i: number) => ({ ...ghost, manifest: { ...ghost.manifest, id: `startup-${i}` } });
  const pending = Array.from({ length: 32 }, (_, i) =>
    handleRoutineRequest(plugin(Math.floor(i / 8)), listening, getEngine, () => true));
  try {
    expect(await handleRoutineRequest(plugin(4), publish, getEngine, () => true)).toEqual(busy);
    expect(getEngine).toHaveBeenCalledTimes(32);
    ready.resolve(f.engine);
    expect((await Promise.all(pending)).every((reply) => reply.ok)).toBe(true);
    // Refill all slots, not just one, to catch counter leaks after settled requests.
    const retry = Array.from({ length: 32 }, (_, i) =>
      handleRoutineRequest(plugin(Math.floor(i / 8)), listening, getEngine, () => true));
    expect((await Promise.all(retry)).every((reply) => reply.ok)).toBe(true);
  } finally {
    ready.resolve(f.engine);
    await Promise.all(pending);
    await f.engine.stop();
  }
});

it.each(['startup failure', 'owner changed', 'publisher failure'])('releases all reserved slots after %s', async (failure) => {
  const f = await statusFixture();
  const ready = deferred<RoutineEngine>();
  let current = true;
  const pending = Array.from({ length: 8 }, () => handleRoutineRequest(
    ghost, failure === 'publisher failure' ? publish : listening, () => ready.promise, () => current,
  ));
  try {
    if (failure === 'startup failure') ready.reject(new Error('startup failed'));
    else {
      if (failure === 'owner changed') current = false;
      // Publish fails because this engine has no listening source.
      ready.resolve(f.engine);
    }
    expect((await Promise.all(pending)).every((reply) => !reply.ok)).toBe(true);
    const retry = Array.from({ length: 8 }, () => f.request(listening));
    expect((await Promise.all(retry)).every((reply) => reply.ok)).toBe(true);
  } finally {
    ready.resolve(f.engine);
    await Promise.all(pending);
    await f.engine.stop();
  }
});

it('rejects invalid operations and oversized events without waiting for startup or leaking slots', async () => {
  const getEngine = vi.fn();
  const invalid = [
    { action: 'unknown' },
    { action: 'status', status: 'unknown' },
    { action: 'publish', event: { ...publish.event, data: { oversized: 'x'.repeat(8001) } } },
    { action: 'publish', event: { ...publish.event, data: Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`field${i}`, 'x'.repeat(8000)])) } },
  ];
  for (let i = 0; i < 12; i++) {
    for (const payload of invalid) {
      const reply = await handleRoutineRequest(ghost, payload, getEngine, () => true);
      expect(reply.ok).toBe(false);
      expect(reply).not.toEqual(busy);
    }
  }
  expect(getEngine).not.toHaveBeenCalled();
});

it('keeps slots reserved until publish finishes, not only until the engine is ready', async () => {
  const saved = deferred<void>();
  const save = vi.fn(async () => {});
  const engine = new RoutineEngine({
    load: async () => null, save, execute: vi.fn(async () => ({})),
    id: () => 'id', now: () => 1, changed: vi.fn(), onError: vi.fn(),
  });
  await engine.start();
  const getEngine = vi.fn(async () => engine);
  const request = (payload: unknown) => handleRoutineRequest(ghost, payload, getEngine, () => true);
  await request(listening);
  save.mockClear();
  save.mockImplementationOnce(() => saved.promise);
  const pending = Array.from({ length: 8 }, (_, i) => request({ ...publish, event: { ...publish.event, id: `slow-${i}` } }));
  try {
    await vi.waitFor(() => expect(save).toHaveBeenCalled());
    expect(await request(listening)).toEqual(busy);
    expect(getEngine).toHaveBeenCalledTimes(9);
    saved.resolve();
    expect((await Promise.all(pending)).every((reply) => reply.ok)).toBe(true);
    expect(await request(listening)).toEqual({ ok: true });
  } finally {
    saved.resolve();
    await Promise.all(pending);
    await engine.stop();
  }
});
