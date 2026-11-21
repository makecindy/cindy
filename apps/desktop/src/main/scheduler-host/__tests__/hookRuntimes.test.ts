import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const spawn = vi.hoisted(() => vi.fn());
const killProcessTree = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ spawn }));
vi.mock('../proc-util', () => ({ killProcessTree }));

import { __resetHookRuntimeCacheForTest, resolveSystemNodeInterpreter } from '../hook-runtimes';

// 测试价值(unit):#5573 评论要求独立发现 fnm/nvm;生产入口为 resolveSystemNodeInterpreter。
// 独立文件隔离模块缓存与 spawn mock,不读取真实用户目录;最小失败输入是 PATH shim exit 1。
describe('resolveSystemNodeInterpreter', () => {
  beforeEach(() => {
    __resetHookRuntimeCacheForTest();
    spawn.mockReset();
    killProcessTree.mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
    __resetHookRuntimeCacheForTest();
  });

  function child() {
    return Object.assign(new EventEmitter(), { pid: 4242, kill: vi.fn(() => true) });
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
});
