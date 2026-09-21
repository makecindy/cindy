import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const state = vi.hoisted(() => ({ root: '', userData: '' }));
const notify = vi.hoisted(() => vi.fn());
const readIdentity = vi.hoisted(() => vi.fn());
vi.mock('electron', () => ({ app: { getPath: (name: string) => name === 'appData' ? path.join(state.root, 'app-data') : (state.userData || state.root) } }));
vi.mock('../worktree/recycleEvents', () => ({ notifyWorktreeRecycleOpportunity: notify }));
vi.mock('../desktopProcessIdentity', async (importOriginal) => ({
  ...await importOriginal<typeof import('../desktopProcessIdentity')>(),
  readDesktopProcessIdentity: readIdentity,
}));

import { acquireWorktreeRuntimeLease, releaseWorktreeRuntimeLease, readWorktreeRuntimePaths, retryPendingWorktreeRuntimeLeaseReleases } from '../worktree/runtimeLeases';
import { physicalWorktreeKey, withWorktreeResourceLock } from '../worktree/resourceLock';
import { createLinkedWorktreeMetadata } from './fixtures/linkedWorktree';

describe('worktree runtime evidence and physical locks', () => {
  let worktree: string;
  let gitLock: string;
  const hasGitLock = () => fs.stat(gitLock).then(() => true, () => false);
  const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
  beforeEach(async () => {
    state.root = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-worktree-runtime-'));
    state.userData = '';
    worktree = path.join(state.root, 'repo', '.cindy-worktrees', 'one');
    await fs.mkdir(path.join(worktree, 'src'), { recursive: true });
    gitLock = await createLinkedWorktreeMetadata(worktree);
    await fs.mkdir(path.join(state.root, '.dev-instances'));
    notify.mockClear();
    readIdentity.mockReset().mockResolvedValue(null);
  });
  afterEach(async () => {
    Object.defineProperty(process, 'platform', platformDescriptor);
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

  it('retries a failed shared lease release from another isolated profile', async () => {
    const lease = (await acquireWorktreeRuntimeLease('borrower', worktree, { crossProfile: true }))!;
    const unlink = fs.unlink.bind(fs);
    let blocked = true;
    vi.spyOn(fs, 'unlink').mockImplementation(async (file) => {
      if (file === lease.sharedFile && blocked) throw Object.assign(new Error('busy'), { code: 'EBUSY' });
      return unlink(file);
    });
    await expect(releaseWorktreeRuntimeLease(lease)).rejects.toMatchObject({ code: 'EBUSY' });
    await expect(fs.stat(lease.file)).rejects.toMatchObject({ code: 'ENOENT' });
    state.userData = path.join(state.root, 'profile-b');
    await fs.mkdir(path.join(state.userData, '.dev-instances'), { recursive: true });
    expect(await readWorktreeRuntimePaths()).toEqual(new Set([await physicalWorktreeKey(worktree)]));
    expect(await retryPendingWorktreeRuntimeLeaseReleases()).toBe(1);
    expect(await readWorktreeRuntimePaths()).toEqual(new Set([await physicalWorktreeKey(worktree)]));
    blocked = false;
    expect(await retryPendingWorktreeRuntimeLeaseReleases()).toBe(0);
    expect(await readWorktreeRuntimePaths()).toEqual(new Set());
    await expect(fs.stat(`${lease.sharedFile}.release`)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each(['crashed-owner', 'partial-write'] as const)('keeps shared lease evidence protective after %s', async (reason) => {
    const lease = (await acquireWorktreeRuntimeLease('borrower', worktree, { crossProfile: true }))!;
    state.userData = path.join(state.root, 'profile-b');
    await fs.mkdir(path.join(state.userData, '.dev-instances'), { recursive: true });
    if (reason === 'partial-write') await fs.writeFile(lease.sharedFile!, '{');
    else vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('owner is gone'), { code: 'ESRCH' });
    });
    expect(await readWorktreeRuntimePaths()).toEqual(reason === 'partial-write' ? null : new Set([await physicalWorktreeKey(worktree)]));
    await releaseWorktreeRuntimeLease(lease);
    expect(await readWorktreeRuntimePaths()).toEqual(new Set());
  });

  it('cleans a failed shared publication without removing an older profile lease', async () => {
    const oldLease = (await acquireWorktreeRuntimeLease('borrower', worktree))!;
    const sharedRoot = path.join(state.root, 'app-data', 'Cindy', 'shared-worktree-runtime-leases');
    const write = fs.writeFile.bind(fs);
    vi.spyOn(fs, 'writeFile').mockImplementation(async (...args) => {
      await write(...args);
      if (typeof args[0] === 'string' && path.dirname(args[0]) === sharedRoot) {
        throw Object.assign(new Error('shared publication interrupted'), { code: 'EIO' });
      }
    });
    await expect(acquireWorktreeRuntimeLease('borrower', worktree, { crossProfile: true })).rejects.toThrow('shared publication interrupted');
    expect(await fs.readdir(path.dirname(oldLease.file))).toEqual([path.basename(oldLease.file)]);
    expect(await fs.readdir(sharedRoot)).toEqual([]);
    expect(await readWorktreeRuntimePaths()).toEqual(new Set([await physicalWorktreeKey(worktree)]));
    await releaseWorktreeRuntimeLease(oldLease);
  });

  it.each(['file', 'directory'] as const)('preserves an existing user Git lock %s', async (kind) => {
    const file = gitLock;
    if (kind === 'file') await fs.writeFile(file, 'user requested retention');
    else await fs.mkdir(file);
    const lease = (await acquireWorktreeRuntimeLease('borrower', worktree, { crossProfile: true }))!;
    expect(lease.keepSentinel).toBeUndefined();
    await releaseWorktreeRuntimeLease(lease);
    expect(await hasGitLock()).toBe(true);
    if (kind === 'file') expect(await fs.readFile(file, 'utf8')).toBe('user requested retention');
    else expect(await fs.readdir(file)).toEqual([]);
  });

  it.each(['missing link', 'malformed link', 'foreign backlink', 'metadata inside source'] as const)(
    'rejects borrowing with %s before publishing an external Git lock', async (kind) => {
      const link = path.join(worktree, '.git');
      if (kind === 'missing link') await fs.unlink(link);
      else if (kind === 'malformed link') await fs.writeFile(link, 'not a Git worktree');
      else if (kind === 'foreign backlink') {
        await fs.writeFile(path.join(path.dirname(gitLock), 'gitdir'), path.join(state.root, 'other', '.git'));
      } else {
        const gitDir = path.join(worktree, 'metadata', 'worktrees', 'one');
        await fs.mkdir(gitDir, { recursive: true });
        await fs.writeFile(path.join(gitDir, 'commondir'), '../..');
        await fs.writeFile(path.join(gitDir, 'gitdir'), link);
        await fs.writeFile(link, `gitdir: ${gitDir}\n`);
        gitLock = path.join(gitDir, 'locked');
      }
      await expect(acquireWorktreeRuntimeLease('borrower', worktree, { crossProfile: true })).rejects.toThrow();
      expect(await readWorktreeRuntimePaths()).toEqual(new Set());
      expect(await hasGitLock()).toBe(false);
    },
  );

  it('accepts relative Git metadata links without creating a keep file in source', async () => {
    const root = await fs.realpath(worktree);
    const gitDir = path.dirname(gitLock);
    const link = path.join(root, '.git');
    await fs.writeFile(link, `gitdir: ${path.relative(root, gitDir)}\n`);
    await fs.writeFile(path.join(gitDir, 'gitdir'), `${path.relative(gitDir, link)}\n`);
    const lease = (await acquireWorktreeRuntimeLease('borrower', worktree, { crossProfile: true }))!;
    expect(lease.keepSentinel?.file).toBe(await physicalWorktreeKey(gitLock));
    await expect(fs.stat(path.join(worktree, '.worktree-keep'))).rejects.toMatchObject({ code: 'ENOENT' });
    await releaseWorktreeRuntimeLease(lease);
    expect(await hasGitLock()).toBe(false);
  });

  it('keeps legacy protection until the last borrower in either profile finishes', async () => {
    const first = (await acquireWorktreeRuntimeLease('first', worktree, { crossProfile: true }))!;
    state.userData = path.join(state.root, 'second-profile');
    const second = (await acquireWorktreeRuntimeLease('second', worktree, { crossProfile: true }))!;
    expect(first.keepSentinel).toBeDefined();
    expect(second.keepSentinel).toEqual(first.keepSentinel);
    await releaseWorktreeRuntimeLease(first);
    await releaseWorktreeRuntimeLease(first);
    expect(await hasGitLock()).toBe(true);
    await releaseWorktreeRuntimeLease(second);
    expect(await hasGitLock()).toBe(false);
  });

  it('does not adopt a user marker just because its contents resemble our format', async () => {
    const file = gitLock;
    const content = JSON.stringify({ kind: 'cindy-runtime-lock', version: 1, nonce: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' });
    await fs.writeFile(file, content);
    const lease = (await acquireWorktreeRuntimeLease('borrower', worktree, { crossProfile: true }))!;
    expect(lease.keepSentinel).toBeUndefined();
    await releaseWorktreeRuntimeLease(lease);
    expect(await fs.readFile(file, 'utf8')).toBe(content);
  });

  it('does not let a later borrower adopt a marker edited during an earlier borrow', async () => {
    const first = (await acquireWorktreeRuntimeLease('first', worktree, { crossProfile: true }))!;
    const file = gitLock;
    const content = JSON.stringify({ kind: 'cindy-runtime-lock', version: 1, nonce: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' });
    await fs.writeFile(file, content);
    const second = (await acquireWorktreeRuntimeLease('second', worktree, { crossProfile: true }))!;
    expect(second.keepSentinel).toBeUndefined();
    await releaseWorktreeRuntimeLease(first);
    await releaseWorktreeRuntimeLease(second);
    expect(await fs.readFile(file, 'utf8')).toBe(content);
  });

  it.each(['edited', 'replaced'] as const)('preserves a runtime marker %s by the user', async (change) => {
    const lease = (await acquireWorktreeRuntimeLease('borrower', worktree, { crossProfile: true }))!;
    const file = gitLock;
    if (change === 'edited') await fs.writeFile(file, 'keep my checkout');
    else {
      // Keep the old inode alive so a replacement containing identical bytes
      // cannot be confused with the marker this acquisition actually owns.
      await fs.rename(file, `${file}.previous`);
      await fs.writeFile(file, lease.keepSentinel!.content);
    }
    await releaseWorktreeRuntimeLease(lease);
    expect(await hasGitLock()).toBe(true);
    expect(await fs.readFile(file, 'utf8')).toBe(change === 'edited' ? 'keep my checkout' : lease.keepSentinel!.content);
  });

  it('does not remove legacy protection when another borrower crashes', async () => {
    const crashed = (await acquireWorktreeRuntimeLease('crashed', worktree, { crossProfile: true }))!;
    const active = (await acquireWorktreeRuntimeLease('active', worktree, { crossProfile: true }))!;
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('owner is gone'), { code: 'ESRCH' });
    });
    await releaseWorktreeRuntimeLease(active);
    await retryPendingWorktreeRuntimeLeaseReleases();
    expect(await hasGitLock()).toBe(true);
    expect(await fs.stat(crashed.sharedFile!)).toBeDefined();
    // Only confirmed source I/O teardown authorizes the remaining release.
    await releaseWorktreeRuntimeLease(crashed);
    expect(await hasGitLock()).toBe(false);
  });

  it('fails acquisition before source I/O when legacy protection cannot be published', async () => {
    const write = fs.writeFile.bind(fs);
    const sentinel = await physicalWorktreeKey(gitLock);
    vi.spyOn(fs, 'writeFile').mockImplementation(async (...args) => {
      if (args[0] === sentinel) throw Object.assign(new Error('read only'), { code: 'EACCES' });
      return write(...args);
    });
    await expect(acquireWorktreeRuntimeLease('borrower', worktree, { crossProfile: true })).rejects.toMatchObject({ code: 'EACCES' });
    expect(await readWorktreeRuntimePaths()).toEqual(new Set());
    expect(await hasGitLock()).toBe(false);
  });

  it('retries failed sentinel cleanup through the shared durable release intent', async () => {
    const lease = (await acquireWorktreeRuntimeLease('borrower', worktree, { crossProfile: true }))!;
    const unlink = fs.unlink.bind(fs);
    const sentinel = lease.keepSentinel!.file!;
    let blocked = true;
    vi.spyOn(fs, 'unlink').mockImplementation(async (file) => {
      if (file === sentinel && blocked) throw Object.assign(new Error('busy'), { code: 'EBUSY' });
      return unlink(file);
    });
    await expect(releaseWorktreeRuntimeLease(lease)).rejects.toMatchObject({ code: 'EBUSY' });
    expect(await hasGitLock()).toBe(true);
    expect(await fs.stat(lease.sharedFile!)).toBeDefined();
    state.userData = path.join(state.root, 'maintenance-profile');
    expect(await retryPendingWorktreeRuntimeLeaseReleases()).toBe(1);
    blocked = false;
    expect(await retryPendingWorktreeRuntimeLeaseReleases()).toBe(0);
    expect(await hasGitLock()).toBe(false);
    await expect(fs.stat(lease.sharedFile!)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.stat(`${lease.sharedFile}.release`)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('still cleans an owned in-tree marker from an older durable release receipt', async () => {
    const lease = (await acquireWorktreeRuntimeLease('borrower', worktree, { crossProfile: true }))!;
    const marker = lease.keepSentinel!;
    const oldFile = path.join(worktree, '.worktree-keep');
    await fs.rename(marker.file!, oldFile);
    // Older receipts carried identity and content, with no explicit marker path.
    const keepSentinel = { identity: marker.identity, content: marker.content };
    await fs.writeFile(`${lease.sharedFile}.release`, JSON.stringify({
      version: 1, file: lease.sharedFile, path: lease.physicalPath, keepSentinel,
    }));
    expect(await retryPendingWorktreeRuntimeLeaseReleases()).toBe(0);
    await expect(fs.stat(oldFile)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.stat(lease.sharedFile!)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.stat(`${lease.sharedFile}.release`)).rejects.toMatchObject({ code: 'ENOENT' });
    await releaseWorktreeRuntimeLease(lease);
  });

  it('cleans its own marker when publishing marker ownership fails', async () => {
    const write = fs.writeFile.bind(fs);
    vi.spyOn(fs, 'writeFile').mockImplementation(async (...args) => {
      if (typeof args[1] === 'string' && args[1].includes('"keepSentinel"')) {
        await write(args[0], '{');
        throw Object.assign(new Error('ownership publication interrupted'), { code: 'EIO' });
      }
      return write(...args);
    });
    await expect(acquireWorktreeRuntimeLease('borrower', worktree, { crossProfile: true })).rejects.toMatchObject({ code: 'EIO' });
    expect(await readWorktreeRuntimePaths()).toEqual(new Set());
    expect(await hasGitLock()).toBe(false);
  });

  it('keeps legacy protection while another shared borrower record is unreadable', async () => {
    const first = (await acquireWorktreeRuntimeLease('first', worktree, { crossProfile: true }))!;
    const second = (await acquireWorktreeRuntimeLease('second', worktree, { crossProfile: true }))!;
    await fs.writeFile(second.sharedFile!, '{');
    await expect(releaseWorktreeRuntimeLease(first)).rejects.toThrow();
    expect(await hasGitLock()).toBe(true);
    expect(await retryPendingWorktreeRuntimeLeaseReleases()).toBe(1);
    await releaseWorktreeRuntimeLease(second);
    expect(await hasGitLock()).toBe(true);
    expect(await retryPendingWorktreeRuntimeLeaseReleases()).toBe(0);
    expect(await hasGitLock()).toBe(false);
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

  describe('POSIX SingletonLock PID reuse', () => {
    const raw = JSON.stringify({ pid: 4242, startedAtMs: 10_000 });
    const identity = { startedAtMs: 100_000, executablePath: '/usr/bin/other' };
    beforeEach(async () => {
      Object.defineProperty(process, 'platform', { ...platformDescriptor, value: 'darwin' });
      await fs.writeFile(path.join(state.root, '.dev-instances', '4242.json'), raw);
      vi.spyOn(process, 'kill').mockReturnValue(true);
      vi.spyOn(fs, 'readlink').mockResolvedValue('hostname-4242');
      readIdentity.mockResolvedValue(identity);
    });

    it.each(['darwin', 'linux'])('ignores a proven reused lock PID on %s while retaining detached-child leases', async (platform) => {
      Object.defineProperty(process, 'platform', { ...platformDescriptor, value: platform });
      const root = path.join(state.root, 'worktree-runtime-leases');
      await fs.mkdir(root);
      await fs.writeFile(path.join(root, `4242-${'a'.repeat(64)}.json`),
        JSON.stringify({ version: 1, pid: 4242, path: worktree }));
      expect(await readWorktreeRuntimePaths()).toEqual(new Set([worktree]));
      expect(await fs.readFile(path.join(state.root, '.dev-instances', '4242.json'), 'utf8')).toBe(raw);
    });

    it('still blocks an unrelated live lock PID without reuse evidence', async () => {
      vi.mocked(fs.readlink).mockResolvedValue('hostname-4343');
      expect(await readWorktreeRuntimePaths()).toBeNull();
    });

    it.each([null, { ...identity, executablePath: '/opt/Cindy.app/Contents/MacOS/Cindy' }])
      ('does not waive the lock when identity becomes unavailable or a runtime replaces the process: %j', async (latest) => {
        readIdentity.mockResolvedValueOnce(identity).mockResolvedValueOnce(latest);
        expect(await readWorktreeRuntimePaths()).toBeNull();
      });

    it('does not waive a lock whose target changes during revalidation', async () => {
      vi.mocked(fs.readlink).mockResolvedValueOnce('hostname-4242').mockResolvedValueOnce('hostname-4343');
      expect(await readWorktreeRuntimePaths()).toBeNull();
    });

    it.each(['replace', 'remove'])('does not waive the lock when its instance registration changes: %s', async (change) => {
      readIdentity.mockResolvedValueOnce(identity).mockImplementationOnce(async () => {
        const file = path.join(state.root, '.dev-instances', '4242.json');
        if (change === 'remove') await fs.unlink(file);
        else await fs.writeFile(file, JSON.stringify({ pid: 4242, startedAtMs: 200_000 }));
        return identity;
      });
      expect(await readWorktreeRuntimePaths()).toBeNull();
    });
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
