/**
 * pi-background-commands-race.test.ts
 * ---------------------------------------------------------------------------
 * 启动 / 停止的窗口竞态（维护者 review 指定的定向覆盖）。
 *
 * 真实 `spawn` 的时序不可控，所以要复现「用户点停止时进程还没起完」这个窗口，必须自己
 * 掌握 `'spawn'` 事件的到达时刻：这里用假的 `child_process.spawn` 把窗口拉成可读的
 * 状态机，再断言完成后的 post-spawn 复查确实收口。
 *
 * 覆盖：
 *   ① 停止落在**日志创建 / spawn 事件到达之前**（记录已占位、子进程还不存在）：
 *      旧实现会放行并发出 running 帧、进程继续跑；现在应当在 spawn 到达时立即 SIGKILL，
 *      记录当场销账，且**不发** running 帧。
 *   ② 停止落在**spawn 之后、回执交付之前**：这是正常的运行态停止，进程必须被杀掉并
 *      按 stopped 收口（回执仍会交付给模型，终态随后到达）。
 */

import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { PassThrough } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface FakeEntry {
  killed: boolean;
  /** 让假进程「退出」并把 exit 事件发给 manager(信号路径唯一入口)。 */
  exitNow: (code: number) => void;
  /** 控制 'spawn' 事件到达的时刻:窗口竞态的复现开关。 */
  emitSpawn: () => void;
  /** 收到信号但故意不退出:用来复现「已收口、进程仍未确认退出」的残留窗口。 */
  holdKill: boolean;
}

const fake = vi.hoisted(() => ({
  pending: [] as FakeEntry[],
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: () => {
      const child = new EventEmitter() as EventEmitter & Record<string, unknown>;
      // 一个不可能存在的 pid:任何真实信号路径都不会误伤别的进程。
      child.pid = 2_147_483_600;
      child.exitCode = null;
      child.signalCode = null;
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.stdin = new PassThrough();
      let exited = false;
      const entry: FakeEntry = {
        killed: false,
        holdKill: false,
        emitSpawn: () => child.emit('spawn'),
        exitNow: (code: number) => {
          if (exited || entry.holdKill) return;
          exited = true;
          entry.killed = true;
          child.exitCode = code;
          child.emit('exit', code, null);
          // 管道随之关闭:否则 manager 会等 STREAM_FLUSH_MS 的兜底窗口才收口
          // (真实子进程被 SIGKILL 后 stdio 也会立刻关闭)。
          (child.stdout as PassThrough).end();
          (child.stderr as PassThrough).end();
        },
      };
      child.kill = () => {
        entry.exitNow(0);
        return true;
      };
      fake.pending.push(entry);
      return child;
    },
    // taskkill /T /F(Windows 路径):不真的执行,只把「进程被杀」同步反馈给假 child。
    spawnSync: () => {
      fake.pending.at(-1)?.exitNow(1);
      return { status: 0, error: undefined, pid: 1, output: [], signal: null, stdout: null, stderr: null };
    },
  };
});

import {
  PiBackgroundCommands,
  type PiBackgroundCommandUpdate,
} from '../pi-background-commands.js';

const NODE_EVAL_SHELL = {
  shell: process.execPath,
  args: ['-e'],
  commandTransport: 'standard' as const,
};

const roots: string[] = [];
const managers: PiBackgroundCommands[] = [];

function makeManager(): {
  manager: PiBackgroundCommands;
  updates: PiBackgroundCommandUpdate[];
  logDir: string;
  fakeEntry: () => FakeEntry;
} {
  const root = mkdtempSync(path.join(tmpdir(), 'pi-bg-race-'));
  roots.push(root);
  const updates: PiBackgroundCommandUpdate[] = [];
  const manager = new PiBackgroundCommands({
    env: process.env,
    defaultCwd: process.cwd(),
    logDir: path.join(root, 'logs'),
    onUpdate: (update) => updates.push(update),
  });
  managers.push(manager);
  return { manager, updates, logDir: path.join(root, 'logs'), fakeEntry: () => fake.pending.at(-1)! };
}

/** 等一个条件成立(标记写/撤都是异步的 best-effort)。 */
async function waitFor(predicate: () => boolean, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && !predicate()) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** 等运行表清空:管道的 'end' 是下一个 tick 才到,收口不是同步的。 */
async function waitForEmptyList(manager: PiBackgroundCommands, deadlineMs = 3_000): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline && manager.list().length > 0) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** 等到假 spawn 被调用(即 start() 已经越过日志创建、卡在等 'spawn' 上)。 */
async function waitForPending(deadlineMs = 4_000): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline && fake.pending.length === 0) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(fake.pending.length).toBeGreaterThan(0);
}

let killSpy: ReturnType<typeof vi.spyOn> | null = null;

beforeEach(() => {
  // POSIX 路径的 SIGTERM/SIGKILL 走 process.kill(负 pid):同样只在假进程上生效,
  // 真正发信号的实现被替换掉,测试因此与平台无关。
  killSpy = vi.spyOn(process, 'kill').mockImplementation((() => {
    fake.pending.at(-1)?.exitNow(1);
    return true;
  }) as unknown as typeof process.kill);
});

afterEach(async () => {
  killSpy?.mockRestore();
  killSpy = null;
  await Promise.all(managers.splice(0).map((manager) => manager.dispose().catch(() => undefined)));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  fake.pending.length = 0;
});

describe('PI background command start/stop race', () => {
  it('停止落在 spawn 事件到达之前:进程被杀、记录销账、不发 running 帧', async () => {
    const { manager, updates, fakeEntry } = makeManager();
    const starting = manager.start({
      taskId: 'race-before-spawn',
      command: 'setInterval(function () {}, 1000);',
      shell: NODE_EVAL_SHELL,
    });
    await waitForPending();
    // 此刻记录已在运行表里(同步占位),但子进程还不存在:停止只能空打 ——
    // 这正是「点了停止却报停止未确认」的窗口。
    const stopOutcome = manager.stop('race-before-spawn');
    // 让 'spawn' 到达:post-spawn 复查必须看到 stopRequested 并收口。
    fake.pending.at(-1)!.emitSpawn();
    await expect(starting).rejects.toThrow(/stopped before it finished starting/i);
    await expect(stopOutcome).resolves.toBe('stopped');
    expect(fakeEntry().killed).toBe(true);
    expect(updates.filter((update) => update.status === 'running')).toEqual([]);
    expect(manager.list()).toEqual([]);
  });

  it('停止落在 spawn 之后、回执交付之前:进程被杀并按 stopped 收口', async () => {
    const { manager, updates, fakeEntry } = makeManager();
    const starting = manager.start({
      taskId: 'race-after-spawn',
      command: 'setInterval(function () {}, 1000);',
      shell: NODE_EVAL_SHELL,
    });
    await waitForPending();
    fake.pending.at(-1)!.emitSpawn();
    // 回执(start 的 resolve)与 running 帧都先落地,模型拿到 taskId 之后用户才点停止。
    await expect(starting).resolves.toMatchObject({ taskId: 'race-after-spawn' });
    expect(updates.some((update) => update.status === 'running')).toBe(true);

    await expect(manager.stop('race-after-spawn')).resolves.toBe('stopped');
    expect(fakeEntry().killed).toBe(true);
    await waitForEmptyList(manager);
    expect(manager.list()).toEqual([]);
  });

  it('归属标记跟着「本实例还有没有进程在这个目录里」走', async () => {
    const { manager, logDir } = makeManager();
    const marker = path.join(logDir, `owner-${process.pid}.json`);
    const starting = manager.start({
      taskId: 'race-owner',
      command: 'setInterval(function () {}, 1000);',
      shell: NODE_EVAL_SHELL,
    });
    await waitForPending();
    fake.pending.at(-1)!.emitSpawn();
    await starting;
    expect(existsSync(marker)).toBe(true);
    expect(readFileSync(marker, 'utf8')).toContain(String(process.pid));

    // 进程收不到信号(顽固):dispose 已按 stopped 对 UI 收口,但进程还没确认退出 ——
    // 它可能仍在写日志,所以标记必须留着,不能让另一个实例把目录删掉。
    fake.pending.at(-1)!.holdKill = true;
    await manager.dispose();
    expect(manager.pendingKillCount).toBe(1);
    expect(existsSync(marker)).toBe(true);

    // 进程真退出:最后一个占用者销账,标记撤销。
    fake.pending.at(-1)!.holdKill = false;
    fake.pending.at(-1)!.exitNow(1);
    await waitFor(() => manager.pendingKillCount === 0);
    await waitFor(() => !existsSync(marker));
    expect(existsSync(marker)).toBe(false);
  });
});
