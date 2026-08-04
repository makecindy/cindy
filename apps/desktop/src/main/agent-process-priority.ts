/**
 * agent-process-priority —— agent 进程优先级降档 watcher(资源占用治理第三层)。
 *
 * 动机: 并发闸门与工具链限核都管不住"任意重命令抢占前台"——优先级是内核层的,
 * 对 agent 进程树里的一切子进程(bash / 测试 / 构建)都生效:降档后 agent 照常
 * 用满空闲核,但用户前台应用永远优先,机器不再卡顿。
 *
 * 实现方式: claude 子进程由 Claude SDK 内部 spawn(host 拿不到 pid),codex 由
 * maker-core spawn —— 统一用周期扫描:找到"当前主进程直接子进程 + 命中本产品
 * agent 二进制路径 marker"的进程,按设置档位调 os.setPriority;后续 spawn 的
 * 子进程(bash / 测试 worker)自动继承。发现窗口 ≤ intervalMs,即会话最初几秒
 * 启动的命令可能仍以原优先级跑完 —— 可接受,重负载通常出现在会话中后期。
 *
 * 档位映射:
 *  - 'low'    → PRIORITY_BELOW_NORMAL(nice 10 / Windows BELOW_NORMAL)
 *  - 'lowest' → PRIORITY_LOW(nice 19 / Windows IDLE);macOS 额外 taskpolicy -b
 *               (Darwin 背景 QoS,压到能效核)
 *  - 'normal' → 只对**曾被本 watcher 降档**的进程尝试恢复;POSIX 非特权进程
 *               无法调回已升高的 nice(EPERM 静默接受,新进程自然是 normal),
 *               macOS 的 taskpolicy -B 钳制清除是例外、可恢复。
 *
 * 安全边界: 只匹配 ppid == 本进程 且命令行带产品二进制 marker 的进程,绝不触碰
 * 外部安装的 claude/codex 或另一个 Cindy 实例的进程(与 claude-orphan-reaper
 * 同一套 marker 策略)。所有失败 best-effort,永不影响 agent 功能。
 */

import { execFile } from 'node:child_process';
import os from 'node:os';
import { promisify } from 'node:util';

import { app } from 'electron';

import { allUserDataDirNames } from '@cindy/maker-shared/brand-identity';

import { CURRENT_CINDY_REGION } from '../shared/brandRegion.js';
import { buildClaudePathMarkers } from './claude-orphan-reaper.js';
import { createLogger } from './logger';
import {
  readAgentResourceSettings,
  type AgentProcessPriority,
} from './maker-host/agent-resource-settings-store.js';

const execFileAsync = promisify(execFile);

const DEFAULT_INTERVAL_MS = 15_000;

export interface AgentProcessRow {
  pid: number;
  kind: 'claude' | 'codex';
}

/**
 * 单进程调档结果:
 *  - 'applied'            : 目标档已生效(或至少 setPriority 成功)
 *  - 'process-gone'       : 进程已退出(ESRCH),从账上移除
 *  - 'nice-raise-refused' : POSIX 拒绝调高优先级(EPERM/EACCES)——nice 停留在
 *                           原档;darwin 的 taskpolicy 钳制部分仍按目标档调整过
 */
export type ApplyPriorityResult = 'applied' | 'process-gone' | 'nice-raise-refused';

interface WatcherLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  debug(message: string, meta?: Record<string, unknown>): void;
}

export interface AgentProcessPriorityWatcherDeps {
  readPriority: () => AgentProcessPriority;
  scanAgentProcesses: () => Promise<AgentProcessRow[]>;
  /** 对单个进程应用档位;结果语义见 ApplyPriorityResult。 */
  applyPriority: (
    pid: number,
    tier: AgentProcessPriority,
    prevTier: AgentProcessPriority | undefined,
  ) => Promise<ApplyPriorityResult>;
  log: WatcherLogger;
  intervalMs?: number;
}

export interface AgentProcessPriorityWatcher {
  start(): void;
  stop(): void;
  /** 单次 tick(测试用;生产由内部 interval 驱动)。 */
  tickOnce(): Promise<void>;
}

/**
 * codex 二进制路径 marker(与 buildClaudePathMarkers 同构):
 * <userData>/codex/<ver>/ 及 dev checkout 的 apps/codex-bin/。
 */
export function buildCodexPathMarkers(dirNames: readonly string[]): string[] {
  return dirNames.flatMap((dirName) => {
    const dir = dirName.toLowerCase();
    return [
      `appdata\\roaming\\${dir}\\codex\\`,
      `appdata/roaming/${dir}/codex/`,
      `/library/application support/${dir}/codex/`,
    ];
  });
}

/**
 * Linux 布局 marker:userData 在 ~/.config/<dir>/ 下。覆盖两种托管形态——
 * legacy `<userData>/<kind>/<version>/` 与 linux-runtime-fallback 的
 * `<userData>/agent-runtime/<kind>/bin/`(见 agent-binaries/linux-runtime-fallback.ts
 * privateBinaryPath;打包 Linux 走这条,不加就整平台失明,bot review P1)。
 * agent-runtime 布局当前仅 Linux 使用,mac/win 无需对应新增。
 */
export function buildLinuxPathMarkers(
  dirNames: readonly string[],
  kind: 'claude-code' | 'codex',
): string[] {
  return dirNames.flatMap((dirName) => {
    const dir = dirName.toLowerCase();
    return [
      `/.config/${dir}/${kind}/`,
      `/.config/${dir}/agent-runtime/${kind}/`,
    ];
  });
}

const CLAUDE_MARKERS = [
  ...buildClaudePathMarkers(allUserDataDirNames(CURRENT_CINDY_REGION)),
  ...buildLinuxPathMarkers(allUserDataDirNames(CURRENT_CINDY_REGION), 'claude-code'),
  'apps\\claude-code-bin\\',
  'apps/claude-code-bin/',
];

const CODEX_MARKERS = [
  ...buildCodexPathMarkers(allUserDataDirNames(CURRENT_CINDY_REGION)),
  ...buildLinuxPathMarkers(allUserDataDirNames(CURRENT_CINDY_REGION), 'codex'),
  'apps\\codex-bin\\',
  'apps/codex-bin/',
];

/**
 * 运行时 userData 派生 marker:Linux 的 userData 可被 XDG_CONFIG_HOME /
 * --user-data-dir 重定向,静态 ~/.config/<brand>/ 形态的 marker 会整体失配,
 * watcher 静默失明(bot review fresh evidence)。以 app.getPath('userData') 的
 * 实际解析值补一组 marker;静态品牌 marker 仍保留(覆盖历史目录名与另一实例
 * 的标准布局)。start 入口注册,重复调用整组替换(幂等)。
 */
const runtimeUserDataMarkers: { claude: string[]; codex: string[] } = { claude: [], codex: [] };

export function registerUserDataMarkers(userDataPath: string): void {
  const markersFor = (kind: 'claude-code' | 'codex'): string[] => {
    const lower = userDataPath.toLowerCase();
    // 命令行里的分隔符形态可能与 app.getPath 返回值不同(Windows 下 / 与 \ 混用),
    // 两种形态都登记;非本平台形态的变体永不命中,无害。
    const variants = new Set([lower.replace(/\\/g, '/'), lower.replace(/\//g, '\\')]);
    const out: string[] = [];
    for (const v of variants) {
      const sep = v.includes('\\') ? '\\' : '/';
      out.push(`${v}${sep}${kind}${sep}`);
      out.push(`${v}${sep}agent-runtime${sep}${kind}${sep}`);
    }
    return out;
  };
  runtimeUserDataMarkers.claude = markersFor('claude-code');
  runtimeUserDataMarkers.codex = markersFor('codex');
}

/** 命令行(已小写)→ agent 种类;不命中任何 marker = 不是我们的 agent 进程。 */
export function classifyAgentCommandLine(cmdLineLower: string): 'claude' | 'codex' | null {
  if (
    CLAUDE_MARKERS.some((m) => cmdLineLower.includes(m)) ||
    runtimeUserDataMarkers.claude.some((m) => cmdLineLower.includes(m))
  ) {
    return 'claude';
  }
  if (
    CODEX_MARKERS.some((m) => cmdLineLower.includes(m)) ||
    runtimeUserDataMarkers.codex.some((m) => cmdLineLower.includes(m))
  ) {
    return 'codex';
  }
  return null;
}

const POSIX_PS_ROW_RE = /^(\d+)\s+(\d+)\s+(.+)$/;

/** POSIX: 一次 ps 全表,过滤"本进程直接子进程 + 命中 marker"。 */
export function parsePosixAgentProcesses(
  psOutput: string,
  selfPid: number,
): AgentProcessRow[] {
  const rows: AgentProcessRow[] = [];
  for (const raw of psOutput.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const match = line.match(POSIX_PS_ROW_RE);
    if (!match) continue;
    const pid = Number.parseInt(match[1], 10);
    const ppid = Number.parseInt(match[2], 10);
    if (!Number.isFinite(pid) || !Number.isFinite(ppid) || ppid !== selfPid) continue;
    const kind = classifyAgentCommandLine(match[3].toLowerCase());
    if (kind) rows.push({ pid, kind });
  }
  return rows;
}

async function scanPosix(): Promise<AgentProcessRow[]> {
  // -ww: macOS ps 默认按显示宽度截断 command 列,长路径(长用户名/重定向
  // userData)会把 /claude-code/ marker 截掉导致扫描静默漏认;重复 -w 取消截断。
  const { stdout } = await execFileAsync('ps', ['-Aww', '-o', 'pid=,ppid=,command='], {
    encoding: 'utf8',
    timeout: 5_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  return parsePosixAgentProcesses(stdout, process.pid);
}

async function scanWindows(): Promise<AgentProcessRow[]> {
  // 与 claude-orphan-reaper 的 Windows 扫描同一套写法(含行尾管道符的坑,见其注释)。
  const script = [
    'Get-CimInstance Win32_Process -Filter "Name=\'claude.exe\' OR Name=\'codex.exe\'" |',
    'ForEach-Object {',
    '  $cmd = ([string]$_.CommandLine) -replace "`r|`n", " "',
    '  Write-Output ("{0}|{1}|{2}" -f $_.ProcessId, $_.ParentProcessId, $cmd)',
    '}',
  ].join('\n');
  const { stdout } = await execFileAsync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    { encoding: 'utf8', timeout: 10_000, windowsHide: true },
  );
  const rows: AgentProcessRow[] = [];
  for (const raw of stdout.split(/\r?\n/)) {
    const parts = raw.trim().split('|');
    if (parts.length < 3) continue;
    const pid = Number.parseInt(parts[0]?.trim() ?? '', 10);
    const ppid = Number.parseInt(parts[1]?.trim() ?? '', 10);
    if (!Number.isFinite(pid) || !Number.isFinite(ppid) || ppid !== process.pid) continue;
    const kind = classifyAgentCommandLine(parts.slice(2).join('|').toLowerCase());
    if (kind) rows.push({ pid, kind });
  }
  return rows;
}

function defaultScanAgentProcesses(): Promise<AgentProcessRow[]> {
  return process.platform === 'win32' ? scanWindows() : scanPosix();
}

function priorityValue(tier: AgentProcessPriority): number {
  switch (tier) {
    case 'low':
      return os.constants.priority.PRIORITY_BELOW_NORMAL;
    case 'lowest':
      return os.constants.priority.PRIORITY_LOW;
    default:
      return os.constants.priority.PRIORITY_NORMAL;
  }
}

/** macOS taskpolicy(背景 QoS 钳制)best-effort;非 darwin no-op。 */
async function taskpolicy(args: string[], log: WatcherLogger): Promise<void> {
  if (process.platform !== 'darwin') return;
  try {
    await execFileAsync('/usr/sbin/taskpolicy', args, { timeout: 5_000 });
  } catch (err) {
    log.debug('taskpolicy failed (best-effort, ignored)', {
      args,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * 提取 os.setPriority 失败的真实 errno。Node 把 libuv 失败包成 SystemError:
 * 顶层 code 是 'ERR_SYSTEM_ERROR',可判定的 errno 在 err.info.code(bot review
 * fresh evidence);plain ErrnoException 形态与 message 内的 uv 错误名做兜底。
 */
export function systemErrnoCode(err: unknown): string | undefined {
  const e = err as NodeJS.ErrnoException & { info?: { code?: string } };
  if (typeof e?.info?.code === 'string') return e.info.code;
  if (typeof e?.code === 'string' && e.code !== 'ERR_SYSTEM_ERROR') return e.code;
  const match = /\b(EACCES|EPERM|ESRCH)\b/.exec(String(e?.message ?? ''));
  return match?.[1];
}

function makeDefaultApplyPriority(log: WatcherLogger) {
  return async (
    pid: number,
    tier: AgentProcessPriority,
    prevTier: AgentProcessPriority | undefined,
  ): Promise<ApplyPriorityResult> => {
    let result: ApplyPriorityResult = 'applied';
    try {
      os.setPriority(pid, priorityValue(tier));
    } catch (err) {
      const code = systemErrnoCode(err);
      if (code === 'ESRCH') return 'process-gone';
      if (code === 'EPERM' || code === 'EACCES') {
        // POSIX 非特权进程不能调高优先级(normal←low←lowest 方向都算 raise):
        // nice 停在原档。如实上报给调用方,不装成功(bot review P1)。
        result = 'nice-raise-refused';
      } else {
        log.debug('setPriority failed', { pid, tier, code, error: String(err) });
      }
    }
    // taskpolicy 钳制与 nice 独立:即使 nice 调不回,darwin 上仍按目标档调整钳制
    // (lowest→low 清掉 -b 后,实际效果介于两档之间,是无特权下能达到的最优近似)。
    if (tier === 'lowest') {
      await taskpolicy(['-b', '-p', String(pid)], log);
    } else if (prevTier === 'lowest') {
      await taskpolicy(['-B', '-p', String(pid)], log);
    }
    return result;
  };
}

export function createAgentProcessPriorityWatcher(
  deps: AgentProcessPriorityWatcherDeps,
): AgentProcessPriorityWatcher {
  const { readPriority, scanAgentProcesses, applyPriority, log } = deps;
  const intervalMs = deps.intervalMs ?? DEFAULT_INTERVAL_MS;
  /**
   * 已被本 watcher 处理过的进程账本。只记非 normal 档;恢复/退出即移除。
   * tier 记的是**目标档**;niceStuck = POSIX 拒绝了本次 raise,nice 实际停在
   * 更低优先级的旧档(darwin 钳制已按目标档调整)。仍按目标档入账是有意的:
   * 无特权下重试永远失败,每 tick 重试只会空转 + 反复 spawn taskpolicy;
   * 账本的职责是"别重复动它",真实状态由日志如实记录。
   */
  const applied = new Map<number, { tier: AgentProcessPriority; niceStuck: boolean }>();
  let timer: ReturnType<typeof setInterval> | null = null;
  let ticking = false;

  async function tickOnce(): Promise<void> {
    if (ticking) return; // 扫描慢于 interval 时跳过本 tick,不排队叠加
    ticking = true;
    try {
      const desired = readPriority();
      // 空闲快路径:设置为 normal 且没有欠恢复的进程 → 完全不扫进程表。
      if (desired === 'normal' && applied.size === 0) return;
      const rows = await scanAgentProcesses();
      const alive = new Set(rows.map((r) => r.pid));
      for (const pid of [...applied.keys()]) {
        if (!alive.has(pid)) applied.delete(pid);
      }
      for (const row of rows) {
        const prev = applied.get(row.pid);
        if (desired === 'normal') {
          if (prev === undefined) continue; // 没动过的进程绝不碰
          const result = await applyPriority(row.pid, 'normal', prev.tier);
          applied.delete(row.pid); // POSIX 恢复注定被拒,重试无意义(见账本注释)
          log.info('agent process priority restore attempted', {
            pid: row.pid,
            kind: row.kind,
            // nice-raise-refused = nice 停在降档值直到进程退出,新进程不受影响
            niceRestored: result === 'applied',
          });
        } else if (prev?.tier !== desired) {
          const result = await applyPriority(row.pid, desired, prev?.tier);
          if (result === 'process-gone') {
            applied.delete(row.pid);
          } else if (result === 'nice-raise-refused') {
            // lowest→low 这类升档:nice 卡在旧档,只有 darwin 钳制按目标档调整了。
            // 入账目标档防空转重试,日志如实说明(不写"lowered")。
            applied.set(row.pid, { tier: desired, niceStuck: true });
            log.warn('agent process priority partially applied: nice stuck at previous tier', {
              pid: row.pid,
              kind: row.kind,
              requestedTier: desired,
              stuckAtTier: prev?.tier ?? 'unknown',
            });
          } else {
            applied.set(row.pid, { tier: desired, niceStuck: false });
            log.info('agent process priority lowered', {
              pid: row.pid,
              kind: row.kind,
              tier: desired,
            });
          }
        }
      }
    } catch (err) {
      log.warn('agent process priority tick failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      ticking = false;
    }
  }

  return {
    start() {
      if (timer) return;
      timer = setInterval(() => {
        void tickOnce();
      }, intervalMs);
      timer.unref?.();
    },
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
    tickOnce,
  };
}

export const __testing = { makeDefaultApplyPriority };

/** 生产入口:默认依赖(设置 store + 平台扫描 + os.setPriority/taskpolicy)组装并启动。 */
export function startAgentProcessPriorityWatcher(): AgentProcessPriorityWatcher {
  const log = createLogger('agent-process-priority');
  try {
    // userData 实际值派生 marker(XDG_CONFIG_HOME / --user-data-dir 重定向场景)。
    registerUserDataMarkers(app.getPath('userData'));
  } catch (err) {
    log.warn('userData marker registration failed; static brand markers only', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  const watcher = createAgentProcessPriorityWatcher({
    readPriority: () => readAgentResourceSettings().processPriority,
    scanAgentProcesses: defaultScanAgentProcesses,
    applyPriority: makeDefaultApplyPriority(log),
    log,
  });
  watcher.start();
  return watcher;
}
