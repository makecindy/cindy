/**
 * device-op 单测:device-link 远程文件浏览的被控端执行层。
 * 覆盖——
 *   1. 参数/guard 拒绝(workdir 收敛是安全边界,必须有回归)
 *   2. 本地 op 全套(fixture 目录真实 fs;返回形状与本地 IPC handler 一致)
 *   3. readFile oversize → 结构化 OVERSIZE(不裸炸帧限)
 *   4. 嵌套:workdir 非本地目录 + 会话表带 remoteHostId → SSH 二跳透传
 *   5. watch 订阅生命周期:onFsWatchSubscribed → 真实 fs 变更 → push 出口收到事件
 */

import { mkdtemp, mkdir, rm, writeFile as fsWriteFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  WorkdirWatchManager,
  type RemoteFileTreeEvent,
} from '@cindy/remote-file-service';
import { FILE_BROWSER_EVENT_CHANNEL } from '@cindy/device-link';
import type { RemoteWorkingDirCheckResult } from '../../device-link/remote-workdir-guard.js';

const pushSpy = vi.fn();
const ownerStampState = vi.hoisted(() => ({
  current: { dataOwnerId: 'owner-a', ownerGeneration: 7 },
}));
const guardMock = vi.fn<(dir: string) => Promise<RemoteWorkingDirCheckResult>>(async () => ({
  allowed: true,
  source: 'filesystem',
}));
const sshRequestMock = vi.fn();
const sshListenerState = vi.hoisted(() => ({
  hostEventHandlers: [] as Array<(event: unknown) => void>,
  hostConnectedHandlers: [] as Array<() => void>,
}));
const dbRowsMock = vi.fn((): Array<{ remoteHostId: string | null }> => []);
const dbWhereMock = vi.fn(async (_condition: unknown) => dbRowsMock());

function hasDeepValue(root: unknown, expected: unknown): boolean {
  const seen = new Set<object>();
  const visit = (value: unknown): boolean => {
    if (value === expected) return true;
    if (!value || typeof value !== 'object' || seen.has(value)) return false;
    seen.add(value);
    return Object.values(value).some(visit);
  };
  return visit(root);
}

vi.mock('electron', () => ({
  app: { once: vi.fn() },
  ipcMain: { handle: vi.fn() },
  utilityProcess: { fork: vi.fn() },
}));
const uploadMock = vi.fn(async (p: string) => ({ key: `oss/${p.split('/').pop()}`, size: 4, contentType: 'text/plain' }));
vi.mock('../../device-link/mediaTransfer.js', () => ({
  uploadLocalFile: (p: string) => uploadMock(p),
}));
vi.mock('../../device-link/remote-workdir-guard.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../device-link/remote-workdir-guard.js')>();
  return {
    ...actual,
    checkRemoteWorkingDir: (dir: string) => guardMock(dir),
  };
});
vi.mock('../../device-link/broadcast-tap.js', () => ({
  getSafeDataOwnerPushStamp: () => ownerStampState.current,
}));
vi.mock('../../device-link/dispatch.js', () => ({
  pushToTopicSubscribers: (channel: string, payload: unknown, ownerStamp?: unknown) =>
    pushSpy(channel, payload, ownerStamp),
}));
vi.mock('../../device-link/subscriptions.js', () => ({
  setTopicsSubscribedListener: vi.fn(),
  setTopicsReleasedListener: vi.fn(),
}));
vi.mock('../../localDb/client/current.js', () => ({
  getDbClient: () => ({
    drizzle: {
      select: () => ({
        from: () => ({
          where: () => ({ limit: async () => dbRowsMock() }),
        }),
      }),
      // 端点判定改用 selectDistinct(歧义检测需要全部 host),where 直接可 await。
      selectDistinct: () => ({
        from: () => ({
          where: (condition: unknown) => dbWhereMock(condition),
        }),
      }),
    },
  }),
}));
vi.mock('../../maker-host/runtime-configs.js', () => ({
  getRipgrepBinaryPath: () => '/nonexistent/rg',
}));
vi.mock('../remote-deps.js', () => ({
  getRemoteFileBrowser: () => ({
    request: sshRequestMock,
    onHostEvent: vi.fn((_hostId: string, cb: (event: unknown) => void) => {
      sshListenerState.hostEventHandlers.push(cb);
      return () => {
        const index = sshListenerState.hostEventHandlers.indexOf(cb);
        if (index >= 0) sshListenerState.hostEventHandlers.splice(index, 1);
      };
    }),
    onHostConnected: vi.fn((_hostId: string, cb: () => void) => {
      sshListenerState.hostConnectedHandlers.push(cb);
      return () => {
        const index = sshListenerState.hostConnectedHandlers.indexOf(cb);
        if (index >= 0) sshListenerState.hostConnectedHandlers.splice(index, 1);
      };
    }),
  }),
}));

import { __deviceOpTesting } from '../device-op.js';

const { handleRemoteOp, onFsWatchSubscribed, onFsWatchReleased } = __deviceOpTesting;

describe('file-browser device-op', () => {
  let workdir: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    ownerStampState.current = { dataOwnerId: 'owner-a', ownerGeneration: 7 };
    sshListenerState.hostEventHandlers.length = 0;
    sshListenerState.hostConnectedHandlers.length = 0;
    guardMock.mockResolvedValue({ allowed: true, source: 'filesystem' });
    dbRowsMock.mockReturnValue([]);
    workdir = await mkdtemp(path.join(os.tmpdir(), 'device-op-'));
    await mkdir(path.join(workdir, 'src'));
    await fsWriteFile(path.join(workdir, '.gitignore'), 'ignored/\n', 'utf8');
    await fsWriteFile(path.join(workdir, 'src', 'a.ts'), 'export const a = 1;\n', 'utf8');
  });

  afterEach(async () => {
    onFsWatchReleased(workdir);
    await rm(workdir, { recursive: true, force: true });
  });

  it('rejects invalid args and guard-denied workdir', async () => {
    expect(await handleRemoteOp({ op: 'listDir', workdir: '' })).toMatchObject({ ok: false });
    guardMock.mockResolvedValue({ allowed: false, reason: 'not-found' });
    await expect(handleRemoteOp({ op: 'listDir', workdir })).rejects.toThrow(
      /REMOTE_WORKDIR_NOT_FOUND/,
    );
    expect(guardMock).toHaveBeenCalledWith(workdir);
  });

  it('known network workdir whose async endpoint probe times out is rejected clearly', async () => {
    guardMock.mockResolvedValue({ allowed: false, reason: 'timeout' });

    await expect(handleRemoteOp({ op: 'listDir', workdir })).rejects.toThrow(
      /REMOTE_WORKDIR_UNAVAILABLE/,
    );
  });

  it('guard rejection wins before compressed input decoding', async () => {
    guardMock.mockResolvedValue({ allowed: false, reason: 'not-found' });

    await expect(
      handleRemoteOp({
        op: 'writeFile',
        workdir,
        relPath: 'src/a.ts',
        contentGz: 'not-a-gzip-stream',
      }),
    ).rejects.toThrow(/REMOTE_WORKDIR_NOT_FOUND/);
  });

  it('local listDir / readFile / stat match local handler shapes', async () => {
    const entries = (await handleRemoteOp({ op: 'listDir', workdir })) as Array<{ name: string }>;
    expect(entries.map((e) => e.name)).toContain('src');

    const read = (await handleRemoteOp({ op: 'readFile', workdir, relPath: 'src/a.ts' })) as {
      ok: true;
      data: { content: string };
    };
    expect(read.ok).toBe(true);
    expect(read.data.content).toBe('export const a = 1;\n');

    const stat = (await handleRemoteOp({ op: 'stat', workdir, relPath: 'src/a.ts' })) as {
      type: string;
    };
    expect(stat.type).toBe('file');
  });

  it('local write path ops work end to end', async () => {
    await handleRemoteOp({ op: 'writeFile', workdir, relPath: 'src/a.ts', content: 'changed\n' });
    const read = (await handleRemoteOp({ op: 'readFile', workdir, relPath: 'src/a.ts' })) as {
      data: { content: string };
    };
    expect(read.data.content).toBe('changed\n');

    expect(await handleRemoteOp({ op: 'createFolder', workdir, relPath: 'docs' })).toMatchObject({
      ok: true,
    });
    expect(await handleRemoteOp({ op: 'createFile', workdir, relPath: 'docs/x.md' })).toMatchObject({
      ok: true,
    });
    expect(
      await handleRemoteOp({ op: 'renameEntry', workdir, fromRel: 'docs/x.md', toRel: 'docs/y.md' }),
    ).toMatchObject({ ok: true });
    expect(await handleRemoteOp({ op: 'deleteEntry', workdir, relPath: 'docs/y.md' })).toMatchObject({
      ok: true,
    });
  });

  it('exportFile two-phase: start/status lifecycle and traversal rejection', async () => {
    await fsWriteFile(path.join(workdir, 'docs', 'x.md'), 'big\n', 'utf8').catch(async () => {
      await mkdir(path.join(workdir, 'docs'), { recursive: true });
      await fsWriteFile(path.join(workdir, 'docs', 'x.md'), 'big\n', 'utf8');
    });
    const start = (await handleRemoteOp({ op: 'exportFileStart', workdir, relPath: 'docs/x.md' })) as {
      ok: boolean;
      transferId?: string;
    };
    expect(start.ok).toBe(true);
    expect(start.transferId).toBeTruthy();
    expect(uploadMock).toHaveBeenCalledTimes(1);
    // uploadMock 同步 resolve → 下一轮 status 即 done,并带回 key。
    await new Promise((r) => setTimeout(r, 10));
    const st = (await handleRemoteOp({
      op: 'exportFileStatus',
      workdir,
      transferId: start.transferId,
    })) as { ok: boolean; state?: string; key?: string };
    expect(st.ok).toBe(true);
    expect(st.state).toBe('done');
    expect(st.key).toContain('x.md');
    // 幂等:终态回包可能在 relay 上丢失,控制端重查同 id 必须仍拿到 done/key
    // (读到即删会让重查得到 unknown → 整次取回作废、大文件从头重传)。
    const again = (await handleRemoteOp({
      op: 'exportFileStatus',
      workdir,
      transferId: start.transferId,
    })) as { ok: boolean; state?: string; key?: string };
    expect(again.ok).toBe(true);
    expect(again.state).toBe('done');
    expect(again.key).toContain('x.md');

    const esc = (await handleRemoteOp({
      op: 'exportFileStart',
      workdir,
      relPath: '../outside.txt',
    })) as { ok: boolean };
    expect(esc.ok).toBe(false);
    expect(uploadMock).toHaveBeenCalledTimes(1);
  });

  it('oversize readFile returns structured OVERSIZE with stat (never a raw frame blowup)', async () => {
    await fsWriteFile(path.join(workdir, 'big.txt'), 'x'.repeat(1_900_000), 'utf8');
    const res = (await handleRemoteOp({ op: 'readFile', workdir, relPath: 'big.txt' })) as {
      ok: false;
      code: string;
      stat: { size: number };
    };
    expect(res.ok).toBe(false);
    expect(res.code).toBe('OVERSIZE');
    expect(res.stat.size).toBe(1_900_000);
  });

  it('oversize precheck measures serialized UTF-8 bytes, not UTF-16 chars (CJK regression)', async () => {
    // 70 万个中文字符 = 2.1MB UTF-8;core readFile 按 2MiB 字节截断后仅 ~70 万
    // 码元——字符数判据会放行,序列化后必超 2MiB 帧限。必须按字节判为 OVERSIZE。
    await fsWriteFile(path.join(workdir, 'cjk.txt'), '中'.repeat(700_000), 'utf8');
    const res = (await handleRemoteOp({ op: 'readFile', workdir, relPath: 'cjk.txt' })) as {
      ok: false;
      code: string;
      stat: { size: number };
    };
    expect(res.ok).toBe(false);
    expect(res.code).toBe('OVERSIZE');
    expect(res.stat.size).toBe(2_100_000);
  });

  it('mid-size ASCII file stays readable (old char-count limit was over-conservative)', async () => {
    // 1.5M ASCII 字符序列化后 ~1.5MB,离 2MiB 帧限有余量,应正常返回内容。
    await fsWriteFile(path.join(workdir, 'mid.txt'), 'y'.repeat(1_500_000), 'utf8');
    const res = (await handleRemoteOp({ op: 'readFile', workdir, relPath: 'mid.txt' })) as {
      ok: true;
      data: { content: string };
    };
    expect(res.ok).toBe(true);
    expect(res.data.content.length).toBe(1_500_000);
  });

  it('nested: non-local workdir with SSH session rows forwards to the SSH route', async () => {
    const sshWorkdir = '/remote/home/user/proj';
    guardMock.mockResolvedValue({ allowed: false, reason: 'not-found' });
    dbRowsMock.mockReturnValue([{ remoteHostId: 'host-1' }]);
    sshRequestMock.mockResolvedValue({ entries: [{ name: 'r.ts' }] });

    const entries = (await handleRemoteOp({ op: 'listDir', workdir: sshWorkdir })) as Array<{
      name: string;
    }>;
    expect(entries.map((e) => e.name)).toEqual(['r.ts']);
    expect(sshRequestMock).toHaveBeenCalledWith('host-1', 'listDir', {
      workdir: sshWorkdir,
      relPath: '',
      hideMetaFiles: true,
      docMode: undefined,
    });
  });

  it.each(['timeout', 'unavailable'] as const)(
    'nested: local probe %s does not mask a unique SSH route',
    async (reason) => {
      const sshWorkdir = '/remote/home/user/offline-locally';
      guardMock.mockResolvedValue({ allowed: false, reason });
      dbRowsMock.mockReturnValue([{ remoteHostId: 'host-1' }]);
      sshRequestMock.mockResolvedValue({ entries: [{ name: 'remote.ts' }] });

      const entries = (await handleRemoteOp({ op: 'listDir', workdir: sshWorkdir })) as Array<{
        name: string;
      }>;
      expect(entries.map((entry) => entry.name)).toEqual(['remote.ts']);
      expect(sshRequestMock).toHaveBeenCalledWith('host-1', 'listDir', {
        workdir: sshWorkdir,
        relPath: '',
        hideMetaFiles: true,
        docMode: undefined,
      });
    },
  );

  it('ambiguous: workdir belonging to multiple SSH hosts is rejected, not guessed', async () => {
    guardMock.mockResolvedValue({ allowed: false, reason: 'not-found' });
    dbRowsMock.mockReturnValue([{ remoteHostId: 'host-1' }, { remoteHostId: 'host-2' }]);
    // 经结构化 IPC 错误让控制端 reject,但不泄露 SSH host ID 等内部路由细节。
    let caught: unknown;
    try {
      await handleRemoteOp({ op: 'listDir', workdir: '/remote/home/user/proj' });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(String(caught)).toMatch(/\[INVALID_PARAMS\].*ambiguous/);
    expect(String(caught)).not.toMatch(/host-[12]/);
    expect(sshRequestMock).not.toHaveBeenCalled();
  });

  it('normalizes an equivalent workdir before looking up its SSH endpoint', async () => {
    const rawWorkdir = '/remote/home/user/proj/';
    guardMock.mockResolvedValue({ allowed: false, reason: 'not-found' });
    dbRowsMock.mockReturnValue([{ remoteHostId: 'host-1' }]);
    sshRequestMock.mockResolvedValue({ entries: [] });

    await handleRemoteOp({ op: 'listDir', workdir: rawWorkdir });

    expect(sshRequestMock).toHaveBeenCalledWith('host-1', 'listDir', {
      workdir: rawWorkdir,
      relPath: '',
      hideMetaFiles: true,
      docMode: undefined,
    });
    const condition = dbWhereMock.mock.calls.at(-1)?.[0];
    expect(hasDeepValue(condition, '/remote/home/user/proj')).toBe(true);
    expect(hasDeepValue(condition, rawWorkdir)).toBe(false);
  });

  it('ambiguous: workdir that exists locally AND has SSH session rows is rejected', async () => {
    // workdir 是真实本地目录(beforeEach 建的),同时会话表里有 SSH 归属——
    // 静默选本地(旧行为)会把读写落在错误机器,必须显式拒绝。
    dbRowsMock.mockReturnValue([{ remoteHostId: 'host-1' }]);
    await expect(handleRemoteOp({ op: 'listDir', workdir })).rejects.toThrow(/ambiguous/);
  });

  it('watch: subscribe starts local watch and pushes fileTree events to topic subscribers', async () => {
    await onFsWatchSubscribed(workdir);
    await new Promise((r) => setTimeout(r, 100));
    ownerStampState.current = { dataOwnerId: 'owner-b', ownerGeneration: 8 };
    await fsWriteFile(path.join(workdir, 'src', 'watched.ts'), 'w\n', 'utf8');
    await vi.waitFor(
      () => {
        const hit = pushSpy.mock.calls.find(
          ([channel, payload]) =>
            channel === 'maker:file-browser:event' &&
            (payload as { relPath?: string }).relPath === 'src/watched.ts',
        );
        if (!hit) throw new Error('no push yet');
      },
      { timeout: 3000, interval: 50 },
    );
    const [, payload, ownerStamp] = pushSpy.mock.calls.find(
      ([, p]) => (p as { relPath?: string }).relPath === 'src/watched.ts',
    )!;
    expect((payload as { workdir: string }).workdir).toBe(workdir);
    expect(ownerStamp).toEqual({ dataOwnerId: 'owner-a', ownerGeneration: 7 });
    onFsWatchReleased(workdir);
  });

  it('watch: guard-denied workdir never starts watching', async () => {
    guardMock.mockResolvedValue({ allowed: false, reason: 'not-found' });
    await onFsWatchSubscribed(workdir);
    await fsWriteFile(path.join(workdir, 'src', 'nope.ts'), 'n\n', 'utf8');
    await new Promise((r) => setTimeout(r, 250));
    expect(pushSpy).not.toHaveBeenCalled();
  });

  it('watch: unavailable local probe still starts a unique SSH watch route', async () => {
    const sshWorkdir = '/remote/home/user/watch-project';
    guardMock.mockResolvedValue({ allowed: false, reason: 'unavailable' });
    dbRowsMock.mockReturnValue([{ remoteHostId: 'host-1' }]);
    sshRequestMock.mockResolvedValue({ ok: true });

    await onFsWatchSubscribed(sshWorkdir);

    expect(sshRequestMock).toHaveBeenCalledWith('host-1', 'watchStart', {
      workdir: sshWorkdir,
      hideMetaFiles: true,
    });
    onFsWatchReleased(sshWorkdir);
  });

  it('watch: release while the guard is pending cancels the stale start', async () => {
    let resolveGuard!: (result: RemoteWorkingDirCheckResult) => void;
    guardMock.mockReturnValueOnce(
      new Promise<RemoteWorkingDirCheckResult>((resolve) => {
        resolveGuard = resolve;
      }),
    );

    const starting = onFsWatchSubscribed(workdir);
    onFsWatchReleased(workdir);
    resolveGuard({ allowed: true, source: 'filesystem' });
    await starting;

    expect(sshRequestMock).not.toHaveBeenCalled();
    await fsWriteFile(path.join(workdir, 'src', 'released.ts'), 'released\n', 'utf8');
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(pushSpy).not.toHaveBeenCalled();
  });

  it('watch: an immediate resubscribe while the guard is pending keeps one current start', async () => {
    let resolveGuard!: (result: RemoteWorkingDirCheckResult) => void;
    guardMock.mockReturnValueOnce(
      new Promise<RemoteWorkingDirCheckResult>((resolve) => {
        resolveGuard = resolve;
      }),
    );

    const firstStart = onFsWatchSubscribed(workdir);
    onFsWatchReleased(workdir);
    await onFsWatchSubscribed(workdir);
    resolveGuard({ allowed: true, source: 'filesystem' });
    await firstStart;

    // fs.watch(recursive) 靠 macOS FSEvents 流, start 返回后仍有短暂空窗,
    // 空窗内的一次性写入事件会整体丢失且不补发 → 在轮询里重复写直到事件到达。
    // 断言语义不变: resubscribe 后的 watcher 确实在推事件。
    let writeSeq = 0;
    await vi.waitFor(
      async () => {
        writeSeq += 1;
        await fsWriteFile(
          path.join(workdir, 'src', 'resubscribed.ts'),
          `active ${writeSeq}\n`,
          'utf8',
        );
        expect(
          pushSpy.mock.calls.some(
            ([, payload]) => (payload as { relPath?: string }).relPath === 'src/resubscribed.ts',
          ),
        ).toBe(true);
      },
      { timeout: 5_000, interval: 100 },
    );
  });

  it('watch: release during SSH watchStart stops a late successful watcher', async () => {
    const sshWorkdir = '/remote/home/user/slow-watch';
    guardMock.mockResolvedValue({ allowed: false, reason: 'not-found' });
    dbRowsMock.mockReturnValue([{ remoteHostId: 'host-1' }]);
    let resolveStart!: () => void;
    const startPending = new Promise<void>((resolve) => {
      resolveStart = resolve;
    });
    sshRequestMock.mockImplementation((_hostId: string, op: string) =>
      op === 'watchStart' ? startPending : Promise.resolve({ ok: true }),
    );

    const starting = onFsWatchSubscribed(sshWorkdir);
    await vi.waitFor(() => {
      expect(sshRequestMock).toHaveBeenCalledWith('host-1', 'watchStart', {
        workdir: sshWorkdir,
        hideMetaFiles: true,
      });
    });
    onFsWatchReleased(sshWorkdir);
    resolveStart();
    await starting;

    expect(sshRequestMock).toHaveBeenCalledWith('host-1', 'watchStop', {
      workdir: sshWorkdir,
    });
  });

  it('watch: release then resubscribe rebuilds SSH watch after the stale start rejects', async () => {
    const sshWorkdir = '/remote/home/user/retry-watch';
    guardMock.mockResolvedValue({ allowed: false, reason: 'not-found' });
    dbRowsMock.mockReturnValue([{ remoteHostId: 'host-1' }]);
    let rejectFirstStart!: (error: Error) => void;
    const firstStart = new Promise<never>((_resolve, reject) => {
      rejectFirstStart = reject;
    });
    let watchStartCount = 0;
    sshRequestMock.mockImplementation((_hostId: string, op: string) => {
      if (op === 'watchStart' && watchStartCount++ === 0) return firstStart;
      return Promise.resolve({ ok: true });
    });

    const staleStart = onFsWatchSubscribed(sshWorkdir);
    await vi.waitFor(() => {
      expect(watchStartCount).toBe(1);
    });
    onFsWatchReleased(sshWorkdir);
    await onFsWatchSubscribed(sshWorkdir);
    rejectFirstStart(new Error('connection reset'));
    await staleStart;

    await vi.waitFor(() => {
      expect(watchStartCount).toBe(2);
    });
    onFsWatchReleased(sshWorkdir);
  });

  it('watch: owner change during local start discards stale owner and rebuilds', async () => {
    let resolveFirstStart!: () => void;
    const firstStart = new Promise<void>((resolve) => {
      resolveFirstStart = resolve;
    });
    const managers: WorkdirWatchManager[] = [];
    const startSpy = vi
      .spyOn(WorkdirWatchManager.prototype, 'start')
      .mockImplementation(function (this: WorkdirWatchManager) {
        managers.push(this);
        return managers.length === 1 ? firstStart : Promise.resolve();
      });
    const stopSpy = vi
      .spyOn(WorkdirWatchManager.prototype, 'stop')
      .mockImplementation(() => undefined);

    try {
      const starting = onFsWatchSubscribed(workdir);
      await vi.waitFor(() => {
        expect(startSpy).toHaveBeenCalledTimes(1);
      });

      ownerStampState.current = { dataOwnerId: 'owner-b', ownerGeneration: 8 };
      resolveFirstStart();
      await starting;

      await vi.waitFor(() => {
        expect(startSpy).toHaveBeenCalledTimes(2);
      });
      expect(managers[1]).not.toBe(managers[0]);
      expect(stopSpy.mock.instances).toContain(managers[0]);

      const event: RemoteFileTreeEvent = {
        workdir,
        type: 'change',
        relPath: 'src/owner-b.ts',
      };
      (managers[1] as unknown as { emit: (value: RemoteFileTreeEvent) => void }).emit(event);
      expect(pushSpy).toHaveBeenCalledWith(
        FILE_BROWSER_EVENT_CHANNEL,
        event,
        { dataOwnerId: 'owner-b', ownerGeneration: 8 },
      );
    } finally {
      onFsWatchReleased(workdir);
      startSpy.mockRestore();
      stopSpy.mockRestore();
    }
  });

  it('watch: owner change during SSH start discards stale owner and rebuilds', async () => {
    const sshWorkdir = '/remote/home/user/owner-race-watch';
    guardMock.mockResolvedValue({ allowed: false, reason: 'not-found' });
    dbRowsMock.mockReturnValue([{ remoteHostId: 'host-1' }]);
    let resolveFirstStart!: () => void;
    const firstStart = new Promise<void>((resolve) => {
      resolveFirstStart = resolve;
    });
    let watchStartCount = 0;
    sshRequestMock.mockImplementation((_hostId: string, op: string) => {
      if (op === 'watchStart' && watchStartCount++ === 0) return firstStart;
      return Promise.resolve({ ok: true });
    });

    const starting = onFsWatchSubscribed(sshWorkdir);
    await vi.waitFor(() => {
      expect(watchStartCount).toBe(1);
    });

    // The first owner commits a new boundary while its watchStart is still in
    // flight. The old start must be stopped and the current subscription
    // rebuilt with the new owner stamp instead of reusing the stale callback.
    ownerStampState.current = { dataOwnerId: 'owner-b', ownerGeneration: 8 };
    resolveFirstStart();
    await starting;

    await vi.waitFor(() => {
      expect(watchStartCount).toBe(2);
    });
    expect(sshRequestMock).toHaveBeenCalledWith('host-1', 'watchStop', {
      workdir: sshWorkdir,
    });
    onFsWatchReleased(sshWorkdir);
  });

  it('watch: a released SSH registration ignores a late reconnect callback', async () => {
    const sshWorkdir = '/remote/home/user/released-reconnect-watch';
    guardMock.mockResolvedValue({ allowed: false, reason: 'not-found' });
    dbRowsMock.mockReturnValue([{ remoteHostId: 'host-1' }]);
    let watchStartCount = 0;
    sshRequestMock.mockImplementation((_hostId: string, op: string) => {
      if (op === 'watchStart') watchStartCount += 1;
      return Promise.resolve({ ok: true });
    });

    await onFsWatchSubscribed(sshWorkdir);
    const staleReconnect = sshListenerState.hostConnectedHandlers[0]!;
    onFsWatchReleased(sshWorkdir);
    staleReconnect();
    await Promise.resolve();

    expect(watchStartCount).toBe(1);
  });

  it('watch: release during SSH reconnect stops a late successful watcher', async () => {
    const sshWorkdir = '/remote/home/user/reconnect-release-watch';
    guardMock.mockResolvedValue({ allowed: false, reason: 'not-found' });
    dbRowsMock.mockReturnValue([{ remoteHostId: 'host-1' }]);
    let resolveReconnect!: () => void;
    const reconnectPending = new Promise<void>((resolve) => {
      resolveReconnect = resolve;
    });
    let watchStartCount = 0;
    sshRequestMock.mockImplementation((_hostId: string, op: string) => {
      if (op === 'watchStart') {
        watchStartCount += 1;
        if (watchStartCount === 2) return reconnectPending;
      }
      return Promise.resolve({ ok: true });
    });

    await onFsWatchSubscribed(sshWorkdir);
    sshListenerState.hostConnectedHandlers[0]!();
    await vi.waitFor(() => {
      expect(watchStartCount).toBe(2);
    });
    onFsWatchReleased(sshWorkdir);
    const stopCountBeforeSettle = sshRequestMock.mock.calls.filter(
      ([, op]) => op === 'watchStop',
    ).length;
    resolveReconnect();

    await vi.waitFor(() => {
      expect(sshRequestMock.mock.calls.filter(([, op]) => op === 'watchStop').length).toBe(
        stopCountBeforeSettle + 1,
      );
    });
    expect(sshListenerState.hostConnectedHandlers).toHaveLength(0);
    expect(sshListenerState.hostEventHandlers).toHaveLength(0);
  });

  it('watch: a late old reconnect does not stop the replacement registration', async () => {
    const sshWorkdir = '/remote/home/user/reconnect-replaced-watch';
    guardMock.mockResolvedValue({ allowed: false, reason: 'not-found' });
    dbRowsMock.mockReturnValue([{ remoteHostId: 'host-1' }]);
    let resolveOldReconnect!: () => void;
    const oldReconnectPending = new Promise<void>((resolve) => {
      resolveOldReconnect = resolve;
    });
    let watchStartCount = 0;
    sshRequestMock.mockImplementation((_hostId: string, op: string) => {
      if (op === 'watchStart') {
        watchStartCount += 1;
        if (watchStartCount === 2) return oldReconnectPending;
      }
      return Promise.resolve({ ok: true });
    });

    await onFsWatchSubscribed(sshWorkdir);
    sshListenerState.hostConnectedHandlers[0]!();
    await vi.waitFor(() => {
      expect(watchStartCount).toBe(2);
    });
    onFsWatchReleased(sshWorkdir);
    ownerStampState.current = { dataOwnerId: 'owner-b', ownerGeneration: 8 };
    await onFsWatchSubscribed(sshWorkdir);
    expect(watchStartCount).toBe(3);
    const stopCountWithReplacement = sshRequestMock.mock.calls.filter(
      ([, op]) => op === 'watchStop',
    ).length;

    resolveOldReconnect();
    await Promise.resolve();
    expect(sshRequestMock.mock.calls.filter(([, op]) => op === 'watchStop')).toHaveLength(
      stopCountWithReplacement,
    );
    const event = {
      event: 'fileTree',
      data: { workdir: sshWorkdir, type: 'change', relPath: 'src/replacement-owner.ts' },
    };
    sshListenerState.hostEventHandlers.at(-1)?.(event);
    expect(pushSpy).toHaveBeenCalledWith(FILE_BROWSER_EVENT_CHANNEL, event.data, {
      dataOwnerId: 'owner-b',
      ownerGeneration: 8,
    });
    onFsWatchReleased(sshWorkdir);
  });

  it('watch: owner change after a failed initial SSH start rebuilds current listeners', async () => {
    const sshWorkdir = '/remote/home/user/owner-reject-watch';
    guardMock.mockResolvedValue({ allowed: false, reason: 'not-found' });
    dbRowsMock.mockReturnValue([{ remoteHostId: 'host-1' }]);
    let rejectFirstStart!: (error: Error) => void;
    const firstStart = new Promise<never>((_resolve, reject) => {
      rejectFirstStart = reject;
    });
    let watchStartCount = 0;
    sshRequestMock.mockImplementation((_hostId: string, op: string) => {
      if (op === 'watchStart' && watchStartCount++ === 0) return firstStart;
      return Promise.resolve({ ok: true });
    });

    const starting = onFsWatchSubscribed(sshWorkdir);
    await vi.waitFor(() => {
      expect(watchStartCount).toBe(1);
    });
    ownerStampState.current = { dataOwnerId: 'owner-b', ownerGeneration: 8 };
    rejectFirstStart(new Error('connection reset'));
    await starting;

    await vi.waitFor(() => {
      expect(watchStartCount).toBe(2);
    });
    const event = {
      event: 'fileTree',
      data: { workdir: sshWorkdir, type: 'change', relPath: 'src/current-owner.ts' },
    };
    sshListenerState.hostEventHandlers.at(-1)?.(event);
    expect(pushSpy).toHaveBeenCalledWith(FILE_BROWSER_EVENT_CHANNEL, event.data, {
      dataOwnerId: 'owner-b',
      ownerGeneration: 8,
    });
    onFsWatchReleased(sshWorkdir);
  });

  it('watch: owner change during SSH reconnect retires the stale registration', async () => {
    const sshWorkdir = '/remote/home/user/owner-reconnect-watch';
    guardMock.mockResolvedValue({ allowed: false, reason: 'not-found' });
    dbRowsMock.mockReturnValue([{ remoteHostId: 'host-1' }]);
    let resolveReconnect!: () => void;
    const reconnectPending = new Promise<void>((resolve) => {
      resolveReconnect = resolve;
    });
    let watchStartCount = 0;
    sshRequestMock.mockImplementation((_hostId: string, op: string) => {
      if (op === 'watchStart') {
        watchStartCount += 1;
        if (watchStartCount === 2) return reconnectPending;
      }
      return Promise.resolve({ ok: true });
    });

    await onFsWatchSubscribed(sshWorkdir);
    const staleReconnect = sshListenerState.hostConnectedHandlers[0]!;
    staleReconnect();
    await vi.waitFor(() => {
      expect(watchStartCount).toBe(2);
    });
    ownerStampState.current = { dataOwnerId: 'owner-b', ownerGeneration: 8 };
    resolveReconnect();

    await vi.waitFor(() => {
      expect(watchStartCount).toBe(3);
    });
    expect(sshRequestMock).toHaveBeenCalledWith('host-1', 'watchStop', {
      workdir: sshWorkdir,
    });
    const event = {
      event: 'fileTree',
      data: { workdir: sshWorkdir, type: 'change', relPath: 'src/reconnected-owner.ts' },
    };
    sshListenerState.hostEventHandlers.at(-1)?.(event);
    expect(pushSpy).toHaveBeenCalledWith(FILE_BROWSER_EVENT_CHANNEL, event.data, {
      dataOwnerId: 'owner-b',
      ownerGeneration: 8,
    });
    onFsWatchReleased(sshWorkdir);
  });

  it('watch: a second release cancels an already scheduled SSH reconcile', async () => {
    const sshWorkdir = '/remote/home/user/cancel-retry-watch';
    guardMock.mockResolvedValue({ allowed: false, reason: 'not-found' });
    dbRowsMock.mockReturnValue([{ remoteHostId: 'host-1' }]);
    let rejectFirstStart!: (error: Error) => void;
    const firstStart = new Promise<never>((_resolve, reject) => {
      rejectFirstStart = reject;
    });
    let watchStartCount = 0;
    sshRequestMock.mockImplementation((_hostId: string, op: string) => {
      if (op === 'watchStart' && watchStartCount++ === 0) return firstStart;
      return Promise.resolve({ ok: true });
    });

    const staleStart = onFsWatchSubscribed(sshWorkdir);
    await vi.waitFor(() => {
      expect(watchStartCount).toBe(1);
    });
    onFsWatchReleased(sshWorkdir);
    await onFsWatchSubscribed(sshWorkdir);
    rejectFirstStart(new Error('connection reset'));
    await staleStart;
    onFsWatchReleased(sshWorkdir);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(watchStartCount).toBe(1);
  });

  // ── gzip(应用层压缩)────────────────────────────────────────────────────

  it('caps op advertises gzip; unknown op stays a deterministic negative signal', async () => {
    // caps 与 workdir 无关,guard 之前处理——guard 拒绝也不影响探测。
    expect(await handleRemoteOp({ op: 'caps', workdir })).toEqual({ ok: true, gzip: true });
    // 控制端把 unknown op 当"老端不支持压缩"的确定性负信号,形状不能漂。
    expect(await handleRemoteOp({ op: 'nope', workdir })).toEqual({
      ok: false,
      message: 'unknown op: nope',
    });
  });

  it('writeFile accepts contentGz (gzip+base64) and lands the plaintext on disk', async () => {
    const original = '# 标题\n' + '正文内容 body text\n'.repeat(5000);
    const contentGz = gzipSync(Buffer.from(original, 'utf8')).toString('base64');
    const res = (await handleRemoteOp({ op: 'writeFile', workdir, relPath: 'src/a.ts', contentGz })) as {
      ok: boolean;
    };
    expect(res.ok).toBe(true);
    const read = (await handleRemoteOp({ op: 'readFile', workdir, relPath: 'src/a.ts' })) as {
      data: { content: string };
    };
    expect(read.data.content).toBe(original);
  });

  it('writeFile rejects decompression bombs (contentGz expanding past the decoded cap)', async () => {
    // 10MB 全零 gzip 后只有 ~10KB,轻松过帧限;解压侧必须按 maxOutputLength
    // 拒绝,不允许在被控端无界膨胀分配(gzip 可 1000:1)。
    const bombGz = gzipSync(Buffer.alloc(10 * 1024 * 1024)).toString('base64');
    const res = (await handleRemoteOp({
      op: 'writeFile',
      workdir,
      relPath: 'src/a.ts',
      contentGz: bombGz,
    })) as { ok: boolean; message?: string };
    expect(res.ok).toBe(false);
    expect(res.message).toContain('invalid contentGz');
    const read = (await handleRemoteOp({ op: 'readFile', workdir, relPath: 'src/a.ts' })) as {
      data: { content: string };
    };
    expect(read.data.content).toBe('export const a = 1;\n');
  });

  it('writeFile rejects corrupted contentGz without touching the file', async () => {
    const res = (await handleRemoteOp({
      op: 'writeFile',
      workdir,
      relPath: 'src/a.ts',
      contentGz: 'not-a-gzip-stream',
    })) as { ok: boolean; message?: string };
    expect(res.ok).toBe(false);
    expect(res.message).toContain('invalid contentGz');
    const read = (await handleRemoteOp({ op: 'readFile', workdir, relPath: 'src/a.ts' })) as {
      data: { content: string };
    };
    expect(read.data.content).toBe('export const a = 1;\n');
  });

  it('readFile + acceptGzip lifts the CJK oversize cliff (gzip-encoded roundtrip)', async () => {
    // 1.95MB CJK:低于 core readFile 的 2MiB 截断线(全量读回),但明文 JSON
    // 字节超 1.8MB 帧预算(不带 acceptGzip 会判 OVERSIZE)。带 acceptGzip 后
    // 应改走 gzip 编码返回,解码等于原文——可编辑上限提升的核心回归。
    const original = '中'.repeat(650_000);
    await fsWriteFile(path.join(workdir, 'cjk.txt'), original, 'utf8');
    const res = (await handleRemoteOp({
      op: 'readFile',
      workdir,
      relPath: 'cjk.txt',
      acceptGzip: true,
    })) as { ok: true; data: { content: string; contentEncoding?: string } };
    expect(res.ok).toBe(true);
    expect(res.data.contentEncoding).toBe('gzip');
    expect(gunzipSync(Buffer.from(res.data.content, 'base64')).toString('utf8')).toBe(original);
  });

  it('readFile + acceptGzip keeps small files plaintext (no needless encoding)', async () => {
    const res = (await handleRemoteOp({
      op: 'readFile',
      workdir,
      relPath: 'src/a.ts',
      acceptGzip: true,
    })) as { ok: true; data: { content: string; contentEncoding?: string } };
    expect(res.ok).toBe(true);
    expect(res.data.contentEncoding).toBeUndefined();
    expect(res.data.content).toBe('export const a = 1;\n');
  });

  it('readFile + acceptGzip still returns OVERSIZE for incompressible oversize content', async () => {
    // base64 随机内容 ≈ 6bit/char 熵,gzip 压不动;编码后仍超预算必须维持
    // OVERSIZE 占位语义,绝不裸炸帧限。
    const incompressible = randomBytes(1_500_000).toString('base64').slice(0, 1_950_000);
    await fsWriteFile(path.join(workdir, 'noise.txt'), incompressible, 'utf8');
    const res = (await handleRemoteOp({
      op: 'readFile',
      workdir,
      relPath: 'noise.txt',
      acceptGzip: true,
    })) as { ok: false; code: string };
    expect(res.ok).toBe(false);
    expect(res.code).toBe('OVERSIZE');
  });

  it('nested SSH: contentGz is decoded before the two-hop forward (daemon sees plaintext)', async () => {
    const sshWorkdir = '/remote/home/user/proj';
    guardMock.mockResolvedValue({ allowed: false, reason: 'not-found' });
    dbRowsMock.mockReturnValue([{ remoteHostId: 'host-1' }]);
    sshRequestMock.mockResolvedValue({ size: 4, mtimeMs: 1 });
    const original = 'ssh 二跳明文 payload\n'.repeat(100);
    const contentGz = gzipSync(Buffer.from(original, 'utf8')).toString('base64');
    const res = (await handleRemoteOp({
      op: 'writeFile',
      workdir: sshWorkdir,
      relPath: 'a.md',
      contentGz,
    })) as { ok: boolean };
    expect(res.ok).toBe(true);
    expect(sshRequestMock).toHaveBeenCalledWith('host-1', 'writeFile', {
      workdir: sshWorkdir,
      relPath: 'a.md',
      content: original,
    });
  });

  describe('thumbnail op(手机网格缩略图)', () => {
    // 1x1 红色 PNG(有效可解码的最小图片)。
    const TINY_PNG = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    );

    it('local: 图片返回 webp base64 + 尺寸/stat 元数据', async () => {
      await fsWriteFile(path.join(workdir, 'src', 'tiny.png'), TINY_PNG);
      const res = (await handleRemoteOp({ op: 'thumbnail', workdir, relPath: 'src/tiny.png' })) as {
        ok: boolean;
        dataBase64?: string;
        mimeType?: string;
        width?: number;
        height?: number;
        size?: number;
        mtimeMs?: number;
        code?: string;
      };
      expect(res.ok).toBe(true);
      expect(res.mimeType).toBe('image/webp');
      expect((res.dataBase64 ?? '').length).toBeGreaterThan(0);
      expect(res.width).toBe(1);
      expect(res.height).toBe(1);
      expect(res.size).toBe(TINY_PNG.byteLength);
      expect(res.mtimeMs).toBeGreaterThan(0);
    });

    it('local: 非图片内容结构化失败(THUMB_FAILED),不 throw', async () => {
      const res = (await handleRemoteOp({ op: 'thumbnail', workdir, relPath: 'src/a.ts' })) as {
        ok: boolean;
        code?: string;
      };
      expect(res.ok).toBe(false);
      expect(res.code).toBe('THUMB_FAILED');
    });

    it('local: 路径穿越被拒绝', async () => {
      const res = (await handleRemoteOp({ op: 'thumbnail', workdir, relPath: '../outside.png' })) as {
        ok: boolean;
      };
      expect(res.ok).toBe(false);
    });

    it('nested SSH: 返回 THUMB_UNSUPPORTED,不发起二跳', async () => {
      guardMock.mockResolvedValue({ allowed: false, reason: 'not-found' });
      dbRowsMock.mockReturnValue([{ remoteHostId: 'host-1' }]);
      const res = (await handleRemoteOp({
        op: 'thumbnail',
        workdir: '/remote/home/user/proj',
        relPath: 'a.png',
      })) as { ok: boolean; code?: string };
      expect(res.ok).toBe(false);
      expect(res.code).toBe('THUMB_UNSUPPORTED');
      expect(sshRequestMock).not.toHaveBeenCalled();
    });
  });
});
