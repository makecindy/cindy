/**
 * 定时任务前置检查脚本(Pre-run Hook)执行器。
 *
 * 协议对齐 Claude Code hooks(语言无关,约定的是进程协议):
 *   - command 经系统 shell 执行(POSIX 走 /bin/sh,Windows 走 cmd.exe——
 *     shell:true 的平台默认;Windows 下 shebang 不生效,命令应写显式解释器)。
 *   - stdin 注入一段 JSON 上下文(scheduleId / name / firedAt / workingDir 等),
 *     脚本可读可不读。
 *   - exit 0 → 放行本轮;exit 2 → 跳过本轮;其它退出码 / 超时 / spawn 失败 →
 *     fail-closed 阻止本轮并记录失败，避免前置检查异常时绕过闸门。
 *   - 超时**仅在显式配置 timeoutMs 时生效**,未配置 = 不限时(产品决策:
 *     不设默认超时;代价是 hook 卡死会阻塞该轮 fire,由配置方自担)。
 *
 * 跨平台注意(docs/dev-rules/engineering-conventions.md):
 *   - 超时杀进程:Windows 上 child.kill 的 POSIX 信号语义不可靠且杀不掉 cmd.exe
 *     的孙子进程,走 `taskkill /pid <pid> /T /F` 树杀兜底;POSIX 用 SIGKILL。
 *   - stdout/stderr 各截断 8KB,防脚本刷屏撑爆 run 记录与日志。
 */

import { spawn } from 'node:child_process';
import type { PreRunHookRunResult } from '@cindy/maker-scheduler';
import { capAppend as capAppendBase, killProcessTree } from './proc-util';
import os from 'node:os';

/** stdout / stderr 各自的截断上限(字节级近似,按 UTF-16 length 截)。 */
const OUTPUT_CAP = 8 * 1024;

/** 脚本经 stdin 收到的 JSON 上下文。字段只增不改,脚本按需取用。 */
export interface PreRunHookStdinPayload {
  event: 'schedule-pre-run';
  scheduleId: string;
  scheduleName: string;
  runId: string;
  firedAt: number;
  workingDir?: string;
  /**
   * 上一次终态完成时间戳(ms);从未有终态为 undefined。
   * ⚠️ **被本 hook 跳过(exit 2)的轮次同样刷新此值**(engine 对 skipped run 走同一
   * 重排落库)。写"距上次真实运行超过 X 才放行"类条件时不要依赖本字段——每次
   * skip 都会把它推新,脚本会永久自锁;这类条件应自己落盘记录上次放行时间。
   */
  lastFinishedAt?: number;
}

export interface PreRunHookInput {
  command: string;
  /** 未传 / 非法值 = 不限时;显式配置为正数时到点杀进程并阻止本轮执行。 */
  timeoutMs?: number;
  /** 脚本 cwd。未传回落 os.homedir()(此时脚本内应使用绝对路径)。 */
  cwd?: string;
  /**
   * 调度器 in-flight abort 信号(用户 pause / delete 任务)。触发即树杀脚本进程、
   * 立刻 settle(`aborted:true`)——pause/delete 的 abortInflightAndWait 只等几秒,
   * 不能让 hook(未配置 timeoutMs 时不限时)拖住它或在任务已删后继续烧 CPU。
   */
  signal?: AbortSignal;
  stdinPayload: PreRunHookStdinPayload;
}

/**
 * `xdt-node` 命令前缀:用 Cindy 自带的 Electron 运行时以 Node 模式执行脚本
 * (ELECTRON_RUN_AS_NODE)。给"机器上没有系统 node"的用户兜底——AI 生成器探测
 * 不到系统 node 时改发 `xdt-node <script>`,执行时在这里解析成当前 app 的
 * process.execPath,**不把 exe 绝对路径写进 DB**(app 升级/换装路径变了命令
 * 依然有效)。纯 node 测试环境下 process.execPath 就是 node 本身,同样成立。
 */
const XDT_NODE_PREFIX = /^xdt-node\s+/;

/** 解析 xdt-node 前缀(纯函数,可测)。普通命令原样返回。 */
export function resolveHookCommand(command: string): {
  command: string;
  extraEnv: Record<string, string>;
} {
  if (XDT_NODE_PREFIX.test(command.trim())) {
    const rest = command.trim().replace(XDT_NODE_PREFIX, '');
    return {
      command: `"${process.execPath}" ${rest}`,
      extraEnv: { ELECTRON_RUN_AS_NODE: '1' },
    };
  }
  return { command, extraEnv: {} };
}

export type PreRunHookResult = PreRunHookRunResult;

/** 构造 skipped run 的历史摘要，不创建会话或写入消息。 */
export function buildSkipResultText(hook: PreRunHookResult): string {
  const head = `pre-run hook exit ${hook.exitCode ?? '?'} — ${hook.durationMs}ms`;
  const out = hook.stdout.trim();
  return out ? `${head} — ${firstLine(out)}` : head;
}

function firstLine(text: string): string {
  const line = text.split(/\r?\n/, 1)[0] ?? '';
  return line.length > 200 ? `${line.slice(0, 200)}…` : line;
}

/** 显式配置的正数才启用超时;未传 / 非法 / ≤0 → undefined(不限时)。 */
export function resolvePreRunHookTimeoutMs(timeoutMs: number | undefined): number | undefined {
  if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return undefined;
  }
  return Math.floor(timeoutMs);
}

/**
 * 执行前置检查脚本。**永不 throw**——任何进程异常都折叠成结构化结果，由调用方
 * 按 fail-closed 协议处理；只有 exit 0 会返回 `decision: 'run'`。
 */
export async function executePreRunHook(input: PreRunHookInput): Promise<PreRunHookResult> {
  const timeoutMs = resolvePreRunHookTimeoutMs(input.timeoutMs);
  const startedAt = Date.now();
  // 进门先查:任务已被 pause/delete(信号已 abort)→ 不 spawn,直接返回
  if (input.signal?.aborted) {
    return {
      status: 'aborted',
      decision: 'block',
      exitCode: null,
      durationMs: 0,
      stdout: '',
      stderr: '',
      stdoutTruncated: false,
      stderrTruncated: false,
      timedOut: false,
      aborted: true,
    };
  }
  return new Promise<PreRunHookResult>((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let aborted = false;
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let settled = false;
    let child: ReturnType<typeof spawn>;

    const settle = (partial: { exitCode: number | null; spawnError?: string }): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      input.signal?.removeEventListener('abort', onAbort);
      const exitCode = partial.exitCode;
      const status = aborted
        ? 'aborted'
        : timedOut
          ? 'timed_out'
          : partial.spawnError
            ? 'failed'
            : exitCode === 0
              ? 'passed'
              : exitCode === 2
                ? 'skipped'
                : 'failed';
      resolve({
        status,
        decision: status === 'passed' ? 'run' : status === 'skipped' ? 'skip' : 'block',
        exitCode,
        durationMs: Date.now() - startedAt,
        stdout,
        stderr,
        stdoutTruncated,
        stderrTruncated,
        timedOut,
        aborted,
        spawnError: partial.spawnError,
        error:
          partial.spawnError ??
          (timedOut
            ? `pre-run hook timed out after ${timeoutMs ?? 0}ms`
            : !aborted && exitCode === null
              ? 'pre-run hook exited without a valid result'
              : undefined),
      });
    };

    // taskkill / SIGKILL 后 close 会跟上;再兜一层 1s 强制 settle,防止句柄异常
    // 导致 close 永不触发。强制收敛仍返回 block，不会绕过检查。⚠️ 计时器必须等 killProcessTree
    // 的 onSettled 回调(它已把重试/后代兜底都跑完)才武装,不能紧跟 kill 调用
    // 就起跑——否则跟收敛动作并行赛跑、大概率在真正杀干净前抢跑(proc-util 侧
    // Greptile 二次 review 发现,这里是同款计时器,同样得改)。
    const armForceSettle = (): void => {
      setTimeout(() => settle({ exitCode: null }), 1_000).unref?.();
    };

    // 未配置 timeoutMs 时不武装定时器 —— 不限时。
    const timer =
      timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            killProcessTree(child?.pid, child, armForceSettle);
          }, timeoutMs);
    timer?.unref?.();

    // 任务 pause/delete → 与超时同款树杀 + 1s 强制 settle:abortInflightAndWait
    // 只等几秒,长 hook 不能拖住它,更不能在任务已删后继续跑完再进会话创建。
    const onAbort = (): void => {
      aborted = true;
      killProcessTree(child?.pid, child, armForceSettle);
    };
    input.signal?.addEventListener('abort', onAbort, { once: true });

    const resolved = resolveHookCommand(input.command);
    try {
      child = spawn(resolved.command, {
        shell: true,
        cwd: input.cwd?.trim() ? input.cwd : os.homedir(),
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, ...resolved.extraEnv },
        // POSIX:自成进程组,超时/abort 时 kill(-pid) 才能连 shell 的子进程一起杀
        // (见 proc-util killProcessTree);Windows 忽略此参数,树杀走 taskkill /T。
        detached: process.platform !== 'win32',
      });
    } catch (err) {
      settle({ exitCode: null, spawnError: err instanceof Error ? err.message : String(err) });
      return;
    }

    child.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      if (stdout.length + text.length > OUTPUT_CAP) stdoutTruncated = true;
      stdout = capAppendBase(stdout, text, OUTPUT_CAP);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      if (stderr.length + text.length > OUTPUT_CAP) stderrTruncated = true;
      stderr = capAppendBase(stderr, text, OUTPUT_CAP);
    });
    child.on('error', (err) => {
      settle({ exitCode: null, spawnError: err.message });
    });
    child.on('close', (code) => {
      settle({ exitCode: code });
    });

    // stdin JSON 上下文:脚本不读也无妨。写失败(脚本秒退不接 stdin)静默忽略。
    try {
      child.stdin?.on('error', () => undefined);
      child.stdin?.write(JSON.stringify(input.stdinPayload));
      child.stdin?.end();
    } catch {
      /* ignore stdin write failures */
    }
  });
}

/** 给 run 错误、通知和日志共用的前置检查失败摘要。 */
export function formatPreRunHookFailure(result: PreRunHookResult): string {
  if (result.status === 'timed_out') return result.error ?? 'pre-run hook timed out';
  if (result.error) return `pre-run hook failed: ${result.error}`;
  return `pre-run hook failed with exit code ${result.exitCode ?? 'unknown'}`;
}
