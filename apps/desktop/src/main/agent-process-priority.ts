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

interface WatcherLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  debug(message: string, meta?: Record<string, unknown>): void;
}

export interface AgentProcessPriorityWatcherDeps {
  readPriority: () => AgentProcessPriority;
  scanAgentProcesses: () => Promise<AgentProcessRow[]>;
  /**
   * 对单个进程应用档位。返回 false = 进程已不存在(从账上移除)。
   * 其余失败(如 POSIX 无法调回)由实现内部消化,返回 true。
   */
  applyPriority: (
    pid: number,
    tier: AgentProcessPriority,
    prevTier: AgentProcessPriority | undefined,
  ) => Promise<boolean>;
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

const CLAUDE_MARKERS = [
  ...buildClaudePathMarkers(allUserDataDirNames(CURRENT_CINDY_REGION)),
  'apps\\claude-code-bin\\',
  'apps/claude-code-bin/',
];

const CODEX_MARKERS = [
  ...buildCodexPathMarkers(allUserDataDirNames(CURRENT_CINDY_REGION)),
  'apps\\codex-bin\\',
  'apps/codex-bin/',
];

/** 命令行(已小写)→ agent 种类;不命中任何 marker = 不是我们的 agent 进程。 */
export function classifyAgentCommandLine(cmdLineLower: string): 'claude' | 'codex' | null {
  if (CLAUDE_MARKERS.some((m) => cmdLineLower.includes(m))) return 'claude';
  if (CODEX_MARKERS.some((m) => cmdLineLower.includes(m))) return 'codex';
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
  const { stdout } = await execFileAsync('ps', ['-A', '-o', 'pid=,ppid=,command='], {
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

function makeDefaultApplyPriority(log: WatcherLogger) {
  return async (
    pid: number,
    tier: AgentProcessPriority,
    prevTier: AgentProcessPriority | undefined,
  ): Promise<boolean> => {
    try {
      os.setPriority(pid, priorityValue(tier));
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ESRCH') return false; // 进程已退出
      // EPERM/EACCES: POSIX 非特权进程不能调回已升高的 nice —— 预期内,只记 debug。
      log.debug('setPriority failed', { pid, tier, code, error: String(err) });
    }
    if (tier === 'lowest') {
      await taskpolicy(['-b', '-p', String(pid)], log);
    } else if (prevTier === 'lowest') {
      await taskpolicy(['-B', '-p', String(pid)], log);
    }
    return true;
  };
}

export function createAgentProcessPriorityWatcher(
  deps: AgentProcessPriorityWatcherDeps,
): AgentProcessPriorityWatcher {
  const { readPriority, scanAgentProcesses, applyPriority, log } = deps;
  const intervalMs = deps.intervalMs ?? DEFAULT_INTERVAL_MS;
  /** 已被本 watcher 降档的进程 → 当前档位。只记非 normal 档;恢复/退出即移除。 */
  const applied = new Map<number, AgentProcessPriority>();
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
          await applyPriority(row.pid, 'normal', prev);
          applied.delete(row.pid); // POSIX 恢复可能无效,但重试无意义(见模块头注释)
          log.info('agent process priority restore attempted', { pid: row.pid, kind: row.kind });
        } else if (prev !== desired) {
          const ok = await applyPriority(row.pid, desired, prev);
          if (ok) {
            applied.set(row.pid, desired);
            log.info('agent process priority lowered', {
              pid: row.pid,
              kind: row.kind,
              tier: desired,
            });
          } else {
            applied.delete(row.pid);
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

/** 生产入口:默认依赖(设置 store + 平台扫描 + os.setPriority/taskpolicy)组装并启动。 */
export function startAgentProcessPriorityWatcher(): AgentProcessPriorityWatcher {
  const log = createLogger('agent-process-priority');
  const watcher = createAgentProcessPriorityWatcher({
    readPriority: () => readAgentResourceSettings().processPriority,
    scanAgentProcesses: defaultScanAgentProcesses,
    applyPriority: makeDefaultApplyPriority(log),
    log,
  });
  watcher.start();
  return watcher;
}
