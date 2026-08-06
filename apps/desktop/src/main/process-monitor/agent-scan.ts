/**
 * process-monitor/agent-scan —— 「资源用量」面板的 OS 级进程枚举。
 *
 * 为什么不复用 agent-process-priority 的扫描:那边只要 pid/kind(调优先级),
 * 这边还要 CPU / 内存与全局 PPID→children 图(树聚合 + 杀树校验),且要认 pi
 * (优先级 watcher 有意不管 pi,直接改它的 classify 会顺带改变调档行为)。
 * marker 策略与安全边界与 agent-process-priority / claude-orphan-reaper 完全
 * 一致:只认「ppid == 本进程 且命令行命中本产品二进制路径 marker」的进程。
 *
 * 平台差异:
 *  - POSIX:一次 `ps -Awwo pid,ppid,%cpu,rss,command`。%cpu 是 ps 的近期均值
 *    (macOS 为衰减平均),rss 单位 KB。
 *  - Windows:一次 Win32_Process 全表。WorkingSetSize 单位字节;CPU 没有现成
 *    百分比,取 UserModeTime+KernelModeTime(100ns)累计值,由 sampler 用两次
 *    采样差分算百分比。
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { allUserDataDirNames } from '@cindy/maker-shared/brand-identity';

import { CURRENT_CINDY_REGION } from '../../shared/brandRegion.js';
import { classifyAgentCommandLine } from '../agent-process-priority.js';

const execFileAsync = promisify(execFile);

export type MonitoredAgentKind = 'claude' | 'codex' | 'pi';

export interface OsProcessRow {
  pid: number;
  ppid: number;
  /** 小写命令行(仅 main 内部用于 marker 匹配,绝不出 IPC)。 */
  cmdLineLower: string;
  memoryKb: number;
  /** POSIX:ps 报告的 %cpu;Windows 为 null(用 cpuTimeMs 差分)。 */
  cpuPercent: number | null;
  /** Windows:UserModeTime+KernelModeTime 累计(ms);POSIX 为 null。 */
  cpuTimeMs: number | null;
}

export interface OsProcessSnapshot {
  rows: OsProcessRow[];
  childrenByParent: Map<number, number[]>;
}

/**
 * pi 二进制路径 marker(与 claude/codex 的 marker 同构):生产二进制安装在
 * `<userData>/pi/<version>/`,dev/sandbox 则从仓库 `apps/pi-bin/` 启动。
 */
export function buildPiPathMarkers(dirNames: readonly string[]): string[] {
  return [
    'apps\\pi-bin\\',
    'apps/pi-bin/',
    ...dirNames.flatMap((dirName) => {
    const dir = dirName.toLowerCase();
    return [
      `appdata\\roaming\\${dir}\\pi\\`,
      `appdata/roaming/${dir}/pi/`,
      `/library/application support/${dir}/pi/`,
      `/.config/${dir}/pi/`,
    ];
    }),
  ];
}

const PI_MARKERS = buildPiPathMarkers(allUserDataDirNames(CURRENT_CINDY_REGION));

/**
 * 运行时 userData 派生的 pi marker(XDG_CONFIG_HOME / --user-data-dir 重定向
 * 场景,与 agent-process-priority.registerUserDataMarkers 同理)。claude/codex
 * 的运行时 marker 由那边的注册函数维护,这里只补 pi 自己的。
 */
let runtimePiMarkers: string[] = [];

export function registerPiUserDataMarkers(userDataPath: string): void {
  const lower = userDataPath.toLowerCase();
  const variants = new Set([lower.replace(/\\/g, '/'), lower.replace(/\//g, '\\')]);
  runtimePiMarkers = [...variants].map((v) => {
    const sep = v.includes('\\') ? '\\' : '/';
    return `${v}${sep}pi${sep}`;
  });
}

/** 命令行(已小写)→ 受监视的 agent 种类;不命中 = 不是我们的 agent 进程。 */
export function classifyMonitoredAgentCommandLine(
  cmdLineLower: string,
): MonitoredAgentKind | null {
  const base = classifyAgentCommandLine(cmdLineLower);
  if (base) return base;
  if (
    PI_MARKERS.some((m) => cmdLineLower.includes(m)) ||
    runtimePiMarkers.some((m) => cmdLineLower.includes(m))
  ) {
    return 'pi';
  }
  return null;
}

// ps 行:pid ppid %cpu rss command(command 可含空格,贪婪吃尾)。
const POSIX_PS_ROW_RE = /^(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+(.+)$/;

export function parsePosixProcessTable(psOutput: string): OsProcessRow[] {
  const rows: OsProcessRow[] = [];
  for (const raw of psOutput.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const match = line.match(POSIX_PS_ROW_RE);
    if (!match) continue;
    const pid = Number.parseInt(match[1], 10);
    const ppid = Number.parseInt(match[2], 10);
    const cpuPercent = Number.parseFloat(match[3]);
    const rssKb = Number.parseInt(match[4], 10);
    if (!Number.isFinite(pid) || !Number.isFinite(ppid)) continue;
    rows.push({
      pid,
      ppid,
      cmdLineLower: match[5].toLowerCase(),
      memoryKb: Number.isFinite(rssKb) ? rssKb : 0,
      cpuPercent: Number.isFinite(cpuPercent) ? cpuPercent : 0,
      cpuTimeMs: null,
    });
  }
  return rows;
}

/** Windows 行:pid|ppid|workingSetBytes|cpuTime100ns|cmdline(cmdline 可含 |)。 */
export function parseWindowsProcessTable(stdout: string): OsProcessRow[] {
  const rows: OsProcessRow[] = [];
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const parts = line.split('|');
    if (parts.length < 5) continue;
    const pid = Number.parseInt(parts[0]?.trim() ?? '', 10);
    const ppid = Number.parseInt(parts[1]?.trim() ?? '', 10);
    const workingSetBytes = Number.parseInt(parts[2]?.trim() ?? '', 10);
    const cpuTime100ns = Number.parseInt(parts[3]?.trim() ?? '', 10);
    if (!Number.isFinite(pid) || !Number.isFinite(ppid)) continue;
    rows.push({
      pid,
      ppid,
      cmdLineLower: parts.slice(4).join('|').toLowerCase(),
      memoryKb: Number.isFinite(workingSetBytes) ? Math.round(workingSetBytes / 1024) : 0,
      cpuPercent: null,
      cpuTimeMs: Number.isFinite(cpuTime100ns) ? cpuTime100ns / 10_000 : null,
    });
  }
  return rows;
}

export function buildChildrenByParent(rows: readonly OsProcessRow[]): Map<number, number[]> {
  const childrenByParent = new Map<number, number[]>();
  for (const row of rows) {
    const siblings = childrenByParent.get(row.ppid);
    if (siblings) siblings.push(row.pid);
    else childrenByParent.set(row.ppid, [row.pid]);
  }
  return childrenByParent;
}

/** 从 childrenByParent 展开一棵子树(含根;防环)。 */
export function collectDescendantPids(
  rootPid: number,
  childrenByParent: Map<number, number[]>,
): number[] {
  const out: number[] = [];
  const seen = new Set<number>();
  const stack: number[] = [rootPid];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    if (seen.has(cur)) continue;
    seen.add(cur);
    out.push(cur);
    const kids = childrenByParent.get(cur);
    if (kids) for (const k of kids) stack.push(k);
  }
  return out;
}

async function scanPosix(): Promise<OsProcessSnapshot> {
  // -ww:macOS ps 默认按显示宽度截断 command,截掉 marker 会静默漏认
  // (与 agent-process-priority 同一个坑)。
  const { stdout } = await execFileAsync(
    'ps',
    ['-Aww', '-o', 'pid=,ppid=,%cpu=,rss=,command='],
    { encoding: 'utf8', timeout: 5_000, maxBuffer: 8 * 1024 * 1024 },
  );
  const rows = parsePosixProcessTable(stdout);
  return { rows, childrenByParent: buildChildrenByParent(rows) };
}

async function scanWindows(): Promise<OsProcessSnapshot> {
  // 全表(无 Name filter):agent 树里的 bash/node 子孙也要计入聚合。
  // 行尾管道符不可省 —— 否则两条语句独立执行、parse 恒 0 行
  // (claude-orphan-reaper 2026-07-14 实锤的坑)。
  const script = [
    'Get-CimInstance Win32_Process |',
    'ForEach-Object {',
    '  $cmd = ([string]$_.CommandLine) -replace "`r|`n", " "',
    '  Write-Output ("{0}|{1}|{2}|{3}|{4}" -f $_.ProcessId, $_.ParentProcessId, $_.WorkingSetSize, ($_.UserModeTime + $_.KernelModeTime), $cmd)',
    '}',
  ].join('\n');
  const { stdout } = await execFileAsync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    { encoding: 'utf8', timeout: 10_000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
  );
  const rows = parseWindowsProcessTable(stdout);
  return { rows, childrenByParent: buildChildrenByParent(rows) };
}

/** 生产扫描入口(sampler / terminate 校验共用)。 */
export function scanOsProcesses(): Promise<OsProcessSnapshot> {
  return process.platform === 'win32' ? scanWindows() : scanPosix();
}
