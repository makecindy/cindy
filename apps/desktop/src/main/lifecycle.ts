/**
 * 退出生命周期注册器 —— 把散落在各模块的 quit / crash 清理逻辑收口到一处编排,
 * 避免多个 handler 互相 race、避免 fire-and-forget 在进程死之前来不及跑完。
 *
 * 使用方法 (在 main bootstrap 里):
 *   onQuit('shutdown-maker', shutdownMaker,                 'sync');
 *   onQuit('im',             () => im.dispose(),            'async');
 *   onQuit('local-db-close',    closeDb,                    'post-async');
 *   installQuitHandler();
 *
 * 执行顺序:
 *   1. sync       —— 串行跑, 吞个体异常不影响后续。允许返回 Promise 但不会被 await
 *                    (出现时只 warn, 鼓励标成 async)
 *   2. async      —— 并发跑, 整体不超过 timeoutMs (默认 2000ms), 超时谁没完就被腰斩
 *   3. post-async —— 串行跑, 确保依赖 async 阶段产物的清理 (例如关 sqlite 必须晚于
 *                    db.backup, 关 IM WS 必须晚于 announce offline)
 *
 * 然后 `app.exit(<code>)` 强制退出。`will-quit` / `quit` 事件不会触发——任何
 * 真正必须执行的清理都必须注册到这里, 而不是挂 `will-quit`。
 *
 * shutdown 开始时同步布防外部硬杀 watchdog (armShutdownHardKillWatchdog):
 * disposer 挂死、事件循环被 sync 代码阻塞、甚至 app.exit 在 native teardown
 * 挂死 (JS 已死) 时, 由 detached 外部进程在宽限期后 kill -9 补刀, 保证退出有界。
 *
 * installQuitHandler() 同时把以下入口都收到这条 disposer chain:
 *
 *   - app.on('before-quit')             —— 用户/代码主动退出 (Cmd+Q / 关窗 / app.quit)
 *   - process.on('SIGINT'/'SIGTERM')    —— Ctrl+C / kill PID (dev 终端必装)
 *   - process.on('uncaughtException')   —— main 进程未捕获异常
 *   - app.on('render-process-gone')     —— renderer 崩 (main 还活)
 *
 * unhandledRejection 只记日志、不退出 —— 悬空 Promise 不必然致命, 让上游决定。
 * 真硬崩 (segfault / kill -9) JS 层无能为力, 这里覆盖不到; 子进程靠 stdin EOF 自死。
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { app, BrowserWindow, session } from 'electron';

import {
  createLogger,
  disableDevTerminalMirror,
  isBrokenStdioError,
  isTransientNetworkError,
} from './logger';
import { noteQuitDisposersCompleted, noteShutdownBegin } from './startup-diagnostics';
import { isGhostSandboxWebContentsId } from './cindy-brain/runtime/electronSandboxAdapter';
import { isRsbNativePopupWebContentsId } from './rsb-browser-bridge/native-popup-surfaces';

/**
 * 瞬时网络错误的 wire payload (main → renderer)。code 永远存在 (Node 的 ErrnoException
 * 一定有 code), address/port 可能没有 (e.g. fetch 在 DNS 阶段失败时只有 hostname)。
 * 不带 stack —— 给用户看的 toast 不需要, 全栈已经在 main.log 里。
 */
export interface TransientNetworkErrorTipPayload {
  code: string;
  address?: string;
  port?: number;
}

/**
 * 广播 "瞬时网络错误" 提示到所有 renderer。lifecycle 兜底命中时调用,
 * renderer 自己决定怎么展示 (toast / banner / 忽略, 看 systemNetworkErrorToast.ts)。
 *
 * 故意吞所有错 —— 调用方是 uncaughtException handler, 这里再 throw 会形成
 * 二次 uncaughtException 死循环。
 */
function broadcastTransientNetworkErrorTip(err: NodeJS.ErrnoException): void {
  try {
    // address/port 不在 ErrnoException 的官方 typing 里, 但 Node 的 net.connect
    // 失败时确实会挂上去 (历史 main.log 已验证)。用 index 读避免 cast 出整个 any。
    const e = err as unknown as Record<string, unknown>;
    const payload: TransientNetworkErrorTipPayload = {
      code: err.code ?? 'UNKNOWN',
    };
    if (typeof e.address === 'string') payload.address = e.address;
    if (typeof e.port === 'number') payload.port = e.port;
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send('system:transient-network-error', payload);
      }
    }
  } catch (broadcastErr) {
    log.warn('failed to broadcast transient-network-error tip', broadcastErr);
  }
}

const log = createLogger('lifecycle');
let brokenStdioWarningLogged = false;

export type DisposerPhase = 'sync' | 'async' | 'post-async';

interface Disposer {
  name: string;
  phase: DisposerPhase;
  fn: () => void | Promise<void>;
}

const registry: Disposer[] = [];

export function onQuit(
  name: string,
  fn: () => void | Promise<void>,
  phase: DisposerPhase = 'sync',
): void {
  registry.push({ name, phase, fn });
}

export async function runQuitDisposers(timeoutMs = 2000): Promise<void> {
  // ── Phase 1: sync ────────────────────────────────────────────────────────
  for (const d of registry.filter((x) => x.phase === 'sync')) {
    try {
      const ret = d.fn();
      if (ret && typeof (ret as Promise<unknown>).then === 'function') {
        log.warn(`sync disposer "${d.name}" returned a promise — not awaited`);
      }
    } catch (err) {
      log.error(`sync disposer "${d.name}" threw`, err);
    }
  }

  // ── Phase 2: async (concurrent, bounded by timeout) ──────────────────────
  const asyncs = registry.filter((x) => x.phase === 'async');
  if (asyncs.length > 0) {
    const settled = Promise.allSettled(
      asyncs.map((d) =>
        Promise.resolve()
          .then(() => d.fn())
          .catch((err) => {
            log.error(`async disposer "${d.name}" threw`, err);
            throw err;
          }),
      ),
    );
    let timedOut = false;
    await Promise.race([
      settled,
      new Promise<void>((resolve) =>
        setTimeout(() => {
          timedOut = true;
          resolve();
        }, timeoutMs),
      ),
    ]);
    if (timedOut) {
      log.warn(`async disposers timed out after ${timeoutMs}ms — proceeding to post-async`);
    }
  }

  // ── Phase 3: post-async ──────────────────────────────────────────────────
  // 返回 Promise 的 disposer 同样纳入 timeoutMs 预算 (逐个 race, 串行语义不变)。
  // 此前这里是无界 await —— 生产实证: 单个挂死的 post-async disposer 就能让
  // "runQuitDisposers completed" 永远打不出来, 进程卡在退出路径上不死。
  for (const d of registry.filter((x) => x.phase === 'post-async')) {
    try {
      const ret = d.fn();
      if (ret && typeof (ret as Promise<unknown>).then === 'function') {
        const settled = (ret as Promise<unknown>).catch((err) =>
          log.error(`post-async disposer "${d.name}" threw`, err),
        );
        let timer: NodeJS.Timeout | undefined;
        let timedOut = false;
        await Promise.race([
          settled,
          new Promise<void>((resolve) => {
            timer = setTimeout(() => {
              timedOut = true;
              resolve();
            }, timeoutMs);
          }),
        ]);
        clearTimeout(timer);
        if (timedOut) {
          log.warn(`post-async disposer "${d.name}" timed out after ${timeoutMs}ms — continuing`);
        }
      }
    } catch (err) {
      log.error(`post-async disposer "${d.name}" threw`, err);
    }
  }
}

/**
 * 外部硬杀 watchdog 的宽限期 (秒)。disposer 预算 6s 的 3 倍余量; 比更新脚本的
 * 120s (updateScriptMacOS) 激进得多 —— 这是常规退出路径, 用户在旁边等。
 */
export const SHUTDOWN_HARD_KILL_GRACE_SECONDS = 20;

/** 最小 spawn 形状 —— 单测注入 fake 用, 真实实现是 node:child_process 的 spawn。 */
type WatchdogSpawn = (
  command: string,
  args: string[],
  options: { detached: boolean; stdio: 'ignore'; windowsHide?: boolean },
) => {
  unref(): void;
  /** ChildProcess 的 'error' 事件订阅; fake 可省略 (可选调用)。 */
  once?(event: 'error', listener: (err: Error) => void): unknown;
};

/**
 * win32 watchdog 脚本 (WSH JScript) —— 单进程完成 sleep / 身份校验 / 补刀,
 * 零子进程。为什么是 wscript 而不是 PowerShell / cmd, 见
 * armShutdownHardKillWatchdog 内 win32 分支的注释。
 *
 * 约束 (均为实机踩坑实证):
 *   - 纯 ASCII: WSH 按系统 ANSI 代码页读文件, 非 ASCII 注释会乱码;
 *   - ES3 语法: JScript 没有 const/let/箭头函数, 函数调用**不允许尾逗号**
 *     (尾逗号是语法错, //B 模式下静默失败, watchdog 形同虚设);
 *   - pid / 宽限期 / execPath 全部走命令行参数, 内容与具体一次运行无关 ——
 *     因此可以固定文件名、启动期预生成、双实例覆盖写也无冲突。
 */
const WATCHDOG_SCRIPT_CONTENT = [
  '// Cindy shutdown hard-kill watchdog (win32).',
  '// Regenerated by Cindy at every app startup; safe to delete when Cindy is not running.',
  '// Usage: wscript.exe //B //E:JScript <this file> <pid> <graceMs> <expectedExePath>',
  '// Kills <pid> after <graceMs> ONLY if the process still exists with the same',
  '// WMI CreationDate (captured while the arming process was provably alive) and',
  '// the same executable path - a reused PID never matches both.',
  'var args = WScript.Arguments;',
  'var pid = parseInt(args(0), 10);',
  'var graceMs = parseInt(args(1), 10);',
  "var expectPath = ('' + args(2)).toLowerCase();",
  '',
  'function query() {',
  '  try {',
  "    var wmi = GetObject('winmgmts:{impersonationLevel=impersonate}!\\\\\\\\.\\\\root\\\\cimv2');",
  "    var sql = 'SELECT ProcessId, ExecutablePath, CreationDate FROM Win32_Process WHERE ProcessId=' + pid;",
  '    var rows = new Enumerator(wmi.ExecQuery(sql));',
  '    return rows.atEnd() ? null : rows.item();',
  '  } catch (e) {',
  "    return null; // WMI unavailable -> never kill (fail toward 'no kill')",
  '  }',
  '}',
  '',
  'var before = query();',
  'if (before !== null) {',
  "  var started = '' + before.CreationDate;",
  '  WScript.Sleep(graceMs);',
  '  var after = query();',
  "  if (after !== null && ('' + after.CreationDate) === started && ('' + after.ExecutablePath).toLowerCase() === expectPath) {",
  '    try {',
  '      after.Terminate();',
  '    } catch (e2) {',
  '      // already exiting / access denied -> nothing to do',
  '    }',
  '  }',
  '}',
  '',
].join('\r\n');

let _watchdogScriptPath: string | null = null;
let _watchdogScriptPrepareFailed = false;

/**
 * 预生成 win32 watchdog 脚本到 mkdtemp 唯一目录 (不可预测路径)。
 * 在 installQuitHandler (启动期) 调用; 布防期 (armShutdownHardKillWatchdog)
 * 再次调用时先校验缓存路径的文件是否仍存在 —— 杀毒软件或临时目录清理可能
 * 在运行期间删除脚本, 此时清除缓存并重新生成到新目录。
 * 写盘失败直接抛给调用方: 启动期调用点只 warn (布防期走缺席标记路径)。
 * 非 win32 平台 no-op 返回 null。失败一次后不再重试
 * (避免退出热路径被无响应存储阻塞)。
 */
export function prepareShutdownWatchdogScript(
  options: { platform?: NodeJS.Platform; tmpDir?: string } = {},
): string | null {
  const platform = options.platform ?? process.platform;
  if (platform !== 'win32') return null;
  if (_watchdogScriptPath) {
    if (existsSync(_watchdogScriptPath)) return _watchdogScriptPath;
    _watchdogScriptPath = null;
  }
  if (_watchdogScriptPrepareFailed) return null;
  try {
    const dir = mkdtempSync(join(options.tmpDir ?? tmpdir(), 'cindy-wd-'));
    const scriptPath = join(dir, 'watchdog.js');
    writeFileSync(scriptPath, WATCHDOG_SCRIPT_CONTENT);
    _watchdogScriptPath = scriptPath;
    return scriptPath;
  } catch (e) {
    _watchdogScriptPrepareFailed = true;
    throw e;
  }
}

let _watchdogArmed = false;
/**
 * watchdog spawn 总尝试预算(同步/异步失败共享计数,防 error→重试死循环):
 * 3 次足以吸收 EAGAIN(fork 上限)这类瞬时抖动;仍然全失败 = 环境级问题
 * (ENOENT/EACCES),本进程从内部**不可能**布防任何外部补刀,重试再多也无意义
 * (review:此为可接受的终态)。耗尽时打一条明确的缺席标记(error 级),让
 * 退出尸检一眼看出"这次 shutdown 没有外部兜底"。
 */
const WATCHDOG_MAX_SPAWN_ATTEMPTS = 3;
let _watchdogSpawnAttempts = 0;

function noteWatchdogSpawnFailure(err: unknown, options: Parameters<typeof armShutdownHardKillWatchdog>[0]): void {
  _watchdogArmed = false;
  if (_watchdogSpawnAttempts < WATCHDOG_MAX_SPAWN_ATTEMPTS) {
    log.warn('shutdown hard-kill watchdog process failed to start (retrying)', err);
    armShutdownHardKillWatchdog(options);
    return;
  }
  log.error(
    `shutdown hard-kill watchdog UNAVAILABLE after ${_watchdogSpawnAttempts} spawn attempts — ` +
      'external kill backstop ABSENT for this shutdown (continuing without it)',
    err,
  );
}

/**
 * 布防外部硬杀 watchdog: spawn 一个 detached 的外部杀手进程, 宽限期后对本进程
 * PID 补 kill。这是唯一能同时覆盖三类退出挂死的手段:
 *   - sync disposer 阻塞事件循环 (JS 层 setTimeout 根本不会触发)
 *   - post-async 无界 await (Phase 3 已加预算, 这里是第二道保险)
 *   - app.exit() 在 native teardown 挂死 —— 实证见 updateScriptMacOS.ts:
 *     2026-07-06 观测到 exit 已打日志但 PID 存活 32h, 彼时 JS 事件循环已死,
 *     进程无法自救, 只有外部进程能补刀。
 *
 * 正常退出时本进程早已死透, 补刀落空无害 (kill 静默失败)。PID 复用防护 (review
 * P1 两轮): 映像名/命令行校验区分不了同一 App 的两次运行 (正常退出后更新器立即
 * 重启、新实例在宽限期内拿到复用 PID 会被误杀), 所以 watchdog 在布防时刻 (本进程
 * 必然存活) 先捕获目标 PID 的**进程创建时间** (POSIX: ps lstart; win32: WMI
 * CreationDate), 补刀前重取一次并比对 execPath, 不一致 = PID 已易主, 放弃。
 * 残余窗口只剩 "本进程在 watchdog 子进程完成首次捕获前 (毫秒级) 就退出且
 * PID 立即复用给另一个同路径进程", 视为可接受。
 *
 * 幂等: 进程生命周期内只布防一次。spawn/pid/platform 可注入, 便于单测;
 * 布防失败只 warn, 绝不阻断正常退出。
 */
export function armShutdownHardKillWatchdog(
  options: {
    spawn?: WatchdogSpawn;
    pid?: number;
    platform?: NodeJS.Platform;
    graceSeconds?: number;
    /** 进程身份锚点 (杀前校验用), 默认 process.execPath;测试注入。 */
    execPath?: string;
    /** win32 watchdog 脚本落盘目录, 默认 os.tmpdir();测试注入。 */
    tmpDir?: string;
  } = {},
): void {
  if (_watchdogArmed) return;
  if (_watchdogSpawnAttempts >= WATCHDOG_MAX_SPAWN_ATTEMPTS) return; // 预算耗尽,缺席标记已打
  _watchdogArmed = true;
  _watchdogSpawnAttempts += 1;
  const spawnFn = options.spawn ?? spawn;
  const pid = options.pid ?? process.pid;
  const platform = options.platform ?? process.platform;
  const graceSeconds = options.graceSeconds ?? SHUTDOWN_HARD_KILL_GRACE_SECONDS;
  const execPath = options.execPath ?? process.execPath;
  try {
    // 杀前校验进程身份 (review P1 两轮): 宽限期内 OS 复用了该 PID 时, 盲杀会误伤。
    // 两平台都以进程创建时间为身份锚点: 布防时刻本进程必然存活, watchdog 先捕获
    // 目标 PID 的创建时间, 补刀前重取比对, 不一致 = PID 已易主, 放弃补刀。
    const child =
      platform === 'win32'
        ? (() => {
            // 不用 PowerShell —— 360 等安全软件把"隐藏拉起 PowerShell"当高危
            // 动作拦截, 每次正常退出都弹风控 (2026-08 实证: 原实现的
            // -WindowStyle Hidden 正中"隐藏执行 PowerShell"规则)。也不用
            // cmd + tasklist 轮询 —— 实机验证发现两条死路:
            //   - 非 detached 的子进程在 libuv 的 kill-on-close job object 里,
            //     父进程一死就被 OS 连带击杀, 根本活不到补刀;
            //   - detached 逃出 job 但没有控制台 (DETACHED_PROCESS 会让
            //     CREATE_NO_WINDOW 失效), cmd 的每个子工具进程都要另开控制台,
            //     既闪窗, 管道还会因句柄泄进新 conhost 而永久收不到 EOF
            //     (实测 findstr 无限挂起, watchdog 名存实亡)。
            // wscript (GUI 子系统, 天生无控制台) + 单进程 JScript 两个问题都
            // 不存在: Sleep / WMI 查询 / Terminate 全部进程内完成, 零子进程;
            // detached 逃出 libuv job 得以活过父进程; 身份校验与原 PowerShell
            // 实现同强度 (CreationDate + ExecutablePath 双校验)。//B 批处理
            // 模式吞掉一切脚本错误弹窗, WSH 被禁用/损坏时静默不杀 —— 失败
            // 方向永远是"少杀"。脚本内容见 WATCHDOG_SCRIPT_CONTENT。
            const scriptPath = prepareShutdownWatchdogScript({
              platform,
              tmpDir: options.tmpDir,
            });
            // platform 为 win32 时 prepare 只可能返回路径或 throw (写盘失败);
            // throw 由外层 catch 接住, 走 spawn 失败的重试/缺席标记路径。
            if (!scriptPath) throw new Error('watchdog script unavailable');
            return spawnFn(
              `${process.env.SystemRoot ?? 'C:\\Windows'}\\System32\\wscript.exe`,
              [
                '//B',
                '//E:JScript',
                scriptPath,
                String(pid),
                String(graceSeconds * 1000),
                execPath,
              ],
              { detached: true, windowsHide: true, stdio: 'ignore' },
            );
          })()
        : spawnFn(
            '/bin/sh',
            [
              '-c',
              // lstart 是完整启动时间字符串 (秒级), 同 PID + 同启动秒 + 同 execPath
              // 的碰撞视为不可能。捕获时进程已死则直接退出 (不需要补刀)。
              `started="$(ps -p ${pid} -o lstart= 2>/dev/null)"; ` +
                `[ -n "$started" ] || exit 0; ` +
                `sleep ${graceSeconds}; ` +
                `[ "$(ps -p ${pid} -o lstart= 2>/dev/null)" = "$started" ] && ` +
                `ps -p ${pid} -o command= 2>/dev/null | grep -qF '${execPath.replace(/'/g, `'\\''`)}' && ` +
                `kill -9 ${pid} 2>/dev/null`,
            ],
            { detached: true, stdio: 'ignore' },
          );
    // spawn 的失败可能在返回后经 'error' 事件异步上报 (ENOENT/EACCES 等);
    // 不挂 listener 会变成 uncaughtException, 且 watchdog 实际未布防却无任何
    // 日志痕迹 —— 这里 warn 留痕, 让退出尸检能看出"补刀兜底当时不在位"。
    child.once?.('error', (err) => {
      // 异步启动失败 = 实际未布防(review P1 两轮):回置标志,预算内立即重试,
      // 耗尽则打缺席标记(见 noteWatchdogSpawnFailure)。
      noteWatchdogSpawnFailure(err, options);
    });
    child.unref();
    // log 放在 spawn 之后 (review P1): 统一 logger 同步写日志文件, 坏盘/网络盘
    // 上可能阻塞 —— watchdog 必须在任何可能卡住的盘 IO 之前先布防好。
    log.info(`arming shutdown hard-kill watchdog: pid=${pid} grace=${graceSeconds}s`);
  } catch (err) {
    // 同步 spawn 失败 = 实际未布防:与异步 error 共享尝试预算,预算内重试,
    // 耗尽打缺席标记(日志由 noteWatchdogSpawnFailure 统一输出)。
    noteWatchdogSpawnFailure(err, options);
  }
}

let _installed = false;
let _isDisposing = false;
let _disposeStarted: Promise<void> | null = null;

/**
 * 「致命 shutdown」观察者 —— 目前唯一消费者是日志上报的崩溃即时路径。
 *
 * 为什么用注册回调而不是让 lifecycle 直接 import 上报模块:上报模块要 onQuit() 注册自己的
 * 清理,反向 import 会成环。接线由 bootstrap 完成,lifecycle 只管「什么时候派发」。
 *
 * ⚠️ 回调**不是 disposer**:它不进 registry,因此不占 runQuitDisposers 的 timeoutMs 预算、
 * 也不推迟其起点(需求「不拖慢退出」)。代价是回调必须自己保证极短 —— 只允许做同步小写盘
 * 或 fire-and-forget,绝不能 await 网络。
 */
type FatalShutdownListener = (reason: string) => void;
const fatalShutdownListeners: FatalShutdownListener[] = [];

export function onFatalShutdown(listener: FatalShutdownListener): void {
  fatalShutdownListeners.push(listener);
}

/**
 * reason 是否属于「致命崩溃」。
 *
 * 判据收口在这里是有意的:自挂 process 事件的实现会漏掉渲染进程崩溃(白屏),并把可恢复的
 * 悬空 promise 误报成崩溃。能走到 beginShutdown 的 uncaughtException 已经被上面的
 * broken-stdio / 瞬时网络两个分支筛过,渲染进程崩溃也已排除沙箱与 webview guest。
 * 未知 reason 一律不算崩溃(宁可漏报,也不把正常退出当崩溃)。
 */
export function isFatalShutdownReason(reason: string): boolean {
  return reason === 'uncaughtException' || reason.startsWith('render-process-gone:');
}

function notifyFatalShutdown(reason: string): void {
  if (!isFatalShutdownReason(reason)) return;
  for (const listener of fatalShutdownListeners) {
    try {
      listener(reason);
    } catch (err) {
      // 观察者出错绝不能影响退出链。
      log.warn('fatal-shutdown listener threw', err);
    }
  }
}

/**
 * 幂等启动 disposer chain: 第一次调用真的跑, 后续调用复用同一个 Promise。
 * 返回的 Promise 在 sync + async + post-async 三阶段都跑完 (或 async 超时) 后 resolve。
 *
 * reason 是触发入口标识(before-quit / signal:SIGTERM / uncaughtException /
 * render-process-gone:<reason>),同时写进 run marker(startup-diagnostics),
 * 让下次启动的退出尸检能还原「这次 shutdown 是谁发起的」。
 */
function beginShutdown(timeoutMs: number, reason: string): Promise<void> {
  if (_disposeStarted) return _disposeStarted;
  _isDisposing = true;
  // watchdog 必须是 shutdown 的第一个动作 (review P1): log 与 noteShutdownBegin
  // 都是同步盘 IO (日志文件 / run-marker 的 mkdirSync+writeFileSync), 落在坏盘
  // 或网络盘上可能无限阻塞 —— 那正是 watchdog 要兜的挂死形态, 不能让布防
  // 排在它们后面。spawn 本身不做盘写 (win32 的 watchdog 脚本已在启动期由
  // installQuitHandler 预生成; 仅当启动期预生成失败时布防才会内联补写一次)。
  armShutdownHardKillWatchdog();
  log.info(`beginShutdown timeoutMs=${timeoutMs} reason=${reason}`);
  noteShutdownBegin(reason);
  // 致命崩溃的观察者派发排在 disposer chain **之前**: 崩溃现场的待补传标记必须在清理链
  // 开始前落盘(清理链可能超时被腰斩,甚至进程可能马上就没了)。回调不进 registry,
  // 不占 timeoutMs 预算(见 onFatalShutdown 的注释)。
  notifyFatalShutdown(reason);
  _disposeStarted = runQuitDisposers(timeoutMs)
    .then(() => {
      log.info('runQuitDisposers completed');
      noteQuitDisposersCompleted();
    })
    .catch((err) => {
      log.error('runQuitDisposers threw', err);
    });
  return _disposeStarted;
}

export function installQuitHandler(timeoutMs = 2000): void {
  if (_installed) return;
  _installed = true;

  // win32 watchdog 脚本在启动期预生成 —— 布防发生在 shutdown 热路径, 必须保持
  // 零盘 IO (见 beginShutdown 注释)。这里失败只 warn: 布防时还有一次内联重试,
  // 两次都失败才会打"缺席标记"。
  if (process.platform === 'win32') {
    try {
      prepareShutdownWatchdogScript();
    } catch (err) {
      log.warn('failed to pre-generate shutdown watchdog script (will retry at arm time)', err);
    }
  }

  // ── Built-in: 强制 Chromium 把 renderer 攒批的 localStorage 写入落盘 ────
  // Chromium 的 LocalStorageImpl 在 browser 进程里有秒级 batch 才提交到
  // <userData>/Local Storage/leveldb。我们 disposer chain 末尾走 app.exit()
  // 强退, 跳过 Chromium 的 graceful storage close, 中间几秒的 setItem 写入
  // 直接丢——在 release 的"热更新→relaunch"路径上,用户切完模型/permission
  // 立刻按"立即重启"几乎注定丢一次 prefs。post-async 阶段调一次 flush, 让
  // Chromium 把内存中的 DOMStorage 同步到 LevelDB。
  // flushStorageData 是 fire-and-forget 的 sync API; 实测够用——Chromium
  // 收到调用后内部立即 schedule 一次 commit, app.exit 之前足以走完。
  onQuit(
    'flush-storage-data',
    () => {
      try {
        session.defaultSession.flushStorageData();
      } catch (err) {
        log.warn('flushStorageData threw', err);
      }
    },
    'post-async',
  );

  // ── Layer 1: graceful quit (before-quit) ────────────────────────────────
  // preventDefault 阻断默认 quit, 等 disposer chain 跑完再 app.exit(0)。
  app.on('before-quit', (e) => {
    // arm-first(review P1):本 handler 必然走向退出,而下面第一行 log 就是
    // 同步盘 IO——日志落在坏盘/网络盘上时会在布防前就挂死,watchdog 形同虚设。
    // 幂等,与 beginShutdown 里的布防互为兜底。
    armShutdownHardKillWatchdog();
    log.info('before-quit received');
    if (_isDisposing) return;
    e.preventDefault();
    void beginShutdown(timeoutMs, 'before-quit').finally(() => app.exit(0));
  });

  // ── Layer 2: Unix process signals ───────────────────────────────────────
  // SIGINT (Ctrl+C in dev terminal) / SIGTERM (systemd / kill PID)。
  // Electron 不会把这两个信号转 app.before-quit, 必须自己接。
  // 走 app.quit() 会 emit before-quit; 我们在那里 preventDefault 等 disposer
  // 跑完再 exit。如果 app 还没 ready, 直接走 disposer chain 然后 exit。
  const shutdownSignals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM'];
  if (process.platform === 'win32') shutdownSignals.push('SIGBREAK');
  for (const sig of shutdownSignals) {
    process.on(sig, () => {
      // arm-first(review P1):同 before-quit,先布防再碰日志盘 IO。
      armShutdownHardKillWatchdog();
      log.info(`received ${sig}, gracefully shutting down`);
      if (_isDisposing) return;
      if (app.isReady()) {
        app.quit();
      } else {
        const code = sig === 'SIGINT' ? 130 : sig === 'SIGTERM' ? 143 : 131;
        void beginShutdown(timeoutMs, `signal:${sig}`).finally(() => app.exit(code));
      }
    });
  }

  process.on('exit', (code) => {
    if (!_isDisposing) {
      log.warn(`process exit without lifecycle disposal code=${code}`);
    }
  });

  // ── Layer 3: main 进程未捕获异常 ────────────────────────────────────────
  // 不让 Electron 默认 dialog 接管; 走 disposer chain 把 IM offline / 子进程
  // SIGTERM 都发出去再 exit(1)。日志已经在 console.error 里了。
  process.on('uncaughtException', (err) => {
    if (isBrokenStdioError(err)) {
      disableDevTerminalMirror();
      if (!brokenStdioWarningLogged) {
        brokenStdioWarningLogged = true;
        log.warn('disabled dev terminal log mirror after broken stdio', err);
      }
      return;
    }
    // 瞬时网络错误 (ETIMEDOUT/ECONNRESET/ENOTFOUND 等) 不杀进程 —— 典型场景是
    // VPN 一断, main 进程后台某个漏 catch 的 fetch/TCP 抛错就把整个 App 崩掉,
    // 用户体验极差。降级成 log.error 留全栈, 后续从日志反查到调用点再补 try/catch。
    //
    // 同时广播一条 tip 到 renderer, renderer 自己 toast (带节流) 让用户感知到
    // "刚才网络抖了一下", 否则 App 表面看起来一切正常, 用户会困惑某些功能为啥不工作。
    if (isTransientNetworkError(err)) {
      log.error('ignored transient network error (no shutdown)', err);
      broadcastTransientNetworkErrorTip(err);
      return;
    }
    // arm-first(review P1):只在确定退出的分支布防——上面 broken-stdio /
    // 瞬时网络两个不退出的分支绝不能布防,否则 20s 后 watchdog 会误杀健康进程。
    armShutdownHardKillWatchdog();
    log.error('uncaughtException — shutting down', err);
    if (_isDisposing) return;
    void beginShutdown(timeoutMs, 'uncaughtException').finally(() => app.exit(1));
  });

  // unhandledRejection: 只记日志、不退出。悬空 Promise 不必然致命, 强退反而
  // 把一个能恢复的状态拖死。出问题时通过日志 / Sentry 上抓即可。
  process.on('unhandledRejection', (reason) => {
    log.error('unhandledRejection (continuing)', reason);
  });

  // ── Layer 4: renderer crashed (main alive) ──────────────────────────────
  // Main 还活着, 但 renderer 死了。继续让用户看一个空白窗没意义, 走 disposer
  // chain 把 IM offline / 子进程都收掉再 exit(1)。
  // 例外 1:意识沙箱(cindy-brain/runtime)的渲染进程"允许死"——崩溃隔离正是它的
  // 设计属性(docs/dev-rules/plugin-security-and-authoring.md),由 GhostRuntime 自己收尸/熔断,
  // 绝不能触发整个应用关机(实证:强崩沙箱曾把主界面一起带走)。
  // 例外 2:`<webview>` guest(内置浏览器等)的崩溃/OOM 只影响那一个 tab——
  // renderer 侧 useBrowserWebview 已有 crash banner + reload 恢复链路。此前
  // 这里不区分 guest,网页死递归吃满内存被 OOM kill 时会把整个 App 一起带走
  // (VS Code / Cursor 的边界都是 guest 崩溃不退 Workbench)。
  // 例外 3:RSB popup 虽然是 `window` 类型,但它是局部网页 surface；崩溃时由
  // native popup manager 回收并让对应 tab 展示恢复态,不能拖垮主窗口。
  app.on('render-process-gone', (_event, webContents, details) => {
    if (isGhostSandboxWebContentsId(webContents.id)) {
      log.warn(
        `ghost sandbox render-process-gone (isolated, no shutdown): reason=${details.reason} exitCode=${details.exitCode}`,
      );
      return;
    }
    if (webContents.getType() === 'webview') {
      log.warn(
        `webview guest render-process-gone (isolated, no shutdown): reason=${details.reason} exitCode=${details.exitCode}`,
      );
      return;
    }
    if (isRsbNativePopupWebContentsId(webContents.id)) {
      log.warn(
        `native popup render-process-gone (isolated, no shutdown): reason=${details.reason} exitCode=${details.exitCode}`,
      );
      return;
    }
    // arm-first(review P1):沙箱/webview 两个不退出的分支在上面已 return,
    // 走到这里必然退出。
    armShutdownHardKillWatchdog();
    log.error(`render-process-gone: reason=${details.reason} exitCode=${details.exitCode}`);
    if (_isDisposing) return;
    void beginShutdown(timeoutMs, `render-process-gone:${details.reason}`).finally(() =>
      app.exit(1),
    );
  });

  // ── Layer 5: 其它子进程死亡 (GPU / utility / shared worker …) —— 只记日志 ──
  // GPU 崩溃 Chromium 会自行重启 GPU 进程,utility 崩溃影响面局部,都不值得
  // 整个 app 退出;但此前这些事件完全无日志,「app 卡死/白屏前发生过什么」
  // 无从追溯 (issue #758)。clean-exit / killed 是正常回收,降级 info。
  app.on('child-process-gone', (_event, details) => {
    const desc =
      `child-process-gone: type=${details.type} reason=${details.reason} ` +
      `exitCode=${details.exitCode ?? '?'}` +
      (details.name ? ` name=${details.name}` : '') +
      (details.serviceName ? ` serviceName=${details.serviceName}` : '');
    if (details.reason === 'clean-exit' || details.reason === 'killed') {
      log.info(desc);
    } else {
      log.error(desc);
    }
  });

  // 真硬崩 (segfault / kill -9) JS 层无能为力 —— 子进程靠 stdin EOF 检测父进程
  // 死亡然后自死 (Codex Rust app-server 的 lines.next_line() 收 None 退出循环)。
  // 硬崩的事后追责由 startup-diagnostics 的 run marker 在下次启动时完成。
}
