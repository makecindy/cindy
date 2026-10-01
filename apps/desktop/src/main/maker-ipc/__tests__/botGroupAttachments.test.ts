import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  refs: [] as Array<{ id: string; hash: string; refKind: string; refId: string }>,
  blobDir: '',
  removed: [] as string[],
  uploads: new Map<string, string>(),
  db: { name: 'account-a' } as object,
  dbSeen: [] as unknown[],
}));

vi.mock('../../cindy-media/blobStore.js', () => ({
  parseBlobUrl: (url: string) => {
    const match = /^cindy-media:\/\/blobs\/([0-9a-f]{64})\.(\w+)$/.exec(url);
    return match ? { hash: match[1], ext: `.${match[2]}` } : null;
  },
  resolveSafe: (url: string) => ({ absPath: path.join(h.blobDir, url.slice('cindy-media://blobs/'.length)), mimeType: 'image/png', hash: '' }),
  supportedMime: (mime: string) => mime === 'image/png',
}));
vi.mock('../../cindy-media/ledger.js', () => ({
  pinBlob: vi.fn(async () => undefined),
  hasRef: vi.fn(async (ref: { hash: string; refKind: string; refId: string }) =>
    h.refs.some((row) => row.hash === ref.hash && row.refKind === ref.refKind && row.refId === ref.refId)),
  addRef: vi.fn(async (ref: { hash: string; refKind: string; refId: string }, db?: unknown) => {
    h.dbSeen.push(db);
    const id = `ref-${h.refs.length + 1}-${Math.random().toString(36).slice(2, 6)}`;
    h.refs.push({ id, ...ref });
    return id;
  }),
  removeRefById: vi.fn(async (id: string, db?: unknown) => {
    h.dbSeen.push(db);
    h.refs = h.refs.filter((row) => row.id !== id);
    return 1;
  }),
}));
vi.mock('../../localDb/client/current.js', () => ({ getDbClient: () => ({ drizzle: h.db }) }));
vi.mock('../../cindy-media/ingest.js', () => ({
  ingestMedia: vi.fn(async (params: { buffer: Uint8Array; refs: Array<{ refKind: string; refId: string }> }) => {
    const hash = 'b'.repeat(64);
    await fs.writeFile(path.join(h.blobDir, `${hash}.png`), params.buffer);
    const refIds = params.refs.map((ref) => {
      const id = `ref-${h.refs.length + 1}`;
      h.refs.push({ id, hash, ...ref });
      return id;
    });
    return { url: `cindy-media://blobs/${hash}.png`, hash, ext: '.png', refIds };
  }),
}));
vi.mock('../../device-link/mediaTransfer.js', () => ({
  removeRemote: vi.fn(async (key: string) => { h.removed.push(key); }),
}));
vi.mock('../../device-link/remoteAttachment.js', () => ({
  parseRemoteAttachmentRef: (value: string) => {
    if (!value.startsWith('upload://')) return null;
    const id = value.slice('upload://'.length);
    return { ossKey: id.startsWith('oss-') ? id : '', mimeType: id.endsWith('.png') ? 'image/png' : 'application/pdf' };
  },
  materializeRemoteAttachment: vi.fn(async (ref: { ossKey: string; mimeType: string }, destination: string) => {
    const key = [...h.uploads.keys()].find((name) => ref.mimeType === (name.endsWith('.png') ? 'image/png' : 'application/pdf'));
    if (!key) throw new Error('FILE_PEER_DENIED');
    await fs.writeFile(destination, h.uploads.get(key)!);
  }),
}));

import { createBotGroupAttachmentStore, safeAttachmentFileName } from '../botGroupAttachments.js';

let root: string;
const hash = 'a'.repeat(64);

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'bot-group-attachments-'));
  h.blobDir = path.join(root, 'blobs');
  await fs.mkdir(h.blobDir);
  await fs.writeFile(path.join(h.blobDir, `${hash}.png`), 'png');
  h.refs = [];
  h.dbSeen = [];
  h.db = { name: 'account-a' };
  h.removed = [];
  h.uploads = new Map();
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const store = () => createBotGroupAttachmentStore({ ownerRoot: () => path.join(root, 'owner') });

describe('bot group attachment store', () => {
  it('references this computer’s images for the group and keeps picked files in place', async () => {
    const doc = path.join(root, '需求.pdf');
    await fs.writeFile(doc, 'pdf!');
    const odd = path.join(root, 'scan.heic');
    await fs.writeFile(odd, 'heic');
    const image = { id: 'i1', name: 'shot.png', path: 'clipboard://paste-1', category: 'image', mimeType: 'image/png', url: `cindy-media://blobs/${hash}.png` };
    const prepared = await store().prepare({
      groupId: 'g1',
      attachments: [
        image,
        { ...image, id: 'i2' },
        { id: 'f1', name: '需求.pdf', path: doc, category: 'pdf', mimeType: 'application/pdf' },
        { id: 'f2', name: 'scan.heic', path: odd, category: 'image', mimeType: 'image/heic' },
      ],
    });
    if (!prepared.ok) throw new Error(prepared.message);
    expect(prepared.attachments).toEqual([
      { id: 'i1', name: 'shot.png', category: 'image', mimeType: 'image/png', size: 3, url: image.url, path: null },
      { id: 'i2', name: 'shot.png', category: 'image', mimeType: 'image/png', size: 3, url: image.url, path: null },
      { id: 'f1', name: '需求.pdf', category: 'pdf', mimeType: 'application/pdf', size: 4, url: null, path: doc },
      // The media store cannot take it, so members get it as a file.
      { id: 'f2', name: 'scan.heic', category: 'file', mimeType: 'image/heic', size: 4, url: null, path: odd },
    ]);
    expect(h.refs).toHaveLength(2);
    for (const ref of h.refs) expect(ref).toMatchObject({ hash, refKind: 'bot-group-attachment', refId: 'g1', originKind: 'user' });
  });

  it('never lets undoing one send unpin an image another send posted', async () => {
    const image = { id: 'i1', name: 'shot.png', path: 'x', category: 'image', mimeType: 'image/png', url: `cindy-media://blobs/${hash}.png` };
    // The second send starts while the first is still waiting for its group's queue.
    const first = await store().prepare({ groupId: 'g1', attachments: [image] });
    const second = await store().prepare({ groupId: 'g1', attachments: [image] });
    if (!first.ok || !second.ok) throw new Error('prepare failed');
    second.commit();
    await first.discard();
    expect(h.refs).toHaveLength(1);
    expect(h.refs[0]).toMatchObject({ hash, refId: 'g1' });
  });

  it('keeps a batch on the account it started in', async () => {
    const image = { id: 'i1', name: 'shot.png', path: 'x', category: 'image', mimeType: 'image/png', url: `cindy-media://blobs/${hash}.png` };
    const accountA = h.db;
    const prepared = await store().prepare({ groupId: 'g1', attachments: [image] });
    if (!prepared.ok) throw new Error(prepared.message);
    h.db = { name: 'account-b' };
    await prepared.discard();
    expect(h.dbSeen).toEqual([accountA, accountA]);
    expect(h.refs).toEqual([]);
  });

  it('refuses anything it cannot vouch for, undoing the batch', async () => {
    const image = { id: 'i1', name: 'shot.png', path: 'x', category: 'image', mimeType: 'image/png', url: `cindy-media://blobs/${hash}.png` };
    for (const bad of [
      { id: 'f', name: 'a.pdf', path: 'relative/a.pdf', category: 'pdf', mimeType: 'application/pdf' },
      { id: 'f', name: 'a.pdf', path: path.join(root, 'missing.pdf'), category: 'pdf', mimeType: 'application/pdf' },
      { id: 'f', name: 'dir', path: root, category: 'file', mimeType: 'application/octet-stream' },
      { id: 'f', name: 'a.exe', path: '/x', category: 'binary', mimeType: 'x' },
      { ...image, url: `cindy-media://blobs/${'c'.repeat(64)}.png` },
      'nope',
    ]) {
      const result = await store().prepare({ groupId: 'g1', attachments: [image, bad] });
      expect(result).toMatchObject({ ok: false, errorCode: 'INVALID_PARAMS' });
      expect(h.refs).toEqual([]);
    }
    expect(await store().prepare({ groupId: 'g1', attachments: Array.from({ length: 21 }, () => image) }))
      .toMatchObject({ ok: false });
  });

  it('fetches a phone’s uploads into the media store or the group folder, and drops cloud copies once posted', async () => {
    h.uploads.set('photo.png', 'png-bytes');
    h.uploads.set('brief.pdf', 'pdf-bytes');
    const prepared = await store().prepare({
      groupId: 'g1',
      controllerDeviceId: 'phone-1',
      attachments: [
        { id: 'p1', name: 'photo.png', path: 'upload://oss-photo.png', url: 'upload://oss-photo.png', category: 'image', mimeType: 'image/png' },
        { id: 'p2', name: '../brief.pdf', path: 'upload://peer-brief.pdf', category: 'pdf', mimeType: 'application/pdf' },
      ],
    });
    if (!prepared.ok) throw new Error(prepared.message);
    const [photo, brief] = prepared.attachments;
    expect(photo).toMatchObject({ category: 'image', url: `cindy-media://blobs/${'b'.repeat(64)}.png`, path: null });
    expect(h.refs).toMatchObject([{ refKind: 'bot-group-attachment', refId: 'g1' }]);
    const dir = path.join(root, 'owner', 'bot-groups', 'g1', 'attachments');
    expect(path.dirname(path.dirname(brief!.path!))).toBe(dir);
    expect(path.basename(brief!.path!)).toBe('brief.pdf');
    expect(await fs.readFile(brief!.path!, 'utf8')).toBe('pdf-bytes');
    // Nothing is left half-fetched next to the kept files.
    expect((await fs.readdir(dir)).filter((name) => name.startsWith('.incoming'))).toEqual([]);

    expect(h.removed).toEqual([]);
    prepared.commit();
    await vi.waitFor(() => expect(h.removed).toEqual(['oss-photo.png']));
  });

  it('never takes a path on this computer from a phone, and undoes a batch that was not posted', async () => {
    const local = path.join(root, 'secret.pdf');
    await fs.writeFile(local, 'secret');
    expect(await store().prepare({
      groupId: 'g1',
      controllerDeviceId: 'phone-1',
      attachments: [{ id: 'x', name: 'secret.pdf', path: local, category: 'pdf', mimeType: 'application/pdf' }],
    })).toMatchObject({ ok: false });

    h.uploads.set('brief.pdf', 'pdf');
    h.uploads.set('photo.png', 'png');
    const prepared = await store().prepare({
      groupId: 'g1',
      controllerDeviceId: 'phone-1',
      attachments: [
        { id: 'p1', name: 'photo.png', path: 'upload://peer-photo.png', category: 'image', mimeType: 'image/png' },
        { id: 'p2', name: 'brief.pdf', path: 'upload://peer-brief.pdf', category: 'pdf', mimeType: 'application/pdf' },
      ],
    });
    if (!prepared.ok) throw new Error(prepared.message);
    await prepared.discard();
    expect(h.refs).toEqual([]);
    expect(await fs.readdir(path.join(root, 'owner', 'bot-groups', 'g1', 'attachments'))).toEqual([]);
  });

  it('reports a refused transfer without host details', async () => {
    const result = await store().prepare({
      groupId: 'g1',
      controllerDeviceId: 'phone-1',
      attachments: [{ id: 'p', name: 'x.pdf', path: 'upload://peer-x.pdf', category: 'pdf', mimeType: 'application/pdf' }],
    });
    expect(result).toEqual({ ok: false, errorCode: 'INVALID_PARAMS', message: 'FILE_PEER_DENIED' });
  });

  it('turns any name into one safe path segment', () => {
    expect(safeAttachmentFileName('../../etc/passwd')).toBe('passwd');
    expect(safeAttachmentFileName('C:\\x\\a:b?.txt')).toBe('a_b_.txt');
    expect(safeAttachmentFileName('...')).toBe('attachment');
    expect(safeAttachmentFileName(' 报告.pdf ')).toBe('报告.pdf');
  });
});
