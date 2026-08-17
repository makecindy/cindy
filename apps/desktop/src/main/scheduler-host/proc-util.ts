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
 * kill 后必须自备"强制 settle"计时兜底(两处调用方都有)。**该计时不能与本函数
 * 并行起跑**:必须等 `onSettled` 回调触发(= 本函数已经把能试的手段都试完,包括
 * win32 下的重试与后代兜底)才去武装那个计时器,否则计时器在杀干净这套流程还没
 * 跑完时就已经开始倒数,大概率在收敛动作真正生效前就强制结束(Greptile 二次
 * review 发现:原实现杀完直接子进程就调 onSettled,后台异步的后代枚举/收敛
 * 完全不被等待)。
 */
const WIN32_TASKKILL_MAX_ATTEMPTS = 3;
const WIN32_TASKKILL_RETRY_DELAY_MS = 150;

export interface KillProcessTreeOptions {
  /**
   * Security-sensitive stores may not release their lock until Windows has
   * positively enumerated and reaped descendants, even when the direct child
   * has already exited. The default keeps the generic PID-reuse-safe behavior.
   */
  requireWindowsDescendantConfirmation?: boolean;
}

/**
 * 最后一层兜底,尽力而为:枚举 pid 的**直接子进程**,对每个单独发
 * `taskkill /T /F`——每个子进程自己的 /T 会级联杀掉它自己的后代,不需要我们
 * 自己递归遍历整棵树。用 PowerShell(`Get-CimInstance`)而非 wmic 枚举:wmic.exe
 * 在新版 Windows(11 24H2+ 默认镜像)已被移除,PowerShell 是官方替代、仍是受
 * 支持核心组件。失败(PowerShell 不可用/超时/无输出)静默跳过——不引入新的
 * 失败模式,退化到"只杀直接子进程"这条已有行为,不会比现状更差。
 *
 * 默认模式下,`onSettled` 在**这层兜底也跑完**(不论枚举成功与否、每个子进程
 * taskkill 是否成功)后调用。安全敏感调用方可要求正向确认；此时查询/终止失败
 * 不回调,让调用方继续持有仓库锁。⚠️ 反过来这层自己也不能无界等:PowerShell/CIM 查询卡死(从不
 * close/error)会让 onSettled 永远不触发,原本"强制 settle 防 fire() 挂死"的
 * 保护就在更深一层失效(codex review 四次发现)。看门狗按**阶段**武装而不是
 * 全链路共用一个 deadline:查询阶段 3s,查询返回、后代 taskkill 已发起后**重新
 * 武装** 3s——否则查询用掉大半窗口时,已在途的后代终止会被同一个 deadline 无条件
 * 掐断、绕过 remaining 计数提前 settle,调用方随即放锁,下一轮触发可能与残留
 * 脚本并发写(Greptile 五次 review 发现)。两段各自有界,总上界 6s,不回到无界等。
 */
const DESCENDANT_REAP_TIMEOUT_MS = 3_000;

function reapWindowsDescendantsBestEffort(
  pid: number,
  onSettled?: () => void,
  requireConfirmation = false,
): void {
  let finished = false;
  let query: ChildProcess | undefined;
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  function finish(confirmed = false): void {
    if (finished) return;
    finished = true;
    if (watchdog) clearTimeout(watchdog);
    if (confirmed || !requireConfirmation) onSettled?.();
  }
  const armWatchdog = (onExpire?: () => void): void => {
    if (watchdog) clearTimeout(watchdog);
    watchdog = setTimeout(() => {
      onExpire?.();
      finish();
    }, DESCENDANT_REAP_TIMEOUT_MS);
    watchdog.unref?.();
  };
  const queryDescendants = (onResult: (childPids: string[]) => void): void => {
    // 每次查询都有独立窗口。后代 taskkill 非零后的二次查询不能复用
    // 第一阶段已经消耗的 deadline，否则自然退出竞态仍可能误判成死锁。
    armWatchdog(() => {
      try {
        query?.kill();
      } catch {
        /* 已经没了 */
      }
    });
    try {
      query = spawn(
        'powershell',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `Get-CimInstance Win32_Process -Filter "ParentProcessId=${pid}" | Select-Object -ExpandProperty ProcessId`,
        ],
        { windowsHide: true },
      );
      let output = '';
      query.stdout?.on('data', (chunk: Buffer) => {
        output += chunk.toString('utf8');
      });
      query.on('close', (code) => {
        if (finished) return; // 查询看门狗已结算(被强杀后的 close 回声)
        if (code !== 0) {
          finish();
          return;
        }
        onResult(output
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter((line) => /^\d+$/.test(line)));
      });
      query.on('error', () => finish());
    } catch {
      finish();
    }
  };
  const inspectAndReap = (): void => {
    queryDescendants((childPids) => {
      if (childPids.length === 0) {
        finish(true);
        return;
      }
      // 阶段二:后代终止。重新武装完整窗口——taskkill 正常几十 ms 内退出,超过
      // 3s 本身就是病态;到点只停止等待(taskkill.exe 自己会退出,不需要强杀)。
      armWatchdog();
      let remaining = childPids.length;
      let allConfirmed = true;
      const onDescendantDone = (confirmed: boolean): void => {
        allConfirmed &&= confirmed;
        remaining -= 1;
        if (remaining > 0) return;
        if (allConfirmed) {
          finish(true);
          return;
        }
        // A descendant can exit naturally between enumeration and taskkill.
        // A non-zero taskkill code is therefore not proof that it survived;
        // re-enumerate once and release strict callers when the tree is empty.
        queryDescendants((remainingPids) => finish(remainingPids.length === 0));
      };
      for (const childPid of childPids) {
        try {
          const killer = spawn('taskkill', ['/pid', childPid, '/T', '/F'], { windowsHide: true });
          let killerFinished = false;
          const finishKiller = (confirmed: boolean): void => {
            if (killerFinished) return;
            killerFinished = true;
            onDescendantDone(confirmed);
          };
          killer.on('exit', (code) => finishKiller(code === 0));
          killer.on('error', () => finishKiller(false));
        } catch {
          onDescendantDone(false);
        }
      }
    });
  };
  inspectAndReap();
}

/**
 * 对同一 pid 重试 taskkill(有限次数、短延迟),再回落 child.kill + 后代兜底
 * ——重试覆盖真实高发的瞬态失败(kill 与进程自然退出竞速、进程表短暂繁忙)。
 * `onSettled` 在整条链路(重试 + 必要时的后代兜底)都跑完后才调用一次。
 */
function killWindowsTree(
  pid: number,
  child: ChildProcess,
  attempt: number,
  onSettled?: () => void,
  options: KillProcessTreeOptions = {},
): void {
  // pid 复用防线(codex review 五次发现):这条重试/兜底链的每一步动手前都先确认
  // 原进程还没退出——taskkill 失败到 150ms 后重试之间,子进程完全可能已自然退出
  // (typical:timeout/abort 与自然退出竞速),此时这个 pid 随时会被 OS 发给无关
  // 进程,继续 taskkill / 按 ppid 枚举都可能误杀。检测到已退出就地收束(调
  // onSettled),接受"可能留孤儿"的降级——与后代兜底"尽力而为"的既有语义一致,
  // 比误杀无关进程安全。exitCode/signalCode 由 Node 在进程终止时置位,是不碰
  // OS 进程表的第一方信号。
  const childExited = (): boolean =>
    typeof child.exitCode === 'number' || typeof child.signalCode === 'string';
  const settleExitedParent = (): void => {
    if (options.requireWindowsDescendantConfirmation) {
      reapWindowsDescendantsBestEffort(pid, onSettled, true);
    } else {
      onSettled?.();
    }
  };
  if (childExited()) {
    settleExitedParent();
    return;
  }
  const fallbackKill = (): void => {
    if (childExited()) {
      settleExitedParent();
      return;
    }
    if (options.requireWindowsDescendantConfirmation) {
      const onChildExit = (): void => settleExitedParent();
      child.once('exit', onChildExit);
      // Close the check/listen race: the process may exit between the first
      // childExited() read and registering the listener above.
      if (childExited()) {
        child.removeListener('exit', onChildExit);
        settleExitedParent();
        return;
      }
      try {
        child.kill('SIGKILL');
      } catch {
        /* 无法证明直接进程退出:调用方继续持有安全锁 */
      }
      return;
    }
    try {
      child.kill('SIGKILL');
    } catch {
      /* 进程已退出 */
    }
    reapWindowsDescendantsBestEffort(pid, onSettled);
  };
  try {
    const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
    let attemptFinished = false;
    const onFailure = (): void => {
      if (attemptFinished) return;
      attemptFinished = true;
      if (childExited()) {
        settleExitedParent();
        return;
      }
      if (attempt < WIN32_TASKKILL_MAX_ATTEMPTS) {
        setTimeout(
          () => killWindowsTree(pid, child, attempt + 1, onSettled, options),
          WIN32_TASKKILL_RETRY_DELAY_MS,
        ).unref?.();
      } else {
        fallbackKill();
      }
    };
    killer.on('exit', (code) => {
      if (code !== 0) {
        onFailure();
        return;
      }
      if (attemptFinished) return;
      attemptFinished = true;
      if (options.requireWindowsDescendantConfirmation) {
        reapWindowsDescendantsBestEffort(pid, onSettled, true);
      } else {
        onSettled?.();
      }
    });
    killer.on('error', onFailure);
  } catch {
    fallbackKill();
  }
}

/**
 * @param onSettled 可选:本函数已经把这个 pid 能试的杀法都试完(win32 下含重试
 *   与后代兜底枚举)时调用一次。调用方应该**只在这个回调里**武装"强制 settle"
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
    killWindowsTree(pid, child, 1, onSettled, options);
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
