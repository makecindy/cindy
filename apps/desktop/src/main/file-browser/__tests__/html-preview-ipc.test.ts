import { afterAll, beforeEach, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { FileServiceRpcError } from '@cindy/remote-file-service/client';
import { sharedTaskHostPeer } from '@cindy/device-link';
const mocks = vi.hoisted(() => ({
  handle: vi.fn(),
  trusted: vi.fn(),
  ingest: vi.fn(),
  current: true,
  db: {},
}));
vi.mock('electron', () => ({ ipcMain: { handle: mocks.handle } }));
vi.mock('../../security/trustedAppRenderer.js', () => ({
  assertTrustedAppRendererEvent: mocks.trusted,
}));
vi.mock('../../logger.js', () => ({ createLogger: () => ({ warn: vi.fn() }) }));
vi.mock('../../cindy-media/ingest.js', () => ({ ingestMedia: mocks.ingest }));
vi.mock('../../device-link/broadcast-tap.js', () => ({
  captureDataOwnerBroadcastScope: () => ({ ownerScopeKey: 'owner-a:1' }),
  isDataOwnerBroadcastScopeCurrent: () => mocks.current,
}));
vi.mock('../../localDb/client/current.js', () => ({ getDbClient: () => ({ drizzle: mocks.db }) }));
import { disposeHtmlPreviews, registerHtmlPreviewIpc } from '../html-preview-ipc';
import { readPreviewMetadata, statSshPreviewMetadata } from '../html-preview-read';
const args = {
  origin: { kind: 'device', deviceId: 'remote' },
  workdir: '/remote',
  absPath: '/remote/preview/index.html',
};
beforeEach(() => {
  vi.clearAllMocks();
  mocks.current = true;
});
afterAll(disposeHtmlPreviews);
it('bounds concurrent preparations before allocating more snapshots', async () => {
  let release!: () => void;
  const paused = new Promise<void>((resolve) => {
    release = resolve;
  });
  registerHtmlPreviewIpc({
    stat: async () => {
      await paused;
      throw new Error('offline');
    },
    read: vi.fn(),
  });
  const open = mocks.handle.mock.calls[0][1];
  const settled = Promise.allSettled(Array.from({ length: 8 }, () => open({}, args)));
  await expect(open({}, args)).rejects.toMatchObject({ code: 'HTML_PREVIEW_TOO_LARGE' });
  release();
  expect((await settled).every((result) => result.status === 'rejected')).toBe(true);
});
it('rejects an untrusted guest before any filesystem or remote operation', async () => {
  mocks.trusted.mockImplementationOnce(() => {
    throw new Error('PERMISSION_DENIED');
  });
  const stat = vi.fn();
  registerHtmlPreviewIpc({ stat, read: vi.fn() });
  await expect(mocks.handle.mock.calls[0][1]({}, args)).rejects.toThrow('PERMISSION_DENIED');
  expect(stat).not.toHaveBeenCalled();
});
it.each(['remote', sharedTaskHostPeer('shared', 'host')])('requires a remote read for %s even if a guest has old cached bytes', async (deviceId) => {
  const stat = vi.fn().mockRejectedValue(new Error('METHOD_NOT_FOUND'));
  const cached = vi.fn(async () => deviceId === 'remote' ? null : '/stale-guest.html');
  const source = { ...args, origin: { kind: 'device', deviceId } };
  registerHtmlPreviewIpc({ stat, read: vi.fn(), cached });
  await expect(mocks.handle.mock.calls[0][1]({}, source)).rejects.toMatchObject({
    code: 'HTML_PREVIEW_UNSUPPORTED',
  });
  expect(stat).toHaveBeenCalledExactlyOnceWith(source, '/remote/preview', 'index.html', expect.any(AbortSignal));
  if (deviceId !== 'remote') expect(cached).not.toHaveBeenCalled();
});

// Unit tier, fake clock: the real metadata reader must survive transient
// congestion without retrying permanent errors or allowing unbounded waiting.
it('backs off read-only metadata across congestion and a short disconnect', async () => {
  vi.useFakeTimers();
  try {
    const stat = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error('busy'), { code: 'BACKPRESSURE' }))
      .mockRejectedValueOnce(new Error('[NOT_CONNECTED] reconnecting'))
      .mockResolvedValue({ type: 'file' });
    const result = readPreviewMetadata(stat, new AbortController().signal, () => true);
    await vi.advanceTimersByTimeAsync(999);
    expect(stat).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(stat).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(result).resolves.toEqual({ type: 'file' });
    expect(stat).toHaveBeenCalledTimes(3);
  } finally { vi.useRealTimers(); }
});

it.each([
  ['BACKPRESSURE', 'DEVICE_LINK_BUSY'],
  ['INVOKE_TIMEOUT', 'DEVICE_LINK_TIMEOUT'],
  ['NOT_CONNECTED', 'DEVICE_LINK_NOT_CONNECTED'],
  ['TIMEOUT', 'DEVICE_LINK_TIMEOUT'],
  ['CHANNEL_CLOSED', 'DEVICE_LINK_NOT_CONNECTED'],
  ['CHANNEL_ERROR', 'DEVICE_LINK_NOT_CONNECTED'],
])('bounds repeated %s failures and preserves the connection error', async (code, expected) => {
  vi.useFakeTimers();
  try {
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const stat = vi.fn().mockImplementation(async () => {
      started();
      throw new FileServiceRpcError(code, 'transient');
    });
    registerHtmlPreviewIpc({ stat, read: vi.fn() });
    const result = mocks.handle.mock.calls[0][1]({}, args).catch((e: unknown) => e);
    await ready;
    await vi.advanceTimersByTimeAsync(7_000);
    expect(await result).toMatchObject({ code: expected });
    expect(stat).toHaveBeenCalledTimes(4);
  } finally { vi.useRealTimers(); }
});

// PR #6288: cancellation must reach both SSH stat sends, including the manager's
// internal rebuild. Existing IPC tests inject stat and cannot observe this adapter.
// Unit tier: a paused request gate models connection setup, with no real network.
it.each([[1, false], [2, false], [2, true]] as const)('blocks SSH preview send %s after cancellation (rebuild=%s)', async (cancelAt, rebuild) => {
  const controller = new AbortController();
  const sent: string[] = [];
  let gates = 0;
  const request = vi.fn().mockImplementation(async (_host, _method, params, options) => {
    const send = async () => {
      await Promise.resolve();
      if (++gates === cancelAt) controller.abort();
      await options?.beforeSend?.();
      sent.push(params.relPath);
    };
    await send();
    // The manager repeats its gate after a channel loss and rebuild.
    if (rebuild && params.relPath === 'preview/index.html') await send();
    return { type: 'file' };
  });
  const result = statSshPreviewMetadata({ request }, {
    ...args, origin: { kind: 'ssh', remoteHostId: 'ssh-1' },
  }, '/remote/preview', 'style.css', controller.signal);
  await expect(result).rejects.toMatchObject({ name: 'AbortError' });
  expect(sent).toHaveLength(cancelAt - 1);
});

it('ends a stalled stat at the total deadline and aborts its downstream signal', async () => {
  vi.useFakeTimers();
  try {
    const stat = vi.fn(() => new Promise(() => {}));
    const result = readPreviewMetadata(stat, new AbortController().signal, () => true).catch(e => e);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await result).toMatchObject({ code: 'DEVICE_LINK_TIMEOUT' });
    expect(stat).toHaveBeenCalledOnce();
    expect((stat.mock.calls[0] as unknown as [AbortSignal])[0].aborted).toBe(true);
  } finally { vi.useRealTimers(); }
});

it.each(['cancel', 'owner-change'] as const)('does not start another read after %s during backoff', async (cause) => {
  vi.useFakeTimers();
  try {
    const controller = new AbortController();
    let current = true;
    const stat = vi.fn().mockRejectedValue(new Error('[BACKPRESSURE] busy'));
    const result = readPreviewMetadata(stat, controller.signal, () => current).catch(e => e);
    await vi.advanceTimersByTimeAsync(100);
    if (cause === 'cancel') controller.abort();
    else current = false;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await result).toMatchObject({ code: 'HTML_PREVIEW_CANCELLED' });
    expect(stat).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  } finally { vi.useRealTimers(); }
});

it.each(['cancel', 'destroyed', 'navigation'] as const)('cancels pending metadata on %s and discards its late success', async (trigger) => {
  let resolve!: (value: { relPath: string; type: 'file'; size: number; mtimeMs: number }) => void;
  let started!: () => void;
  const ready = new Promise<void>(done => { started = done; });
  let signal!: AbortSignal;
  const stat = vi.fn((_args, _root, _rel, attemptSignal) => {
    signal = attemptSignal;
    started();
    return new Promise<{ relPath: string; type: 'file'; size: number; mtimeMs: number }>(done => { resolve = done; });
  });
  registerHtmlPreviewIpc({ stat, read: vi.fn() });
  const open = mocks.handle.mock.calls[0][1];
  const cancel = mocks.handle.mock.calls[1][1];
  const sender = Object.assign(new EventEmitter(), { id: 10 });
  const result = open({ sender }, { ...args, requestId: 'preview-1' }).catch((e: unknown) => e);
  await ready;
  // A trusted but different window cannot cancel this sender's allocation.
  await cancel({ sender: { id: 11 } }, 'preview-1');
  expect(signal.aborted).toBe(false);
  if (trigger === 'cancel') await cancel({ sender }, 'preview-1');
  else if (trigger === 'destroyed') sender.emit('destroyed');
  else sender.emit('did-start-navigation', {}, 'https://example.test', false, true);
  expect(await result).toMatchObject({ code: 'HTML_PREVIEW_CANCELLED' });
  expect(signal.aborted).toBe(true);
  resolve({ relPath: 'index.html', type: 'file', size: 0, mtimeMs: 0 });
  await Promise.resolve();
  expect(stat).toHaveBeenCalledOnce();
  expect(sender.listenerCount('destroyed')).toBe(0);
  expect(sender.listenerCount('did-start-navigation')).toBe(0);
});
it('opens a preview before downloading even a large entry file', async () => {
  const read = vi.fn();
  registerHtmlPreviewIpc({
    stat: async () => ({
        name: 'index.html',
        relPath: 'index.html',
        type: 'file',
        size: 101 * 1024 * 1024,
        mtimeMs: 0,
    }),
    read,
  });
  await expect(mocks.handle.mock.calls[0][1]({}, args)).resolves.toMatchObject({ ok: true });
  expect(read).not.toHaveBeenCalled();
});
it.each([1, 2])('serves cached HTML while stat is blocked, then refreshes with mtime %s', async (mtimeMs) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-preview-swr-test-'));
  let reply!: (value: any) => void;
  const metadata = { relPath: 'index.html', type: 'file' as const, size: 3, mtimeMs: 1 };
  const stat = vi.fn(async () => metadata);
  let cached: string | null = null;
  const read = vi.fn(async () => { cached = path.join(dir, 'old.html'); return cached; });
  try {
    await fs.writeFile(path.join(dir, 'old.html'), 'old');
    await fs.writeFile(path.join(dir, 'new.html'), 'new');
    registerHtmlPreviewIpc({ stat, read, cached: async () => cached });
    const open = mocks.handle.mock.calls[0][1];
    const first = await open({}, args);
    expect(await (await readResource(first.url, '/index.html')).text()).toContain('old');
    stat.mockImplementationOnce(() => new Promise(resolve => { reply = resolve; }));
    const second = await open({}, args);
    expect(await (await readResource(second.url, '/index.html')).text()).toContain('old');
    expect(read).toHaveBeenCalledOnce();
    read.mockImplementationOnce(async () => { cached = path.join(dir, 'new.html'); return cached; });
    reply({ ...metadata, mtimeMs });
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    const third = await open({}, args);
    expect(await (await readResource(third.url, '/index.html')).text()).toContain('new');
    expect(await (await readResource(second.url, '/index.html')).text()).toContain('old');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
// #6292 + #6288 integration, unit tier: previous cancellation cases only cover
// uncached preparation. Cancel a cached preview during a stalled background stat;
// its transport must abort and a later open must be able to revalidate again.
it('releases a cancelled cached refresh so the next preview can revalidate', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-preview-refresh-cancel-'));
  const metadata = { relPath: 'index.html', type: 'file' as const, size: 3, mtimeMs: 1 };
  const stat = vi.fn(async (_args, _root, _rel, _signal: AbortSignal) => metadata);
  let cached: string | null = null;
  const read = vi.fn(async () => { cached = path.join(dir, 'old.html'); return cached; });
  try {
    await fs.writeFile(path.join(dir, 'old.html'), 'old');
    registerHtmlPreviewIpc({ stat, read, cached: async () => cached });
    const open = mocks.handle.mock.calls[0][1];
    const cancel = mocks.handle.mock.calls[1][1];
    const first = await open({}, args);
    expect(await (await readResource(first.url, '/index.html')).text()).toContain('old');
    let refreshSignal!: AbortSignal;
    stat.mockImplementationOnce((_args, _root, _rel, signal) => {
      refreshSignal = signal;
      return new Promise(() => {});
    });
    const sender = Object.assign(new EventEmitter(), { id: 20 });
    const second = await open({ sender }, { ...args, requestId: 'cached-preview' });
    expect(await (await readResource(second.url, '/index.html')).text()).toContain('old');
    await cancel({ sender }, 'cached-preview');
    expect(refreshSignal.aborted).toBe(true);
    const callsBeforeReopen = stat.mock.calls.length;
    const third = await open({}, args);
    expect(await (await readResource(third.url, '/index.html')).text()).toContain('old');
    expect(stat.mock.calls.length).toBeGreaterThan(callsBeforeReopen);
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2));
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
it('passes the captured owner guard through reference-free cache ingestion', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-preview-owner-test-'));
  try {
    await fs.writeFile(path.join(dir, 'index.html'), '');
    const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    await fs.writeFile(path.join(dir, 'image.png'), png);
    mocks.ingest.mockImplementationOnce(async (params, db) => {
      expect(db).toBe(mocks.db);
      expect(params.refs).toEqual([]);
      expect(params.isCache).toBe(true);
      params.assertStillValid();
      // The real ingest helper calls this guard after each asynchronous write/ref operation.
      await Promise.resolve();
      mocks.current = false;
      params.assertStillValid();
    });
    registerHtmlPreviewIpc({
      stat: async (_args, _root, name) => ({
          name,
          relPath: name,
          type: 'file' as const,
          size: name === 'image.png' ? png.length : 0,
          mtimeMs: 0,
        }),
      read: async (_args, _root, entry) => path.join(dir, entry.relPath),
    });
    const { url } = await mocks.handle.mock.calls[0][1]({}, args);
    expect((await readResource(url, '/image.png')).status).toBe(502);
    expect(mocks.ingest).toHaveBeenCalledTimes(1);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
it('serves independent media after cache loss without refs across failure and retries', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-preview-ref-test-'));
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  try {
    await fs.writeFile(path.join(dir, 'index.html'), '');
    await fs.writeFile(path.join(dir, 'image.png'), png);
    let fail = true;
    mocks.ingest.mockImplementation(async (params) => {
      expect(params.refs).toEqual([]);
      expect(params.isCache).toBe(true);
      if (fail) { fail = false; throw new Error('cache write failed'); }
      // A reclaimed managed blob is deliberately unavailable; HTTP must use dest.
      return { url: 'cindy-media://blobs/unavailable.png', refIds: [] };
    });
    registerHtmlPreviewIpc({
      stat: async (_args, _root, name) => ({
        name, relPath: name, type: 'file' as const,
        size: name === 'image.png' ? png.length : 0, mtimeMs: 0,
      }),
      read: async (_args, _root, entry) => path.join(dir, entry.relPath),
    });
    const open = mocks.handle.mock.calls[0][1];
    const failed = await open({}, args);
    expect((await readResource(failed.url, '/image.png')).status).toBe(502);
    for (let i = 0; i < 3; i++) {
      const { url } = await open({}, args);
      const bootstrap = await fetch(url, { redirect: 'manual' });
      const cookie = bootstrap.headers.get('set-cookie')!.split(';')[0];
      await bootstrap.body?.cancel();
      const response = await fetch(new URL('/image.png', url), { headers: { cookie } });
      expect(response.status).toBe(200);
      expect(Buffer.from(await response.arrayBuffer())).toEqual(png);
    }
    expect(mocks.ingest).toHaveBeenCalledTimes(4);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
it('opens beyond eight sequential snapshots by reclaiming the oldest completed one', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-preview-capacity-test-'));
  try {
    const source = path.join(dir, 'index.html');
    await fs.writeFile(source, '');
    registerHtmlPreviewIpc({
      stat: async () => ({ relPath: 'index.html', type: 'file', size: 0, mtimeMs: 0 }),
      read: async () => source,
    });
    const open = mocks.handle.mock.calls[0][1];
    const urls: string[] = [];
    for (let i = 0; i < 12; i++) urls.push((await open({}, args)).url);
    await expect(fetch(urls[0])).rejects.toThrow();
    for (const url of urls.slice(-8)) {
      const response = await fetch(url, { redirect: 'manual' });
      expect(response.status).toBe(302);
      await response.body?.cancel();
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

async function readResource(url: string, pathname: string) {
  const bootstrap = await fetch(url, { redirect: 'manual' });
  const cookie = bootstrap.headers.get('set-cookie')!.split(';')[0];
  await bootstrap.body?.cancel();
  return fetch(new URL(pathname, url), { headers: { cookie } });
}

// Regression: weak-network stat used to block even a complete, readable cache.
it('serves cached HTML and assets while stat is pending, retains them on failure, and fences account changes', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-preview-offline-test-'));
  let fail!: () => void;
  const waiting = new Promise<never>((_resolve, reject) => { fail = () => reject(new Error('offline')); });
  try {
    await fs.writeFile(path.join(dir, 'index.html'), '<h1>Saved page</h1>');
    await fs.writeFile(path.join(dir, 'style.css'), 'body { color: blue; }');
    const stat = vi.fn(() => waiting);
    const read = vi.fn();
    registerHtmlPreviewIpc({ cached: async (_args, _root, rel) => path.join(dir, rel), stat, read });
    const { url } = await mocks.handle.mock.calls[0][1]({}, args);
    expect(stat).not.toHaveBeenCalled();
    expect(await (await readResource(url, '/index.html')).text()).toContain('Saved page');
    expect(await (await readResource(url, '/style.css')).text()).toBe('body { color: blue; }');
    expect(stat).toHaveBeenCalledTimes(2);
    expect(read).not.toHaveBeenCalled();
    fail();
    expect(await (await readResource(url, '/index.html')).text()).toContain('Saved page');
    mocks.current = false;
    expect((await fetch(url, { redirect: 'manual' })).status).toBe(410);
  } finally { fail(); await fs.rm(dir, { recursive: true, force: true }); }
});

it('refreshes the durable copy for the next open without replacing the visible snapshot', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-preview-refresh-test-'));
  try {
    const cached = path.join(dir, 'index.html');
    await fs.writeFile(cached, '<p>previous</p>');
    const next = '<p>updated</p>';
    let refreshed!: () => void;
    const update = new Promise<void>((resolve) => { refreshed = resolve; });
    registerHtmlPreviewIpc({
      cached: async () => cached,
      stat: async () => ({ relPath: 'index.html', type: 'file', size: Buffer.byteLength(next), mtimeMs: 1 }),
      read: async () => { await fs.writeFile(cached, next); refreshed(); return cached; },
    });
    const open = mocks.handle.mock.calls[0][1];
    const first = await open({}, args);
    expect(await (await readResource(first.url, '/index.html')).text()).toContain('previous');
    await update;
    expect(await (await readResource(first.url, '/index.html')).text()).toContain('previous');
    const second = await open({}, args);
    expect(await (await readResource(second.url, '/index.html')).text()).toContain('updated');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
