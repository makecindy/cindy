import { mkdtemp, writeFile, readFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  root: '', snapshot: null as any, session: { status: 'active', remoteHostId: null } as any,
  existing: undefined as any, resolved: 'test-session' as string | null, invalidOwner: false,
  ingest: vi.fn(), query: vi.fn(), addRef: vi.fn(), removeRef: vi.fn(),
}));
vi.mock('electron', () => ({ app: { getPath: () => state.root } }));
vi.mock('../../localDb/client/current.js', () => ({ getCurrentDbClientSnapshot: () => state.snapshot }));
vi.mock('../../cindy-media/refCompensationJournal.js', () => ({
  captureMediaRefCompensationScope: () => ({ assertStillValid: () => { if (state.invalidOwner) throw new Error('owner changed'); } }),
  withMediaRefCompensation: async ({ perform, compensate, refIds }: any) => {
    try { return await perform(); }
    catch (error) { for (const id of refIds) await compensate(id); throw error; }
  },
}));
vi.mock('../../cindy-media/ledger.js', () => ({ addRef: (...args: unknown[]) => state.addRef(...args), removeRefById: (...args: unknown[]) => state.removeRef(...args) }));
vi.mock('../../cindy-media/ingest.js', () => ({ ingestMedia: (...args: unknown[]) => state.ingest(...args) }));
vi.mock('../../cindy-media/blobStore.js', () => ({ blobUrl: () => 'cindy-media://blobs/test.png', extForMime: () => '.png', resolveSafe: () => ({ absPath: path.join(state.root, 'saved.png') }) }));
import { createAttachmentRecovery } from '../oversized-attachment-recovery.js';
import { sessions } from '../../localDb/schema.js';

beforeEach(async () => {
  state.root = await mkdtemp(path.join(tmpdir(), 'host-recovery-test-'));
  state.session = { status: 'active', remoteHostId: null };
  state.existing = undefined;
  state.resolved = 'test-session';
  state.invalidOwner = false;
  state.query.mockImplementation((table: unknown) => table === sessions ? state.session : state.existing);
  state.snapshot = { userId: 'owner', clientEpoch: 1, client: { drizzle: {
    select: () => ({ from: (table: unknown) => ({ where: () => ({ get: () => state.query(table) }) }) }),
  } } };
  state.addRef.mockReset();
  state.removeRef.mockReset();
  state.ingest.mockReset();
  state.ingest.mockImplementation(async (params: any) => {
    params.assertStillValid();
    await writeFile(path.join(state.root, 'saved.png'), await readFile(params.filePath));
    return { url: 'cindy-media://blobs/test.png' };
  });
});
afterEach(async () => { await rm(state.root, { recursive: true, force: true }); });
async function body(bytes: Buffer, mime = 'application/pdf') {
  const filePath = path.join(state.root, 'request.json');
  const raw = JSON.stringify({ input: [{ role: 'user', content: [{ type: 'input_file', file_data: `data:${mime};base64,${bytes.toString('base64')}` }] }] });
  await writeFile(filePath, raw);
  return { filePath, bytes: Buffer.byteLength(raw), signal: new AbortController().signal };
}
const factory = () => createAttachmentRecovery(() => state.resolved)({ reqId: 1, method: 'POST', url: '/v1/responses/compact', headers: {} });

it('persists a PDF under the existing session attachment lifecycle and keeps a usable path', async () => {
  const bytes = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(90_000, 1)]);
  const input = await body(bytes);
  const result = await factory()!(input, 1000);
  const text = JSON.parse(result!.toString()).input[0].content[0].text;
  const local = JSON.parse(text.match(/Preserved local file: (".*?")\./)[1]);
  expect(local).toContain(path.join('hook-attachments', 'test-session'));
  expect(local.endsWith('.pdf')).toBe(true);
  expect(await readFile(local)).toEqual(bytes);
  expect(state.ingest).not.toHaveBeenCalled();
  // Retries deduplicate by content without overwriting the file.
  expect(await factory()!(input, 1000)).toEqual(result);
});

it('uses durable media ingestion and session refs for recognized media', async () => {
  const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(90_000)]);
  const result = await factory()!(await body(png, 'image/png'), 1000);
  expect(result!.toString()).toContain('saved.png');
  expect(await readFile(path.join(state.root, 'saved.png'))).toEqual(png);
  expect(state.ingest.mock.calls[0][0]).toMatchObject({ mimeType: 'image/png', isCache: false, refs: [] });
  expect(state.addRef).toHaveBeenCalledWith(expect.objectContaining({ refId: 'test-session', refKind: 'session-attachment' }), expect.anything());
  state.existing = { id: 'prior-ref' };
  await factory()!(await body(png, 'image/png'), 1000);
  expect(state.ingest.mock.calls[1][0].refs).toEqual([]);
  expect(state.addRef).toHaveBeenCalledTimes(1);
});

it.each([null, { status: 'deleted', remoteHostId: null }, { status: 'active', remoteHostId: 'ssh' }])('does not persist for unavailable or remote sessions: %s', async session => {
  state.session = session;
  expect(await factory()!(await body(Buffer.alloc(90_000)), 1000)).toBeNull();
  expect(state.ingest).not.toHaveBeenCalled();
});

it.each(['owner', 'binding', 'database'])('rejects a changed %s while the request is being received', async boundary => {
  const recover = factory()!;
  const input = await body(Buffer.alloc(90_000));
  if (boundary === 'owner') state.invalidOwner = true;
  if (boundary === 'binding') state.resolved = null;
  if (boundary === 'database') state.snapshot = { ...state.snapshot };
  await expect(recover(input, 1000)).rejects.toThrow();
  expect(state.ingest).not.toHaveBeenCalled();
});

it('does not replace an attachment when media persistence fails', async () => {
  const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(90_000)]);
  const input = await body(png, 'image/png');
  const original = await readFile(input.filePath);
  state.ingest.mockRejectedValue(new Error('disk full'));
  await expect(factory()!(input, 1000)).rejects.toThrow('disk full');
  expect(await readFile(input.filePath)).toEqual(original);
});

async function multiBody(blocks: unknown[], text = '') {
  const filePath = path.join(state.root, 'request.json');
  const raw = JSON.stringify({ input: [{ role: 'user', content: [...blocks, { type: 'input_text', text }] }] });
  await writeFile(filePath, raw);
  return { filePath, bytes: Buffer.byteLength(raw), signal: new AbortController().signal };
}
const pdfBlock = (byte: number) => ({ type: 'input_file', file_data: `data:application/pdf;base64,${Buffer.concat([Buffer.from('%PDF-1.7'), Buffer.alloc(3000, byte)]).toString('base64')}` });
const pngBlock = () => ({ type: 'input_image', image_url: `data:image/png;base64,${Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(3000)]).toString('base64')}` });

it('publishes nothing if text still cannot fit after removing every attachment', async () => {
  const input = await multiBody([pdfBlock(1), pngBlock()], 'x'.repeat(100_000));
  expect(await factory()!(input, 1000)).toBeNull();
  expect(state.ingest).not.toHaveBeenCalled();
  expect(await readdir(state.root)).toEqual(['request.json']);
});

it('rolls back newly created files and refs if a later media save fails, preserving prior files', async () => {
  await factory()!(await multiBody([pdfBlock(1)]), 1000);
  const dir = path.join(state.root, 'hook-attachments', 'test-session');
  const before = await readdir(dir);
  state.ingest.mockRejectedValue(new Error('disk full'));
  await expect(factory()!(await multiBody([pdfBlock(1), pdfBlock(2), pngBlock()]), 2000)).rejects.toThrow('disk full');
  expect(await readdir(dir)).toEqual(before);
  expect(state.removeRef).toHaveBeenCalledTimes(1);
});

it('compensates a media reference when a later write fails', async () => {
  state.addRef.mockImplementation(async () => { throw new Error('lost acknowledgement'); });
  await expect(factory()!(await multiBody([pngBlock()]), 1000)).rejects.toThrow('lost acknowledgement');
  expect(state.removeRef.mock.calls[0][0]).toBe(state.addRef.mock.calls[0][0].id);
});
