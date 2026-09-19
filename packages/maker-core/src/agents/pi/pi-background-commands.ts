/**
 * pi-background-commands —— PI 会话「后台命令」能力的宿主侧执行器与生命周期。
 *
 * 模型侧入口是 cindy-bridge 覆盖过的 `bash` 工具(`background: true`)。bridge 只做三件事:
 *   1. 用 Pi 自己的 `getShellConfig` 解析 shell(与前台 `bash` 同一条解析链);
 *   2. 把启动请求经 `extension_ui_request`(title = CINDY_PI_BACKGROUND_COMMAND_CONTROL_TITLE)
 *      交给 host,并等 host 回执;
 *   3. 把回执文本交给模型。
 * 真正的进程由本模块在 Cindy main 里 spawn 并**独占拥有**:
 *   - 生命周期与 live 会话绑定:会话 close、账号边界、应用退出清扫时全部杀掉;
 *   - 停止由 host 直接对自己 spawn 的子进程杀树 —— 不依赖 Pi 进程还活着,也不需要
 *     pid 记录文件(进程句柄只在本模块内存里,外部文件无法诱导 host 去杀任意 pid);
 *   - 输出落有界日志(默认 8 MiB,超出后继续消费但不写盘),尾部进终态 update 的 summary;
 *   - 状态经 onUpdate 回调交回 PiAgent,统一走 agent_task_update 事件流进 UI。
 *
 * 为什么不在 Pi 进程里 spawn:bridge 所在进程一旦消失(导航释放 / 空闲回收 / 崩溃),
 * 就没有可靠的杀进程树执行者 —— 由 host 拥有才满足「会话关闭不留孤儿进程」。
 * SSH 远程会话不启用该能力(命令会跑在控制端本机,路径与工作区都不对),bridge 侧 fail closed。
 */

import { createHash, randomUUID } from 'node:crypto';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { PI_BASH_STATIC_SECRET_ENV_NAMES } from './pi-bash-secret-envs.js';

/**
 * host → bridge 的能力开关与 bearer:仅本地普通会话注入,值是 host 每会话签发的
 * 一次随机 token(43 字符 base64url),不是 `1`。
 *
 * 为什么是 token 而不是布尔开关:extension_ui_request 的 title 与 payload 在 Pi 进程内
 * 对所有扩展可见,复制 title 就能伪造控制请求 —— 而这条通道会以**父会话的 env 与 cwd**
 * spawn 进程,还能指定任意 shell 路径。与 Pi 包管理通道同一口径(见 index.ts 的
 * piPackageManagementToken):bridge 读入后仅闭包持有,host 侧逐请求比对。
 * 但与包管理 token 不同:bridge **不**把这个键从 env 里删掉 —— 扩展重载(#3070)会重新
 * 执行 bridge 模块,删了 env 就把能力在重载后静默关掉(2026-09-18 真机实测:模型下一次
 * `background:true` 直接拿到 “unavailable”)。该键已在静态剥名单与 piSecretEnvNames 里,
 * 前台/后台 bash 的 spawn 边界都会剥掉;子代理 runner 也另行剥离 —— 能拿到它的只有 Pi
 * 主进程内的代码,而那本来就等同于直接 spawn 的能力。
 */
export const CINDY_PI_BACKGROUND_COMMANDS_ENV = 'CINDY_PI_BACKGROUND_COMMANDS';
/** bridge → host 的后台命令控制通道 title(经 extension_ui_request 的 input 方法)。 */
export const CINDY_PI_BACKGROUND_COMMAND_CONTROL_TITLE = 'cindy:bash-background';

/**
 * `stop()` 的结果。`'not-running'` 覆盖「未知 id」与「已收口」两种(对调用方语义相同:
 * 这个 id 现在不归本 manager 管);`'unconfirmed'` 表示 SIGKILL 之后仍未确认退出。
 */
export type PiBackgroundCommandStopOutcome = 'stopped' | 'not-running' | 'unconfirmed';
/** 单会话同时运行的后台命令上限:再多的并发进程只会互相拖慢并放大失控面。 */
export const PI_BACKGROUND_COMMAND_MAX_RUNNING = 16;
/** 单条后台命令长度上限(字符);超过即拒绝,避免把巨型脚本文本当进程参数传。 */
export const PI_BACKGROUND_COMMAND_MAX_CHARS = 32_000;
/** 日志落盘上限;超出后仍持续消费 stdout/stderr(防止子进程写满管道被阻塞),只是不再写盘。 */
export const PI_BACKGROUND_COMMAND_LOG_MAX_BYTES = 8 * 1024 * 1024;
/** 终态 update 的 summary 取日志尾部多少字符。 */
export const PI_BACKGROUND_COMMAND_SUMMARY_TAIL_CHARS = 2_000;
/** taskId 只接受稳定、无控制字符的可见字符(缺省由 host 生成)。 */
const TASK_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,200}$/;
/** 直接当 taskId 保留的上限(与旧 pattern 上限一致);超长一律退回生成 id。 */
const PI_BACKGROUND_COMMAND_TASK_ID_MAX = 200;

function containsTaskIdControlChars(value: string): boolean {
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * 日志文件名:taskId 在 pattern 内就直接用(可读);否则用 sha256 前缀。
 *
 * 存在的理由:taskId 必须原样保留(渲染层靠它把 update 配回聊天流),不能被文件名规则
 * 绑死;旧实现在 pattern 不匹配时**换 id**,后果是聊天卡被过滤、只剩面板孤儿行。
 * 派生文件名让「id 任意字符集」与「路径安全」解耦。
 */
export function piBackgroundCommandLogFileName(taskId: string): string {
  if (TASK_ID_PATTERN.test(taskId)) return `${taskId}.log`;
  return `task-${createHash('sha256').update(taskId).digest('hex').slice(0, 32)}.log`;
}
/** 优雅停止等待;超时后升级 SIGKILL / taskkill /F。 */
const STOP_GRACE_MS = 2_000;
/** 升级后确认退出的等待上限。 */
const STOP_CONFIRM_MS = 6_000;
/** 'exit' 之后给 stdio 收尾留的窗口(超过即按已有输出收口,防止被后台孙进程占住管道卡死)。 */
const STREAM_FLUSH_MS = 1_500;

export interface PiBackgroundCommandLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
}

/** bridge 解析好的 shell 规格:shell/args/命令经 argv 还是 stdin 传入。 */
export interface PiBackgroundCommandShellSpec {
  shell: string;
  args: readonly string[];
  commandTransport: 'standard' | 'stdin';
}

/**
 * 解析 bridge 传来的 shell 规格。形状/字符集不合法一律返回 null(调用方拒绝)。
 * 只做形状校验,不做路径白名单 —— shell 由 Pi 自己的 getShellConfig 解析,
 * 与前台 bash 同源。
 */
export function parsePiBackgroundCommandShellSpec(
  value: unknown,
): PiBackgroundCommandShellSpec | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.shell !== 'string' || !raw.shell.trim() || /[\0\r\n]/.test(raw.shell)) return null;
  if (!Array.isArray(raw.args)) return null;
  if (raw.args.some((arg) => typeof arg !== 'string' || arg.includes('\0'))) return null;
  return {
    shell: raw.shell,
    args: raw.args as string[],
    commandTransport: raw.commandTransport === 'stdin' ? 'stdin' : 'standard',
  };
}

export interface PiBackgroundCommandStartRequest {
  /** Pi tool call id;缺失/非法时 host 生成一个。 */
  taskId?: string;
  command: string;
  /** 缺省用 defaultCwd;必须是绝对路径。 */
  cwd?: string;
  shell: PiBackgroundCommandShellSpec;
  title?: string;
}

export interface PiBackgroundCommandSnapshot {
  taskId: string;
  title?: string;
  command: string;
}

/**
 * 一条后台命令的对外状态。字段与 `agent_task_update` 同源:PiAgent 把 running /
 * 终态分别映射成对应事件(status / summary / usage.durationMs)。
 */
export interface PiBackgroundCommandUpdate {
  taskId: string;
  status: 'running' | 'completed' | 'failed' | 'stopped';
  command: string;
  title: string;
  logPath: string;
  startedAt: number;
  endedAt?: number;
  exitCode?: number | null;
  /** 日志尾部(有输出才有);启动失败时为错误原因。 */
  summary?: string;
}

export interface PiBackgroundCommandsOptions {
  /** 已按 bridge 同口径清洗过的 bash 环境(secret 剥离 + PI_CODING_AGENT_DIR=bashPackageHome)。 */
  env: NodeJS.ProcessEnv;
  /** 会话工作目录;请求未带 cwd 时使用。 */
  defaultCwd: string;
  /** 日志目录(每会话一个);本模块负责创建。 */
  logDir: string;
  /** 状态回调;抛出异常不会影响进程管理。 */
  onUpdate: (update: PiBackgroundCommandUpdate) => void;
  logger?: PiBackgroundCommandLogger;
  /** 测试注入;缺省 process.platform。 */
  platform?: NodeJS.Platform;
  /** 测试注入;缺省 PI_BACKGROUND_COMMAND_MAX_RUNNING。 */
  maxRunning?: number;
}

interface RunningCommand {
  taskId: string;
  command: string;
  title: string;
  cwd: string;
  logPath: string;
  startedAt: number;
  child: ChildProcess | null;
  stdout: NodeJS.ReadableStream | null;
  stderr: NodeJS.ReadableStream | null;
  streamsOpen: number;
  logStream: fs.WriteStream | null;
  logBytes: number;
  tail: Buffer[];
  tailBytes: number;
  stopRequested: boolean;
  finalized: boolean;
  /** spawn 事件已到达;在此之前 'error'/'exit' 都属于启动失败,不得发终态 update。 */
  spawned: boolean;
  exit: { code: number | null; signal: NodeJS.Signals | null } | null;
  flushTimer: NodeJS.Timeout | null;
  /** **操作系统报告进程结束**才 resolve(stop/stopAll 的确认口径)。 */
  nativeExited: Promise<void>;
  resolveNativeExited: () => void;
}

/** 会话退出清扫用的活动实例表(一个 PiAgent 会话一个)。 */
const liveManagers = new Set<PiBackgroundCommands>();

/**
 * 构造后台命令子进程 env:与 bridge 的 `isolatedBashEnvironment` 同口径 ——
 * 动态秘密名单 + 静态名单全剪掉,删 `PI_PACKAGE_DIR`，并把 `PI_CODING_AGENT_DIR`
 * 指向隔离的 bash package home。两处结果不一致会让后台命令比前台 bash 多拿到
 * 凭证 / 控制面变量,因此名单与步骤都共用单一来源。
 */
export function buildPiBackgroundCommandEnv(input: {
  spawnEnv: NodeJS.ProcessEnv;
  dynamicSecretEnvNames: readonly string[];
  bashPackageHome: string;
}): NodeJS.ProcessEnv {
  // 与 bridge 的 isolatedBashEnvironment 同口径 fail-closed:隔离 home 不合法时
  // 前台 bash 直接抛错,后台命令也必须拒绝 —— 静默把一个坏值写进
  // PI_CODING_AGENT_DIR 会让子进程在错误的隔离目录/未隔离目录下跑。
  if (!input.bashPackageHome || !path.isAbsolute(input.bashPackageHome)) {
    throw new Error('Cindy isolated Pi package home is unavailable');
  }
  const clean: NodeJS.ProcessEnv = { ...input.spawnEnv };
  for (const name of input.dynamicSecretEnvNames) delete clean[name];
  for (const name of PI_BASH_STATIC_SECRET_ENV_NAMES) delete clean[name];
  delete clean.PI_PACKAGE_DIR;
  clean.PI_CODING_AGENT_DIR = input.bashPackageHome;
  return clean;
}

/**
 * 日志目录的归属标记:每实例一个文件 `owner-<pid>.json`,内容 `{"pid": <进程号>, "at": <时间戳>}`。
 *
 * 为什么不是单个 `owner.json`:受支持的拓扑里多个 Cindy 实例能打开**同一个 sessionId**
 * (dev + 打包双开、`--passive` 多开),它们共享同一个日志目录 —— 单文件会被后来者覆盖,
 * 于是「标记指向自己」的那次删除会把另一个实例**仍在写**的日志连同目录一起删掉。
 * 每实例一个文件后,所有声明过归属的实例都留下可读判据,删除侧只要看到**任何一个**
 * 活着的异实例就保留目录(pid 复用最坏也只是多留一个目录,不会误删)。
 *
 * pid 从**文件名**读取(内容残缺不影响判据):归属判据必须能容忍写了一半的文件,
 * 否则一个被截断的 JSON 就能让目录被当成"没人用"而删掉。
 */
export const PI_BACKGROUND_COMMAND_OWNER_FILE_PREFIX = 'owner-';

function piBackgroundCommandOwnerFileName(pid: number): string {
  return `${PI_BACKGROUND_COMMAND_OWNER_FILE_PREFIX}${pid}.json`;
}

/** best-effort 写自己的归属标记:写不进去(只读盘 / 权限)不影响命令本身。 */
async function writePiBackgroundCommandOwner(logDir: string): Promise<void> {
  try {
    await fsp.writeFile(
      path.join(logDir, piBackgroundCommandOwnerFileName(process.pid)),
      JSON.stringify({ pid: process.pid, at: Date.now() }),
      { encoding: 'utf8', mode: 0o600 },
    );
  } catch {
    // 忽略:标记只影响删除侧是否保守,不影响命令执行。
  }
}

/**
 * 后台命令日志根目录:`<agentHome>/runtime/pi-bash-tasks/<sessionId>`。
 * 与 pi-subagent-runs 同级,理由相同:属于运行时产物,会话删除时一并回收。
 */
export function piBackgroundCommandRoot(agentHome: string, sessionId: string): string {
  const id = sessionId.trim();
  if (!id || id === '.' || id === '..' || /[\\/\0]/.test(id)) {
    throw new Error('unsafe PI background command session id');
  }
  return path.join(agentHome, 'runtime', 'pi-bash-tasks', id);
}

/**
 * 启动期回收「无会话」日志目录:`<agentHome>/runtime/pi-bash-tasks/anon-<pid>-<ts>`。
 *
 * 为什么需要:`anon-*` 只在 Pi 会话拿不到 sessionId 时出现(启动早期 / bot 注入路径),
 * 它没有任何后续代码路径会回收 —— 会话删除的回收需要 sessionId,退出清扫只杀进程不删目录。
 * 于是这些目录会永久留在 userData 里(每次最多若干 8MiB 日志)。
 *
 * 判据是**目录名里的 owner pid** 与目录内的归属标记:前者是 spawn 命令、写日志的那个
 * Cindy 主进程(它已经不在,这些日志就没有读者了 —— 命令进程本身是 detached,可能还在跑,
 * 但它的 manager 已随主进程消失,没人能再消费这些文件;Windows 上文件被占用时删除会失败,
 * 同样无害);后者兜住「另一个实例正在同一目录里写」。名字里的 pid 还活着的目录一律保留:
 * `pi-agent-home` 与并发实例(dev --passive / 打包版双开)共享。
 *
 * 名称里的死 pid 是**正面证据**,所以这里可以关掉「无归属就保留」的保守默认值
 * (`keepWhenUnowned: false`):否则崩溃残留的 `anon-*` 目录永远收不掉。
 *
 * 返回尝试删除的目录数(删除本身是 best-effort,失败只记 debug)。
 */
export async function sweepStalePiBackgroundCommandAnonRoots(
  agentHome: string,
  opts?: { isProcessAlive?: (pid: number) => boolean },
): Promise<number> {
  const root = path.join(agentHome, 'runtime', 'pi-bash-tasks');
  let entries: string[];
  try {
    entries = await fsp.readdir(root);
  } catch {
    return 0;
  }
  const alive = opts?.isProcessAlive ?? defaultIsProcessAlive;
  const stale = entries.filter((entry) => {
    const pid = parseAnonOwnerPid(entry);
    if (pid === null || pid === process.pid) return false;
    return !alive(pid);
  });
  const results = await Promise.all(
    stale.map((entry) => removePiBackgroundCommandRoot(path.join(root, entry), {
      isProcessAlive: alive,
      keepWhenUnowned: false,
    })),
  );
  // owner 标记指向活进程的目录会被保留(理论上只可能是 pid 复用或竞态;不计入回收数)。
  return results.filter((result) => result === 'removed').length;
}

/** `anon-<pid>-<ts>` → pid;名字不符 / pid 非法返回 null。 */
function parseAnonOwnerPid(entry: string): number | null {
  const match = /^anon-(\d+)-\d+$/.exec(entry);
  if (!match) return null;
  const pid = Number(match[1]);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function defaultIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // 只有 ESRCH(查无此进程)才算死。EPERM 是**进程存在但本进程无权发信号**
    // (另一个用户 / 提权实例),判死会删掉那个实例正在写的日志目录 —— 宁可漏收
    // (残留一个目录)也不能误删。口径与 index.ts 的 isLocalProcessAlive 一致。
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/**
 * 会话删除时回收日志目录(不存在视为成功)。
 *
 * 三种结果:
 * - `'removed'`:确实回收了(没有任何标记说明还有人用)。
 * - `'kept-foreign-owner'`:目录里有**另一个仍然存活**实例的归属标记 —— 跨实例边界下我们
 *   停不掉那边的进程,删日志只会让它连输出与线索一起消失(调用方应记 warn)。
 * - `'kept-unowned'`:目录里**一个归属标记都没有**(写入失败 / 标记被清掉 / 目录来自更早的
 *   构建)。判据缺失时**默认保守保留**(`keepWhenUnowned` 默认 true):我们无法证明没有人
 *   在用,而删错的代价是另一个实例的进程还在跑、日志却没了。有正面证据的调用方(例如启动期
 *   sweep 手里有目录名里的死 pid)可以显式关掉这一保守行为。
 */
export async function removePiBackgroundCommandRoot(
  root: string,
  opts?: { isProcessAlive?: (pid: number) => boolean; keepWhenUnowned?: boolean },
): Promise<'removed' | 'kept-foreign-owner' | 'kept-unowned'> {
  const owners = await readPiBackgroundCommandOwnerPids(root);
  const alive = opts?.isProcessAlive ?? defaultIsProcessAlive;
  if (owners.some((pid) => pid !== process.pid && alive(pid))) return 'kept-foreign-owner';
  if (owners.length === 0 && (opts?.keepWhenUnowned ?? true)) return 'kept-unowned';
  // Windows:刚死的进程还占着 cwd / 打开的 .log,第一次 rmdir 会 EBUSY/EPERM —— 与
  // subagent 那边的 stopAndRemovePiSubagentRuns 同一补救(Node 自带重试)。
  await fsp
    .rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    .catch(() => undefined);
  return 'removed';
}

/** 读目录里所有归属标记的 pid(来自**文件名**);目录不存在 / 名字不成形一律忽略。 */
async function readPiBackgroundCommandOwnerPids(root: string): Promise<number[]> {
  let entries: string[];
  try {
    entries = await fsp.readdir(root);
  } catch {
    return [];
  }
  const pids: number[] = [];
  for (const entry of entries) {
    if (!entry.startsWith(PI_BACKGROUND_COMMAND_OWNER_FILE_PREFIX) || !entry.endsWith('.json')) continue;
    const raw = entry.slice(PI_BACKGROUND_COMMAND_OWNER_FILE_PREFIX.length, -'.json'.length);
    const pid = Number(raw);
    if (Number.isInteger(pid) && pid > 0) pids.push(pid);
  }
  return pids;
}

/**
 * 应用退出 / 主进程收尾时的全量清扫。
 *
 * 与 pi-subagent 的 sweep 分开:`pi-agent-home` 可能被并发实例共享,但后台命令是
 * **本进程** spawn 的子进程 —— 只有本进程的 manager 知道自己持有谁,按实例表清扫
 * 不会误伤另一个实例的任务。
 */
export async function stopAllPiBackgroundCommandsForExit(timeoutMs = STOP_CONFIRM_MS): Promise<number> {
  const managers = [...liveManagers];
  const results = await Promise.allSettled(managers.map((manager) => manager.stopAll({ timeoutMs })));
  // 调用方(更新重启)按「未确认条数 > 0」决定取消重启;正常退出忽略返回值。
  return results.reduce((sum, r) => sum + (r.status === 'fulfilled' ? r.value : 0), 0);
}

/**
 * **同步**退出清扫(forceQuit 专用,不 await)。
 *
 * `forceQuit()` 绕过 lifecycle 的 before-quit 链,且不能 await(await 会卡住 updater 的
 * pid 轮询、拖延重启),所以只能同步发信号;语义与 subagent 的
 * `requestStopAllPiSubagentRunsSync` 对齐。要覆的残留窗口是「更新重启的 reclaim 扫过之后、
 * `process.exit(0)` 之前」:那几秒里父 Pi 会话仍然活着,模型/重入请求可以再 `start` ——
 * 而这些是 detached 进程组,父进程退出不会带走它们。
 *
 * 直接 SIGKILL(main 侧 `killTree` 在 Windows 上是 taskkill /T /F):退出路径不留给
 * 长跑脚本优雅退出的时间,而它们本来就是可丢弃的工作进程。
 */
export function stopAllPiBackgroundCommandsForExitSync(): number {
  let killed = 0;
  for (const manager of [...liveManagers]) killed += manager.killAllSync();
  return killed;
}

export class PiBackgroundCommands {
  private readonly running = new Map<string, RunningCommand>();
  /**
   * dispose 已按 stopped 收口、但 **尚未确认退出** 的进程。
   *
   * 它们已不在 `running` 里(UI 不该再看到 running),但进程可能还在跑;退出清扫只遍历
   * `liveManagers`,所以本实例必须**继续留在登记表**直到这些进程全部确认退出 ——
   * dispose 里的 unref 定时器在应用退出时不会触发,只靠它会留下孤儿进程组。
   */
  private readonly pendingKills = new Set<RunningCommand>();
  private readonly options: PiBackgroundCommandsOptions;
  private readonly platform: NodeJS.Platform;
  private readonly maxRunning: number;
  private disposed = false;

  constructor(options: PiBackgroundCommandsOptions) {
    this.options = options;
    this.platform = options.platform ?? process.platform;
    this.maxRunning = options.maxRunning ?? PI_BACKGROUND_COMMAND_MAX_RUNNING;
    liveManagers.add(this);
  }

  /**
   * dispose 后仍未确认退出的进程数(退出清扫的输入)。
   *
   * 仅用于测试与诊断:那个集合必须保持**可观察**,因为「dispose 收口后是否还能被退出
   * 清扫回收」正是它存在的理由(见 dispose 注释)。
   */
  get pendingKillCount(): number {
    return this.pendingKills.size;
  }

  /** 当前仍在运行的后台命令快照(listBackgroundTasks 的输入)。 */
  list(): PiBackgroundCommandSnapshot[] {
    if (this.disposed) return [];
    return [...this.running.values()]
      .filter((record) => !record.finalized)
      .map((record) => {
        const snapshot: PiBackgroundCommandSnapshot = {
          taskId: record.taskId,
          command: record.command,
        };
        if (record.title) snapshot.title = record.title;
        return snapshot;
      });
  }

  /**
   * 启动一条后台命令。返回回执信息(taskId + 日志路径);spawn 失败直接抛错,
   * 让 bridge 把可读原因交还给模型。
   */
  async start(request: PiBackgroundCommandStartRequest): Promise<{ taskId: string; logPath: string }> {
    if (this.disposed) throw new Error('Background commands are unavailable for this task.');
    const command = typeof request.command === 'string' ? request.command : '';
    if (!command.trim()) throw new Error('A background command requires a non-empty command.');
    if (command.length > PI_BACKGROUND_COMMAND_MAX_CHARS) {
      throw new Error(
        `Background command is too long (limit ${PI_BACKGROUND_COMMAND_MAX_CHARS} characters).`,
      );
    }
    const shellSpec = request.shell;
    if (
      !shellSpec
      || typeof shellSpec.shell !== 'string'
      || !shellSpec.shell.trim()
      || /[\0\r\n]/.test(shellSpec.shell)
      || !Array.isArray(shellSpec.args)
      || shellSpec.args.some((arg) => typeof arg !== 'string' || /[\0]/.test(arg))
    ) {
      throw new Error('Cindy could not resolve a shell for the background command.');
    }
    const cwd = typeof request.cwd === 'string' && request.cwd.trim() ? request.cwd : this.options.defaultCwd;
    if (!path.isAbsolute(cwd)) {
      throw new Error('Background command working directory is invalid.');
    }
    const requestedTaskId = typeof request.taskId === 'string' ? request.taskId.trim() : '';
    // taskId 就是 Pi 的 toolCallId,必须**原样保留**:渲染层用它把 update 配回聊天流里的
    // tool_use(parentToolUseId === toolUseId)。这里只挡空值 / 超长 / 控制字符这类根本不能
    // 当 key 的输入,绝不因为“pattern 不匹配”换 id —— 换了 id 的后果是聊天卡被过滤掉、
    // 只剩面板孤儿行(历史 review 结论)。文件名另行派生,不受 id 字符集影响。
    const taskId = requestedTaskId
      && requestedTaskId.length <= PI_BACKGROUND_COMMAND_TASK_ID_MAX
      && !containsTaskIdControlChars(requestedTaskId)
      ? requestedTaskId
      : `bash-${randomUUID()}`;
    if (this.running.has(taskId)) {
      throw new Error('A background command with this task id is already running.');
    }
    if (this.running.size >= this.maxRunning) {
      throw new Error(
        `Too many background commands are already running (limit ${this.maxRunning}). Stop one first.`,
      );
    }

    // 日志文件名由 taskId 派生:能被当文件名直接用就用原值(可读),否则用 sha256 前缀。
    // 路径安全由此保证 —— taskId 本身可能是任意 toolCallId 字符集。
    const logPath = path.join(this.options.logDir, piBackgroundCommandLogFileName(taskId));
    let resolveNativeExited: () => void = () => {};
    const nativeExited = new Promise<void>((resolve) => {
      resolveNativeExited = resolve;
    });
    const record: RunningCommand = {
      taskId,
      command,
      title: compactCommandTitle(command),
      cwd,
      logPath,
      startedAt: Date.now(),
      child: null,
      stdout: null,
      stderr: null,
      streamsOpen: 0,
      logStream: null,
      logBytes: 0,
      tail: [],
      tailBytes: 0,
      stopRequested: false,
      finalized: false,
      spawned: false,
      exit: null,
      flushTimer: null,
      nativeExited,
      resolveNativeExited,
    };
    // 同步占位**必须先于下面两个 await**:重复 taskId 的并发 start(模型重试 / 双发)若都
    // 通过了上面的 has() 检查,后一路会覆盖前一路的纪录、把前一个 detached 进程变成谁都够不到
    // 的泄漏。占位之后后续所有失败路径都会把它删掉(见下方 catch)。
    this.running.set(taskId, record);
    try {
      await fsp.mkdir(this.options.logDir, { recursive: true, mode: 0o700 });
      // 归属标记:删除侧靠它区分「这个目录可能是另一个活着的实例在用」。
      await writePiBackgroundCommandOwner(this.options.logDir);
      const logStream = fs.createWriteStream(logPath, { flags: 'w', mode: 0o600 });
      record.logStream = logStream;
      // 打开失败必须在这里暴露(例如盘满 / 权限),不能等到写输出时静默丢日志。
      await new Promise<void>((resolve, reject) => {
        logStream.once('open', () => resolve());
        logStream.once('error', (error) => reject(error));
      });
    } catch (error) {
      this.running.delete(taskId);
      record.resolveNativeExited();
      try { record.logStream?.destroy(); } catch { /* 打不开的流无需处理 */ }
      throw toStartError(error);
    }
    const title = typeof request.title === 'string' && request.title.trim()
      ? request.title.trim().slice(0, 96)
      : compactCommandTitle(command);
    const stdin = shellSpec.commandTransport === 'stdin';
    let child: ChildProcess;
    try {
      const args = stdin ? [...shellSpec.args] : [...shellSpec.args, command];
      child = spawn(shellSpec.shell, args, {
        cwd,
        env: this.options.env,
        windowsHide: true,
        stdio: [stdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
        // POSIX 新建进程组,便于一次杀掉整棵命令树;Windows 用 taskkill /T。
        detached: this.platform !== 'win32',
      });
    } catch (error) {
      this.running.delete(taskId);
      record.resolveNativeExited();
      try { record.logStream?.destroy(); } catch { /* 未打开的流无需处理 */ }
      throw toStartError(error);
    }
    record.child = child;
    record.stdout = child.stdout;
    record.stderr = child.stderr;
    record.streamsOpen = (child.stdout ? 1 : 0) + (child.stderr ? 1 : 0);
    // 运行期写日志失败(盘满等)不能升级成 uncaughtEventEmitter error:停写即可,
    // 进程本身与 UI 状态不受影响。
    const activeLogStream = record.logStream;
    record.logStream?.on('error', (error) => {
      if (record.logStream === activeLogStream) record.logStream = null;
      this.options.logger?.warn('pi background command log write failed', {
        taskId,
        message: error instanceof Error ? error.message : String(error),
      });
    });
    const onStreamEnd = (): void => {
      record.streamsOpen = Math.max(0, record.streamsOpen - 1);
      if (record.streamsOpen === 0) this.finalizeFromExit(record);
    };
    child.stdout?.on('end', onStreamEnd);
    child.stderr?.on('end', onStreamEnd);
    child.stdout?.on('data', (chunk: Buffer) => this.consumeOutput(record, chunk));
    child.stderr?.on('data', (chunk: Buffer) => this.consumeOutput(record, chunk));
    child.on('error', (error) => {
      // spawn 已成功后的 error 很少见(例如 kill 竞态);没有 spawn 成功过才算启动失败,
      // 那条路径由 start() 的等待分支抛出,不应额外发一个模型没拿到回执的终态 update。
      if (record.finalized || !record.spawned) return;
      this.options.logger?.warn('pi background command process error', {
        taskId,
        message: error instanceof Error ? error.message : String(error),
      });
      // 收口之后记录会离开 running,而这条 error 不保证进程已死(例如 kill 竞态)。
      // 不登记进 pendingKills 的话,退出清扫与 stopAll 都遍历不到它 —— 这个进程
      // 就成了本实例永远够不着的残留(与 dispose 同一套销账逻辑:真退出时 'exit'
      // 会把它从这里删掉)。
      if (!record.exit) this.pendingKills.add(record);
      this.finalize(record, 'failed', null, error instanceof Error ? error.message : String(error));
    });
    child.on('exit', (code, signal) => {
      record.exit = { code, signal };
      // 真实退出已确认:stop/stopAll 以它为口径,dispose 留下的残留进程也随之销账。
      record.resolveNativeExited();
      if (this.pendingKills.size > 0) {
        this.pendingKills.delete(record);
        // 全部残留进程都已确认退出 → 本实例不再需要留在退出清扫登记表里。
        if (this.disposed && this.pendingKills.size === 0) liveManagers.delete(this);
      }
      // 'exit' 只说明进程结束;stdio 里可能还有在途数据。正常情况两个流随后
      // 立刻 'end'(由 onStreamEnd 收口);这里再留一个兜底窗口 —— 后台孙进程
      // 占住管道时不能让任务永远停在 running。
      if (record.streamsOpen === 0) {
        this.finalizeFromExit(record);
        return;
      }
      record.flushTimer = setTimeout(() => this.finalizeFromExit(record), STREAM_FLUSH_MS);
      record.flushTimer.unref?.();
    });

    // spawn 失败(ENOENT 等)会在 'error' 上异步到达;把它作为启动失败抛出。
    try {
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        child.once('spawn', () => {
          if (settled) return;
          settled = true;
          resolve();
        });
        child.once('error', (error) => {
          if (settled) return;
          settled = true;
          reject(error);
        });
      });
    } catch (error) {
      this.running.delete(taskId);
      if (record.flushTimer) clearTimeout(record.flushTimer);
      try { record.logStream?.destroy(); } catch { /* 未打开的流无需处理 */ }
      // 启动失败也算「进程不会再跑」:否则 dispose 会把它挂进 pendingKills,本实例从此
      // 留在退出清扫表里出不来。
      record.resolveNativeExited();
      throw toStartError(error);
    }
    // 等 'spawn' 期间可能有三种外部决定落在同一条记录上:
    // ① dispose(会话关闭 / 账号边界 / 退出)——记录已被按 stopped 收口,终态不会再发第二个;
    // ② stopAll(「全部停止」/ 退出清扫)已经置位 stopRequested —— 用户/会话已经要求停,
    //    而那时子进程还不存在,killTree 是空打,请求本身只能返回「未确认」;
    // ③ 记录被同 id 的新启动顶掉。
    // 任一命中都不能再发 running(否则面板与状态栏停在僵尸 running,而 bridge 已经把
    // 「已启动」的回执交回模型),也不能让刚产生的进程活下去 —— 用户已经明确不要它了。
    // 直接 SIGKILL,不走 SIGTERM→2s→SIGKILL:此时无人在等优雅退出,且这条路径可能落在
    // forceQuit 时序里(unref 升级定时器在主进程 exit 后永不执行)。
    const stoppedBeforeSpawn = record.stopRequested;
    if (
      this.disposed
      || stoppedBeforeSpawn
      || record.finalized
      || this.running.get(taskId) !== record
    ) {
      record.stopRequested = true;
      this.killTree(record, 'SIGKILL');
      // 撤下这条从未公告过的记录并把它交给退出清扫兜底(与 dispose 同一套销账逻辑)。
      this.discardUnannounced(record);
      // 报错文案要能区分两种原因:被要求停止(用户的意图已经达成)vs 能力不可用。
      throw new Error(
        stoppedBeforeSpawn
          ? 'The background command was stopped before it finished starting.'
          : 'Cindy background commands are unavailable in this session.',
      );
    }
    if (stdin && child.stdin) {
      child.stdin.on('error', () => undefined);
      child.stdin.end(command);
    }
    record.spawned = true;
    this.emit({
      taskId,
      status: 'running',
      command,
      title,
      logPath,
      startedAt: record.startedAt,
    });
    this.options.logger?.info('pi background command started', {
      taskId,
      cwd,
      // 命令正文一律不进日志:首行恰恰是凭证最常出现的地方(`export TOKEN=…`,
      // `curl -H 'Authorization: …'`,`git clone https://user:pass@…`),而
      // 「只记首行摘要」的建议在这里不成立 —— 摘要是可分享的本地日志的一部分。
      // 定位用 taskId + 日志文件的完整输出足够,不做任何正文截断。
      commandLength: command.length,
    });
    return { taskId, logPath };
  }

  /**
   * 同步杀全部(**forceQuit 专用**):只发信号、不等待确认(调用方马上就要退出了;终态 update
   * 是否来得及送出取决于退出时序,不做保证)。
   * 覆盖运行中的记录与 dispose 遗留的未确认进程。返回实际发过信号的条数。
   *
   * 诚实说明:Windows 分支是 `spawnSync('taskkill')`,进程数上限 16 —— taskkill 正常毫秒级
   * 返回,但极端情况下(每个都挂)最多阻塞到各自的 5s 超时。这里不引入 detached 杀手进程去
   * 换那点阻塞:forceQuit 里阻塞的是「正在关窗口、updater 已落盘」的收尾段,而漏杀的代价
   * 是整个进程树跨版本存活。
   */
  killAllSync(): number {
    // 关门:在飞的 `start()` 会在 post-spawn 复查处被拒并杀树,新来的 start 直接抛错 ——
    // 这是「同步信号发出之后、process.exit 之前又冒出一条命令」的唯一防线(签名锁挡不住)。
    this.disposed = true;
    let killed = 0;
    for (const record of [...this.running.values(), ...this.pendingKills]) {
      // 只看 `exit`(操作系统确认退出),**不看 `finalized`**:dispose 会先把记录
      // finalized(UI 收口)而进程可能还活着 —— 而 pendingKills 里的记录全部是 finalized
      // 的,拿它当跳过条件等于把这段同步清扫要覆的对象全跳过(第 2 轮评审 P0)。
      if (record.exit || record.child?.pid === undefined) continue;
      record.stopRequested = true;
      this.killTree(record, 'SIGKILL');
      killed += 1;
    }
    return killed;
  }

  /**
   * 停止单条命令。返回值是**三态**而不是 boolean:调用方(IPC 停止入口 / bridge 控制通道)
   * 必须能区分「已确认停掉」「本来就不在」「SIGKILL 打下去仍未确认退出」。
   *
   * 第三种必须显式暴露,不能回 true:进程还活着而调用方以为停掉了,用户点一次停止就再也
   * 得不到任何反馈(UI 没有终态事件可以翻状态,只能一直显示运行中)。真正杀不掉的只有
   * 三类(不可中断的系统调用 / 自己脱树的进程 / 权限或内核卡死),日常不会遇到;遇到时
   * 唯一的补救就是让它可见、可重试。
   */
  async stop(taskId: string): Promise<PiBackgroundCommandStopOutcome> {
    const record = this.running.get(taskId);
    if (!record) return 'not-running';
    if (record.finalized) return 'stopped';
    record.stopRequested = true;
    this.killTree(record, 'SIGTERM');
    if (await this.waitForExit(record, STOP_GRACE_MS)) return 'stopped';
    this.killTree(record, 'SIGKILL');
    if (await this.waitForExit(record, STOP_CONFIRM_MS)) return 'stopped';
    this.options.logger?.warn('pi background command stop unconfirmed', { taskId });
    return 'unconfirmed';
  }

  /**
   * 会话关闭 / 退出清扫:停掉全部运行中的命令。
   *
   * 违拗于名字的一点:它也负责 dispose 遗留的 pendingKills —— 那些记录已经对外收口,
   * 但进程可能还活着,而**退出清扫是本进程唯一能对它们做 SIGTERM→SIGKILL 的机会**。
   */
  async stopAll(opts?: { timeoutMs?: number }): Promise<number> {
    const targets = [...this.running.values()].filter((record) => !record.finalized);
    const orphaned = [...this.pendingKills].filter((record) => !record.exit);
    const all = [...targets, ...orphaned];
    if (all.length === 0) return 0;
    const timeoutMs = opts?.timeoutMs ?? STOP_CONFIRM_MS;
    const results = await Promise.allSettled(
      all.map(async (record) => {
        record.stopRequested = true;
        this.killTree(record, 'SIGTERM');
        if (await this.waitForExit(record, STOP_GRACE_MS)) return true;
        this.killTree(record, 'SIGKILL');
        if (await this.waitForExit(record, timeoutMs)) return true;
        this.options.logger?.warn('pi background command exit sweep unconfirmed', {
          taskId: record.taskId,
          pid: record.child?.pid,
        });
        return false;
      }),
    );
    // 返回**未确认退出**的条数:更新重启用它决定要不要放行(与 subagent 的
    // hasActivePiSubagentRunsSync 复检同口径 —— 确认不了的进程不该带着旧 env 跨版本活)。
    return results.filter((r) => r.status !== 'fulfilled' || r.value === false).length;
  }

  /** 释放:停全部命令并退出清扫登记。幂等。 */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const targets = [...this.running.values()].filter((record) => !record.finalized);
    for (const record of targets) {
      record.stopRequested = true;
      this.killTree(record, 'SIGTERM');
      // SIGTERM 没杀掉(或还没被观察到退出)的进程先记账:下面 finalize 会把记录从
      // running 里删掉,那就只能靠 pendingKills + 退出清扫兜底了。
      if (!record.exit) this.pendingKills.add(record);
    }
    // 会话已结束,先按 stopped 对 UI 收口:Pi 进程随 close 退出后事件队列会 `end()`,
    // 真实退出事件可能到不了 renderer(面板会停在 stale running)。老板条已经
    // killTree,这里只是不再等确认。
    for (const record of targets) {
      this.finalize(record, 'stopped', null, undefined);
    }
    // 顽固进程升级强杀;record.exit 已置位说明进程已退出,不得再对可能被复用的
    // pid 发信号。定时器 unref:进程退出时它不会触发 —— 那种情况下由
    // stopAllPiBackgroundCommandsForExit 的 stopAll 完成同一件事,所以本实例必须
    // 留在 liveManagers 里直到全部销账。
    for (const record of targets) {
      const escalation = setTimeout(() => {
        if (!record.exit) this.killTree(record, 'SIGKILL');
      }, STOP_GRACE_MS);
      escalation.unref?.();
    }
    if (this.pendingKills.size === 0) liveManagers.delete(this);
  }

  // ── 内部实现 ────────────────────────────────────────────────────────────

  private consumeOutput(record: RunningCommand, chunk: Buffer): void {
    if (record.finalized) return;
    if (record.logStream && record.logBytes < PI_BACKGROUND_COMMAND_LOG_MAX_BYTES) {
      const remaining = PI_BACKGROUND_COMMAND_LOG_MAX_BYTES - record.logBytes;
      const slice = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
      record.logBytes += slice.length;
      record.logStream.write(slice);
    }
    // tail 只保留最近 N 字节;进程写爆日志时内存占用仍是有界的。
    //
    // 两道裁剪缺一不可:① 队首整块可丢就丢;② 只剩单块但单块本身超预算时**裁剪这一块**
    // —— stream 的 `data` 块可以有多大?实测(2026-09-18)一次 `write(9MB)` 在 Node 管道下
    // 是 144 块 × 最大 65536B,所以只靠 ① 会让单块(≤64KB,而预算只有 2000 字符)整块常驻到终态
    // (第 2 轮评审;它说的 MB 级不成立,但「单元素不受预算约束」是对的)。
    record.tail.push(chunk);
    record.tailBytes += chunk.length;
    while (record.tail.length > 0) {
      const head = record.tail[0]!;
      if (record.tailBytes - head.length >= PI_BACKGROUND_COMMAND_SUMMARY_TAIL_CHARS) {
        record.tail.shift();
        record.tailBytes -= head.length;
        continue;
      }
      if (record.tail.length === 1 && record.tailBytes > PI_BACKGROUND_COMMAND_SUMMARY_TAIL_CHARS) {
        const keep = head.subarray(head.length - PI_BACKGROUND_COMMAND_SUMMARY_TAIL_CHARS);
        record.tail[0] = keep;
        record.tailBytes = keep.length;
      }
      break;
    }
  }

  /**
   * 撤下一条**从未对外公告过**的记录(等 'spawn' 期间就被要求停止 / 被顶掉的那条)。
   *
   * 与 `finalize` 的唯一区别:不发终态 update —— 它的 running 帧从未发出去,补一个
   * stopped 帧只会在 UI 里凭空造出一行。但其余记账必须与 finalize 完全一致(离开运行表、
   * 清定时器、放掉日志与管道句柄),否则记录会永远卡在 running 里:占住这个 taskId 让
   * 同名启动全部被拒,还会污染 list() 快照。
   *
   * 注意 `finalizeFromExit` 对 `!spawned` 恒早退(dispose 已发过终态那条路径依赖它),
   * 所以这里必须自己销账,不能指望随后的 'exit' 帮忙。
   */
  private discardUnannounced(record: RunningCommand): void {
    if (record.finalized) return;
    record.finalized = true;
    if (record.flushTimer) {
      clearTimeout(record.flushTimer);
      record.flushTimer = null;
    }
    try { record.logStream?.destroy(); } catch { /* 未打开的流无需处理 */ }
    record.logStream = null;
    record.stdout?.removeAllListeners();
    record.stderr?.removeAllListeners();
    try {
      record.child?.stdout?.destroy();
      record.child?.stderr?.destroy();
    } catch {
      // 流销毁失败不影响记账。
    }
    this.running.delete(record.taskId);
    if (!record.exit) this.pendingKills.add(record);
  }

  private finalizeFromExit(record: RunningCommand): void {
    if (record.finalized || !record.spawned) return;
    if (!record.exit) return;
    const { code } = record.exit;
    const status: PiBackgroundCommandUpdate['status'] = record.stopRequested
      ? 'stopped'
      : code === 0
        ? 'completed'
        : 'failed';
    this.finalize(record, status, code, undefined);
  }

  private finalize(
    record: RunningCommand,
    status: PiBackgroundCommandUpdate['status'],
    exitCode: number | null,
    errorMessage: string | undefined,
  ): void {
    if (record.finalized) return;
    record.finalized = true;
    if (record.flushTimer) {
      clearTimeout(record.flushTimer);
      record.flushTimer = null;
    }
    record.logStream?.end();
    record.logStream = null;
    // 子进程已结束,管道不再需要:释放句柄,并让 stop() 等到的等待者收口。
    record.stdout?.removeAllListeners();
    record.stderr?.removeAllListeners();
    try {
      record.child?.stdout?.destroy();
      record.child?.stderr?.destroy();
    } catch {
      // 流销毁失败不影响终态记账。
    }
    this.running.delete(record.taskId);
    const summary = errorMessage ?? this.readTail(record);
    const update: PiBackgroundCommandUpdate = {
      taskId: record.taskId,
      status,
      command: record.command,
      title: record.title,
      logPath: record.logPath,
      startedAt: record.startedAt,
      endedAt: Date.now(),
      exitCode,
      ...(summary ? { summary } : {}),
    };
    this.emit(update);
  }

  private readTail(record: RunningCommand): string | undefined {
    if (record.tail.length === 0) return undefined;
    const merged = Buffer.concat(record.tail);
    const text = merged.toString('utf8').trim();
    if (!text) return undefined;
    return text.length > PI_BACKGROUND_COMMAND_SUMMARY_TAIL_CHARS
      ? text.slice(text.length - PI_BACKGROUND_COMMAND_SUMMARY_TAIL_CHARS)
      : text;
  }

  private async waitForExit(record: RunningCommand, timeoutMs: number): Promise<boolean> {
    // 口径是**操作系统报告进程结束**,不是 UI 收口(finalize 可能由 dispose 提前触发)。
    if (record.exit) return true;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
      timer.unref?.();
    });
    const result = await Promise.race([record.nativeExited.then(() => true), timeout]);
    if (timer) clearTimeout(timer);
    return result;
  }

  private killTree(record: RunningCommand, signal: 'SIGTERM' | 'SIGKILL'): void {
    const child = record.child;
    const pid = child?.pid;
    if (!child || pid === undefined) return;
    // 已经观察到退出的进程绝不再发信号:Windows 上 pid 会被回收,而退出事件到 UI 收口
    // 之间还有一个流冲刷窗口(STREAM_FLUSH_MS),期间 record 仍在运行表里 ——
    // taskkill /T /F 这时杀的是操作系统刚分配给别人的进程树。
    if (record.exit || child.exitCode !== null || child.signalCode !== null) return;
    if (this.platform === 'win32') {
      // Windows 没有可用的 POSIX 信号:taskkill 不带 /F 对控制台子进程基本等于
      // 发 WM_CLOSE,dev server / 构建进程不会理 —— 用户点「停止」不该等 2 秒兜底。
      // 后台命令本来就是可丢弃的工作进程,直接用 /T /F 杀整棵树。
      const result = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
        timeout: 5_000,
      });
      if (!result.error && result.status === 0) return;
      if (signal === 'SIGKILL') {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // 进程可能已自行退出。
        }
      }
      return;
    }
    // detached spawn 建了独立进程组:负 pid 一次覆盖整棵命令树。
    try {
      process.kill(-pid, signal);
      return;
    } catch {
      // 进程组不存在(子进程从没真正建组)时退回单进程信号。
    }
    try {
      process.kill(pid, signal);
    } catch {
      // 已退出。
    }
  }

  private emit(update: PiBackgroundCommandUpdate): void {
    try {
      this.options.onUpdate(update);
    } catch (error) {
      this.options.logger?.warn('pi background command update listener threw', {
        taskId: update.taskId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

/** 单行化 + 截断的命令标题(与状态栏/卡片标题口径一致)。 */
export function compactCommandTitle(command: string, max = 96): string {
  const oneLine = command.replace(/\s+/g, ' ').trim();
  if (oneLine.length <= max) return oneLine;
  return `${oneLine.slice(0, max - 1)}…`;
}

function toStartError(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  return new Error(`Cindy could not start the background command: ${message}`);
}
