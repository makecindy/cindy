import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readlinkSync, rmSync, statSync } from 'node:fs';
import type { Stream } from 'node:stream';
import { app } from 'electron';
import { BRAND_NAME } from '@cindy/maker-shared/branding';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type {
  ComputerMcpCallContext,
  ComputerDriverPermissionGrant,
  ComputerDriverPermissionPlatform,
  ComputerDriverPermissionState,
  ComputerDriverStatus,
  ComputerMcpDeps,
  ComputerMcpToolName,
} from '@cindy/mcps';
import { createLogger } from '../logger.js';
import { outboundFetch } from '../maker-host/outbound-fetch.js';

const logger = createLogger('mcp/cindy_computer');
const DRIVER_COMMAND = 'cua-driver';
const STATUS_TIMEOUT_MS = 3_000;
const DOCTOR_TIMEOUT_MS = 10_000;
const CALL_TIMEOUT_MS = 45_000;
const LIGHTWEIGHT_CALL_TIMEOUT_MS = 10_000;
const CLI_FALLBACK_TIMEOUT_MS = 8_000;
const WINDOWS_WIN32_FALLBACK_TIMEOUT_MS = 4_000;
// 安装/更新超时按「活动」而非总时长计:上游安装脚本要从 GitHub Releases
// 下载数十 MB 二进制,慢网下总时长不可预算(2026-07-02 实测固定 180s 超时
// 误杀安装、还把内层脚本的安装锁留成死锁)。活动信号 = stdout/stderr 输出
// 或安装进程树快照(pid 集合 + 累计 CPU time)变化——下载中的 curl 会持续
// 消耗 CPU,挂死的连接则完全冻结。连续 3 分钟无任何活动才判失败;另设
// 30 分钟硬上限兜底防真僵死。该操作由用户显式发起且 UI 有 pending 态。
const INSTALL_IDLE_TIMEOUT_MS = 180_000;
const INSTALL_HARD_TIMEOUT_MS = 1_800_000;
const INSTALL_ACTIVITY_POLL_MS = 15_000;
const PERMISSIONS_GRANT_TIMEOUT_MS = 210_000;
const PERMISSIONS_GRANT_SETTLE_WAIT_MS = 750;
// grant 流程的在途复用只在这个窗口内有效:上游 `permissions grant` 会一直等到
// 用户完成授权(上限 210s),用户中途走开再回来点「去授权」时,复用一个已经
// 等了很久的旧流程看起来就是「按钮点了没反应」——超过该窗口就杀旧起新。
const PERMISSIONS_GRANT_REUSE_MAX_AGE_MS = 15_000;
const MAX_STDOUT_BYTES = 5 * 1024 * 1024;
const MAX_STDERR_BYTES = 512 * 1024;
const DOCS_URL = 'https://cua.ai/docs/cua-driver';
const UNIX_INSTALL_COMMAND =
  '/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/trycua/cua/main/libs/cua-driver/scripts/install.sh)"';
const WINDOWS_INSTALL_COMMAND =
  'irm https://raw.githubusercontent.com/trycua/cua/main/libs/cua-driver/scripts/install.ps1 | iex';
const UNIX_INSTALL_URL = 'https://raw.githubusercontent.com/trycua/cua/main/libs/cua-driver/scripts/install.sh';
const WINDOWS_INSTALL_URL = 'https://raw.githubusercontent.com/trycua/cua/main/libs/cua-driver/scripts/install.ps1';
// 上游 trycua/cua 是 monorepo,cua-driver 的 release tag 前缀固定为 cua-driver-rs-v。
// 版本发现走「按前缀过滤 tag」的 matching-refs API,而不是翻 /releases 列表:
// 上游 monorepo 的 releases 混着多个组件家族,任何基于 /releases 的分页策略
// 都在「翻不够会漏检(backport 乱序 / driver tag 被挤出)」与「翻到底会耗尽
// 未鉴权 60/h 限额、403 后静默降级成无更新」之间两头堵(review 拉锯实锤)。
// matching-refs 一次请求返回全量 cua-driver-rs-v* tag(当前约 50 个,单页),
// 零遗漏、请求量恒定;随后按版本倒序精确核对 release + 当前平台 asset,
// 防止上游先推 tag、后发布安装包的窗口把不可安装版本暴露给用户。
const CUA_DRIVER_TAG_REFS_URL =
  'https://api.github.com/repos/trycua/cua/git/matching-refs/tags/cua-driver-rs-v';
const CUA_DRIVER_RELEASE_BY_TAG_URL =
  'https://api.github.com/repos/trycua/cua/releases/tags';
const CUA_DRIVER_REFS_PAGE_SIZE = 100;
const CUA_DRIVER_REFS_MAX_PAGES = 10;
// SWR 后台刷新节流:打开面板即触发刷新,频繁开合面板会放大未鉴权请求量。
const UPDATE_CHECK_REFRESH_MIN_INTERVAL_MS = 10 * 60_000;
const CUA_DRIVER_RELEASE_TAG_PREFIX = 'cua-driver-rs-v';
const UPDATE_CHECK_TIMEOUT_MS = 10_000;
const LOG_OUTPUT_PREVIEW_CHARS = 2_000;
const TYPE_TEXT_CHUNK_CHARS = 400;
const CUA_DRIVER_SESSION_PROCESS_NONCE = randomUUID().replace(/-/g, '').slice(0, 12);
// 0.12.2 changed `permissions status` into a strictly read-only daemon query.
// Older builds may touch ScreenCaptureKit while checking capturability.
const PASSIVE_PERMISSION_STATUS_MIN_VERSION = '0.12.2';
const SCREENSHOT_OUTPUT_TOOL_NAMES = new Set<ComputerMcpToolName>(['get_window_state']);
const DRIVER_SESSION_ARG_TOOL_NAMES = new Set<ComputerMcpToolName>([
  'list_windows',
  'get_window_state',
  'click',
  'double_click',
  'right_click',
  'drag',
  'type_text',
  'set_value',
  'press_key',
  'hotkey',
  'scroll',
  'move_cursor',
  'get_agent_cursor_state',
  'start_recording',
]);
const CURSOR_STYLED_TOOL_NAMES = new Set<ComputerMcpToolName>([
  'get_window_state',
  'click',
  'double_click',
  'right_click',
  'drag',
  'type_text',
  'set_value',
  'press_key',
  'hotkey',
  'scroll',
  'move_cursor',
  'start_recording',
]);
const LIGHTWEIGHT_TIMEOUT_RETRY_TOOL_NAMES = new Set<ComputerMcpToolName>([
  'get_screen_size',
  'get_cursor_position',
  'get_agent_cursor_state',
  'move_cursor',
]);
const CLI_FALLBACK_TOOL_NAMES = new Set<ComputerMcpToolName>([
  'get_screen_size',
  'get_cursor_position',
]);
const TAPTAP_CURSOR_STYLE = {
  gradient_colors: ['#00D9C5', '#000050'],
  bloom_color: '#00D9C5',
} as const;
const TAPTAP_CURSOR_MOTION = {
  cursor_icon: 'arrow',
  cursor_color: '#00D9C5',
  cursor_label: BRAND_NAME,
  cursor_size: 30,
  cursor_opacity: 0.96,
} as const;
const MCP_STARTUP_TIMEOUT_MS = 10_000;
const MCP_END_SESSION_TIMEOUT_MS = 5_000;
const POSIX_PROCESS_SNAPSHOT_TIMEOUT_MS = 1_500;
const WINDOWS_PROCESS_SNAPSHOT_TIMEOUT_MS = 4_000;
const PROCESS_SNAPSHOT_CACHE_MS = 2_000;
const LIST_WINDOWS_LOCAL_ARG_NAMES = new Set(['query', 'workspace_root', 'process_name']);
const WIN32_FALLBACK_SOURCE = 'xdmaker_win32_fallback';
const WINDOWS_WIN32_FALLBACK_TOOL_NAMES = new Set<ComputerMcpToolName>(['list_windows', 'list_apps']);
// Phase one uses the upstream CuaDriver app as the real runtime and TCC
// identity.
const CUA_DRIVER_APP_BUNDLE_PATH = '/Applications/CuaDriver.app';

let computerDriverPermissionProbePaused = false;

/**
 * macOS permission panes accept application bundles as native file drags.
 * Keep the technical bundle path in main; renderer only sees "Computer Use".
 */
export function getComputerDriverAppBundlePath(): string | null {
  if (process.platform !== 'darwin') return null;
  if (!existsSync(CUA_DRIVER_APP_BUNDLE_PATH)) return null;
  return CUA_DRIVER_APP_BUNDLE_PATH;
}

const WINDOWS_WIN32_WINDOW_SNAPSHOT_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;

public static class XdtWin32WindowSnapshot {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

  [DllImport("user32.dll")]
  public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

  [DllImport("user32.dll")]
  public static extern bool IsWindowVisible(IntPtr hWnd);

  [DllImport("user32.dll")]
  public static extern bool IsIconic(IntPtr hWnd);

  [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern int GetWindowTextW(IntPtr hWnd, StringBuilder lpString, int nMaxCount);

  [DllImport("user32.dll")]
  public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

  [DllImport("user32.dll")]
  public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);

  [StructLayout(LayoutKind.Sequential)]
  public struct RECT {
    public int Left;
    public int Top;
    public int Right;
    public int Bottom;
  }
}
'@

$windows = [System.Collections.Generic.List[object]]::new()
$callback = [XdtWin32WindowSnapshot+EnumWindowsProc]{
  param([IntPtr]$hwnd, [IntPtr]$lparam)
  try {
    $procId = [uint32]0
    [void][XdtWin32WindowSnapshot]::GetWindowThreadProcessId($hwnd, [ref]$procId)
    $rect = New-Object XdtWin32WindowSnapshot+RECT
    [void][XdtWin32WindowSnapshot]::GetWindowRect($hwnd, [ref]$rect)
    $titleBuilder = New-Object System.Text.StringBuilder 1024
    [void][XdtWin32WindowSnapshot]::GetWindowTextW($hwnd, $titleBuilder, $titleBuilder.Capacity)
    $width = [Math]::Max(0, $rect.Right - $rect.Left)
    $height = [Math]::Max(0, $rect.Bottom - $rect.Top)
    $visible = [XdtWin32WindowSnapshot]::IsWindowVisible($hwnd)
    $iconic = [XdtWin32WindowSnapshot]::IsIconic($hwnd)
    $windowId = $hwnd.ToInt64()
    if ($windowId -ge 0 -and $procId -gt 0 -and $visible -and $width -gt 0 -and $height -gt 0) {
      $windows.Add([pscustomobject]@{
        WindowId = $windowId
        ProcessId = [int]$procId
        Title = $titleBuilder.ToString()
        Left = [int]$rect.Left
        Top = [int]$rect.Top
        Width = [int]$width
        Height = [int]$height
        IsVisible = [bool]$visible
        IsIconic = [bool]$iconic
        IsOnScreen = [bool]($visible -and -not $iconic -and $width -gt 0 -and $height -gt 0)
      })
    }
  } catch {
  }
  return $true
}

[void][XdtWin32WindowSnapshot]::EnumWindows($callback, [IntPtr]::Zero)
$processes = [System.Collections.Generic.List[object]]::new()
$processIds = @($windows | ForEach-Object { $_.ProcessId } | Sort-Object -Unique)
foreach ($procId in $processIds) {
  try {
    $proc = Get-Process -Id $procId -ErrorAction Stop
    $exePath = $null
    try {
      $exePath = $proc.MainModule.FileName
    } catch {
    }
    $processes.Add([pscustomobject]@{
      ProcessId = [int]$procId
      Name = $proc.ProcessName
      ExecutablePath = $exePath
    })
  } catch {
  }
}

[pscustomobject]@{
  Windows = $windows
  Processes = $processes
} | ConvertTo-Json -Compress -Depth 6
`;

interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
}

interface RunDriverOptions {
  stdin?: string;
  /** spawn 后回调子进程句柄(grant 流程需要持有以便 stale 时收割)。 */
  onChild?: (child: ChildProcess) => void;
}

interface DaemonStatus {
  running: boolean;
  message: string;
  /** daemon 进程 pid(从 `cua-driver status` 输出解析);解析不出为 null。 */
  pid: number | null;
}

interface CuaMcpSessionEntry {
  client: Client;
  transport: StdioClientTransport;
  ready: Promise<void>;
  driverSessionId: string;
  styled: boolean;
}

interface ProcessSnapshotEntry {
  pid: number;
  parent_pid?: number;
  name?: string;
  command?: string;
  executable?: string;
  cwd?: string;
}

interface WindowIdentity {
  kind: 'electron-dev' | 'node-dev' | 'browser' | 'terminal' | 'unknown';
  workspace_root?: string;
  confidence: number;
  labels: string[];
}

interface ProcessSnapshotResult {
  processes: Map<number, ProcessSnapshotEntry>;
  available: boolean;
}

interface WindowsWin32FallbackSnapshot {
  windows: Record<string, unknown>[];
  processSnapshot: ProcessSnapshotResult;
}

let cachedProcessSnapshot: {
  expiresAt: number;
  result: ProcessSnapshotResult;
} | null = null;

function clearProcessSnapshotCache(): void {
  cachedProcessSnapshot = null;
}

export interface ComputerDriverInstallResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  status: ComputerDriverStatus;
}

/**
 * cua-driver 更新检查结果。查询型数据:任何一步失败(本地未装 / 网络不通 /
 * API 限流 / tag 解析不出)都静默落到 updateAvailable=false,renderer 直接
 * 不渲染更新入口,绝不打扰用户。
 * updating 表示 main 侧此刻有一个更新安装在跑(设置面板关闭不影响它),
 * renderer 重新打开面板时据此恢复「更新中」态并 join 完成时刻。
 */
export interface ComputerDriverUpdateCheck {
  currentVersion: string | null;
  latestVersion: string | null;
  updateAvailable: boolean;
  updating: boolean;
}

export interface ComputerDriverPermissionGrantResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  status: ComputerDriverStatus;
}

export interface ComputerMcpDepsOptions {
  isComputerUseEnabled?: (context?: ComputerMcpCallContext) => boolean;
  /** Optional provider gate before the first status/tool request. */
  prepareRuntimeBeforeUse?: () => Promise<void>;
}

interface ComputerDriverStatusOptions {
  includeDoctor?: boolean;
  forcePermissionProbe?: boolean;
  /** Passive surfaces must not trigger ScreenCaptureKit authorization prompts. */
  skipPermissionProbe?: boolean;
  /**
   * 显式用户动作(重新检查 / 开启开关)专用:先重启 daemon 再实测。
   * 背景:辅助功能(AX)被用户在系统设置里撤销后,**正在运行的 daemon 感知不到**
   * (AXIsProcessTrusted 对撤销不生效,授予方向才是实时的;而屏幕录制的任何改动
   * macOS 都会直接杀掉 daemon),不重启就永远报 stale 的 granted。
   * 护栏(见 getComputerDriverStatus 实现):有 cua MCP 会话在跑、或已知屏幕录制
   * 处于「探测会弹窗」的坏状态时,跳过重启走普通探测。
   */
  freshPermissionProbe?: boolean;
  /**
   * 跳过「坏状态探测结果」的 pid 门控缓存,强制现场重新探测(不重启 daemon)。
   * 使用方:grant 流程刷新状态(main 内部),以及 renderer 授权引导轮询——引导
   * 期间权限逐项变化(授予方向 daemon 实时可见),复用缓存会把进度冻住,导致
   * 「授完第一个权限后第二个设置页永远不弹」(2026-07-03 实踩);此时系统本就在
   * 弹授权对话框,实测可能再触发的弹窗与引导语义一致。
   */
  bypassPermissionProbeCache?: boolean;
  /** Never fall back to a status implementation that may open a macOS TCC prompt. */
  passivePermissionProbeOnly?: boolean;
}

class ComputerDriverError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ComputerDriverError';
  }
}

class ComputerDriverTypeTextRetryError extends ComputerDriverError {
  constructor(
    message: string,
    readonly remainingText: string,
    readonly completedChars: number,
    readonly completedChunks: number,
  ) {
    super(message);
    this.name = 'ComputerDriverTypeTextRetryError';
  }
}

let permissionGrantInFlight: Promise<ExecResult> | null = null;
let permissionGrantStartedAt = 0;
let permissionGrantChild: ChildProcess | null = null;
let lastPermissionGrantResult: ExecResult | null = null;
let lastPermissionGrantError: string | null = null;
/**
 * macOS 权限探测结果缓存(按 daemon pid 门控)。daemon 端回答 `permissions status`
 * 时总会跑一次 ScreenCaptureKit 实测(screen_recording_capturable),该查询在授权
 * 缺失 / 失效状态下每次都会让 macOS 弹「CuaDriver 想要录制屏幕」系统框(status 并非
 * 真正只读,2026-07-03 经 TCC 日志实锤)。缓存 + pid 门控把 status 引发的系统弹窗
 * 压到每个 daemon 生命周期至多一次,详见 getComputerDriverStatus 内的复用条件注释。
 */
let cachedPermissionProbe: {
  daemonPid: number | null;
  raw: unknown;
  state: ComputerDriverPermissionState;
} | null = null;

/** 测试隔离用:清空权限探测缓存与 daemon 自愈启动节流。 */
export function resetComputerDriverPermissionProbeCacheForTests(): void {
  cachedPermissionProbe = null;
  lastDaemonAutostartAt = 0;
  daemonAutostartInFlight = null;
  computerDriverPermissionProbePaused = false;
}

// ── macOS daemon 自愈启动 ────────────────────────────────────────────────
// macOS 修改屏幕录制授权会直接杀掉 CuaDriver daemon,而 macOS 侧上游没有
// autostart(仅 Windows 有)。daemon 掉线时 `permissions status` 只能如实报
// unknown,设置面板会一直停在「未知」。因此设置面板的权限探测(带
// forcePermissionProbe 的 status 调用)在 daemon 掉线时先按上游文档的方式把
// 它拉起来(LaunchServices 启动,TCC 归因才是 com.trycua.driver),再做探测。
// --no-permissions-gate 必带:serve 的首启 gate 缺权限时会主动弹授权框、打开
// 系统设置并阻塞启动 —— 「打开设置面板」绝不能触发那一套。
const DAEMON_AUTOSTART_MIN_INTERVAL_MS = 30_000;
const DAEMON_AUTOSTART_OPEN_TIMEOUT_MS = 5_000;
const DAEMON_AUTOSTART_WAIT_MS = 3_000;
const DAEMON_AUTOSTART_POLL_MS = 300;
let lastDaemonAutostartAt = 0;
let daemonAutostartInFlight: Promise<DaemonStatus | null> | null = null;

async function tryAutostartCuaDaemonOnce(): Promise<DaemonStatus | null> {
  const res = await runProcess(
    'open',
    ['-n', '-g', '-a', 'CuaDriver', '--args', 'serve', '--no-permissions-gate'],
    DAEMON_AUTOSTART_OPEN_TIMEOUT_MS,
  );
  // app bundle 不存在(仅 CLI 安装)等情况 open 非零退出:放弃,维持 unknown 现状。
  if (res.exitCode !== 0) return null;
  const deadline = Date.now() + DAEMON_AUTOSTART_WAIT_MS;
  while (Date.now() < deadline) {
    await sleep(DAEMON_AUTOSTART_POLL_MS);
    const status = await readDaemonStatus().catch(() => null);
    if (status?.running) {
      logger.info('cua-driver daemon autostarted for permission probe', { pid: status.pid });
      return status;
    }
  }
  logger.warn('cua-driver daemon autostart launched but daemon did not come up in time');
  return null;
}

/**
 * 节流 + 并发去重的 daemon 自愈启动;失败静默返回 null(状态维持 unknown)。
 * ignoreThrottle:fresh 探测(用户显式点重新检查/开关)刚主动停掉 daemon,
 * 必须立刻拉起,不能被 30s 节流挡住。
 */
function tryAutostartCuaDaemon(options: { ignoreThrottle?: boolean } = {}): Promise<DaemonStatus | null> {
  if (daemonAutostartInFlight) return daemonAutostartInFlight;
  if (
    !options.ignoreThrottle &&
    Date.now() - lastDaemonAutostartAt < DAEMON_AUTOSTART_MIN_INTERVAL_MS
  ) {
    return Promise.resolve(null);
  }
  lastDaemonAutostartAt = Date.now();
  const run = tryAutostartCuaDaemonOnce()
    .then((status) => {
      // 节流只针对「起不来」的失败重试(防 spawn 风暴);成功启动后清零冷却——
      // daemon 之后再被 macOS 杀掉(如授权引导中用户授了屏幕录制)时必须能立刻
      // 再拉起,否则引导流程要干等 30s 才能确认「已全部授权」。
      if (status?.running) lastDaemonAutostartAt = 0;
      return status;
    })
    .catch(() => null)
    .finally(() => {
      if (daemonAutostartInFlight === run) daemonAutostartInFlight = null;
    });
  daemonAutostartInFlight = run;
  return run;
}

/**
 * 进行中的权限探测 —— 并发调用(设置面板初载 + 开关切换等同时触发)复用同一次
 * 在途探测,避免坏状态下短时间连出两个系统授权弹窗。结果不做时间缓存,缓存语义
 * 由上面的 pid 门控承担。
 * forceNew:fresh / bypass 这类「必须第一手结论」的调用不许 join 在途探测——
 * 在途的那次可能是对重启前旧 daemon 发起的,会把 stale granted 交给刚做完
 * daemon 重启的 fresh 检查(review P2);新探测会顶替为最新在途,后续被动调用
 * join 到最新的这次。
 */
let permissionProbeInFlight: Promise<unknown> | null = null;

function probeDriverPermissionsOnce(options: { forceNew?: boolean } = {}): Promise<unknown> {
  if (!options.forceNew && permissionProbeInFlight) return permissionProbeInFlight;
  const run = readDriverJsonCommand(['permissions', 'status', '--json'], DOCTOR_TIMEOUT_MS)
    .catch((err) => ({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    }))
    .finally(() => {
      if (permissionProbeInFlight === run) permissionProbeInFlight = null;
    });
  permissionProbeInFlight = run;
  return run;
}
const cuaMcpSessions = new Map<string, CuaMcpSessionEntry>();
const cuaMcpSessionCleanups = new Map<string, Promise<void>>();
const cuaDriverSessionGenerations = new Map<string, number>();
const cuaMcpSessionCloseVersions = new Map<string, number>();

function getInstallCommand(): string {
  return process.platform === 'win32' ? WINDOWS_INSTALL_COMMAND : UNIX_INSTALL_COMMAND;
}

function getPermissionPlatform(): ComputerDriverPermissionPlatform {
  if (process.platform === 'darwin') return 'macos';
  if (process.platform === 'win32') return 'windows';
  if (process.platform === 'linux') return 'linux';
  return 'unsupported';
}

function getDriverCandidates(): string[] {
  const envPath = process.env.XDT_CUA_DRIVER_PATH?.trim();
  const candidates = envPath ? [envPath] : [];
  const home = app.getPath('home');
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA;
    if (localAppData) {
      candidates.push(path.join(localAppData, 'Programs', 'Cua', 'cua-driver', 'bin', 'cua-driver.exe'));
    }
    candidates.push(DRIVER_COMMAND);
  } else {
    candidates.push(
      path.join(home, '.local', 'bin', DRIVER_COMMAND),
      '/opt/homebrew/bin/cua-driver',
      '/usr/local/bin/cua-driver',
      DRIVER_COMMAND,
    );
  }
  return Array.from(new Set(candidates.filter(Boolean)));
}

function resolveDriverCommand(): string {
  const candidates = getDriverCandidates();
  for (const candidate of candidates) {
    if (candidate === DRIVER_COMMAND || existsSync(candidate)) {
      return candidate;
    }
  }
  return DRIVER_COMMAND;
}

function resolveDriverInvocation(args: readonly string[]): {
  command: string;
  args: string[];
  env?: Record<string, string>;
} {
  return { command: resolveDriverCommand(), args: [...args] };
}

/** Whether permission onboarding is deliberately waiting for a real app drag. */
export function isComputerDriverPermissionProbePaused(): boolean {
  return computerDriverPermissionProbePaused;
}

function assertComputerDriverToolDispatchAvailable(): void {
  if (computerDriverPermissionProbePaused) {
    throw new ComputerDriverError(
      'Computer Use tool calls are paused while permission onboarding is active.',
    );
  }
}

/**
 * Pause permission probes while the app is absent from the current macOS
 * permission pane. Close active agent MCP sessions and reject new tool calls
 * so they cannot re-register a deleted app row while the guide waits for a
 * fresh drag.
 */
export async function pauseComputerDriverPermissionProbe(): Promise<void> {
  computerDriverPermissionProbePaused = true;
  cachedPermissionProbe = null;
  lastDaemonAutostartAt = 0;
  await cleanupActiveComputerDriverSessions();
}

/** Resume live permission checks after System Settings contains Computer Use. */
export function resumeComputerDriverPermissionProbe(): void {
  computerDriverPermissionProbePaused = false;
  cachedPermissionProbe = null;
  lastDaemonAutostartAt = 0;
}

function runDriver(args: string[], timeoutMs: number, options: RunDriverOptions = {}): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const invocation = resolveDriverInvocation(args);
    const child = spawn(invocation.command, invocation.args, {
      stdio: [options.stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: invocation.env
        ? {
            ...process.env,
            ...invocation.env,
          }
        : undefined,
    });
    options.onChild?.(child);
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new ComputerDriverError(`cua-driver timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.once('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    if (options.stdin !== undefined) {
      child.stdin?.on('error', () => {
        /* Child process errors are handled through the child error/close events. */
      });
      child.stdin?.end(options.stdin);
    }
    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length < MAX_STDOUT_BYTES) stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < MAX_STDERR_BYTES) stderr += chunk.toString('utf8');
    });
    child.once('close', (exitCode, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode, signal });
    });
  });
}

/**
 * 安装前清理上游安装脚本残留的 stale 锁。
 *
 * 上游 _install-rust.sh 用 `$HOME/.cua-driver/packages/.install.lock.d`
 * (mkdir 原子锁,info 里写 holder pid)串行化并发安装;持有者被强杀时锁
 * 不会释放,后续安装会卡在 1s 轮询里等它的 600s stale 自愈——2026-07-02
 * 实测这正是「更新一直没进度」的根源。锁路径与 info 格式是上游脚本注释
 * 明确公开的行为;这里只在 holder 确认已死(kill -0 ESRCH)时才敢清,
 * 活着的慢安装绝不抢锁。返回是否清了锁,便于测试与日志。
 */
export function isInstallLockHolderAlive(holderPid: number): boolean {
  try {
    process.kill(holderPid, 0);
    return true;
  } catch (err) {
    // EPERM = 存活但无权限探测,保守视为活着
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function clearStaleCuaInstallLock(
  lockDir: string = path.join(os.homedir(), '.cua-driver', 'packages', '.install.lock.d'),
  isHolderAlive: (pid: number) => boolean = isInstallLockHolderAlive,
): boolean {
  try {
    const infoPath = path.join(lockDir, 'info');
    if (!existsSync(infoPath)) return false;
    const info = readFileSync(infoPath, 'utf8');
    const pidMatch = info.match(/^pid=(\d+)/m);
    if (!pidMatch) return false;
    const holderPid = Number(pidMatch[1]);
    if (isHolderAlive(holderPid)) return false; // 真的在装,别动它的锁
    rmSync(lockDir, { recursive: true, force: true });
    logger.warn('cleared stale cua-driver install lock left by a dead installer', {
      lockDir,
      holderPid,
    });
    return true;
  } catch (err) {
    logger.debug('stale cua-driver install lock preflight failed (ignored)', {
      message: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/**
 * 采样安装进程树快照(POSIX:同进程组的 pid + 累计 CPU time + 下载文件
 * 字节数)。慢速下载阻塞在网络 IO 时 CPU TIME 的秒值可能长时间不变,单靠
 * 进程快照会误杀健康下载——把 curl `-o` 目标文件的当前大小并入快照,文件
 * 在涨即算活动。Windows 无进程组概念,返回 null(活动检测退化为仅
 * stdout/stderr,硬上限兜底)。导出仅供测试。
 */
export async function sampleInstallProcessTree(rootPid: number): Promise<string | null> {
  if (process.platform === 'win32') return null;
  return new Promise((resolve) => {
    const ps = spawn('ps', ['-ax', '-o', 'pgid=,pid=,time=,command='], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let out = '';
    ps.stdout?.on('data', (chunk: Buffer) => {
      out += chunk.toString('utf8');
    });
    ps.once('error', () => resolve(null));
    ps.once('close', () => {
      const lines = out
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.startsWith(`${rootPid} `) || line.split(/\s+/)[0] === String(rootPid));
      let snapshot = lines.sort().join('|');
      for (const line of lines) {
        if (line.includes('curl') && line.includes('-o')) {
          const outFile = extractCurlOutputPath(line);
          if (outFile && existsSync(outFile)) {
            try {
              snapshot += `|bytes:${statSync(outFile).size}`;
            } catch {
              /* 下载文件瞬时消失(改名/清理),忽略 */
            }
          }
        }
      }
      resolve(snapshot || null);
    });
  });
}

/** 超时/失败时终止整个安装进程组,防止内层脚本残留并占着安装锁。 */
function killInstallTree(child: { pid?: number; kill: (signal?: NodeJS.Signals) => boolean }): void {
  const pid = child.pid;
  if (process.platform === 'win32') {
    if (pid) spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
    else child.kill();
    return;
  }
  try {
    if (pid) process.kill(-pid, 'SIGTERM');
    else child.kill();
  } catch {
    child.kill();
  }
  if (pid) {
    setTimeout(() => {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        /* 进程组已退出 */
      }
    }, 2_000).unref();
  }
}

export interface ActivityTimeoutOptions {
  idleTimeoutMs: number;
  hardTimeoutMs: number;
  pollIntervalMs: number;
  /** 测试注入:进程树采样器。返回 null 表示本平台/本次不可采样。 */
  sampleTree?: (rootPid: number) => Promise<string | null>;
  /** 子进程 spawn 后回调其 pid(供下载进度采样定位进程组)。 */
  onSpawn?: (pid: number | undefined) => void;
  /** 附加环境变量(如 CUA_DRIVER_RS_VERSION 版本 pin)。 */
  extraEnv?: Record<string, string>;
}

/**
 * 活动感知地运行安装命令:stdout/stderr 有输出、或安装进程树快照有变化,
 * 都视为「有进度」并重置 idle 计时;连续 idleTimeoutMs 无任何活动才判失败,
 * hardTimeoutMs 是防僵死的总时长兜底。POSIX 下 detached 起新进程组,超时
 * 时整组终止(而不是只杀外层 bash 留下持锁孤儿)。
 */
export function runProcessWithActivityTimeout(
  command: string,
  args: string[],
  options: ActivityTimeoutOptions,
): Promise<ExecResult> {
  const { idleTimeoutMs, hardTimeoutMs, pollIntervalMs } = options;
  const sampleTree = options.sampleTree ?? sampleInstallProcessTree;
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      detached: process.platform !== 'win32',
      env: {
        ...process.env,
        CUA_DRIVER_NO_MODIFY_PATH: '1',
        CUA_DRIVER_RS_NO_MODIFY_PATH: '1',
        ...options.extraEnv,
      },
    });
    options.onSpawn?.(child.pid);
    let stdout = '';
    let stderr = '';
    let settled = false;
    let lastActivityAt = Date.now();
    let lastTreeSnapshot: string | null = null;
    let pollTimer: NodeJS.Timeout | null = null;
    let idleTimer: NodeJS.Timeout | null = null;

    const cleanupTimers = () => {
      clearTimeout(hardTimer);
      if (idleTimer) clearTimeout(idleTimer);
      if (pollTimer) clearTimeout(pollTimer);
    };
    const fail = (message: string) => {
      if (settled) return;
      settled = true;
      cleanupTimers();
      killInstallTree(child);
      reject(new ComputerDriverError(message));
    };
    const markActivity = () => {
      lastActivityAt = Date.now();
    };
    const armIdleCheck = () => {
      if (settled) return;
      const idleFor = Date.now() - lastActivityAt;
      if (idleFor >= idleTimeoutMs) {
        fail(`${command} showed no install progress for ${Math.round(idleFor / 1000)}s`);
        return;
      }
      idleTimer = setTimeout(armIdleCheck, Math.max(1_000, idleTimeoutMs - idleFor));
    };
    const pollTree = () => {
      if (settled) return;
      pollTimer = setTimeout(() => {
        void sampleTree(child.pid ?? -1)
          .then((snapshot) => {
            if (snapshot !== null && snapshot !== lastTreeSnapshot) {
              lastTreeSnapshot = snapshot;
              markActivity();
            }
          })
          .catch(() => {
            /* 采样失败不算活动,也不判死 */
          })
          .finally(() => pollTree());
      }, pollIntervalMs);
      pollTimer.unref?.();
    };

    const hardTimer = setTimeout(() => {
      fail(`${command} timed out after ${hardTimeoutMs}ms (hard cap)`);
    }, hardTimeoutMs);
    hardTimer.unref?.();
    armIdleCheck();
    pollTree();

    child.once('error', (err) => {
      if (settled) return;
      settled = true;
      cleanupTimers();
      reject(err);
    });
    child.stdout?.on('data', (chunk: Buffer) => {
      markActivity();
      if (stdout.length < MAX_STDOUT_BYTES) stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      markActivity();
      if (stderr.length < MAX_STDERR_BYTES) stderr += chunk.toString('utf8');
    });
    child.once('close', (exitCode, signal) => {
      if (settled) return;
      settled = true;
      cleanupTimers();
      resolve({ stdout, stderr, exitCode, signal });
    });
  });
}

/**
 * Windows 上没有进程组/ps 的活动采样,且上游 install.ps1 在下载 asset 阶段
 * 静默(Invoke-WebRequest 进度被关掉)—— idle 检测只剩 stdout/stderr 一个
 * 信号,慢网下载会被误杀。因此 Windows 退化为「仅硬上限兜底」:idle 窗口
 * 拉满到硬上限,等价于不做 idle 判死。POSIX 保持 3 分钟无活动即失败。
 */
export function installIdleTimeoutForPlatform(platform: NodeJS.Platform = process.platform): number {
  return platform === 'win32' ? INSTALL_HARD_TIMEOUT_MS : INSTALL_IDLE_TIMEOUT_MS;
}

function runInstallCommand(
  onSpawn?: (pid: number | undefined) => void,
  targetVersion?: string,
): Promise<ExecResult> {
  clearStaleCuaInstallLock();
  const activityOptions: ActivityTimeoutOptions = {
    idleTimeoutMs: installIdleTimeoutForPlatform(),
    hardTimeoutMs: INSTALL_HARD_TIMEOUT_MS,
    pollIntervalMs: INSTALL_ACTIVITY_POLL_MS,
    onSpawn,
    // 更新场景把检测到的版本 pin 给上游脚本(env 是其最高优先级版本源)。
    // 不 pin 时上游会用脚本内 baked 默认值,该值可能滞后于真实最新版,
    // 导致「更新到 0.7.0」实际装回旧版(review P1)。
    ...(targetVersion ? { extraEnv: { CUA_DRIVER_RS_VERSION: targetVersion } } : {}),
  };
  if (process.platform === 'win32') {
    return runProcessWithActivityTimeout(
      'powershell.exe',
      [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        `irm ${WINDOWS_INSTALL_URL} | iex`,
      ],
      activityOptions,
    );
  }
  return runProcessWithActivityTimeout(
    '/bin/bash',
    ['-c', `curl -fsSL ${UNIX_INSTALL_URL} | /bin/bash`],
    activityOptions,
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 收割在途的 grant 流程(幂等)。触发时机:流程 stale(用户走开后再回来点授权)、
 * 权限已被 status 确认 granted(上游 grant 子进程还在傻等,留着只会占住 in-flight
 * 复用位)、以及应用清理。
 */
function stopPermissionGrantFlow(
  reason: string,
  options: { expectedFlow?: Promise<ExecResult> | null } = {},
): void {
  // expectedFlow 门控:调用方基于「某一代 grant 流程」的证据要求收割时,只有该流程
  // 仍是当前在途流程才执行。否则一个过期 status 探测的晚到 continuation(stale
  // granted)会误杀用户刚发起的新 grant 子进程 —— 引导弹窗还开着,原生授权流程却被
  // 静默终止(review P2)。不传 expectedFlow 表示无条件收割(stale 重启 / 用户取消 /
  // 应用清理这类不依赖探测证据的场景)。
  if (options.expectedFlow !== undefined && permissionGrantInFlight !== options.expectedFlow) {
    return;
  }
  const child = permissionGrantChild;
  const ageMs = permissionGrantStartedAt > 0 ? Date.now() - permissionGrantStartedAt : 0;
  permissionGrantInFlight = null;
  permissionGrantStartedAt = 0;
  permissionGrantChild = null;
  if (!child) return;

  if (!child.killed) {
    logger.info('stopping cua-driver permission grant flow', { reason, ageMs });
    try {
      child.kill();
    } catch {
      /* 进程已退出 */
    }
  }
}

function startPermissionGrantFlow(): Promise<ExecResult> {
  if (permissionGrantInFlight) {
    const ageMs = Date.now() - permissionGrantStartedAt;
    if (ageMs < PERMISSIONS_GRANT_REUSE_MAX_AGE_MS) {
      logger.info('cua-driver permission grant flow already in flight; reusing it', { ageMs });
      return permissionGrantInFlight;
    }
    // 旧流程可能已在等一个用户早就关掉的系统弹窗——复用它等于按钮无响应。
    logger.warn('cua-driver permission grant flow is stale; restarting it', {
      ageMs,
      staleAfterMs: PERMISSIONS_GRANT_REUSE_MAX_AGE_MS,
    });
    stopPermissionGrantFlow('stale');
  }

  lastPermissionGrantResult = null;
  lastPermissionGrantError = null;
  permissionGrantStartedAt = Date.now();
  let flowChild: ChildProcess | null = null;
  logger.info('starting cua-driver permission grant flow');
  const flow = runDriver(['permissions', 'grant'], PERMISSIONS_GRANT_TIMEOUT_MS, {
    onChild: (child) => {
      flowChild = child;
      permissionGrantChild = child;
    },
  })
    .then((res) => {
      // 已被 stopPermissionGrantFlow 换代的旧流程不许覆盖新流程的结果。
      if (permissionGrantInFlight === flow) {
        lastPermissionGrantResult = res;
      }
      logger.info('cua-driver permission grant flow exited', {
        exitCode: res.exitCode,
        signal: res.signal,
      });
      return res;
    })
    .catch((err) => {
      if (permissionGrantInFlight === flow) {
        lastPermissionGrantError = err instanceof Error ? err.message : String(err);
      }
      logger.warn('cua-driver permission grant flow failed', err);
      throw err;
    })
    .finally(() => {
      if (permissionGrantInFlight === flow) {
        permissionGrantInFlight = null;
        permissionGrantStartedAt = 0;
      }
      if (permissionGrantChild === flowChild) {
        permissionGrantChild = null;
      }
    });
  permissionGrantInFlight = flow;
  return flow;
}

function runProcess(command: string, args: string[], timeoutMs: number): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: {
        ...process.env,
        CUA_DRIVER_NO_MODIFY_PATH: '1',
        CUA_DRIVER_RS_NO_MODIFY_PATH: '1',
      },
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new ComputerDriverError(`${command} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.once('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length < MAX_STDOUT_BYTES) stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < MAX_STDERR_BYTES) stderr += chunk.toString('utf8');
    });
    child.once('close', (exitCode, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode, signal });
    });
  });
}

async function readDaemonStatus(): Promise<DaemonStatus> {
  const res = await runDriver(['status'], STATUS_TIMEOUT_MS);
  const message = (res.stdout || res.stderr).trim();
  // 输出形如 "  pid: 58564"。pid 用作 daemon 生命周期标识(权限探测缓存的门控键):
  // macOS 改屏幕录制授权必然杀掉目标进程,pid 变化 = 授权状态可能已变,需要重新实测。
  const pidMatch = message.match(/^\s*pid:\s*(\d+)\s*$/m);
  return {
    running: res.exitCode === 0,
    message,
    pid: pidMatch ? Number(pidMatch[1]) : null,
  };
}

async function readDriverVersion(): Promise<string | null> {
  const res = await runDriver(['--version'], STATUS_TIMEOUT_MS);
  if (res.exitCode !== 0) {
    throw new ComputerDriverError(res.stderr.trim() || `cua-driver --version exited ${res.exitCode}`);
  }
  return res.stdout.trim() || null;
}

async function readDriverJsonCommand(args: string[], timeoutMs: number): Promise<unknown> {
  const res = await runDriver(args, timeoutMs);
  if (res.exitCode !== 0) {
    throw new ComputerDriverError(res.stderr.trim() || `cua-driver ${args.join(' ')} exited ${res.exitCode}`);
  }
  return parseJsonOutput(res.stdout);
}

async function callCuaCliTool(name: ComputerMcpToolName): Promise<unknown> {
  const res = await runDriver(['call', name], CLI_FALLBACK_TIMEOUT_MS, { stdin: '{}\n' });
  if (res.exitCode !== 0) {
    throw new ComputerDriverError(res.stderr.trim() || `cua-driver call ${name} exited ${res.exitCode}`);
  }
  return parseJsonOutput(res.stdout);
}

function parseJsonOutput(stdout: string): unknown {
  const text = stdout.trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function outputPreview(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length <= LOG_OUTPUT_PREVIEW_CHARS) return trimmed;
  return `${trimmed.slice(0, LOG_OUTPUT_PREVIEW_CHARS)}... [truncated ${trimmed.length - LOG_OUTPUT_PREVIEW_CHARS} chars]`;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new ComputerDriverError(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function defaultScreenshotOutputPath(name: ComputerMcpToolName, args: Record<string, unknown>): string {
  const windowId = typeof args.window_id === 'number' ? String(args.window_id) : 'window';
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const dir = path.join(app.getPath('temp'), 'xdt-maker-cua');
  mkdirSync(dir, { recursive: true });
  return path.join(dir, `${name}-${windowId}-${suffix}.png`);
}

function processPath(): typeof path.posix {
  return process.platform === 'win32' ? path.win32 : path.posix;
}

function normalizePathForCompare(value: string): string {
  const resolved = processPath().resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isSameOrChildPath(candidate: string, parent: string): boolean {
  const pathApi = processPath();
  const normalizedCandidate = normalizePathForCompare(candidate);
  const normalizedParent = normalizePathForCompare(parent);
  if (normalizedCandidate === normalizedParent) return true;
  const relative = pathApi.relative(normalizedParent, normalizedCandidate);
  return Boolean(relative && !relative.startsWith('..') && !pathApi.isAbsolute(relative));
}

function commandContainsSameOrChildPath(command: string | undefined, parent: string): boolean {
  if (!command) return false;
  const normalizeText = (value: string) => (
    process.platform === 'win32' ? value.toLowerCase() : value
  ).replace(/\\/g, '/');
  const normalizedCommand = normalizeText(command);
  const normalizedParent = normalizeText(normalizePathForCompare(parent));
  let index = normalizedCommand.indexOf(normalizedParent);
  while (index >= 0) {
    const before = index === 0 ? '' : normalizedCommand[index - 1];
    const after = normalizedCommand[index + normalizedParent.length] ?? '';
    const startsOnBoundary = !before || /\s|["'=]/.test(before);
    const endsOnBoundary = !after || after === '/' || /\s|["']/.test(after);
    if (startsOnBoundary && endsOnBoundary) return true;
    index = normalizedCommand.indexOf(normalizedParent, index + 1);
  }
  return false;
}

function basenameFromCommand(command: string | undefined): string | undefined {
  if (!command) return undefined;
  const trimmed = command.trim();
  if (!trimmed) return undefined;
  const firstToken = trimmed.startsWith('"')
    ? trimmed.slice(1).split('"')[0]
    : trimmed.split(/\s+/)[0];
  return firstToken ? processPath().basename(firstToken) : undefined;
}

function executableFromCommand(command: string | undefined): string | undefined {
  if (!command) return undefined;
  const trimmed = command.trim();
  if (!trimmed) return undefined;
  if (trimmed.startsWith('"')) {
    const quoted = trimmed.slice(1).split('"')[0];
    return quoted || undefined;
  }
  const appMatch = trimmed.match(/^(\/.+?\.app\/Contents\/MacOS\/[^\s]+(?: [^\s]+)*?)(?:\s+\/|\s+-|$)/);
  if (appMatch?.[1]) return appMatch[1];
  return trimmed.split(/\s+/)[0];
}

function commandPathCandidates(command: string | undefined): string[] {
  if (!command) return [];
  const matches = process.platform === 'win32'
    ? command.match(/[A-Za-z]:\\[^\s"]+/g)
    : command.match(/\/[^\s"']+/g);
  return matches ?? [];
}

function pathHasSegment(candidate: string, segment: string): boolean {
  const pathApi = processPath();
  return pathApi.resolve(candidate).split(pathApi.sep).includes(segment);
}

function findWorkspaceRootFromPath(candidate: string, cache: Map<string, string | undefined>): string | undefined {
  const pathApi = processPath();
  const normalized = pathApi.resolve(candidate);
  if (cache.has(normalized)) return cache.get(normalized);
  let current = pathApi.extname(normalized) ? pathApi.dirname(normalized) : normalized;
  const packageJsonFallbacks: string[] = [];
  for (let depth = 0; depth < 8; depth += 1) {
    if (
      existsSync(pathApi.join(current, '.git')) ||
      existsSync(pathApi.join(current, 'pnpm-workspace.yaml'))
    ) {
      cache.set(normalized, current);
      return current;
    }
    if (
      existsSync(pathApi.join(current, 'package.json')) &&
      !pathHasSegment(current, 'node_modules')
    ) {
      packageJsonFallbacks.push(current);
    }
    const parent = pathApi.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  const fallback = packageJsonFallbacks[packageJsonFallbacks.length - 1];
  cache.set(normalized, fallback);
  return fallback;
}

function parsePosixProcesses(stdout: string): ProcessSnapshotEntry[] {
  const processes: ProcessSnapshotEntry[] = [];
  for (const line of stdout.split('\n')) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.+)\s*$/);
    if (!match) continue;
    const pid = Number(match[1]);
    const parentPid = Number(match[2]);
    const command = match[3]?.trim();
    if (!Number.isInteger(pid) || pid <= 0) continue;
    const executable = executableFromCommand(command);
    processes.push({
      pid,
      parent_pid: Number.isInteger(parentPid) && parentPid > 0 ? parentPid : undefined,
      name: executable ? processPath().basename(executable) : basenameFromCommand(command),
      command,
      executable,
    });
  }
  return processes;
}

function withLinuxProcessCwd(processInfo: ProcessSnapshotEntry | undefined): ProcessSnapshotEntry | undefined {
  if (!processInfo || process.platform !== 'linux' || processInfo.cwd) return processInfo;
  try {
    return {
      ...processInfo,
      cwd: readlinkSync(`/proc/${processInfo.pid}/cwd`),
    };
  } catch {
    return processInfo;
  }
}

function parseWindowsProcesses(stdout: string): ProcessSnapshotEntry[] {
  const trimmed = stdout.trim();
  if (!trimmed) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new ComputerDriverError('PowerShell process snapshot returned invalid JSON');
  }
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  const processes: ProcessSnapshotEntry[] = [];
  for (const row of rows) {
    const obj = objectValue(row);
    if (!obj) continue;
    const pid = Number(obj.ProcessId);
    const parentPid = Number(obj.ParentProcessId);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    const command = typeof obj.CommandLine === 'string' ? obj.CommandLine : undefined;
    const executable = typeof obj.ExecutablePath === 'string' ? obj.ExecutablePath : undefined;
    processes.push({
      pid,
      parent_pid: Number.isInteger(parentPid) && parentPid > 0 ? parentPid : undefined,
      name: typeof obj.Name === 'string' ? obj.Name : basenameFromCommand(command),
      command,
      executable,
    });
  }
  return processes;
}

async function readProcessSnapshotResult(options: {
  forceFresh?: boolean;
} = {}): Promise<ProcessSnapshotResult> {
  if (!options.forceFresh && cachedProcessSnapshot && cachedProcessSnapshot.expiresAt > Date.now()) {
    return cachedProcessSnapshot.result;
  }
  const result = await readProcessSnapshotUncached();
  if (result.available) {
    cachedProcessSnapshot = {
      expiresAt: Date.now() + PROCESS_SNAPSHOT_CACHE_MS,
      result,
    };
  }
  return result;
}

async function readProcessSnapshotUncached(): Promise<ProcessSnapshotResult> {
  try {
    const result = process.platform === 'win32'
      ? await runProcess(
        'powershell.exe',
        [
          '-NoProfile',
          '-Command',
          'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,ExecutablePath,CommandLine | ConvertTo-Json -Compress',
        ],
        WINDOWS_PROCESS_SNAPSHOT_TIMEOUT_MS,
      )
      : await runProcess(
        'ps',
        ['-eo', 'pid=,ppid=,command='],
        POSIX_PROCESS_SNAPSHOT_TIMEOUT_MS,
      );
    if (result.exitCode !== 0) {
      throw new ComputerDriverError(
        result.stderr.trim() || result.stdout.trim() || `process snapshot command exited ${result.exitCode}`,
      );
    }
    const processes = process.platform === 'win32'
      ? parseWindowsProcesses(result.stdout)
      : parsePosixProcesses(result.stdout);
    return {
      available: true,
      processes: new Map(processes.map((processInfo) => [processInfo.pid, processInfo])),
    };
  } catch (err) {
    logger.debug('failed to read process snapshot for computer-use window enrichment', {
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      available: false,
      processes: new Map(),
    };
  }
}

function parseWindowsWin32FallbackSnapshot(stdout: string): WindowsWin32FallbackSnapshot {
  const trimmed = stdout.trim();
  if (!trimmed) {
    throw new ComputerDriverError('PowerShell Win32 fallback returned no output');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new ComputerDriverError('PowerShell Win32 fallback returned invalid JSON');
  }

  const root = objectValue(parsed);
  if (!root) {
    throw new ComputerDriverError('PowerShell Win32 fallback returned an invalid payload');
  }
  const processRows = Array.isArray(root.Processes)
    ? root.Processes
    : root.Processes
      ? [root.Processes]
      : [];
  const processEntries: ProcessSnapshotEntry[] = [];
  for (const row of processRows) {
    const obj = objectValue(row);
    if (!obj) continue;
    const pid = Number(obj.ProcessId);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    processEntries.push({
      pid,
      name: typeof obj.Name === 'string' ? obj.Name : undefined,
      executable: typeof obj.ExecutablePath === 'string' ? obj.ExecutablePath : undefined,
    });
  }
  const processes = new Map(processEntries.map((processInfo) => [processInfo.pid, processInfo]));
  const windowRows = Array.isArray(root.Windows)
    ? root.Windows
    : root.Windows
      ? [root.Windows]
      : [];
  const windows: Record<string, unknown>[] = [];
  for (const row of windowRows) {
    const obj = objectValue(row);
    if (!obj) continue;
    const windowId = Number(obj.WindowId);
    const pid = Number(obj.ProcessId);
    const left = Number(obj.Left);
    const top = Number(obj.Top);
    const width = Number(obj.Width);
    const height = Number(obj.Height);
    if (
      !Number.isSafeInteger(windowId) ||
      windowId < 0 ||
      !Number.isInteger(pid) ||
      pid <= 0 ||
      !Number.isFinite(left) ||
      !Number.isFinite(top) ||
      !Number.isFinite(width) ||
      !Number.isFinite(height)
    ) {
      continue;
    }
    const processInfo = processes.get(pid);
    windows.push({
      window_id: windowId,
      hwnd: windowId,
      pid,
      app_name: processInfo?.name ?? `pid:${pid}`,
      title: typeof obj.Title === 'string' ? obj.Title : '',
      bounds: {
        x: left,
        y: top,
        width,
        height,
      },
      is_visible: obj.IsVisible === true,
      is_minimized: obj.IsIconic === true,
      is_on_screen: obj.IsOnScreen === true,
      source: WIN32_FALLBACK_SOURCE,
      accessibility_unavailable: true,
    });
  }
  return {
    windows,
    processSnapshot: {
      available: true,
      processes,
    },
  };
}

async function readWindowsWin32FallbackSnapshot(): Promise<WindowsWin32FallbackSnapshot> {
  if (process.platform !== 'win32') {
    throw new ComputerDriverError('Win32 fallback is only available on Windows');
  }
  const result = await runProcess(
    'powershell.exe',
    [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      WINDOWS_WIN32_WINDOW_SNAPSHOT_SCRIPT,
    ],
    WINDOWS_WIN32_FALLBACK_TIMEOUT_MS,
  );
  if (result.exitCode !== 0) {
    throw new ComputerDriverError(
      result.stderr.trim() || result.stdout.trim() || `PowerShell Win32 fallback exited ${result.exitCode}`,
    );
  }
  return parseWindowsWin32FallbackSnapshot(result.stdout);
}

function mergeProcessSnapshots(
  primary: ProcessSnapshotResult,
  fallback: ProcessSnapshotResult,
): ProcessSnapshotResult {
  const processes = new Map(fallback.processes);
  for (const [pid, processInfo] of primary.processes) {
    const fallbackProcess = processes.get(pid);
    const definedProcessInfo = Object.fromEntries(
      Object.entries(processInfo).filter(([, value]) => value !== undefined),
    ) as ProcessSnapshotEntry;
    processes.set(pid, {
      ...fallbackProcess,
      ...definedProcessInfo,
    });
  }
  return {
    available: primary.available || fallback.available,
    processes,
  };
}

async function getWindowsWin32FallbackProcessSnapshot(
  fallbackSnapshot: WindowsWin32FallbackSnapshot,
  args: Record<string, unknown>,
): Promise<ProcessSnapshotResult> {
  if (!(typeof args.workspace_root === 'string' && args.workspace_root.trim().length > 0)) {
    return fallbackSnapshot.processSnapshot;
  }
  const processSnapshot = await readProcessSnapshotResult({ forceFresh: true });
  if (!processSnapshot.available) {
    return fallbackSnapshot.processSnapshot;
  }
  return mergeProcessSnapshots(processSnapshot, fallbackSnapshot.processSnapshot);
}

function inferWorkspaceRoot(
  processInfo: ProcessSnapshotEntry | undefined,
  workspaceRootCache: Map<string, string | undefined>,
): string | undefined {
  const candidates = [
    processInfo?.cwd,
    ...commandPathCandidates(processInfo?.command),
    processInfo?.executable,
  ].filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
  for (const candidate of candidates) {
    const workspaceRoot = findWorkspaceRootFromPath(candidate, workspaceRootCache);
    if (workspaceRoot) return workspaceRoot;
  }
  return undefined;
}

function inferWindowIdentity(
  window: Record<string, unknown>,
  processInfo: ProcessSnapshotEntry | undefined,
  workspaceRootCache: Map<string, string | undefined>,
): WindowIdentity {
  const labels: string[] = [];
  const haystack = [
    typeof window.app_name === 'string' ? window.app_name : '',
    typeof window.title === 'string' ? window.title : '',
    processInfo?.name ?? '',
    processInfo?.command ?? '',
    processInfo?.executable ?? '',
  ].join(' ').toLowerCase();

  let kind: WindowIdentity['kind'] = 'unknown';
  let confidence = 0;
  if (/\b(electron|electron-forge)\b/.test(haystack)) {
    kind = 'electron-dev';
    confidence = 0.75;
    labels.push('electron');
  } else if (/\b(pnpm|npm|yarn|node|tsx|vite)\b/.test(haystack)) {
    kind = 'node-dev';
    confidence = 0.65;
    labels.push('node');
  } else if (/\b(chrome|chromium|safari|firefox|edge|msedge)\b/.test(haystack)) {
    kind = 'browser';
    confidence = 0.7;
    labels.push('browser');
  } else if (/\b(terminal|iterm|powershell|cmd\.exe|windows terminal|wt\.exe)\b/.test(haystack)) {
    kind = 'terminal';
    confidence = 0.7;
    labels.push('terminal');
  }

  const workspaceRoot = inferWorkspaceRoot(processInfo, workspaceRootCache);
  if (workspaceRoot) labels.push('workspace');
  return {
    kind,
    workspace_root: workspaceRoot,
    confidence,
    labels,
  };
}

function stripLocalListWindowsArgs(
  name: ComputerMcpToolName,
  args: Record<string, unknown>,
): Record<string, unknown> {
  if (name !== 'list_windows') return args;
  return Object.fromEntries(
    Object.entries(args).filter(([key]) => !LIST_WINDOWS_LOCAL_ARG_NAMES.has(key)),
  );
}

function searchableWindowText(window: Record<string, unknown>): string {
  const processInfo = objectValue(window.process);
  const identity = objectValue(window.identity);
  return [
    window.window_id,
    window.pid,
    window.title,
    window.app_name,
    processInfo?.pid,
    processInfo?.parent_pid,
    processInfo?.name,
    processInfo?.command,
    processInfo?.cwd,
    processInfo?.executable,
    identity?.kind,
    identity?.workspace_root,
    ...(Array.isArray(identity?.labels) ? identity.labels : []),
  ]
    .filter((value) => value !== undefined && value !== null)
    .join(' ')
    .toLowerCase();
}

function processNameMatches(window: Record<string, unknown>, filter: string): boolean {
  const needle = filter.trim().toLowerCase();
  if (!needle) return true;
  const processInfo = objectValue(window.process);
  const candidates = [
    processInfo?.name,
    processInfo?.command,
    processInfo?.executable ? processPath().basename(String(processInfo.executable)) : undefined,
  ]
    .filter((value): value is string => typeof value === 'string')
    .map((value) => value.toLowerCase());
  return candidates.some((candidate) => candidate.includes(needle));
}

function workspaceMatches(window: Record<string, unknown>, filter: string): boolean {
  const processInfo = objectValue(window.process);
  const identity = objectValue(window.identity);
  const candidates = [
    processInfo?.cwd,
    processInfo?.executable,
    identity?.workspace_root,
  ].filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
  return (
    candidates.some((candidate) => isSameOrChildPath(candidate, filter)) ||
    commandContainsSameOrChildPath(typeof processInfo?.command === 'string' ? processInfo.command : undefined, filter)
  );
}

function filterEnrichedWindows(
  windows: Record<string, unknown>[],
  args: Record<string, unknown>,
  options: { applyDriverSideFilters?: boolean } = {},
): Record<string, unknown>[] {
  const query = typeof args.query === 'string' ? args.query.trim().toLowerCase() : '';
  const workspaceRoot = typeof args.workspace_root === 'string' ? args.workspace_root.trim() : '';
  const processName = typeof args.process_name === 'string' ? args.process_name.trim() : '';
  const pid = typeof args.pid === 'number' && Number.isInteger(args.pid) && args.pid > 0 ? args.pid : null;
  const onScreenOnly = args.on_screen_only === true;
  return windows.filter((window) => {
    if (options.applyDriverSideFilters && pid !== null && window.pid !== pid) return false;
    if (
      options.applyDriverSideFilters &&
      onScreenOnly &&
      typeof window.is_on_screen === 'boolean' &&
      !window.is_on_screen
    ) {
      return false;
    }
    if (query && !searchableWindowText(window).includes(query)) return false;
    if (workspaceRoot && !workspaceMatches(window, workspaceRoot)) return false;
    if (processName && !processNameMatches(window, processName)) return false;
    return true;
  });
}

function needsProcessBackedFilter(args: Record<string, unknown>): boolean {
  return (
    (typeof args.workspace_root === 'string' && args.workspace_root.trim().length > 0) ||
    (typeof args.process_name === 'string' && args.process_name.trim().length > 0)
  );
}

async function enrichAndFilterListWindowsResult(
  result: unknown,
  args: Record<string, unknown>,
  options: {
    processSnapshot?: ProcessSnapshotResult;
    applyDriverSideFilters?: boolean;
  } = {},
): Promise<unknown> {
  const obj = objectValue(result);
  if (!obj || !Array.isArray(obj.windows)) return result;
  const windowObjects = obj.windows.filter(objectValue) as Record<string, unknown>[];
  const needsProcessSnapshot = windowObjects.some((window) => typeof window.pid === 'number');
  const processSnapshot = needsProcessSnapshot
    ? options.processSnapshot ?? await readProcessSnapshotResult({ forceFresh: needsProcessBackedFilter(args) })
    : { available: true, processes: new Map<number, ProcessSnapshotEntry>() };
  const workspaceRootCache = new Map<string, string | undefined>();
  const windows = windowObjects.map((windowObject) => {
    const pid = typeof windowObject.pid === 'number' ? windowObject.pid : undefined;
    const processInfo = pid ? withLinuxProcessCwd(processSnapshot.processes.get(pid)) : undefined;
    const processPayload = processInfo
      ? {
          pid: processInfo.pid,
          parent_pid: processInfo.parent_pid,
          name: processInfo.name,
          command: processInfo.command,
          cwd: processInfo.cwd,
          executable: processInfo.executable,
        }
      : pid
        ? { pid }
        : undefined;
    return {
      ...windowObject,
      ...(processPayload ? { process: processPayload } : {}),
      ...(processInfo ? { identity: inferWindowIdentity(windowObject, processInfo, workspaceRootCache) } : {}),
    };
  });
  return {
    ...obj,
    ...(!processSnapshot.available && needsProcessBackedFilter(args) ? { enrichment: 'unavailable' } : {}),
    windows: filterEnrichedWindows(windows, args, {
      applyDriverSideFilters: options.applyDriverSideFilters,
    }),
  };
}

async function buildWindowsWin32ListWindowsFallback(args: Record<string, unknown>): Promise<unknown> {
  const fallbackSnapshot = await readWindowsWin32FallbackSnapshot();
  const processSnapshot = await getWindowsWin32FallbackProcessSnapshot(fallbackSnapshot, args);
  return enrichAndFilterListWindowsResult(
    {
      ok: true,
      source: WIN32_FALLBACK_SOURCE,
      degraded: true,
      accessibility_unavailable: true,
      windows: fallbackSnapshot.windows,
    },
    args,
    {
      processSnapshot,
      applyDriverSideFilters: true,
    },
  );
}

async function buildWindowsWin32ListAppsFallback(): Promise<unknown> {
  const fallbackSnapshot = await readWindowsWin32FallbackSnapshot();
  const apps = Array.from(fallbackSnapshot.processSnapshot.processes.values())
    .flatMap((processInfo): Record<string, unknown>[] => {
      const windows = fallbackSnapshot.windows.filter((window) => window.pid === processInfo.pid);
      if (windows.length === 0) return [];
      return [{
        pid: processInfo.pid,
        name: processInfo.name ?? `pid:${processInfo.pid}`,
        app_name: processInfo.name ?? `pid:${processInfo.pid}`,
        process_name: processInfo.name,
        executable: processInfo.executable,
        is_running: true,
        running_windows_only: true,
        installed_app_metadata_unavailable: true,
        source: WIN32_FALLBACK_SOURCE,
        accessibility_unavailable: true,
        window_count: windows.length,
        windows: windows.map((window) => ({
          window_id: window.window_id,
          hwnd: window.hwnd,
          title: window.title,
          bounds: window.bounds,
          is_on_screen: window.is_on_screen,
          source: WIN32_FALLBACK_SOURCE,
          accessibility_unavailable: true,
        })),
      }];
    });

  return {
    ok: true,
    source: WIN32_FALLBACK_SOURCE,
    degraded: true,
    running_apps_only: true,
    installed_app_metadata_unavailable: true,
    accessibility_unavailable: true,
    apps,
  };
}

function normalizeToolArgsForDriver(
  name: ComputerMcpToolName,
  args: Record<string, unknown>,
): Record<string, unknown> {
  if (!SCREENSHOT_OUTPUT_TOOL_NAMES.has(name) || typeof args.screenshot_out_file === 'string') {
    return args;
  }
  if (args.capture_mode === 'ax') {
    return args;
  }
  return {
    ...args,
    screenshot_out_file: defaultScreenshotOutputPath(name, args),
  };
}

function readSessionIdFromContext(
  context: ComputerMcpCallContext | undefined,
): string | null {
  if (typeof context?.sessionId === 'string' && context.sessionId.trim()) {
    return context.sessionId.trim();
  }
  return null;
}

function firstTextFromMcpResult(result: unknown): string | null {
  if (!result || typeof result !== 'object') return null;
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) return null;
  const firstText = content.find((item) => (
    item
    && typeof item === 'object'
    && (item as { type?: unknown }).type === 'text'
    && typeof (item as { text?: unknown }).text === 'string'
  ));
  return firstText ? (firstText as { text: string }).text : null;
}

function structuredContentFromMcpResult(result: unknown): unknown {
  if (!result || typeof result !== 'object') return undefined;
  if (!Object.hasOwn(result, 'structuredContent')) return undefined;
  return (result as { structuredContent?: unknown }).structuredContent;
}

function hasNonTextMcpContent(result: unknown): boolean {
  if (!result || typeof result !== 'object') return false;
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) return false;
  return content.some((item) => (
    item
    && typeof item === 'object'
    && (item as { type?: unknown }).type !== 'text'
  ));
}

function parseMcpToolResult(result: unknown): unknown {
  const structuredContent = structuredContentFromMcpResult(result);
  if (structuredContent !== undefined) return structuredContent;
  if (hasNonTextMcpContent(result)) return result;
  const text = firstTextFromMcpResult(result);
  if (text === null) return result;
  return parseJsonOutput(text);
}

function getDriverSessionId(sessionId: string): string {
  const generation = cuaDriverSessionGenerations.get(sessionId) ?? 0;
  return `${sessionId}-cua-${CUA_DRIVER_SESSION_PROCESS_NONCE}-${generation}`;
}

function rotateDriverSessionId(sessionId: string, failedDriverSessionId: string): void {
  if (getDriverSessionId(sessionId) !== failedDriverSessionId) return;
  const generation = cuaDriverSessionGenerations.get(sessionId) ?? 0;
  cuaDriverSessionGenerations.set(sessionId, generation + 1);
}

function applyDriverSessionArgs(
  name: ComputerMcpToolName,
  args: Record<string, unknown>,
  driverSessionId: string,
): Record<string, unknown> {
  if (!DRIVER_SESSION_ARG_TOOL_NAMES.has(name)) return args;
  if (name === 'get_agent_cursor_state') {
    return {
      ...args,
      cursor_id: driverSessionId,
    };
  }
  if (name === 'move_cursor') {
    return {
      ...args,
      cursor_id: driverSessionId,
      session: driverSessionId,
    };
  }
  return {
    ...args,
    session: driverSessionId,
  };
}

function splitTypeTextChunks(text: string): string[] {
  const chars = Array.from(text);
  if (chars.length <= TYPE_TEXT_CHUNK_CHARS) return [text];
  const chunks: string[] = [];
  for (let index = 0; index < chars.length; index += TYPE_TEXT_CHUNK_CHARS) {
    chunks.push(chars.slice(index, index + TYPE_TEXT_CHUNK_CHARS).join(''));
  }
  return chunks;
}

/**
 * Cua MCP session 已失效时可能出现的错误标记。这里同时供
 * `callCuaMcpTool` 和 `shouldRetryWithFreshCuaSession` 使用，避免某种
 * plain text 结果被提升成错误后却没有进入一次性重试分支。
 */
const STALE_CUA_SESSION_MARKER_RE = /session ended; tool call ignored|not connected/i;

function shouldCleanupCuaMcpSessionAfterError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  if (/timed out after/.test(message)) return true;
  return /transport (?:closed|error)|read ECONNRESET|write EPIPE|connection closed|stream closed|session ended|not connected/i.test(message);
}

function shouldRetryWithFreshCuaSession(name: ComputerMcpToolName, err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return (
    STALE_CUA_SESSION_MARKER_RE.test(message) ||
    (/timed out after/i.test(message) && LIGHTWEIGHT_TIMEOUT_RETRY_TOOL_NAMES.has(name))
  );
}

function getCuaMcpToolTimeoutMs(name: ComputerMcpToolName): number {
  return LIGHTWEIGHT_TIMEOUT_RETRY_TOOL_NAMES.has(name) ? LIGHTWEIGHT_CALL_TIMEOUT_MS : CALL_TIMEOUT_MS;
}

function shouldUseCliFallbackAfterError(name: ComputerMcpToolName, err: unknown): boolean {
  if (!CLI_FALLBACK_TOOL_NAMES.has(name)) return false;
  const message = err instanceof Error ? err.message : String(err);
  return /timed out after|not connected/i.test(message);
}

function shouldUseWindowsWin32FallbackAfterError(name: ComputerMcpToolName, err: unknown): boolean {
  if (process.platform !== 'win32' || !WINDOWS_WIN32_FALLBACK_TOOL_NAMES.has(name)) return false;
  const message = err instanceof Error ? err.message : String(err);
  if (!/timed out after/i.test(message)) return false;
  if (STALE_CUA_SESSION_MARKER_RE.test(message)) return false;
  if (/transport (?:closed|error)|read ECONNRESET|write EPIPE|connection closed|stream closed|session ended/i.test(message)) {
    return false;
  }
  if (/permission denied|access denied|unauthorized|forbidden/i.test(message)) return false;
  return true;
}

async function tryWindowsWin32Fallback(
  name: ComputerMcpToolName,
  args: Record<string, unknown>,
  cause: unknown,
): Promise<unknown> {
  if (!shouldUseWindowsWin32FallbackAfterError(name, cause)) {
    throw cause;
  }
  try {
    if (name === 'list_windows') {
      return await buildWindowsWin32ListWindowsFallback(args);
    }
    if (name === 'list_apps') {
      return await buildWindowsWin32ListAppsFallback();
    }
  } catch (fallbackErr) {
    logger.warn('Win32 degraded computer-use fallback failed', {
      tool: name,
      cause: cause instanceof Error ? cause.message : String(cause),
      error: fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr),
    });
  }
  throw cause;
}

function cleanupCuaMcpSessionAfterError(
  sessionId: string,
  entry: CuaMcpSessionEntry,
): Promise<void> {
  rotateDriverSessionId(sessionId, entry.driverSessionId);
  return cleanupComputerDriverSessionInternal(sessionId, {
    resetGeneration: false,
    expectedEntry: entry,
  });
}

function getCuaMcpSessionCloseVersion(sessionId: string): number {
  return cuaMcpSessionCloseVersions.get(sessionId) ?? 0;
}

function markCuaMcpSessionClosed(sessionId: string): void {
  cuaMcpSessionCloseVersions.set(sessionId, getCuaMcpSessionCloseVersion(sessionId) + 1);
}

function inheritedProcessEnv(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  );
}

function logCuaMcpStderr(sessionId: string, stream: Stream): void {
  let buffer = '';
  stream.on('data', (chunk: Buffer | string) => {
    buffer += chunk.toString();
    let index = buffer.indexOf('\n');
    while (index >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line) logger.debug('cua-driver mcp stderr', { sessionId, line });
      index = buffer.indexOf('\n');
    }
    if (buffer.length > LOG_OUTPUT_PREVIEW_CHARS) {
      logger.debug('cua-driver mcp stderr', { sessionId, line: outputPreview(buffer) });
      buffer = '';
    }
  });
}

function createCuaMcpSession(sessionId: string): CuaMcpSessionEntry {
  const invocation = resolveDriverInvocation(['mcp']);
  const transport = new StdioClientTransport({
    command: invocation.command,
    args: invocation.args,
    env: {
      ...inheritedProcessEnv(),
      ...(invocation.env ?? {}),
    },
    stderr: 'pipe',
  });
  const stderr = transport.stderr;
  if (stderr) logCuaMcpStderr(sessionId, stderr);
  const client = new Client({
    name: 'xdt-maker-cua-driver',
    version: '0.1.0',
  });
  const entry: CuaMcpSessionEntry = {
    client,
    transport,
    driverSessionId: getDriverSessionId(sessionId),
    styled: false,
    ready: withTimeout(
      client.connect(transport),
      MCP_STARTUP_TIMEOUT_MS,
      `cua-driver mcp session ${sessionId} startup`,
    ).catch(async (err) => {
      cuaMcpSessions.delete(sessionId);
      try {
        await client.close();
      } catch {
        try {
          await transport.close();
        } catch {
          /* ignore startup cleanup failure */
        }
      }
      throw err;
    }),
  };
  cuaMcpSessions.set(sessionId, entry);
  return entry;
}

async function getCuaMcpSession(sessionId: string): Promise<CuaMcpSessionEntry> {
  assertComputerDriverToolDispatchAvailable();
  const existing = cuaMcpSessions.get(sessionId);
  if (existing) {
    await existing.ready;
    return existing;
  }
  const cleanup = cuaMcpSessionCleanups.get(sessionId);
  if (cleanup) {
    await cleanup.catch(() => undefined);
    const next = cuaMcpSessions.get(sessionId);
    if (next) {
      await next.ready;
      return next;
    }
  }
  const entry = createCuaMcpSession(sessionId);
  await entry.ready;
  return entry;
}

async function callCuaMcpTool(
  entry: CuaMcpSessionEntry,
  name: string,
  args: Record<string, unknown>,
  timeoutMs: number,
): Promise<unknown> {
  const result = await withTimeout(
    entry.client.callTool({
      name,
      arguments: args,
    }),
    timeoutMs,
    `cua-driver mcp tool ${name}`,
  );
  if ((result as { isError?: unknown }).isError) {
    const text = firstTextFromMcpResult(result);
    throw new ComputerDriverError(text ?? `cua-driver mcp tool ${name} returned an error`);
  }
  const parsed = parseMcpToolResult(result);
  if (typeof parsed === 'string' && STALE_CUA_SESSION_MARKER_RE.test(parsed)) {
    throw new ComputerDriverError(parsed);
  }
  return parsed;
}

async function callCuaMcpToolWithTypeTextChunks(
  entry: CuaMcpSessionEntry,
  name: ComputerMcpToolName,
  args: Record<string, unknown>,
  timeoutMs: number,
): Promise<unknown> {
  if (name !== 'type_text' || typeof args.text !== 'string') {
    return callCuaMcpTool(entry, name, args, timeoutMs);
  }

  const chunks = splitTypeTextChunks(args.text);
  if (chunks.length === 1) {
    return callCuaMcpTool(entry, name, args, timeoutMs);
  }

  let lastResult: unknown = null;
  let inserted = 0;
  let processedChunks = 0;
  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index];
    try {
      lastResult = await callCuaMcpTool(
        entry,
        name,
        {
          ...args,
          text: chunk,
        },
        timeoutMs,
      );
    } catch (err) {
      if (shouldRetryWithFreshCuaSession(name, err)) {
        throw new ComputerDriverTypeTextRetryError(
          err instanceof Error ? err.message : String(err),
          chunks.slice(index).join(''),
          inserted,
          index,
        );
      }
      throw err;
    }
    const resultObject = objectValue(lastResult);
    processedChunks += 1;
    if (resultObject?.ok === false) {
      if (typeof resultObject.inserted === 'number') {
        inserted += resultObject.inserted;
      }
      return {
        ...resultObject,
        inserted,
        chunks: processedChunks,
        chars: inserted,
        lastResult,
      };
    }
    if (typeof resultObject?.inserted === 'number') {
      inserted += resultObject.inserted;
    } else {
      inserted += Array.from(chunk).length;
    }
  }
  const lastResultObject = objectValue(lastResult);
  return {
    ...(lastResultObject ?? {}),
    ok: true,
    inserted,
    chunks: processedChunks,
    chars: inserted,
    lastResult,
  };
}

async function initializeDefaultCursorStyle(
  name: ComputerMcpToolName,
  _args: Record<string, unknown>,
  entry: CuaMcpSessionEntry,
  session: string,
): Promise<void> {
  if (!CURSOR_STYLED_TOOL_NAMES.has(name)) return;
  if (entry.styled) return;

  const calls: Array<{ tool: string; args: Record<string, unknown> }> = [
    {
      tool: 'set_agent_cursor_motion',
      args: {
        cursor_id: session,
        ...TAPTAP_CURSOR_MOTION,
      },
    },
    {
      tool: 'set_agent_cursor_style',
      args: {
        cursor_id: session,
        gradient_colors: TAPTAP_CURSOR_STYLE.gradient_colors,
        bloom_color: TAPTAP_CURSOR_STYLE.bloom_color,
      },
    },
  ];

  let styled = true;
  for (const call of calls) {
    try {
      await callCuaMcpTool(
        entry,
        call.tool,
        call.args,
        STATUS_TIMEOUT_MS,
      );
    } catch (err) {
      styled = false;
      logger.warn('failed to apply default cua-driver cursor style', {
        tool: name,
        cursorTool: call.tool,
        session,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  entry.styled = styled;
}

function readBooleanGrant(value: unknown): ComputerDriverPermissionGrant {
  if (value === true) return 'granted';
  if (value === false) return 'missing';
  return 'unknown';
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function normalizePermissionState(raw: unknown): ComputerDriverPermissionState {
  const platform = getPermissionPlatform();
  if (platform !== 'macos') {
    return {
      platform,
      required: false,
      status: 'not_required',
      accessibility: 'not_required',
      screenRecording: 'not_required',
      screenRecordingCapturable: 'not_required',
      canGrant: false,
    };
  }

  const obj = objectValue(raw);
  if (!obj) {
    return {
      platform,
      required: true,
      status: 'unknown',
      reason: 'cua-driver did not return a permission payload',
      canGrant: true,
    };
  }

  if (obj.status === 'unknown') {
    return {
      platform,
      required: true,
      status: 'unknown',
      reason: typeof obj.reason === 'string' ? obj.reason : undefined,
      canGrant: true,
    };
  }

  if (obj.ok === false || typeof obj.error === 'string') {
    return {
      platform,
      required: true,
      status: 'unknown',
      reason: typeof obj.error === 'string' ? obj.error : undefined,
      canGrant: true,
    };
  }

  const sourceObject = objectValue(obj.source);
  const source = sourceObject?.attribution;
  const sourceAttribution = typeof source === 'string' ? source : undefined;
  const accessibility = readBooleanGrant(obj.accessibility);
  const screenRecording = readBooleanGrant(obj.screen_recording);
  const screenRecordingCapturable = readBooleanGrant(obj.screen_recording_capturable);
  const grantsBelongToDriver = !sourceAttribution || sourceAttribution === 'driver-daemon';
  // capturable 是 daemon 用 ScreenCaptureKit 实测「此刻能否真正截屏」;screen_recording
  // 只是 TCC 数据库的 preflight 记录。driver 二进制更新后会出现「记录还在、授权实际已
  // 失效」的 stale grant(screen_recording=true / capturable=false),此时截屏必失败且
  // macOS 会反复弹重新授权框 —— 必须以实测为准报 missing,把用户指回系统设置重新授权;
  // 反向(preflight 读不到但实测可截)同样信实测。只有 capturable 字段缺席(unknown,
  // 旧版 driver)才回退信 preflight 记录。
  const screenCaptureReady =
    screenRecordingCapturable === 'granted' ||
    (screenRecordingCapturable === 'unknown' && screenRecording === 'granted');
  const staleScreenRecordingGrant =
    screenRecording === 'granted' && screenRecordingCapturable === 'missing';
  const granted =
    accessibility === 'granted' &&
    screenCaptureReady &&
    grantsBelongToDriver;

  return {
    platform,
    required: true,
    status: granted ? 'granted' : 'missing',
    accessibility,
    screenRecording,
    screenRecordingCapturable,
    source: sourceAttribution,
    reason: !grantsBelongToDriver
      ? 'Permission status belongs to the launching app, not CuaDriver.'
      : staleScreenRecordingGrant
        ? 'macOS still lists a Screen Recording grant but live capture is denied (stale grant, typically after a driver update). Re-enable CuaDriver in System Settings → Privacy & Security → Screen Recording.'
        : undefined,
    canGrant: true,
  };
}

export async function getComputerDriverStatus(
  options: ComputerDriverStatusOptions = {},
): Promise<ComputerDriverStatus> {
  try {
    const version = await readDriverVersion();
    const installedVersion = extractDriverSemver(version);
    const passivePermissionProbeSupported =
      options.passivePermissionProbeOnly !== true
      || (
        installedVersion !== null
        && compareSemver(installedVersion, PASSIVE_PERMISSION_STATUS_MIN_VERSION) >= 0
      );
    let daemon: DaemonStatus = await readDaemonStatus().catch((err) => ({
      running: false,
      message: err instanceof Error ? err.message : String(err),
      pid: null,
    }));
    // fresh 探测(重新检查 / 开启开关):先主动停掉 daemon,再由下方自愈分支立刻
    // 拉起并对新进程实测 —— 这是读到「辅助功能已被撤销」的唯一途径(运行中的
    // daemon 对 AX 撤销无感知)。fresh 是用户显式动作,必须永远给出第一手结论,
    // 绝不能被弹窗抑制缓存挡成「点了没反应」(2026-07-03 实踩);坏状态下重启后的
    // 实测可能让 macOS 弹一次授权框,但此时 UI 已如实显示未授权,语义一致。护栏:
    //   - 有 cua MCP 会话在跑 → 不重启(别打断正在操作电脑的 agent),退化为
    //     不重启的现场实测(AX 撤销此时读不到,但至少刷新其余状态);
    //   - stop 失败(daemon 仍在)→ 同上,静默回落不重启的现场实测。
    if (
      process.platform === 'darwin' &&
      !computerDriverPermissionProbePaused &&
      options.freshPermissionProbe === true &&
      passivePermissionProbeSupported &&
      daemon.running &&
      cuaMcpSessions.size === 0 &&
      // CLI-only 安装(无 app bundle)时自愈的 `open` 必然失败:停了就拉不回来,
      // 宁可保留运行中的 daemon(此时读不到 AX 撤销)也不能让「重新检查」这种
      // 看似只读的动作变成破坏性操作(review P2)。
      Boolean(getComputerDriverAppBundlePath())
    ) {
      await runDriver(['stop'], STATUS_TIMEOUT_MS).catch((err: unknown) => {
        logger.warn('failed to stop cua-driver daemon for fresh permission probe', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
      daemon = await readDaemonStatus().catch((err) => ({
        running: false,
        message: err instanceof Error ? err.message : String(err),
        pid: null,
      }));
    }
    // daemon 掉线时的自愈:仅设置面板的显式探测路径(forcePermissionProbe)触发,
    // 拉起成功后按新 daemon 继续走权限探测,失败维持 unknown 现状(节流 30s;
    // fresh 探测刚主动停掉 daemon,豁免节流立即拉起)。
    if (
      process.platform === 'darwin' &&
      !computerDriverPermissionProbePaused &&
      !daemon.running &&
      passivePermissionProbeSupported &&
      (options.forcePermissionProbe === true || options.freshPermissionProbe === true)
    ) {
      const revived = await tryAutostartCuaDaemon({
        ignoreThrottle: options.freshPermissionProbe === true,
      });
      if (revived) daemon = revived;
    }
    const doctor = options.includeDoctor
      ? await readDriverJsonCommand(['doctor', '--json'], DOCTOR_TIMEOUT_MS).catch((err) => ({
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        }))
      : undefined;
    // 在采集权限证据(探测/缓存判读)之前捕获当前 grant 流程身份:下方
    // 「granted → 收割 grant 子进程」只允许作用于证据采集开始时就在途的那一代
    // 流程,防止过期探测误杀采集期间新启动的 grant(见 stopPermissionGrantFlow)。
    const grantFlowAtProbeStart = permissionGrantInFlight;
    const shouldProbePermissions =
      process.platform === 'darwin' &&
      !computerDriverPermissionProbePaused &&
      options.skipPermissionProbe !== true &&
      passivePermissionProbeSupported &&
      (daemon.running || options.forcePermissionProbe === true || options.freshPermissionProbe === true);
    let permissions: unknown = null;
    let permissionProbe: 'run' | 'cached' | 'skipped' = 'skipped';
    let permissionState: ComputerDriverPermissionState;
    if (shouldProbePermissions) {
      // 弹窗抑制:上次实测已知「探测会触发系统授权弹窗」(capturable=missing)且 daemon
      // 没有重启过(pid 未变;macOS 修改屏幕录制授权必然杀掉目标进程,因此 pid 不变 ⇒
      // 授权状态不可能自愈)时,复用上次结果、不再戳 daemon。pid 变化或上次是健康态
      // (健康态的 SCK 实测是静默的)则照常现场探测,保证授权修复后状态立即回真。
      const cached = cachedPermissionProbe;
      const reuseCachedProbe =
        options.bypassPermissionProbeCache !== true &&
        // fresh(用户显式动作)永远现场实测,即使上面因会话在跑/stop 失败没重启。
        options.freshPermissionProbe !== true &&
        cached !== null &&
        cached.state.screenRecordingCapturable === 'missing' &&
        daemon.running &&
        cached.daemonPid !== null &&
        cached.daemonPid === daemon.pid;
      if (reuseCachedProbe) {
        permissions = cached.raw;
        permissionState = cached.state;
        permissionProbe = 'cached';
      } else {
        permissions = await probeDriverPermissionsOnce({
          forceNew:
            options.freshPermissionProbe === true || options.bypassPermissionProbeCache === true,
        });
        permissionState = normalizePermissionState(permissions);
        permissionProbe = 'run';
        // 只缓存「daemon 在跑且拿到确定结论」的探测。unknown(daemon 掉线 / 探测失败)
        // 本身是静默路径,无需抑制;缓存它反而会挡住 daemon 恢复后的第一手数据。
        if (daemon.running && permissionState.status !== 'unknown') {
          cachedPermissionProbe = { daemonPid: daemon.pid, raw: permissions, state: permissionState };
        } else {
          cachedPermissionProbe = null;
        }
      }
    } else {
      permissionState = computerDriverPermissionProbePaused && process.platform === 'darwin'
        ? {
            platform: 'macos',
            required: true,
            status: 'missing',
            accessibility: 'missing',
            screenRecording: 'unknown',
            screenRecordingCapturable: 'unknown',
            reason: 'Waiting for CuaDriver to be added in System Settings.',
            canGrant: true,
          }
        : normalizePermissionState(null);
    }
    // 权限已确认到位时,收割仍在傻等系统弹窗的 grant 子进程(用户可能是在系统
    // 设置里手动授的权,上游 `permissions grant` 不会自己退出)。
    if (permissionState.status === 'granted' && permissionGrantInFlight) {
      stopPermissionGrantFlow('permissions verified by status', {
        expectedFlow: grantFlowAtProbeStart,
      });
    }
    logger.debug('cua-driver status checked', {
      daemonRunning: daemon.running,
      daemonPid: daemon.pid,
      doctorProbe: options.includeDoctor ? 'run' : 'skipped',
      permissionProbe,
      permissionStatus: permissionState.status,
      accessibility: permissionState.accessibility,
      screenRecording: permissionState.screenRecording,
      screenRecordingCapturable: permissionState.screenRecordingCapturable,
      source: permissionState.source,
      reason: permissionState.reason,
    });
    return {
      installed: true,
      executablePath: resolveDriverCommand(),
      version,
      daemonRunning: daemon.running,
      daemonStatus: daemon.message,
      ...(doctor !== undefined ? { doctor } : {}),
      permissions,
      permissionState,
      installCommand: getInstallCommand(),
      docsUrl: DOCS_URL,
    };
  } catch (err) {
    return {
      installed: false,
      executablePath: null,
      version: null,
      daemonRunning: false,
      permissionState: normalizePermissionState(null),
      installCommand: getInstallCommand(),
      docsUrl: DOCS_URL,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function installComputerDriver(
  onSpawn?: (pid: number | undefined) => void,
  targetVersion?: string,
): Promise<ComputerDriverInstallResult> {
  const res = await runInstallCommand(onSpawn, targetVersion);
  const status = await getComputerDriverStatus();
  if (res.exitCode !== 0 || !status.installed) {
    throw new ComputerDriverError(
      res.stderr.trim() || res.stdout.trim() || `cua-driver installer exited ${res.exitCode}`,
    );
  }
  return {
    ok: true,
    stdout: res.stdout,
    stderr: res.stderr,
    status,
  };
}

/**
 * 从 `cua-driver --version` 的原始输出中提取 x.y.z 语义化版本号。
 * 输出形态不保证稳定(可能是 "0.5.8" 或 "cua-driver 0.5.8"),取第一个匹配。
 */
export function extractDriverSemver(raw: string | null): string | null {
  if (!raw) return null;
  const match = raw.match(/\d+\.\d+\.\d+/);
  return match ? match[0] : null;
}

/** 数值逐段比较两个 x.y.z 版本。a<b 返回负数,a>b 返回正数,相等返回 0。 */
export function compareSemver(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i += 1) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

export interface CuaDriverReleaseAsset {
  name: string;
  size: number;
}

interface CuaDriverReleaseInfo {
  version: string;
  assets: CuaDriverReleaseAsset[];
}

/** 只接受完整稳定版 tag,避免把 prerelease 后缀截断后误认成正式版本。 */
function extractCuaDriverTagVersion(tagName: string): string | null {
  if (!tagName.startsWith(CUA_DRIVER_RELEASE_TAG_PREFIX)) return null;
  const version = tagName.slice(CUA_DRIVER_RELEASE_TAG_PREFIX.length);
  return /^\d+\.\d+\.\d+$/.test(version) ? version : null;
}

/**
 * 从 GitHub releases 列表中挑出 cua-driver 的最新 release(版本号 + asset
 * 列表,后者供更新进度条换算总字节数)。上游是 monorepo,列表混着
 * agent-v* / cli-v* 等其它组件,只认 cua-driver-rs-v 前缀;按 semver 取
 * 最大而不是取第一条,避免依赖发布顺序。
 */
export function pickLatestCuaDriverRelease(
  releases: Array<{ tag_name?: unknown; assets?: unknown }>,
): CuaDriverReleaseInfo | null {
  let latest: CuaDriverReleaseInfo | null = null;
  for (const release of releases) {
    const tag = typeof release?.tag_name === 'string' ? release.tag_name : null;
    if (!tag) continue;
    const version = extractCuaDriverTagVersion(tag);
    if (!version) continue;
    if (!latest || compareSemver(version, latest.version) > 0) {
      const assets = Array.isArray(release.assets)
        ? (release.assets as Array<{ name?: unknown; size?: unknown }>)
            .filter((a) => typeof a?.name === 'string' && typeof a?.size === 'number')
            .map((a) => ({ name: a.name as string, size: a.size as number }))
        : [];
      latest = { version, assets };
    }
  }
  return latest;
}

/** 兼容旧签名:仅按 tag 列表挑最新版本号(单测与调用方沿用)。 */
export function pickLatestCuaDriverVersion(tagNames: string[]): string | null {
  return pickLatestCuaDriverRelease(tagNames.map((tag) => ({ tag_name: tag })))?.version ?? null;
}

/** 将 `os.machine()` / installer 使用的原生机器架构归一化。 */
function normalizeCuaDriverMachineArch(machineArch: string): 'x64' | 'arm64' | null {
  const normalized = machineArch.toLowerCase();
  if (normalized === 'x64' || normalized === 'x86_64' || normalized === 'amd64') return 'x64';
  if (normalized === 'arm64' || normalized === 'aarch64') return 'arm64';
  return null;
}

/**
 * 解析当前宿主架构:优先 `os.machine()`(与官方 installer 一致),Windows 上
 * Node 可能返回 `unknown`(nodejs#62232) 时回退 `PROCESSOR_ARCHITECTURE`,
 * 再回退 `process.arch`。
 */
export function resolveCuaDriverHostArch(
  platform: NodeJS.Platform = process.platform,
  machineArch: string = os.machine(),
  options?: { processArch?: string; env?: NodeJS.ProcessEnv },
): 'x64' | 'arm64' | null {
  const fromMachine = normalizeCuaDriverMachineArch(machineArch);
  if (fromMachine) return fromMachine;
  // 只有 machine 不可用(空 / Node 的 "unknown") 才回退;riscv64 这类明确不支持的值直接 null。
  const machineLabel = machineArch.trim().toLowerCase();
  const machineUsable = machineLabel.length > 0 && machineLabel !== 'unknown';
  if (machineUsable) return null;
  if (platform === 'win32') {
    const env = options?.env ?? process.env;
    const fromEnv = normalizeCuaDriverMachineArch(String(env.PROCESSOR_ARCHITECTURE ?? ''));
    if (fromEnv) return fromEnv;
  }
  return normalizeCuaDriverMachineArch(options?.processArch ?? process.arch);
}

/**
 * 返回官方安装脚本在指定平台会下载的 release asset 文件名。优先原生机器架构,
 * 避免 Windows ARM64 上 x64 仿真进程用错包;machine 未知时再按宿主探测回退。
 */
export function getCuaDriverReleaseAssetName(
  version: string,
  platform: NodeJS.Platform = process.platform,
  machineArch: string = os.machine(),
  options?: { processArch?: string; env?: NodeJS.ProcessEnv },
): string | null {
  const prefix = `cua-driver-rs-${version}`;
  if (platform === 'darwin') return `${prefix}-darwin-universal.tar.gz`;
  const arch = resolveCuaDriverHostArch(platform, machineArch, options);
  if (platform === 'linux') {
    if (arch === 'x64') return `${prefix}-linux-x86_64-binary.tar.gz`;
    if (arch === 'arm64') return `${prefix}-linux-arm64-binary.tar.gz`;
    return null;
  }
  if (platform === 'win32') {
    if (arch === 'x64') return `${prefix}-windows-x86_64.zip`;
    if (arch === 'arm64') return `${prefix}-windows-arm64.zip`;
  }
  return null;
}

/** 携带 HTTP status,供多候选探测区分可继续的上游 5xx 与应立即停止的错误。 */
class CuaDriverReleaseHttpError extends Error {
  constructor(readonly status: number, version: string) {
    super(`GitHub release API responded ${status} for cua-driver ${version}`);
    this.name = 'CuaDriverReleaseHttpError';
  }
}

/** 构造 GitHub API headers;开发环境有 token 时自动提升限额。 */
function getCuaDriverGithubHeaders(): Record<string, string> {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  return {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'xdt-maker',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

/**
 * 精确核对指定版本已经发布且包含当前平台安装器需要的 asset。404、draft
 * 或缺 asset 都表示该候选不可安装;上游会把稳定 semver tag 的 release 标成
 * GitHub prerelease,因此不使用该布尔值过滤。其它 HTTP 错误按网络故障抛出。
 */
async function fetchInstallableCuaDriverRelease(
  version: string,
  fetchImpl: typeof fetch,
  headers: Record<string, string>,
): Promise<CuaDriverReleaseInfo | null> {
  const res = await fetchImpl(
    `${CUA_DRIVER_RELEASE_BY_TAG_URL}/${CUA_DRIVER_RELEASE_TAG_PREFIX}${version}`,
    { headers, signal: AbortSignal.timeout(UPDATE_CHECK_TIMEOUT_MS) },
  );
  if (res.status === 404) {
    logger.debug('skipping cua-driver tag without a published release', { version });
    return null;
  }
  if (!res.ok) {
    throw new CuaDriverReleaseHttpError(res.status, version);
  }

  const release = (await res.json()) as {
    tag_name?: unknown;
    assets?: unknown;
    draft?: unknown;
  };
  if (release.draft === true) {
    logger.debug('skipping unpublished cua-driver release', { version });
    return null;
  }
  const parsed = pickLatestCuaDriverRelease([release]);
  const requiredAssetName = getCuaDriverReleaseAssetName(version);
  const requiredAssetUploaded =
    requiredAssetName !== null &&
    Array.isArray(release.assets) &&
    (release.assets as Array<{ name?: unknown; size?: unknown; state?: unknown }>).some(
      (asset) =>
        asset?.name === requiredAssetName &&
        asset?.state === 'uploaded' &&
        typeof asset?.size === 'number' &&
        asset.size > 0,
    );
  const installable =
    parsed?.version === version &&
    requiredAssetUploaded;
  if (!installable || !parsed) {
    logger.debug('skipping cua-driver release without an uploaded platform asset', {
      version,
      requiredAssetName,
    });
    return null;
  }
  return parsed;
}

// ── cua-driver 更新检查 / 更新执行的 main 侧状态 ──────────────────────────
// 缓存与 in-flight 都托管在 main:设置面板只是显示层,关闭/重开不丢状态。
let cachedDriverUpdateCheck: Omit<ComputerDriverUpdateCheck, 'updating'> | null = null;
let driverUpdateCheckInFlight: Promise<Omit<ComputerDriverUpdateCheck, 'updating'>> | null = null;
let driverUpdateInstallInFlight: Promise<ComputerDriverInstallResult> | null = null;
// 最新 release 的 asset 列表(name + size),供更新进度采样换算总字节数。
let cachedDriverReleaseAssets: CuaDriverReleaseAsset[] = [];
// 上次检查(成功或失败)完成时刻,SWR 后台刷新节流用。
let driverUpdateCheckLastFetchAt = 0;

/** 测试隔离用:清空更新检查缓存与 in-flight 状态。 */
export function resetComputerDriverUpdateStateForTests(): void {
  cachedDriverUpdateCheck = null;
  driverUpdateCheckInFlight = null;
  driverUpdateInstallInFlight = null;
  cachedDriverReleaseAssets = [];
  driverUpdateCheckLastFetchAt = 0;
}

/** 真正执行一次「本地版本 + 上游 releases」的检查,无缓存语义。 */
async function fetchDriverUpdateCheck(
  fetchImpl: typeof fetch,
  excludedVersions: ReadonlySet<string> = new Set(),
  knownVerifiedTarget: string | null = null,
): Promise<Omit<ComputerDriverUpdateCheck, 'updating'>> {
  let currentVersion: string | null = null;
  try {
    currentVersion = extractDriverSemver(await readDriverVersion());
  } catch {
    // 本地未安装或版本读取失败:没有比较基准,直接视为无更新。
    return { currentVersion: null, latestVersion: null, updateAvailable: false };
  }
  if (!currentVersion) {
    return { currentVersion: null, latestVersion: null, updateAvailable: false };
  }

  try {
    const headers = getCuaDriverGithubHeaders();
    // 全量 driver tag(matching-refs 按前缀过滤,常规单页拿全;分页仅防御
    // tag 数超过单页的远期情形,短页即尾页)。
    const tagNames: string[] = [];
    for (let page = 1; page <= CUA_DRIVER_REFS_MAX_PAGES; page += 1) {
      const res = await fetchImpl(
        `${CUA_DRIVER_TAG_REFS_URL}?per_page=${CUA_DRIVER_REFS_PAGE_SIZE}&page=${page}`,
        { headers, signal: AbortSignal.timeout(UPDATE_CHECK_TIMEOUT_MS) },
      );
      if (!res.ok) {
        throw new Error(`GitHub matching-refs API responded ${res.status}`);
      }
      const batch = (await res.json()) as Array<{ ref?: unknown }>;
      if (!Array.isArray(batch) || batch.length === 0) break;
      for (const entry of batch) {
        if (typeof entry?.ref === 'string' && entry.ref.startsWith('refs/tags/')) {
          tagNames.push(entry.ref.slice('refs/tags/'.length));
        }
      }
      if (batch.length < CUA_DRIVER_REFS_PAGE_SIZE) break;
    }
    const versions = [...new Set(
      tagNames
        .map(extractCuaDriverTagVersion)
        .filter((version): version is string => version !== null),
    )].sort((a, b) => compareSemver(b, a));
    const latestTagVersion = versions[0] ?? null;
    const newerCandidates = versions.filter((version) =>
      compareSemver(currentVersion, version) < 0 && !excludedVersions.has(version));

    if (newerCandidates.length === 0) {
      cachedDriverReleaseAssets = [];
      return { currentVersion, latestVersion: latestTagVersion, updateAvailable: false };
    }

    let hadTransientProbeFailure = false;
    let knownTargetProbeFailedTransiently = false;
    for (const candidateVersion of newerCandidates) {
      let release: CuaDriverReleaseInfo | null;
      try {
        release = await fetchInstallableCuaDriverRelease(candidateVersion, fetchImpl, headers);
      } catch (err) {
        if (err instanceof CuaDriverReleaseHttpError && err.status >= 500) {
          hadTransientProbeFailure = true;
          if (candidateVersion === knownVerifiedTarget) {
            knownTargetProbeFailedTransiently = true;
          }
          logger.debug('continuing cua-driver fallback after transient release API error', {
            version: candidateVersion,
            status: err.status,
          });
          continue;
        }
        throw err;
      }
      if (!release) continue;

      // 后台刷新若无法重新核实已知目标,不能用更旧候选覆盖它;首次检查仍可回退。
      if (
        knownTargetProbeFailedTransiently &&
        knownVerifiedTarget &&
        compareSemver(candidateVersion, knownVerifiedTarget) < 0
      ) {
        return { currentVersion, latestVersion: null, updateAvailable: false };
      }
      cachedDriverReleaseAssets = release.assets;
      return { currentVersion, latestVersion: candidateVersion, updateAvailable: true };
    }

    if (hadTransientProbeFailure) {
      return { currentVersion, latestVersion: null, updateAvailable: false };
    }

    // API 请求均成功但没有可安装的新版本:用当前已安装版本覆盖旧缓存。
    // 网络失败会走 catch 返回 null,commitDriverUpdateCheck 会保留已知结果。
    cachedDriverReleaseAssets = [];
    return { currentVersion, latestVersion: currentVersion, updateAvailable: false };
  } catch (err) {
    logger.debug('cua-driver update check failed (silently ignored)', {
      message: err instanceof Error ? err.message : String(err),
    });
    return { currentVersion, latestVersion: null, updateAvailable: false };
  }
}

/**
 * 网络失败(latestVersion 拿不到)时不覆盖已有的"发现新版"缓存,避免一次
 * 离线刷新把更新入口抹掉;本地 driver 都读不到版本(currentVersion null,
 * 例如被卸载)时则如实覆盖。
 */
function commitDriverUpdateCheck(
  result: Omit<ComputerDriverUpdateCheck, 'updating'>,
): void {
  if (result.latestVersion !== null || result.currentVersion === null || !cachedDriverUpdateCheck) {
    cachedDriverUpdateCheck = result;
  }
}

function startDriverUpdateCheck(fetchImpl: typeof fetch): Promise<Omit<ComputerDriverUpdateCheck, 'updating'>> {
  if (!driverUpdateCheckInFlight) {
    const knownVerifiedTarget = cachedDriverUpdateCheck?.updateAvailable
      ? cachedDriverUpdateCheck.latestVersion
      : null;
    driverUpdateCheckInFlight = fetchDriverUpdateCheck(fetchImpl, new Set(), knownVerifiedTarget)
      .then((result) => {
        commitDriverUpdateCheck(result);
        return result;
      })
      .finally(() => {
        driverUpdateCheckInFlight = null;
        driverUpdateCheckLastFetchAt = Date.now();
      });
  }
  return driverUpdateCheckInFlight;
}

/**
 * 检查 cua-driver 是否有新版本。刻意保持"安静"语义:仅在用户打开设置页
 * 时由 renderer 触发,不做启动检查、不做后台轮询;任何失败都返回
 * updateAvailable=false 而不是抛错(查询型,失败时 renderer 静默隐藏入口)。
 *
 * 缓存语义(stale-while-revalidate):有缓存时立即返回缓存——用户第二次
 * 打开面板不必等网络往返;同时后台静默刷新,结果供下次读取。更新安装
 * 进行中不发起刷新(装完缓存会被清)。fetchImpl 可注入用于测试。
 */
export async function checkComputerDriverUpdate(
  // 默认吃系统代理:api.github.com / raw.githubusercontent.com 都是境外端点。
  fetchImpl: typeof fetch = outboundFetch,
): Promise<ComputerDriverUpdateCheck> {
  const updating = driverUpdateInstallInFlight !== null;
  if (cachedDriverUpdateCheck) {
    // 后台刷新节流:面板频繁开合时不重复打 GitHub API(未鉴权限额有限)。
    const refreshDue =
      Date.now() - driverUpdateCheckLastFetchAt >= UPDATE_CHECK_REFRESH_MIN_INTERVAL_MS;
    if (!updating && refreshDue) {
      void startDriverUpdateCheck(fetchImpl);
    }
    return { ...cachedDriverUpdateCheck, updating };
  }
  const result = await startDriverUpdateCheck(fetchImpl);
  return { ...result, updating: driverUpdateInstallInFlight !== null };
}

/** 点击更新时再次核对目标;失效时排除它并回退到下一个可安装版本。 */
async function revalidateComputerDriverUpdateTarget(fetchImpl: typeof fetch): Promise<string | null> {
  const cachedTarget = cachedDriverUpdateCheck?.updateAvailable
    ? cachedDriverUpdateCheck.latestVersion
    : null;
  if (!cachedTarget) return null;

  try {
    const release = await fetchInstallableCuaDriverRelease(
      cachedTarget,
      fetchImpl,
      getCuaDriverGithubHeaders(),
    );
    if (release) {
      cachedDriverReleaseAssets = release.assets;
      return cachedTarget;
    }

    const refreshed = await fetchDriverUpdateCheck(fetchImpl, new Set([cachedTarget]));
    // 已确认 cachedTarget 不可安装,即使 fallback 刷新失败也不能保留旧入口。
    cachedDriverUpdateCheck = refreshed;
    if (!refreshed.updateAvailable) cachedDriverReleaseAssets = [];
    return refreshed.updateAvailable ? refreshed.latestVersion : null;
  } finally {
    // 安装前校验也是一次完整的上游刷新,避免面板重开后立即重复请求。
    driverUpdateCheckLastFetchAt = Date.now();
  }
}

// ── 更新下载进度采样 ──────────────────────────────────────────────────────
// 上游安装脚本用静默 curl 下载(无输出、落在随机 mktemp 目录),字节级进度
// 只能从外部观测:在安装进程组里找 curl 的命令行,取 `-o <file>` 目标文件
// stat 其大小 = 已下载字节;总字节用文件名匹配 release asset 的 size。
// Windows 无进程组/ps,不采样(renderer 退化为不定态文案)。

export interface ComputerDriverUpdateProgress {
  /** downloading = 正在下载 tarball;installing = 下载完成后的解压/落盘阶段;done = 本次更新结束(成功或失败)。 */
  phase: 'downloading' | 'installing' | 'done';
  downloadedBytes: number | null;
  totalBytes: number | null;
}

/** 从 curl 命令行里提取 `-o` 的输出文件路径(支持 -o <path> 与 -o<path>)。 */
export function extractCurlOutputPath(command: string): string | null {
  const spaced = command.match(/(?:^|\s)-o\s+("[^"]+"|\S+)/);
  const joined = command.match(/(?:^|\s)-o("[^"]+"|[^\s"]\S*)/);
  const raw = spaced?.[1] ?? joined?.[1] ?? null;
  if (!raw) return null;
  return raw.replace(/^"|"$/g, '');
}

/** 用下载目标文件名匹配 release asset,拿总字节数;匹配不到返回 null。 */
export function matchAssetSizeByFilename(
  assets: CuaDriverReleaseAsset[],
  filePath: string,
): number | null {
  const base = path.basename(filePath);
  return assets.find((a) => a.name === base)?.size ?? null;
}

const INSTALL_PROGRESS_POLL_MS = 1_000;

/**
 * 周期采样安装进程组里 curl 的下载进度并回调。返回 stop 函数。
 * 采样失败静默(进度条消失好过误报);曾观测到下载、后来 curl 消失且安装
 * 仍在进行时,上报 installing 阶段。
 */
function startInstallProgressSampler(
  rootPid: number | undefined,
  onProgress: (progress: ComputerDriverUpdateProgress) => void,
): () => void {
  if (process.platform === 'win32' || !rootPid) {
    return () => {};
  }
  let stopped = false;
  let sawDownload = false;
  let timer: NodeJS.Timeout | null = null;
  const poll = () => {
    if (stopped) return;
    const ps = spawn('ps', ['-ax', '-o', 'pgid=,command='], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    ps.stdout?.on('data', (chunk: Buffer) => {
      out += chunk.toString('utf8');
    });
    ps.once('error', () => schedule());
    ps.once('close', () => {
      if (stopped) return;
      try {
        const curlLine = out
          .split('\n')
          .map((line) => line.trim())
          .find((line) => line.startsWith(`${rootPid} `) && line.includes('curl') && line.includes('-o'));
        if (curlLine) {
          const outFile = extractCurlOutputPath(curlLine);
          if (outFile && existsSync(outFile)) {
            sawDownload = true;
            const downloadedBytes = statSync(outFile).size;
            onProgress({
              phase: 'downloading',
              downloadedBytes,
              totalBytes: matchAssetSizeByFilename(cachedDriverReleaseAssets, outFile),
            });
          }
        } else if (sawDownload) {
          onProgress({ phase: 'installing', downloadedBytes: null, totalBytes: null });
        }
      } catch {
        /* 采样失败静默 */
      }
      schedule();
    });
  };
  const schedule = () => {
    if (stopped) return;
    timer = setTimeout(poll, INSTALL_PROGRESS_POLL_MS);
    timer.unref?.();
  };
  poll();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}

/**
 * 执行 cua-driver 更新(复用官方安装脚本,装最新版覆盖旧版)。
 * in-flight 复用:更新过程托管在 main,设置面板关闭它照常跑完;面板重开
 * 后再调用本函数会 join 同一个安装 Promise,不会重复起安装进程。
 * 成功后清掉更新检查缓存(本地版本已变,旧结果作废)。
 * onProgress 只在发起安装的那次调用被采纳(进度经 IPC 广播给所有窗口,
 * join 的调用方天然共享),结束时保证发一条 phase='done'。
 * opts.joinOnly:仅 join 既有安装,绝不起新安装——renderer 的 resume 路径
 * (checkUpdate 返回 updating=true 后重挂)用它防竞态:checkUpdate resolve
 * 到 updateDriver IPC 到达之间原安装恰好完成时,无 in-flight 会误起一次
 * 全新的未 pin 安装(review P2);join-only 命空时直接返回当前状态。
 */
export async function updateComputerDriver(
  onProgress?: (progress: ComputerDriverUpdateProgress) => void,
  opts?: { joinOnly?: boolean; fetchImpl?: typeof fetch },
): Promise<ComputerDriverInstallResult> {
  if (!driverUpdateInstallInFlight && opts?.joinOnly) {
    const status = await getComputerDriverStatus();
    return { ok: true, stdout: '', stderr: '', status };
  }
  if (!driverUpdateInstallInFlight) {
    let stopSampler: () => void = () => {};
    // preflight + install 立即收进同一个 Promise,避免并发点击各起一轮安装。
    driverUpdateInstallInFlight = (async () => {
      const targetVersion = await revalidateComputerDriverUpdateTarget(opts?.fetchImpl ?? outboundFetch);
      if (!targetVersion) {
        throw new ComputerDriverError('no verified installable cua-driver update is available');
      }
      const result = await installComputerDriver((pid) => {
        if (onProgress) stopSampler = startInstallProgressSampler(pid, onProgress);
      }, targetVersion);
      const installedVersion = extractDriverSemver(result.status.version);
      if (!installedVersion || compareSemver(installedVersion, targetVersion) < 0) {
        throw new ComputerDriverError(
          `cua-driver update did not reach v${targetVersion} (installed: ${result.status.version ?? 'unknown'})`,
        );
      }
      cachedDriverUpdateCheck = null;
      cachedDriverReleaseAssets = [];
      return result;
    })().finally(() => {
      driverUpdateInstallInFlight = null;
      stopSampler();
      onProgress?.({ phase: 'done', downloadedBytes: null, totalBytes: null });
    });
  }
  return driverUpdateInstallInFlight;
}

// CuaDriver.app 图标 dataURL 缓存:安装位置与图标在一次运行内不变,取一次即可。
let cachedDriverAppIconDataUrl: string | null | undefined;

/**
 * 返回本机 CuaDriver.app 的真实图标(PNG dataURL)。授权引导弹窗用它当识别参照——
 * 用户要去系统设置的权限列表里找这个 App,给到和列表里一模一样的图标最直观。
 *
 * 实现刻意走**进程外**管线:plutil 读 Info.plist 拿 icns 文件名 → sips(macOS 自带)
 * 转成 64px PNG → 读文件转 dataURL。不用 Electron app.getFileIcon —— 该调用在
 * Chromium ThreadPool 工作线程执行原生取图,2026-07-03 在 macOS 26.5 上首次调用后
 * 主进程即 SIGTRAP 崩溃(DiagnosticReports Electron-*-161054.ips,崩溃线程正是
 * ThreadPoolForegroundWorker;符号缺失无法完全定罪,但它是当次改动唯一的新增
 * 进程内原生调用)。子进程方案再怎么失败也只是取不到图标,绝不可能带崩应用。
 * 非 macOS / 未装 app bundle / 任一步失败一律返回 null,调用方降级为通用图标。
 */
export async function getComputerDriverAppIcon(): Promise<string | null> {
  if (process.platform !== 'darwin') return null;
  if (cachedDriverAppIconDataUrl !== undefined) return cachedDriverAppIconDataUrl;
  cachedDriverAppIconDataUrl = null;
  try {
    const appPath = CUA_DRIVER_APP_BUNDLE_PATH;
    if (!existsSync(appPath)) return null;
    let iconName: string | null = null;
    const plistRes = await runProcess(
      '/usr/bin/plutil',
      ['-extract', 'CFBundleIconFile', 'raw', '-o', '-', path.join(appPath, 'Contents', 'Info.plist')],
      STATUS_TIMEOUT_MS,
    ).catch(() => null);
    if (plistRes && plistRes.exitCode === 0) iconName = plistRes.stdout.trim() || null;
    const resourcesDir = path.join(appPath, 'Contents', 'Resources');
    const icnsCandidates = [
      ...(iconName
        ? [path.join(resourcesDir, iconName.endsWith('.icns') ? iconName : `${iconName}.icns`)]
        : []),
      path.join(resourcesDir, 'AppIcon.icns'),
    ];
    const icnsPath = icnsCandidates.find((candidate) => existsSync(candidate));
    if (!icnsPath) return null;
    const outPng = path.join(app.getPath('temp'), `xdt-cua-driver-icon-${Date.now()}.png`);
    // 128px:UI 里按 40px 显示,Retina @2x/@3x 下仍然清晰;圆角遮罩由 renderer CSS
    // 负责(icns 原始画布是无圆角的方形,系统列表里的圆角是 macOS 显示时加的)。
    const sipsRes = await runProcess(
      '/usr/bin/sips',
      ['-s', 'format', 'png', '-z', '128', '128', icnsPath, '--out', outPng],
      DOCTOR_TIMEOUT_MS,
    );
    if (sipsRes.exitCode !== 0 || !existsSync(outPng)) return null;
    try {
      cachedDriverAppIconDataUrl = `data:image/png;base64,${readFileSync(outPng).toString('base64')}`;
    } finally {
      rmSync(outPng, { force: true });
    }
  } catch (err) {
    logger.debug('failed to extract CuaDriver.app icon (fallback to generic)', {
      error: err instanceof Error ? err.message : String(err),
    });
    cachedDriverAppIconDataUrl = null;
  }
  return cachedDriverAppIconDataUrl;
}

/** 测试隔离用:清空图标缓存。 */
export function resetComputerDriverAppIconCacheForTests(): void {
  cachedDriverAppIconDataUrl = undefined;
}

/**
 * 用户在授权引导弹窗点「取消」时调用:收割在途的 `permissions grant` 子进程,
 * 让原生授权流程真正停下——否则它会继续等待/驱动系统弹窗直至 210s 超时,
 * 且 15s 复用窗口内下一次点击会复用这个已被放弃的流程(review P2)。幂等。
 */
export function cancelComputerDriverPermissionGrant(): void {
  stopPermissionGrantFlow('user cancelled permission guide');
}

export async function grantComputerDriverPermissions(
  knownStatus?: ComputerDriverStatus,
): Promise<ComputerDriverPermissionGrantResult> {
  if (process.platform !== 'darwin') {
    const status = await getComputerDriverStatus();
    return {
      ok: true,
      stdout: '',
      stderr: '',
      status,
    };
  }

  // The phase-one macOS guide owns the drag/enable interaction. While it is
  // waiting for the real CuaDriver.app row, do not run upstream
  // `permissions grant`: that command would recreate the row and replace the
  // designed drag step with its own legacy onboarding.
  if (computerDriverPermissionProbePaused) {
    const status = knownStatus
      ?? await getComputerDriverStatus({ skipPermissionProbe: true });
    return {
      ok: false,
      stdout: '',
      stderr: '',
      status,
    };
  }

  // Legacy callers without the new guide retain upstream CuaDriver's grant.
  const grantFlow = startPermissionGrantFlow();
  await Promise.race([
    grantFlow.catch(() => null),
    sleep(PERMISSIONS_GRANT_SETTLE_WAIT_MS),
  ]);
  // 授权流程本就伴随系统弹窗,这里必须拿第一手状态(同时刷新弹窗抑制缓存)。
  const status = await getComputerDriverStatus({
    forcePermissionProbe: true,
    bypassPermissionProbeCache: true,
  });
  const granted = status.permissionState?.status === 'granted';
  if (granted && permissionGrantInFlight) {
    // 只收割本次调用发起/复用的那一代流程;若期间已被 stale 重启换代,新流程归新调用管。
    stopPermissionGrantFlow('permissions verified', { expectedFlow: grantFlow });
  }
  const res = lastPermissionGrantResult;
  return {
    ok: granted,
    stdout: res?.stdout ?? '',
    stderr: res?.stderr ?? lastPermissionGrantError ?? '',
    status,
  };
}

export async function callComputerDriverTool(
  name: ComputerMcpToolName,
  args: Record<string, unknown>,
  context?: ComputerMcpCallContext,
): Promise<unknown> {
  assertComputerDriverToolDispatchAvailable();
  const sessionId = readSessionIdFromContext(context);
  if (!sessionId) {
    throw new ComputerDriverError(`Computer Use tool calls require an active ${BRAND_NAME} session.`);
  }
  const sessionCloseVersion = getCuaMcpSessionCloseVersion(sessionId);
  const rawArgs = args ?? {};
  const driverInputArgs = stripLocalListWindowsArgs(name, rawArgs);
  const normalizedArgs = normalizeToolArgsForDriver(name, driverInputArgs);
  const entry = await getCuaMcpSession(sessionId);
  assertComputerDriverToolDispatchAvailable();
  const driverArgs = applyDriverSessionArgs(name, normalizedArgs, entry.driverSessionId);
  await initializeDefaultCursorStyle(name, driverArgs, entry, entry.driverSessionId);
  const timeoutMs = getCuaMcpToolTimeoutMs(name);
  try {
    const result = await callCuaMcpToolWithTypeTextChunks(entry, name, driverArgs, timeoutMs);
    return name === 'list_windows' ? enrichAndFilterListWindowsResult(result, rawArgs) : result;
  } catch (err) {
    logger.warn('cua-driver MCP tool call failed', {
      tool: name,
      sessionId,
      driverSessionId: entry.driverSessionId,
      error: err instanceof Error ? err.message : String(err),
    });
    if (shouldCleanupCuaMcpSessionAfterError(err)) {
      const cleanup = cleanupCuaMcpSessionAfterError(sessionId, entry);
      if (shouldUseCliFallbackAfterError(name, err)) {
        try {
          return await callCuaCliTool(name);
        } catch (fallbackErr) {
          logger.warn('cua-driver CLI fallback failed', {
            tool: name,
            sessionId,
            driverSessionId: entry.driverSessionId,
            error: fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr),
          });
        }
      }
      if (shouldRetryWithFreshCuaSession(name, err)) {
        await cleanup.catch(() => undefined);
        if (getCuaMcpSessionCloseVersion(sessionId) !== sessionCloseVersion) {
          throw err;
        }
        const freshEntry = await getCuaMcpSession(sessionId);
        assertComputerDriverToolDispatchAvailable();
        if (getCuaMcpSessionCloseVersion(sessionId) !== sessionCloseVersion) {
          await cleanupComputerDriverSessionInternal(sessionId, {
            resetGeneration: false,
            expectedEntry: freshEntry,
          }).catch(() => undefined);
          throw err;
        }
        const retryArgs = err instanceof ComputerDriverTypeTextRetryError
          ? {
              ...normalizedArgs,
              text: err.remainingText,
            }
          : normalizedArgs;
        const freshArgs = applyDriverSessionArgs(name, retryArgs, freshEntry.driverSessionId);
        await initializeDefaultCursorStyle(name, freshArgs, freshEntry, freshEntry.driverSessionId);
        if (getCuaMcpSessionCloseVersion(sessionId) !== sessionCloseVersion) {
          await cleanupComputerDriverSessionInternal(sessionId, {
            resetGeneration: false,
            expectedEntry: freshEntry,
          }).catch(() => undefined);
          throw err;
        }
        let retryResult: unknown;
        try {
          retryResult = await callCuaMcpToolWithTypeTextChunks(freshEntry, name, freshArgs, timeoutMs);
        } catch (retryErr) {
          if (shouldCleanupCuaMcpSessionAfterError(retryErr)) {
            await cleanupCuaMcpSessionAfterError(sessionId, freshEntry).catch(() => undefined);
          }
          return tryWindowsWin32Fallback(name, rawArgs, retryErr);
        }
        if (err instanceof ComputerDriverTypeTextRetryError) {
          const retryResultObject = objectValue(retryResult);
          const retryInserted = typeof retryResultObject?.inserted === 'number'
            ? retryResultObject.inserted
            : retryResultObject?.ok === false
              ? 0
              : Array.from(err.remainingText).length;
          const retryChars = typeof retryResultObject?.chars === 'number'
            ? retryResultObject.chars
            : retryInserted;
          return {
            ...(retryResultObject ?? {}),
            inserted: err.completedChars + retryInserted,
            chunks: err.completedChunks + (
              typeof retryResultObject?.chunks === 'number'
                ? retryResultObject.chunks
                : 1
            ),
            chars: err.completedChars + retryChars,
          };
        }
        return name === 'list_windows' ? enrichAndFilterListWindowsResult(retryResult, rawArgs) : retryResult;
      }
      void cleanup;
    }
    return tryWindowsWin32Fallback(name, rawArgs, err);
  }
}

async function cleanupComputerDriverSessionEntry(sessionId: string, entry: CuaMcpSessionEntry): Promise<void> {
  try {
    await entry.ready;
  } catch {
    // Startup failed; close below is still best-effort.
  }
  try {
    await callCuaMcpTool(
      entry,
      'end_session',
      { session: entry.driverSessionId },
      MCP_END_SESSION_TIMEOUT_MS,
    );
  } catch (err) {
    logger.warn('cua-driver MCP end_session failed', {
      sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  try {
    await entry.client.close();
  } catch (err) {
    logger.warn('cua-driver MCP client close failed', {
      sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export function cleanupComputerDriverSession(sessionId: string): Promise<void> {
  markCuaMcpSessionClosed(sessionId);
  const entry = cuaMcpSessions.get(sessionId);
  if (entry) {
    rotateDriverSessionId(sessionId, entry.driverSessionId);
  }
  return cleanupComputerDriverSessionInternal(sessionId, { resetGeneration: false });
}

function cleanupComputerDriverSessionInternal(
  sessionId: string,
  options: { resetGeneration: boolean; expectedEntry?: CuaMcpSessionEntry },
): Promise<void> {
  if (options.resetGeneration) {
    cuaDriverSessionGenerations.delete(sessionId);
  }
  const entry = cuaMcpSessions.get(sessionId);
  if (!entry) return Promise.resolve();
  if (options.expectedEntry && entry !== options.expectedEntry) {
    return Promise.resolve();
  }
  cuaMcpSessions.delete(sessionId);
  const cleanup = cleanupComputerDriverSessionEntry(sessionId, entry)
    .finally(() => {
      if (cuaMcpSessionCleanups.get(sessionId) === cleanup) {
        cuaMcpSessionCleanups.delete(sessionId);
      }
    });
  cuaMcpSessionCleanups.set(sessionId, cleanup);
  return cleanup;
}

async function cleanupActiveComputerDriverSessions(): Promise<void> {
  const sessionIds = Array.from(cuaMcpSessions.keys());
  await Promise.allSettled(sessionIds.map((sessionId) => cleanupComputerDriverSession(sessionId)));
  await Promise.allSettled(Array.from(cuaMcpSessionCleanups.values()));
}

export async function cleanupAllComputerDriverSessions(): Promise<void> {
  stopPermissionGrantFlow('cleanup');
  clearProcessSnapshotCache();
  await cleanupActiveComputerDriverSessions();
  cuaDriverSessionGenerations.clear();
  cuaMcpSessionCloseVersions.clear();
}

export function getComputerMcpDeps(options: ComputerMcpDepsOptions = {}): ComputerMcpDeps {
  let runtimePreparation: Promise<void> | null = null;
  const ensureRuntime = async (): Promise<void> => {
    if (!options.prepareRuntimeBeforeUse) return;
    runtimePreparation ??= Promise.resolve().then(options.prepareRuntimeBeforeUse);
    await runtimePreparation;
  };
  return {
    getStatus: async () => {
      await ensureRuntime();
      return getComputerDriverStatus();
    },
    callTool: async (name, args, context) => {
      if (options.isComputerUseEnabled && !options.isComputerUseEnabled(context)) {
        throw new ComputerDriverError('Computer Use is disabled in Settings.');
      }
      await ensureRuntime();
      return callComputerDriverTool(name, args, context);
    },
    logger,
  };
}
