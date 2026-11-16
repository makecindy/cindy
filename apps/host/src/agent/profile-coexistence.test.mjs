/*
 * 测试价值
 * - 生产入口：profile-coexistence.ts 的 createDesktopScanner（启动和运行中重扫共用，内部是桌面的
 *   findConcurrentLiveInstancePids）与 createCoexistenceMonitor（10 秒一次加目录监听，main.ts 据此关、开闸门）。
 * - 规则：并存方案 A（审核方 2026-11-17 定）。开库的桌面挡住 Host：没有 `runtime` 字段的旧记录按开库处理，
 *   `runtime: 'client'` 与 `passive: true` 放行；只在 SingletonLock 里出现的 PID 也挡；进程已结束的残留和
 *   PID 被复用的记录不挡。同一份记录只问一次进程身份。闸门遇到桌面立刻关，连续两次干净扫描才报可开，
 *   扫描失败按有桌面处理。
 * - 现有覆盖缺口：桌面的 ownerNamespaceMigration.test.ts 只测这个扫描在迁移里的用法，不测 runtime / passive
 *   的放行，也没有重扫和闸门状态。
 * - 最小失败输入：一个空转子进程的 PID 加一份记录；监听回调与定时器手动触发。tier：unit（子进程按 PID 结束，
 *   没有 100ms 以上的真实等待）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createCoexistenceMonitor, createDesktopScanner, nodeProfileScanPorts } from './profile-coexistence.ts';

async function liveChild(t) {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1 << 30)'], { stdio: 'ignore' });
  await once(child, 'spawn');
  t.after(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, 'exit');
    child.kill();
    await exited;
  });
  return child;
}

function profile(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-host-coexistence-'));
  fs.mkdirSync(path.join(dir, '.dev-instances'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const write = (pid, fields = {}) => fs.writeFileSync(path.join(dir, '.dev-instances', `${pid}.json`),
    JSON.stringify({ schemaVersion: 1, pid, startedAtMs: Date.now(), userDataDir: dir, state: 'ready', passive: false, ...fields }));
  return { dir, write };
}

/** The real ports, counting the OS identity queries. */
function countingPorts() {
  const asked = [];
  return { asked, ports: { ...nodeProfileScanPorts, readProcessIdentities: async pids => {
    asked.push([...pids]);
    return nodeProfileScanPorts.readProcessIdentities(pids);
  } } };
}

test('a live desktop record blocks, unless it is a Host client or a passive instance', async t => {
  const child = await liveChild(t);
  const p = profile(t);
  const { asked, ports } = countingPorts();
  const scan = createDesktopScanner(p.dir, ports);
  // Written by an older desktop: no `runtime` field. It opens the database.
  p.write(child.pid);
  assert.deepEqual(await scan(), [child.pid]);
  p.write(child.pid, { runtime: 'embedded' });
  assert.deepEqual(await scan(), [child.pid]);
  p.write(child.pid, { runtime: 'client' });
  assert.deepEqual(await scan(), []);
  p.write(child.pid, { passive: true });
  assert.deepEqual(await scan(), []);
  // An unreadable record keeps the PID visible through its file name, and blocks.
  fs.writeFileSync(path.join(p.dir, '.dev-instances', `${child.pid}.json`), '{ torn');
  assert.deepEqual(await scan(), [child.pid]);
  assert.ok(asked.length >= 1);
});

test('the same record asks the OS for its identity once; a changed record asks again', async t => {
  const child = await liveChild(t);
  const p = profile(t);
  const { asked, ports } = countingPorts();
  const scan = createDesktopScanner(p.dir, ports);
  const startedAtMs = Date.now();
  p.write(child.pid, { startedAtMs });
  assert.deepEqual(await scan(), [child.pid]);
  assert.deepEqual(await scan(), [child.pid]);
  assert.deepEqual(await scan(), [child.pid]);
  assert.equal(asked.length, 1, 'three scans of the same record ask once');
  p.write(child.pid, { startedAtMs, state: 'starting' });
  await scan();
  assert.equal(asked.length, 2);
});

test('a record whose process ended, or whose PID now belongs to another program, does not block', async t => {
  const child = await liveChild(t);
  const p = profile(t);
  const scan = createDesktopScanner(p.dir);
  // Recorded an hour before this process started, by a Cindy at another path: the PID was reused.
  p.write(child.pid, { startedAtMs: Date.now() - 3_600_000, rootDir: path.join(p.dir, 'some-other-cindy') });
  assert.deepEqual(await scan(), []);
  p.write(child.pid);
  assert.deepEqual(await scan(), [child.pid]);
  const exited = once(child, 'exit');
  child.kill();
  await exited;
  assert.deepEqual(await scan(), [], 'a leftover record of an ended process');
});

test('a PID seen only through the SingletonLock blocks', { skip: process.platform === 'win32' }, async t => {
  const child = await liveChild(t);
  const p = profile(t);
  fs.symlinkSync(`some-host-${child.pid}`, path.join(p.dir, 'SingletonLock'));
  assert.deepEqual(await createDesktopScanner(p.dir)(), [child.pid]);
});

test('the monitor closes at once, reports clear after two clean scans, and fails closed', async () => {
  const results = [];
  const reports = [];
  const intervals = [];
  const timeouts = [];
  let watched = null;
  const monitor = createCoexistenceMonitor({
    scan: async () => { const next = results.shift(); if (next instanceof Error) throw next; return next ?? []; },
    registryDir: '/registry', onScan: state => reports.push(state), log: { warn() {} },
    timers: {
      setInterval: (fn, ms) => { intervals.push({ fn, ms }); return intervals.length; },
      clearInterval() {},
      setTimeout: (fn, ms) => { timeouts.push({ fn, ms }); return timeouts.length; },
      clearTimeout() {},
    },
    watch: (dir, listener) => { watched = { dir, listener }; return { close() { watched = null; } }; },
  });
  monitor.start();
  assert.equal(intervals[0].ms, 10_000);
  assert.equal(watched.dir, '/registry');

  const settle = async () => { for (let i = 0; i < 20; i += 1) await new Promise(resolve => setImmediate(resolve)); };
  results.push([42]);
  intervals[0].fn(); await settle();
  assert.equal(reports.length, 1, 'the interval scans');
  assert.deepEqual(reports.at(-1), { state: 'desktop-running', desktops: [42] });
  // The desktop restarts: one clean scan in between does not open.
  results.push([]);
  watched.listener(); watched.listener();
  assert.equal(timeouts.length, 2);
  assert.equal(timeouts[1].ms, 250);
  timeouts[1].fn(); await settle();
  assert.equal(reports.length, 2, 'two registry changes, debounced into one scan');
  assert.equal(reports.at(-1).state, 'desktop-running');
  results.push([]);
  await monitor.scanNow();
  assert.deepEqual(reports.at(-1), { state: 'clear', desktops: [] });
  // Clear repeats on each clean scan, so a reopen that waited for a turn is tried again.
  await monitor.scanNow();
  assert.equal(reports.at(-1).state, 'clear');
  // An unreadable registry: in use, with no PIDs.
  results.push(new Error('EACCES'));
  await monitor.scanNow();
  assert.deepEqual(reports.at(-1), { state: 'desktop-running', desktops: [] });
  monitor.stop();
  assert.equal(watched, null);
  const count = reports.length;
  await monitor.scanNow();
  assert.equal(reports.length, count, 'nothing after stop');
});
