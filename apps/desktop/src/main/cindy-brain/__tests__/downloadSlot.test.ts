import { it, expect } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PluginDownloadSlot } from '../downloadSlot';
import type { InstalledGhost } from '../../../shared/ghost';
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
it('cancel reaches only the matching active request', async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'plugin-download-test-')));
  const ghost = {
    enabled: true,
    approval: {},
    manifest: { node: {}, network: { hosts: ['github.com'] } },
  } as unknown as InstalledGhost;
  let started!: () => void;
  const ready = new Promise<void>((r) => (started = r));
  const slot = new PluginDownloadSlot({
    root: (id) => path.join(root, id),
    scope: () => 'a',
    getGhost: () => ghost,
    send: () => {},
    download: async (o) =>
      new Promise((_, reject) => {
        started();
        o.signal!.addEventListener('abort', () => reject(Error('aborted')));
      }),
  });
  try {
    const work = slot.handle('p', {
      kind: 'start',
      id: 'x',
      url: 'https://github.com/file',
      sha256: 'a'.repeat(64),
      bytes: 2,
    });
    await ready;
    await slot.handle('p', { kind: 'cancel', id: 'x' });
    expect(await work).toMatchObject({ ok: false, message: '下载已取消' });
  } finally {
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
