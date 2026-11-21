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
 *   - POSIX 下执行前先 `sh -n` 预检命令语法:sh 的语法错误退出码恰好也是 2,
 *     不预检会把"引号没配平"之类的命令错误当成正常跳过，任务悄悄停摆。
 *   - 超时**仅在显式配置 timeoutMs 时生效**,未配置 = 不限时(产品决策:
 *     不设默认超时;代价是 hook 卡死会阻塞该轮 fire,由配置方自担)。
 *
 * 跨平台注意(docs/dev-rules/engineering-conventions.md):
 *   - 超时杀进程:Windows 上 child.kill 的 POSIX 信号语义不可靠且杀不掉 cmd.exe
 *     的孙子进程,走 `taskkill /pid <pid> /T /F` 树杀兜底;POSIX 用 SIGKILL。
 *   - stdout/stderr 各截断 8KB,防脚本刷屏撑爆 run 记录与日志。
 */

import { execFile, spawn } from 'node:child_process';
import type { PreRunHookRunResult, ScheduleWebhookEvent } from '@cindy/maker-scheduler';
import { capAppend as capAppendBase, killProcessTree } from './proc-util';
import { readPrCheckDiagnosis } from '@cindy/maker-shared/schedule-model';
import { deviceName } from '../device-link/deviceName.js';
import os from 'node:os';
import path from 'node:path';
import { resolveSystemNodeInterpreter } from './hook-runtimes.js';

/** Platform port: Desktop uses utilityProcess; Node Host uses its own Node executable. */
let spawnNodeScript = (script: string, cwd: string): ReturnType<typeof spawn> => {
  if (process.versions.electron) throw new Error('Node script hook runtime is not configured');
  return spawn(process.execPath, [script], { cwd, stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true, detached: process.platform !== 'win32' });
};
export function configurePreRunNodeScriptSpawner(spawner: typeof spawnNodeScript): void {
  spawnNodeScript = spawner;
}

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
  /** Webhook 触发时的事件元数据（外部不可信数据）。 */
  webhook?: { events: ScheduleWebhookEvent[]; omitted: number };
  /**
   * Present when host code started this run early instead of the cron or a user, for example
   * `{ kind: 'watch', source: 'pr-status', detail: <PR URL> }` when a watched PR's status changed.
   */
  trigger?: { kind: 'watch'; source: string; detail?: string };
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
 * `node` / `xdt-node` 首 token 在执行时解析为真实 Node 解释器:PATH 不可用
 * 时由 hook-runtimes 发现版本管理器安装。xdt-node 找不到可用运行时则
 * fail-closed,不能退回 RunAsNode(正式包可能只启动 GUI 并以 0 退出)。
 * 只有首 token 会替换,后续脚本参数与 shell 文本保持原样。
 */
const NODE_INTERPRETER_PREFIX = /^(node|xdt-node)(?=\s)/;
const INVALID_XDT_NODE_PREFIX = /^xdt-node(?:$|[;&|])/;
const XDT_NODE_RUNTIME_ERROR =
  'xdt-node requires a working Node.js runtime; install Node.js or repair the version-manager installation';
const INVALID_XDT_NODE_COMMAND_ERROR =
  'invalid pre-run hook configuration: xdt-node must be followed by a script command';

export type PreRunHookResult = PreRunHookRunResult;

/** 构造 skipped run 的历史摘要，不创建会话或写入消息。 */
export function buildSkipResultText(hook: PreRunHookResult): string {
  const head = `pre-run hook exit ${hook.exitCode ?? '?'} — ${hook.durationMs}ms`;
  const out = hook.stdout.trim();
  return out ? `${head} — ${firstLine(out)}` : head;
}

function parsePrCheckOutput(stdout: string) {
  const prefix = 'CINDY_PR_CHECK_DIAGNOSIS ';
  const marker = stdout.split(/\r?\n/).find(line => line.startsWith(prefix));
  if (!marker) return;
  try {
    const device = process.versions.electron ? deviceName() : process.env.CINDY_HOST_DEVICE_NAME?.trim() || deviceName();
    return readPrCheckDiagnosis({ ...JSON.parse(marker.slice(prefix.length)), device });
  } catch {
    return undefined;
  }
}

function firstLine(text: string): string {
  const line = text.split(/\r?\n/, 1)[0] ?? '';
  return line.length > 200 ? `${line.slice(0, 200)}…` : line;
}

/** POSIX 下 spawn(shell:true) 实际使用的解释器;语法预检必须用同一个。 */
const POSIX_SHELL = '/bin/sh';
const SYNTAX_CHECK_TIMEOUT_MS = 5_000;

/**
 * POSIX shell 语法预检(`sh -n -c`,只解析不执行)。返回 shell 的报错文本;语法
 * 正确、Windows(cmd.exe 没有对应能力)或预检本身没能完成(参数非法 / spawn
 * 失败 / 超时 / 取消)时返回 undefined,交给真实执行按原协议处理。
 */
export function findShellSyntaxError(
  command: string,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<string | undefined> {
  if (process.platform === 'win32' || options.signal?.aborted) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    try {
      execFile(
        POSIX_SHELL,
        ['-n', '-c', command],
        {
          timeout: Math.min(SYNTAX_CHECK_TIMEOUT_MS, options.timeoutMs ?? SYNTAX_CHECK_TIMEOUT_MS),
          signal: options.signal,
        },
        (err, _stdout, stderr) => {
          // 只有 shell 正常退出且非 0 才是语法错误;err.code 为字符串(ENOENT /
          // ABORT_ERR 等)或超时被杀时不下结论。
          if (!err || typeof err.code !== 'number') {
            resolve(undefined);
            return;
          }
          resolve(String(stderr).trim() || `${POSIX_SHELL} -n exited with code ${err.code}`);
        },
      );
    } catch {
      // 参数非法(如命令含 NUL)时 Node 同步抛错:不下结论,交给真实执行折叠成失败结果。
      resolve(undefined);
    }
  });
}

/** 保存任务前校验前置检查命令;语法错误抛 invalid,让写错的命令当场被拒。 */
export async function assertPreRunHookCommandSyntax(command: string): Promise<void> {
  if (INVALID_XDT_NODE_PREFIX.test(command.trim())) throw new Error(INVALID_XDT_NODE_COMMAND_ERROR);
  const syntaxError = await findShellSyntaxError(command);
  if (syntaxError) {
    throw new Error(
      `invalid pre-run hook configuration: shell syntax error in command: ${firstLine(syntaxError)}`,
    );
  }
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
  const abortedResult = (): PreRunHookResult => ({
    status: 'aborted',
    decision: 'block',
    exitCode: null,
    durationMs: Date.now() - startedAt,
    stdout: '',
    stderr: '',
    stdoutTruncated: false,
    stderrTruncated: false,
    timedOut: false,
    aborted: true,
  });
  const timedOutResult = (): PreRunHookResult => ({
    status: 'timed_out',
    decision: 'block',
    exitCode: null,
    durationMs: Date.now() - startedAt,
    stdout: '',
    stderr: '',
    stdoutTruncated: false,
    stderrTruncated: false,
    timedOut: true,
    aborted: false,
    error: `pre-run hook timed out after ${timeoutMs ?? 0}ms`,
  });
  // 进门先查:任务已被 pause/delete(信号已 abort)→ 不 spawn,直接返回
  if (input.signal?.aborted) return abortedResult();

  let command = input.command;
  // A literal script path, never a shell expression or Node CLI option. This is separate
  // from legacy xdt-node, whose Electron Node-mode behavior is unsuitable for shipped fuses.
  const nodeScript = /^cindy-node-script\s+"([^"\r\n]+)"\s*$/.exec(input.command.trim());
  // 预检与真实执行共用同一个取消信号和超时预算。
  const syntaxError = await findShellSyntaxError(command, {
    signal: input.signal,
    timeoutMs,
  });
  if (input.signal?.aborted) return abortedResult();
  let remainingTimeoutMs =
    timeoutMs === undefined ? undefined : timeoutMs - (Date.now() - startedAt);
  // 预检已耗尽配置的超时预算:不再启动真实命令,直接按超时阻止本轮。
  if (remainingTimeoutMs !== undefined && remainingTimeoutMs <= 0) {
    return timedOutResult();
  }
  if (syntaxError) {
    return {
      status: 'failed',
      decision: 'block',
      exitCode: null,
      durationMs: Date.now() - startedAt,
      stdout: '',
      stderr: capAppendBase('', syntaxError, OUTPUT_CAP),
      stdoutTruncated: false,
      stderrTruncated: syntaxError.length > OUTPUT_CAP,
      timedOut: false,
      aborted: false,
      error: `shell syntax error in command: ${firstLine(syntaxError)}`,
    };
  }

  const trimmedCommand = input.command.trim();
  const interpreterPrefix = NODE_INTERPRETER_PREFIX.exec(trimmedCommand);
  let interpreter: string | null = null;
  if (interpreterPrefix) {
    try {
      interpreter = await resolveSystemNodeInterpreter({
        signal: input.signal,
        timeoutMs: remainingTimeoutMs,
        cwd: input.cwd,
      });
    } catch {
      // xdt-node 在下方 fail-closed;裸 node 保留原命令与既有错误语义。
    }
    if (input.signal?.aborted) return abortedResult();
    remainingTimeoutMs = timeoutMs === undefined ? undefined : timeoutMs - (Date.now() - startedAt);
    if (remainingTimeoutMs !== undefined && remainingTimeoutMs <= 0) return timedOutResult();
  }
  const invalidXdtNode = INVALID_XDT_NODE_PREFIX.test(trimmedCommand);
  if (invalidXdtNode || (interpreterPrefix?.[1] === 'xdt-node' && !interpreter)) {
    const error = invalidXdtNode ? INVALID_XDT_NODE_COMMAND_ERROR : XDT_NODE_RUNTIME_ERROR;
    return {
      status: 'failed',
      decision: 'block',
      exitCode: null,
      durationMs: Date.now() - startedAt,
      stdout: '',
      stderr: error,
      stdoutTruncated: false,
      stderrTruncated: false,
      timedOut: false,
      aborted: false,
      error,
    };
  }
  if (interpreterPrefix && interpreter) {
    // 只替换首 token;其后的空白、引号、参数与 shell 操作符全部原样保留。
    command = trimmedCommand.replace(NODE_INTERPRETER_PREFIX, () => interpreter);
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
      const diagnosis = status === 'failed' && !stdoutTruncated ? parsePrCheckOutput(stdout) : undefined;
      resolve({
        status,
        ...(diagnosis && { prCheckDiagnosis: diagnosis }),
        ...((status === 'passed' || status === 'skipped') && !stdoutTruncated
          && stdout.split(/\r?\n/).includes('CINDY_PRECHECK_OK') ? { checkSucceeded: true as const } : {}),
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

    // 未配置 timeoutMs 时不武装定时器 —— 不限时;配置了则只用预检后剩余的预算。
    const timer =
      remainingTimeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            killProcessTree(child?.pid, child, armForceSettle);
          }, remainingTimeoutMs);
    timer?.unref?.();

    // 任务 pause/delete → 与超时同款树杀 + 1s 强制 settle:abortInflightAndWait
    // 只等几秒,长 hook 不能拖住它,更不能在任务已删后继续跑完再进会话创建。
    const onAbort = (): void => {
      aborted = true;
      killProcessTree(child?.pid, child, armForceSettle);
    };
    input.signal?.addEventListener('abort', onAbort, { once: true });

    try {
      child = nodeScript ? spawnNodeScript(path.resolve(input.cwd || os.homedir(), nodeScript[1]), input.cwd || os.homedir()) : spawn(command, {
        shell: true,
        cwd: input.cwd?.trim() ? input.cwd : os.homedir(),
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: process.env,
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
  const plugin = result.missingPlugin;
  if (plugin) {
    const label = plugin.name ? `"${plugin.name}" (${plugin.ghostId})` : `"${plugin.ghostId}"`;
    return `pre-run hook failed: plugin ${label} is ${
      plugin.installed ? 'not enabled' : 'not installed'
    }, so its check script is missing. ${plugin.installed ? 'Enable' : 'Install'} the plugin to resume this task.`;
  }
  if (result.status === 'timed_out') return result.error ?? 'pre-run hook timed out';
  if (result.error) return `pre-run hook failed: ${result.error}`;
  // The script's own first stderr line is usually the actual cause ("gh not found",
  // "not authenticated"); a bare exit code leaves the user nothing to act on.
  // Bounded like script-mode failures, which already carry their stderr tail.
  const reason = firstLine(result.stderr.trim());
  return `pre-run hook failed with exit code ${result.exitCode ?? 'unknown'}${reason ? `: ${reason}` : ''}`;
}
