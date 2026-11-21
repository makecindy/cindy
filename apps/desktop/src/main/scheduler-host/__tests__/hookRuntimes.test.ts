import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const spawn = vi.hoisted(() => vi.fn());
const killProcessTree = vi.hoisted(() => vi.fn());
const readdir = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:child_process')>(), spawn,
}));
vi.mock('node:fs/promises', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:fs/promises')>(), readdir,
}));
vi.mock('../proc-util', async (importOriginal) => ({
  ...await importOriginal<typeof import('../proc-util')>(), killProcessTree,
}));

import { __resetHookRuntimeCacheForTest, resolveSystemNodeInterpreter } from '../hook-runtimes';
import { executePreRunHook } from '../pre-run-hook';

// 测试价值(unit):#5573 评论要求独立发现 fnm/nvm;生产入口为 resolveSystemNodeInterpreter。
// 独立文件隔离模块缓存与 spawn mock,不读取真实用户目录;最小失败输入是 PATH shim exit 1。
describe('resolveSystemNodeInterpreter', () => {
  beforeEach(async () => {
    __resetHookRuntimeCacheForTest();
    spawn.mockReset();
    killProcessTree.mockReset();
    readdir.mockReset();
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    readdir.mockImplementation(actual.readdir);
  });
  afterEach(() => {
    vi.useRealTimers();
    __resetHookRuntimeCacheForTest();
  });

  function child() {
    return Object.assign(new EventEmitter(), { pid: 4242, kill: vi.fn(() => true) });
  }

  function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => { resolve = done; });
    return { promise, resolve };
  }

  function stdinPayload(cwd: string) {
    return {
      event: 'schedule-pre-run' as const,
      scheduleId: 'runtime-test', scheduleName: 'runtime test', runId: 'runtime-run',
      firedAt: Date.now(), workingDir: cwd,
    };
  }

  it('PATH 可用时保持透明 node', async () => {
    const process = child();
    spawn.mockReturnValueOnce(process);
    const result = resolveSystemNodeInterpreter({ forceProbe: true });
    process.emit('close', 0);
    await expect(result).resolves.toBe('node');
  });

  it('PATH 探测使用实际执行目录,缓存按目录隔离', async () => {
    const cwdA = path.join(tmpdir(), 'node-runtime-project-a');
    const cwdB = path.join(tmpdir(), 'node-runtime-project-b');
    const options = {
      env: {}, home: tmpdir(), readVersions: () => [], probeExecutable: async () => false,
    };
    const first = child();
    const second = child();
    spawn.mockReturnValueOnce(first).mockReturnValueOnce(second);

    const a = resolveSystemNodeInterpreter({ forceProbe: true, cwd: cwdA, ...options });
    expect(spawn).toHaveBeenNthCalledWith(1, 'node --version', [],
      expect.objectContaining({ cwd: cwdA, shell: true, detached: process.platform !== 'win32' }));
    first.emit('close', 0);
    await expect(a).resolves.toBe('node');

    const b = resolveSystemNodeInterpreter({ forceProbe: true, cwd: cwdB, ...options });
    expect(spawn).toHaveBeenNthCalledWith(2, 'node --version', [],
      expect.objectContaining({ cwd: cwdB, shell: true, detached: process.platform !== 'win32' }));
    second.emit('close', 1);
    await expect(b).resolves.toBeNull();

    await expect(resolveSystemNodeInterpreter({ cwd: cwdA, ...options })).resolves.toBe('node');
    await expect(resolveSystemNodeInterpreter({ cwd: cwdB, ...options })).resolves.toBeNull();
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it('PATH shim 失败时按版本倒序发现并验证版本管理器 Node', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'node-runtime-home-'));
    try {
      const expected = process.platform === 'win32'
        ? path.join(home, 'installs', 'v22.23.2', 'node.exe')
        : path.join(home, 'versions', 'node', 'v22.23.2', 'bin', 'node');
      mkdirSync(path.dirname(expected), { recursive: true });
      const old = process.platform === 'win32'
        ? path.join(home, 'installs', 'v22.22.3', 'node.exe')
        : path.join(home, 'versions', 'node', 'v22.22.3', 'bin', 'node');
      mkdirSync(path.dirname(old), { recursive: true });
      const pathChild = child();
      spawn.mockReturnValueOnce(pathChild);
      const probeExecutable = vi.fn(async (executable: string) => executable === expected);
      const result = resolveSystemNodeInterpreter({
        forceProbe: true,
        env: process.platform === 'win32' ? { NVM_HOME: home } : { NVM_DIR: home },
        home,
        probeExecutable,
      });
      pathChild.emit('close', 1);

      const quoted = process.platform === 'win32' ? `"${expected}"` : `'${expected}'`;
      await expect(result).resolves.toBe(quoted);
      expect(probeExecutable).toHaveBeenCalledWith(expected, expect.anything());
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('macOS 未设置 FNM_DIR 时发现 Library/Application Support 下的 Node', async () => {
    const home = '/test/fnm-darwin-home';
    const fnmRoot = path.posix.join(home, 'Library', 'Application Support', 'fnm', 'node-versions');
    const expected = path.posix.join(fnmRoot, 'v22.23.5', 'installation', 'bin', 'node');
    const pathChild = child();
    spawn.mockReturnValueOnce(pathChild);
    const probeExecutable = vi.fn(async (executable: string) => executable === expected);
    const readVersions = vi.fn((directory: string) => directory === fnmRoot ? ['v22.23.5'] : []);
    const result = resolveSystemNodeInterpreter({
      forceProbe: true, platform: 'darwin', pathApi: path.posix,
      env: {}, home, readVersions, probeExecutable,
    });
    pathChild.emit('close', 1);

    await expect(result).resolves.toBe(`'${expected}'`);
    expect(probeExecutable).toHaveBeenCalledWith(expected, expect.anything());
  });

  it('候选全部不可用时返回 null 并缓存,不重复启动 PATH 探测', async () => {
    const pathChild = child();
    spawn.mockReturnValueOnce(pathChild);
    const options = {
      env: {}, home: tmpdir(), readVersions: () => [], probeExecutable: async () => false,
    };
    const result = resolveSystemNodeInterpreter({ forceProbe: true, ...options });
    pathChild.emit('close', 1);

    await expect(result).resolves.toBeNull();
    await expect(resolveSystemNodeInterpreter(options)).resolves.toBeNull();
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('abort 立即结束并终止进程树,不污染下一次探测', async () => {
    const first = child();
    const second = child();
    spawn.mockReturnValueOnce(first).mockReturnValueOnce(second);
    const controller = new AbortController();
    const result = resolveSystemNodeInterpreter({ forceProbe: true, signal: controller.signal });
    controller.abort();
    await expect(result).resolves.toBeNull();
    expect(killProcessTree).toHaveBeenCalledWith(first.pid, first);

    const next = resolveSystemNodeInterpreter({ forceProbe: true });
    second.emit('close', 0);
    await expect(next).resolves.toBe('node');
  });

  it('短预算耗尽返回 null,不写成全局无 Node 缓存', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const first = child();
    const second = child();
    spawn.mockReturnValueOnce(first).mockReturnValueOnce(second);
    const short = resolveSystemNodeInterpreter({ forceProbe: true, timeoutMs: 10 });
    await vi.advanceTimersByTimeAsync(10);
    await expect(short).resolves.toBeNull();

    const next = resolveSystemNodeInterpreter({ forceProbe: true });
    second.emit('close', 0);
    await expect(next).resolves.toBe('node');
  });

  it('同 cwd 合并在途探测,单个调用者 abort 不取消其他等待者', async () => {
    const cwd = path.join(tmpdir(), 'node-runtime-shared-abort');
    const pathChild = child();
    spawn.mockReturnValueOnce(pathChild);
    const controller = new AbortController();
    const options = { forceProbe: true, cwd };
    const first = resolveSystemNodeInterpreter({ ...options, signal: controller.signal });
    const second = resolveSystemNodeInterpreter(options);
    expect(spawn).toHaveBeenCalledTimes(1);

    controller.abort();
    await expect(first).resolves.toBeNull();
    expect(killProcessTree).not.toHaveBeenCalled();
    pathChild.emit('close', 0);
    await expect(second).resolves.toBe('node');
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('同 cwd 的短预算调用者退出后,其他调用者继续等待共享结果', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const cwd = path.join(tmpdir(), 'node-runtime-shared-budget');
    const pathChild = child();
    spawn.mockReturnValueOnce(pathChild);
    const options = { forceProbe: true, cwd };
    const short = resolveSystemNodeInterpreter({ ...options, timeoutMs: 10 });
    const full = resolveSystemNodeInterpreter(options);
    expect(spawn).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(10);
    await expect(short).resolves.toBeNull();
    expect(killProcessTree).not.toHaveBeenCalled();
    pathChild.emit('close', 0);
    await expect(full).resolves.toBe('node');
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('挂起目录读取响应 abort,迟到结果不写成缓存', async () => {
    const read = deferred<string[]>();
    const cwd = path.join(tmpdir(), 'node-runtime-read-abort');
    const base = {
      cwd, env: {}, home: tmpdir(), readVersions: vi.fn(() => read.promise),
      probeExecutable: async () => false,
    };
    const pathChild = child();
    const nextChild = child();
    spawn.mockReturnValueOnce(pathChild).mockReturnValueOnce(nextChild);
    const controller = new AbortController();
    const first = resolveSystemNodeInterpreter({
      ...base, forceProbe: true, signal: controller.signal,
    });
    pathChild.emit('close', 1);
    await vi.waitFor(() => expect(base.readVersions).toHaveBeenCalled());

    controller.abort();
    await expect(first).resolves.toBeNull();
    read.resolve([]);
    await Promise.resolve();
    await Promise.resolve();

    const next = resolveSystemNodeInterpreter(base);
    nextChild.emit('close', 0);
    await expect(next).resolves.toBe('node');
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it('挂起目录读取响应总预算,迟到结果不写成缓存', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const read = deferred<string[]>();
    const cwd = path.join(tmpdir(), 'node-runtime-read-timeout');
    const base = {
      cwd, env: {}, home: tmpdir(), readVersions: vi.fn(() => read.promise),
      probeExecutable: async () => false,
    };
    const pathChild = child();
    const nextChild = child();
    spawn.mockReturnValueOnce(pathChild).mockReturnValueOnce(nextChild);
    const first = resolveSystemNodeInterpreter({ ...base, forceProbe: true, timeoutMs: 50 });
    pathChild.emit('close', 1);
    await vi.advanceTimersByTimeAsync(0);
    expect(base.readVersions).toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(50);
    await expect(first).resolves.toBeNull();
    read.resolve([]);
    await vi.advanceTimersByTimeAsync(0);

    const next = resolveSystemNodeInterpreter(base);
    nextChild.emit('close', 0);
    await expect(next).resolves.toBe('node');
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it('执行器在挂起目录读取时及时 aborted/block,迟到结果不启动脚本', async () => {
    const read = deferred<string[]>();
    const started = deferred<void>();
    readdir.mockImplementation(() => {
      started.resolve();
      return read.promise;
    });
    const pathChild = child();
    spawn.mockReturnValueOnce(pathChild);
    const cwd = path.join(tmpdir(), 'node-runtime-executor-abort');
    const controller = new AbortController();
    const pending = executePreRunHook({
      command: 'node "must-not-run.mjs"', cwd,
      signal: controller.signal, stdinPayload: stdinPayload(cwd),
    });
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(1), { interval: 10, timeout: 5_000 });
    pathChild.emit('close', 1);
    await started.promise;
    controller.abort();

    await expect(pending).resolves.toMatchObject({
      status: 'aborted', decision: 'block', exitCode: null,
    });
    expect(spawn).toHaveBeenCalledTimes(1);
    read.resolve([]);
    await Promise.resolve();
    await Promise.resolve();
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('执行器在挂起目录读取时及时 timed_out/block,迟到结果不启动脚本', async () => {
    const read = deferred<string[]>();
    const started = deferred<void>();
    readdir.mockImplementation(() => {
      started.resolve();
      return read.promise;
    });
    const pathChild = child();
    spawn.mockReturnValueOnce(pathChild);
    const cwd = path.join(tmpdir(), 'node-runtime-executor-timeout');
    const pending = executePreRunHook({
      command: 'node "must-not-run.mjs"', cwd, timeoutMs: 2_000,
      stdinPayload: stdinPayload(cwd),
    });
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(1), { interval: 10, timeout: 5_000 });
    pathChild.emit('close', 1);
    await started.promise;

    await expect(pending).resolves.toMatchObject({
      status: 'timed_out', decision: 'block', exitCode: null, timedOut: true,
    });
    expect(spawn).toHaveBeenCalledTimes(1);
    read.resolve([]);
    await Promise.resolve();
    await Promise.resolve();
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('缓存按 LRU 淘汰最久未使用的 cwd,容量不超过 32', async () => {
    const options = {
      env: {}, home: tmpdir(), readVersions: () => [], probeExecutable: async () => false,
    };
    const cwd = (index: number) => path.join(tmpdir(), `node-runtime-lru-${index}`);
    for (let index = 0; index < 32; index += 1) {
      const pathChild = child();
      spawn.mockReturnValueOnce(pathChild);
      const result = resolveSystemNodeInterpreter({ ...options, forceProbe: true, cwd: cwd(index) });
      pathChild.emit('close', 0);
      await expect(result).resolves.toBe('node');
    }
    await expect(resolveSystemNodeInterpreter({ ...options, cwd: cwd(0) })).resolves.toBe('node');

    const newest = child();
    spawn.mockReturnValueOnce(newest);
    const added = resolveSystemNodeInterpreter({ ...options, forceProbe: true, cwd: cwd(32) });
    newest.emit('close', 0);
    await expect(added).resolves.toBe('node');
    expect(spawn).toHaveBeenCalledTimes(33);

    const evicted = child();
    spawn.mockReturnValueOnce(evicted);
    const reprobe = resolveSystemNodeInterpreter({ ...options, cwd: cwd(1) });
    evicted.emit('close', 0);
    await expect(reprobe).resolves.toBe('node');
    expect(spawn).toHaveBeenCalledTimes(34);
    await expect(resolveSystemNodeInterpreter({ ...options, cwd: cwd(0) })).resolves.toBe('node');
    expect(spawn).toHaveBeenCalledTimes(34);
  });
});
