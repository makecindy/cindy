/**
 * 安全终止 POSIX Agent 进程树。
 *
 * 普通 `ps` 快照不能直接拿来逐 PID kill：后代可能在扫描后退出并被父进程
 * reap，原 PID 随后可被无关进程复用。这里先 SIGSTOP 已验证根进程，再按层
 * 枚举并暂停直属子进程；每层必须由后续 ps stat 确认 T/Z 后才继续。父进程保持
 * 暂停时，子进程即使退出也只能保持 zombie，PID 不会被回收复用；因此随后对
 * 这批已冻结 PID 发 SIGKILL 不会越过归属边界。
 */

import type { OsProcessRow, OsProcessSnapshot } from './agent-scan.js';

export type SafePosixTreeTerminationResult = 'terminated' | 'root-not-found';

export interface SafePosixTreeTerminationOptions {
  rootPid: number;
  /** 终止请求重新扫描时确认的根进程出生身份。 */
  rootStartIdentity: string;
  rootStateBeforeStop: string | null;
  scan(): OsProcessSnapshot;
  signal(pid: number, signal: NodeJS.Signals): void;
  isExpectedRoot(row: OsProcessRow): boolean;
}

function isMissingProcess(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'ESRCH';
}

function isPosixStoppedOrZombie(state: string | null): boolean {
  return state != null && /^[TZ]/.test(state);
}

function resumeStoppedProcesses(
  stoppedPids: readonly number[],
  signal: SafePosixTreeTerminationOptions['signal'],
): unknown[] {
  const errors: unknown[] = [];
  for (let index = stoppedPids.length - 1; index >= 0; index -= 1) {
    try {
      signal(stoppedPids[index]!, 'SIGCONT');
    } catch (error) {
      if (!isMissingProcess(error)) errors.push(error);
    }
  }
  return errors;
}

interface FrozenProcessIdentity {
  pid: number;
  ppid: number;
  startIdentity: string;
  root: boolean;
}

export function terminateSafePosixProcessTree(
  opts: SafePosixTreeTerminationOptions,
): SafePosixTreeTerminationResult {
  const { rootPid, rootStartIdentity, rootStateBeforeStop, scan, signal, isExpectedRoot } = opts;
  const stoppedPids: number[] = [];
  const resumeOnFailurePids: number[] = [];
  const seen = new Set<number>([rootPid]);
  let completed = false;
  let result: SafePosixTreeTerminationResult | undefined;
  let primaryError: unknown;
  let failed = false;

  const execute = (): SafePosixTreeTerminationResult => {
    try {
      signal(rootPid, 'SIGSTOP');
    } catch (error) {
      if (isMissingProcess(error)) return 'root-not-found';
      throw error;
    }
    stoppedPids.push(rootPid);
    if (!isPosixStoppedOrZombie(rootStateBeforeStop)) resumeOnFailurePids.push(rootPid);

    let frontier: FrozenProcessIdentity[] = [
      { pid: rootPid, ppid: -1, startIdentity: rootStartIdentity, root: true },
    ];
    while (frontier.length > 0) {
      const snapshot = scan();
      const rowsByPid = new Map(snapshot.rows.map((row) => [row.pid, row]));
      const nextFrontier: FrozenProcessIdentity[] = [];

      for (const expected of frontier) {
        const current = rowsByPid.get(expected.pid);
        if (expected.root && (!current || !isExpectedRoot(current))) {
          // 复核时若根 PID 已是另一个出生身份，就不能再对该 PID 发 SIGCONT：
          // SIGSTOP 可能命中的是随后退出的旧实例，而当前 PID 已属于未授权替代进程。
          // 从恢复集合移除根 PID，保持失败关闭，避免跨越进程归属边界。
          if (current && current.startIdentity !== expected.startIdentity) {
            const recoveryIndex = resumeOnFailurePids.indexOf(rootPid);
            if (recoveryIndex >= 0) resumeOnFailurePids.splice(recoveryIndex, 1);
          }
          return 'root-not-found';
        }
        if (
          !current ||
          (!expected.root &&
            (current.ppid !== expected.ppid || current.startIdentity !== expected.startIdentity))
        ) {
          throw new Error(`stopped process identity changed before confirmation: ${expected.pid}`);
        }
        if (!isPosixStoppedOrZombie(current.state)) {
          throw new Error(`process did not enter stopped state: ${expected.pid}`);
        }
      }

      for (const parent of frontier) {
        for (const childPid of snapshot.childrenByParent.get(parent.pid) ?? []) {
          if (seen.has(childPid)) continue;
          const child = rowsByPid.get(childPid);
          if (!child || child.ppid !== parent.pid || !child.startIdentity) continue;

          try {
            signal(childPid, 'SIGSTOP');
          } catch (error) {
            if (isMissingProcess(error)) {
              // 子进程可能在本次快照之后 fork 后代再退出；即使旧快照里没有
              // 已知后代，也不能证明该分支已清空。父链失效后必须失败关闭，
              // 由外层恢复已冻结进程，等待用户基于新鲜归属快照重试。
              throw new Error(`process exited before its descendants could be frozen: ${childPid}`);
            }
            throw error;
          }

          seen.add(childPid);
          stoppedPids.push(childPid);
          if (!isPosixStoppedOrZombie(child.state)) resumeOnFailurePids.push(childPid);
          nextFrontier.push({
            pid: childPid,
            ppid: parent.pid,
            startIdentity: child.startIdentity,
            root: false,
          });
        }
      }

      frontier = nextFrontier;
    }

    // 后代优先、根最后。所有目标仍处于 SIGSTOP，父链不会在 kill 过程中主动
    // reap 子进程，因此不会出现“杀到一半 PID 被复用”的窗口。
    for (let index = stoppedPids.length - 1; index >= 0; index -= 1) {
      try {
        signal(stoppedPids[index]!, 'SIGKILL');
      } catch (error) {
        if (!isMissingProcess(error)) throw error;
      }
    }

    return 'terminated';
  };

  try {
    result = execute();
    completed = result === 'terminated';
  } catch (error) {
    failed = true;
    primaryError = error;
  }

  if (!completed) {
    const recoveryErrors = resumeStoppedProcesses(resumeOnFailurePids, signal);
    if (recoveryErrors.length > 0) {
      throw new AggregateError(
        failed ? [primaryError, ...recoveryErrors] : recoveryErrors,
        'failed to recover stopped POSIX processes',
      );
    }
  }
  if (failed) throw primaryError;
  return result!;
}
