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
 * kill 后必须自备"强制 settle"计时兜底。安全敏感的严格模式不使用
 * taskkill:Windows 没有可从纯 Node/TypeScript 原子绑定整棵后代树的接口,因此只
 * 通过 ChildProcess 持有的原始进程句柄终止直接子进程,并故意不触发 onSettled,
 * 让调用方的共享锁保持 fail closed,直到应用重启或未来接入启动时 Job Object。
 */
const WIN32_TASKKILL_MAX_ATTEMPTS = 3;
const WIN32_TASKKILL_RETRY_DELAY_MS = 150;

export interface KillProcessTreeOptions {
  /**
   * Security-sensitive stores must not send taskkill to a reusable numeric PID.
   * Strict mode terminates only the original ChildProcess handle and deliberately
   * withholds onSettled because pure Node cannot prove every descendant is gone.
   * The default keeps the generic, best-effort cleanup behavior.
   */
  requireWindowsIdentityBoundTermination?: boolean;
}

function childExited(child: ChildProcess): boolean {
  return typeof child.exitCode === 'number' || typeof child.signalCode === 'string';
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

/**
 * Windows 的 ChildProcess 持有原始进程句柄，kill 不会命中复用后的同号 PID。
 * 纯 Node 没有启动时 Job Object，也无法原子证明整棵后代树都归属该句柄；安全
 * 敏感调用方因此只终止直接子进程且永不回调 settled，让共享锁保持 fail closed。
 */
function killWindowsIdentityBoundFailClosed(child: ChildProcess): void {
  if (!childExited(child)) killDirectChild(child);
}

/**
 * @param onSettled 可选:本函数已经完成安全的树杀与必要确认时调用一次。调用方
 *   应该**只在这个回调里**武装"强制 settle"
 *   计时器,不要在调用 killProcessTree 后立即武装——否则计时器和收敛动作并行
 *   赛跑,大概率在真正收敛前就抢跑判定超时。Windows 严格模式故意不回调,
 *   因为没有 Job Object 时无法安全证明后代树已静止。
 */
export function killProcessTree(
  pid: number | undefined,
  child: ChildProcess,
  onSettled?: () => void,
  options: KillProcessTreeOptions = {},
): void {
  if (process.platform === 'win32' && pid) {
    if (options.requireWindowsIdentityBoundTermination) {
      killWindowsIdentityBoundFailClosed(child);
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
