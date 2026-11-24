/**
 * Unit tier. Inject the process table through the production reaper interface;
 * the Host diagnostics integration sends real signals to owned test processes.
 * A valid ancestry alone cannot authorize a signal if the app-server's
 * registration was retired while the reaper checked that ancestry.
 */
import { ChildProcess } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { reapCodexToolTreesSync, type CodexProcessSampler } from '../codex-tool-tree-reaper';
import {
  _resetCodexProcessRegistryForTests,
  registerCodexProcessRole,
} from '../process-monitor/codex-process-registry';

const logger = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn() }));
vi.mock('../logger', () => ({ createLogger: () => logger }));

const platform = process.platform;
const root = 900100;
const tool = 900101;
const child = 900102;
const neighbour = 900103;

function spawned(pid: number): ChildProcess {
  return Object.assign(new ChildProcess(), { pid, spawnfile: 'unit-fixture' });
}

function processTable(
  allRows: ReadonlyArray<readonly [number, number]>,
  currentRows = allRows,
): ReturnType<typeof vi.fn<CodexProcessSampler>> {
  return vi.fn<CodexProcessSampler>(query => {
    const rows = query.kind === 'all' ? allRows : query.kind === 'parents'
      ? currentRows.filter(([pid]) => query.pids.includes(pid))
      : currentRows.filter(([, ppid]) => ppid === query.parentPid);
    const stdout = query.kind === 'children' ? rows.map(([pid]) => pid).join('\n')
      : rows.map(([pid, ppid]) => pid + ' ' + ppid).join('\n');
    return { stdout, status: 0, signal: null };
  });
}

describe('reapCodexToolTreesSync', () => {
  afterEach(() => {
    _resetCodexProcessRegistryForTests();
    Object.defineProperty(process, 'platform', { value: platform, configurable: true });
    vi.restoreAllMocks();
    logger.warn.mockClear();
  });

  it('uses the live spawned handle as the root and rechecks the tail before each signal', () => {
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
    const rows = [[tool, root], [child, tool], [neighbour, process.pid]] as const;
    const sample = processTable(rows, [...rows, [root, process.pid]]);
    registerCodexProcessRole(root, 'task-host', spawned(root));

    expect(reapCodexToolTreesSync(sample)).toMatchObject({
      appServers: 1, killedToolTrees: 1, scanFailed: false, fallbackUsed: false, unreapedAppServers: 0,
    });
    expect(sample.mock.calls.map(([query]) => query)).toEqual([
      { kind: 'all' },
      { kind: 'parents', pids: [child, tool, root] },
      { kind: 'parents', pids: [tool, root] },
    ]);
    expect(kill.mock.calls).toEqual([[child, 'SIGKILL'], [tool, 'SIGKILL']]);
  });

  it('withholds signals when the re-read loses an ancestor', () => {
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
    const sample = processTable([[tool, root], [child, tool]],
      [[tool, neighbour], [child, tool], [root, process.pid]]);
    registerCodexProcessRole(root, 'task-host', spawned(root));

    expect(reapCodexToolTreesSync(sample)).toMatchObject({ killedToolTrees: 0, unreapedAppServers: 1 });
    expect(kill).not.toHaveBeenCalled();
  });

  it('withholds signals if the registration is retired during the parent re-read', () => {
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
    const unregister = registerCodexProcessRole(root, 'task-host', spawned(root));
    const readTable = processTable([[tool, root], [root, process.pid]]);
    const sample: CodexProcessSampler = (query, timeoutMs) => {
      const result = readTable(query, timeoutMs);
      if (query.kind === 'parents') unregister();
      return result;
    };

    expect(reapCodexToolTreesSync(sample)).toMatchObject({ killedToolTrees: 0, unreapedAppServers: 1 });
    expect(readTable.mock.calls.map(([query]) => query.kind)).toEqual(['all', 'parents']);
    expect(kill).not.toHaveBeenCalled();
  });

  it.each([
    ['an empty handle', new ChildProcess()],
    ['a PID without a handle', undefined],
    ['an exited child with a reused PID', Object.assign(spawned(root), { exitCode: 0 })],
    ['a child with a different PID', spawned(neighbour)],
  ])('does not scan for %s', (_name, handle) => {
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
    const sample = processTable([[tool, root], [root, process.pid]]);
    registerCodexProcessRole(root, 'task-host', handle);

    expect(reapCodexToolTreesSync(sample)).toMatchObject({ appServers: 0, killedToolTrees: 0, unreapedAppServers: 1 });
    expect(sample).not.toHaveBeenCalled();
    expect(kill).not.toHaveBeenCalled();
  });

  it('keeps Windows shutdown unchanged', () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    const sample = processTable([]);
    registerCodexProcessRole(root, 'task-host', spawned(root));
    expect(reapCodexToolTreesSync(sample)).toMatchObject({ appServers: 0, killedToolTrees: 0, unreapedAppServers: 0 });
    expect(sample).not.toHaveBeenCalled();
  });

  it('reserves time for a scoped fallback and reports scoped inspection failures', () => {
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
    const sample = vi.fn<CodexProcessSampler>((query, timeout) => {
      if (query.kind === 'all') {
        expect(timeout).toBeLessThanOrEqual(750);
        return { stdout: '', status: null, signal: 'SIGKILL', error: Object.assign(new Error(), { code: 'ETIMEDOUT' }) };
      }
      expect(timeout).toBeLessThanOrEqual(120);
      return { stdout: '', status: 2, signal: null };
    });
    registerCodexProcessRole(root, 'task-host', spawned(root));

    expect(reapCodexToolTreesSync(sample)).toMatchObject({
      appServers: 1, scanFailed: true, fallbackUsed: true, killedToolTrees: 0, unreapedAppServers: 1,
    });
    expect(sample.mock.calls.map(([query]) => query.kind)).toEqual(['all', 'children']);
    expect(logger.warn.mock.calls.map(([, event]) => event)).toEqual([
      expect.objectContaining({ code: 'CODEX_REAPER_SCAN_FAILED', query: 'all', durationMs: expect.any(Number),
        exitCode: null, signal: 'SIGKILL', reason: 'ETIMEDOUT' }),
      expect.objectContaining({ code: 'CODEX_REAPER_SCAN_FAILED', query: 'children', durationMs: expect.any(Number),
        exitCode: 2, signal: null }),
    ]);
    expect(kill).not.toHaveBeenCalled();
  });
});
