/**
 * 内置 desktop slash command —— /help, /clear。
 *
 * 这些命令的"业务"很轻 (其实就是触发一个 UI 动作), 所以 main 这边的 execute
 * 主要是 broadcast 一个 push channel; renderer 收到后真正执行 UI (insertSystemCard
 * 'help' 卡 / clearSession 开新草稿)。
 *
 * 为什么不让 renderer 自己处理? —— 统一架构: palette 上所有命令都走"main 注册 +
 * main dispatch"这条同一条路径, renderer 不需要"判断这个命令是不是 local"的分支
 * 逻辑。哪怕命令最终效果是 UI, 决策权和命名权也归 main 拥有。
 */

import { spawn } from 'node:child_process';
import { BrowserWindow, webContents } from 'electron';
import { BRAND_NAME } from '@cindy/maker-shared/branding';
import { MAKER_PUSH } from '../maker-ipc/channels.js';
import { createLogger } from '../logger.js';
// type-only:不引入对 goal-host / learn-host 的运行时依赖(避免潜在 import 环),
// 运行时实例由 bootstrap 经 deps.getGoalController / getLearnController 注入。
import type { GoalController } from '../goal-host/controller.js';
import type { LearnController } from '../learn-host/controller.js';
import type { DesktopCommandContext, DesktopCommandRegistry } from './registry.js';

const log = createLogger('desktop-commands');

/**
 * push channel payload —— renderer 按 command 分支处理。
 * 字段保持平铺方便 renderer 解构, 不嵌 ctx 子对象。
 *
 * /cmd 这种"main 内闭环执行 + 结果回灌 renderer"的命令通过可选 result 字段透传
 * 执行结果(stdout / stderr / exitCode / elapsedMs / cmdLine / cwd / timedOut)。
 */
export interface DesktopCommandTriggeredPayload {
  command:
    'help' | 'clear' | 'cmd' | 'issue' | 'review' | 'jump-session' | 'goal' | 'workflows' | 'learn';
  sessionId?: string;
  workingDir?: string;
  args?: string;
  /** /cmd 专用 —— shell 命令执行结果。其它命令此字段不存在。 */
  result?: CmdExecutionResult;
  /** /goal、/learn 共用 —— 错误码(renderer 据此显示用法/错误提示):
   *  goal-usage / goal-no-session / goal-failed;learn-usage / learn-busy / learn-failed;
   *  remote-unsupported(远程会话:被控端版本过旧,不支持该命令的隧道 channel)。 */
  error?: string;
  /** /goal 专用 —— 动作:'set'(已设目标)/ 'cleared'(已清除)/ 'open-dialog'(无参 /goal → renderer 打开新建目标弹窗)。GoalIndicator 由状态 push 驱动,set/cleared 仅用于插一张确认卡。 */
  goalAction?: 'set' | 'cleared' | 'open-dialog';
  /** /learn 专用 —— 启动成功时的 runId(renderer 据此关联 learn:event 状态流)。 */
  learnRunId?: string;
}

export interface CmdExecutionResult {
  /** 用户原始命令行(就是 args, 冗余字段方便 renderer 直接渲染) */
  cmdLine: string;
  /** 执行时的工作目录(spawn 的 cwd) */
  cwd: string;
  /** 进程退出码; spawn 错误(命令找不到等)用 -1 兜底 */
  exitCode: number;
  /** 已截断的 stdout(超过 MAX_OUTPUT_BYTES 末尾会带省略提示) */
  stdout: string;
  stderr: string;
  /** 总耗时 ms */
  elapsedMs: number;
  /** 命中超时被 kill 时为 true */
  timedOut: boolean;
  /** spawn 直接抛错(命令不存在 / 权限拒等)时填错误消息; 此时 exitCode 为 -1 */
  spawnError?: string;
}

function broadcastDesktopCommand(payload: DesktopCommandTriggeredPayload): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    try {
      win.webContents.send(MAKER_PUSH.DESKTOP_COMMAND_TRIGGERED, payload);
    } catch {
      // broadcast 失败不阻塞执行 —— 某个窗口挂了不影响别的
    }
  }
}

function sendDesktopCommandToSender(ctx: DesktopCommandContext, payload: DesktopCommandTriggeredPayload): void {
  // 只回发起窗口:无 sessionId 的 draft 命令如果广播,会被其它已挂载 SessionView
  // 当成全局命令消费。sender id 缺失(防御未来非 IPC 调用路径)时回退广播。
  const target =
    typeof ctx.senderWebContentsId === 'number'
      ? webContents.fromId(ctx.senderWebContentsId)
      : undefined;
  if (target && !target.isDestroyed()) {
    target.send(MAKER_PUSH.DESKTOP_COMMAND_TRIGGERED, payload);
    return;
  }
  broadcastDesktopCommand(payload);
}

function buildPayload(
  command: DesktopCommandTriggeredPayload['command'],
  ctx: DesktopCommandContext,
): DesktopCommandTriggeredPayload {
  return {
    command,
    ...(ctx.sessionId ? { sessionId: ctx.sessionId } : {}),
    ...(ctx.workingDir ? { workingDir: ctx.workingDir } : {}),
    ...(ctx.args ? { args: ctx.args } : {}),
  };
}

// ── /cmd shell 执行 ────────────────────────────────────────────────────
// 跨平台 shell 执行: spawn 用 shell:true, Node 在 win32 走 cmd.exe /d /s /c,
// 其它走 /bin/sh -c。stdout/stderr 各自截断到 MAX_OUTPUT_BYTES, 避免一条
// `cat huge.log` 把 IPC payload / message store 撑爆。30s 超时硬上限,
// 命中后 SIGTERM,再 5s 仍未退出则 SIGKILL(Windows spawn.kill 忽略 signal,
// 直接强杀)。

const CMD_TIMEOUT_MS = 30_000;
const CMD_KILL_GRACE_MS = 5_000;
const MAX_OUTPUT_BYTES = 64 * 1024; // 64KB / 流; 超出末尾追加 "... (truncated)"

interface RunCmdOptions {
  cmdLine: string;
  cwd: string;
}

/**
 * Windows 下把 cmd.exe 的活动代码页临时切到 UTF-8(65001), 再跑用户命令。
 *
 * 这个 wrapping **只对外部工具有效**(git / node / python 这类按 GetConsoleOutputCP
 * 决定输出编码的程序), 让它们走 UTF-8。
 *
 * cmd.exe 内置命令(`dir` / `tasklist` / `ipconfig` 等)hardcode 用 OEM 代码页输出
 * (中文 Windows 是 GBK/936), **不鸟 chcp**。这部分由 decodeOutputBuffer 兜底:
 * 先 utf-8 严格解, 失败再 GB18030 fallback。
 *
 * 非 Windows 平台 sh/bash 默认就是 locale-based UTF-8, 不需要包裹。
 */
function wrapCmdLineForPlatform(cmdLine: string): string {
  if (process.platform === 'win32') {
    return `chcp 65001 >nul && ${cmdLine}`;
  }
  return cmdLine;
}

/**
 * 解码 spawn 收来的字节流。Windows 是混合编码地狱 —— 同一个 cmd.exe 子进程里,
 * 外部工具(git / node)可能 UTF-8 输出, 内置命令(dir)死磕 OEM codepage(GBK)。
 * 没有"一种"解码方式同时对两者都正确。
 *
 * 策略: 优先 UTF-8 严格(fatal)解, 整段失败时 fallback 到 GB18030。
 *  - 纯 UTF-8(git log 中文)→ 严格解成功 ✓
 *  - 纯 GBK(dir 输出"驱动器")→ GBK 字节里高位字节序列绝大多数不是合法 UTF-8 →
 *    严格解抛错 → fallback 到 GB18030 解成功 ✓
 *  - 混合(罕见)→ fallback, 部分字符可能位移, 但至少不再是 ��� 乱码块。
 *
 * 非 Windows 平台直接 utf-8(macOS/Linux 默认 locale 就是 UTF-8, 现代工具都 UTF-8 输出)。
 */
function decodeOutputBuffer(buf: Buffer): string {
  if (process.platform !== 'win32') {
    return buf.toString('utf8');
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    try {
      return new TextDecoder('gb18030', { fatal: false }).decode(buf);
    } catch {
      // 极端兜底: ICU 没 ship gb18030(理论上 Electron full-icu 一定有, 防御性留着)
      return buf.toString('utf8');
    }
  }
}

/**
 * 跨平台执行 shell 命令。**永不 throw** —— 任何错误都包装成 CmdExecutionResult
 * 返回, 调用方按 exitCode / spawnError / timedOut 判读。
 * export 供 desktop-cmd:run 远程 handler(remoteCmdIpc.ts)复用 —— 本机与远程
 * /cmd 的超时 / 截断 / 编码语义必须一致。
 */
export async function runShellCommand(opts: RunCmdOptions): Promise<CmdExecutionResult> {
  const { cmdLine, cwd } = opts;
  const startedAt = Date.now();
  const wrappedCmdLine = wrapCmdLineForPlatform(cmdLine);

  return new Promise<CmdExecutionResult>((resolve) => {
    // 收原始字节, 不在 chunk 边界 toString —— 多字节字符(UTF-8 3-4 字节, GBK 2 字节)
    // 可能正好被切在两个 chunk 之间, 边走边 toString 会产生不可恢复的乱码。
    // 累到结束一次性 decodeOutputBuffer 避免这个问题。
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let timedOut = false;
    let spawnError: string | undefined;
    let settled = false;

    const finish = (exitCode: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutHandle);
      clearTimeout(graceHandle);
      const elapsedMs = Date.now() - startedAt;
      const stdoutText = decodeOutputBuffer(Buffer.concat(stdoutChunks));
      const stderrText = decodeOutputBuffer(Buffer.concat(stderrChunks));
      resolve({
        cmdLine,
        cwd,
        exitCode,
        stdout: stdoutTruncated ? `${stdoutText}\n... (truncated, ${MAX_OUTPUT_BYTES}B cap)` : stdoutText,
        stderr: stderrTruncated ? `${stderrText}\n... (truncated, ${MAX_OUTPUT_BYTES}B cap)` : stderrText,
        elapsedMs,
        timedOut,
        ...(spawnError ? { spawnError } : {}),
      });
    };

    let child;
    try {
      // shell:true 让 Node 自动选 per-platform shell, 字符串作为单个参数传入,
      // 让 shell 自己解析(支持管道 / 重定向 / 引号等); 不要传 args 数组。
      // wrappedCmdLine 在 Windows 上前置 `chcp 65001 >nul && ...` 让外部工具走 UTF-8,
      // 内置命令(dir 等)无视 chcp 仍走 GBK, 由 decodeOutputBuffer 的 fallback 兜底。
      child = spawn(wrappedCmdLine, {
        cwd,
        shell: true,
        // windowsHide:true 避免 GUI 应用蹦出来一个 console 窗口
        windowsHide: true,
        env: {
          ...process.env,
          // Windows 下 Python piped stdout 默认走 locale encoding(cp936/GBK),
          // 不看 chcp 65001。强制 UTF-8 避免中文乱码。跨平台设置无副作用。
          PYTHONUTF8: process.env.PYTHONUTF8 ?? '1',
          PYTHONIOENCODING: process.env.PYTHONIOENCODING ?? 'utf-8',
        },
      });
    } catch (err) {
      spawnError = err instanceof Error ? err.message : String(err);
      finish(-1);
      return;
    }

    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdoutTruncated) return;
      const remaining = MAX_OUTPUT_BYTES - stdoutBytes;
      if (remaining <= 0) { stdoutTruncated = true; return; }
      if (chunk.length <= remaining) {
        stdoutChunks.push(chunk);
        stdoutBytes += chunk.length;
      } else {
        stdoutChunks.push(chunk.subarray(0, remaining));
        stdoutBytes = MAX_OUTPUT_BYTES;
        stdoutTruncated = true;
      }
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderrTruncated) return;
      const remaining = MAX_OUTPUT_BYTES - stderrBytes;
      if (remaining <= 0) { stderrTruncated = true; return; }
      if (chunk.length <= remaining) {
        stderrChunks.push(chunk);
        stderrBytes += chunk.length;
      } else {
        stderrChunks.push(chunk.subarray(0, remaining));
        stderrBytes = MAX_OUTPUT_BYTES;
        stderrTruncated = true;
      }
    });

    child.on('error', (err) => {
      spawnError = err.message;
      finish(-1);
    });

    child.on('close', (code) => {
      finish(typeof code === 'number' ? code : -1);
    });

    // 超时 → SIGTERM, 再 5s 兜底 SIGKILL
    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGTERM'); } catch { /* ignore */ }
    }, CMD_TIMEOUT_MS);
    const graceHandle = setTimeout(() => {
      if (!settled) {
        try { child.kill('SIGKILL'); } catch { /* ignore */ }
      }
    }, CMD_TIMEOUT_MS + CMD_KILL_GRACE_MS);
  });
}

/**
 * 在 bootstrap 阶段调一次, 把所有内置 desktop command 灌进 registry。
 * 重复调会因为 registry.register 的去重保护抛错(开发期暴露问题)。
 */
/** /goal clear 的别名(对齐 Claude Code /goal clear|stop|off|...)。 */
const GOAL_CLEAR_ALIASES = new Set(['clear', 'stop', 'off', 'cancel', 'reset', 'none']);

export interface BuiltinDesktopCommandDeps {
  /** null-safe 取 GoalController 单例(注册早于 startGoalController,invoke 时已就绪)。 */
  getGoalController: () => GoalController | null;
  /** null-safe 取 LearnController 单例(同 goal:注册早于 startLearnHost)。 */
  getLearnController: () => LearnController | null;
  /**
   * device-link 隧道 invoke(控制端 → 被控端)。ctx.deviceId 存在(远程会话)时,
   * /goal /learn /cmd 的业务体经它路由到被控端执行 —— 与 renderer 的
   * deviceLink.invoke 走同一条 handleInvoke 主路径(含控制开关校验 + 错误映射,
   * 失败抛 `[CODE] message` 形态 Error)。bootstrap 注入,避免 builtins 直接
   * import device-link 运行时(与 getGoalController 同款解耦)。
   */
  remoteInvoke: (deviceId: string, channel: string, args: unknown[]) => Promise<unknown>;
}

/**
 * 从错误对象提取错误码:优先取 `.code`(本机 LearnError / GoalControllerInputError),
 * 回退解析 throwIpcError 的 `[CODE] message` 编码(隧道透传的被控端错误)。
 * 本机与远程两条错误链路因此在调用点收敛成同一套分类逻辑。
 */
function extractErrorCode(err: unknown): string | null {
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && code.length > 0) return code;
  const msg = err instanceof Error ? err.message : '';
  const m = /^\[([A-Z0-9_]+)\]/.exec(msg);
  return m ? m[1] : null;
}

/** 远程会话命中「被控端不支持该 channel」(版本过旧 / 半升级):映射成 remote-unsupported 提示。
 *  契约锁定:NOT_FOUND 在这条链路上**只**来自被控端 dispatchLocalInvoke 的
 *  「no local IPC handler for channel」(device-link/invoke-registry.ts)——
 *  goal/learn/cmd 的业务 handler 均不同步抛 NOT_FOUND;若未来某 handler 开始抛,
 *  这里会把业务错误误报成「版本过旧」,届时需给 dispatch 缺 handler 换专用错误码。 */
function isRemoteUnsupported(err: unknown): boolean {
  const code = extractErrorCode(err);
  return code === 'DEVICE_LINK_CHANNEL_NOT_ALLOWED' || code === 'NOT_FOUND';
}

export function registerBuiltinDesktopCommands(
  registry: DesktopCommandRegistry,
  deps: BuiltinDesktopCommandDeps,
): void {
  registry.register({
    name: 'help',
    description: 'Show the help card with every available command and usage example.',
    execute: (ctx) => broadcastDesktopCommand(buildPayload('help', ctx)),
  });

  registry.register({
    name: 'clear',
    // 实现是 renderer 收到 DESKTOP_COMMAND_TRIGGERED 后调 clearSession() →
    // clearSessionAfterGuard:**原地**清空当前任务的对话上下文,不新建、也不切走
    // (help-knowledge/{commands,sessions-and-chat}.md 写的才是对的)。
    description:
      'Clears the current session context in place — wipes its messages and state without creating or switching to a new session. The session stays in the sidebar.',
    execute: (ctx) => broadcastDesktopCommand(buildPayload('clear', ctx)),
  });

  registry.register({
    name: 'cmd',
    description:
      'Run a shell command on this machine and show the output here. Cross-platform (uses cmd.exe on Windows, /bin/sh elsewhere). Example: /cmd ls -la',
    execute: async (ctx) => {
      const cmdLine = (ctx.args ?? '').trim();
      // 空参数 / 没工作目录 → 仍然 broadcast, 但 result 标记错误, renderer 用同一张卡渲染
      if (!cmdLine) {
        broadcastDesktopCommand({
          ...buildPayload('cmd', ctx),
          result: {
            cmdLine: '',
            cwd: ctx.workingDir ?? '',
            exitCode: -1,
            stdout: '',
            stderr: 'usage: /cmd <shell command>',
            elapsedMs: 0,
            timedOut: false,
            spawnError: 'empty command',
          },
        });
        return;
      }
      // 远程会话:workingDir 是被控端路径,本机 spawn 语义错误(路径不存在 →
      // spawn error)。隧道到被控端 desktop-cmd:run 执行,结果照常回灌 /cmd 卡。
      if (ctx.deviceId) {
        const cwd = ctx.workingDir ?? '';
        // 远程会话必有 workingDir;缺失(防御)时不发起隧道,直接回可读错误
        // (被控端 guard 也会拒,但 renderer 会看到裸 [INVALID_PARAMS] 文案)。
        if (!cwd) {
          broadcastDesktopCommand({
            ...buildPayload('cmd', ctx),
            result: {
              cmdLine, cwd: '', exitCode: -1, stdout: '', stderr: '',
              elapsedMs: 0, timedOut: false,
              spawnError: 'remote session has no working directory',
            },
          });
          return;
        }
        log.info('/cmd remote exec ▶', { cmdLine, cwd, deviceId: ctx.deviceId });
        let result: CmdExecutionResult;
        try {
          result = (await deps.remoteInvoke(ctx.deviceId, 'desktop-cmd:run', [
            { cmdLine, cwd },
          ])) as CmdExecutionResult;
        } catch (err) {
          log.warn('/cmd remote exec failed', err);
          result = {
            cmdLine,
            cwd,
            exitCode: -1,
            stdout: '',
            stderr: '',
            elapsedMs: 0,
            timedOut: false,
            spawnError: isRemoteUnsupported(err)
              ? 'remote device does not support /cmd (app version too old)'
              : err instanceof Error
                ? err.message
                : String(err),
          };
        }
        broadcastDesktopCommand({ ...buildPayload('cmd', ctx), result });
        return;
      }
      const cwd = ctx.workingDir && ctx.workingDir.length > 0 ? ctx.workingDir : process.cwd();
      log.info('/cmd exec ▶', { cmdLine, cwd, sessionId: ctx.sessionId ?? '<none>' });
      const result = await runShellCommand({ cmdLine, cwd });
      log.info('/cmd exec ◀', {
        cmdLine, cwd, exitCode: result.exitCode, elapsedMs: result.elapsedMs,
        timedOut: result.timedOut, stdoutBytes: Buffer.byteLength(result.stdout, 'utf8'),
        stderrBytes: Buffer.byteLength(result.stderr, 'utf8'),
        spawnError: result.spawnError ?? null,
      });
      broadcastDesktopCommand({
        ...buildPayload('cmd', ctx),
        result,
      });
    },
  });

  registry.register({
    name: 'issue',
    description:
      `File feedback to the ${BRAND_NAME} team — the agent helps clarify details, then submits a GitHub issue after your confirmation. Usage: /issue [initial description]`,
    execute: (ctx) => {
      sendDesktopCommandToSender(ctx, buildPayload('issue', ctx));
    },
  });

  registry.register({
    name: 'review',
    description:
      'Review the current task in a fresh, memory-free, read-only reviewer task. Supports code changes, files, documents, and images. Usage: /review [focus or path]',
    execute: () => {
      // ChatInput invokes maker:start-review directly so its exact attachment
      // snapshot crosses the durable Main boundary before the view can unmount.
      // Refuse any unbound registry invocation instead of silently broadcasting
      // an event that may have no mounted consumer.
      throw new Error('/review must be started from a task composer');
    },
  });

  registry.register({
    name: 'goal',
    description:
      'Set an autonomous goal — the agent keeps working across turns until it is met, blocked, or the budget runs out. Usage: /goal <condition>. Clear with /goal clear.',
    execute: async (ctx) => {
      const arg = (ctx.args ?? '').trim();
      const sessionId = ctx.sessionId;
      // /goal 必须挂在一个已存在的会话上(目标是会话级)。
      if (!sessionId) {
        broadcastDesktopCommand({ ...buildPayload('goal', ctx), error: 'goal-no-session' });
        return;
      }
      // 远程会话:goal-host 在被控端(目标随会话在被控端自主续跑,控制端断链不中断),
      // clear / set 经隧道路由;open-dialog 仍是控制端 UI 动作(弹窗内 setGoal 由
      // renderer 按会话来源路由)。本机路径与远程路径的动作语义一一对应。
      const remoteGoal = ctx.deviceId
        ? {
            clearGoal: (id: string) => deps.remoteInvoke(ctx.deviceId!, 'maker:goal:clear', [id]),
            setGoal: (input: { sessionId: string; objective: string }) =>
              deps.remoteInvoke(ctx.deviceId!, 'maker:goal:set', [input]),
          }
        : null;
      const controller = deps.getGoalController();
      if (!remoteGoal && !controller) {
        broadcastDesktopCommand({ ...buildPayload('goal', ctx), error: 'goal-failed' });
        return;
      }
      const lower = arg.toLowerCase();
      // /goal clear|stop|off|... → 清除目标。
      if (arg && GOAL_CLEAR_ALIASES.has(lower)) {
        try {
          if (remoteGoal) await remoteGoal.clearGoal(sessionId);
          else await controller!.clearGoal(sessionId);
          broadcastDesktopCommand({ ...buildPayload('goal', ctx), goalAction: 'cleared' });
        } catch (err) {
          log.warn('/goal clearGoal failed', err);
          broadcastDesktopCommand({
            ...buildPayload('goal', ctx),
            error: isRemoteUnsupported(err) ? 'remote-unsupported' : 'goal-failed',
          });
        }
        return;
      }
      // /goal(无参)→ 等同点击「新建目标」:让 renderer 打开新建目标弹窗(此处已确保有 session)。
      if (!arg) {
        broadcastDesktopCommand({ ...buildPayload('goal', ctx), goalAction: 'open-dialog' });
        return;
      }
      // /goal <objective> → 直接设/编辑目标并续跑。
      try {
        if (remoteGoal) await remoteGoal.setGoal({ sessionId, objective: arg });
        else await controller!.setGoal({ sessionId, objective: arg });
        broadcastDesktopCommand({ ...buildPayload('goal', ctx), goalAction: 'set' });
      } catch (err) {
        log.warn('/goal setGoal failed', err);
        broadcastDesktopCommand({
          ...buildPayload('goal', ctx),
          error: isRemoteUnsupported(err) ? 'remote-unsupported' : 'goal-failed',
        });
      }
    },
  });

  registry.register({
    name: 'learn',
    description:
      'Distill a reusable skill from anything you describe (a workflow, a repo, a URL, how you usually do X) — grounded in your usage history and profile, reviewed as a diff before saving. Bare /learn distills the current conversation; /learn hub:<slug> learns from a SkillHub skill. Usage: /learn [hub:<slug>] [what to learn]',
    execute: async (ctx) => {
      const arg = (ctx.args ?? '').trim();
      // 无参 /learn = 蒸馏当前会话(Hermes 同语义)—— 需要挂在一个已有会话上;
      // 草稿态(无 sessionId)没有可蒸的内容,回用法提示。
      if (!arg && !ctx.sessionId) {
        sendDesktopCommandToSender(ctx, { ...buildPayload('learn', ctx), error: 'learn-usage' });
        return;
      }
      // 远程会话:learn-host 全流程在被控端(证据查它自己的 DB、staging 在它的
      // userData、skill 落它的 ~/.agents/skills),startLearn 经隧道路由到
      // learn:start;本机路径不变。
      const controller = ctx.deviceId ? null : deps.getLearnController();
      if (!ctx.deviceId && !controller) {
        sendDesktopCommandToSender(ctx, { ...buildPayload('learn', ctx), error: 'learn-failed' });
        return;
      }
      // `/learn hub:<slug> [补充要求]` —— skill hub「学习此技能」预填的形态,
      // 用户可在输入框改要求、换模型后再发。slug 规则与市场一致([a-z0-9-])。
      const hubMatch = /^hub:([a-z0-9][a-z0-9-]*)\s*/.exec(arg);
      const req = hubMatch
        ? {
            input: arg.slice(hubMatch[0].length).trim(),
            sourceKind: 'hub' as const,
            hubSlug: hubMatch[1],
            ...(ctx.sessionId ? { originSessionId: ctx.sessionId } : {}),
          }
        : {
            input: arg,
            sourceKind: (arg ? 'freetext' : 'session') as 'freetext' | 'session',
            ...(ctx.sessionId ? { originSessionId: ctx.sessionId } : {}),
          };
      try {
        const { runId } = ctx.deviceId
          ? ((await deps.remoteInvoke(ctx.deviceId, 'learn:start', [req])) as { runId: string })
          : await controller!.startLearn(req);
        sendDesktopCommandToSender(ctx, { ...buildPayload('learn', ctx), learnRunId: runId });
      } catch (err) {
        // extractErrorCode 同时覆盖本机 LearnError.code 与隧道 `[LEARN_BUSY] ...` 编码。
        const code = extractErrorCode(err);
        log.warn('/learn startLearn failed', err);
        sendDesktopCommandToSender(ctx, {
          ...buildPayload('learn', ctx),
          error:
            code === 'LEARN_BUSY'
              ? 'learn-busy'
              : isRemoteUnsupported(err)
                ? 'remote-unsupported'
                : 'learn-failed',
        });
      }
    },
  });

  registry.register({
    name: 'workflows',
    description:
      'Show the progress of workflows running in this session — a live tree of the Workflow tool subtasks (status, tokens). Opens/expands the latest workflow progress card.',
    // 展现全在 renderer:DESKTOP_COMMAND_TRIGGERED 订阅按 sessionId 定位并展开最近一张
    // workflow 进度卡,无正在运行的 workflow 时插一张提示 system card。数据来自 renderer
    // 已聚合的 taskUpdates,不回 SDK —— 原生 /workflows 在非交互 SDK 模式下不可用
    // (SDK 返回 "isn't available in this environment"),故由 desktop 命令抢在派发给 SDK
    // 之前接管(maybeDispatchDesktopSlashCommand)。
    execute: (ctx) => broadcastDesktopCommand(buildPayload('workflows', ctx)),
  });

  registry.register({
    name: 'jump-session',
    description: '输入 sessionId 后直接跳转到该任务。',
    // 实际执行在 renderer 本地拦截(navigationCommands.ts)；这里仅负责让命令出现在
    // `/` 菜单并提供描述，不走 executeDesktopCommand broadcast。
    execute: () => {},
  });
}
