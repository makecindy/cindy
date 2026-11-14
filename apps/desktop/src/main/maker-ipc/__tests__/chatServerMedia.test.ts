import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
const f = vi.hoisted(() => ({ fetch: vi.fn(), read: vi.fn(), ingest: vi.fn() }));
vi.mock('electron', () => ({ net: { fetch: f.fetch } }));
vi.mock('../../cindy-media/blobStore.desktop.js', () => ({ readFile: f.read, supportedMime: () => true }));
vi.mock('../../device-link/remoteMediaPersistentCache.js', () => ({
  captureRemoteMediaCacheValidity: () => () => {},
  remoteMediaCacheGeneration: () => 0,
  chatMediaPersistentCache: () => ({ get: async () => null, put: f.ingest }),
}));
vi.mock('../../localDb/client/current.js', () => ({ getDbClient: () => ({ drizzle: {} }) }));
vi.mock('../../appSessionState.js', () => ({ ownerScopedUserDataPath: () => '/unused-test-owner' }));
vi.mock('../botGroupAttachments.js', () => ({ safeAttachmentFileName: (name: string) => name }));
import { createChatMedia } from '../chatServerMedia.js';
import type { ChatApi } from '../chatServerMigration.js';
import type { BotGroupAttachment } from '../../../shared/botGroupChat.js';
import { startCompanionCloud } from '../../companion-cloud/runtime.js';
import { createCompanionHomeRegistry } from '../../companion-cloud/homes.js';
import { fakeApi, memoryState, rejection } from '../../companion-cloud/__tests__/fakes.js';
const attachment: BotGroupAttachment = { id: 'file', name: 'picture.png', category: 'image', mimeType: 'image/png', size: 3, url: 'cindy-media://test', path: null };

type Prepare = { operationId: string; name: string; type: string; size: number };
// #10544, unit: exercise upload's actual prepare/PUT/seal path. Previous tests never
// rejected a deterministic prepare ID. Identical bytes under a new name reproduce it.
function uploadServer() {
  const operations = new Map<string, { body: Prepare; id: string }>();
  const receipts = new Map<string, Prepare>();
  const sealed = new Set<string>();
  const { api, calls } = fakeApi((route, _method, data, actor) => {
    if (route.endsWith('/media')) {
      const body = data as Prepare;
      const key = JSON.stringify([route, actor, body.operationId]);
      const previous = operations.get(key);
      if (previous && JSON.stringify(previous.body) !== JSON.stringify(body)) throw rejection(409, 'OPERATION_CONFLICT');
      const id = previous?.id ?? `file-${operations.size}`;
      operations.set(key, { body: { ...body }, id }); receipts.set(id, body);
      return { id, uploadUrl: `https://upload.example.test/${id}` };
    }
    if (route.endsWith('/complete')) { sealed.add(route.split('/').at(-2)!); return {}; }
    throw new Error(`unexpected ${route}`);
  });
  f.fetch.mockReset().mockResolvedValue(new Response('', { status: 200 }));
  const media = () => createChatMedia(api, () => true, 'https://chat.example.test');
  const file = { ...attachment, readBytes: async () => Buffer.from('png') };
  const prepares = () => calls.filter(call => call.route.endsWith('/media')).map(call => call.data as Prepare);
  return { api, calls, operations, receipts, sealed, media, file, prepares };
}

describe('media prepare conflict recovery', () => {
  it('recovers changed metadata once and reuses both old and recovered receipts after restart', async () => {
    const t = uploadServer();
    const original = await t.media().upload('room', 'source', [t.file], 'actor');
    const oldId = `media:${createHash('sha256').update('source').update(t.file.id).update('png').digest('hex')}`;
    expect(t.prepares()[0]?.operationId).toBe(oldId);
    const renamed = { ...t.file, name: 'renamed.png' };
    const recovered = await t.media().upload('room', 'source', [renamed], 'actor');
    expect(t.prepares()).toHaveLength(3);
    expect(recovered[0]?.mediaId).not.toBe(original[0]?.mediaId);
    expect(t.receipts.get(recovered[0]!.mediaId!)).toMatchObject({ name: 'renamed.png', type: 'image/png', size: 3 });
    // A lost caller ACK or process restart cannot create a third stored upload.
    expect(await t.media().upload('room', 'source', [renamed], 'actor')).toEqual(recovered);
    expect(await t.media().upload('room', 'source', [t.file], 'actor')).toEqual(original);
    expect(t.operations.size).toBe(2);
    expect(t.sealed.size).toBe(2);
    expect(t.prepares()[4]?.operationId).toBe(t.prepares()[2]?.operationId);
  });

  it.each(['prepare', 'seal'] as const)('reuses the recovered operation after a lost %s ACK', async stage => {
    const t = uploadServer();
    await t.media().upload('room', 'source', [t.file], 'actor');
    let loseAck = true;
    const api: ChatApi = async (...args) => {
      const result = await t.api(...args);
      if (loseAck && args[0].endsWith(stage === 'prepare' ? '/media' : '/complete')) {
        loseAck = false; throw new Error('ECONNRESET');
      }
      return result as never;
    };
    const renamed = { ...t.file, name: 'new.png' };
    await expect(createChatMedia(api, () => true, 'https://chat.example.test').upload('room', 'source', [renamed], 'actor')).rejects.toThrow('ECONNRESET');
    const blocks = await t.media().upload('room', 'source', [renamed], 'actor');
    expect(t.operations.size).toBe(2);
    expect(t.receipts.get(blocks[0]!.mediaId!)).toMatchObject({ name: 'new.png' });
    expect(t.sealed.has(blocks[0]!.mediaId!)).toBe(true);
  });

  it('bounds persistent conflicts to two stable attempts per call, including a new service instance', async () => {
    const t = uploadServer();
    vi.mocked(t.api).mockImplementation(async (...args) => {
      t.calls.push({ route: args[0], method: args[1] ?? 'GET', data: args[2], actorId: args[3] });
      throw rejection(409, 'OPERATION_CONFLICT');
    });
    for (let attempt = 0; attempt < 3; attempt++) {
      await expect(t.media().upload('room', 'source', [t.file], 'actor')).rejects.toMatchObject({ message: 'OPERATION_CONFLICT', status: 409 });
      expect(t.prepares()).toHaveLength((attempt + 1) * 2);
    }
    expect(new Set(t.prepares().map(body => body.operationId)).size).toBe(2);
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it('isolates recovery IDs by room, actor and all prepare metadata', async () => {
    const t = uploadServer();
    const recovery: Prepare[] = [];
    const ids = new Set<string>();
    const api: ChatApi = async (route, method, data, actor) => {
      if (route.endsWith('/media')) {
        const body = data as Prepare;
        const old = `media:${createHash('sha256').update('source').update(t.file.id).update('png').digest('hex')}`;
        if (body.operationId === old) throw rejection(409, 'OPERATION_CONFLICT');
        recovery.push(body); ids.add(body.operationId);
      }
      return t.api(route, method, data, actor);
    };
    const media = createChatMedia(api, () => true, 'https://chat.example.test');
    for (const [room, actor, name, mimeType] of [
      ['room', 'actor', 'a.png', 'image/png'], ['other', 'actor', 'a.png', 'image/png'],
      ['room', 'other', 'a.png', 'image/png'], ['room', 'actor', 'b.png', 'image/png'],
      ['room', 'actor', 'a.png', 'application/octet-stream'],
    ]) {
      const [block] = await media.upload(room!, 'source', [{ ...t.file, name: name!, mimeType: mimeType! }], actor!);
      expect(t.receipts.get(block!.mediaId!)).toMatchObject({ name, type: mimeType, size: 3 });
    }
    expect(ids.size).toBe(5);
    expect(recovery.every(body => body.operationId.length <= 128)).toBe(true);
  });

  it.each([
    rejection(429, 'RATE_LIMITED', { retryAt: 123 }), rejection(403, 'ACTOR_NOT_OWNED'),
    rejection(409, 'REVISION_CONFLICT'), rejection(500, 'OPERATION_CONFLICT'), new Error('OPERATION_CONFLICT'), new Error('ECONNRESET'),
  ])('does not replace an operation for an unrelated or uncertain failure: %s', async error => {
    const t = uploadServer();
    const api = vi.fn().mockRejectedValue(error) as unknown as ChatApi;
    await expect(createChatMedia(api, () => true, 'https://chat.example.test').upload('room', 'source', [t.file], 'actor')).rejects.toBe(error);
    expect(api).toHaveBeenCalledTimes(1);
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it.each(['owner', 'send', 'file'] as const)('rechecks the %s fence before conflict recovery', async fence => {
    const t = uploadServer(); let live = true;
    const api = vi.fn(async () => { live = false; throw rejection(409, 'OPERATION_CONFLICT'); }) as unknown as ChatApi;
    const assert = () => { if (!live) throw new Error('REVOKED'); };
    await expect(createChatMedia(api, () => fence !== 'owner' || live, 'https://chat.example.test')
      .upload('room', 'source', [{ ...t.file, ...(fence === 'file' ? { assertCurrent: assert } : {}) }], 'actor', fence === 'send' ? assert : undefined))
      .rejects.toThrow(fence === 'owner' ? 'OWNER_CHANGED' : 'REVOKED');
    expect(api).toHaveBeenCalledTimes(1); expect(f.fetch).not.toHaveBeenCalled();
  });

  it('still replaces an expired abandoned upload once, and checks the recovered signed URL', async () => {
    const t = uploadServer();
    const api = vi.fn().mockRejectedValueOnce(new Error('UPLOAD_EXPIRED'))
      .mockResolvedValue({ id: 'fresh', uploadUrl: 'http://private.invalid/file' }) as unknown as ChatApi;
    await expect(createChatMedia(api, () => true, 'https://chat.example.test').upload('room', 'source', [t.file], 'actor')).rejects.toThrow('INVALID_MEDIA_URL');
    expect(api).toHaveBeenCalledTimes(2); expect(f.fetch).not.toHaveBeenCalled();
    const bodies = vi.mocked(api).mock.calls.map(call => call[2] as Prepare);
    expect(bodies[1]!.operationId).not.toBe(bodies[0]!.operationId);
    expect(bodies[1]).toMatchObject({ name: t.file.name, type: t.file.mimeType, size: 3 });
  });

  it.each([false, true])('replaces an expired recovery receipt at most once (persistent expiration: %s)', async persistent => {
    const t = uploadServer();
    const api = vi.fn().mockRejectedValueOnce(rejection(409, 'OPERATION_CONFLICT'))
      .mockRejectedValueOnce(new Error('UPLOAD_EXPIRED'));
    if (persistent) api.mockRejectedValue(new Error('UPLOAD_EXPIRED'));
    else api.mockImplementation((...args: Parameters<ChatApi>) => t.api(...args));
    const result = createChatMedia(api as ChatApi, () => true, 'https://chat.example.test').upload('room', 'source', [t.file], 'actor');
    if (persistent) {
      await expect(result).rejects.toThrow('UPLOAD_EXPIRED');
      expect(api).toHaveBeenCalledTimes(3); expect(f.fetch).not.toHaveBeenCalled();
    } else {
      await expect(result).resolves.toMatchObject([{ type: 'media', caption: t.file.name }]);
      expect(api).toHaveBeenCalledTimes(4); expect(t.sealed.size).toBe(1);
    }
  });
});

// #10544, unit: run the real companion scheduler/uploader and room media uploader
// together. Mocked upload callbacks alone missed conflict omission, lost retention
// and timer/queue behavior. State I/O and file bytes stay in memory; no real sleeps.
describe('companion skill media conflict sync', () => {
  const key = 'companion.skill-files.v1:brew';
  function setupSync(t: ReturnType<typeof uploadServer>, saved?: string) {
    const { state, files } = memoryState(saved);
    const preferences = new Map<string, { key: string; value: unknown; revision: number }>();
    let changed: (() => void) | undefined;
    const api: ChatApi = async (route, method = 'GET', data, actor) => {
      if (route === '/preferences') {
        if (method === 'GET') return [...preferences.values()] as never;
        const body = data as { key: string; value: unknown; expectedRevision: number };
        const revision = body.expectedRevision + 1;
        preferences.set(body.key, { key: body.key, value: body.value, revision });
        return { revision } as never;
      }
      if (route === '/conversations') return { id: 'room' } as never;
      return t.api(route, method, data, actor);
    };
    const media = createChatMedia(api, () => true, 'https://chat.example.test');
    const runtime = startCompanionCloud({
      api, endpoint: 'https://chat.example.test', humanActorId: 'human', selfDeviceId: 'desk', current: () => true,
      bots: () => [{ botId: 'bot', actorId: 'actor', name: 'Brew' }],
      actors: () => [{ id: 'actor', externalId: 'bot', kind: 'bot', name: 'Brew', avatar: null, homeDeviceId: 'desk' }],
      initialKick: false,
      host: {
        homes: createCompanionHomeRegistry(), openState: () => state,
        readValues: async () => [{ key, value: null, localFiles: [
          { path: 'scripts/new.py', sha256: 'sha', size: 3, absolutePath: '/unused-test-skill/new.py' },
        ] }],
        canonicalSession: async () => null, rowsAfter: async () => [], latestRows: async () => [],
        deliverToCanonical: async () => ({ ok: true }),
        onLocalChange: listener => { changed = () => listener('bot'); return () => { changed = undefined; }; },
      },
      media: { ...media, upload: (room, source, attachments, actor) => media.upload(room, source,
        attachments.map(file => ({ ...file, readBytes: async () => Buffer.from('png') })), actor) },
    });
    return { runtime, state, files, preferences, change: () => changed?.() };
  }

  it('publishes the recovered file and retains its receipt through subsequent sync and restart', async () => {
    const t = uploadServer();
    await t.media().upload('room', 'skill-file:sha', [{ ...t.file, id: 'sha', name: 'old.py', mimeType: 'application/octet-stream' }], 'human');
    const s = setupSync(t);
    try {
      await s.runtime.syncNow();
      const value = s.preferences.get(key)?.value;
      expect(value).toMatchObject({ files: [{ path: 'scripts/new.py', sha256: 'sha', mediaId: 'file-1' }] });
      expect(value).not.toHaveProperty('omitted');
      expect(s.state.bot('bot')?.skillFileMedia).toEqual({ sha: 'file-1' });
      await s.runtime.syncNow();
      expect(t.prepares()).toHaveLength(3);
      s.runtime.dispose();
      const restarted = setupSync(t, s.files.get('state.json'));
      try { await restarted.runtime.syncNow(); expect(t.prepares()).toHaveLength(3); }
      finally { restarted.runtime.dispose(); }
    } finally { s.runtime.dispose(); }
  });

  it('keeps persistent conflicts out of omissions and retries only on the existing sync cadence', async () => {
    vi.useFakeTimers();
    const t = uploadServer();
    const conflict = rejection(409, 'OPERATION_CONFLICT');
    vi.mocked(t.api).mockImplementation(async (...args) => {
      t.calls.push({ route: args[0], method: args[1] ?? 'GET', data: args[2], actorId: args[3] });
      throw conflict;
    });
    const s = setupSync(t);
    const old = { slug: 'brew', files: [{ path: 'scripts/new.py', sha256: 'old-sha', size: 3, mediaId: 'old-file' }] };
    s.preferences.set(key, { key, value: old, revision: 1 });
    s.state.update('bot', 'actor', entry => { entry.skillFileMedia = { 'old-sha': 'old-file' }; });
    let restarted: ReturnType<typeof setupSync> | undefined;
    try {
      await s.runtime.syncNow();
      expect(s.preferences.get(key)?.value).toEqual(old);
      expect(s.state.bot('bot')?.skillFileMedia).toEqual({ 'old-sha': 'old-file' });
      expect(t.prepares()).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(59_999); expect(t.prepares()).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(1); expect(t.prepares()).toHaveLength(4);
      expect(await s.runtime.flushHere('bot')).toEqual({ ok: false, code: 'FAILED' });
      expect(t.prepares()).toHaveLength(6);
      s.runtime.dispose();
      restarted = setupSync(t, s.files.get('state.json'));
      await restarted.runtime.syncNow();
      expect(t.prepares()).toHaveLength(8);
      expect(new Set(t.prepares().map(body => body.operationId)).size).toBe(2);
      expect(restarted.state.bot('bot')?.skillFileMedia).toEqual({ 'old-sha': 'old-file' });
      expect(f.fetch).not.toHaveBeenCalled();
    } finally { s.runtime.dispose(); restarted?.runtime.dispose(); vi.useRealTimers(); }
  });

  it('coalesces a slow conflicting upload and a burst of local changes into one pending pass', async () => {
    vi.useFakeTimers();
    const t = uploadServer();
    let release!: () => void;
    const paused = new Promise<void>(resolve => { release = resolve; });
    let first = true;
    vi.mocked(t.api).mockImplementation(async (...args) => {
      t.calls.push({ route: args[0], method: args[1] ?? 'GET', data: args[2], actorId: args[3] });
      if (first) { first = false; await paused; }
      throw rejection(409, 'OPERATION_CONFLICT');
    });
    const s = setupSync(t);
    const run = s.runtime.syncNow();
    try {
      await vi.advanceTimersByTimeAsync(0);
      for (let i = 0; i < 100; i++) s.change();
      await vi.advanceTimersByTimeAsync(15_000);
      expect(t.prepares()).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(180_000);
      expect(t.prepares()).toHaveLength(1);
      release(); await run; await vi.advanceTimersByTimeAsync(0);
      expect(t.prepares()).toHaveLength(4);
      await vi.advanceTimersByTimeAsync(14_999); expect(t.prepares()).toHaveLength(4);
      expect(new Set(t.prepares().map(body => body.operationId)).size).toBe(2);
    } finally { release(); await run; s.runtime.dispose(); vi.useRealTimers(); }
  });
});

describe('chat private media', () => {
  it.each(['read', 'put', 'seal'])('awaits live authorization before %s', async deniedStage => {
    let stage = 'read';
    const readBytes = vi.fn(async () => Buffer.from('private report'));
    f.fetch.mockReset().mockImplementation(async () => { stage = 'seal'; return new Response('', { status: 200 }); });
    const api = vi.fn(async route => {
      if (route.endsWith('/media')) { stage = 'put'; return { id: 'media', uploadUrl: 'https://upload.example.test/signed' }; }
      return {};
    }) as unknown as ChatApi;
    const validate = async () => { await Promise.resolve(); if (stage === deniedStage) throw new Error('REVOKED'); };
    await expect(createChatMedia(api, () => true, 'https://chat.example.test').upload('room', 'operation', [{ ...attachment, readBytes }], 'actor', validate)).rejects.toThrow('REVOKED');
    if (deniedStage === 'read') expect(readBytes).not.toHaveBeenCalled();
    if (deniedStage !== 'seal') expect(f.fetch).not.toHaveBeenCalled();
    expect(vi.mocked(api).mock.calls.some(([route]) => route.endsWith('/complete'))).toBe(false);
  });

  it.each([undefined, '120'])('preserves PUT 429 Retry-After %s for settlement backoff', async retryAfter => {
    f.read.mockResolvedValue({ buffer: Buffer.from('png') });
    f.fetch.mockResolvedValue(new Response('', { status: 429, headers: retryAfter ? { 'Retry-After': retryAfter } : {} }));
    const api = vi.fn(async () => ({ id: 'media', uploadUrl: 'https://upload.example.test/signed' })) as unknown as ChatApi;
    const before = Date.now();
    const error = await createChatMedia(api, () => true, 'https://chat.example.test').upload('room', 'reply', [attachment], 'actor').catch(error => error);
    expect(error).toMatchObject({ message: 'MEDIA_UPLOAD_FAILED', status: 429 });
    if (retryAfter) expect(error.retryAt).toBeGreaterThanOrEqual(before + 120_000);
    else expect(error.retryAt).toBeUndefined();
    expect(vi.mocked(api).mock.calls.some(([route]) => route.endsWith('/complete'))).toBe(false);
  });

  it('does not PUT an ordinary reply after execution changes during prepare', async () => {
    let current = true; f.read.mockResolvedValueOnce({ buffer: Buffer.from('png') }); f.fetch.mockClear();
    const api = vi.fn(async () => { current = false; return { id: 'media', uploadUrl: 'https://upload.example.test/signed' }; }) as unknown as ChatApi;
    await expect(createChatMedia(api, () => true, 'https://chat.example.test').upload('room', 'reply', [attachment], 'actor', () => { if (!current) throw new Error('STALE_EXECUTOR'); })).rejects.toThrow('STALE_EXECUTOR');
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it('uploads the bytes without a Cindy token and seals before returning the message reference', async () => {
    f.read.mockResolvedValue({ buffer: Buffer.from('png'), mimeType: 'image/png' });
    f.fetch.mockResolvedValue(new Response('', { status: 200 }));
    const api = vi.fn(async route => route.endsWith('/media') ? { id: 'media', uploadUrl: 'https://upload.example.test/signed' } : {}) as unknown as ChatApi;
    const media = createChatMedia(api, () => true, 'https://chat.example.test');
    expect(await media.upload('room', 'operation', [attachment], 'actor')).toEqual([{ type: 'media', mediaId: 'media', caption: 'picture.png' }]);
    expect(f.fetch).toHaveBeenLastCalledWith('https://upload.example.test/signed', expect.objectContaining({ redirect: 'error', headers: { 'Content-Type': 'image/png' } }));
    expect(vi.mocked(api).mock.calls.at(-1)?.[0]).toBe('/conversations/room/media/media/complete');
  });
  it('uploads authorized reply bytes and refuses an expired execution before PUT', async () => {
    f.fetch.mockReset().mockResolvedValue(new Response('', { status: 200 }));
    const readBytes = vi.fn(async () => Buffer.from('%PDF-1.4'));
    let valid = true;
    const file = { ...attachment, name: 'report.pdf', mimeType: 'application/pdf', url: null, path: null, readBytes,
      assertCurrent: () => { if (!valid) throw new Error('STALE_EXECUTOR'); } };
    const api = vi.fn(async (route: string) => route.endsWith('/media') ? { id: 'pdf', uploadUrl: 'https://upload.example.test/signed' } : {}) as unknown as ChatApi;
    const media = createChatMedia(api, () => true, 'https://chat.example.test');
    expect(await media.upload('room', 'operation', [file], 'actor')).toEqual([{ type: 'media', mediaId: 'pdf', caption: 'report.pdf' }]);
    expect(f.fetch).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ body: new Uint8Array(Buffer.from('%PDF-1.4')) }));
    f.fetch.mockClear();
    vi.mocked(api).mockImplementationOnce(async () => { valid = false; return { id: 'pdf', uploadUrl: 'https://upload.example.test/signed' }; });
    await expect(media.upload('room', 'retry', [file], 'actor')).rejects.toThrow('STALE_EXECUTOR');
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it.each(['prepare', 'upload', 'complete'])('reports the failing %s stage without signed URLs or filenames', async (stage) => {
    f.read.mockResolvedValue({ buffer: Buffer.from('png') });
    const log = { warn: vi.fn() };
    f.fetch.mockResolvedValue(new Response('', { status: stage === 'upload' ? 403 : 200 }));
    const api = vi.fn(async (route: string) => {
      if (stage === 'prepare' && route.endsWith('/media') || stage === 'complete' && route.endsWith('/complete'))
        throw Object.assign(new Error('REQUEST_FAILED'), { status: 500 });
      return { id: 'media', uploadUrl: 'https://upload.example.test/private?token=secret' };
    }) as unknown as ChatApi;
    await expect(createChatMedia(api, () => true, 'https://chat.example.test', log).upload('room', 'operation', [attachment], 'actor')).rejects.toThrow();
    expect(log.warn).toHaveBeenCalledWith('Chat media upload failed', expect.objectContaining({ stage, status: stage === 'upload' ? 403 : 500 }));
    expect(JSON.stringify(log.warn.mock.calls)).not.toMatch(/secret|picture.png|https:/);
  });

  it('does not upload bytes when the owner changes during local file reading', async () => {
    let current = true;
    f.fetch.mockClear();
    f.read.mockImplementation(async () => { current = false; return { buffer: Buffer.from('png') }; });
    const api = vi.fn() as unknown as ChatApi;
    await expect(createChatMedia(api, () => current, 'https://chat.example.test').upload('room', 'op', [attachment], 'actor')).rejects.toThrow('OWNER_CHANGED');
    expect(api).not.toHaveBeenCalled();
    expect(f.fetch).not.toHaveBeenCalled();
  });
  it('rechecks membership before reusing cached media bytes', async () => {
    f.fetch.mockResolvedValue(new Response('png'));
    f.ingest.mockResolvedValue({ url: 'cindy-media://cached' });
    let allowed = true;
    const api = vi.fn(async () => {
      if (!allowed) throw new Error('CONVERSATION_NOT_FOUND');
      return { name: 'p.png', type: 'image/png', size: 3, url: 'https://download.example.test/signed' };
    }) as unknown as ChatApi;
    const media = createChatMedia(api, () => true, 'https://chat.example.test');
    expect((await media.download('room', 'media')).url).toBe('cindy-media://cached');
    allowed = false;
    await expect(media.download('room', 'media')).rejects.toThrow('CONVERSATION_NOT_FOUND');
    expect(api).toHaveBeenCalledTimes(2);
  });
  it('keeps the status of a failed download, so a file that is gone is told from a failing server', async () => {
    const api = vi.fn(async () => ({ name: 'p.png', type: 'image/png', size: 3, url: 'https://download.example.test/signed' })) as unknown as ChatApi;
    f.fetch.mockResolvedValueOnce(new Response('', { status: 404 }));
    await expect(createChatMedia(api, () => true, 'https://chat.example.test').download('room', 'gone')).rejects.toMatchObject({ message: 'MEDIA_DOWNLOAD_FAILED', status: 404 });
    f.fetch.mockResolvedValueOnce(new Response('', { status: 503 }));
    await expect(createChatMedia(api, () => true, 'https://chat.example.test').download('room', 'later')).rejects.toMatchObject({ message: 'MEDIA_DOWNLOAD_FAILED', status: 503 });
  });

  it('uploads a send\'s files three at a time and keeps their order', async () => {
    f.read.mockResolvedValue({ buffer: Buffer.from('png') });
    f.fetch.mockResolvedValue(new Response('', { status: 200 }));
    const files = ['a', 'b', 'c', 'd'].map(id => ({ ...attachment, id, name: `${id}.png` }));
    let inFlight = 0, most = 0;
    const api = vi.fn(async (route: string, _method: string, body: { name?: string }) => {
      if (!route.endsWith('/media')) return {};
      inFlight += 1; most = Math.max(most, inFlight);
      // The first file is prepared last.
      await new Promise(resolve => setTimeout(resolve, body.name === 'a.png' ? 20 : 1));
      inFlight -= 1;
      return { id: `media-${body.name}`, uploadUrl: 'https://upload.example.test/signed' };
    }) as unknown as ChatApi;
    const blocks = await createChatMedia(api, () => true, 'https://chat.example.test').upload('room', 'operation', files, 'actor');
    expect(blocks.map(block => block.caption)).toEqual(['a.png', 'b.png', 'c.png', 'd.png']);
    expect(most).toBe(3);
  });
  it('permits exact loopback media only for the explicitly isolated adapter', async () => {
    f.read.mockResolvedValue({ buffer: Buffer.from('png') });f.fetch.mockResolvedValue(new Response('', { status: 200 }));
    let uploadUrl = 'http://127.0.0.1:3018/dev-media/fixture';
    const api = vi.fn(async () => ({ id: 'media', uploadUrl })) as unknown as ChatApi;
    await expect(createChatMedia(api, () => true, 'https://chat.example.test').upload('room','op',[attachment],'actor')).rejects.toThrow('INVALID_MEDIA_URL');
    await expect(createChatMedia(api, () => true, 'https://chat.example.test', undefined, { allowLoopback: true }).upload('room','op',[attachment],'actor')).resolves.toHaveLength(1);
    uploadUrl = 'http://127.0.0.1:3019/private';
    await expect(createChatMedia(api, () => true, 'https://chat.example.test', undefined, { allowLoopback: true }).upload('room','op',[attachment],'actor')).rejects.toThrow('INVALID_MEDIA_URL');
  });

});
