/**
 * gitReviewTransport 单测:git 审查的 device-link 透明传输层。
 *  - deviceId 为空 → 原样返回本地 window.electronAPI.gitReview(零包装)。
 *  - device 分支:op/payload 信封形状、明文 result 与 resultGz(gzip+base64)
 *    解码回读、结构化 OVERSIZE → 带稳定标记的 reject(isReviewRemoteOversizeError
 *    判真)、{ok:false,message} → 原样 reject。
 * window.electronAPI 用 vi.stubGlobal 注入(node 环境,无 jsdom)。
 */

import { gzipSync } from 'node:zlib';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type InvokeMock = ReturnType<typeof vi.fn>;

let invokeMock: InvokeMock;
let localGitReview: Record<string, unknown>;
let transport: typeof import('../lib/gitReviewTransport');

beforeEach(async () => {
  invokeMock = vi.fn();
  localGitReview = { get: vi.fn(), summary: vi.fn() };
  vi.stubGlobal('window', {
    electronAPI: {
      gitReview: localGitReview,
      deviceLink: { invoke: invokeMock },
    },
  });
  transport = await import('../lib/gitReviewTransport');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('gitReviewApiFor', () => {
  it('returns the local API untouched when deviceId is empty', () => {
    expect(transport.gitReviewApiFor(null)).toBe(localGitReview);
    expect(transport.gitReviewApiFor(undefined)).toBe(localGitReview);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('tunnels reads through git-review:remote-op with {op, payload} envelope', async () => {
    invokeMock.mockResolvedValue({ ok: true, result: { scope: { sessionId: 's1' } } });
    const api = transport.gitReviewApiFor('device-1');
    const data = await api.get({ sessionId: 's1', ignoreWhitespace: true });
    expect(data).toEqual({ scope: { sessionId: 's1' } });
    expect(invokeMock).toHaveBeenCalledWith('device-1', 'git-review:remote-op', [
      { op: 'get', payload: { sessionId: 's1', ignoreWhitespace: true } },
    ]);
  });

  it('maps read methods to their op names', async () => {
    invokeMock.mockResolvedValue({ ok: true, result: null });
    const api = transport.gitReviewApiFor('device-1');
    await api.summary({ sessionId: 's1' });
    await api.commits({ sessionId: 's1', baseRef: null });
    await api.commitDiff({ sessionId: 's1', oid: 'a'.repeat(40) });
    await api.branchDiff({ sessionId: 's1' });
    await api.fileDiff({ sessionId: 's1', source: 'unstaged', path: 'a.ts' });
    const ops = invokeMock.mock.calls.map((call) => (call[2] as Array<{ op: string }>)[0].op);
    expect(ops).toEqual(['summary', 'commits', 'commit-diff', 'branch-diff', 'file-diff']);
  });

  it('decodes resultGz (gzip+base64) transparently', async () => {
    const result = { diffs: ['line'.repeat(10_000)] };
    invokeMock.mockResolvedValue({
      ok: true,
      resultGz: gzipSync(Buffer.from(JSON.stringify(result), 'utf8')).toString('base64'),
    });
    const api = transport.gitReviewApiFor('device-1');
    expect(await api.get({ sessionId: 's1' })).toEqual(result);
  });

  it('rejects OVERSIZE with a stable marker recognized by isReviewRemoteOversizeError', async () => {
    invokeMock.mockResolvedValue({ ok: false, code: 'OVERSIZE' });
    const api = transport.gitReviewApiFor('device-1');
    const err = await api.get({ sessionId: 's1' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(transport.isReviewRemoteOversizeError(err)).toBe(true);
    expect(transport.isReviewRemoteOversizeError(new Error('other'))).toBe(false);
  });

  it('rejects structured {ok:false,message} with the original message', async () => {
    invokeMock.mockResolvedValue({ ok: false, message: 'unknown op: get' });
    const api = transport.gitReviewApiFor('device-1');
    await expect(api.get({ sessionId: 's1' })).rejects.toThrow('unknown op: get');
  });
});
