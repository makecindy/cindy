/**
 * fileBrowserTransport gzip 安全闸单测:控制端"绝不向未确认支持的设备发
 * contentGz"是防静默数据丢失的唯一防线,必须锁住——
 *  - caps 探测:新端命中走 contentGz;老端 unknown op 负信号走明文;探测结果
 *    per-device 缓存(不重复探测)。
 *  - 写后校验自愈:caps 正缓存过期(被控端降级回老版本)时,contentGz 落到
 *    老端会被写成空文件(size=0);控制端必须立刻明文重发同一内容并负缓存。
 *  - 小内容不触发探测/压缩;readFile 的 gzip 返回在 transport 层解回明文。
 * window.electronAPI 用 vi.stubGlobal 注入(node 环境,无 jsdom)。
 */

import { randomBytes } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type InvokeMock = ReturnType<typeof vi.fn>;

const BIG = 'markdown 正文内容\n'.repeat(8000); // ~144K chars,> 64K 压缩阈值
const SMALL = 'short content';

let invokeMock: InvokeMock;
let transport: typeof import('../lib/fileBrowserTransport');

/** 取第 n 次 remote-op invoke 的 op args(invoke(deviceId, channel, [args])) */
function opArgs(n: number): Record<string, unknown> {
  return invokeMock.mock.calls[n][2][0] as Record<string, unknown>;
}

beforeEach(async () => {
  invokeMock = vi.fn();
  vi.stubGlobal('window', {
    electronAPI: { deviceLink: { invoke: invokeMock } },
  });
  transport = await import('../lib/fileBrowserTransport');
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// caps 缓存是模块级 per-deviceId,单测用唯一 deviceId 隔离,不依赖模块重载。
let seq = 0;
const freshDevice = () => `dev-${Date.now().toString(36)}-${seq++}`;

describe('fileBrowserTransport gzip write gate', () => {
  it('compresses large writes only after caps confirms, and caches the probe', async () => {
    const deviceId = freshDevice();
    invokeMock.mockImplementation(async (_d: string, _c: string, [args]: [Record<string, unknown>]) => {
      if (args.op === 'caps') return { ok: true, gzip: true };
      if (args.op === 'writeFile') return { ok: true, size: 144_000, mtimeMs: 1 };
      throw new Error(`unexpected op ${String(args.op)}`);
    });
    const api = transport.fileBrowserApiFor(deviceId);
    const res = await api.writeFile({ workdir: '/w', relPath: 'a.md', content: BIG });
    expect(res).toMatchObject({ ok: true });

    // 第 0 次 caps 探测,第 1 次 writeFile:带 contentGz、不带明文 content。
    expect(opArgs(0).op).toBe('caps');
    const write = opArgs(1);
    expect(write.op).toBe('writeFile');
    expect(write.content).toBeUndefined();
    expect(gunzipSync(Buffer.from(write.contentGz as string, 'base64')).toString('utf8')).toBe(BIG);

    // 第二次大写入:caps 已缓存,不再探测。
    await api.writeFile({ workdir: '/w', relPath: 'a.md', content: BIG });
    const opsAfter = invokeMock.mock.calls.map((c) => (c[2][0] as { op: string }).op);
    expect(opsAfter.filter((o) => o === 'caps')).toHaveLength(1);
  });

  it('old target (unknown op: caps) gets plaintext writes, negative-cached', async () => {
    const deviceId = freshDevice();
    invokeMock.mockImplementation(async (_d: string, _c: string, [args]: [Record<string, unknown>]) => {
      if (args.op === 'caps') return { ok: false, message: 'unknown op: caps' };
      if (args.op === 'writeFile') return { ok: true, size: 144_000, mtimeMs: 1 };
      throw new Error(`unexpected op ${String(args.op)}`);
    });
    const api = transport.fileBrowserApiFor(deviceId);
    await api.writeFile({ workdir: '/w', relPath: 'a.md', content: BIG });
    const write = opArgs(1);
    expect(write.op).toBe('writeFile');
    expect(write.content).toBe(BIG);
    expect(write.contentGz).toBeUndefined();
  });

  it('self-heals when stale caps hits a downgraded target (size=0 → plaintext resend + negative cache)', async () => {
    const deviceId = freshDevice();
    invokeMock.mockImplementation(async (_d: string, _c: string, [args]: [Record<string, unknown>]) => {
      if (args.op === 'caps') return { ok: true, gzip: true }; // 陈旧正缓存来源
      if (args.op === 'writeFile') {
        // 老端:收到 contentGz 时 content 缺失 → 空串写盘,size=0;明文则正常。
        return typeof args.contentGz === 'string'
          ? { ok: true, size: 0, mtimeMs: 1 }
          : { ok: true, size: 144_000, mtimeMs: 2 };
      }
      throw new Error(`unexpected op ${String(args.op)}`);
    });
    const api = transport.fileBrowserApiFor(deviceId);
    const res = (await api.writeFile({ workdir: '/w', relPath: 'a.md', content: BIG })) as {
      ok: boolean;
      size: number;
    };
    // 自愈:最终返回的是明文重发的成功结果,不是 size=0 的空写。
    expect(res.ok).toBe(true);
    expect(res.size).toBe(144_000);
    const ops = invokeMock.mock.calls.map((c) => c[2][0] as Record<string, unknown>);
    const writes = ops.filter((a) => a.op === 'writeFile');
    expect(writes).toHaveLength(2);
    expect(typeof writes[0].contentGz).toBe('string');
    expect(writes[1].content).toBe(BIG);

    // 负缓存生效:后续大写入直接明文,不再发 contentGz、不再探测。
    await api.writeFile({ workdir: '/w', relPath: 'a.md', content: BIG });
    const afterOps = invokeMock.mock.calls.map((c) => c[2][0] as Record<string, unknown>);
    const lastWrite = afterOps[afterOps.length - 1];
    expect(lastWrite.op).toBe('writeFile');
    expect(lastWrite.content).toBe(BIG);
    expect(lastWrite.contentGz).toBeUndefined();
    expect(afterOps.filter((a) => a.op === 'caps')).toHaveLength(1);
  });

  it('falls back to plaintext when compressed payload exceeds the frame budget', async () => {
    // base64 随机文本 ≈ 6bit/char 熵,gzip 压不动、再 base64 反而膨胀:
    // ~1.87M 字符 → gz+b64 ≈ 1.87M > 1.8M 预算 → 必须预检回退明文,
    // 而不是发出去撞 invoke 层 PAYLOAD_TOO_LARGE。
    const deviceId = freshDevice();
    const incompressible = randomBytes(1_400_000).toString('base64');
    invokeMock.mockImplementation(async (_d: string, _c: string, [args]: [Record<string, unknown>]) => {
      if (args.op === 'caps') return { ok: true, gzip: true };
      if (args.op === 'writeFile') return { ok: true, size: incompressible.length, mtimeMs: 1 };
      throw new Error(`unexpected op ${String(args.op)}`);
    });
    const api = transport.fileBrowserApiFor(deviceId);
    const res = await api.writeFile({ workdir: '/w', relPath: 'noise.txt', content: incompressible });
    expect(res).toMatchObject({ ok: true });
    const writes = invokeMock.mock.calls
      .map((c) => c[2][0] as Record<string, unknown>)
      .filter((a) => a.op === 'writeFile');
    expect(writes).toHaveLength(1);
    expect(writes[0].content).toBe(incompressible);
    expect(writes[0].contentGz).toBeUndefined();
  });

  it('small writes skip probing and compression entirely', async () => {
    const deviceId = freshDevice();
    invokeMock.mockImplementation(async () => ({ ok: true, size: 13, mtimeMs: 1 }));
    const api = transport.fileBrowserApiFor(deviceId);
    await api.writeFile({ workdir: '/w', relPath: 'a.md', content: SMALL });
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(opArgs(0)).toMatchObject({ op: 'writeFile', content: SMALL });
  });
});

describe('fileBrowserTransport gzip read decode', () => {
  it('requests acceptGzip and transparently decodes gzip-encoded content', async () => {
    const deviceId = freshDevice();
    const original = '中文大文档内容。\n'.repeat(1000);
    const gzB64 = gzipSync(Buffer.from(original, 'utf8')).toString('base64');
    invokeMock.mockResolvedValue({
      ok: true,
      data: { relPath: 'a.md', content: gzB64, contentEncoding: 'gzip', size: 999, mtimeMs: 1, truncated: false },
    });
    const api = transport.fileBrowserApiFor(deviceId);
    const res = (await api.readFile({ workdir: '/w', relPath: 'a.md' })) as {
      ok: true;
      data: { content: string; truncated: boolean } & { contentEncoding?: string };
    };
    expect(opArgs(0)).toMatchObject({ op: 'readFile', acceptGzip: true });
    expect(res.ok).toBe(true);
    expect(res.data.content).toBe(original);
    expect(res.data.contentEncoding).toBeUndefined();
    expect(res.data.truncated).toBe(false);
  });

  it('passes plaintext read results through untouched', async () => {
    const deviceId = freshDevice();
    invokeMock.mockResolvedValue({
      ok: true,
      data: { relPath: 'a.md', content: 'plain', size: 5, mtimeMs: 1, truncated: false },
    });
    const api = transport.fileBrowserApiFor(deviceId);
    const res = (await api.readFile({ workdir: '/w', relPath: 'a.md' })) as { ok: true; data: { content: string } };
    expect(res.data.content).toBe('plain');
  });
});
