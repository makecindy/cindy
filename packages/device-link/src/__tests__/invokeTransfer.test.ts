import { createHash } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
import {
  INVOKE_TRANSFER_MAX_CHARS,
  INVOKE_TRANSFER_MIN_CHARS,
  InboundInvokeTransferOptions,
  InvokeResultCache,
  encodeInvokeResultTransfer,
  parseInvokeTransferOptions,
  type DeviceLinkTransferCodec,
} from '../invokeTransfer.js';
import { InvokeDeltaBases, applyInvokeResultPatch, sampleInvokeResultText } from '../invokeDelta.js';

const codec: Required<Omit<DeviceLinkTransferCodec, 'gunzipBase64Async' | 'deflateRawBase64' | 'inflateRawBase64'>> = {
  gzipBase64: (text) => gzipSync(Buffer.from(text, 'utf8')).toString('base64'),
  gunzipBase64: (base64, maxChars) => gunzipSync(Buffer.from(base64, 'base64'), { maxOutputLength: maxChars }).toString('utf8'),
  contentTag: (text) => createHash('sha256').update(text).digest('base64url'),
};
const large = { rows: 'a'.repeat(INVOKE_TRANSFER_MIN_CHARS * 4) };

describe('asynchronous gunzip', () => {
  const channel = { channel: 'c', args: [] };
  const encoded = () => encodeInvokeResultTransfer({ gzip: 1 }, { ok: true, result: large }, codec);

  it('prefers the async decoder, reports timing and remembers the result for notModified', async () => {
    const gunzipBase64 = vi.fn(codec.gunzipBase64);
    const gunzipBase64Async = vi.fn(async (base64: string, maxChars: number) => codec.gunzipBase64(base64, maxChars));
    const cache = new InvokeResultCache({ gunzipBase64, gunzipBase64Async });
    const observe = vi.fn();
    const first = cache.prepare('peer', channel);
    expect(first.payload.transfer).toEqual({ gzip: 1 });
    const pending = first.decode(encoded(), observe);
    expect(pending).toBeInstanceOf(Promise);
    await expect(pending).resolves.toEqual({ ok: true, result: large });
    expect(gunzipBase64Async).toHaveBeenCalledWith(expect.any(String), INVOKE_TRANSFER_MAX_CHARS);
    expect(gunzipBase64).not.toHaveBeenCalled();
    expect(observe).toHaveBeenCalledWith({ inflateMs: expect.any(Number), parseMs: expect.any(Number) });
    const tag = (encoded() as { transfer: { tag?: string } }).transfer.tag;
    expect(tag).toBeDefined();
    const second = cache.prepare('peer', channel);
    expect(second.payload.transfer).toEqual({ gzip: 1, ifNoneMatch: tag });
    expect(second.decode({ ok: true, result: null, transfer: { tag, notModified: true } }))
      .toEqual({ ok: true, result: large });
  });

  it('turns a failed async decode into the same invalid-transfer error', async () => {
    const cache = new InvokeResultCache({
      gunzipBase64: codec.gunzipBase64,
      gunzipBase64Async: async () => { throw new RangeError('decompressed text exceeds limit'); },
    });
    await expect(cache.prepare('peer', channel).decode(encoded())).resolves.toMatchObject({
      ok: false,
      error: { code: 'IPC_ERROR', message: expect.stringContaining('exceeds limit') },
    });
  });

  it('does not put a result back after clear() ran during a slow async decode', async () => {
    let release!: (text: string) => void;
    const cache = new InvokeResultCache({
      gunzipBase64: codec.gunzipBase64,
      gunzipBase64Async: () => new Promise<string>((resolve) => { release = resolve; }),
    });
    const pending = cache.prepare('peer', channel).decode(encoded());
    cache.clear();
    release(JSON.stringify(large));
    await expect(pending).resolves.toEqual({ ok: true, result: large });
    // Nothing was remembered, so the next request carries no validator for the cleared result.
    expect(cache.prepare('peer', channel).payload.transfer).toEqual({ gzip: 1 });
  });

  it('keeps cached results across fence() but drops a decode that was in flight', async () => {
    let release!: (text: string) => void;
    const cache = new InvokeResultCache({ ...codec, gunzipBase64Async: () => new Promise((resolve) => { release = resolve; }) });
    const kept = { channel: 'kept', args: [] };
    cache.prepare('desktop', kept).decode({ ok: true, result: large, transfer: { tag: 'kept' } });
    const late = cache.prepare('desktop', { channel: 'late', args: [] });
    const pending = late.decode({ ok: true, result: null, transfer: { tag: 'late', gzipBase64: 'x' } });
    cache.fence();
    release(JSON.stringify(large));
    await pending;
    expect(cache.prepare('desktop', kept).payload.transfer?.ifNoneMatch).toBe('kept');
    expect(cache.prepare('desktop', { channel: 'late', args: [] }).payload.transfer?.ifNoneMatch).toBeUndefined();
  });

  it('does not let a throwing observer lose the result', () => {
    const cache = new InvokeResultCache({ gunzipBase64: codec.gunzipBase64 });
    expect(cache.prepare('peer', channel).decode(encoded(), () => { throw new Error('metrics'); }))
      .toEqual({ ok: true, result: large });
  });
});

describe('invoke result transfer encoding', () => {
  it('accepts only the documented request options', () => {
    expect(parseInvokeTransferOptions(undefined)).toBeNull();
    expect(parseInvokeTransferOptions({ gzip: true })).toBeNull();
    expect(parseInvokeTransferOptions({ ifNoneMatch: '' })).toBeNull();
    expect(parseInvokeTransferOptions({ ifNoneMatch: 'x'.repeat(129) })).toBeNull();
    expect(parseInvokeTransferOptions({ gzip: 1, ifNoneMatch: 'tag', extra: 1 })).toEqual({ gzip: 1, ifNoneMatch: 'tag' });
  });

  it('leaves small results, errors and already-encoded results unchanged', () => {
    const small = { ok: true as const, result: { id: 1 } };
    expect(encodeInvokeResultTransfer({ gzip: 1 }, small, codec)).toBe(small);
    const failure = { ok: false as const, error: { code: 'IPC_ERROR' as const, message: 'x' } };
    expect(encodeInvokeResultTransfer({ gzip: 1 }, failure, codec)).toBe(failure);
    const encoded = { ok: true as const, result: null, transfer: { tag: 't', notModified: true as const } };
    expect(encodeInvokeResultTransfer({ gzip: 1 }, encoded, codec)).toBe(encoded);
  });

  // 门槛按 UTF-8 字节、与标签分开（INVOKE_TRANSFER_MIN_GZIP_BYTES）：正文复用 / 增量读取后的 1–4 KB 结果
  // 原来原样发送并在可靠层被二次转义；现在压缩，但不带标签、不占控制端 32 条缓存。
  it.each([
    ['below the gzip threshold', 'x'.repeat(600), false],
    ['1–4 KB of JSON rows', JSON.stringify(Array.from({ length: 30 }, (_, i) => ({ id: `row-${i}`, status: 'idle' }))), true],
    ['Chinese text over 1 KiB of UTF-8 but far under 4096 characters', '弱网下的结果正文'.repeat(60), true],
  ])('compresses mid-size results by UTF-8 bytes without tagging them (%s)', (_label, value, compressed) => {
    const payload = { ok: true as const, result: { value } };
    const encoded = encodeInvokeResultTransfer({ gzip: 1 }, payload, codec);
    if (!compressed) {
      expect(encoded).toBe(payload);
      return;
    }
    expect(encoded).toMatchObject({ ok: true, result: null, transfer: { gzipBase64: expect.any(String) } });
    expect((encoded as { transfer: { tag?: string } }).transfer.tag).toBeUndefined();
    const cache = new InvokeResultCache(codec);
    expect(cache.prepare('peer', { channel: 'c', args: [] }).decode(encoded)).toEqual(payload);
    // 不打标签的结果不进缓存：下一次请求不会带 ifNoneMatch。
    expect(cache.prepare('peer', { channel: 'c', args: [] }).payload.transfer).toEqual({ gzip: 1 });
    // 控制端没声明 gzip 时照旧原样。
    expect(encodeInvokeResultTransfer({}, payload, codec)).toBe(payload);
  });

  it('drops a cached large result once the same read comes back small and untagged', () => {
    // 同一读取从 4096 字符以上缩到 1–4 KB：旧标签再也对不上，不能继续占缓存位、每次白带 ifNoneMatch。
    const cache = new InvokeResultCache(codec);
    const request = { channel: 'c', args: [] };
    const first = cache.prepare('peer', request);
    first.decode(encodeInvokeResultTransfer({ gzip: 1 }, { ok: true, result: large }, codec));
    expect(cache.prepare('peer', request).payload.transfer).toMatchObject({ ifNoneMatch: expect.any(String) });
    const smaller = { ok: true as const, result: { rows: '弱网'.repeat(300) } };
    const second = cache.prepare('peer', request);
    expect(second.decode(encodeInvokeResultTransfer({ gzip: 1 }, smaller, codec))).toEqual(smaller);
    expect(cache.prepare('peer', request).payload.transfer).toEqual({ gzip: 1 });
  });

  it('keeps an incompressible result plain but still tags it', () => {
    let seed = 1;
    const noise = Array.from({ length: INVOKE_TRANSFER_MIN_CHARS * 2 }, () => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return String.fromCharCode(33 + (seed % 90));
    }).join('');
    const payload = { ok: true as const, result: noise };
    const out = encodeInvokeResultTransfer({ gzip: 1 }, payload, codec);
    expect(out).toEqual({ ok: true, result: noise, transfer: { tag: expect.any(String) } });
  });

  it('host without gzip support only tags, and answers a matching tag with notModified', () => {
    const tagOnly = { contentTag: codec.contentTag };
    const first = encodeInvokeResultTransfer({ gzip: 1 }, { ok: true, result: large }, tagOnly);
    expect(first.ok && first.result).toEqual(large);
    const tag = first.ok ? first.transfer?.tag : undefined;
    expect(tag).toEqual(expect.any(String));
    expect(encodeInvokeResultTransfer({ ifNoneMatch: tag }, { ok: true, result: large }, tagOnly))
      .toEqual({ ok: true, result: null, transfer: { tag, notModified: true } });
  });

  // Regression: UTF-16 length understates Chinese wire bytes; an otherwise useful
  // gzip result was discarded. Unit tier, real encoder/decoder, bounded fixture.
  it('judges Chinese compression savings by UTF-8 bytes including base64 overhead', () => {
    let seed = 1;
    const text = Array.from({ length: 6000 }, () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return String.fromCharCode(0x4e00 + ((seed >>> 16) % 1024));
    }).join('');
    const json = JSON.stringify(text);
    const base64 = codec.gzipBase64(json);
    expect(base64.length).toBeGreaterThan(json.length);
    expect(base64.length).toBeLessThan(Buffer.byteLength(json) * 0.9);
    const cache = new InvokeResultCache(codec);
    const request = cache.prepare('desktop', { channel: 'c', args: [] });
    const wire = encodeInvokeResultTransfer(request.payload.transfer!, { ok: true, result: text }, codec);
    expect(wire.ok && wire.transfer?.gzipBase64).toBe(base64);
    expect(request.decode(wire)).toEqual({ ok: true, result: text });
  });

  it('controller decodes against the snapshot fixed at request time', () => {
    const cache = new InvokeResultCache(codec);
    const request = { channel: 'maker:provider:list', args: [] };
    const first = cache.prepare('desktop', request);
    expect(first.payload).toEqual({ ...request, transfer: { gzip: 1 } });
    const encoded = encodeInvokeResultTransfer({ gzip: 1 }, { ok: true, result: large }, codec);
    expect(first.decode(encoded)).toEqual({ ok: true, result: large });

    const second = cache.prepare('desktop', request);
    const tag = second.payload.transfer?.ifNoneMatch;
    expect(tag).toEqual(expect.any(String));
    // Evicting everything after the request was sent must not lose the snapshot.
    cache.clear();
    expect(second.decode({ ok: true, result: null, transfer: { tag, notModified: true } }))
      .toEqual({ ok: true, result: large });
    // Another peer or other args never reuse this entry.
    expect(cache.prepare('laptop', request).payload.transfer?.ifNoneMatch).toBeUndefined();
  });

  it('turns an unexpected notModified into an error instead of returning stale data', () => {
    const cache = new InvokeResultCache(codec);
    const prepared = cache.prepare('desktop', { channel: 'c', args: [] });
    expect(prepared.decode({ ok: true, result: null, transfer: { tag: 'other', notModified: true } }))
      .toMatchObject({ ok: false, error: { code: 'IPC_ERROR' } });
  });

  it('bounds the controller cache by entry count', () => {
    const cache = new InvokeResultCache(codec);
    for (let i = 0; i < 40; i += 1) {
      const prepared = cache.prepare('desktop', { channel: 'c', args: [i] });
      prepared.decode(encodeInvokeResultTransfer({ gzip: 1 }, { ok: true, result: large }, codec));
    }
    expect(cache.prepare('desktop', { channel: 'c', args: [0] }).payload.transfer?.ifNoneMatch).toBeUndefined();
    expect(cache.prepare('desktop', { channel: 'c', args: [39] }).payload.transfer?.ifNoneMatch).toEqual(expect.any(String));
  });

  it('host keeps a bounded record of request options', () => {
    const inbound = new InboundInvokeTransferOptions();
    inbound.record('ios', 'old', { channel: 'c', args: [], transfer: { gzip: 1 } });
    inbound.record('ios', 'plain', { channel: 'c', args: [] });
    for (let i = 0; i < 512; i += 1) inbound.record('ios', `r-${i}`, { channel: 'c', args: [], transfer: { gzip: 1 } });
    expect(inbound.get('ios', 'old')).toBeUndefined();
    expect(inbound.get('ios', 'plain')).toBeUndefined();
    expect(inbound.get('ios', 'r-511')).toEqual({ gzip: 1 });
    expect(inbound.get('android', 'r-511')).toBeUndefined();
  });

  it('leaves results above the decode limit unencoded so the existing oversize path still applies', () => {
    const huge = { ok: true as const, result: 'a'.repeat(INVOKE_TRANSFER_MAX_CHARS + 1) };
    expect(encodeInvokeResultTransfer({ gzip: 1 }, huge, codec)).toBe(huge);
  });

  it('rejects a highly compressible result that expands past the limit instead of returning it', () => {
    const cache = new InvokeResultCache(codec);
    const prepared = cache.prepare('desktop', { channel: 'c', args: [] });
    const bomb = codec.gzipBase64(JSON.stringify('a'.repeat(INVOKE_TRANSFER_MAX_CHARS + 16)));
    expect(bomb.length).toBeLessThan(64 * 1024);
    expect(prepared.decode({ ok: true, result: null, transfer: { tag: 't', gzipBase64: bomb } }))
      .toMatchObject({ ok: false, error: { code: 'IPC_ERROR' } });
    expect(cache.prepare('desktop', { channel: 'c', args: [] }).payload.transfer?.ifNoneMatch).toBeUndefined();
  });
});

describe('invoke result delta', () => {
  it('gzips a 1–4 KB list patch like a result and keeps smaller patches plain', () => {
    // Host and controller through their real entries, as client.sendInvokeResult / invoke run them.
    const bases = new InvokeDeltaBases();
    const inbound = new InboundInvokeTransferOptions();
    const cache = new InvokeResultCache(codec);
    const request = { channel: 'local-db:sessions:list', args: [200, 'active'] };
    let n = 0;
    const roundTrip = (rows: unknown) => {
      const prepared = cache.prepare('desktop', request);
      const id = `r${++n}`;
      inbound.record('phone', id, prepared.payload);
      const sent = encodeInvokeResultTransfer(inbound.get('phone', id)!, { ok: true, result: rows }, codec, { src: 'phone', bases });
      return { sent, decoded: prepared.decode(sent) };
    };
    const rows = Array.from({ length: 60 }, (_, i) => ({ id: `s${i}`, preview: createHash('sha256').update(String(i)).digest('hex') }));
    roundTrip(rows);
    // One changed row of ~1.8 KB UTF-8: the patch sits between 1 KiB and the 4096-character tag threshold.
    const changed = rows.map((row, i) => (i === 7 ? { ...row, preview: '进度更新'.repeat(150) } : row));
    const medium = roundTrip(changed);
    const mediumDelta = (medium.sent as { transfer?: { delta?: { gzipBase64?: string; patch?: unknown } } }).transfer?.delta;
    expect(mediumDelta?.gzipBase64).toEqual(expect.any(String));
    expect(mediumDelta?.patch).toBeUndefined();
    expect(medium.decoded).toEqual({ ok: true, result: changed });
    // A patch under 1 KiB stays plain: gzip + base64 would not pay for its wrapper.
    const small = changed.map((row, i) => (i === 3 ? { ...row, preview: 'x' } : row));
    const tiny = roundTrip(small);
    expect((tiny.sent as { transfer?: { delta?: { patch?: unknown } } }).transfer?.delta?.patch).toBeDefined();
    expect(tiny.decoded).toEqual({ ok: true, result: small });
  });

  it('reads one full result after a run of deltas the controller could not hash', () => {
    const cache = new InvokeResultCache({ gunzipBase64: codec.gunzipBase64 });
    const request = { channel: 'local-db:sessions:list', args: [200, 'active'] };
    let rows = [{ id: 'a', n: 0 }, { id: 'b', n: 0 }];
    cache.prepare('desktop', request).decode({ ok: true, result: rows, transfer: { tag: 't0' } });
    const sent: Array<string | undefined> = [];
    for (let n = 1; n <= 9; n++) {
      const prepared = cache.prepare('desktop', request);
      sent.push(prepared.payload.transfer?.ifNoneMatch);
      if (!prepared.payload.transfer?.ifNoneMatch) break;
      rows = [{ id: 'a', n }, rows[1]!];
      const text = JSON.stringify(rows);
      prepared.decode({ ok: true, result: null, transfer: { tag: `t${n}`, delta: {
        base: `t${n - 1}`, length: text.length, sample: sampleInvokeResultText(text), patch: { a: [[rows[0]], 1] } } } });
    }
    // One plain (re-serialized) base plus deltas: the ninth read goes without a base.
    expect(sent.slice(0, 7)).toEqual(['t0', 't1', 't2', 't3', 't4', 't5', 't6']);
    expect(sent.at(-1)).toBeUndefined();
  });

  it('rejects a same-length rebuild with rows out of place on a controller that cannot hash', () => {
    // Mobile injects gunzip only: length and the sampled digest are its whole check.
    const cache = new InvokeResultCache({ gunzipBase64: codec.gunzipBase64 });
    const request = { channel: 'local-db:sessions:list', args: [200, 'active'] };
    const rows = [{ id: 'a', title: 'x'.repeat(40) }, { id: 'b', title: 'y'.repeat(40) }];
    cache.prepare('desktop', request).decode({ ok: true, result: rows, transfer: { tag: 'base' } });
    const expected = JSON.stringify([rows[1], rows[0], { id: 'c', title: 'z'.repeat(40) }]);
    const prepared = cache.prepare('desktop', request);
    expect(prepared.payload.transfer).toEqual({ gzip: 1, ifNoneMatch: 'base', delta: 1 });
    // Indices swapped against the expected order: same length, different text.
    expect(prepared.decode({ ok: true, result: null, transfer: { tag: 'next', delta: {
      base: 'base', length: expected.length, sample: sampleInvokeResultText(expected),
      patch: { a: [0, 1, [{ id: 'c', title: 'z'.repeat(40) }]] } } } })).toMatchObject({ ok: false });
    expect(prepared.retryWithoutBase()).toBe(true);
    expect(cache.prepare('desktop', request).payload.transfer?.ifNoneMatch).toBeUndefined();
  });

  it('refuses a patch that repeats a large base element past the decode limit', () => {
    // Each index reuses one 1 MB element; 8 references would rebuild 8 MB from a few bytes.
    const base = JSON.stringify([{ body: 'x'.repeat(1024 * 1024) }]);
    expect(() => applyInvokeResultPatch(base, { a: Array(8).fill(0) }, INVOKE_TRANSFER_MAX_CHARS))
      .toThrow('delta result too large');
  });
});
