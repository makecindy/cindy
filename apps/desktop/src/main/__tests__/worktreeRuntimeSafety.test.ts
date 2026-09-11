import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const state = vi.hoisted(() => ({ root: '' }));
const notify = vi.hoisted(() => vi.fn());
const readIdentity = vi.hoisted(() => vi.fn());
vi.mock('electron', () => ({ app: { getPath: () => state.root } }));
vi.mock('../worktree/recycleEvents', () => ({ notifyWorktreeRecycleOpportunity: notify }));
vi.mock('../desktopProcessIdentity', async (importOriginal) => ({
  ...await importOriginal<typeof import('../desktopProcessIdentity')>(),
  readDesktopProcessIdentity: readIdentity,
}));

import { acquireWorktreeRuntimeLease, releaseWorktreeRuntimeLease, readWorktreeRuntimePaths, retryPendingWorktreeRuntimeLeaseReleases } from '../worktree/runtimeLeases';
import { physicalWorktreeKey, withWorktreeResourceLock } from '../worktree/resourceLock';

describe('worktree runtime evidence and physical locks', () => {
  let worktree: string;
  beforeEach(async () => {
    state.root = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-worktree-runtime-'));
    worktree = path.join(state.root, 'repo', '.cindy-worktrees', 'one');
    await fs.mkdir(path.join(worktree, 'src'), { recursive: true });
    await fs.mkdir(path.join(state.root, '.dev-instances'));
    notify.mockClear();
    readIdentity.mockReset().mockResolvedValue(null);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(state.root, { recursive: true, force: true });
  });

  it('publishes a root lease before using a descendant and wakes retries only on actual release', async () => {
    const lease = (await acquireWorktreeRuntimeLease('one', path.join(worktree, 'src')))!;
    expect(await readWorktreeRuntimePaths()).toEqual(new Set([await physicalWorktreeKey(worktree)]));
    await releaseWorktreeRuntimeLease(lease);
    await releaseWorktreeRuntimeLease(lease);
    expect(await readWorktreeRuntimePaths()).toEqual(new Set());
    expect(notify).toHaveBeenCalledOnce();
  });

  it('keeps the replacement runtime protected when an older close finishes late', async () => {
    const oldLease = (await acquireWorktreeRuntimeLease('one', worktree))!;
    const replacementLease = (await acquireWorktreeRuntimeLease('one', worktree))!;
    expect(oldLease.file).not.toBe(replacementLease.file);
    await releaseWorktreeRuntimeLease(oldLease);
    await releaseWorktreeRuntimeLease(oldLease);
    expect(await readWorktreeRuntimePaths()).toEqual(new Set([await physicalWorktreeKey(worktree)]));
    await releaseWorktreeRuntimeLease(replacementLease);
    expect(await readWorktreeRuntimePaths()).toEqual(new Set());
  });

  it('persists a failed release and retries it without treating a dead PID as idle', async () => {
    const lease = (await acquireWorktreeRuntimeLease('one', worktree))!;
    const unlink = vi.spyOn(fs, 'unlink').mockImplementationOnce(async () => {
      throw Object.assign(new Error('busy'), { code: 'EBUSY' });
    });
    await expect(releaseWorktreeRuntimeLease(lease)).rejects.toMatchObject({ code: 'EBUSY' });
    expect(await readWorktreeRuntimePaths()).toEqual(new Set([await physicalWorktreeKey(worktree)]));
    expect(await retryPendingWorktreeRuntimeLeaseReleases()).toBe(0);
    expect(await readWorktreeRuntimePaths()).toEqual(new Set());
    expect(notify).toHaveBeenCalledTimes(2);
    unlink.mockRestore();
  });

  it('cleans only the failed acquisition when publishing a replacement lease fails', async () => {
    const oldLease = (await acquireWorktreeRuntimeLease('one', worktree))!;
    const write = fs.writeFile.bind(fs);
    vi.spyOn(fs, 'writeFile').mockImplementationOnce(async (...args) => {
      await write(...args);
      throw Object.assign(new Error('lease write interrupted'), { code: 'EIO' });
    });
    await expect(acquireWorktreeRuntimeLease('one', worktree)).rejects.toThrow('lease write interrupted');
    expect(await fs.readdir(path.dirname(oldLease.file))).toEqual([path.basename(oldLease.file)]);
    expect(await readWorktreeRuntimePaths()).toEqual(new Set([await physicalWorktreeKey(worktree)]));
    await releaseWorktreeRuntimeLease(oldLease);
  });

  it('preserves when another live instance cannot publish runtime evidence', async () => {
    vi.spyOn(process, 'kill').mockReturnValue(true);
    await fs.writeFile(path.join(state.root, '.dev-instances', '4242.json'), JSON.stringify({ pid: 4242 }));
    expect(await readWorktreeRuntimePaths()).toBeNull();
  });

  it('prefers a valid current instance record over its older backup', async () => {
    vi.spyOn(process, 'kill').mockReturnValue(true);
    await fs.writeFile(path.join(state.root, '.dev-instances', '4242.json'), JSON.stringify({ pid: 4242, worktreeLeaseProtocol: 1 }));
    await fs.writeFile(path.join(state.root, '.dev-instances', '4242.json.bak'), JSON.stringify({ pid: 4242 }));
    expect(await readWorktreeRuntimePaths()).toEqual(new Set());
    expect(readIdentity).not.toHaveBeenCalled();
  });

  it('ignores a legacy registration whose PID was reused, but keeps its detached-child lease', async () => {
    const lease = (await acquireWorktreeRuntimeLease('one', worktree))!;
    const file = path.join(state.root, '.dev-instances', '4242.json');
    const raw = JSON.stringify({ pid: 4242, startedAtMs: 10_000 });
    await fs.writeFile(file, raw);
    vi.spyOn(process, 'kill').mockReturnValue(true);
    readIdentity.mockResolvedValue({ startedAtMs: 100_000, executablePath: path.join(state.root, 'chrome.exe') });
    expect(await readWorktreeRuntimePaths()).toEqual(new Set([await physicalWorktreeKey(worktree)]));
    expect(await fs.readFile(file, 'utf8')).toBe(raw);
    await releaseWorktreeRuntimeLease(lease);
    expect(await readWorktreeRuntimePaths()).toEqual(new Set());
  });

  it('keeps a real legacy Cindy instance protective', async () => {
    await fs.writeFile(path.join(state.root, '.dev-instances', '4242.json'),
      JSON.stringify({ pid: 4242, startedAtMs: 100_000 }));
    vi.spyOn(process, 'kill').mockReturnValue(true);
    readIdentity.mockResolvedValue({ startedAtMs: 99_000, executablePath: process.execPath });
    expect(await readWorktreeRuntimePaths()).toBeNull();
  });

  it('keeps a replacement Cindy protective before its new registration is published', async () => {
    await fs.writeFile(path.join(state.root, '.dev-instances', '4242.json'),
      JSON.stringify({ pid: 4242, startedAtMs: 1 }));
    vi.spyOn(process, 'kill').mockReturnValue(true);
    readIdentity.mockResolvedValue({ startedAtMs: 100_000, executablePath: path.join(state.root, 'Cindy.exe') });
    expect(await readWorktreeRuntimePaths()).toBeNull();
  });

  it('preserves when process identity is unavailable even for a very old registration', async () => {
    await fs.writeFile(path.join(state.root, '.dev-instances', '4242.json'),
      JSON.stringify({ pid: 4242, startedAtMs: 1 }));
    vi.spyOn(process, 'kill').mockReturnValue(true);
    expect(await readWorktreeRuntimePaths()).toBeNull();
  });

  it('rechecks liveness when the process exits during the identity query', async () => {
    await fs.writeFile(path.join(state.root, '.dev-instances', '4242.json'), JSON.stringify({ pid: 4242 }));
    vi.spyOn(process, 'kill').mockReturnValueOnce(true).mockImplementation(() => {
      throw Object.assign(new Error('exited'), { code: 'ESRCH' });
    });
    expect(await readWorktreeRuntimePaths()).toEqual(new Set());
  });

  it('does not apply stale evidence after another instance replaces the registry record', async () => {
    const file = path.join(state.root, '.dev-instances', '4242.json');
    await fs.writeFile(file, JSON.stringify({ pid: 4242, startedAtMs: 10_000 }));
    vi.spyOn(process, 'kill').mockReturnValue(true);
    readIdentity.mockImplementation(async () => {
      await fs.writeFile(file, JSON.stringify({ pid: 4242, startedAtMs: 200_000 }));
      return { startedAtMs: 100_000, executablePath: path.join(state.root, 'chrome.exe') };
    });
    expect(await readWorktreeRuntimePaths()).toBeNull();
  });

  it('does not trust a backup after a new primary registration appears during the probe', async () => {
    const file = path.join(state.root, '.dev-instances', '4242.json');
    await fs.writeFile(`${file}.bak`, JSON.stringify({ pid: 4242, startedAtMs: 10_000 }));
    vi.spyOn(process, 'kill').mockReturnValue(true);
    readIdentity.mockImplementation(async () => {
      await fs.writeFile(file, JSON.stringify({ pid: 4242, startedAtMs: 200_000 }));
      return { startedAtMs: 100_000, executablePath: path.join(state.root, 'chrome.exe') };
    });
    expect(await readWorktreeRuntimePaths()).toBeNull();
  });

  it('does not mistake an unreadable live lease for a stopped runtime', async () => {
    await acquireWorktreeRuntimeLease('one', worktree);
    const root = path.join(state.root, 'worktree-runtime-leases');
    const [name] = await fs.readdir(root);
    await fs.writeFile(path.join(root, name), '{');
    expect(await readWorktreeRuntimePaths()).toBeNull();
  });

  it('keeps a crashed owner lease protective because its child may still run', async () => {
    const lease = (await acquireWorktreeRuntimeLease('one', worktree))!;
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('owner is gone'), { code: 'ESRCH' });
    });
    expect(await readWorktreeRuntimePaths()).toEqual(new Set([await physicalWorktreeKey(worktree)]));
    await releaseWorktreeRuntimeLease(lease);
    expect(await readWorktreeRuntimePaths()).toEqual(new Set());
  });

  it('does not treat a crashed owner partial lease as evidence of an idle directory', async () => {
    const lease = (await acquireWorktreeRuntimeLease('one', worktree))!;
    await fs.writeFile(lease.file, '{');
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('owner is gone'), { code: 'ESRCH' });
    });
    expect(await readWorktreeRuntimePaths()).toBeNull();
  });

  it('serializes independent callers and allows a nested call in the same operation', async () => {
    let release!: () => void;
    let entered!: () => void;
    const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const order: string[] = [];
    const first = withWorktreeResourceLock(worktree, async () => {
      await withWorktreeResourceLock(path.join(worktree, 'src', '..'), async () => { order.push('nested'); });
      entered(); await gate; order.push('released');
    });
    await enteredPromise;
    const second = withWorktreeResourceLock(worktree, async () => { order.push('second'); });
    expect(order).toEqual(['nested']);
    release(); await Promise.all([first, second]);
    expect(order).toEqual(['nested', 'released', 'second']);
  });
});
