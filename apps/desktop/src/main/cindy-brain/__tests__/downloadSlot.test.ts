import { it, expect, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PluginDownloadSlot } from '../downloadSlot';
import { PluginDownloadCache } from '../downloadCache';
import type { InstalledGhost } from '../../../shared/ghost';
it('a destroyed caller cannot enter Node after a delayed lease, even if the plugin remains enabled', async () => {
  let finish!: () => void;
  const barrier = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const release = vi.fn();
  const acquire = vi
    .spyOn(PluginDownloadCache.prototype, 'acquire')
    .mockImplementation(async () => {
      await barrier;
      return { path: '/fixture/artifact', release };
    });
  let active = true;
  const slot = new PluginDownloadSlot({
    root: () => '/fixture',
    scope: () => 'owner',
    send() {},
    getGhost: () => ({ enabled: true, approval: {}, manifest: { node: {} } }) as InstalledGhost,
    download: async () => {
      throw Error('unused');
    },
  });
  const run = vi.fn(async () => ({ ok: true }));
  try {
    const request = slot.withNodeDownloads(
      'p',
      { downloadTokens: { archive: 'receipt' } },
      run,
      () => active,
    );
    expect(acquire).toHaveBeenCalledOnce();
    active = false; // runtime.stop destroys the caller before broker.stopAndWait.
    finish();
    expect(await request).toMatchObject({ ok: false });
    expect(run).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
    expect(await slot.withNodeDownloads('p', {}, run, () => active)).toMatchObject({ ok: false });
    expect(run).not.toHaveBeenCalled();
  } finally {
    finish();
    acquire.mockRestore();
  }
});
it('shutdown drains cancelled downloads and rejects new downloads and Node handoffs', async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'download-shutdown-')));
  let started!: () => void, finish!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const drained = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const slot = new PluginDownloadSlot({
    root: (id) => path.join(root, id),
    scope: () => 'anonymous',
    send() {},
    getGhost: () =>
      ({
        enabled: true,
        approval: {},
        manifest: { node: {}, network: { hosts: ['github.com'] } },
      }) as unknown as InstalledGhost,
    download: async (options) => {
      started();
      await new Promise<void>((resolve) =>
        options.signal!.addEventListener('abort', () => resolve(), { once: true }),
      );
      await drained;
      throw Error('aborted');
    },
  });
  const request = {
    kind: 'start',
    id: 'x',
    url: 'https://github.com/file',
    sha256: 'a'.repeat(64),
    bytes: 2,
  };
  try {
    const work = slot.handle('p', request);
    await ready;
    let stopped = false;
    const stop = slot.stopAndWait().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    expect(await slot.handle('p', { ...request, id: 'later' })).toMatchObject({ ok: false });
    expect(
      await slot.withNodeDownloads('p', {}, async () => {
        throw Error('must not run');
      }),
    ).toMatchObject({ ok: false });
    finish();
    await stop;
    await work;
    await slot.removePlugin('p');
    await expect(fs.stat(path.join(root, 'p'))).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    finish();
    await fs.rm(root, { recursive: true, force: true });
  }
});
it('restricts redirects, rejects arbitrary paths and isolates owner delivery', async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'plugin-download-test-')));
  let scope = 'a';
  const events: unknown[] = [];
  const ghost = {
    enabled: true,
    approval: { state: 'approved' },
    manifest: { node: {}, network: { hosts: ['github.com'] } },
  } as unknown as InstalledGhost;
  let calls = 0;
  const slot = new PluginDownloadSlot({
    root: (id) => path.join(root, id),
    scope: () => scope,
    getGhost: () => ghost,
    send: (_, e) => events.push(e),
    download: async (o) => {
      calls++;
      expect(() => o.validateUrl!('https://evil.invalid/file')).toThrow();
      expect(() => o.validateUrl!('http://github.com/file')).toThrow();
      o.onProgress?.({ loaded: 1, total: 2, percent: 50, speedBps: 1 });
      scope = 'b';
      return {
        path: o.targetPath,
        size: 2,
        sha256: o.sha256,
        fromCache: false,
        durationMs: 1,
        resumedFromBytes: 0,
      };
    },
  });
  const req = {
    kind: 'start',
    id: 'x',
    url: 'https://github.com/file',
    sha256: 'a'.repeat(64),
    bytes: 2,
  };
  try {
    expect(await slot.handle('p', { ...req, targetPath: '/tmp/arbitrary' })).toMatchObject({
      ok: false,
    });
    expect(calls).toBe(0);
    expect(await slot.handle('p', req)).toMatchObject({ ok: false });
    expect(calls).toBe(1);
    expect(events.filter((x: any) => x.data.phase === 'completed')).toHaveLength(0);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
it('cancel drains the matching request before acknowledging an immediate same-id retry', async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'plugin-download-test-')));
  const ghost = {
    enabled: true,
    approval: {},
    manifest: { node: {}, network: { hosts: ['github.com'] } },
  } as unknown as InstalledGhost;
  let started!: () => void;
  const ready = new Promise<void>((r) => (started = r));
  let finish!: () => void;
  const cleanup = new Promise<void>((r) => (finish = r));
  let calls = 0;
  const slot = new PluginDownloadSlot({
    root: (id) => path.join(root, id),
    scope: () => 'a',
    getGhost: () => ghost,
    send: () => {},
    download: async (o) => {
      if (++calls === 1) {
        await new Promise<void>((resolve) => {
          started();
          o.signal!.addEventListener('abort', () => resolve());
        });
        await cleanup;
        throw Error('aborted');
      }
      await fs.writeFile(o.targetPath, 'ok');
      return {
        path: o.targetPath,
        size: 2,
        sha256: o.sha256,
        fromCache: false,
        durationMs: 1,
        resumedFromBytes: 0,
      };
    },
  });
  try {
    const request = {
      kind: 'start',
      id: 'x',
      url: 'https://github.com/file',
      sha256: 'a'.repeat(64),
      bytes: 2,
    };
    const work = slot.handle('p', request);
    await ready;
    let acknowledged = false;
    const cancel = slot.handle('p', { kind: 'cancel', id: 'x' }).then(() => {
      acknowledged = true;
    });
    await Promise.resolve();
    expect(acknowledged).toBe(false);
    finish();
    await cancel;
    expect(await work).toMatchObject({ ok: false, message: '下载已取消' });
    expect(await slot.handle('p', request)).toMatchObject({ ok: true });
    expect(calls).toBe(2);
  } finally {
    finish();
    await fs.rm(root, { recursive: true, force: true });
  }
});

it('hands opaque receipts only to the owning Node call and preserves legacy params', async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'plugin-receipt-test-')));
  const alias = root + '-alias';
  const outside = root + '-outside';
  await fs.symlink(root, alias, process.platform === 'win32' ? 'junction' : 'dir');
  let scope = 'a';
  const ghost = {
    enabled: true,
    approval: { revision: 'a' },
    manifest: { node: {}, network: { hosts: ['github.com'] } },
  } as unknown as InstalledGhost;
  const slot = new PluginDownloadSlot({
    root: (id) => path.join(alias, id),
    scope: () => scope,
    getGhost: () => ghost,
    send: () => {},
    download: async (o) => {
      await fs.writeFile(o.targetPath, 'ok');
      return {
        path: o.targetPath,
        size: 2,
        sha256: o.sha256,
        fromCache: false,
        durationMs: 1,
        resumedFromBytes: 0,
      };
    },
  });
  const req = {
    kind: 'start',
    id: 'x',
    url: 'https://github.com/file',
    sha256: 'a'.repeat(64),
    bytes: 2,
  };
  try {
    const result = (await slot.handle('p', req)) as { ok: boolean; token: string };
    expect(result.ok).toBe(true);
    expect(result).not.toHaveProperty('path');
    let called = 0;
    const run = async (payload: any) => {
      called++;
      expect(await fs.readFile(payload.params.downloads.archive, 'utf8')).toBe('ok');
      return { ok: true };
    };
    const payload = {
      type: 'node-request',
      method: 'unpack',
      downloadTokens: { archive: result.token },
      params: {},
    };
    expect(await slot.withNodeDownloads('other', payload, run)).toMatchObject({
      ok: false,
      errorCode: 'INVALID_REQUEST',
    });
    expect(await slot.withNodeDownloads('p', payload, run)).toEqual({ ok: true });
    expect(called).toBe(1);
    expect(
      await slot.withNodeDownloads('p', { ...payload, params: { downloads: {} } }, run),
    ).toMatchObject({ ok: false });
    scope = 'b';
    expect(await slot.withNodeDownloads('p', payload, run)).toMatchObject({
      ok: false,
      errorCode: 'INVALID_REQUEST',
    });
    scope = 'a';
    ghost.approval = { ...ghost.approval, revision: 'b' } as InstalledGhost['approval'];
    expect(await slot.withNodeDownloads('p', payload, run)).toMatchObject({ ok: false });
    const legacy = { type: 'node-request', params: ['legacy'] };
    expect(await slot.withNodeDownloads('p', legacy, async (p) => p)).toBe(legacy);
    await slot.removePlugin('p');
    await expect(fs.stat(path.join(root, 'p'))).rejects.toMatchObject({ code: 'ENOENT' });
    scope = 'a';
    await fs.mkdir(outside);
    await fs.symlink(
      outside,
      path.join(root, 'p'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    expect(await slot.handle('p', req)).toMatchObject({ ok: false });
  } finally {
    await fs.unlink(alias);
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
});
