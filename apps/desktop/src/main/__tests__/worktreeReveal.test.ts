/**
 * worktree-parallel-sessions: worktree:reveal IPC 白名单单测 (I-3 修复)。
 *
 * shell.showItemInFolder 接受任意路径, 没有白名单时 renderer 可构造任意系统路径
 * 触发文件管理器探测目录。修复后 handler 必须先校验路径在 worktreeStore 已登记,
 * 不在白名单 → 返回 { ok: false, error: { kind: 'unknown', ... } } 且不调 shell。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'node:path';
import { extractIpcError } from '../../renderer/utils/ipcError';

// ── mock electron 的 ipcMain + shell ──────────────────────────────────────
const showItemInFolderMock = vi.fn();
const suggestNameMock = vi.fn();
const detectCwdMock = vi.fn();
type Handler = (event: unknown, req: unknown) => unknown | Promise<unknown>;
const handlers = new Map<string, Handler>();
const ipcMainMock = {
  handle: (channel: string, handler: Handler) => {
    handlers.set(channel, handler);
  },
};

vi.mock('electron', () => ({
  ipcMain: ipcMainMock,
  shell: { showItemInFolder: (p: string) => showItemInFolderMock(p) },
}));

// ── mock worktreeStore.getAllPaths 控制白名单 ─────────────────────────────
const getAllPathsMock = vi.fn(() => [] as string[]);
vi.mock('../worktree/worktreeStore', () => ({
  getAllPaths: () => getAllPathsMock(),
  // 其他 export 不用, 但 barrel 还会读到 — 给个空实现避免崩
  getAll: () => [],
  get: () => null,
  set: vi.fn(),
  del: vi.fn(),
  _setStoreForTests: vi.fn(),
}));

// 业务依赖 (避免触达真实 git 调用)
vi.mock('../worktree/WorktreeManager', () => ({
  createWorktree: vi.fn(),
  detectCwd: (...args: unknown[]) => detectCwdMock(...args),
  getForSession: vi.fn(),
  listAll: vi.fn(),
  suggestName: (...args: unknown[]) => suggestNameMock(...args),
  listBranches: vi.fn(),
}));

let registerWorktreeIpc: typeof import('../worktree/index').registerWorktreeIpc;

beforeEach(async () => {
  showItemInFolderMock.mockReset();
  suggestNameMock.mockReset();
  detectCwdMock.mockReset();
  getAllPathsMock.mockReset();
  handlers.clear();
  if (!registerWorktreeIpc) {
    ({ registerWorktreeIpc } = await import('../worktree/index'));
  }
  // 注册 handler 到 mock ipcMain
  registerWorktreeIpc(ipcMainMock as unknown as Electron.IpcMain);
});

function callReveal(req: unknown): Promise<unknown> {
  const handler = handlers.get('worktree:reveal');
  if (!handler) throw new Error('worktree:reveal handler not registered');
  return Promise.resolve(handler({}, req));
}

function callSuggestName(req: unknown): Promise<unknown> {
  const handler = handlers.get('worktree:suggest-name');
  if (!handler) throw new Error('worktree:suggest-name handler not registered');
  return Promise.resolve(handler({}, req));
}

async function callDetectCwd(req: unknown): Promise<unknown> {
  const handler = handlers.get('worktree:detect-cwd');
  if (!handler) throw new Error('worktree:detect-cwd handler not registered');
  return handler({}, req);
}

describe('worktree:detect-cwd IPC contract', () => {
  it.each([true, false])('preserves successful probe responses (inside worktree: %s)', async (inside) => {
    const cwd = path.resolve('/tmp/worktree');
    const response = { isGitRepo: inside, isInsideWorktree: inside, gitInstalled: true };
    detectCwdMock.mockResolvedValue(response);
    await expect(callDetectCwd({ cwd })).resolves.toEqual(response);
    expect(detectCwdMock).toHaveBeenCalledExactlyOnceWith(cwd);
  });

  it.each(['timeout', 'unexpected'])('encodes %s failures without leaking raw Git details', async (kind) => {
    const { GitExecError } = await import('../worktree/gitExec');
    const cwd = path.resolve('/private/worktree');
    const rawError = kind === 'timeout'
      ? new GitExecError({
          args: ['rev-parse'], exitCode: null, timedOut: true,
          stdout: 'private output', stderr: `probe stalled in ${cwd}`,
        })
      : new Error(`failed in ${cwd}`);
    detectCwdMock.mockRejectedValue(rawError);

    const error = await callDetectCwd({ cwd }).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({ code: 'INTERNAL' });
    // Electron only preserves the message; the renderer must still decode it.
    const serialized = new Error(`Error invoking remote method 'worktree:detect-cwd': ${(error as Error).toString()}`);
    expect(extractIpcError(serialized)).toEqual({
      code: 'INTERNAL', message: 'Worktree directory probe failed',
    });
    expect(serialized.message).not.toContain(cwd);
    expect(serialized.message).not.toContain('rev-parse');
    expect(serialized.message).not.toContain('private output');
  });
});

describe('worktree:suggest-name IPC contract', () => {
  it('wraps the generated name in the declared response shape', async () => {
    suggestNameMock.mockResolvedValue('pensive-lederberg');

    await expect(callSuggestName({ baseRepo: '/repo' })).resolves.toEqual({
      name: 'pensive-lederberg',
    });
    expect(suggestNameMock).toHaveBeenCalledWith('/repo');
  });
});

describe('worktree:reveal whitelist (I-3 fix)', () => {
  it('rejects requests for paths NOT in worktreeStore.getAllPaths()', async () => {
    const managed = path.resolve('/tmp/repo/.xdt-worktrees/jolly-turing');
    const evil = path.resolve('/etc/passwd');
    getAllPathsMock.mockReturnValue([managed]);

    const resp = (await callReveal({ path: evil })) as {
      ok: boolean;
      error?: { kind: string; message: string };
    };

    expect(resp.ok).toBe(false);
    expect(resp.error?.kind).toBe('unknown');
    expect(resp.error?.message).toMatch(/not in managed worktrees/i);
    expect(showItemInFolderMock).not.toHaveBeenCalled();
  });

  it('accepts requests for paths IN the whitelist and forwards to shell.showItemInFolder', async () => {
    const managed = path.resolve('/tmp/repo/.xdt-worktrees/jolly-turing');
    getAllPathsMock.mockReturnValue([managed]);

    const resp = (await callReveal({ path: managed })) as { ok: boolean };

    expect(resp.ok).toBe(true);
    expect(showItemInFolderMock).toHaveBeenCalledTimes(1);
    expect(showItemInFolderMock).toHaveBeenCalledWith(managed);
  });

  it('rejects malformed requests (missing/non-string path)', async () => {
    getAllPathsMock.mockReturnValue([]);
    const resp = (await callReveal({})) as { ok: boolean; error?: { kind: string } };
    expect(resp.ok).toBe(false);
    expect(resp.error?.kind).toBe('unknown');
    expect(showItemInFolderMock).not.toHaveBeenCalled();
  });
});
