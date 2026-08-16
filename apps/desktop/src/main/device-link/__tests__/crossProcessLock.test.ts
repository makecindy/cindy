/**
 * crossProcessLock —— ordinary/advisory 与 security-boundary 两档锁的行为守卫。
 *
 * ordinary 档守旧文件形态、nonce 所有权和轻量 Windows 热路径；strict 档守精确进程身份、
 * malformed fail-closed 与可恢复 reclaim 协议。两档共享路径时还必须互相看见 gate，避免
 * 混版本或不同策略的实例同时进入临界区。测试中的别名只用于保留原 strict 回归组的命名，
 * 新增用例应显式选择对应档位。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

vi.mock('../../logger', () => ({
  createLogger: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));

import {
  __testing,
  withCrossProcessLock as withAdvisoryCrossProcessLock,
  withSecurityBoundaryLock as withCrossProcessLock,
} from '../crossProcessLock';

let dir: string;

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cross-process-lock-'));
});

afterEach(() => {
  __testing.setProcessIdentityProbeOverride(null);
  fs.rmSync(dir, { recursive: true, force: true });
});

/** 造一把「陈旧且 owner 已死」的锁。 */
async function writeStaleLock(lock: string): Promise<void> {
  await fsp.writeFile(lock, JSON.stringify({ pid: 424_242, startedAt: 1 }), 'utf8');
  const old = new Date(Date.now() - 60_000);
  await fsp.utimes(lock, old, old);
}

async function writeStaleStrictLock(lock: string): Promise<void> {
  __testing.setProcessIdentityProbeOverride(async () => ({ status: 'missing' }));
  await fsp.writeFile(
    lock,
    JSON.stringify({
      pid: 424_242,
      startedAt: 1,
      nonce: '00000000-0000-4000-8000-000000000001',
      processStartIdentity: 'start-ms:1',
      state: 'held',
    }),
    'utf8',
  );
  const old = new Date(Date.now() - 60_000);
  await fsp.utimes(lock, old, old);
}

async function writeStaleReclaimGate(lock: string): Promise<void> {
  __testing.setProcessIdentityProbeOverride(async () => ({ status: 'missing' }));
  const gate = `${lock}.reclaim`;
  await fsp.writeFile(
    gate,
    JSON.stringify({ pid: 424_242, startedAt: 1, nonce: 'stale-gate' }),
    'utf8',
  );
  const old = new Date(Date.now() - 60_000);
  await fsp.utimes(gate, old, old);
}

describe('接管陈旧锁', () => {
  it('删得掉 → 接管成功,task 拿到 held=true', async () => {
    const lock = path.join(dir, 'lock');
    await writeStaleLock(lock);

    const status = await withAdvisoryCrossProcessLock(
      lock,
      { label: 'test', waitMs: 200 },
      async (s) => s,
    );

    expect(status).toEqual({ held: true });
  });

  it('锁文件删不掉 → 立刻降级返回,不空转到超时(更不无限循环)', async () => {
    const lock = path.join(dir, 'lock');
    await writeStaleLock(lock);
    const originalRename = fsp.rename;
    let renameAttempts = 0;
    const spy = vi.spyOn(fsp, 'rename').mockImplementation((async (
      from: unknown,
      to: unknown,
    ) => {
      if (from === lock && typeof to === 'string' && to.startsWith(`${lock}.stale-`)) {
        renameAttempts += 1;
        throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
      }
      return (originalRename as (...args: unknown[]) => Promise<unknown>)(from, to);
    }) as typeof fsp.rename);
    try {
      const started = performance.now();
      const status = await withAdvisoryCrossProcessLock(
        lock,
        { label: 'test', waitMs: 5_000 },
        async (s) => s,
      );
      const elapsed = performance.now() - started;

      // 降级(而不是宣称持有):内容写会跳过,清理路径照常执行。
      expect(status).toEqual({ held: false, reason: 'busy' });
      // 不该把 waitMs 熬完,也不该反复重试删除。
      expect(elapsed).toBeLessThan(1_000);
      expect(renameAttempts).toBe(1);
      // 别人的锁没被动过。
      expect(fs.existsSync(lock)).toBe(true);
      expect(fs.existsSync(`${lock}.reclaim`)).toBe(false);
    } finally {
      spy.mockRestore();
    }

    expect(fs.existsSync(lock)).toBe(true);
  });

  it('advisory release leaves no strict recovery artifacts and permits reacquisition', async () => {
    const lock = path.join(dir, 'advisory-lock');
    const gateDir = `${lock}.reclaim.d`;
    const originalRm = fsp.rm;
    let blockedGateDeletes = 0;
    let blockedGateFile: string | null = null;
    let allowBlockedGateDelete = false;
    const rmSpy = vi.spyOn(fsp, 'rm').mockImplementation((async (
      target: unknown,
      options?: unknown,
    ) => {
      if (
        typeof target === 'string'
        && path.dirname(target) === gateDir
        && path.basename(target).startsWith('gate-')
        && path.basename(target).endsWith('.json')
      ) {
        blockedGateFile ??= target;
        if (target === blockedGateFile && !allowBlockedGateDelete) {
          blockedGateDeletes += 1;
          throw Object.assign(new Error('gate temporarily busy'), { code: 'EBUSY' });
        }
      }
      return (originalRm as (...args: unknown[]) => Promise<unknown>)(target, options);
    }) as typeof fsp.rm);

    try {
      await expect(
        withAdvisoryCrossProcessLock(lock, { label: 'first' }, async (s) => s),
      ).resolves.toEqual({ held: true });
      expect(blockedGateDeletes).toBe(3);
      expect(fs.readdirSync(gateDir)).toEqual(expect.arrayContaining([
        expect.stringMatching(/^gate-.*\.json$/),
        expect.stringMatching(/^gate-.*\.json\.released$/),
      ]));
      await expect(
        withAdvisoryCrossProcessLock(lock, { label: 'second' }, async (s) => s),
      ).resolves.toEqual({ held: true });
      expect(blockedGateDeletes).toBeGreaterThan(3);
      expect(fs.readdirSync(gateDir)).toEqual(expect.arrayContaining([
        expect.stringMatching(/^gate-.*\.json$/),
        expect.stringMatching(/^gate-.*\.json\.released$/),
      ]));
      allowBlockedGateDelete = true;
      await expect(
        withAdvisoryCrossProcessLock(lock, { label: 'third' }, async (s) => s),
      ).resolves.toEqual({ held: true });
    } finally {
      rmSpy.mockRestore();
    }

    const artifacts = fs.readdirSync(dir).flatMap((entry) => {
      const candidate = path.join(dir, entry);
      return fs.statSync(candidate).isDirectory()
        ? fs.readdirSync(candidate).map((child) => path.join(entry, child))
        : [entry];
    });
    expect(artifacts).toEqual([]);
  });

  it('keeps the advisory canonical lock as a legacy-readable file', async () => {
    const lock = path.join(dir, 'advisory-lock');

    await withAdvisoryCrossProcessLock(lock, { label: 'shape' }, async (status) => {
      expect(status).toEqual({ held: true });
      expect((await fsp.lstat(lock)).isFile()).toBe(true);
      expect(JSON.parse(await fsp.readFile(lock, 'utf8'))).toMatchObject({
        pid: process.pid,
        nonce: expect.any(String),
      });
    });
  });

  it('does not use strict hard-link publication on the advisory hot path', async () => {
    const lock = path.join(dir, 'advisory-lock');
    const linkSpy = vi.spyOn(fsp, 'link');
    try {
      await expect(
        withAdvisoryCrossProcessLock(lock, { label: 'lightweight' }, async (status) => status),
      ).resolves.toEqual({ held: true });
      expect(linkSpy).not.toHaveBeenCalled();
    } finally {
      linkSpy.mockRestore();
    }
  });

  it('advisory release does not remove a successor with a different nonce', async () => {
    const lock = path.join(dir, 'advisory-lock');
    const successor = {
      pid: process.pid,
      startedAt: Date.now(),
      nonce: '00000000-0000-4000-8000-000000000002',
    };

    await withAdvisoryCrossProcessLock(lock, { label: 'predecessor' }, async (status) => {
      expect(status).toEqual({ held: true });
      await fsp.writeFile(lock, JSON.stringify(successor), 'utf8');
    });

    expect(JSON.parse(await fsp.readFile(lock, 'utf8'))).toEqual(successor);
  });

  it('does not reclaim a stale advisory lock while its owner pid is still alive', async () => {
    const lock = path.join(dir, 'advisory-lock');
    await fsp.writeFile(
      lock,
      JSON.stringify({
        pid: process.pid,
        startedAt: 1,
        nonce: '00000000-0000-4000-8000-000000000003',
      }),
      'utf8',
    );
    const old = new Date(Date.now() - 60_000);
    await fsp.utimes(lock, old, old);

    await expect(
      withAdvisoryCrossProcessLock(
        lock,
        { label: 'live-owner', waitMs: 100 },
        async (status) => status,
      ),
    ).resolves.toEqual({ held: false, reason: 'busy' });
    expect(fs.existsSync(lock)).toBe(true);
  });

  it('recovers a same-process advisory record after release rename fails', async () => {
    const lock = path.join(dir, 'advisory-lock');
    const originalRename = fsp.rename;
    let failedRelease = false;
    const spy = vi.spyOn(fsp, 'rename').mockImplementation((async (
      from: unknown,
      to: unknown,
    ) => {
      if (
        !failedRelease
        && from === lock
        && typeof to === 'string'
        && to.startsWith(`${lock}.release-`)
      ) {
        failedRelease = true;
        throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
      }
      return (originalRename as (...args: unknown[]) => Promise<unknown>)(from, to);
    }) as typeof fsp.rename);
    try {
      await expect(
        withAdvisoryCrossProcessLock(lock, { label: 'first' }, async (status) => status),
      ).resolves.toEqual({ held: true });
      expect(fs.existsSync(lock)).toBe(true);

      await expect(
        withAdvisoryCrossProcessLock(lock, { label: 'second' }, async (status) => status),
      ).resolves.toEqual({ held: true });
    } finally {
      spy.mockRestore();
    }

    expect(fs.existsSync(lock)).toBe(false);
  });

  it('advisory release gate prevents a successor replacement race', async () => {
    const lock = path.join(dir, 'advisory-lock');
    const releaseFirstTask = deferred();
    const firstTaskStarted = deferred();
    const releaseRenameStarted = deferred();
    const allowReleaseRename = deferred();
    const originalRename = fsp.rename;
    let blockedRelease = false;
    const spy = vi.spyOn(fsp, 'rename').mockImplementation((async (
      from: unknown,
      to: unknown,
    ) => {
      if (
        !blockedRelease
        && from === lock
        && typeof to === 'string'
        && to.startsWith(`${lock}.release-`)
      ) {
        blockedRelease = true;
        releaseRenameStarted.resolve();
        await allowReleaseRename.promise;
      }
      return (originalRename as (...args: unknown[]) => Promise<unknown>)(from, to);
    }) as typeof fsp.rename);

    try {
      const first = withAdvisoryCrossProcessLock(
        lock,
        { label: 'first', waitMs: 500 },
        async (status) => {
          expect(status).toEqual({ held: true });
          firstTaskStarted.resolve();
          await releaseFirstTask.promise;
          return status;
        },
      );
      await firstTaskStarted.promise;
      releaseFirstTask.resolve();
      await releaseRenameStarted.promise;

      await fsp.rm(lock, { force: true });
      await fsp.writeFile(
        lock,
        JSON.stringify({
          pid: process.pid,
          startedAt: Date.now(),
          nonce: '00000000-0000-4000-8000-000000000004',
        }),
        'utf8',
      );

      await expect(
        withAdvisoryCrossProcessLock(
          lock,
          { label: 'third', waitMs: 100 },
          async (status) => status,
        ),
      ).resolves.toEqual({ held: false, reason: 'busy' });

      allowReleaseRename.resolve();
      await expect(first).resolves.toEqual({ held: true });
      expect(JSON.parse(await fsp.readFile(lock, 'utf8'))).toMatchObject({
        nonce: '00000000-0000-4000-8000-000000000004',
      });
    } finally {
      allowReleaseRename.resolve();
      releaseFirstTask.resolve();
      spy.mockRestore();
    }
  });

  it('reclaims a crashed reclaim gate before taking over the stale lock', async () => {
    const lock = path.join(dir, 'lock');
    await writeStaleStrictLock(lock);
    await writeStaleReclaimGate(lock);

    const status = await withCrossProcessLock(lock, { label: 'test', waitMs: 500 }, async (s) => s);

    expect(status).toEqual({ held: true });
    expect(fs.existsSync(`${lock}.reclaim`)).toBe(false);
  });

  it.each(['', '{not-json'])('keeps a stale legacy malformed lock fail-closed: %j', async (content) => {
    const lock = path.join(dir, 'lock');
    await fsp.writeFile(lock, content, 'utf8');
    const old = new Date(Date.now() - 60_000);
    await fsp.utimes(lock, old, old);

    await expect(
      withCrossProcessLock(
        lock,
        { label: 'test', waitMs: 100 },
        async (s) => s,
      ),
    ).resolves.toEqual({ held: false, reason: 'busy' });
  });

  it('keeps a stale legacy lock when its pid started before the lock file', async () => {
    const lock = path.join(dir, 'lock');
    await fsp.writeFile(lock, JSON.stringify({ pid: process.pid, startedAt: 1 }), 'utf8');
    const old = new Date(Date.now() - 60_000);
    await fsp.utimes(lock, old, old);

    await expect(
      withCrossProcessLock(lock, { label: 'test', waitMs: 100 }, async (s) => s),
    ).resolves.toEqual({ held: false, reason: 'busy' });
  });

  it('reclaims a lock when the recorded process identity no longer matches the live pid', async () => {
    const lock = path.join(dir, 'lock');
    await fsp.writeFile(lock, '{}', 'utf8');
    await new Promise((resolve) => setTimeout(resolve, 2_100));
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], {
      windowsHide: true,
      stdio: 'ignore',
    });
    try {
      await new Promise<void>((resolve, reject) => {
        child.once('spawn', resolve);
        child.once('error', reject);
      });
      if (!child.pid) throw new Error('child pid missing');
      __testing.setProcessIdentityProbeOverride(async (pid) => ({
        status: 'found',
        identity: { key: `start-ms:${pid + 10_000}`, startedAtMs: pid + 10_000 },
      }));
      // The lock records a process identity that cannot match the live pid's
      // current identity ('start-ms:0' parses to null → never equal). This is
      // the only sound signal for a PID-reuse takeover: a live pid alone is
      // treated as the active holder (fail closed), because a still-running
      // drain/cleanup owner must not be squeezed out.
      await fsp.writeFile(
        lock,
        JSON.stringify({
          pid: child.pid,
          startedAt: 1,
          processStartIdentity: 'start-ms:1',
          nonce: '00000000-0000-4000-8000-000000000001',
          state: 'held',
        }),
        'utf8',
      );
      const old = new Date(Date.now() - 60_000);
      await fsp.utimes(lock, old, old);

      await expect(
        withCrossProcessLock(lock, { label: 'test', waitMs: 1_000 }, async (s) => s),
      ).resolves.toEqual({ held: true });
    } finally {
      child.kill();
    }
  }, 15_000);

  it('reclaims a self-pid lock whose recorded identity was from a reused pid', async () => {
    // A crashed instance left a lock naming our pid, but with the dead
    // instance's process identity. After the OS reuses the pid for us, the
    // identity no longer matches: the exact-identity comparison must win over
    // the self-pid shortcut, or strict callers stay permanently busy.
    const lock = path.join(dir, 'lock');
    __testing.setProcessIdentityProbeOverride(async () => ({
      status: 'found',
      identity: { key: 'start-ms:10000', startedAtMs: 10_000 },
    }));
    await fsp.writeFile(
      lock,
      JSON.stringify({
        pid: process.pid,
        startedAt: 1,
        processStartIdentity: 'start-ms:1',
        nonce: '00000000-0000-4000-8000-000000000001',
        state: 'held',
      }),
      'utf8',
    );
    const old = new Date(Date.now() - 60_000);
    await fsp.utimes(lock, old, old);

    await expect(
      withCrossProcessLock(lock, { label: 'test', waitMs: 1_000 }, async (s) => s),
    ).resolves.toEqual({ held: true });
  }, 15_000);

  it('retries a transient release deletion failure', async () => {
    const lock = path.join(dir, 'lock');
    const originalRm = fsp.rm;
    let failed = false;
    const spy = vi.spyOn(fsp, 'rm').mockImplementation((async (target: unknown, options?: unknown) => {
      if (target === lock && !failed) {
        failed = true;
        throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
      }
      return (originalRm as (...args: unknown[]) => Promise<unknown>)(target, options);
    }) as typeof fsp.rm);
    try {
      await expect(
        withCrossProcessLock(lock, { label: 'test', waitMs: 500 }, async (s) => s),
      ).resolves.toEqual({ held: true });
    } finally {
      spy.mockRestore();
    }
    expect(fs.existsSync(lock)).toBe(false);
  });

  it('recovers a released record after deletion stays unavailable', async () => {
    const lock = path.join(dir, 'lock');
    const originalRename = fsp.rename;
    const spy = vi.spyOn(fsp, 'rename').mockImplementation((async (
      from: unknown,
      to: unknown,
    ) => {
      if (from === lock && typeof to === 'string' && to.startsWith(`${lock}.release-`)) {
        throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' });
      }
      return (originalRename as (...args: unknown[]) => Promise<unknown>)(from, to);
    }) as typeof fsp.rename);
    try {
      await expect(
        withCrossProcessLock(lock, { label: 'test', waitMs: 500 }, async (s) => s),
      ).resolves.toEqual({ held: true });
    } finally {
      spy.mockRestore();
    }
    expect(fs.existsSync(lock)).toBe(true);

    await expect(
      withCrossProcessLock(lock, { label: 'test', waitMs: 500 }, async (s) => s),
    ).resolves.toEqual({ held: true });
  });

  it('retries when a released lock disappears during stale takeover', async () => {
    const lock = path.join(dir, 'lock');
    await fsp.writeFile(
      lock,
      JSON.stringify({
        pid: process.pid,
        startedAt: 1,
        nonce: '00000000-0000-4000-8000-000000000001',
        processStartIdentity: 'start-ms:1',
        state: 'released',
      }),
      'utf8',
    );
    const old = new Date(Date.now() - 60_000);
    await fsp.utimes(lock, old, old);

    const originalRename = fsp.rename;

    let removedByRacingOwner = false;
    const race = vi.spyOn(fsp, 'rename').mockImplementation((async (
      from: unknown,
      to: unknown,
    ) => {
      if (
        !removedByRacingOwner
        && from === lock
        && typeof to === 'string'
        && to.startsWith(`${lock}.reclaim-`)
      ) {
        removedByRacingOwner = true;
        await fsp.rm(lock, { force: true });
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      }
      return (originalRename as (...args: unknown[]) => Promise<unknown>)(from, to);
    }) as typeof fsp.rename);
    try {
      await expect(
        withCrossProcessLock(lock, { label: 'waiter', waitMs: 1_000 }, async (s) => s),
      ).resolves.toEqual({ held: true });
    } finally {
      race.mockRestore();
    }
    expect(removedByRacingOwner).toBe(true);
  });

  it('keeps a stale lock when process liveness cannot be proven', async () => {
    const lock = path.join(dir, 'lock');
    const identity = await __testing.getProcessIdentity(process.pid);
    if (!identity) throw new Error('current process identity unavailable in test');
    await fsp.writeFile(
      lock,
      JSON.stringify({
        pid: process.pid,
        startedAt: 1,
        nonce: 'live-owner',
        processStartIdentity: identity.key,
        state: 'held',
      }),
      'utf8',
    );
    const old = new Date(Date.now() - 60_000);
    await fsp.utimes(lock, old, old);
    const kill = vi.spyOn(process, 'kill').mockImplementation((() => {
      throw Object.assign(new Error('liveness query unavailable'), { code: 'EACCES' });
    }) as typeof process.kill);
    try {
      await expect(
        withCrossProcessLock(
          lock,
          {
            label: 'strict',
            waitMs: 100,
          },
          async (s) => s,
        ),
      ).resolves.toEqual({ held: false, reason: 'busy' });
    } finally {
      kill.mockRestore();
    }
    expect(fs.existsSync(lock)).toBe(true);
  });

  it.each(['unknown-format', 'bogus-state'])('keeps an unverifiable strict record fail-closed: %s', async (value) => {
    const lock = path.join(dir, 'lock');
    const identity = value === 'unknown-format' ? value : undefined;
    await fsp.writeFile(
      lock,
      JSON.stringify({
        pid: process.pid,
        startedAt: 1,
        nonce: '00000000-0000-4000-8000-000000000001',
        ...(identity ? { processStartIdentity: identity } : { state: value }),
      }),
      'utf8',
    );
    const old = new Date(Date.now() - 60_000);
    await fsp.utimes(lock, old, old);

    await expect(
      withCrossProcessLock(
        lock,
        { label: 'strict', waitMs: 100 },
        async (s) => s,
      ),
    ).resolves.toEqual({ held: false, reason: 'busy' });
    expect(fs.existsSync(lock)).toBe(true);
  });

  it.each([
    { label: 'missing nonce', omit: 'nonce' },
    { label: 'null nonce', nonce: null },
    { label: 'unknown nonce', nonce: 'unknown-format' },
    { label: 'missing identity', omit: 'processStartIdentity' },
    { label: 'zero identity', processStartIdentity: 'start-ms:0' },
    { label: 'negative ticks identity', processStartIdentity: '-621355968000000001' },
    { label: 'missing state', omit: 'state' },
  ])('keeps a strict record with $label fail-closed', async (variant) => {
    const lock = path.join(dir, 'lock');
    const identity = await __testing.getProcessIdentity(process.pid);
    if (!identity) throw new Error('current process identity unavailable in test');
    const record: Record<string, unknown> = {
      pid: process.pid,
      startedAt: 1,
      nonce: '00000000-0000-4000-8000-000000000001',
      processStartIdentity: identity.key,
      state: 'held',
    };
    if (variant.omit) delete record[variant.omit];
    if (Object.prototype.hasOwnProperty.call(variant, 'nonce')) record.nonce = variant.nonce;
    if (variant.processStartIdentity !== undefined) {
      record.processStartIdentity = variant.processStartIdentity;
    }
    await fsp.writeFile(lock, JSON.stringify(record), 'utf8');
    const old = new Date(Date.now() - 60_000);
    await fsp.utimes(lock, old, old);

    await expect(
      withCrossProcessLock(
        lock,
        { label: 'strict', waitMs: 100 },
        async (s) => s,
      ),
    ).resolves.toEqual({ held: false, reason: 'busy' });
    expect(fs.existsSync(lock)).toBe(true);
  });

  it('bounds repeated successful stale takeovers by time and count', async () => {
    const lock = path.join(dir, 'lock');
    await writeStaleStrictLock(lock);
    const originalRename = fsp.rename;
    let takeovers = 0;
    const spy = vi.spyOn(fsp, 'rename').mockImplementation((async (
      from: unknown,
      to: unknown,
    ) => {
      const result = await (originalRename as (...args: unknown[]) => Promise<unknown>)(from, to);
      if (from === lock && typeof to === 'string' && to.startsWith(`${lock}.reclaim-`)) {
        takeovers += 1;
        await writeStaleStrictLock(lock);
      }
      return result;
    }) as typeof fsp.rename);
    try {
      const started = performance.now();
      await expect(
        withCrossProcessLock(lock, { label: 'churn', waitMs: 2_000 }, async (s) => s),
      ).resolves.toEqual({ held: false, reason: 'busy' });
      expect(performance.now() - started).toBeLessThan(1_000);
      expect(takeovers).toBe(3);
    } finally {
      spy.mockRestore();
    }
  });

  it('publishes after the final stale takeover when the path stays empty', async () => {
    const lock = path.join(dir, 'lock');
    await writeStaleStrictLock(lock);
    const originalRename = fsp.rename;
    let takeovers = 0;
    const spy = vi.spyOn(fsp, 'rename').mockImplementation((async (
      from: unknown,
      to: unknown,
    ) => {
      const result = await (originalRename as (...args: unknown[]) => Promise<unknown>)(from, to);
      if (from === lock && typeof to === 'string' && to.startsWith(`${lock}.reclaim-`)) {
        takeovers += 1;
        if (takeovers < 3) await writeStaleStrictLock(lock);
      }
      return result;
    }) as typeof fsp.rename);
    try {
      await expect(
        withCrossProcessLock(lock, { label: 'final-takeover', waitMs: 2_000 }, async (s) => s),
      ).resolves.toEqual({ held: true });
      expect(takeovers).toBe(3);
    } finally {
      spy.mockRestore();
    }
  });

  it('retries publication after the final takeover when Windows still reports the path busy', async () => {
    const lock = path.join(dir, 'lock');
    await writeStaleStrictLock(lock);
    const originalRename = fsp.rename;
    const originalLink = fsp.link;
    let takeovers = 0;
    let busyPublishes = 0;
    const renameSpy = vi.spyOn(fsp, 'rename').mockImplementation((async (
      from: unknown,
      to: unknown,
    ) => {
      const result = await (originalRename as (...args: unknown[]) => Promise<unknown>)(from, to);
      if (from === lock && typeof to === 'string' && to.startsWith(`${lock}.reclaim-`)) {
        takeovers += 1;
        if (takeovers < 3) await writeStaleStrictLock(lock);
      }
      return result;
    }) as typeof fsp.rename);
    const linkSpy = vi.spyOn(fsp, 'link').mockImplementation((async (
      from: unknown,
      to: unknown,
    ) => {
      if (to === lock && takeovers === 3 && busyPublishes < 1) {
        busyPublishes += 1;
        throw Object.assign(new Error('resource busy'), { code: 'EBUSY' });
      }
      return (originalLink as (...args: unknown[]) => Promise<unknown>)(from, to);
    }) as typeof fsp.link);
    try {
      await expect(
        withCrossProcessLock(lock, { label: 'final-takeover-busy', waitMs: 2_000 }, async (s) => s),
      ).resolves.toEqual({ held: true });
      expect(takeovers).toBe(3);
      expect(busyPublishes).toBe(1);
    } finally {
      renameSpy.mockRestore();
      linkSpy.mockRestore();
    }
  });

  it('recovers an own reclaim gate after rename and fsync both fail', async () => {
    const lock = path.join(dir, 'lock');
    const originalOpen = fsp.open;
    const originalRename = fsp.rename;
    const openSpy = vi.spyOn(fsp, 'open').mockImplementation((async (...args: any[]) => {
      const handle = await (originalOpen as (...inner: any[]) => Promise<any>)(...args);
      const file = args[0];
      if (typeof file === 'string' && file.startsWith(`${lock}.reclaim.candidate-`)) {
        const originalSync = handle.sync.bind(handle);
        let syncCount = 0;
        handle.sync = async () => {
          syncCount += 1;
          if (syncCount >= 2) throw Object.assign(new Error('fsync unavailable'), { code: 'EIO' });
          return originalSync();
        };
      }
      return handle;
    }) as typeof fsp.open);
    const renameSpy = vi.spyOn(fsp, 'rename').mockImplementation((async (
      from: unknown,
      to: unknown,
    ) => {
      if (from === `${lock}.reclaim` && typeof to === 'string' && to.startsWith(`${lock}.reclaim.release-`)) {
        throw Object.assign(new Error('rename unavailable'), { code: 'EBUSY' });
      }
      return (originalRename as (...args: unknown[]) => Promise<unknown>)(from, to);
    }) as typeof fsp.rename);
    try {
      await expect(
        withCrossProcessLock(lock, { label: 'test', waitMs: 500 }, async (s) => s),
      ).resolves.toEqual({ held: true });
    } finally {
      renameSpy.mockRestore();
      openSpy.mockRestore();
    }

    await expect(
      withCrossProcessLock(lock, { label: 'test', waitMs: 500 }, async (s) => s),
    ).resolves.toEqual({ held: true });
    expect(fs.existsSync(`${lock}.reclaim`)).toBe(false);
  });

  it('keeps a successor protected while the previous owner is releasing', async () => {
    const lock = path.join(dir, 'lock');
    const releaseFirstTask = deferred();
    const firstTaskStarted = deferred();
    const releaseRenameStarted = deferred();
    const allowReleaseRename = deferred();
    const secondTaskStarted = deferred();
    const releaseSecondTask = deferred();
    const originalRename = fsp.rename;
    let blockedRelease = false;
    const spy = vi.spyOn(fsp, 'rename').mockImplementation((async (
      from: unknown,
      to: unknown,
    ) => {
      if (
        !blockedRelease
        && from === lock
        && typeof to === 'string'
        && to.startsWith(`${lock}.release-`)
      ) {
        blockedRelease = true;
        releaseRenameStarted.resolve();
        await allowReleaseRename.promise;
      }
      return (originalRename as (...args: unknown[]) => Promise<unknown>)(from, to);
    }) as typeof fsp.rename);

    try {
      const first = withCrossProcessLock(
        lock,
        { label: 'first', waitMs: 500 },
        async (status) => {
          expect(status).toEqual({ held: true });
          firstTaskStarted.resolve();
          await releaseFirstTask.promise;
          return status;
        },
      );
      await firstTaskStarted.promise;
      releaseFirstTask.resolve();
      await releaseRenameStarted.promise;

      await expect(
        withCrossProcessLock(lock, { label: 'second', waitMs: 100 }, async (s) => s),
      ).resolves.toEqual({ held: false, reason: 'busy' });

      allowReleaseRename.resolve();
      await expect(first).resolves.toEqual({ held: true });

      const second = withCrossProcessLock(
        lock,
        { label: 'second', waitMs: 500 },
        async (status) => {
          expect(status).toEqual({ held: true });
          secondTaskStarted.resolve();
          await releaseSecondTask.promise;
          return status;
        },
      );
      await secondTaskStarted.promise;

      await expect(
        withCrossProcessLock(lock, { label: 'third', waitMs: 100 }, async (s) => s),
      ).resolves.toEqual({ held: false, reason: 'busy' });

      releaseSecondTask.resolve();
      await expect(second).resolves.toEqual({ held: true });
    } finally {
      allowReleaseRename.resolve();
      releaseFirstTask.resolve();
      releaseSecondTask.resolve();
      spy.mockRestore();
    }
  });

  it('does not remove a successor after the predecessor path disappeared', async () => {
    const lock = path.join(dir, 'lock');
    const firstTaskStarted = deferred();
    const releaseFirstTask = deferred();
    const secondTaskStarted = deferred();
    const releaseSecondTask = deferred();

    const first = withCrossProcessLock(
      lock,
      { label: 'first', waitMs: 500 },
      async (status) => {
        expect(status).toEqual({ held: true });
        firstTaskStarted.resolve();
        await releaseFirstTask.promise;
        return status;
      },
    );
    await firstTaskStarted.promise;
    await fsp.rm(lock, { force: true });

    const second = withCrossProcessLock(
      lock,
      { label: 'second', waitMs: 500 },
      async (status) => {
        expect(status).toEqual({ held: true });
        secondTaskStarted.resolve();
        await releaseSecondTask.promise;
        return status;
      },
    );
    await secondTaskStarted.promise;

    releaseFirstTask.resolve();
    await expect(first).resolves.toEqual({ held: true });
    await expect(
      withCrossProcessLock(lock, { label: 'third', waitMs: 100 }, async (s) => s),
    ).resolves.toEqual({ held: false, reason: 'busy' });

    releaseSecondTask.resolve();
    await expect(second).resolves.toEqual({ held: true });
  });

  it('recovers a main lock left held when release marking and gate publication fail', async () => {
    const lock = path.join(dir, 'lock');
    const originalOpen = fsp.open;
    const openSpy = vi.spyOn(fsp, 'open').mockImplementation((async (...args: any[]) => {
      const file = args[0];
      if (typeof file === 'string' && file.startsWith(`${lock}.reclaim.candidate-`)) {
        throw Object.assign(new Error('gate unavailable'), { code: 'EIO' });
      }
      const handle = await (originalOpen as (...inner: any[]) => Promise<any>)(...args);
      if (typeof file === 'string' && file.startsWith(`${lock}.candidate-`)) {
        handle.write = async () => {
          throw Object.assign(new Error('release write unavailable'), { code: 'EIO' });
        };
      }
      return handle;
    }) as typeof fsp.open);
    try {
      await expect(
        withCrossProcessLock(lock, { label: 'first', waitMs: 500 }, async (s) => s),
      ).resolves.toEqual({ held: true });
      expect(JSON.parse(await fsp.readFile(lock, 'utf8')).state).toBe('held');

      await expect(
        withCrossProcessLock(lock, { label: 'second', waitMs: 500 }, async (s) => s),
      ).resolves.toEqual({ held: true });
    } finally {
      openSpy.mockRestore();
    }
  });

  it('keeps strict acquisition available when current-process identity commands fail', async () => {
    const identity = await __testing.readProcessIdentity(
      process.pid,
      async () => {
        throw new Error('identity command unavailable');
      },
    );

    expect(identity?.startedAtMs).toEqual(expect.any(Number));
    expect(identity?.key).toMatch(/^start-ms:\d+$/);
  });

  it('does not invent an identity for another process when OS queries fail', async () => {
    await expect(
      __testing.readProcessIdentity(
        0x7ffffffe,
        async () => {
          throw new Error('identity command unavailable');
        },
      ),
    ).resolves.toBeNull();
  });

  it('distinguishes a missing Windows process from an unavailable identity query', async () => {
    await expect(
      __testing.readWindowsIdentityWithPowershell(
        123,
        async () => ({ stdout: 'MISSING\r\n' }),
      ),
    ).resolves.toEqual({ status: 'missing' });
    await expect(
      __testing.readWindowsIdentityWithPowershell(
        123,
        async () => ({ stdout: 'unexpected output' }),
      ),
    ).resolves.toEqual({ status: 'unavailable' });
    await expect(
      __testing.readWindowsIdentityWithWmic(
        123,
        async () => ({ stdout: 'No Instance(s) Available.\r\n' }),
      ),
    ).resolves.toEqual({ status: 'missing' });
    await expect(
      __testing.readWindowsIdentityWithWmic(
        123,
        async () => ({ stdout: 'ERROR: provider unavailable\r\n' }),
      ),
    ).resolves.toEqual({ status: 'unavailable' });
    await expect(
      __testing.probeProcessIdentity(
        123,
        async () => ({ stdout: '' }),
      ),
    ).resolves.toEqual({ status: 'unavailable' });
  });

  it('retries transient empty-directory removal without recursive deletion', async () => {
    const gateDir = path.join(dir, 'lock.reclaim.d');
    await fsp.mkdir(gateDir);
    const originalRmdir = fsp.rmdir;
    let attempts = 0;
    const rmdirSpy = vi.spyOn(fsp, 'rmdir').mockImplementation((async (target: unknown) => {
      if (target === gateDir && attempts < 2) {
        attempts += 1;
        throw Object.assign(new Error('directory temporarily busy'), { code: 'EPERM' });
      }
      return originalRmdir(target as string);
    }) as typeof fsp.rmdir);
    const rmSpy = vi.spyOn(fsp, 'rm');
    try {
      await __testing.removeEmptyDirectoryWithRetry(gateDir);
      expect(attempts).toBe(2);
      expect(fs.existsSync(gateDir)).toBe(false);
      expect(rmSpy).not.toHaveBeenCalledWith(gateDir, expect.objectContaining({ recursive: true }));
    } finally {
      rmdirSpy.mockRestore();
      rmSpy.mockRestore();
    }
  });
});
