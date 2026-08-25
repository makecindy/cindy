import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ActiveAppSession } from '../../appSessionState.js';
import {
  bindForgePackStagingTempDir,
  completeForgePackStaging,
  configureForgePackStagingForTests,
  createForgePackStagingController,
  getForgePackStagingController,
  resetForgePackStagingForTests,
  sha256Hex,
  sweepStaleForgePackStagingDirs,
  FORGE_PACK_STAGING_SWEEP_MAX_AGE_MS,
} from '../forgePackStaging.js';

const OWNER_A: ActiveAppSession = {
  mode: 'cloud',
  dataOwnerId: 'user-a',
  generation: 1,
};

const OWNER_B: ActiveAppSession = {
  mode: 'cloud',
  dataOwnerId: 'user-b',
  generation: 2,
};

let tempDir: string | null = null;
const timeouts: Array<{ fire(): void; cancel(): void }> = [];

afterEach(() => {
  for (const timeout of timeouts.splice(0)) timeout.cancel();
  resetForgePackStagingForTests();
  if (tempDir) {
    fs.rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

function makeTempDir(): string {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-forge-staging-'));
  return tempDir;
}

function controller(overrides: Partial<Parameters<typeof createForgePackStagingController>[0]> = {}) {
  const dir = tempDir ?? makeTempDir();
  return createForgePackStagingController({
    getTempDir: () => dir,
    randomId: () => 'unpredictable-token',
    scheduleTimeout: (ms, callback) => {
      let cancelled = false;
      const handle = {
        fire() {
          if (!cancelled) callback();
        },
        cancel() {
          cancelled = true;
        },
      };
      timeouts.push(handle);
      void ms;
      return handle;
    },
    ...overrides,
  });
}

describe('createForgePackStagingController', () => {
  it('writes staging bytes from the in-memory buffer, not a later workdir rewrite', () => {
    const dir = makeTempDir();
    const workdirCopy = path.join(dir, 'author-demo-1.0.0.cindy');
    const buf = Buffer.from('built-from-memory');
    fs.writeFileSync(workdirCopy, buf);
    const staging = controller({
      randomId: (() => {
        let n = 0;
        return () => (n++ === 0 ? 'task-dir-id' : 'ticket-id');
      })(),
    }).stage({
      buf,
      manifestId: 'demo',
      owner: OWNER_A,
      operationKind: 'install',
    });

    fs.writeFileSync(workdirCopy, Buffer.from('agent-replaced-bytes'));
    expect(fs.readFileSync(staging.stagingPath)).toEqual(buf);
    expect(fs.readFileSync(workdirCopy).toString()).toBe('agent-replaced-bytes');
    expect(staging.stagingPath).not.toBe(workdirCopy);
    expect(staging.stagingPath.startsWith(dir)).toBe(true);
    expect(staging.packageSha256).toBe(sha256Hex(buf));
    expect(staging.packageSha256).not.toBe(sha256Hex(Buffer.from('agent-replaced-bytes')));
  });

  it('issues an unguessable ticket bound to owner, kind, staging path, hash, and manifest id', () => {
    const ids: string[] = [];
    const issued = controller({
      randomId: () => {
        const id = `rand-${cryptoRandom()}`;
        ids.push(id);
        return id;
      },
    });
    const staging = issued.stage({
      buf: Buffer.from('pkg'),
      manifestId: 'acme-tool',
      owner: OWNER_A,
      operationKind: 'update',
    });

    expect(ids).toHaveLength(2);
    expect(staging.ticket).toBe(ids[1]);
    expect(staging.ticket).not.toMatch(/^\d+$/);
    expect(staging.ticket).not.toMatch(/T\d{2}:\d{2}/);
    expect(staging.taskDir).toContain(ids[0]);
    expect(issued.peek(staging.ticket)).toMatchObject({
      owner: OWNER_A,
      operationKind: 'update',
      stagingPath: staging.stagingPath,
      packageSha256: sha256Hex(Buffer.from('pkg')),
      manifestId: 'acme-tool',
    });
    expect(issued.peek(staging.ticket)?.packExpiresAt).toEqual(expect.any(Number));
  });

  it('lets peek read the five bound fields from the issuing controller', () => {
    const issued = controller({
      randomId: (() => {
        let n = 0;
        return () => ['task-aaaa', 'ticket-bbbb'][n++] ?? `extra-${n}`;
      })(),
    });
    const staged = issued.stage({
      buf: Buffer.from('pkg'),
      manifestId: 'acme-tool',
      owner: OWNER_A,
      operationKind: 'update',
    });
    expect(issued.peek(staged.ticket)).toMatchObject({
      owner: OWNER_A,
      operationKind: 'update',
      stagingPath: staged.stagingPath,
      packageSha256: sha256Hex(Buffer.from('pkg')),
      manifestId: 'acme-tool',
    });
    expect(issued.peek(staged.ticket)?.packExpiresAt).toEqual(expect.any(Number));
  });

  it('creates an unpredictable 0700 task dir and a 0600 staging file', () => {
    const dir = makeTempDir();
    const issued = controller({
      getTempDir: () => dir,
      randomId: (() => {
        let n = 0;
        return () => ['task-secret', 'ticket-secret'][n++] ?? `x-${n}`;
      })(),
    });
    const staged = issued.stage({
      buf: Buffer.from('pkg'),
      manifestId: 'demo',
      owner: OWNER_A,
      operationKind: 'install',
    });
    expect(path.basename(staged.taskDir)).toBe('cindy-forge-task-secret');
    expect(staged.taskDir.startsWith(dir)).toBe(true);
    if (process.platform !== 'win32') {
      expect(fs.statSync(staged.taskDir).mode & 0o777).toBe(0o700);
      expect(fs.statSync(staged.stagingPath).mode & 0o777).toBe(0o600);
    }
  });

  it('cleans staging and drops the ticket on cancel, timeout, and owner change', () => {
    let clock = 0;
    const pendingTimeouts: Array<() => void> = [];
    const issued = controller({
      now: () => clock,
      ttlMs: 100,
      randomId: (() => {
        let n = 0;
        return () => `id-${n++}`;
      })(),
      scheduleTimeout: (_ms, callback) => {
        pendingTimeouts.push(callback);
        return { cancel: () => {} };
      },
    });
    const first = issued.stage({
      buf: Buffer.from('one'),
      manifestId: 'demo',
      owner: OWNER_A,
      operationKind: 'install',
    });
    expect(fs.existsSync(first.stagingPath)).toBe(true);
    expect(issued.invalidate(first.ticket)).toBe(true);
    expect(fs.existsSync(first.stagingPath)).toBe(false);
    expect(issued.peek(first.ticket)).toBeNull();

    const second = issued.stage({
      buf: Buffer.from('two'),
      manifestId: 'demo',
      owner: OWNER_A,
      operationKind: 'install',
    });
    expect(fs.existsSync(second.stagingPath)).toBe(true);
    pendingTimeouts.at(-1)!();
    expect(fs.existsSync(second.stagingPath)).toBe(false);
    expect(issued.peek(second.ticket)).toBeNull();

    const third = issued.stage({
      buf: Buffer.from('three'),
      manifestId: 'demo',
      owner: OWNER_A,
      operationKind: 'install',
    });
    issued.invalidateMismatchedOwners(OWNER_B);
    expect(fs.existsSync(third.stagingPath)).toBe(false);
    expect(issued.peek(third.ticket)).toBeNull();
  });

  it('does not create directories or files when the module is imported', async () => {
    const dir = makeTempDir();
    const before = fs.readdirSync(dir);
    await import('../forgePackStaging.js');
    expect(fs.readdirSync(dir)).toEqual(before);
  });

  it('stages completeForgePackStaging from buf even when authorCindyPath holds different bytes', () => {
    const dir = makeTempDir();
    configureForgePackStagingForTests({
      getTempDir: () => dir,
      randomId: (() => {
        let n = 0;
        return () => ['task-id', 'ticket-id'][n++] ?? `n-${n}`;
      })(),
      scheduleTimeout: () => ({ cancel() {} }),
    });
    const authorDir = path.join(dir, 'workdir');
    fs.mkdirSync(authorDir, { recursive: true });
    const authorCindyPath = path.join(authorDir, 'demo-1.0.0.cindy');
    const authorBytes = Buffer.from('author-copy-A');
    const memoryBytes = Buffer.from('memory-buf-B');
    fs.writeFileSync(authorCindyPath, authorBytes);

    const completed = completeForgePackStaging({
      buf: memoryBytes,
      manifestId: 'demo',
      owner: OWNER_A,
      operationKind: 'install',
      authorCindyPath,
    });

    expect(fs.readFileSync(completed.installPath)).toEqual(memoryBytes);
    expect(fs.readFileSync(completed.installPath)).not.toEqual(authorBytes);
    expect(completed.installPath).toBe(path.join(dir, 'cindy-forge-task-id', 'package.cindy'));
    expect(completed.agentCindyPath).toBe('demo-1.0.0.cindy');
    expect(path.isAbsolute(completed.agentCindyPath)).toBe(false);
    expect(completed.agentCindyPath.includes(path.sep)).toBe(false);
    expect(completed.installPath).not.toContain('workdir');

    fs.writeFileSync(authorCindyPath, Buffer.from('author-copy-C'));
    expect(fs.readFileSync(completed.installPath)).toEqual(memoryBytes);
  });

  it('sweeps leftover cindy-forge UUID task dirs on restart without following links', () => {
    const dir = makeTempDir();
    const leftover = path.join(dir, 'cindy-forge-aaaaaaaa-bbbb-4ccc-9ddd-eeeeeeeeeeee');
    const keepName = path.join(dir, 'cindy-forge-not-a-uuid');
    const other = path.join(dir, 'unrelated');
    fs.mkdirSync(leftover);
    fs.writeFileSync(path.join(leftover, 'package.cindy'), 'stale');
    const nowMs = 1_700_000_000_000;
    const staleMs = nowMs - FORGE_PACK_STAGING_SWEEP_MAX_AGE_MS - 5_000;
    const lease = path.join(leftover, '.cindy-forge-lease');
    fs.writeFileSync(lease, `${staleMs}\n`);
    fs.utimesSync(leftover, staleMs / 1000, staleMs / 1000);
    fs.utimesSync(lease, staleMs / 1000, staleMs / 1000);
    fs.mkdirSync(keepName);
    fs.writeFileSync(path.join(keepName, 'keep.txt'), 'keep');
    fs.mkdirSync(other);
    const outside = path.join(dir, 'outside-target');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'sentinel.txt'), 'safe');
    const linkName = path.join(dir, 'cindy-forge-ffffffff-bbbb-4ccc-9ddd-eeeeeeeeeeee');
    try {
      fs.symlinkSync(outside, linkName);
    } catch {
      // Platforms that cannot symlink still cover the UUID directory sweep.
    }

    sweepStaleForgePackStagingDirs(dir, { now: nowMs });

    expect(fs.existsSync(leftover)).toBe(false);
    expect(fs.existsSync(keepName)).toBe(true);
    expect(fs.existsSync(other)).toBe(true);
    expect(fs.readFileSync(path.join(outside, 'sentinel.txt'), 'utf8')).toBe('safe');
    if (fs.existsSync(linkName)) {
      expect(fs.lstatSync(linkName).isSymbolicLink()).toBe(true);
    }
  });

  it('does not sweep another instance live staging directory that is still within TTL', () => {
    const dir = makeTempDir();
    const liveA = controller({
      getTempDir: () => dir,
      randomId: (() => {
        let n = 0;
        return () =>
          [
            'aaaaaaaa-bbbb-4ccc-9ddd-eeeeeeeeeeee',
            'aaaaaaaa-bbbb-4ccc-9ddd-ffffffffffff',
          ][n++] ?? `extra-${n}`;
      })(),
    }).stage({
      buf: Buffer.from('live-a'),
      manifestId: 'demo',
      owner: OWNER_A,
      operationKind: 'install',
    });
    expect(fs.existsSync(liveA.stagingPath)).toBe(true);
    sweepStaleForgePackStagingDirs(dir);
    expect(fs.existsSync(liveA.stagingPath)).toBe(true);
  });

  it('production getController sweep keeps a fresh dir and deletes a >21min leftover', () => {
    const dir = makeTempDir();
    const liveA = controller({
      getTempDir: () => dir,
      randomId: (() => {
        let n = 0;
        return () =>
          [
            'aaaaaaaa-bbbb-4ccc-9ddd-eeeeeeeeeeee',
            'aaaaaaaa-bbbb-4ccc-9ddd-ffffffffffff',
          ][n++] ?? `extra-${n}`;
      })(),
    }).stage({
      buf: Buffer.from('live-a'),
      manifestId: 'demo',
      owner: OWNER_A,
      operationKind: 'install',
    });
    const leftover = path.join(dir, 'cindy-forge-cccccccc-bbbb-4ccc-9ddd-eeeeeeeeeeee');
    fs.mkdirSync(leftover);
    fs.writeFileSync(path.join(leftover, 'package.cindy'), 'stale');
    const nowMs = Date.now();
    const staleMs = nowMs - FORGE_PACK_STAGING_SWEEP_MAX_AGE_MS - 5_000;
    const lease = path.join(leftover, '.cindy-forge-lease');
    fs.writeFileSync(lease, '\n');
    fs.utimesSync(leftover, staleMs / 1000, staleMs / 1000);
    fs.utimesSync(lease, staleMs / 1000, staleMs / 1000);

    resetForgePackStagingForTests();
    bindForgePackStagingTempDir(() => dir);
    getForgePackStagingController();

    expect(fs.existsSync(liveA.stagingPath)).toBe(true);
    expect(fs.existsSync(leftover)).toBe(false);
  });

  it('does not renew ticket expiry if the process freezes after pinning expiresAt', () => {
    const dir = makeTempDir();
    const t1 = 1_700_000_000_000;
    const t2 = t1 + 30 * 60 * 1000;
    let sawLeaseAfterPin = false;
    const issued = controller({
      getTempDir: () => dir,
      // T1 before the one-shot lease exists, T2 after — a freeze between the
      // pin and tickets.set (or a now() read after the marker) must not mint
      // a ticket that outlives the marker.
      now: () => {
        const taskDir = fs.readdirSync(dir).find((name) => name.startsWith('cindy-forge-'));
        if (taskDir && fs.existsSync(path.join(dir, taskDir, '.cindy-forge-lease'))) {
          sawLeaseAfterPin = true;
          return t2;
        }
        return t1;
      },
      ttlMs: 10 * 60 * 1000,
      randomId: (() => {
        let n = 0;
        return () => ['task-freeze', 'ticket-freeze'][n++] ?? `extra-${n}`;
      })(),
    });
    const staged = issued.stage({
      buf: Buffer.from('frozen-mid-stage'),
      manifestId: 'demo',
      owner: OWNER_A,
      operationKind: 'install',
    });
    expect(issued.peek(staged.ticket)).toBeNull();
    expect(sawLeaseAfterPin).toBe(true);
  });

  it('writes the one-shot lease marker after hashing, not when the package file is created', () => {
    const dir = makeTempDir();
    const originalCreateHash = crypto.createHash;
    let leaseExistedDuringHash = false;
    const spy = vi.spyOn(crypto, 'createHash').mockImplementation((algorithm, options) => {
      const hash = originalCreateHash.call(crypto, algorithm, options);
      const update = hash.update.bind(hash);
      hash.update = ((data: crypto.BinaryLike) => {
        const taskDir = fs.readdirSync(dir).find((name) => name.startsWith('cindy-forge-'));
        if (taskDir) {
          leaseExistedDuringHash = fs.existsSync(path.join(dir, taskDir, '.cindy-forge-lease'));
        }
        return update(data);
      }) as typeof hash.update;
      return hash;
    });
    try {
      const staged = controller({ getTempDir: () => dir }).stage({
        buf: Buffer.from('hashed-after-write'),
        manifestId: 'demo',
        owner: OWNER_A,
        operationKind: 'install',
      });
      expect(leaseExistedDuringHash).toBe(false);
      const lease = path.join(path.dirname(staged.stagingPath), '.cindy-forge-lease');
      expect(fs.lstatSync(lease).isFile()).toBe(true);
      expect(fs.lstatSync(lease).isSymbolicLink()).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });
});

function cryptoRandom(): string {
  return Math.random().toString(16).slice(2);
}
