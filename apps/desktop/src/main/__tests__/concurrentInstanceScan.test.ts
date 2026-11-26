import { afterEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';

const logged = vi.hoisted(() => [] as Array<{ message: string; meta?: unknown }>);

vi.mock('../logger.js', () => ({
  createLogger: () => ({
    trace: () => {},
    debug: () => {},
    info: (message: string, meta?: unknown) => { logged.push({ message, meta }); },
    warn: () => {},
    error: () => {},
    fatal: () => {},
  }),
}));

import {
  findConcurrentLiveInstancePids,
  hasFreshStaleProcessProof,
  processProofKey,
  type ConcurrentInstanceScanDeps,
} from '../concurrentInstanceScan.js';

// Tier unit: verifies stale PID-reuse proof lifetime, revocation, log deduplication, and
// bounded deletion of proven-stale registry records via the real scan entry.
function makeDeps(opts: {
  raw?: string;
  lockTarget?: string;
  lockMtimeMs?: number;
  readProcessIdentity: ConcurrentInstanceScanDeps['readProcessIdentity'];
  unlink?: ConcurrentInstanceScanDeps['unlink'];
}): ConcurrentInstanceScanDeps {
  const enoent = () => Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  return {
    readdir: async () => (opts.raw !== undefined ? ['4242.json'] : []),
    readFile: async () => {
      if (opts.raw === undefined) throw enoent();
      return opts.raw;
    },
    readlink: async () => {
      if (opts.lockTarget === undefined) throw enoent();
      return opts.lockTarget;
    },
    lstat: async () => ({
      isDirectory: () => false,
      isFile: () => false,
      isSymbolicLink: () => true,
      mtimeMs: opts.lockMtimeMs,
    }),
    selfPid: () => 99999,
    isPidAlive: (pid) => pid === 4242,
    readProcessIdentity: opts.readProcessIdentity,
    ...(opts.unlink ? { unlink: opts.unlink } : {}),
  };
}

afterEach(() => {
  logged.length = 0;
  vi.useRealTimers();
});

describe('concurrentInstanceScan stale PID proof & log deduplication', () => {
  it('logs stale registry PID reuse once per fingerprint, holds proof for 60s, and ignores null discovery probes', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000_000);
    const userDataDir = '/tmp/cindy-stale-proof-registry';
    const raw = JSON.stringify({ pid: 4242, userDataDir, startedAtMs: 1_000_000, rootDir: '/Applications/Cindy.app' });
    const proofKey = processProofKey(userDataDir, 'registry', `4242.json\u0000${raw}`);
    const nonCindy = () => ({ startedAtMs: 5_000_000, command: '/usr/libexec/microstackshot' });

    expect(await findConcurrentLiveInstancePids(makeDeps({ raw, readProcessIdentity: nonCindy }), userDataDir)).toEqual([]);
    expect(hasFreshStaleProcessProof(proofKey)).toBe(true);
    expect(logged).toHaveLength(1);

    // Proof stays fresh past the old 10s window (still fresh at 59s, expires at 60s).
    vi.advanceTimersByTime(59_000);
    expect(hasFreshStaleProcessProof(proofKey)).toBe(true);

    // Host-style null discovery pass followed by resolved identity pass does not re-log the same stale record.
    expect(await findConcurrentLiveInstancePids(makeDeps({ raw, readProcessIdentity: () => null }), userDataDir)).toEqual([4242]);
    expect(await findConcurrentLiveInstancePids(makeDeps({ raw, readProcessIdentity: nonCindy }), userDataDir)).toEqual([]);
    expect(logged).toHaveLength(1);

    // Proof expires after 60s without refresh.
    vi.advanceTimersByTime(60_000);
    expect(hasFreshStaleProcessProof(proofKey)).toBe(false);
    // Re-proving the exact same immutable record refreshes the proof without spamming INFO logs.
    expect(await findConcurrentLiveInstancePids(makeDeps({ raw, readProcessIdentity: nonCindy }), userDataDir)).toEqual([]);
    expect(hasFreshStaleProcessProof(proofKey)).toBe(true);
    expect(logged).toHaveLength(1);

    // Observing a real Cindy runtime revokes the stale proof immediately and allows a future reuse to log again.
    const liveCindy = () => ({ startedAtMs: 5_000_000, command: '/Applications/Cindy.app/Contents/MacOS/Cindy' });
    expect(await findConcurrentLiveInstancePids(makeDeps({ raw, readProcessIdentity: liveCindy }), userDataDir)).toEqual([4242]);
    expect(hasFreshStaleProcessProof(proofKey)).toBe(false);
    expect(await findConcurrentLiveInstancePids(makeDeps({ raw, readProcessIdentity: nonCindy }), userDataDir)).toEqual([]);
    expect(logged).toHaveLength(2);
  });

  it('deduplicates stale SingletonLock PID reuse logs and revokes proof if Cindy re-appears', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(20_000_000);
    const userDataDir = '/tmp/cindy-stale-proof-lock';
    const lockTarget = 'host-4242';
    const lockMtimeMs = 1_000_000;
    const proofKey = processProofKey(userDataDir, 'singleton-lock', `${lockTarget}\u0000${lockMtimeMs}`);
    const nonCindy = () => ({ startedAtMs: 5_000_000, command: '/usr/libexec/microstackshot' });

    expect(await findConcurrentLiveInstancePids(
      makeDeps({ lockTarget, lockMtimeMs, readProcessIdentity: nonCindy }),
      userDataDir,
    )).toEqual([]);
    expect(await findConcurrentLiveInstancePids(
      makeDeps({ lockTarget, lockMtimeMs, readProcessIdentity: nonCindy }),
      userDataDir,
    )).toEqual([]);
    expect(hasFreshStaleProcessProof(proofKey)).toBe(true);
    expect(logged).toHaveLength(1);

    const liveCindy = () => ({ startedAtMs: 5_000_000, command: '/Applications/Cindy.app/Contents/MacOS/Cindy' });
    expect(await findConcurrentLiveInstancePids(
      makeDeps({ lockTarget, lockMtimeMs, readProcessIdentity: liveCindy }),
      userDataDir,
    )).toEqual([4242]);
    expect(hasFreshStaleProcessProof(proofKey)).toBe(false);
  });
});

describe('concurrentInstanceScan stale registry record cleanup', () => {
  // 维护者 zkyo 的「Main 进程空转噪音」清单：PID 复用被证死后，残留的 .dev-instances 记录
  // 仍留在盘上，每次扫描都为它重复 readFile / 存活探测 / ps 查证（上游实测 3,206 次/天）。
  // #12917 已把日志去重；这里锁住另一半——证死后就地删除记录（连带 .bak），让后续扫描
  // 的 readdir 里根本不再出现它。
  const userDataDir = '/tmp/cindy-stale-cleanup';
  const raw = JSON.stringify({ pid: 4242, userDataDir, startedAtMs: 1_000_000, rootDir: '/Applications/Cindy.app' });
  const nonCindy = () => ({ startedAtMs: 5_000_000, command: '/usr/libexec/microstackshot' });

  it('deletes a proven-stale registry record and its backup, swallowing unlink failures', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000_000);
    const unlinked: string[] = [];
    const deps = makeDeps({
      raw,
      readProcessIdentity: nonCindy,
      unlink: async (file) => {
        unlinked.push(file);
        // .bak 删失败（只读卷/竞争方）不得影响本轮判定,也不得跳过后续尝试。
        if (file.endsWith('.bak')) throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
      },
    });

    expect(await findConcurrentLiveInstancePids(deps, userDataDir)).toEqual([]);
    expect(unlinked).toEqual([
      path.join(userDataDir, '.dev-instances', '4242.json'),
      path.join(userDataDir, '.dev-instances', '4242.json.bak'),
    ]);
    expect(logged).toHaveLength(1);
  });

  it('never deletes unless provenance definitively proves the record dead', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000_000);
    const unlinked: string[] = [];
    const unlink = async (file: string) => { unlinked.push(file); };

    // 探测不到 provenance（null）：fail closed 按活实例处理,记录必须原地保留。
    expect(await findConcurrentLiveInstancePids(
      makeDeps({ raw, readProcessIdentity: () => null, unlink }),
      userDataDir,
    )).toEqual([4242]);
    expect(unlinked).toEqual([]);

    // PID 其实被新的 Cindy 运行时复用：是活实例,不删。
    const liveCindy = () => ({ startedAtMs: 5_000_000, command: '/Applications/Cindy.app/Contents/MacOS/Cindy' });
    expect(await findConcurrentLiveInstancePids(
      makeDeps({ raw, readProcessIdentity: liveCindy, unlink }),
      userDataDir,
    )).toEqual([4242]);
    expect(unlinked).toEqual([]);
    expect(logged).toHaveLength(0);
  });
});
