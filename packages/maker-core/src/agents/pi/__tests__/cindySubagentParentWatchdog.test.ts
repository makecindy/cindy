import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import {
  CINDY_SUBAGENT_PARENT_PID_ENV,
  CINDY_SUBAGENT_PARENT_WATCHDOG_INTERVAL_MS,
  CINDY_SUBAGENT_PARENT_WATCHDOG_SOURCE,
} from '../cindy-subagent-source.js';

/**
 * 父死子亡的**执行级**回归测试。
 *
 * 子代理进程是 Cindy 的孙进程:`PiRpcProcess.close()` 的 SIGTERM/SIGKILL 只打到 pi 父进程,
 * 孙进程会被 init 收养后继续请求模型烧额度(review)。守这条不能只做字符串断言 —— 那类断言
 * 在"看门狗写了但根本不工作"时照样通过。这里把注入的看门狗源码**原样**丢进真进程里跑,
 * 用一个真的假父进程验证两个方向:
 *  - 父进程活着时不能自杀(否则子代理会在正常工作中途消失);
 *  - 父进程被 SIGKILL(最狠的死法,任何父侧钩子都跑不到)后必须自己退出。
 */

const PI_BINARY = process.env.CINDY_TEST_PI_BINARY || path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../../../apps/pi-bin',
  `${process.platform}-${process.arch}`,
  process.platform === 'win32' ? 'pi.exe' : 'pi',
);
const piBinaryAvailable = existsSync(PI_BINARY);

const spawned: ChildProcess[] = [];
const tempDirs: string[] = [];

function track<T extends ChildProcess>(child: T): T {
  spawned.push(child);
  return child;
}

afterEach(async () => {
  for (const child of spawned.splice(0)) {
    try {
      child.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  }
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 已退出返回退出信息,仍在跑返回 null。 */
function exitInfo(child: ChildProcess): { code: number | null } | null {
  return child.exitCode === null && child.signalCode === null ? null : { code: child.exitCode };
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (exitInfo(child)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

function waitForStdout(child: ChildProcess, needle: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let seen = '';
    const timer = setTimeout(() => resolve(false), timeoutMs);
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      seen += chunk;
      if (seen.includes(needle)) {
        clearTimeout(timer);
        resolve(true);
      }
    });
  });
}

/**
 * 写一个只跑看门狗的脚本:装上看门狗,再用一个 ref 住事件循环的长定时器模拟"子代理正在
 * 干活"。这样进程唯一的退出途径就是看门狗本身 —— 它没生效的话进程会一直挂着,测试会失败。
 */
async function writeWatchdogHarness(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'cindy-subagent-watchdog-'));
  tempDirs.push(dir);
  const file = path.join(dir, 'watchdog.mjs');
  await writeFile(
    file,
    `${CINDY_SUBAGENT_PARENT_WATCHDOG_SOURCE}
installParentWatchdog();
const busy = setTimeout(function () {}, 120000);
process.stdout.write('ready\\n');
`,
    'utf8',
  );
  return file;
}

/** 一个什么都不干、只是活着的假父进程。 */
function spawnFakeParent(): ChildProcess {
  return track(
    spawn(process.execPath, ['-e', 'setTimeout(function () {}, 120000)'], { stdio: 'ignore' }),
  );
}

describe('cindy-subagent parent watchdog (executed)', () => {
  it('父进程被强杀后子代理自己退出,不留孤儿烧额度', async () => {
    const file = await writeWatchdogHarness();
    const parent = spawnFakeParent();
    expect(parent.pid).toBeGreaterThan(0);

    const child = track(
      spawn(process.execPath, [file], {
        env: { ...process.env, [CINDY_SUBAGENT_PARENT_PID_ENV]: String(parent.pid) },
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    );
    expect(await waitForStdout(child, 'ready', 10_000)).toBe(true);

    // 方向一:父进程活着期间不能自杀。等足一个轮询周期以上,确认看门狗没有误杀。
    await sleep(CINDY_SUBAGENT_PARENT_WATCHDOG_INTERVAL_MS * 1.5);
    expect(exitInfo(child)).toBeNull();

    // 方向二:SIGKILL 父进程 —— 父侧任何 exit / 信号处理器都跑不到,只剩看门狗能救。
    parent.kill('SIGKILL');
    await waitForExit(parent, 5_000);

    expect(await waitForExit(child, 15_000)).toBe(true);
    expect(child.exitCode).toBe(0);
  }, 40_000);

  /**
   * The durable Subagent child is a *real* Pi process, spawned by the runner
   * with `stdio: ['pipe','pipe','pipe']` and `detached: true`. It loads only
   * `cindy-bridge.ts`, so it carries no parent-pid watchdog — the extension's
   * SIGKILL escalation (runner wedged past its SIGTERM grace) therefore has no
   * hook to reap it, and the durable record goes stale where the sweeps skip it.
   *
   * What actually reaps it is the stdio pipe: killing the runner closes the
   * child's stdin and Pi exits on EOF. That is load-bearing but invisible in
   * the source, so it is asserted here against the real binary. If someone
   * switches the runner's child stdio to `ignore`, or Pi stops exiting on EOF,
   * this fails instead of silently leaking a token-burning orphan.
   */
  it.skipIf(!piBinaryAvailable || process.platform === 'win32')(
    'a real Pi child exits on stdin EOF when its runner is SIGKILLed',
    async () => {
      const dir = await mkdtemp(path.join(tmpdir(), 'cindy-pi-eof-'));
      tempDirs.push(dir);
      const pidFile = path.join(dir, 'pi-pid');
      // Stands in for the runner: same spawn shape, then killed with SIGKILL so
      // no exit handler of its own can run.
      const harness = path.join(dir, 'fake-runner.cjs');
      await writeFile(harness, [
        "'use strict';",
        "const { spawn } = require('node:child_process');",
        "const fs = require('node:fs');",
        `const child = spawn(${JSON.stringify(PI_BINARY)}, ['--mode', 'rpc', '--no-approve', '--no-extensions'], {`,
        "  stdio: ['pipe', 'pipe', 'pipe'],",
        "  detached: process.platform !== 'win32',",
        "  env: Object.assign({}, process.env, { PI_OFFLINE: '1' }),",
        '});',
        'child.stdout.on(\'data\', () => {});',
        'child.stderr.on(\'data\', () => {});',
        `fs.writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));`,
        "process.stdout.write('ready\\n');",
        'setInterval(() => {}, 1000);',
      ].join('\n'));

      const runner = track(spawn(process.execPath, [harness], { stdio: ['ignore', 'pipe', 'pipe'] }));
      expect(await waitForStdout(runner, 'ready', 20_000)).toBe(true);

      const piPid = Number(await readFile(pidFile, 'utf8'));
      expect(Number.isSafeInteger(piPid)).toBe(true);
      // Confirm the child really came up before proving it goes away.
      await sleep(1_000);
      expect(() => process.kill(piPid, 0)).not.toThrow();

      runner.kill('SIGKILL');
      await waitForExit(runner, 10_000);

      let gone = false;
      for (let attempt = 0; attempt < 60; attempt += 1) {
        try {
          process.kill(piPid, 0);
        } catch (error) {
          gone = (error as NodeJS.ErrnoException).code === 'ESRCH';
          if (gone) break;
        }
        await sleep(250);
      }
      if (!gone) {
        try { process.kill(piPid, 'SIGKILL'); } catch { /* cleanup */ }
      }
      expect(gone).toBe(true);
    },
    60_000,
  );

  it('没拿到父 pid 时不装看门狗(不影响独立运行的 pi)', async () => {
    const file = await writeWatchdogHarness();
    const env = { ...process.env };
    delete env[CINDY_SUBAGENT_PARENT_PID_ENV];

    const child = track(spawn(process.execPath, [file], { env, stdio: ['ignore', 'pipe', 'pipe'] }));
    expect(await waitForStdout(child, 'ready', 10_000)).toBe(true);

    // 缺 pid 时看门狗直接 return:进程只受那个 120s 长定时器约束,不该被提前干掉。
    await sleep(CINDY_SUBAGENT_PARENT_WATCHDOG_INTERVAL_MS * 1.5);
    expect(exitInfo(child)).toBeNull();
  }, 30_000);
});
