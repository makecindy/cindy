import { afterEach, describe, expect, it, vi } from 'vitest';

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

// Tier unit: verifies stale PID-reuse proof lifetime, revocation, and log deduplication via real scan entry.
function makeDeps(opts: {
  raw?: string;
  lockTarget?: string;
  lockMtimeMs?: number;
  readProcessIdentity: ConcurrentInstanceScanDeps['readProcessIdentity'];
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
