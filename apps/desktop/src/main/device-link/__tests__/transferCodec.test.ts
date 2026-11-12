import { describe, expect, it, vi } from 'vitest';
import { encodeInvokeResultTransfer, InvokeResultCache } from '@cindy/device-link';
import { createCompressionStatsLog, desktopTransferCodec } from '../transferCodec';
import { decodeGzipBase64TextBounded } from '../../../../../mobile/src/utils/gzipBase64';

describe('desktop device-link transfer codec', () => {
  // Protocol regression: the shared Node compressor must retain both desktop
  // zlib and mobile pako compatibility. No native Mobile dependency changes.
  it.each([
    ['desktop', desktopTransferCodec],
    ['mobile', { gunzipBase64: decodeGzipBase64TextBounded }],
  ] as const)('round-trips a large result between a desktop host and a %s controller', (_name, codec) => {
    const result = Array.from({ length: 300 }, (_, i) => ({ id: `s-${i}`, title: '远程任务 ✓' }));
    const controller = new InvokeResultCache(codec);
    const request = controller.prepare('desktop-b', { channel: 'local-db:sessions:list', args: [] });
    const wire = encodeInvokeResultTransfer(request.payload.transfer!, { ok: true, result }, desktopTransferCodec);
    expect(wire.ok && wire.transfer?.gzipBase64).toEqual(expect.any(String));
    expect(JSON.stringify(wire).length).toBeLessThan(JSON.stringify(result).length / 4);
    expect(request.decode(wire)).toEqual({ ok: true, result });
  });

  it('produces a stable content tag', () => {
    expect(desktopTransferCodec.contentTag!('abc')).toBe(desktopTransferCodec.contentTag!('abc'));
    expect(desktopTransferCodec.contentTag!('abc')).not.toBe(desktopTransferCodec.contentTag!('abd'));
  });

  it('stops decompressing once the output limit is exceeded', () => {
    const bomb = desktopTransferCodec.gzipBase64!('a'.repeat(1_000_000));
    expect(desktopTransferCodec.gunzipBase64!(bomb, 1_000_000)).toHaveLength(1_000_000);
    expect(() => desktopTransferCodec.gunzipBase64!(bomb, 100_000)).toThrow();
    // Multi-byte text is measured in JS string length, not UTF-8 bytes.
    const cjk = desktopTransferCodec.gzipBase64!('弱'.repeat(1_000));
    expect(desktopTransferCodec.gunzipBase64!(cjk, 1_000)).toHaveLength(1_000);
    expect(() => desktopTransferCodec.gunzipBase64!(cjk, 999)).toThrow();
  });

  // Log-noise regression: one DEBUG line per compressed reply (~16k/day) becomes one
  // windowed summary; a slow synchronous compression is still reported on its own.
  it('aggregates compression stats per window and reports slow calls immediately', () => {
    const emit = vi.fn();
    let now = 0;
    const record = createCompressionStatsLog(emit, () => now, 1_000);
    const stats = { originalBytes: 10_000, gzipBytes: 1_000, wireBytes: 1_336, compressionMs: 2 };
    for (let i = 0; i < 100; i++) record(stats);
    expect(emit).not.toHaveBeenCalled();
    record({ ...stats, compressionMs: 150 });
    expect(emit).toHaveBeenCalledExactlyOnceWith('gzip slow candidate', { ...stats, compressionMs: 150 });
    now = 1_000;
    record(stats);
    expect(emit).toHaveBeenLastCalledWith('gzip summary', {
      count: 101, originalBytes: 1_010_000, gzipBytes: 101_000, wireBytes: 134_936,
      compressionMs: 350, maxCompressionMs: 150, elapsedMs: 1_000,
    });
    expect(emit).toHaveBeenCalledTimes(2);
  });
});
