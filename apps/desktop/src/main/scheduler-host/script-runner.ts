import { spawn, type ChildProcess } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

import { eq } from 'drizzle-orm';

import type {
  FireContext,
  FireResult,
  Logger,
  Notifier,
  Schedule,
  ScheduleRun,
  Scheduler,
  ScriptCapability,
} from '@cindy/maker-scheduler';

import { sessions } from '../localDb/schema';
import { buildSkipResultText, executePreRunHook, formatPreRunHookFailure } from './pre-run-hook';
import { capAppend, killProcessTree } from './proc-util';
import type { SchedulerDrizzleDb } from './storage';

const PROTOCOL = 'cindy-script/1' as const;
const LEGACY_PROTOCOL = 'xdt-maker-script/1' as const;
type ScriptProtocol = typeof PROTOCOL | typeof LEGACY_PROTOCOL;

const OUTPUT_CAP = 64 * 1024;
const FRAME_CAP = 256 * 1024;
const RESULT_CAP = 8 * 1024;
const MAX_INFLIGHT_CALLS = 16;
// 子进程已退出、还在等在途 broker 调用落地时的宿主截止时间。这段等待只为给
// 本轮 run 定成败(脚本已收不到 call_result),不该被一个卡死的 broker 调用
// 拖成"schedule 锁占到重启"——与 scriptConfig.timeoutMs(整轮、可不配)独立,
// 恒生效。broker 调用(jira/feishu/dispatch)正常秒级返回,30s 已非常宽裕。
const POST_EXIT_CALL_SETTLE_TIMEOUT_MS = 30_000;

const SCRIPT_ENV_ALLOWLIST = new Set([
  'APPDATA',
  'COMSPEC',
  'HOME',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'LOCALAPPDATA',
  'LOGNAME',
  'PATH',
  'PATHEXT',
  'SHELL',
  'SYSTEMROOT',
  'TEMP',
  'TMP',
  'TMPDIR',
  'USER',
  'USERNAME',
  'USERPROFILE',
  'WINDIR',
]);
const SENSITIVE_ENV_NAME_RE = /(?:AUTH|BEARER|COOKIE|CREDENTIAL|KEY|PASS(?:WORD|WD)?|SECRET|SESSION|TOKEN|JWT|PRIVATE)/i;

export function buildScriptEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (!SCRIPT_ENV_ALLOWLIST.has(name.toUpperCase())) continue;
    if (SENSITIVE_ENV_NAME_RE.test(name)) continue;
    env[name] = value;
  }
  // 协议标记:告知脚本客户端"运行在 script runner 下"。Python 端 protocol.py 见到
  // 它会在 import 期就做 fd 级 stdout 接管(真 stdout 私有化给协议帧、fd 1 重定向
  // 到 stderr),让脚本/三方库/子进程的杂音 print 无法污染严格 JSONL 通道。
  env.CINDY_SCRIPT_PROTOCOL = '1';
  // 老示例客户端仍读取该标记；保留到旧脚本迁移完成。
  env.XDT_MAKER_SCRIPT_PROTOCOL = '1';
  // 协议通道两个方向都是 UTF-8,但中文 Windows 上 Python 对 pipe stdio 默认按
  // locale(cp936)编解码,中文内容会撕坏 JSON 转义符(实测 BAD_FRAME)。protocol.py
  // 已显式 reconfigure 自保,这里再从宿主侧兜底,顺带覆盖不走 protocol.py 的裸脚本。
  env.PYTHONUTF8 = '1';
  return env;
}

export interface ScriptCapabilityCall {
  method: string;
  params: Record<string, unknown>;
}

export interface ScriptCapabilityBroker {
  call(
    request: ScriptCapabilityCall,
    granted: ReadonlySet<ScriptCapability>,
    context: { schedule: Schedule; runId?: string },
  ): Promise<unknown>;
  /**
   * 本轮 fire 终结(成功/失败/放弃等待在途调用)的统一收口:让残留的脚本
   * 通道意识调用 callId 立即失效(写盘授权不跨 run 存活;review P1)。可选——
   * 不带意识调用的 broker 实现无需提供。runId 维度隔离:scheduler 并发上限
   * 8、broker 单例,只能 finalize 本 run 的在途调用,不得误伤并发 run。
   */
  finalizeActiveCalls?(runId: string): void;
}

export interface ScriptScheduleRunnerDeps {
  broker: ScriptCapabilityBroker;
  logger: Logger;
  notifier?: Notifier;
  scheduler?: Scheduler;
  getDb?: () => SchedulerDrizzleDb;
}

interface CompleteFrame {
  protocol: ScriptProtocol;
  type: 'complete';
  resultText?: string;
  primarySessionId?: string | null;
}

interface CallFrame {
  protocol: ScriptProtocol;
  type: 'call';
  id: string;
  method: string;
  params?: Record<string, unknown>;
}

type ScriptFrame = CompleteFrame | CallFrame;

function safeError(error: unknown): { code: string; message: string } {
  const value = error as { errorCode?: unknown; code?: unknown; message?: unknown };
  const code =
    typeof value?.errorCode === 'string'
      ? value.errorCode
      : typeof value?.code === 'string'
        ? value.code
        : 'INTERNAL';
  return {
    code,
    message: typeof value?.message === 'string' ? value.message : String(error),
  };
}

export class ScriptScheduleRunner {
  constructor(private readonly deps: ScriptScheduleRunnerDeps) {}

  attachScheduler(scheduler: Scheduler): void {
    this.deps.scheduler = scheduler;
  }

  async fire(schedule: Schedule, ctx: FireContext): Promise<FireResult> {
    try {
      return await this.fireInner(schedule, ctx);
    } catch (error) {
      // 用户主动 pause/delete 触发的中断不该发"失败"通知——engine 那侧本就会把
      // 这轮 run 记成 'aborted' 而非 'failed'(agent 模式 runner.ts 的 abort 路径
      // 也不走任何 notify,这里之前是唯一的例外,codex review 发现)。只认
      // ctx.signal.aborted 这个权威信号,**不**按错误文本猜——脚本自己的失败
      // 消息/stderr 恰好含 'abort' 字样(如某个工具打印 "operation aborted")
      // 不代表这是我们的取消,按文本猜会把真实失败误吞成"已取消"而不通知
      // (codex review 三次发现:engine 侧那个 message 正则兜底,是因为它在事后
      // 才拿到 error 字符串、没有 signal 对象;这里有 signal 第一方引用,不需要
      // 也不该退化到模糊匹配)。
      if (!ctx.signal.aborted) {
        await this.notifyFailure(schedule, ctx, error instanceof Error ? error.message : String(error));
      }
      throw error;
    }
  }

  private async fireInner(schedule: Schedule, ctx: FireContext): Promise<FireResult> {
    const config = schedule.scriptConfig;
    if (schedule.executionMode !== 'script' || !config?.command.trim()) {
      throw new Error('script execution requires a non-empty command');
    }
    if (schedule.workspaceKind !== 'project' || !schedule.workingDir?.trim()) {
      throw new Error('script execution requires a local project workspace');
    }
    if (schedule.useWorktree || schedule.targetSessionId || schedule.persistentSession) {
      throw new Error('script execution does not support worktrees or bound sessions');
    }

    if (schedule.preRunHook?.command?.trim()) {
      const hook = await executePreRunHook({
        command: schedule.preRunHook.command,
        timeoutMs: schedule.preRunHook.timeoutMs,
        cwd: schedule.workingDir,
        signal: ctx.signal,
        stdinPayload: {
          event: 'schedule-pre-run',
          scheduleId: schedule.id,
          scheduleName: schedule.name,
          runId: ctx.runId,
          firedAt: ctx.firedAt,
          workingDir: schedule.workingDir,
          lastFinishedAt: schedule.lastFinishedAt,
        },
      });
      await ctx.onPreRunHookCompleted?.(hook);
      if (hook.aborted || ctx.signal.aborted) {
        this.deps.logger.info?.('[script-runner] pre-run hook aborted by pause/delete', {
          scheduleId: schedule.id,
          runId: ctx.runId,
        });
        throw new Error('fire aborted during pre-run hook');
      }
      if (hook.decision === 'skip') {
        this.deps.logger.info?.('[script-runner] pre-run hook blocked this fire', {
          scheduleId: schedule.id,
          runId: ctx.runId,
          exitCode: hook.exitCode,
          durationMs: hook.durationMs,
        });
        return {
          // exit 2 只保留 schedule_runs 中的 skipped 记录，不创建或更新会话。
          sessionId: '',
          skipped: true,
          resultText: buildSkipResultText(hook),
        };
      }
      if (hook.decision === 'block') {
        const errMsg = formatPreRunHookFailure(hook);
        this.deps.logger.warn?.('[script-runner] pre-run hook failed; fail-closed (script blocked)', {
          scheduleId: schedule.id,
          runId: ctx.runId,
          status: hook.status,
          exitCode: hook.exitCode,
          error: hook.error,
          stderr: hook.stderr.slice(0, 500),
        });
        throw new Error(errMsg);
      }
      this.deps.logger.info?.('[script-runner] pre-run hook passed (exit 0); script proceeds', {
        scheduleId: schedule.id,
        runId: ctx.runId,
        durationMs: hook.durationMs,
        stdout: hook.stdout.slice(0, 200),
      });
    }

    const granted = new Set(config.capabilities);
    const startedAt = Date.now();
    let child: ChildProcess;
    try {
      child = spawn(config.command, {
        shell: true,
        cwd: schedule.workingDir,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: buildScriptEnv(),
        detached: process.platform !== 'win32',
      });
    } catch (error) {
      throw new Error(`script spawn failed: ${safeError(error).message}`);
    }
    // 脚本在 host 写 start/call_result 帧之前就退出关闭 stdin(典型:命令打错、
    // shell 起了就死)会让 write() 撞 EPIPE/ERR_STREAM_DESTROYED——没有监听器时
    // Node 会当成未捕获的 stream error 往上抛,炸穿这层 async 边界。这里静默吞掉,
    // 真实失败原因由下面的 child.on('close'/'error') 走 exit.code / spawnError 上报,
    // 不会因为吞掉 stdin 错误而丢失诊断信息。
    child.stdin?.on('error', () => {});

    let stdoutBuffer = '';
    let stderr = '';
    // chunk 边界可能正好切在一个多字节 UTF-8 字符中间(中文/emoji 常见)——逐 chunk
    // 独立 toString('utf8') 会把被截断的字节解成替换字符(U+FFFD),即使后续 chunk
    // 补全了剩余字节也回不去了(codex review 第七轮发现:CJK resultText/call
    // params 可能被静默撕坏)。StringDecoder 跨 write() 调用维护未消费完的尾部
    // 字节,由它保证多字节字符不被 chunk 边界撕开。
    const stdoutDecoder = new StringDecoder('utf8');
    const stderrDecoder = new StringDecoder('utf8');
    // kill 后 close 可能永不触发(taskkill 异步失败/句柄异常)——scheduleForceSettle
    // 由下方 exit promise 填充,killTree 触发 1.5s 强制 settle,防 fire() 挂死占住
    // schedule 锁(pre-run-hook 同款兜底)。⚠️ 计时器只能在 killProcessTree 的
    // onSettled 回调里武装(它已把重试/后代兜底都跑完),不能在调用后立即武装,
    // 否则计时器与收敛动作并行赛跑、大概率抢跑(Greptile 二次 review 发现)。
    let scheduleForceSettle: () => void = () => {};
    // 子进程已经退出后,它的 pid 随时可能被 OS 复用给一个完全不相关的进程——
    // 这个时间点之后再对 child.pid 发 taskkill/进程组 kill 有误杀无关进程的风险
    // (codex review 第七轮发现:上一轮修复让 onAbort/超时回调在等待 inflightCalls
    // 期间仍会触发,而那时 exitPromise 已经 settle、child 早就不在了)。killTree
    // 因此在子进程确认退出后不再发起真实的 kill,只保留 cutoffReject 打断等待。
    let childHasExited = false;
    const killTree = (): void => {
      if (childHasExited) return;
      killProcessTree(child.pid, child, () => scheduleForceSettle());
    };
    let completed: CompleteFrame | null = null;
    let completeReceived = false;
    // complete 帧到达但仍有 host 调用在途(典型:sessions.dispatch/jira.add_comment
    // 这类写操作)时先缓一步——不能立即视为终态并关 stdin,否则写操作真实失败时
    // 这次 run 已经报了 success,失败被静默吞掉(codex review 发现)。等 inflight
    // 归零(finalizeCompletion 见下方 handleCall finally)才真正完成。
    let pendingComplete: CompleteFrame | null = null;
    // 脚本在某个调用结果出来之前就已声明 complete、而那个调用最终失败——脚本
    // 没机会看到/处理这次失败,不能悄悄用 pendingComplete 的"成功"结论收尾
    // (codex review 二次发现)。记下第一个这类失败,finalize 前提升为整轮失败。
    let deferredCallFailure: Error | null = null;
    let protocolError: Error | null = null;
    let timedOut = false;
    let inflight = 0;
    const seenIds = new Set<string>();
    // 子进程可能在某个 host 调用还没 resolve 时就自行退出(脚本发完 complete
    // 后立即 exit,不等 host 关 stdin)——child.on('close') 只反映"进程没了",
    // 不反映"我们的调用账本清了没"。exit 后必须等这些 promise 全部落地,否则
    // pendingComplete 永远等不到 finalize、被误判成"没发 complete 帧"
    // (codex review 三次发现)。
    const inflightCalls = new Set<Promise<void>>();
    // 子进程已经 close 之后,若还在等 inflightCalls 落地,abort/timeout 不能失效
    // (codex review 第七轮发现:此前等这段时 timer 已 clear、abort listener 已
    // remove,一个卡死的 broker 调用会让 fire() 永久占死 schedule 锁)。仅在
    // 真正进入等待阶段时赋值,之前(子进程尚存活)为 null,onAbort/timer 的行为
    // 不受影响。
    let cutoffReject: ((error: Error) => void) | null = null;
    // 首帧必须让只认识旧协议名的已部署脚本也能启动。客户端首次回帧后锁定
    // 它实际使用的协议，后续 call_result 再按同一版本返回。新客户端会接受旧
    // start 帧、主动用 cindy-script/1 回帧，因此双方可无停机迁移。
    let peerProtocol: ScriptProtocol | null = null;

    const writeFrame = (frame: Record<string, unknown>): void => {
      if (!child.stdin?.writable) return;
      child.stdin.write(`${JSON.stringify({ protocol: peerProtocol ?? LEGACY_PROTOCOL, ...frame })}\n`);
    };

    const finalizeCompletion = (frame: CompleteFrame): void => {
      completed = frame;
      child.stdin?.end();
    };

    const handleCall = async (frame: CallFrame): Promise<void> => {
      if (completeReceived) {
        // complete 之后脚本还在发 call——协议顺序违规,不静默接受。
        protocolError = new Error('script protocol call frame received after complete');
        killTree();
        return;
      }
      if (!frame.id || seenIds.has(frame.id)) {
        protocolError = new Error('script protocol duplicate or empty call id');
        killTree();
        return;
      }
      seenIds.add(frame.id);
      if (inflight >= MAX_INFLIGHT_CALLS) {
        writeFrame({
          type: 'call_result',
          id: frame.id,
          ok: false,
          error: { code: 'TOO_MANY_REQUESTS', message: 'too many in-flight calls' },
        });
        return;
      }
      inflight += 1;
      try {
        const result = await this.deps.broker.call(
          { method: frame.method, params: frame.params ?? {} },
          granted,
          { schedule, runId: ctx.runId },
        );
        // capabilities 的 protocol 字段也应反映本轮协商结果。否则旧客户端虽然
        // 能收发旧帧，却会在自省 payload 里突然看到新协议名，严格校验的脚本仍
        // 可能被迁移打断。broker 保持返回 canonical 新名称，wire 层在此适配。
        const responseResult =
          frame.method === 'host.capabilities' &&
          result !== null &&
          typeof result === 'object' &&
          !Array.isArray(result)
            ? { ...result, protocol: frame.protocol }
            : result;
        writeFrame({ type: 'call_result', id: frame.id, ok: true, result: responseResult });
      } catch (error) {
        writeFrame({ type: 'call_result', id: frame.id, ok: false, error: safeError(error) });
        if (completeReceived && !deferredCallFailure) {
          deferredCallFailure = error instanceof Error ? error : new Error(safeError(error).message);
        }
      } finally {
        inflight -= 1;
        if (inflight === 0 && pendingComplete) {
          const readyFrame = pendingComplete;
          pendingComplete = null;
          finalizeCompletion(readyFrame);
        }
      }
    };

    const handleLine = (line: string): void => {
      if (!line.trim()) return;
      if (line.length > FRAME_CAP) {
        protocolError = new Error('script protocol frame too large');
        killTree();
        return;
      }
      let frame: ScriptFrame;
      try {
        const parsed = JSON.parse(line) as unknown;
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          protocolError = new Error(
            'script stdout must contain JSONL protocol frames only; each line must be a complete cindy-script/1 JSON object, and logs belong on stderr',
          );
          killTree();
          return;
        }
        const record = parsed as Record<string, unknown>;
        if (record.protocol !== PROTOCOL && record.protocol !== LEGACY_PROTOCOL) {
          protocolError = new Error(
            `script stdout frame has an unsupported protocol; expected "${PROTOCOL}" or "${LEGACY_PROTOCOL}"`,
          );
          killTree();
          return;
        }
        if (peerProtocol !== null && record.protocol !== peerProtocol) {
          protocolError = new Error('script changed protocol versions within one run');
          killTree();
          return;
        }
        peerProtocol = record.protocol;
        if (record.type === 'call') {
          frame = record as unknown as CallFrame;
        } else if (record.type === 'complete') {
          frame = record as unknown as CompleteFrame;
        } else {
          protocolError = new Error(
            'script stdout frame has an invalid or missing type; expected "call" or "complete"',
          );
          killTree();
          return;
        }
      } catch {
        protocolError = new Error(
          'script stdout must contain JSONL protocol frames only; each line must be valid JSON for a cindy-script/1 frame, and logs belong on stderr',
        );
        killTree();
        return;
      }
      if (frame.type === 'call') {
        const callPromise = handleCall(frame);
        inflightCalls.add(callPromise);
        void callPromise.finally(() => inflightCalls.delete(callPromise));
        return;
      }
      if (frame.type === 'complete') {
        if (completeReceived) {
          protocolError = new Error('script emitted more than one complete frame');
          killTree();
          return;
        }
        completeReceived = true;
        if (inflight > 0) {
          // 还有 host 调用在途(sessions.dispatch/jira.add_comment 等写操作)——
          // 缓一步,等 handleCall 的 finally 里 inflight 归零后才真正终结。
          pendingComplete = frame;
          return;
        }
        finalizeCompletion(frame);
        return;
      }
      // ScriptFrame is exhaustively handled above.
    };

    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutBuffer += stdoutDecoder.write(chunk);
      while (true) {
        const newline = stdoutBuffer.indexOf('\n');
        if (newline < 0) break;
        const line = stdoutBuffer.slice(0, newline);
        stdoutBuffer = stdoutBuffer.slice(newline + 1);
        handleLine(line);
      }
      // 上限只约束"没有换行的残行"(它再长也不可能是合法帧);先消费完整帧再查,
      // 避免同一 chunk 里的合法多帧突发被整体误杀(review Angle A 发现)。
      if (stdoutBuffer.length > FRAME_CAP) {
        protocolError = new Error('script protocol frame too large');
        killTree();
      }
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = capAppend(stderr, stderrDecoder.write(chunk), OUTPUT_CAP);
    });

    writeFrame({
      type: 'start',
      context: {
        scheduleId: schedule.id,
        scheduleName: schedule.name,
        runId: ctx.runId,
        firedAt: ctx.firedAt,
        workingDir: schedule.workingDir,
      },
    });

    // Promise 的 executor 是同步执行的——构造(不是 await)完这个 promise 之后,
    // scheduleForceSettle 立刻拿到真实实现。必须先做这步,再做下面"若已经 abort
    // 立即杀"的检查:否则 killTree() 里调的还是最初的 no-op(codex review 二次
    // 发现:原顺序下 pre-aborted 场景的强制 settle 从未被真正武装,平台 kill 若
    // 恰好不触发 close,fire() 会永久挂起、占死 schedule 锁)。
    const exitPromise = new Promise<{ code: number | null; spawnError?: string }>((resolve) => {
      let settled = false;
      const settle = (value: { code: number | null; spawnError?: string }): void => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      scheduleForceSettle = () => {
        const timer = setTimeout(
          () => settle({ code: null, spawnError: 'process did not exit after kill' }),
          1_500,
        );
        timer.unref?.();
      };
      child.on('error', (error) => settle({ code: null, spawnError: error.message }));
      child.on('close', (code) => settle({ code }));
    });

    const onAbort = (): void => {
      killTree();
      cutoffReject?.(new Error('script execution aborted'));
    };
    // AbortSignal 已经 aborted 时 addEventListener 不会补发 'abort'——若在到达这里
    // 之前任务已被 pause/delete(signal 早就 abort 了),必须立即杀,否则无 timeout
    // 的脚本会一直挂着、fire() 永远等不到 close(codex review 发现)。
    if (ctx.signal.aborted) {
      killTree();
    } else {
      ctx.signal.addEventListener('abort', onAbort, { once: true });
    }
    const timeoutMs = config.timeoutMs;
    const timer =
      typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            killTree();
            cutoffReject?.(new Error(`script execution timed out after ${timeoutMs}ms`));
          }, timeoutMs)
        : undefined;
    timer?.unref?.();

    const exit = await exitPromise;
    childHasExited = true;
    // 子进程已经没了,decoder 里可能还压着一段没消费的多字节尾巴——在读取
    // stdoutBuffer/stderr 前先 flush,否则被截断的最后一个字符会丢失/半解码。
    stdoutBuffer += stdoutDecoder.end();
    stderr = capAppend(stderr, stderrDecoder.end(), OUTPUT_CAP);

    // 终态前有界收干净在途 broker 调用。broker 不支持取消——脚本已发出的写操作
    // (sessions.dispatch/jira.add_comment)只能等它落地,不等就抛终态的话,run
    // 已记 failed/aborted、schedule 锁已释放,而副作用还在后台继续,下一轮触发
    // 可能与之并发(codex review 发现)。收不干净时 30s 兜底放行,不为一个卡死
    // 的调用把终态无限期悬着。
    const drainInflightCalls = async (): Promise<void> => {
      if (inflightCalls.size === 0) return;
      await new Promise<void>((resolve) => {
        const guard = setTimeout(resolve, POST_EXIT_CALL_SETTLE_TIMEOUT_MS);
        guard.unref?.();
        // handleCall 内部全量 catch,这些 promise 理论上不会 reject——防御性两路都收。
        Promise.all(inflightCalls).then(
          () => {
            clearTimeout(guard);
            resolve();
          },
          () => {
            clearTimeout(guard);
            resolve();
          },
        );
      });
    };

    try {
      // 优先级与原顺序一致:abort > 协议违规 > 超时 > spawn 失败 > 非零退出。
      const preTerminalError = ctx.signal.aborted
        ? new Error('script execution aborted')
        : protocolError ??
          (timedOut
            ? new Error(`script execution timed out after ${timeoutMs}ms`)
            : exit.spawnError
              ? new Error(`script spawn failed: ${exit.spawnError}`)
              : exit.code !== 0
                ? new Error(`script exited with code ${exit.code}: ${stderr.slice(0, 1_000)}`)
                : null);
      if (preTerminalError) {
        await drainInflightCalls();
        throw preTerminalError;
      }
      if (stdoutBuffer.trim()) handleLine(stdoutBuffer);
      // 子进程已经 close(退出码 0),但可能还有 host 调用没 resolve(脚本发完
      // complete 就退出,不等 host 关 stdin)——等它们全部落地,pendingComplete
      // 才有机会真正 finalize 成 completed,deferredCallFailure 才有机会被设置。
      // ⚠️ 这段等待期间 timer/abort listener 仍然存活(直到下面 finally 才清)——
      // 若这里等的 broker 调用卡死,configured timeoutMs 或后续 pause/delete
      // 通过 cutoffReject 打断这段等待,而不是让 fire() 永久占死 schedule 锁
      // (codex review 第七轮发现)。timeoutMs 未配置是合法状态(不限时),彼时
      // 没有 timer——这段等待必须自带宿主截止时间:子进程已经退出,脚本再也收
      // 不到 call_result,继续等只是为了给这轮 run 定成败,broker 调用卡死不该
      // 换来"锁被占到重启"(Greptile 五轮发现)。
      if (inflightCalls.size > 0) {
        await new Promise<void>((resolve, reject) => {
          const guard = setTimeout(
            () =>
              reject(
                new Error(
                  `host call did not settle within ${POST_EXIT_CALL_SETTLE_TIMEOUT_MS}ms after script exit`,
                ),
              ),
            POST_EXIT_CALL_SETTLE_TIMEOUT_MS,
          );
          guard.unref?.();
          const settleWait = (fn: () => void): void => {
            clearTimeout(guard);
            fn();
          };
          cutoffReject = (error) => settleWait(() => reject(error));
          Promise.all(inflightCalls).then(
            () => settleWait(resolve),
            () => settleWait(resolve),
          );
        });
      }
      if (ctx.signal.aborted) throw new Error('script execution aborted');
      if (protocolError) throw protocolError;
      if (timedOut) throw new Error(`script execution timed out after ${timeoutMs}ms`);
    } finally {
      if (timer) clearTimeout(timer);
      ctx.signal.removeEventListener('abort', onAbort);
      cutoffReject = null;
      // 本轮 fire 终结(无论成败):放弃等待的在途调用不能再留着写盘授权——
      // 否则旧 callId 要等 pipeDispatcher 超时(上限 30min)才失效,而下一轮
      // fire 可能已开始(review P1)。按 runId 收口:scheduler 可并发跑多个
      // schedule,只 finalize 本 run 的在途调用,不误伤并发 run(第二个 P1)。
      this.deps.broker.finalizeActiveCalls?.(ctx.runId);
    }
    // deferredCallFailure 只在闭包(handleCall)内被赋值,TS 的控制流分析看不到
    // 那次赋值、一直把这里narrow 回声明时的 null——显式断言绕开,不是真的绕过
    // null 检查(下面 if 仍是运行时判空)。
    const failedDeferredCall = deferredCallFailure as Error | null;
    if (failedDeferredCall) {
      throw new Error(
        `script declared completion before a host call it made had finished, and that call failed: ${failedDeferredCall.message}`,
      );
    }
    const finished = completed as CompleteFrame | null;
    if (!finished) {
      throw new Error(
        'script exited without a complete frame; it must finish with a cindy-script/1 "complete" frame',
      );
    }

    // 脚本上报的 primarySessionId 是不可信输入:schedule_runs.session_id 对
    // sessions.id 有外键,笔误/过期/编造的 id 会让引擎在 run 已经成功之后的
    // 落库环节撞 FK,整个收尾流程炸掉而不是记一次可控失败(codex review 发现)。
    // 能查库就先验存在性;查无此会话(或校验自身出错)按"无会话"降级——warn +
    // 空串,run 照常 success,只是不带会话链接。
    let primarySessionId = finished.primarySessionId ?? '';
    if (primarySessionId && this.deps.getDb) {
      try {
        const [row] = await this.deps
          .getDb()
          .select({ id: sessions.id })
          .from(sessions)
          .where(eq(sessions.id, primarySessionId))
          .limit(1);
        if (!row) {
          this.deps.logger.warn?.('[script-runner] script reported an unknown primarySessionId; dropping it', {
            scheduleId: schedule.id,
            runId: ctx.runId,
            primarySessionId,
          });
          primarySessionId = '';
        }
      } catch (err) {
        this.deps.logger.warn?.('[script-runner] primarySessionId validation failed; dropping it', err);
        primarySessionId = '';
      }
    }

    // Script schedules learn their primary session from the terminal protocol frame rather
    // than the prompt runner's early binding path. Publish the existing binding event before
    // the scheduler notifier runs so renderer-side completion handling cannot emit a duplicate.
    if (primarySessionId) {
      try {
        await ctx.onSessionBound?.(primarySessionId);
      } catch (err) {
        this.deps.logger.warn?.('[script-runner] onSessionBound failed (non-fatal)', err);
      }
    }

    this.deps.logger.info?.('[script-runner] script completed', {
      scheduleId: schedule.id,
      runId: ctx.runId,
      durationMs: Date.now() - startedAt,
      stderr: stderr.slice(0, 500),
    });
    const result: FireResult = {
      sessionId: primarySessionId,
      resultText: finished.resultText?.slice(0, RESULT_CAP),
    };
    if (this.deps.notifier) {
      const finalRun: ScheduleRun = {
        id: ctx.runId,
        scheduleId: schedule.id,
        sessionId: result.sessionId || undefined,
        firedAt: ctx.firedAt,
        finishedAt: Date.now(),
        status: 'success',
        resultText: result.resultText,
      };
      try {
        await this.deps.notifier.notify(schedule, finalRun);
      } catch (err) {
        this.deps.logger.warn?.('script notifier.notify threw (should not happen)', err);
      }
    }
    return result;
  }

  private async notifyFailure(schedule: Schedule, ctx: FireContext, errMsg: string): Promise<void> {
    if (!this.deps.notifier) return;
    const fauxRun: ScheduleRun = {
      id: ctx.runId,
      scheduleId: schedule.id,
      firedAt: ctx.firedAt,
      finishedAt: Date.now(),
      status: 'failed',
      errorMsg: errMsg,
    };
    try {
      await this.deps.notifier.notify(schedule, fauxRun);
    } catch {
      // DesktopNotifier already swallows; keep script runner fail-safe if a notifier regresses.
    }
  }
}
