import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createWorkingDirectoryPreflight } from '../workingDirectoryPreflight';
import { createPreflightHarness, filesystemError } from './helpers/workingDirectoryPreflightHarness';

describe('working directory send preflight', () => {
  it('allows a bound timeout without missing, recovery, or a second bootstrap observation', async () => {
    const h = createPreflightHarness();
    h.io.stat.mockRejectedValue(filesystemError('WORKDIR_PROBE_TIMEOUT'));
    await expect(h.check('s', h.dir, 'codex')).resolves.toBe(true);
    await h.recovery.observe('s', h.dir);
    expect(h.io.stat).toHaveBeenCalledOnce();
    expect(h.recover).toHaveBeenCalledWith('s', h.dir, undefined, [], 'ordinary', { existingFallbackOnly: true });
    expect(h.io.mkdir).not.toHaveBeenCalled();
    expect(h.emitMissing).not.toHaveBeenCalled();
    expect(h.log.warn).not.toHaveBeenCalled();
    expect(h.recovery.resolve('s', h.dir)).toBe(h.dir);

    // No cached permission to continue: the next send checks again.
    await expect(h.check('s', h.dir, 'codex')).resolves.toBe(true);
    expect(h.io.stat).toHaveBeenCalledTimes(2);
    h.io.stat.mockRejectedValue(filesystemError('ENOENT'));
    h.recover.mockImplementation(async (_sessionId, _workingDir, _similar, _candidates, _mode, options) => options?.existingFallbackOnly === true);
    await expect(h.check('s', h.dir, 'codex')).resolves.toBe(false);
    expect(h.recover).toHaveBeenCalledTimes(4);
    expect(h.recover).toHaveBeenNthCalledWith(4, 's', h.dir, expect.any(Function), []);
    expect(h.emitMissing).toHaveBeenCalledWith('s', h.dir, 'codex', 'not-exist', null);
  });

  it.each([null, path.resolve('/another-project')])('preserves an unbound timeout (%s) without recovery or missing', async (bound) => {
    const h = createPreflightHarness();
    const error = filesystemError('WORKDIR_PROBE_TIMEOUT');
    h.io.stat.mockRejectedValue(error);
    h.readBoundWorkingDir.mockResolvedValue(bound);
    await expect(h.check('s', h.dir, 'codex')).rejects.toBe(error);
    expect(h.recover).toHaveBeenCalledWith('s', h.dir, undefined, [], 'ordinary', { existingFallbackOnly: true });
    expect(h.emitMissing).not.toHaveBeenCalled();
  });

  it.each(['EACCES', 'EIO', 'WORKDIR_PROBE_UNAVAILABLE'])('preserves %s instead of entering missing recovery', async (code) => {
    const h = createPreflightHarness();
    const error = filesystemError(code);
    h.io.stat.mockRejectedValue(error);
    await expect(h.check('s', h.dir, 'codex')).rejects.toBe(error);
    expect(h.recover).toHaveBeenCalledWith('s', h.dir, undefined, [], 'ordinary', { existingFallbackOnly: true });
    expect(h.emitMissing).not.toHaveBeenCalled();
    expect(h.log.warn).toHaveBeenCalled();
  });

  it('recovers an explicitly absent ordinary directory without broadcasting missing', async () => {
    const h = createPreflightHarness();
    h.io.stat.mockRejectedValue(filesystemError('ENOENT'));
    await expect(h.check('s', h.dir, 'codex')).resolves.toBe(true);
    expect(h.recover).toHaveBeenCalledTimes(2);
    expect(h.recover).toHaveBeenNthCalledWith(2, 's', h.dir, expect.any(Function), []);
    expect(h.io.mkdir).toHaveBeenCalledWith(h.dir, { recursive: true });
    expect(h.emitMissing).not.toHaveBeenCalled();
  });

  it.each(['ENOENT', 'EACCES', 'WORKDIR_PROBE_TIMEOUT'])('keeps a suppressed %s quiet until the authoritative fallback is tried', async (code) => {
    const h = createPreflightHarness();
    h.readBoundWorkingDir.mockResolvedValue(null);
    h.io.stat.mockRejectedValue(filesystemError(code));
    await expect(h.check('s', h.dir, 'codex', null, { suppressMissingBroadcast: true })).resolves.toBe(false);
    expect(h.log.warn).not.toHaveBeenCalled();
    expect(h.recover).toHaveBeenCalledWith('s', h.dir, undefined, [], 'ordinary', { existingFallbackOnly: true });
    expect(h.emitMissing).not.toHaveBeenCalled();
  });

  it('still blocks an explicit non-directory result', async () => {
    const h = createPreflightHarness();
    h.io.stat.mockResolvedValue({ isDirectory: () => false, dev: 7 });
    await expect(h.check('s', h.dir, 'codex')).resolves.toBe(false);
    expect(h.emitMissing).toHaveBeenCalledWith('s', h.dir, 'codex', 'not-dir');
    expect(h.recover).toHaveBeenCalledWith('s', h.dir, undefined, [], 'ordinary', { existingFallbackOnly: true });
  });

  it('treats ENOTDIR as a non-directory result without entering missing recovery', async () => {
    const h = createPreflightHarness();
    h.io.stat.mockRejectedValue(filesystemError('ENOTDIR'));
    await expect(h.check('s', h.dir, 'codex')).resolves.toBe(false);
    expect(h.emitMissing).toHaveBeenCalledWith('s', h.dir, 'codex', 'not-dir');
    expect(h.recover).toHaveBeenCalledWith('s', h.dir, undefined, [], 'ordinary', { existingFallbackOnly: true });
  });

  it('checks managed worktree readiness before allowing a bound timeout', async () => {
    const h = createPreflightHarness();
    h.deps.getManagedWorktreeBasePath = vi.fn(() => h.dir);
    h.deps.getManagedWorktreeReadinessForSession = vi.fn(async () => 'retry' as const);
    h.io.stat.mockRejectedValue(filesystemError('WORKDIR_PROBE_TIMEOUT'));
    const check = createWorkingDirectoryPreflight(h.deps);
    await expect(check('s', h.dir, 'codex')).resolves.toBe(false);
    expect(h.deps.getManagedWorktreeReadinessForSession).toHaveBeenCalledWith('s', h.dir);
    expect(h.emitMissing).toHaveBeenCalledWith('s', h.dir, 'codex', 'not-exist');
    expect(h.recovery.peek('s', h.dir)).toBeNull();
  });

  it('does not probe SSH paths on the local host', async () => {
    const h = createPreflightHarness();
    await expect(h.check('s', '/remote/repo', 'codex', 'ssh-host')).resolves.toBe(true);
    expect(h.io.stat).not.toHaveBeenCalled();
  });

  it('keeps a present managed worktree blocked while restoration is incomplete', async () => {
    const h = createPreflightHarness();
    h.deps.getManagedWorktreeBasePath = () => h.dir;
    h.deps.getManagedWorktreeReadinessForSession = async () => 'retry';
    await expect(createWorkingDirectoryPreflight(h.deps)('s', h.dir, 'codex')).resolves.toBe(false);
    expect(h.emitMissing).toHaveBeenCalled();
    expect(h.io.mkdir).not.toHaveBeenCalled();
  });
});
