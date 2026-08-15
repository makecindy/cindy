/**
 * git-review device-op 单测:device-link 远程审查(只读)的被控端执行层。
 * 覆盖——
 *   1. op 白名单:未知 op 与写 op(stage / commit / push / open-file)确定性拒绝,
 *      不进 dispatch(只读契约是安全边界,必须有回归)
 *   2. 只读 op 路由:payload 经真实 parse* 校验后到达对应 readReview*;
 *      非法 pathspec 被 parseFileDiffPayload 拦下([INVALID_PARAMS] 原样上抛)
 *   3. 响应编码:小结果明文;大可压缩结果 gzip(resultGz 回读一致);
 *      gzip 后仍超预算 → 结构化 OVERSIZE(不裸炸帧限)
 */

import { randomBytes } from 'node:crypto';
import { gunzipSync } from 'node:zlib';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const readReviewDataMock = vi.fn();
const readReviewSummaryMock = vi.fn();
const readReviewCommitsMock = vi.fn();
const readReviewCommitDiffMock = vi.fn();
const readReviewBranchDiffMock = vi.fn();
const readReviewFileDiffMock = vi.fn();
const readReviewImagePreviewMock = vi.fn();
const readReviewMarkdownPreviewMock = vi.fn();
const withSessionReviewExecutionMock = vi.hoisted(() => vi.fn());

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  shell: { openPath: vi.fn() },
}));

vi.mock('../sshReviewBackend.js', () => ({
  withSessionReviewExecution: withSessionReviewExecutionMock,
}));

vi.mock('../ipc.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../ipc.js')>();
  return {
    ...actual,
    readReviewData: (...args: unknown[]) => readReviewDataMock(...args),
    readReviewSummary: (...args: unknown[]) => readReviewSummaryMock(...args),
    readReviewCommits: (...args: unknown[]) => readReviewCommitsMock(...args),
    readReviewCommitDiff: (...args: unknown[]) => readReviewCommitDiffMock(...args),
    readReviewBranchDiff: (...args: unknown[]) => readReviewBranchDiffMock(...args),
    readReviewFileDiff: (...args: unknown[]) => readReviewFileDiffMock(...args),
    readReviewImagePreview: (...args: unknown[]) => readReviewImagePreviewMock(...args),
    readReviewMarkdownPreview: (...args: unknown[]) => readReviewMarkdownPreviewMock(...args),
  };
});

import { __gitReviewDeviceOpTesting } from '../device-op.js';

const { handleRemoteOp, GIT_REVIEW_MAX_JSON_BYTES } = __gitReviewDeviceOpTesting;

beforeEach(() => {
  vi.clearAllMocks();
  withSessionReviewExecutionMock.mockImplementation(
    (_sessionId: string, task: () => Promise<unknown>) => task(),
  );
});

describe('git-review device-op', () => {
  it('rejects invalid args deterministically', async () => {
    expect(await handleRemoteOp(undefined as never)).toEqual({ ok: false, message: 'invalid remote-op args' });
    expect(await handleRemoteOp({ payload: {} } as never)).toEqual({ ok: false, message: 'invalid remote-op args' });
  });

  it('rejects unknown and write ops without dispatching (read-only contract)', async () => {
    for (const op of ['nope', 'stage-file', 'unstage-file', 'discard-file', 'stage-hunk', 'commit', 'push', 'open-file']) {
      expect(await handleRemoteOp({ op, payload: { sessionId: 's1' } })).toEqual({
        ok: false,
        message: `unknown op: ${op}`,
      });
    }
    expect(readReviewDataMock).not.toHaveBeenCalled();
    expect(readReviewFileDiffMock).not.toHaveBeenCalled();
  });

  it('routes get with parsed diff options', async () => {
    readReviewDataMock.mockResolvedValue({ scope: { sessionId: 's1' } });
    const res = await handleRemoteOp({ op: 'get', payload: { sessionId: 's1', ignoreWhitespace: true } });
    expect(readReviewDataMock).toHaveBeenCalledWith('s1', { ignoreWhitespace: true });
    expect(res).toEqual({ ok: true, result: { scope: { sessionId: 's1' } } });
  });

  it('routes summary / commits / commit-diff / branch-diff / file-diff / previews', async () => {
    readReviewSummaryMock.mockResolvedValue({ dirty: false });
    readReviewCommitsMock.mockResolvedValue({ commits: [] });
    readReviewCommitDiffMock.mockResolvedValue({ diffs: [] });
    readReviewBranchDiffMock.mockResolvedValue({ diffs: [] });
    readReviewFileDiffMock.mockResolvedValue({ diff: null });

    await handleRemoteOp({ op: 'summary', payload: { sessionId: 's1' } });
    expect(readReviewSummaryMock).toHaveBeenCalledWith('s1');

    await handleRemoteOp({ op: 'commits', payload: { sessionId: 's1', baseRef: 'origin/main' } });
    expect(readReviewCommitsMock).toHaveBeenCalledWith('s1', 'origin/main');

    const oid = 'a'.repeat(40);
    await handleRemoteOp({ op: 'commit-diff', payload: { sessionId: 's1', oid } });
    expect(readReviewCommitDiffMock).toHaveBeenCalledWith('s1', oid, { ignoreWhitespace: false });

    await handleRemoteOp({ op: 'branch-diff', payload: { sessionId: 's1', baseRef: null } });
    expect(readReviewBranchDiffMock).toHaveBeenCalledWith('s1', null, { ignoreWhitespace: false });

    await handleRemoteOp({
      op: 'file-diff',
      payload: { sessionId: 's1', source: 'unstaged', path: 'src/a.ts' },
    });
    expect(readReviewFileDiffMock).toHaveBeenCalledWith('s1', expect.objectContaining({
      source: 'unstaged',
      path: 'src/a.ts',
    }));
  });

  it('surfaces [INVALID_PARAMS] from real payload validation (unsafe pathspec)', async () => {
    await expect(
      handleRemoteOp({ op: 'file-diff', payload: { sessionId: 's1', source: 'unstaged', path: '../evil' } }),
    ).rejects.toThrow(/INVALID_PARAMS/);
    expect(readReviewFileDiffMock).not.toHaveBeenCalled();
  });

  it('summarizes untagged dispatch errors as structured {ok:false}', async () => {
    readReviewDataMock.mockRejectedValue(new Error('boom'));
    expect(await handleRemoteOp({ op: 'get', payload: { sessionId: 's1' } })).toEqual({ ok: false, message: 'boom' });
  });

  it('does not expose controlled-device SSH setup details', async () => {
    withSessionReviewExecutionMock.mockRejectedValue(
      new Error('[SSH_AUTH_FAILED] Identity file C:\\Users\\alice\\.ssh\\id_ed25519'),
    );

    expect(await handleRemoteOp({ op: 'get', payload: { sessionId: 's1' } })).toEqual({
      ok: false,
      message: 'SSH workspace review is unavailable on the controlled device',
    });
  });

  it('gzips large compressible results and round-trips through resultGz', async () => {
    const result = { diff: 'context line\n'.repeat(300_000) }; // ~3.9MB JSON,高度可压缩
    readReviewDataMock.mockResolvedValue(result);
    const res = await handleRemoteOp({ op: 'get', payload: { sessionId: 's1' } });
    expect(res.ok).toBe(true);
    if (!('resultGz' in res)) throw new Error('expected resultGz encoding');
    expect(res.resultGz.length).toBeLessThanOrEqual(GIT_REVIEW_MAX_JSON_BYTES);
    const decoded = JSON.parse(gunzipSync(Buffer.from(res.resultGz, 'base64')).toString('utf8'));
    expect(decoded).toEqual(result);
  });

  it('returns structured OVERSIZE when even gzip cannot fit the frame budget', async () => {
    // 随机字节的 base64 不可压缩:gzip 后仍远超预算 → OVERSIZE。
    readReviewDataMock.mockResolvedValue({ blob: randomBytes(2_500_000).toString('base64') });
    expect(await handleRemoteOp({ op: 'get', payload: { sessionId: 's1' } })).toEqual({ ok: false, code: 'OVERSIZE' });
  });
});
