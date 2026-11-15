import { mkdtemp, writeFile, readFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { createAnthropicCompatProxy } from '@cindy/anthropic-compat-proxy';
import path from 'node:path';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  root: '', snapshot: null as any, session: { status: 'active', remoteHostId: null } as any,
  existing: undefined as any, resolved: 'test-session' as string | null, invalidOwner: false,
  getSnapshot: vi.fn(), info: vi.fn(), ingest: vi.fn(), query: vi.fn(), addRef: vi.fn(), removeRef: vi.fn(),
}));
vi.mock('../../logger.js', () => ({ createLogger: () => ({ info: state.info }) }));
vi.mock('electron', () => ({ app: { getPath: () => state.root } }));
vi.mock('../../localDb/client/current.js', () => ({ getCurrentDbClientSnapshot: () => state.getSnapshot() }));
vi.mock('node:fs/promises', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs/promises')>();
  return { ...fs, mkdtemp: vi.fn(fs.mkdtemp), rm: vi.fn(fs.rm) };
});
vi.mock('../../cindy-media/refCompensationJournal.desktop.js', () => ({
  captureMediaRefCompensationScope: () => ({ assertStillValid: () => { if (state.invalidOwner) throw new Error('owner changed'); } }),
  withMediaRefCompensation: async ({ perform, compensate, refIds }: any) => {
    try { return await perform(); }
    catch (error) { for (const id of refIds) await compensate(id); throw error; }
  },
}));
vi.mock('../../cindy-media/ledger.js', () => ({ addRef: (...args: unknown[]) => state.addRef(...args), removeRefById: (...args: unknown[]) => state.removeRef(...args) }));
vi.mock('../../cindy-media/ingest.js', () => ({ ingestMedia: (...args: unknown[]) => state.ingest(...args) }));
vi.mock('../../cindy-media/blobStore.desktop.js', () => ({ blobUrl: () => 'cindy-media://blobs/test.png', extForMime: () => '.png', resolveSafe: () => ({ absPath: path.join(state.root, 'saved.png') }) }));
import { createAttachmentRecovery, createRequestSizeController } from '../oversized-attachment-recovery.js';
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
  state.getSnapshot.mockReset().mockImplementation(() => state.snapshot);
  state.query.mockClear();
  vi.mocked(mkdtemp).mockClear();
  vi.mocked(rm).mockClear();
  state.info.mockReset();
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
function preservedLocalPath(text: string): string {
  const quoted = /Preserved local file: ("(?:\\.|[^"\\])*")\./.exec(text)?.[1];
  if (!quoted) throw new Error('Missing preserved-file JSON string literal');
  return JSON.parse(quoted) as string;
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

// Production controller contract: native Codex/CC headers contain no provider ID.
// The host resolver must reach prepare and keep denied-format records separate.
it.each(['thread-id', 'x-claude-code-session-id'])('uses host provider resolution for %s and isolates format memory', async header => {
  state.resolved = `provider-test-${header}`;
  let provider = 'provider-a';
  const prepare = vi.fn<import('@cindy/anthropic-compat-proxy').InlineImagePreprocessor['prepare']>(async () => null);
  const controller = createRequestSizeController(() => state.resolved, { prepare }, () => provider);
  const ctx = { reqId: 1, method: 'POST', url: '/v1/responses', headers: { [header]: 'native-session' } };
  const input = { model: 'gpt-test', input: [{ role: 'user', content: [{ type: 'input_image', image_url: `data:image/png;base64,${Buffer.alloc(8000, 7).toString('base64')}` }] }] };
  const raw = Buffer.from(JSON.stringify(input));
  const signal = new AbortController().signal;
  await controller.control(raw, 'responses', { context: ctx, signal, route: controller.route!(ctx, input) });
  expect(prepare.mock.calls[0]?.[0]).toMatchObject({ route: { providerId: 'provider-a' } });
  await controller.retry!(raw, { kind: 'unsupported-image-format' }, ctx, signal);
  expect(controller.route!(ctx, input).deniedMimeTypes).toContain('image/webp');
  const extended = Buffer.from(JSON.stringify({ ...input, trailingText: 'more history' }));
  // A format rejection can deny a MIME, but must not teach a byte budget.
  expect(await controller.control(extended, 'responses', { context: ctx, signal, route: controller.route!(ctx, input) })).toBeNull();
  provider = 'provider-b';
  expect(controller.route!(ctx, input)).toMatchObject({ providerId: 'provider-b', deniedMimeTypes: [] });
  expect(await controller.control(extended, 'responses', { context: ctx, signal, route: controller.route!(ctx, input) })).toBeNull();
  expect(prepare.mock.calls.at(-1)?.[0]).toMatchObject({ route: { providerId: 'provider-b', deniedMimeTypes: [] } });
});

// A missing local owner must disable persistence, not preprocessing. Production
// shared controller, 8 KiB request / 1 KiB budget, unit tier; no real account data.
it.each(['no-db', 'no-session', 'invalid-session', 'session-missing', 'session-deleted', 'remote-session'] as const)(
  'compresses without persistence and logs the skip reason for %s', async reason => {
    if (reason === 'no-db') state.snapshot = null;
    if (reason === 'no-session') state.resolved = null;
    if (reason === 'invalid-session') state.resolved = 'invalid/session';
    if (reason === 'session-missing') state.session = null;
    if (reason === 'session-deleted') state.session.status = 'deleted';
    if (reason === 'remote-session') state.session.remoteHostId = 'remote';
    const bytes = Buffer.alloc(500, 9);
    const prepare = vi.fn(async () => ({ bytes, mimeType: 'image/webp', width: 10, height: 10, changed: true, cacheKey: 'test' }));
    const controller = createRequestSizeController(() => state.resolved, { prepare });
    const raw = Buffer.from(JSON.stringify({ input: [{ role: 'user', content: [pngBlock()] }], text: 't'.repeat(2000) }));
    const result = await controller.control(raw, 'responses', { triggerBytes: 1024, targetBytes: 512, signal: new AbortController().signal,
      context: { reqId: 73, method: 'POST', url: '/v1/responses', headers: {} }, route: { modelId: 'gpt-test' } });
    expect(prepare).toHaveBeenCalledOnce();
    expect(result?.removedImages).toBe(0);
    expect(result!.body.length).toBeGreaterThan(1024); // No new hard cap without a local owner.
    expect(result!.body.toString()).toContain(`data:image/webp;base64,${bytes.toString('base64')}`);
    expect(state.ingest).not.toHaveBeenCalled();
    expect(state.addRef).not.toHaveBeenCalled();
    expect(await readdir(state.root)).toEqual([]);
    expect(state.info).toHaveBeenCalledExactlyOnceWith('request size control skipped', {
      reqId: 73, reason: reason === 'invalid-session' ? 'no-session' : reason === 'session-deleted' ? 'session-missing' : reason,
      originalBytes: raw.length, imageCount: 1,
    });
  },
);

it('preserves the original request on controller errors and logs only the error type', async () => {
  state.ingest.mockRejectedValue(new TypeError('private content /secret/path bearer-secret'));
  const prepare = vi.fn(async () => null);
  const controller = createRequestSizeController(() => state.resolved, { prepare });
  const raw = Buffer.from(JSON.stringify({ input: [{ role: 'user', content: [pngBlock()] }] }));
  expect(await controller.control(raw, 'responses', { triggerBytes: 1024, targetBytes: 512, signal: new AbortController().signal, route: {},
    context: { reqId: 74, method: 'POST', url: '/v1/responses', headers: {} } })).toBeNull();
  expect(prepare).toHaveBeenCalledOnce();
  expect(state.info).toHaveBeenCalledExactlyOnceWith('request size control skipped', {
    reqId: 74, reason: 'error', originalBytes: raw.length, imageCount: 1, errorType: 'TypeError',
  });
});

// Unit regression: retry generation persists omitted media but cannot learn a
// rule before an upstream success. Sixty small images reproduce the 50/22 rule.
it('persists count recovery media without learning a rule during body generation', async () => {
  const controller = createRequestSizeController(() => state.resolved);
  const parsed = { model: 'grok-test', input: Array.from({ length: 60 }, () => ({ role: 'user', content: [pngBlock()] })) };
  const raw = Buffer.from(JSON.stringify(parsed));
  const ctx = { reqId: 91, method: 'POST', url: '/v1/responses', headers: {} };
  const signal = new AbortController().signal;
  const retried = await controller.retry!(raw, { kind: 'image-count', limitCount: 50 }, ctx, signal);
  const { input } = JSON.parse(retried!.toString()) as { input: Array<{
    role: 'user'; content: Array<{ type: 'input_image'; image_url: string } | { type: 'input_text'; text: string }>;
  }> };
  expect(input.filter(item => item.content[0].type === 'input_image')).toHaveLength(31);
  const first = input[0].content[0];
  expect(first.type).toBe('input_text');
  expect(preservedLocalPath('text' in first ? first.text : '')).toBe(path.join(state.root, 'saved.png'));
  expect(state.ingest).toHaveBeenCalled();
  expect(state.addRef).toHaveBeenCalled();
  expect(await controller.control(raw, 'responses', { context: ctx, signal, route: controller.route!(ctx, parsed) })).toBeNull();
});

// Production host controller and actual HTTP forwarding: ordinary text must
// bypass session DB, media scratch directories, preprocessing and INFO logs.
// Unit tier; the three reported request sizes, with byte equality on the wire.
it.each([100 * 1024, 1024 * 1024, 5 * 1024 * 1024])('forwards %i bytes of text without touching media resources', async bytes => {
  let received: Buffer | undefined;
  const upstream = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk);
    received = Buffer.concat(chunks); res.end('ok');
  });
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const address = upstream.address();
  if (!address || typeof address === 'string') throw new Error('test server address unavailable');
  const prepare = vi.fn(async () => null);
  const controller = createRequestSizeController(() => state.resolved, { prepare });
  const proxy = await createAnthropicCompatProxy({ upstream: `http://127.0.0.1:${address.port}`, transformRequest: [], requestSizeController: controller });
  try {
    const raw = Buffer.from(JSON.stringify({ input: [{ role: 'user', content: [{ type: 'input_text', text: 'x'.repeat(bytes) }] }] }));
    const response = await fetch(`${proxy.url}/v1/responses`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: raw });
    expect(response.status).toBe(200); await response.text();
    expect(received?.equals(raw)).toBe(true);
    expect(state.getSnapshot).not.toHaveBeenCalled();
    expect(state.query).not.toHaveBeenCalled();
    expect(mkdtemp).not.toHaveBeenCalled();
    expect(rm).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
    expect(state.info).not.toHaveBeenCalled();
  } finally {
    await proxy.dispose();
    upstream.closeAllConnections();
    await new Promise<void>(resolve => upstream.close(() => resolve()));
  }
});

it.each([false, true])('does not stage media when a small image only needs preprocessing: changed=%s', async changed => {
  const prepare = vi.fn(async () => changed ? { bytes: Buffer.alloc(300), mimeType: 'image/webp', width: 1, height: 1, changed: true, cacheKey: 'small' } : null);
  const controller = createRequestSizeController(() => state.resolved, { prepare });
  const raw = Buffer.from(JSON.stringify({ input: [{ role: 'user', content: [pngBlock()] }] }));
  const result = await controller.control(raw, 'responses', { signal: new AbortController().signal, route: {} });
  expect(prepare).toHaveBeenCalledOnce();
  expect(result?.removedImages ?? 0).toBe(0);
  expect(result !== null).toBe(changed);
  expect(mkdtemp).not.toHaveBeenCalled();
  expect(rm).not.toHaveBeenCalled();
  expect(state.ingest).not.toHaveBeenCalled();
  expect(state.info).not.toHaveBeenCalled();
});

it('creates one scratch directory only after preprocessing and persists removed images', async () => {
  const directoryCallsDuringPrepare: number[] = [];
  const prepare = vi.fn(async () => { directoryCallsDuringPrepare.push(vi.mocked(mkdtemp).mock.calls.length); return null; });
  const controller = createRequestSizeController(() => state.resolved, { prepare });
  const raw = Buffer.from(JSON.stringify({ input: [{ role: 'user', content: [pngBlock(), pngBlock(), pngBlock()] }] }));
  const result = await controller.control(raw, 'responses', { signal: new AbortController().signal, route: {}, triggerBytes: 8192, targetBytes: 4096 });
  expect(directoryCallsDuringPrepare).toEqual([0, 0, 0]);
  expect(result!.removedImages).toBeGreaterThan(0);
  const text = JSON.parse(result!.body.toString()).input[0].content[0].text as string;
  expect(preservedLocalPath(text)).toBe(path.join(state.root, 'saved.png'));
  expect(mkdtemp).toHaveBeenCalledOnce();
  expect(rm).toHaveBeenCalledExactlyOnceWith(vi.mocked(mkdtemp).mock.settledResults[0].value, { recursive: true, force: true });
  expect(state.ingest).toHaveBeenCalled();
  expect(state.addRef).toHaveBeenCalled();
});
