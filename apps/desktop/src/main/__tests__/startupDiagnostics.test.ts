/**
 * startupDiagnostics.test.ts
 * ---------------------------------------------------------------------------
 * 覆盖 issue #758 退出尸检核心 RunMarkerStore 的状态机与分析分类:
 *   - begin / heartbeat / markShutdownBegin / markDisposed / markExited 落盘语义
 *   - analyzePreviousRuns 对 exited / shutdown-begin / running / 活进程 / 损坏
 *     标记的分类与清理
 *   - scanCrashDumps 的递归扫描、时间窗过滤与排序
 *
 * 全部走 os.tmpdir 下的临时目录(规则 23:测试不落仓库工作区),electron 仅为
 * 满足模块加载 mock 成空壳 —— 被测核心不依赖它。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => os.tmpdir()),
    getVersion: vi.fn(() => '0.0.0-test'),
  },
  crashReporter: { start: vi.fn() },
}));

vi.mock('../logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { RunMarkerStore, scanCrashDumps, type RunMarker } from '../startup-diagnostics';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xdt-run-markers-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function readMarker(pid: number): RunMarker {
  return JSON.parse(fs.readFileSync(path.join(tmpDir, `run-${pid}.json`), 'utf8')) as RunMarker;
}

function writeMarker(marker: Partial<RunMarker> & { pid: number }): string {
  const file = path.join(tmpDir, `run-${marker.pid}.json`);
  fs.writeFileSync(
    file,
    JSON.stringify({
      version: '0.0.1',
      startedAt: '2026-07-07T10:00:00.000Z',
      heartbeatAt: '2026-07-07T10:05:00.000Z',
      heartbeatIntervalMs: 30_000,
      state: 'running',
      ...marker,
    }),
  );
  return file;
}

function makeStore(opts: { pid?: number; alivePids?: number[]; now?: () => Date } = {}) {
  return new RunMarkerStore({
    dir: tmpDir,
    pid: opts.pid ?? 111,
    version: '0.0.2',
    now: opts.now,
    isPidAlive: (pid) => (opts.alivePids ?? []).includes(pid),
    warn: () => {},
  });
}

describe('RunMarkerStore state machine', () => {
  it('begin() persists a running marker with pid/version/heartbeat', () => {
    const store = makeStore({ pid: 42, now: () => new Date('2026-07-07T12:00:00.000Z') });
    store.begin();

    const m = readMarker(42);
    expect(m.state).toBe('running');
    expect(m.pid).toBe(42);
    expect(m.version).toBe('0.0.2');
    expect(m.startedAt).toBe('2026-07-07T12:00:00.000Z');
    expect(m.heartbeatAt).toBe('2026-07-07T12:00:00.000Z');
    expect(m.heartbeatIntervalMs).toBeGreaterThan(0);
  });

  it('heartbeat() refreshes heartbeatAt without touching state', () => {
    let t = new Date('2026-07-07T12:00:00.000Z');
    const store = makeStore({ pid: 42, now: () => t });
    store.begin();

    t = new Date('2026-07-07T12:00:30.000Z');
    store.heartbeat();

    const m = readMarker(42);
    expect(m.heartbeatAt).toBe('2026-07-07T12:00:30.000Z');
    expect(m.startedAt).toBe('2026-07-07T12:00:00.000Z');
    expect(m.state).toBe('running');
  });

  it('markShutdownBegin records first reason only; markDisposed + markExited finalize', () => {
    const store = makeStore({ pid: 42 });
    store.begin();

    store.markShutdownBegin('before-quit');
    store.markShutdownBegin('uncaughtException'); // 后到的 reason 不覆盖
    expect(readMarker(42).state).toBe('shutdown-begin');
    expect(readMarker(42).shutdownReason).toBe('before-quit');

    store.markDisposed();
    expect(readMarker(42).disposedAt).toBeTruthy();

    store.markExited(0);
    const m = readMarker(42);
    expect(m.state).toBe('exited');
    expect(m.exitCode).toBe(0);
    expect(m.exitedAt).toBeTruthy();
    expect(m.shutdownReason).toBe('before-quit');
  });

  it('markExited without prior shutdown still records exited (forceQuit-like path)', () => {
    const store = makeStore({ pid: 42 });
    store.begin();
    store.markExited(0);
    expect(readMarker(42).state).toBe('exited');
  });
});

describe('analyzePreviousRuns classification', () => {
  it('returns [] on a fresh (non-existent) directory', () => {
    const store = new RunMarkerStore({
      dir: path.join(tmpDir, 'does-not-exist'),
      pid: 111,
      version: '0.0.2',
      isPidAlive: () => false,
      warn: () => {},
    });
    expect(store.analyzePreviousRuns()).toEqual([]);
  });

  it('dead pid + running → abnormal, marker removed', () => {
    const file = writeMarker({ pid: 900, state: 'running' });
    const reports = makeStore().analyzePreviousRuns();

    expect(reports).toHaveLength(1);
    expect(reports[0].kind).toBe('abnormal');
    expect(reports[0].marker?.pid).toBe(900);
    expect(fs.existsSync(file)).toBe(false);
  });

  it('dead pid + shutdown-begin → shutdown-incomplete, marker removed', () => {
    const file = writeMarker({ pid: 901, state: 'shutdown-begin', shutdownReason: 'before-quit' });
    const reports = makeStore().analyzePreviousRuns();

    expect(reports[0].kind).toBe('shutdown-incomplete');
    expect(reports[0].marker?.shutdownReason).toBe('before-quit');
    expect(fs.existsSync(file)).toBe(false);
  });

  it('dead pid + exited + exitCode 0 → clean, marker removed', () => {
    const file = writeMarker({ pid: 902, state: 'exited', exitCode: 0 });
    const reports = makeStore().analyzePreviousRuns();

    expect(reports[0].kind).toBe('clean');
    expect(fs.existsSync(file)).toBe(false);
  });

  it('dead pid + exited + non-zero exitCode → crash-exit, marker removed', () => {
    const file = writeMarker({ pid: 908, state: 'exited', exitCode: 1, shutdownReason: 'render-process-gone:crashed' });
    const reports = makeStore().analyzePreviousRuns();

    expect(reports[0].kind).toBe('crash-exit');
    expect(reports[0].marker?.exitCode).toBe(1);
    expect(fs.existsSync(file)).toBe(false);
  });

  it('alive pid → still-running, marker kept', () => {
    const file = writeMarker({ pid: 903, state: 'running' });
    const reports = makeStore({ alivePids: [903] }).analyzePreviousRuns();

    expect(reports[0].kind).toBe('still-running');
    expect(fs.existsSync(file)).toBe(true);
  });

  it('corrupt marker → corrupt, file removed', () => {
    const file = path.join(tmpDir, 'run-904.json');
    fs.writeFileSync(file, '{"pid": 904, "state"'); // 崩溃瞬间写一半
    const reports = makeStore().analyzePreviousRuns();

    expect(reports[0].kind).toBe('corrupt');
    expect(fs.existsSync(file)).toBe(false);
  });

  it('own-pid marker and non-marker files are skipped', () => {
    writeMarker({ pid: 111, state: 'running' }); // 自己的 pid
    fs.writeFileSync(path.join(tmpDir, 'other.txt'), 'x');
    const reports = makeStore({ pid: 111 }).analyzePreviousRuns();
    expect(reports).toEqual([]);
  });

  it('mixed markers classified independently', () => {
    writeMarker({ pid: 905, state: 'running' });
    writeMarker({ pid: 906, state: 'exited' });
    writeMarker({ pid: 907, state: 'running' });

    const reports = makeStore({ alivePids: [907] }).analyzePreviousRuns();
    const byKind = Object.fromEntries(reports.map((r) => [r.marker?.pid, r.kind]));
    expect(byKind).toEqual({ 905: 'abnormal', 906: 'clean', 907: 'still-running' });
  });
});

// 实测 Windows 用户日志:10-14 写下的标记 pid 被别的进程复用,连续 9 天每次启动都报
// 「another instance appears to be running」,误导「旧进程残留」的排查,真实退出结论也丢了。
describe('resolveReusedPids', () => {
  const markerStartedAt = '2026-07-07T10:00:00.000Z';
  const startTimesOf = (entries: Array<[number, number]>) => async () => new Map(entries);
  const reusedAt = Date.parse('2026-07-16T08:00:00.000Z');

  it('PID 已被更晚启动的进程占用 → 按标记状态补出退出结论并清掉标记', async () => {
    const file = writeMarker({ pid: 2184, state: 'running', startedAt: markerStartedAt });
    const store = makeStore({ alivePids: [2184] });
    const stillRunning = store.analyzePreviousRuns();

    const resolved = await store.resolveReusedPids(stillRunning, startTimesOf([[2184, reusedAt]]));

    expect(resolved).toEqual([
      expect.objectContaining({ kind: 'abnormal', pidReusedSince: '2026-07-16T08:00:00.000Z' }),
    ]);
    expect(fs.existsSync(file)).toBe(false);
  });

  it.each([
    ['PID 已被复用', [[2186, reusedAt]] as Array<[number, number]>],
    ['启动时刻读不到', [] as Array<[number, number]>],
    [
      '占用者仍是旧实例本身',
      [[2186, Date.parse(markerStartedAt) - 1_000]] as Array<[number, number]>,
    ],
  ])('核对前旧实例已正常退出(%s)→ 按重读的 exited 标记判 clean 并清掉标记', async (_label, entries) => {
    writeMarker({ pid: 2186, state: 'running', startedAt: markerStartedAt });
    const store = makeStore({ alivePids: [2186] });
    const stillRunning = store.analyzePreviousRuns();
    const file = writeMarker({ pid: 2186, state: 'exited', exitCode: 0, startedAt: markerStartedAt });

    const resolved = await store.resolveReusedPids(stillRunning, startTimesOf(entries));

    expect(resolved).toEqual([expect.objectContaining({ kind: 'clean' })]);
    expect(fs.existsSync(file)).toBe(false);
  });

  it.each([
    ['启动时刻读不到', [] as Array<[number, number]>],
    [
      '占用者早于标记启动(就是写标记的实例)',
      [[2185, Date.parse(markerStartedAt) - 1_000]] as Array<[number, number]>,
    ],
  ])('%s → 保持 still-running,标记保留', async (_label, entries) => {
    const file = writeMarker({ pid: 2185, state: 'running', startedAt: markerStartedAt });
    const store = makeStore({ alivePids: [2185] });

    const resolved = await store.resolveReusedPids(store.analyzePreviousRuns(), startTimesOf(entries));

    expect(resolved).toEqual([expect.objectContaining({ kind: 'still-running' })]);
    expect(resolved[0].pidReusedSince).toBeUndefined();
    expect(fs.existsSync(file)).toBe(true);
  });
});

describe('scanCrashDumps', () => {
  it('finds nested .dmp files within window, sorted by mtime desc; ignores old and non-dmp', () => {
    const reportsDir = path.join(tmpDir, 'reports');
    fs.mkdirSync(reportsDir, { recursive: true });

    const now = Date.now();
    const fresh1 = path.join(reportsDir, 'a.dmp');
    const fresh2 = path.join(tmpDir, 'b.DMP');
    const stale = path.join(reportsDir, 'old.dmp');
    const noise = path.join(reportsDir, 'meta.txt');
    for (const f of [fresh1, fresh2, stale, noise]) fs.writeFileSync(f, 'x');
    fs.utimesSync(fresh1, new Date(now - 1000), new Date(now - 1000));
    fs.utimesSync(fresh2, new Date(now - 5000), new Date(now - 5000));
    fs.utimesSync(stale, new Date(now - 30 * 24 * 3600 * 1000), new Date(now - 30 * 24 * 3600 * 1000));

    const found = scanCrashDumps(tmpDir, now - 14 * 24 * 3600 * 1000);
    expect(found.map((d) => d.path)).toEqual([fresh1, fresh2]);
  });

  it('returns [] for a missing directory', () => {
    expect(scanCrashDumps(path.join(tmpDir, 'nope'), 0)).toEqual([]);
  });
});
