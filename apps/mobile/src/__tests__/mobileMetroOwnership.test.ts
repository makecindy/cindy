import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { metroEnvironmentFingerprint, probeMetroOwnership, windowsProcessSnapshot } from '../../scripts/sim-metro.mjs';
import { classifySimMetroListener, inspectSimMetroIdentity, resolveSimMetroHandoff } from '../../scripts/lib/sim-whoami.mjs';

const worktreeRoot = join('/worktrees', 'metro-owner');
const owner = { pid: 100, launcherPid: 100, worktreeRoot, source: 'branch@commit', recordedAtMs: 1500,
  envFingerprint: 'env-1' };
type ProcessEntry = { pid: number; parentPid: number; startedAtMs: number };
const launcher = { pid: 100, parentPid: 1, startedAtMs: 1000 };
const wrapper = { pid: 200, parentPid: 100, startedAtMs: 1100 };
const listener = { pid: 300, parentPid: 200, startedAtMs: 1200 };

// PR #7814 discussion_r4409775119: listener discovery coverage did not reach
// command/cwd/source timeouts. Call the importable whoami receipt entry with
// injected process I/O (unit): errors must reach its receipt and suppress the
// start hint, without reading or evaluating production source as text.
const target = { ports: [8081], expectedPort: 8081, worktreeRoot,
  expectedSource: owner.source, region: 'global', envFingerprint: 'env-1' };

describe('whoami Metro identity probe failures', () => {
  it.each(['command', 'cwd', 'source', 'process-snapshot'])('reports %s timeout without suggesting another Metro', (failedStage) => {
    const result = inspectSimMetroIdentity(target, {
      inspectListeners: () => ({ healthy: true, code: 'ready', pids: { 8081: '300' } }),
      probeOwnership: (port: number, options: object = {}) => probeMetroOwnership(port, {
        ...options, platform: failedStage === 'process-snapshot' ? 'win32' : 'darwin', readOwner: () => owner,
        execFile: (command: string, args: string[]) => {
          const stage = command === 'powershell.exe' ? 'process-snapshot'
            : command === 'lsof' ? 'cwd' : args.includes('-E') ? 'source' : 'command';
          if (stage === failedStage) throw Object.assign(new Error('private child output'), { code: 'ETIMEDOUT', stderr: 'private environment' });
          if (stage === 'command') return 'node expo start';
          if (stage === 'cwd') return `p300\nn${join(worktreeRoot, 'apps/mobile')}\n`;
          return `EXPO_PUBLIC_XDT_GIT_SOURCE=${owner.source}`;
        },
      }),
    });
    expect(result.healthy).toBe(false);
    expect(result.probeErrors).toEqual([expect.objectContaining({ port: 8081, stage: failedStage, code: 'METRO_PROCESS_TIMEOUT' })]);
    expect(result.metros[0].identity.healthy).toBe(false);
    expect(result.canSuggestStart).toBe(false);
    expect(JSON.stringify(result)).not.toContain('private');
  });

  // Preserve the other receipt outcomes while extracting the CLI logic (#7814
  // discussion_r4409904097); old timeout cases alone could pass if every result
  // were incorrectly unhealthy or every start hint were disabled.
  it.each([
    ['empty ports', true, false, false, true],
    ['failed discovery', false, false, false, false],
    ['matching Metro', true, true, true, false],
  ] as const)('preserves %s', (_name, discoveryHealthy, hasMetro, healthy, canSuggestStart) => {
    const result = inspectSimMetroIdentity(target, {
      inspectListeners: () => ({ healthy: discoveryHealthy, code: discoveryHealthy ? 'ready' : 'METRO_LISTENERS_TIMEOUT',
        pids: hasMetro ? { 8081: '300' } : {} }),
      probeOwnership: () => ({ pid: '300', cwd: join(worktreeRoot, 'apps/mobile'), source: owner.source,
        region: 'global', envFingerprint: 'env-1' }),
    });
    expect(result).toMatchObject({ healthy, canSuggestStart, anyMetro: hasMetro, currentSourceOnExpectedPort: hasMetro });
    expect(result.probeErrors).toEqual(discoveryHealthy ? [] : [{ stage: 'metro-listeners', code: 'METRO_LISTENERS_TIMEOUT' }]);
  });
});

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


it('rejects a non-Metro Unix listener before trusting persisted owner metadata', () => {
  const readOwner = vi.fn(() => owner);
  expect(probeMetroOwnership(8081, {
    platform: 'darwin', listenerPid: () => '300', isMetroPid: () => false, readOwner,
  })).toEqual({ pid: '300', cwd: null, source: null });
  expect(readOwner).not.toHaveBeenCalled();
});
