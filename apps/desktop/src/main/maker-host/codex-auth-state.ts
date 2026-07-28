import type { ChildProcess } from 'node:child_process';

import type { AuthState } from '@cindy/maker-core';

export type CodexLoginMode = 'browser' | 'device-code';

/** 官方 Codex CLI 的两种交互登录入口。 */
export function codexLoginArgs(mode: CodexLoginMode = 'browser'): string[] {
  return mode === 'device-code' ? ['login', '--device-auth'] : ['login'];
}

/** 平台化的 Codex 登录子进程终止方案。 */
export type CodexLoginTerminationPlan =
  | { kind: 'windows-handle'; signal: 'SIGKILL' }
  | { kind: 'posix-group'; signal: 'SIGKILL' };

/**
 * `codex login` 的成功判定必须是「真的拿到 OAuth token」，不能复用全局 Codex 门禁。
 * 全局门禁允许 XD Gateway key fallback；若拿它判登录结果，auth.json 写失败时也会误报成功。
 */
export function requireCodexOAuthLoginState(state: AuthState): AuthState {
  if (state.authenticated && state.authSource === 'oauth') return state;
  return {
    authenticated: false,
    errorReason: state.errorReason ?? 'no_oauth',
  };
}

/**
 * 登录前异步清理完成后的线性化检查。cleanup await 期间用户可能取消；取消必须优先，
 * 不能继续 spawn CLI，也不应被同时发生的 cleanup 失败覆盖成另一个错误。
 */
export async function resolveCodexLoginCleanupPreflight(
  cleanup: () => Promise<boolean>,
  isCancelled: () => boolean,
): Promise<AuthState | null> {
  const cleanupReady = await cleanup();
  if (isCancelled()) return { authenticated: false, errorReason: 'login_cancelled' };
  if (!cleanupReady) return { authenticated: false, errorReason: 'auth_cleanup_failed' };
  return null;
}

/**
 * 把退出前的取消 / 超时状态归一成稳定的 AuthState；返回 null 表示 exit code 0，继续校验 OAuth 文件。
 */
export function resolveCodexLoginExitState(input: {
  cancelled: boolean;
  timedOut: boolean;
  exitCode: number | null;
  stderr: string;
}): AuthState | null {
  // exit 0 代表 CLI 已完成提交窗口：即使 cancel / timeout 同一拍到达，也必须先校验
  // auth.json。真 token 已落盘则 success 胜出；没有 token 时由 finalize 回退稳定中断原因。
  if (input.exitCode === 0) return null;
  if (input.cancelled) return { authenticated: false, errorReason: 'login_cancelled' };
  if (input.timedOut) return { authenticated: false, errorReason: 'login_timeout' };
  return {
    authenticated: false,
    errorReason: input.stderr || `codex_login_exit_${String(input.exitCode)}`,
  };
}

/** Windows 走 ChildProcess handle；POSIX 走独立进程组。两端取消/超时都立即强杀。 */
export function buildCodexLoginTerminationPlan(
  platform: NodeJS.Platform,
): CodexLoginTerminationPlan {
  return platform === 'win32'
    ? { kind: 'windows-handle', signal: 'SIGKILL' }
    : { kind: 'posix-group', signal: 'SIGKILL' };
}

function isLiveRoot(proc: ChildProcess): boolean {
  return proc.exitCode === null && proc.signalCode === null;
}

/** 只在根进程仍存活时直接发信号，避免已退出 PID 被复用后误杀其它进程。 */
function signalLiveRoot(proc: ChildProcess, signal: NodeJS.Signals): void {
  if (!isLiveRoot(proc)) return;
  try {
    proc.kill(signal);
  } catch {
    /* 已退出。 */
  }
}

/** POSIX 独立进程组发信号；失败交给调用方决定是否回退根进程。 */
function signalPosixProcessGroup(pid: number | undefined, signal: NodeJS.Signals): boolean {
  if (pid === undefined) return false;
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    return false;
  }
}

/**
 * 跨平台终止 Codex 登录：Windows 经 ChildProcess 的原生 process handle 强杀根进程；
 * POSIX 强杀独立进程组。当前 pin 的 Codex callback server 是登录进程内的 thread/task，
 * Windows 不需要 taskkill /T；后者只能按裸 PID 查找目标，会引入 PID 复用误杀窗口。
 */
export function terminateCodexLoginProcess(
  proc: ChildProcess,
  platform: NodeJS.Platform = process.platform,
): void {
  if (!isLiveRoot(proc)) return;
  const plan = buildCodexLoginTerminationPlan(platform);
  if (plan.kind === 'windows-handle') {
    signalLiveRoot(proc, plan.signal);
    return;
  }

  if (!signalPosixProcessGroup(proc.pid, plan.signal)) signalLiveRoot(proc, plan.signal);
}
