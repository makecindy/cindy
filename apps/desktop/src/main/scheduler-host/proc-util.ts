/**
 * proc-util — scheduler-host 内共享的子进程/输出小工具
 * ---------------------------------------------------------------------------
 * pre-run-hook(前置检查)与 script-runner(仅运行脚本)各自维护过一份同语义
 * 拷贝,review 后收敛到这里:跨平台树杀的平台坑只修一处。
 */
import { spawn, type ChildProcess } from 'node:child_process';

/** 带上限的字符串累加:超出 cap 的部分截断丢弃(stderr/stdout 采集用)。 */
export function capAppend(current: string, chunk: string, cap: number): string {
  if (current.length >= cap) return current;
  const remain = cap - current.length;
  return chunk.length > remain ? current + chunk.slice(0, remain) : current + chunk;
}

/**
 * 平台差异化的"杀干净":Windows `taskkill /T` 树杀(detached 组杀不可用,
 * taskkill 是唯一可靠树杀,/T 连 cmd.exe → python → ... 孙子一起);POSIX 对
 * **进程组**发 SIGKILL(spawn 时 detached:true 让 shell 自成组长,`kill(-pid)`
 * 连孙子一起——只 kill shell 会漏成后台孤儿)。失败静默(进程可能已退出)。
 *
 * ⚠️ taskkill 是异步 fire-and-forget,调用方**不能**假设 close 一定跟上——
 * kill 后必须自备"强制 settle"计时兜底。**该计时不能与本函数并行起跑**:
 * 必须等 `onSettled` 回调触发(严格模式下还包括存活期身份快照的只读消失确认)
 * 才去武装,否则会在收敛动作真正生效前抢跑。
 */
const WIN32_TASKKILL_MAX_ATTEMPTS = 3;
const WIN32_TASKKILL_RETRY_DELAY_MS = 150;

export interface KillProcessTreeOptions {
  /**
   * Security-sensitive stores may not release their lock until a process-tree
   * snapshot captured while the direct child was alive has been confirmed gone.
   * The default keeps the generic, best-effort cleanup behavior.
   */
  requireWindowsDescendantConfirmation?: boolean;
}

const WIN32_PROCESS_QUERY_TIMEOUT_MS = 3_000;
const WIN32_SNAPSHOT_CONFIRM_RETRY_DELAY_MS = 150;
const WIN32_SNAPSHOT_CONFIRM_MAX_UNAVAILABLE_ATTEMPTS = 3;

interface Win32ProcessRow {
  pid: number;
  ppid: number;
  created: string;
}

interface Win32TreeSnapshot {
  rootIdentity: string;
  identities: Set<string>;
}

function childExited(child: ChildProcess): boolean {
  return typeof child.exitCode === 'number' || typeof child.signalCode === 'string';
}

function win32ProcessIdentity(row: Pick<Win32ProcessRow, 'pid' | 'created'>): string {
  return `${row.pid}:${row.created}`;
}

/**
 * Windows 严格收尾只使用完整进程表做**只读身份观察**。PID 与 CreationDate
 * 组成稳定身份；父 PID 被复用时，新进程不会匹配旧快照，也绝不会成为 kill 目标。
 */
function queryWindowsProcessTable(onResult: (rows: Win32ProcessRow[] | null) => void): void {
  let finished = false;
  let query: ChildProcess | undefined;
  const finish = (rows: Win32ProcessRow[] | null): void => {
    if (finished) return;
    finished = true;
    clearTimeout(watchdog);
    onResult(rows);
  };
  const watchdog = setTimeout(() => {
    try {
      query?.kill();
    } catch {
      /* 查询进程已经结束 */
    }
    finish(null);
  }, WIN32_PROCESS_QUERY_TIMEOUT_MS);
  watchdog.unref?.();
  try {
    query = spawn(
      'powershell',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId)`t$($_.ParentProcessId)`t$($_.CreationDate)" }',
      ],
      { windowsHide: true },
    );
    let output = '';
    query.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
    });
    query.on('close', (code) => {
      if (finished) return;
      if (code !== 0) {
        finish(null);
        return;
      }
      const rows = output.split(/\r?\n/).flatMap((line) => {
        const [pidText, ppidText, created = ''] = line.trim().split('\t');
        const pid = Number(pidText);
        const ppid = Number(ppidText);
        return Number.isInteger(pid) && Number.isInteger(ppid) && created
          ? [{ pid, ppid, created }]
          : [];
      });
      finish(rows);
    });
    query.on('error', () => finish(null));
  } catch {
    finish(null);
  }
}

function captureWindowsTreeWhileParentLives(
  pid: number,
  child: ChildProcess,
  previous: Win32TreeSnapshot | undefined,
  onCaptured: (snapshot: Win32TreeSnapshot) => void,
  onUnavailable: () => void,
): void {
  if (childExited(child)) {
    onUnavailable();
    return;
  }
  queryWindowsProcessTable((rows) => {
    if (!rows || childExited(child)) {
      onUnavailable();
      return;
    }
    const root = rows.find((row) => row.pid === pid);
    if (!root) {
      onUnavailable();
      return;
    }
    const rootIdentity = win32ProcessIdentity(root);
    if (previous && previous.rootIdentity !== rootIdentity) {
      onUnavailable();
      return;
    }
    const identities = new Set(previous?.identities ?? []);
    identities.add(rootIdentity);
    const treePids = new Set<number>([pid]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const row of rows) {
        if (!treePids.has(row.ppid) || treePids.has(row.pid)) continue;
        treePids.add(row.pid);
        identities.add(win32ProcessIdentity(row));
        grew = true;
      }
    }
    onCaptured({ rootIdentity, identities });
  });
}

function confirmWindowsSnapshotGone(
  snapshot: Win32TreeSnapshot,
  onSettled?: () => void,
  unavailableAttempts = 0,
): void {
  queryWindowsProcessTable((rows) => {
    const retry = (nextUnavailableAttempts: number): void => {
      if (nextUnavailableAttempts >= WIN32_SNAPSHOT_CONFIRM_MAX_UNAVAILABLE_ATTEMPTS) {
        // 进程表连续不可用时，无法证明共享 store 已安全静止。明确终止
        // 观察但不调用 onSettled，让安全敏感调用方保持 fail closed。
        return;
      }
      setTimeout(
        () => confirmWindowsSnapshotGone(snapshot, onSettled, nextUnavailableAttempts),
        WIN32_SNAPSHOT_CONFIRM_RETRY_DELAY_MS,
      ).unref?.();
    };
    if (!rows) {
      retry(unavailableAttempts + 1);
      return;
    }
    const present = new Set(rows.map(win32ProcessIdentity));
    if ([...snapshot.identities].every((identity) => !present.has(identity))) {
      onSettled?.();
      return;
    }
    retry(0);
  });
}

function killDirectChild(child: ChildProcess): void {
  try {
    child.kill('SIGKILL');
  } catch {
    /* 进程已退出 */
  }
}

/** 普通调用方使用有限 taskkill 重试；父进程退出后绝不再按其 PID 查杀后代。 */
function killWindowsTreeBestEffort(
  pid: number,
  child: ChildProcess,
  attempt: number,
  onSettled?: () => void,
): void {
  if (childExited(child)) {
    onSettled?.();
    return;
  }
  try {
    const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
    let attemptFinished = false;
    const onFailure = (): void => {
      if (attemptFinished) return;
      attemptFinished = true;
      if (childExited(child)) {
        onSettled?.();
        return;
      }
      if (attempt < WIN32_TASKKILL_MAX_ATTEMPTS) {
        setTimeout(
          () => killWindowsTreeBestEffort(pid, child, attempt + 1, onSettled),
          WIN32_TASKKILL_RETRY_DELAY_MS,
        ).unref?.();
      } else {
        killDirectChild(child);
        onSettled?.();
      }
    };
    killer.on('exit', (code) => {
      if (code !== 0) {
        onFailure();
        return;
      }
      if (attemptFinished) return;
      attemptFinished = true;
      onSettled?.();
    });
    killer.on('error', onFailure);
  } catch {
    killDirectChild(child);
    onSettled?.();
  }
}

function confirmSnapshotAfterDirectExit(
  child: ChildProcess,
  snapshot: Win32TreeSnapshot,
  onSettled?: () => void,
): void {
  const confirm = (): void => confirmWindowsSnapshotGone(snapshot, onSettled);
  if (childExited(child)) {
    confirm();
    return;
  }
  child.once('exit', confirm);
  if (childExited(child)) {
    child.removeListener('exit', confirm);
    confirm();
  }
}

function killWindowsTreeConfirmedAttempt(
  pid: number,
  child: ChildProcess,
  snapshot: Win32TreeSnapshot,
  attempt: number,
  onSettled?: () => void,
): void {
  if (childExited(child)) {
    confirmWindowsSnapshotGone(snapshot, onSettled);
    return;
  }
  try {
    const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
    let attemptFinished = false;
    const onFailure = (): void => {
      if (attemptFinished) return;
      attemptFinished = true;
      if (childExited(child)) {
        confirmWindowsSnapshotGone(snapshot, onSettled);
        return;
      }
      if (attempt < WIN32_TASKKILL_MAX_ATTEMPTS) {
        setTimeout(() => {
          captureWindowsTreeWhileParentLives(
            pid,
            child,
            snapshot,
            (refreshed) =>
              killWindowsTreeConfirmedAttempt(pid, child, refreshed, attempt + 1, onSettled),
            () => {
              // 父进程已退出、PID 身份变化或进程表不可用时，不能再对这个
              // 数字 PID 动手。Node ChildProcess 保留原进程句柄，可安全终止
              // 直接子进程；之后仅凭已捕获的稳定身份做只读消失确认。
              if (!childExited(child)) killDirectChild(child);
              confirmWindowsSnapshotGone(snapshot, onSettled);
            },
          );
        }, WIN32_TASKKILL_RETRY_DELAY_MS).unref?.();
        return;
      }
      // 最后一次 taskkill 失败时仍持有经存活期刷新过的身份快照。只终止 Node
      // 直接子进程；其 exit 后按稳定身份只读确认，不枚举或杀任何 PID。
      confirmSnapshotAfterDirectExit(child, snapshot, onSettled);
      killDirectChild(child);
    };
    killer.on('exit', (code) => {
      if (code !== 0) {
        onFailure();
        return;
      }
      if (attemptFinished) return;
      attemptFinished = true;
      confirmWindowsSnapshotGone(snapshot, onSettled);
    });
    killer.on('error', onFailure);
  } catch {
    // spawn 本身失败时身份仍已确认，但没有安全的树杀动作；直接子进程退出后
    // 只读核验快照。核验不可用或仍有成员存活时保持 fail closed。
    confirmSnapshotAfterDirectExit(child, snapshot, onSettled);
    killDirectChild(child);
  }
}

/**
 * 严格调用方先在原始子进程存活时捕获 PID+CreationDate 树快照，再执行树杀。
 * 后续只核验已捕获身份是否消失，绝不拿已释放的父 PID 枚举或杀新进程。
 */
function killWindowsTreeConfirmed(pid: number, child: ChildProcess, onSettled?: () => void): void {
  let settled = false;
  const settleOnce = (): void => {
    if (settled) return;
    settled = true;
    onSettled?.();
  };
  captureWindowsTreeWhileParentLives(
    pid,
    child,
    undefined,
    (snapshot) => killWindowsTreeConfirmedAttempt(pid, child, snapshot, 1, settleOnce),
    () => {
      // 无法证明 PID 仍属于原始子进程时不再对数字 PID 发 taskkill。只使用
      // Node 保存的原进程句柄终止直接子进程，并保持安全锁 fail closed。
      if (!childExited(child)) killDirectChild(child);
    },
  );
}

/**
 * @param onSettled 可选:本函数已经完成安全的树杀与必要确认时调用一次。调用方
 *   应该**只在这个回调里**武装"强制 settle"
 *   计时器,不要在调用 killProcessTree 后立即武装——否则计时器和收敛动作并行
 *   赛跑,大概率在真正收敛前就抢跑判定超时(Greptile review)。
 */
export function killProcessTree(
  pid: number | undefined,
  child: ChildProcess,
  onSettled?: () => void,
  options: KillProcessTreeOptions = {},
): void {
  if (process.platform === 'win32' && pid) {
    if (options.requireWindowsDescendantConfirmation) {
      killWindowsTreeConfirmed(pid, child, onSettled);
    } else {
      killWindowsTreeBestEffort(pid, child, 1, onSettled);
    }
    return;
  }
  if (process.platform !== 'win32' && pid) {
    try {
      process.kill(-pid, 'SIGKILL');
      onSettled?.();
      return;
    } catch {
      /* 进程组已不存在,回落单进程 kill */
    }
  }
  try {
    child.kill('SIGKILL');
  } catch {
    /* 进程已退出 */
  }
  onSettled?.();
}
