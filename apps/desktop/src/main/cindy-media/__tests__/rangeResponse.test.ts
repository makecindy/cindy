/**
 * rangeResponse.test.ts — cindy 系媒体协议 Range/206 组装(视频播放支持)。
 * 锁死三态:无 Range 头 → 200 全量 + Accept-Ranges(<video> 才知道能 seek);
 * 合法 Range → 206 精确分片;越界 → 416 带总长。图片路径(无 Range 头)行为
 * 与修复前一致由 200 分支保证。
 */

import { describe, expect, it, vi } from 'vitest';

// audioFileProtocol(parseRangeHeader 宿主)模块顶层 import electron。
vi.mock('electron', () => ({ protocol: { handle: vi.fn() } }));

const { buildRangedMediaResponse } = await import('../rangeResponse');

const BUF = Buffer.from('0123456789'); // 10 字节
const base = { buffer: BUF, mimeType: 'video/mp4', cacheControl: 'no-cache' };

describe('buildRangedMediaResponse', () => {
  it('无 Range 头 → 200 全量,带 Accept-Ranges 与 Content-Length', async () => {
    const r = buildRangedMediaResponse({ ...base, rangeHeader: null });
    expect(r.status).toBe(200);
    expect(r.headers.get('Accept-Ranges')).toBe('bytes');
    expect(r.headers.get('Content-Length')).toBe('10');
    expect(r.headers.get('Content-Type')).toBe('video/mp4');
    expect(Buffer.from(await r.arrayBuffer()).toString()).toBe('0123456789');
  });

  it('合法 Range → 206 精确分片 + Content-Range', async () => {
    const r = buildRangedMediaResponse({ ...base, rangeHeader: 'bytes=2-5' });
    expect(r.status).toBe(206);
    expect(r.headers.get('Content-Range')).toBe('bytes 2-5/10');
    expect(r.headers.get('Content-Length')).toBe('4');
    expect(Buffer.from(await r.arrayBuffer()).toString()).toBe('2345');
  });

  it('共享媒体响应把超过 EOF 的结束位收窄到最后一个字节', async () => {
    const r = buildRangedMediaResponse({ ...base, rangeHeader: 'bytes=4-99' });

    expect(r.status).toBe(206);
    expect(r.headers.get('Content-Range')).toBe('bytes 4-9/10');
    expect(r.headers.get('Content-Length')).toBe('6');
    expect(Buffer.from(await r.arrayBuffer()).toString()).toBe('456789');
  });

  it('开区间 Range(bytes=8-)→ 206 到末尾;越界 → 416 带总长', async () => {
    const open = buildRangedMediaResponse({ ...base, rangeHeader: 'bytes=8-' });
    expect(open.status).toBe(206);
    expect(open.headers.get('Content-Range')).toBe('bytes 8-9/10');

    const bad = buildRangedMediaResponse({ ...base, rangeHeader: 'bytes=99-' });
    expect(bad.status).toBe(416);
    expect(bad.headers.get('Content-Range')).toBe('bytes */10');
  });

  it('畸形 Range 头当没有处理(200 全量,不 500)', () => {
    const r = buildRangedMediaResponse({ ...base, rangeHeader: 'bytes=abc' });
    expect(r.status).toBe(200);
  });
});
