import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { metroEnvironmentFingerprint, probeMetroOwnership, windowsProcessSnapshot } from '../../scripts/sim-metro.mjs';
import { classifySimMetroListener, resolveSimMetroHandoff } from '../../scripts/lib/sim-whoami.mjs';

const worktreeRoot = join('/worktrees', 'metro-owner');
const owner = { pid: 100, launcherPid: 100, worktreeRoot, source: 'branch@commit', recordedAtMs: 1500,
  envFingerprint: 'env-1' };
type ProcessEntry = { pid: number; parentPid: number; startedAtMs: number };
const launcher = { pid: 100, parentPid: 1, startedAtMs: 1000 };
const wrapper = { pid: 200, parentPid: 100, startedAtMs: 1100 };
const listener = { pid: 300, parentPid: 200, startedAtMs: 1200 };

function probe(processes: ProcessEntry[], metadata: object | null = owner, listenerPid = '300') {
  return probeMetroOwnership(8081, {
    platform: 'win32',
    listenerPid: () => listenerPid,
    readOwner: () => metadata,
    processSnapshot: () => processes,
  });
}

describe('Windows Metro owner and listener association', () => {
  it('recognizes a listener beneath the pnpm and shell wrappers', () => {
    expect(probe([launcher, wrapper, listener])).toEqual({
      pid: '300', launcherPid: 100, cwd: join(worktreeRoot, 'apps/mobile'), source: owner.source,
      region: null, envFingerprint: owner.envFingerprint,
    });
  });

  it('recognizes a launcher that directly owns the listening socket', () => {
    expect(probe([launcher], owner, '100')?.launcherPid).toBe(100);
  });

  it('supports older owner metadata without a separate launcherPid', () => {
    const { launcherPid: _launcherPid, ...legacyOwner } = owner;
    expect(probe([launcher, wrapper, listener], legacyOwner)?.source).toBe(owner.source);
  });

  it.each([
    ['unrelated live launcher', [launcher, wrapper, { ...listener, parentPid: 1 }]],
    ['missing launcher', [wrapper, listener]],
    ['missing listener', [launcher, wrapper]],
    ['missing wrapper', [launcher, listener]],
    ['launcher PID reused after owner was written', [{ ...launcher, startedAtMs: 1600 }, wrapper, listener]],
    ['reused parent PID newer than its child', [launcher, { ...wrapper, startedAtMs: 1300 }, listener]],
    ['ancestry cycle', [launcher, { ...wrapper, parentPid: 300, startedAtMs: 1200 }, listener]],
    ['missing process creation time', [{ ...launcher, startedAtMs: Number.NaN }, wrapper, listener]],
    ['unavailable process snapshot', []],
  ] satisfies [string, ProcessEntry[]][])('rejects %s without allowing takeover', (_name, processes) => {
    const ownership = probe(processes);
    expect(ownership).toEqual({ pid: '300', cwd: null, source: null });
    const classified = classifySimMetroListener({
      cwd: ownership?.cwd, source: ownership?.source, targetWorktree: worktreeRoot,
    });
    const handoff = {
      takeover: true, currentSource: owner.source, runningSource: ownership?.source, listener: classified,
    };
    expect(resolveSimMetroHandoff(handoff).action).toBe('refuse');
  });

  it('rejects direct listener PID reuse even when it matches the saved owner PID', () => {
    expect(probe([{ ...launcher, startedAtMs: 1600 }], owner, '100')).toEqual({
      pid: '100', cwd: null, source: null,
    });
  });

  it.each([
    null,
    { ...owner, pid: 0 },
    { ...owner, launcherPid: -1 },
    { ...owner, recordedAtMs: undefined },
  ])('rejects missing or malformed owner identity: %j', (metadata) => {
    expect(probe([launcher, wrapper, listener], metadata)?.source).toBeNull();
  });

  it('does not read owner metadata or process identity for a free port', () => {
    const readOwner = vi.fn();
    const processSnapshot = vi.fn();
    expect(probeMetroOwnership(8081, {
      platform: 'win32', listenerPid: () => null, readOwner, processSnapshot,
    })).toBeNull();
    expect(readOwner).not.toHaveBeenCalled();
    expect(processSnapshot).not.toHaveBeenCalled();
  });

  it('preserves the recorded Metro region for rebuild gates', () => {
    expect(probe([launcher, wrapper, listener], { ...owner, region: 'cn' })?.region).toBe('cn');
  });

  it('preserves the recorded environment fingerprint for reuse gates', () => {
    expect(probe([launcher, wrapper, listener], { ...owner, envFingerprint: 'env-2' })?.envFingerprint)
      .toBe('env-2');
  });
});

describe('Metro environment fingerprint', () => {
  it('is stable for reordered inputs and changes when local config changes', () => {
    const first = metroEnvironmentFingerprint({
      env: { REGION: 'cn', MANIFEST: 'https://one.invalid' },
      files: { '.env': 'REGION=cn\n', 'scripts/self-host-regions.json': '{"cn":1}' },
    });
    expect(metroEnvironmentFingerprint({
      env: { MANIFEST: 'https://one.invalid', REGION: 'cn' },
      files: { 'scripts/self-host-regions.json': '{"cn":1}', '.env': 'REGION=cn\n' },
    })).toBe(first);
    expect(metroEnvironmentFingerprint({
      env: { REGION: 'cn', MANIFEST: 'https://two.invalid' },
      files: { '.env': 'REGION=cn\n', 'scripts/self-host-regions.json': '{"cn":1}' },
    })).not.toBe(first);
    expect(metroEnvironmentFingerprint({
      env: { REGION: 'cn', MANIFEST: 'https://one.invalid' },
      files: { '.env': 'REGION=cn\n', 'scripts/self-host-regions.json': '{"cn":2}' },
    })).not.toBe(first);
  });
});

describe('Windows process snapshot', () => {
  it.each([false, true])('parses CIM identity output (array=%s)', (array) => {
    const process = { ProcessId: 100, ParentProcessId: 1, StartedAtMs: 1000 };
    const run = vi.fn(() => JSON.stringify(array ? [process] : process));
    expect(windowsProcessSnapshot(run)).toEqual([launcher]);
    expect(run).toHaveBeenCalledWith('powershell.exe', expect.any(Array), expect.objectContaining({
      timeout: 5000, windowsHide: true,
    }));
  });

  it('fails closed when process inspection fails or returns malformed output', () => {
    expect(windowsProcessSnapshot(() => { throw new Error('timeout'); })).toEqual([]);
    expect(windowsProcessSnapshot(() => 'invalid json')).toEqual([]);
    expect(windowsProcessSnapshot(() => 'null')).toEqual([]);
  });
});
