import { describe, expect, it, vi } from 'vitest';

import { buildChildrenByParent, type OsProcessRow, type OsProcessSnapshot } from '../agent-scan.js';
import { terminateSafePosixProcessTree } from '../safe-posix-process-tree.js';

function row(pid: number, ppid: number, state = 'T'): OsProcessRow {
  return {
    pid,
    ppid,
    state,
    cmdLineLower: `process-${pid}`,
    memoryKb: 0,
    cpuPercent: 0,
    cpuTimeMs: null,
    startIdentity: `start:${pid}`,
  };
}

function snapshot(rows: OsProcessRow[]): OsProcessSnapshot {
  return { rows, childrenByParent: buildChildrenByParent(rows) };
}

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}

describe('terminateSafePosixProcessTree', () => {
  it('逐层确认停止状态，纳入暂停投递期间新出现的孙进程并后代优先终止', () => {
    const scans = [
      snapshot([row(100, 10, 'T'), row(101, 100, 'S'), row(200, 1, 'R')]),
      snapshot([row(100, 10, 'T'), row(101, 100, 'T'), row(102, 101, 'S')]),
      snapshot([row(100, 10, 'T'), row(101, 100, 'T'), row(102, 101, 'T')]),
    ];
    const scan = vi.fn(() => scans.shift()!);
    const signal = vi.fn();

    expect(
      terminateSafePosixProcessTree({
        rootPid: 100,
        rootStartIdentity: 'start:100',
        rootStateBeforeStop: 'S',
        scan,
        signal,
        isExpectedRoot: (candidate) => candidate.ppid === 10,
      }),
    ).toBe('terminated');
    expect(signal.mock.calls).toEqual([
      [100, 'SIGSTOP'],
      [101, 'SIGSTOP'],
      [102, 'SIGSTOP'],
      [102, 'SIGKILL'],
      [101, 'SIGKILL'],
      [100, 'SIGKILL'],
    ]);
  });

  it('根进程消失或暂停后身份不再匹配时 fail closed', () => {
    const missingSignal = vi.fn(() => {
      throw errno('ESRCH');
    });
    expect(
      terminateSafePosixProcessTree({
        rootPid: 100,
        rootStartIdentity: 'start:100',
        rootStateBeforeStop: 'S',
        scan: vi.fn(),
        signal: missingSignal,
        isExpectedRoot: () => true,
      }),
    ).toBe('root-not-found');

    const changedSignal = vi.fn();
    expect(
      terminateSafePosixProcessTree({
        rootPid: 100,
        rootStartIdentity: 'start:100',
        rootStateBeforeStop: 'S',
        scan: () => snapshot([row(100, 999, 'T')]),
        signal: changedSignal,
        isExpectedRoot: (candidate) => candidate.ppid === 10,
      }),
    ).toBe('root-not-found');
    expect(changedSignal.mock.calls).toEqual([
      [100, 'SIGSTOP'],
      [100, 'SIGCONT'],
    ]);
  });

  it.each(['S', 'T'])(
    '根进程原状态为 %s 但 PID 已被新实例复用时不向替代进程发 SIGCONT',
    (rootStateBeforeStop) => {
      const replacement = row(100, 10, 'T');
      replacement.startIdentity = 'start:replacement';
      const signal = vi.fn();

      expect(
        terminateSafePosixProcessTree({
          rootPid: 100,
          rootStartIdentity: 'start:original',
          rootStateBeforeStop,
          scan: () => snapshot([replacement]),
          signal,
          isExpectedRoot: (candidate) => candidate.startIdentity === 'start:original',
        }),
      ).toBe('root-not-found');
      expect(signal.mock.calls).toEqual([[100, 'SIGSTOP']]);
    },
  );

  it('SIGSTOP 后根或子进程仍在运行时拒绝枚举/终止并恢复已暂停节点', () => {
    const rootSignal = vi.fn();
    expect(() =>
      terminateSafePosixProcessTree({
        rootPid: 100,
        rootStartIdentity: 'start:100',
        rootStateBeforeStop: 'S',
        scan: () => snapshot([row(100, 10, 'R'), row(101, 100, 'S')]),
        signal: rootSignal,
        isExpectedRoot: () => true,
      }),
    ).toThrow('process did not enter stopped state: 100');
    expect(rootSignal.mock.calls).toEqual([
      [100, 'SIGSTOP'],
      [100, 'SIGCONT'],
    ]);

    const childScans = [
      snapshot([row(100, 10, 'T'), row(101, 100, 'S')]),
      snapshot([row(100, 10, 'T'), row(101, 100, 'S')]),
    ];
    const childSignal = vi.fn();
    expect(() =>
      terminateSafePosixProcessTree({
        rootPid: 100,
        rootStartIdentity: 'start:100',
        rootStateBeforeStop: 'S',
        scan: () => childScans.shift()!,
        signal: childSignal,
        isExpectedRoot: () => true,
      }),
    ).toThrow('process did not enter stopped state: 101');
    expect(childSignal.mock.calls).toEqual([
      [100, 'SIGSTOP'],
      [101, 'SIGSTOP'],
      [101, 'SIGCONT'],
      [100, 'SIGCONT'],
    ]);
  });

  it('子进程在暂停前退出且仍有已知后代时失败关闭并恢复根进程', () => {
    const scan = vi.fn(() => snapshot([row(100, 10, 'T'), row(101, 100, 'S'), row(102, 101, 'S')]));
    const signal = vi.fn((pid: number, processSignal: NodeJS.Signals) => {
      if (pid === 101 && processSignal === 'SIGSTOP') throw errno('ESRCH');
    });

    expect(() =>
      terminateSafePosixProcessTree({
        rootPid: 100,
        rootStartIdentity: 'start:100',
        rootStateBeforeStop: 'S',
        scan,
        signal,
        isExpectedRoot: () => true,
      }),
    ).toThrow('process exited before its descendants could be frozen: 101');
    expect(signal.mock.calls).toEqual([
      [100, 'SIGSTOP'],
      [101, 'SIGSTOP'],
      [100, 'SIGCONT'],
    ]);
    expect(scan).toHaveBeenCalledTimes(1);
  });

  it('旧快照没有后代时，子进程在暂停前退出仍失败关闭', () => {
    const scan = vi.fn(() => snapshot([row(100, 10, 'T'), row(101, 100, 'S')]));
    const signal = vi.fn((pid: number, processSignal: NodeJS.Signals) => {
      if (pid === 101 && processSignal === 'SIGSTOP') throw errno('ESRCH');
    });

    expect(() =>
      terminateSafePosixProcessTree({
        rootPid: 100,
        rootStartIdentity: 'start:100',
        rootStateBeforeStop: 'S',
        scan,
        signal,
        isExpectedRoot: () => true,
      }),
    ).toThrow('process exited before its descendants could be frozen: 101');
    expect(signal.mock.calls).toEqual([
      [100, 'SIGSTOP'],
      [101, 'SIGSTOP'],
      [100, 'SIGCONT'],
    ]);
    expect(scan).toHaveBeenCalledTimes(1);
  });

  it('扫描或 KILL 硬失败时恢复所有已确认暂停的进程', () => {
    const scanError = new Error('ps failed');
    const scanSignal = vi.fn();
    expect(() =>
      terminateSafePosixProcessTree({
        rootPid: 100,
        rootStartIdentity: 'start:100',
        rootStateBeforeStop: 'S',
        scan: () => {
          throw scanError;
        },
        signal: scanSignal,
        isExpectedRoot: () => true,
      }),
    ).toThrow(scanError);
    expect(scanSignal.mock.calls).toEqual([
      [100, 'SIGSTOP'],
      [100, 'SIGCONT'],
    ]);

    const scans = [
      snapshot([row(100, 10, 'T'), row(101, 100, 'S')]),
      snapshot([row(100, 10, 'T'), row(101, 100, 'T')]),
    ];
    const killSignal = vi.fn((pid: number, processSignal: NodeJS.Signals) => {
      if (pid === 101 && processSignal === 'SIGKILL') throw new Error('kill denied');
    });
    expect(() =>
      terminateSafePosixProcessTree({
        rootPid: 100,
        rootStartIdentity: 'start:100',
        rootStateBeforeStop: 'S',
        scan: () => scans.shift()!,
        signal: killSignal,
        isExpectedRoot: () => true,
      }),
    ).toThrow('kill denied');
    expect(killSignal.mock.calls).toEqual([
      [100, 'SIGSTOP'],
      [101, 'SIGSTOP'],
      [101, 'SIGKILL'],
      [101, 'SIGCONT'],
      [100, 'SIGCONT'],
    ]);
  });

  it('失败时只恢复本次暂停的节点，不改变原本已暂停的根或子进程', () => {
    const scans = [
      snapshot([row(100, 10, 'T'), row(101, 100, 'T')]),
      snapshot([row(100, 10, 'T'), row(101, 100, 'T'), row(102, 101, 'S')]),
      snapshot([row(100, 10, 'T'), row(101, 100, 'T'), row(102, 101, 'R')]),
    ];
    const signal = vi.fn();

    expect(() =>
      terminateSafePosixProcessTree({
        rootPid: 100,
        rootStartIdentity: 'start:100',
        rootStateBeforeStop: 'T',
        scan: () => scans.shift()!,
        signal,
        isExpectedRoot: () => true,
      }),
    ).toThrow('process did not enter stopped state: 102');
    expect(signal.mock.calls).toEqual([
      [100, 'SIGSTOP'],
      [101, 'SIGSTOP'],
      [102, 'SIGSTOP'],
      [102, 'SIGCONT'],
    ]);
  });

  it('SIGCONT 非 ESRCH 失败时以 AggregateError 上报，不能静默留下冻结进程', () => {
    const signal = vi.fn((_pid: number, processSignal: NodeJS.Signals) => {
      if (processSignal === 'SIGCONT') throw errno('EPERM');
    });
    let thrown: unknown;
    try {
      terminateSafePosixProcessTree({
        rootPid: 100,
        rootStartIdentity: 'start:100',
        rootStateBeforeStop: 'S',
        scan: () => snapshot([row(100, 999, 'T')]),
        signal,
        isExpectedRoot: (candidate) => candidate.ppid === 10,
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(AggregateError);
    expect((thrown as AggregateError).errors).toHaveLength(1);
    expect(signal.mock.calls).toEqual([
      [100, 'SIGSTOP'],
      [100, 'SIGCONT'],
    ]);
  });

  it('确认快照形成环时不会重复暂停或死循环', () => {
    const scans = [
      snapshot([row(100, 102, 'T'), row(101, 100, 'S'), row(102, 101, 'S')]),
      snapshot([row(100, 102, 'T'), row(101, 100, 'T'), row(102, 101, 'S')]),
      snapshot([row(100, 102, 'T'), row(101, 100, 'T'), row(102, 101, 'T')]),
    ];
    const signal = vi.fn();

    expect(
      terminateSafePosixProcessTree({
        rootPid: 100,
        rootStartIdentity: 'start:100',
        rootStateBeforeStop: 'S',
        scan: () => scans.shift()!,
        signal,
        isExpectedRoot: () => true,
      }),
    ).toBe('terminated');
    expect(signal.mock.calls).toEqual([
      [100, 'SIGSTOP'],
      [101, 'SIGSTOP'],
      [102, 'SIGSTOP'],
      [102, 'SIGKILL'],
      [101, 'SIGKILL'],
      [100, 'SIGKILL'],
    ]);
  });
});
