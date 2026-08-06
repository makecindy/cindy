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
          // SIGSTOP 与复核之间若根 PID 已被另一实例复用，rootStateBeforeStop 属于旧
          // Agent，不能据此判断替代进程原本是否暂停。只要替代实例仍存在，就必须
          // SIGCONT 撤销我们刚发出的 SIGSTOP，避免把未授权进程永久冻结。
          if (
            current &&
            current.startIdentity !== expected.startIdentity &&
            !resumeOnFailurePids.includes(rootPid)
          ) {
            resumeOnFailurePids.push(rootPid);
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
            // 父进程已经暂停；ESRCH 表示子进程已退出，其 PID 仍不会被该父进程
            // reap/reuse。无需把它加入待 kill 集合。
            if (isMissingProcess(error)) continue;
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
