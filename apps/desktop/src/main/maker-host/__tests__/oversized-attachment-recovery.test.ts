import sharp from 'sharp';
import { createInlineImagePreprocessor } from '../inlineImagePreprocessor.js';
import { mkdtemp, writeFile, readFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { createAnthropicCompatProxy } from '@cindy/anthropic-compat-proxy';
import path from 'node:path';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  root: '', snapshot: null as any, session: { status: 'active', remoteHostId: null } as any,
  existing: undefined as any, resolved: 'test-session' as string | null, invalidOwner: false,
  getSnapshot: vi.fn(), info: vi.fn(), ingest: vi.fn(), query: vi.fn(), addRef: vi.fn(), removeRef: vi.fn(),
}));
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, mkdtemp: vi.fn(actual.mkdtemp), writeFile: vi.fn(actual.writeFile), rm: vi.fn(actual.rm) };
});
vi.mock('../../logger.js', () => ({ createLogger: () => ({ info: state.info }) }));
vi.mock('electron', () => ({ app: { getPath: () => state.root } }));
vi.mock('../../localDb/client/current.js', () => ({ getCurrentDbClientSnapshot: () => state.getSnapshot() }));
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
import { createAttachmentRecoveryService } from '../oversizedAttachmentRecoveryCore.js';
import * as blobs from '../../cindy-media/blobStore.desktop.js';
import * as ingest from '../../cindy-media/ingest.js';
import * as journal from '../../cindy-media/refCompensationJournal.desktop.js';

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

// PR #10663: the new controller sent PDFs to media ingestion, unlike legacy recovery.
// Unit tier: a PDF + PNG exceeding a 4 KiB ingress window exercises the actual proxy,
// controller and file persistence; existing PDF coverage used only legacy recovery.
// Image preparation/tightening must never receive the PDF, even under a single-image cap.
it('recovers a spooled PDF to hook-attachments while preserving images in the media store', async () => {
  const input = await multiBody([pdfBlock(1), pngBlock()]);
  const raw = await readFile(input.filePath);
  const pdf = Buffer.from(pdfBlock(1).file_data.split(',')[1], 'base64');
  const png = Buffer.from(pngBlock().image_url.split(',')[1], 'base64');
  const pdfPath = path.join(state.root, 'hook-attachments', 'test-session', `${createHash('sha256').update(pdf).digest('hex')}-recovered.pdf`);
  const received: Buffer[] = [];
  const upstream = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk);
    received.push(Buffer.concat(chunks)); res.end('ok');
  });
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const address = upstream.address();
  if (!address || typeof address === 'string') throw new Error('test server address unavailable');
  state.ingest.mockImplementation(async (params: Parameters<typeof ingest.ingestMedia>[0]) => {
    if (params.mimeType !== 'image/png') throw new Error('unsupported media MIME');
    params.assertStillValid?.();
    await writeFile(path.join(state.root, 'saved.png'), await readFile(params.filePath!));
    return { url: 'cindy-media://blobs/test.png' };
  });
  const prepare = vi.fn<import('@cindy/anthropic-compat-proxy').InlineImagePreprocessor['prepare']>(async () => null);
  const tighten = vi.fn<NonNullable<import('@cindy/anthropic-compat-proxy').InlineImagePreprocessor['tighten']>>(async () => null);
  const controller = createRequestSizeController(() => state.resolved, { prepare, tighten });
  const proxy = await createAnthropicCompatProxy({ upstream: `http://127.0.0.1:${address.port}`, transformRequest: [], maxRequestBodyBytes: 4096,
    requestSizeController: { ...controller, control: (body, format, policy) => controller.control(body, format, { ...policy, triggerBytes: 3500, targetBytes: 1600, singleImageMaxBytes: 2000 }) },
  });
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await fetch(`${proxy.url}/v1/responses`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: raw });
      expect(response.status).toBe(200); await response.text();
    }
    expect(received).toHaveLength(2); expect(received[0]).toEqual(received[1]);
    expect(received[0].length).toBeLessThanOrEqual(3500);
    const content = JSON.parse(received[0].toString()).input[0].content as Array<{ text: string }>;
    expect(preservedLocalPath(content[0].text)).toBe(pdfPath);
    expect(preservedLocalPath(content[1].text)).toBe(path.join(state.root, 'saved.png'));
    expect(await readFile(pdfPath)).toEqual(pdf);
    expect(await readFile(path.join(state.root, 'saved.png'))).toEqual(png);
    expect(state.ingest.mock.calls.every(([params]) => params.mimeType === 'image/png')).toBe(true);
    expect(state.addRef).toHaveBeenCalled();
    expect(prepare.mock.calls.map(([input]) => input.mimeType)).toEqual(['image/png', 'image/png']);
    expect(tighten.mock.calls.map(([input]) => input.mimeType)).toEqual(['image/png', 'image/png']);
    for (const [input] of [...prepare.mock.calls, ...tighten.mock.calls]) expect(input.bytes).toEqual(png);
  } finally {
    await proxy.dispose(); upstream.closeAllConnections();
    await new Promise<void>(resolve => upstream.close(() => resolve()));
  }
});

// PR2 unit regression: PDFs reached prepare before PR1's image-only fix.
// PR1's spy callbacks return null, so they cannot detect saving the original PNG
// after real compression. A PDF plus a 64x48 PNG exercises the actual adapter/
// controller; only storage/account ports are fakes.
// Half noise keeps the compressed PNG above the small injected removal budget.
it('prepares only the PNG and preserves its compressed bytes separately from the PDF', async () => {
  const pixels = Buffer.alloc(64 * 48 * 3);
  let seed = 1;
  for (let i = 0; i < pixels.length / 2; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    pixels[i] = seed >>> 24;
  }
  const png = await sharp(pixels, { raw: { width: 64, height: 48, channels: 3 } })
    .png({ compressionLevel: 0 }).toBuffer();
  const file = pdfBlock(1);
  const pdf = Buffer.from(file.file_data.split(',')[1], 'base64');
  const raw = Buffer.from(JSON.stringify({ input: [{ role: 'user', content: [
    file, { type: 'input_image', image_url: `data:image/png;base64,${png.toString('base64')}` },
  ] }] }));
  const preprocessor = createInlineImagePreprocessor(() => true);
  const prepare = vi.spyOn(preprocessor, 'prepare');
  const controller = createRequestSizeController(() => state.resolved, preprocessor);
  const result = await controller.control(raw, 'responses', {
    signal: new AbortController().signal, route: { providerId: 'xai', modelId: 'grok-4' },
    triggerBytes: 3500, targetBytes: 1600,
  });

  expect(prepare).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ bytes: png, mimeType: 'image/png' }));
  const prepared = await prepare.mock.results[0].value;
  expect(prepared).toMatchObject({ changed: true, mimeType: 'image/png', width: 64, height: 48 });
  expect(prepared!.bytes.length).toBeLessThanOrEqual(png.length * 0.85);
  expect(result).toMatchObject({ imageCount: 1, removedImages: 1 });
  const content = JSON.parse(result!.body.toString()).input[0].content as Array<{ text: string }>;
  const pdfPath = preservedLocalPath(content[0].text);
  const pngPath = preservedLocalPath(content[1].text);
  expect(path.dirname(pdfPath)).toBe(path.join(state.root, 'hook-attachments', 'test-session'));
  expect(path.extname(pdfPath)).toBe('.pdf');
  expect(await readFile(pdfPath)).toEqual(pdf);
  expect(pngPath).toBe(path.join(state.root, 'saved.png'));
  const stored = await readFile(pngPath);
  expect(stored).toEqual(prepared!.bytes);
  expect(await sharp(stored).raw().toBuffer()).toEqual(pixels);
  expect(state.ingest).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ mimeType: 'image/png', isCache: false }), expect.anything(),
  );
  expect(state.addRef).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ refKind: 'session-attachment', refId: 'test-session' }), expect.anything(),
  );
});

// PR #10699, unit: a real adapter's WebP must become PNG in the rejected request,
// not only in future requests. Existing denial tests used a fake prepare callback.
it('retries its own rejected WebP as PNG and remembers the denial for later PNG inputs', async () => {
  const png = await sharp({ create: { width: 64, height: 48, channels: 4, background: { r: 40, g: 80, b: 120, alpha: 0.5 } } })
    .png({ compressionLevel: 0 }).toBuffer();
  const preprocessor = createInlineImagePreprocessor(() => true);
  const prepare = vi.spyOn(preprocessor, 'prepare');
  const controller = createRequestSizeController(() => state.resolved, preprocessor, () => 'openai');
  const control = vi.spyOn(controller, 'control');
  const ctx = { reqId: 10699, method: 'POST', url: '/v1/responses', headers: {} };
  const model = 'gpt-webp-rejection-regression';
  const signal = new AbortController().signal;
  const webp = await preprocessor.prepare({ bytes: png, mimeType: 'image/png', route: controller.route!(ctx, { model }), signal });
  expect(webp?.mimeType).toBe('image/webp');
  const bodyFor = (bytes: Buffer, mime: string) => ({ model, input: [{ role: 'user', content: [
    { type: 'input_image', image_url: `data:${mime};base64,${bytes.toString('base64')}` },
  ] }] });
  const sent = Buffer.from(JSON.stringify(bodyFor(webp!.bytes, 'image/webp')));
  const retried = await controller.retry!(sent, { kind: 'unsupported-image-format' }, ctx, signal);
  expect(control.mock.calls[0][2]).toMatchObject({ allowRemoval: false, route: { deniedMimeTypes: ['image/webp'] } });
  const candidate = await prepare.mock.results.at(-1)!.value;
  expect(candidate?.mimeType).toBe('image/png');
  expect(candidate!.bytes.length).toBeGreaterThan(webp!.bytes.length);
  expect(retried).not.toBeNull();
  expect(retried!.equals(sent)).toBe(false);
  const retriedUrl = JSON.parse(retried!.toString()).input[0].content[0].image_url as string;
  expect(retriedUrl).toMatch(/^data:image\/png;base64,/);
  expect(await sharp(Buffer.from(retriedUrl.split(',')[1], 'base64')).raw().toBuffer()).toEqual(await sharp(png).raw().toBuffer());

  const original = bodyFor(png, 'image/png');
  const route = controller.route!(ctx, original);
  expect(route.deniedMimeTypes).toContain('image/webp');
  const subsequent = await controller.control(Buffer.from(JSON.stringify(original)), 'responses', { context: ctx, route, signal });
  expect(JSON.parse(subsequent!.body.toString()).input[0].content[0].image_url).toMatch(/^data:image\/png;base64,/);
  expect(state.ingest).not.toHaveBeenCalled();
  expect(state.addRef).not.toHaveBeenCalled();
});

// PR #10699, unit: real loopback proxy -> classifier -> controller retry ->
// real encoder. Direct retry tests cannot detect a dropped or repeated resend.
it('retries a WebP format 400 once as PNG and sends PNG directly on the next request', async () => {
  const png = await sharp({ create: { width: 64, height: 48, channels: 4, background: { r: 40, g: 80, b: 120, alpha: 0.5 } } })
    .png({ compressionLevel: 0 }).toBuffer();
  const received: string[] = [];
  const upstream = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const image = JSON.parse(Buffer.concat(chunks).toString()).input[0].content[0].image_url as string;
    received.push(image);
    res.setHeader('content-type', 'application/json');
    res.statusCode = image.startsWith('data:image/png;') ? 200 : 400;
    res.end(res.statusCode === 200 ? '{}' : JSON.stringify({ error: { message: 'unsupported image format' } }));
  });
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const address = upstream.address();
  if (!address || typeof address === 'string') throw new Error('test server address unavailable');
  const controller = createRequestSizeController(() => state.resolved, createInlineImagePreprocessor(() => true), () => 'openai');
  const proxy = await createAnthropicCompatProxy({ upstream: `http://127.0.0.1:${address.port}`, transformRequest: [], requestSizeController: controller });
  const body = JSON.stringify({ model: 'gpt-webp-http-retry-regression', input: [{ role: 'user', content: [
    { type: 'input_image', image_url: `data:image/png;base64,${png.toString('base64')}` },
  ] }] });
  const send = () => fetch(`${proxy.url}/v1/responses`, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
  try {
    const first = await send();
    await first.text();
    expect({ status: first.status, calls: received.length }).toEqual({ status: 200, calls: 2 });
    expect(received[0]).toMatch(/^data:image\/webp;base64,/);
    expect(received[1]).toMatch(/^data:image\/png;base64,/);
    expect(await sharp(Buffer.from(received[1].split(',')[1], 'base64')).raw().toBuffer()).toEqual(await sharp(png).raw().toBuffer());
    const second = await send();
    await second.text();
    expect(second.status).toBe(200);
    expect(received).toHaveLength(3);
    expect(received[2]).toMatch(/^data:image\/png;base64,/);
  } finally {
    await proxy.dispose();
    upstream.closeAllConnections();
    await new Promise<void>(resolve => upstream.close(() => resolve()));
  }
});

// PR #10663: batch persistence could leave the first new reference on later failure.
// Unit tier: two different images, with failure/cancellation/owner change during commit.
// Existing compensation tests covered only the legacy recovery factory.
it.each(['second-ingest', 'lost-ack', 'abort', 'owner'] as const)('compensates controller references on %s during batch commit', async failure => {
  const mediaPath = (url: string) => path.join(state.root, path.basename(new URL(url).pathname));
  const service = createAttachmentRecoveryService({ getUserDataDir: () => state.root, media: {
    ...blobs, ...ingest, ...journal,
    blobUrl: (hash, ext) => `cindy-media://blobs/${hash}${ext}`,
    resolveSafe: url => ({ ...blobs.resolveSafe(url), absPath: mediaPath(url) }),
  } });
  const abort = new AbortController();
  let saves = 0;
  state.ingest.mockImplementation(async (params: Parameters<typeof ingest.ingestMedia>[0]) => {
    params.assertStillValid?.();
    if (++saves === 2 && failure === 'second-ingest') throw new Error('disk full');
    const bytes = await readFile(params.filePath!);
    const url = `cindy-media://blobs/${createHash('sha256').update(bytes).digest('hex')}.png`;
    await writeFile(mediaPath(url), bytes);
    if (saves === 1 && failure === 'abort') abort.abort();
    if (saves === 1 && failure === 'owner') state.snapshot = { ...state.snapshot };
    return { url };
  });
  if (failure === 'lost-ack') state.addRef.mockRejectedValue(new Error('lost acknowledgement'));
  const second = { ...pngBlock(), image_url: pngBlock().image_url.replace(/AAAA/, 'AQEB') };
  const raw = await readFile((await multiBody([pngBlock(), second])).filePath);
  const result = await service.createRequestSizeController(() => state.resolved).control(raw, 'responses', {
    signal: abort.signal, route: {}, triggerBytes: 3500, targetBytes: 1600,
  });
  expect(result).toBeNull();
  expect(state.removeRef).toHaveBeenCalledTimes(2);
  if (failure === 'second-ingest' || failure === 'lost-ack') {
    expect(state.addRef).toHaveBeenCalledOnce();
    expect(state.removeRef.mock.calls.map(([id]) => id)).toContain(state.addRef.mock.calls[0][0].id);
  } else {
    expect(saves).toBe(1);
    expect(state.addRef).not.toHaveBeenCalled();
  }
});

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
  const preprocessor = createInlineImagePreprocessor(() => true);
  const prepare = vi.spyOn(preprocessor, 'prepare');
  const controller = createRequestSizeController(() => state.resolved, preprocessor);
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

// PR2 integration: use the actual adapter, including JPEG passthrough, to
// protect PR1's lazy persistence contract after the compressor is wired in.
it.each([false, true])('does not stage media with the real adapter: changed=%s', async changed => {
  const preprocessor = createInlineImagePreprocessor(() => true);
  const prepare = vi.spyOn(preprocessor, 'prepare');
  const controller = createRequestSizeController(() => state.resolved, preprocessor);
  const image = sharp({ create: { width: 64, height: 48, channels: 3, background: '#123456' } });
  const bytes = await (changed ? image.png({ compressionLevel: 0 }) : image.jpeg({ quality: 95 })).toBuffer();
  const mime = changed ? 'image/png' : 'image/jpeg';
  const raw = Buffer.from(JSON.stringify({ input: [{ role: 'user', content: [{ type: 'input_image', image_url: `data:${mime};base64,${bytes.toString('base64')}` }] }] }));
  vi.mocked(writeFile).mockClear();
  const result = await controller.control(raw, 'responses', { signal: new AbortController().signal, route: { providerId: 'openai', modelId: 'gpt-6-astra' } });
  expect(prepare).toHaveBeenCalledOnce();
  expect(result?.removedImages ?? 0).toBe(0);
  expect(result !== null).toBe(changed);
  if (changed) {
    const uri = JSON.parse(result!.body.toString()).input[0].content[0].image_url as string;
    expect(uri).toMatch(/^data:image\/webp;base64,/);
    const encoded = Buffer.from(uri.split(',')[1], 'base64');
    expect(await sharp(encoded).raw().toBuffer()).toEqual(await sharp(bytes).raw().toBuffer());
  } else {
    expect(result).toBeNull(); // The caller keeps the original JPEG request.
  }
  expect(mkdtemp).not.toHaveBeenCalled();
  expect(rm).not.toHaveBeenCalled();
  expect(writeFile).not.toHaveBeenCalled();
  expect(state.ingest).not.toHaveBeenCalled();
  expect(state.addRef).not.toHaveBeenCalled();
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

// Real HTTP + shared host controller. Scale only the injected route budget so
// equality/+1 tests stay small; Codex assembly separately covers production MiB.
it.each(['responses', 'anthropic', 'chat'] as const)('enforces the text-only trigger without media side effects for %s', async format => {
  const received: Buffer[] = [];
  const upstream = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk);
    received.push(Buffer.concat(chunks)); res.end('ok');
  });
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const address = upstream.address();
  if (!address || typeof address === 'string') throw new Error('test server address unavailable');
  const prepare = vi.fn(async () => null);
  const controller = createRequestSizeController(() => state.resolved, { prepare });
  const route = format === 'responses' ? '/v1/responses' : format === 'anthropic' ? '/v1/messages' : '/v1/chat/completions';
  const threshold = 8192;
  const retry = vi.fn(async () => null);
  const proxy = await createAnthropicCompatProxy({ upstream: `http://127.0.0.1:${address.port}`, transformRequest: [], maxRequestBodyBytes: 42 * 1024,
    requestSizeRetry: retry,
    requestSizeController: { ...controller, control: (body, wire, policy) => controller.control(body, wire, { ...policy, triggerBytes: threshold }) },
  });
  const wire = (bytes: number) => {
    const body = { [format === 'responses' ? 'input' : 'messages']: [{ role: 'user', content: [{ type: format === 'responses' ? 'input_text' : 'text', text: '' }] }] };
    const raw = JSON.stringify(body);
    return Buffer.from(raw.replace('"text":""', `"text":"${'x'.repeat(bytes - Buffer.byteLength(raw))}"`));
  };
  const send = (body: Buffer<ArrayBuffer>) => fetch(`${proxy.url}${route}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
  const assertNoMediaWork = () => {
    expect(state.getSnapshot).not.toHaveBeenCalled(); expect(state.query).not.toHaveBeenCalled();
    expect(mkdtemp).not.toHaveBeenCalled(); expect(rm).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled(); expect(state.info).not.toHaveBeenCalled();
    expect(retry).not.toHaveBeenCalled();
  };
  try {
    const equal = wire(threshold);
    const ok = await send(equal); expect(ok.status).toBe(200); await ok.text();
    expect(received).toHaveLength(1); expect(received[0].equals(equal)).toBe(true); assertNoMediaWork();
    const large = wire(threshold + 1);
    const rejected = await send(large); expect(rejected.status).toBe(413);
    expect(await rejected.json()).toEqual({ error: { type: 'request_too_large', message: 'Request text exceeds the local 32 MiB request budget after image recovery.' } });
    expect(received).toHaveLength(1); assertNoMediaWork();
    vi.stubEnv('XDT_REQUEST_SIZE_CONTROL_DISABLE', '1');
    const disabled = await send(large); expect(disabled.status).toBe(200); await disabled.text();
    expect(received).toHaveLength(2); expect(received[1].equals(large)).toBe(true); assertNoMediaWork();
  } finally {
    vi.unstubAllEnvs(); await proxy.dispose(); upstream.closeAllConnections();
    await new Promise<void>(resolve => upstream.close(() => resolve()));
  }
});

it('uses a learned byte trigger for later text-only requests without DB or disk access', async () => {
  const received: Buffer[] = [];
  const upstream = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk);
    received.push(Buffer.concat(chunks)); res.statusCode = received.length === 1 ? 413 : 200;
    res.end(received.length === 1 ? 'Request too large' : 'ok');
  });
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const address = upstream.address();
  if (!address || typeof address === 'string') throw new Error('test server address unavailable');
  const controller = createRequestSizeController(() => state.resolved);
  const proxy = await createAnthropicCompatProxy({ upstream: `http://127.0.0.1:${address.port}`, transformRequest: [], requestSizeController: controller });
  const send = (body: Buffer<ArrayBuffer>) => fetch(`${proxy.url}/v1/responses`, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
  try {
    const images = Buffer.from(JSON.stringify({ input: [{ role: 'user', content: [pngBlock()] }] }));
    const recovered = await send(images); expect(recovered.status).toBe(200); await recovered.text();
    expect(received).toHaveLength(2);
    const trigger = Math.floor(received[0].length * 0.44);
    state.getSnapshot.mockClear(); state.query.mockClear(); state.info.mockClear();
    vi.mocked(mkdtemp).mockClear(); vi.mocked(rm).mockClear();
    for (const delta of [0, 1]) {
      const raw = Buffer.from(JSON.stringify({ input: 'x'.repeat(trigger + delta - Buffer.byteLength('{"input":""}')) }));
      const response = await send(raw); expect(response.status).toBe(delta ? 413 : 200); await response.text();
      expect(received).toHaveLength(3);
      if (!delta) expect(received[2].equals(raw)).toBe(true);
    }
    expect(state.getSnapshot).not.toHaveBeenCalled(); expect(state.query).not.toHaveBeenCalled();
    expect(mkdtemp).not.toHaveBeenCalled(); expect(rm).not.toHaveBeenCalled(); expect(state.info).not.toHaveBeenCalled();
  } finally {
    await proxy.dispose(); upstream.closeAllConnections(); await new Promise<void>(resolve => upstream.close(() => resolve()));
  }
});
// Unit, PR 2: existing ownership tests replace prepare with a fake encoder.
// Real Desktop controller + real adapter + sharp must compress a valid PNG at
// default request thresholds without allocating staging files or media refs.
it.each(['no-db', 'no-session', 'session-missing', 'remote-session'] as const)(
  'uses the real image adapter without disk writes for %s', async reason => {
    if (reason === 'no-db') state.snapshot = null;
    if (reason === 'no-session') state.resolved = null;
    if (reason === 'session-missing') state.session = null;
    if (reason === 'remote-session') state.session.remoteHostId = 'remote';
    const png = await sharp({ create: { width: 64, height: 48, channels: 3, background: '#235681' } })
      .png({ compressionLevel: 0 }).toBuffer();
    const controller = createRequestSizeController(() => state.resolved, createInlineImagePreprocessor(() => true), () => 'openai');
    const context = { reqId: 81, method: 'POST', url: '/v1/responses', headers: {} };
    const body = { model: 'gpt-6-astra', input: [{ role: 'user', content: [{ type: 'input_image', image_url: `data:image/png;base64,${png.toString('base64')}` }] }] };
    const raw = Buffer.from(JSON.stringify(body));
    vi.mocked(mkdtemp).mockClear();
    vi.mocked(writeFile).mockClear();
    const result = await controller.control(raw, 'responses', { context, route: controller.route!(context, body), signal: new AbortController().signal });
    expect(result?.removedImages).toBe(0);
    const image = JSON.parse(result!.body.toString()).input[0].content[0].image_url as string;
    expect(image.startsWith('data:image/webp;base64,')).toBe(true);
    const compressed = Buffer.from(image.slice(image.indexOf(',') + 1), 'base64');
    expect(compressed.length).toBeLessThanOrEqual(png.length * 0.85);
    expect(await sharp(compressed).metadata()).toMatchObject({ format: 'webp', width: 64, height: 48 });
    expect(await sharp(compressed).raw().toBuffer()).toEqual(await sharp(png).raw().toBuffer());
    expect(mkdtemp).not.toHaveBeenCalled();
    expect(writeFile).not.toHaveBeenCalled();
    expect(state.ingest).not.toHaveBeenCalled();
    expect(state.addRef).not.toHaveBeenCalled();
    expect(await readdir(state.root)).toEqual([]);
    expect(state.info).toHaveBeenCalledWith('request size control skipped', expect.objectContaining({ reason, imageCount: 1 }));
  },
);
