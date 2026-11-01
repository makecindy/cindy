import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { Writable } from 'node:stream';
import { afterAll, describe, expect, it, vi } from 'vitest';
// eslint-disable-next-line import/no-relative-packages -- dev 脚本模块,不在 src 下
import { inspectIOSBuildTools, podInstallBounded, runPodInstallOnce, withUserGemPodOnPath } from '../../scripts/sim-pod-install.mjs';

// 这些用例用假的 `pod` 可执行文件真实跑 spawn + 看门狗,覆盖 sim-rebuild pod 层的
// 全部失败模式 —— 尤其是"输出空转 → SIGKILL"(实测过 CDN 连接挂死干等 20 分钟)
// 和"慢但持续有输出的下载不能被误杀"(~90MB prebuilt 产物在慢网络下是合法长任务)。
// shell 假可执行文件依赖 POSIX,Windows 上跳过(脚本本身也只在 macOS 有意义)。
const posixOnly = process.platform === 'win32' ? describe.skip : describe;

const tempDirs: string[] = [];

function fakePod(script: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'sim-pod-test-'));
  tempDirs.push(dir);
  const bin = join(dir, 'pod');
  writeFileSync(bin, `#!/bin/sh\n${script}\n`);
  chmodSync(bin, 0o755);
  return bin;
}

function sink(): Writable {
  return new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
}

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

posixOnly('sim-pod-install bounded runner', () => {
  it('resolves when pod install succeeds', async () => {
    // 空转窗口给得远大于用例本身需要:高负载机器上 spawn 到首行输出可能就要
    // 数秒,窗口太小会把健康进程误判成挂死(CI / 本地并行构建时实测过)。
    const podBin = fakePod('echo ok; exit 0');
    await expect(runPodInstallOnce({
      iosDir: tmpdir(), podBin, idleTimeoutMs: 15_000, stdout: sink(), stderr: sink(),
    })).resolves.toBeUndefined();
  });

  it('SIGKILLs the whole hung process group, including children holding the pipes', { timeout: 15_000 }, async () => {
    // 完全无输出地挂住,且像真实 pod 一样 fork 了继承 stdout/stderr 的子进程
    // (真实场景是 ruby 下面的 curl)。只杀父进程会留下持有管道的孤儿,'close'
    // 永不触发(CI 实测卡到测试超时);必须组杀 + 按 'exit' 结算,秒级收尾。
    const podBin = fakePod('sleep 30 &\nsleep 31');
    const startedAt = Date.now();
    await expect(runPodInstallOnce({
      iosDir: tmpdir(), podBin, idleTimeoutMs: 500, stdout: sink(), stderr: sink(),
    })).rejects.toMatchObject({ idleKilled: true });
    expect(Date.now() - startedAt).toBeLessThan(10_000);
  });

  it('does NOT kill a slow-but-progressing download (output keeps resetting the watchdog)', { timeout: 20_000 }, async () => {
    // 每 100ms 产生一点输出、总时长(~4s)超过 idleTimeoutMs(3s)—— 模拟慢速但
    // 健康的大文件下载,必须跑完而不是被看门狗误杀(总时长必须大于空转窗口,
    // 否则"看门狗被输出重置"就没被证明)。tick 间隔与空转窗口留 30 倍余量,
    // 高负载下的调度抖动不会假性触发。
    const podBin = fakePod('i=0; while [ $i -lt 40 ]; do echo tick; sleep 0.1; i=$((i+1)); done; exit 0');
    await expect(runPodInstallOnce({
      iosDir: tmpdir(), podBin, idleTimeoutMs: 3_000, stdout: sink(), stderr: sink(),
    })).resolves.toBeUndefined();
  });

  it('falls back to --repo-update once when the local-specs attempt fails', async () => {
    // 假 pod:不带 --repo-update 失败,带 --repo-update 成功。
    const podBin = fakePod('case "$*" in *--repo-update*) exit 0;; *) echo miss >&2; exit 1;; esac');
    const warnings: string[] = [];
    await expect(podInstallBounded({
      iosDir: tmpdir(), podBin, idleTimeoutMs: 15_000,
      log: { warn: (message: string) => warnings.push(message) },
    })).resolves.toBeUndefined();
    expect(warnings.join('\n')).toContain('--repo-update');
  });

  it('surfaces a missing CocoaPods binary as podMissing with install guidance', async () => {
    await expect(podInstallBounded({
      iosDir: tmpdir(), podBin: '/nonexistent/pod-not-here', idleTimeoutMs: 2_000, log: { warn: () => {} },
    })).rejects.toMatchObject({ podMissing: true });
  });
});

describe('withUserGemPodOnPath', () => {
  const missing = () => { throw Object.assign(new Error('spawn pod ENOENT'), { code: 'ENOENT' }); };
  const env = { PATH: '/usr/bin' } as unknown as NodeJS.ProcessEnv;
  // 实现用宿主平台的 join/delimiter,测试输入与预期也用同一套,Windows CI 才不会因分隔符失败。
  const gemDir = join('/home/test', '.gem', 'ruby', '2.6.0');
  const gemBin = join(gemDir, 'bin');

  // Regression 2026-11-01: a working user-gem CocoaPods was reported as pod=missing
  // because the Agent PATH omits Gem.user_dir/bin, and tasks asked to install Homebrew.
  it('appends the user gem bin when pod is only installed there, without shadowing PATH', () => {
    const run = vi.fn((command: string) => (command === 'ruby' ? `${gemDir}\n` : missing()));
    const result = withUserGemPodOnPath({ env, run: run as never, exists: (path) => path === join(gemBin, 'pod') });
    expect(result).toEqual({ PATH: `${env.PATH}${delimiter}${gemBin}` });
    expect(env.PATH).toBe('/usr/bin');
  });

  it('keeps the environment when pod is already on PATH, without asking Ruby', () => {
    const run = vi.fn(() => '1.17.0');
    expect(withUserGemPodOnPath({ env, run: run as never, exists: () => true })).toBe(env);
    expect(run).toHaveBeenCalledOnce();
  });

  it('keeps a broken PATH pod visible instead of masking it with the user gem copy', () => {
    const run = vi.fn(() => { throw Object.assign(new Error('boom'), { status: 1 }); });
    expect(withUserGemPodOnPath({ env, run: run as never, exists: () => true })).toBe(env);
    expect(run).toHaveBeenCalledOnce();
  });

  it.each([
    ['Ruby is unavailable', () => missing(), true],
    ['Ruby prints no directory', () => '', true],
    ['the user gem directory has no pod', () => gemDir, false],
  ])('keeps the environment when %s', (_case, ruby, podExists) => {
    const run = vi.fn((command: string) => (command === 'ruby' ? ruby() : missing()));
    expect(withUserGemPodOnPath({ env, run: run as never, exists: () => podExists })).toBe(env);
  });

  it('lets the preflight find pod through the resolved PATH', () => {
    const run = vi.fn((command: string, _args: string[], options: { env: NodeJS.ProcessEnv }) => {
      if (command === 'ruby') return gemDir;
      if (command === 'pod' && !options.env.PATH?.includes(gemBin)) return missing();
      return '';
    });
    const resolved = withUserGemPodOnPath({ env, run: run as never, exists: () => true });
    expect(inspectIOSBuildTools({ env: resolved, run: run as never }).healthy).toBe(true);
    expect(inspectIOSBuildTools({ env, run: run as never }).checks.at(-1)).toEqual({ tool: 'pod', healthy: false, code: 'missing' });
  });
});
