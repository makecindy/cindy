/**
 * host-daemons/scheduledTasks —— Windows 计划任务的读取与操作。
 *
 * 只取 `\Microsoft\*` 之外的条目：系统自带任务（约 260 条）与「我让 Cindy 做过
 * 什么」无关，全量列出来只会把真正的条目淹掉。本机实测这一层剩 20 余条。
 *
 * PowerShell 通过 `process-monitor/windowsProcessScanWorker` 的一次性 worker 执行
 * （`workerData.script` 注入），沿用既有边界：子进程管道异常只让本次扫描降级，
 * 不会变成 Electron main 的 uncaughtException。
 */

import { runWindowsScriptWorker } from '../process-monitor/windowsProcessScanWorkerClient.js';
import type { HostDaemonState, HostDaemonTrigger } from '../../shared/hostDaemons.js';
import type { HostDaemonAdapter, RawHostDaemon } from './target.js';

/**
 * 每条任务输出一行 JSON。字段刻意保持扁平：
 *  - `mtime` = 任务定义文件（`C:\Windows\System32\Tasks\<id>`）的修改时间，是本功能
 *    判定「这条任务是什么时候被创建」的唯一可用证据（`RegistrationInfo.Date` 在
 *    schtasks 创建的任务上普遍为空）。
 *  - 非 ASCII 任务名不依赖控制台代码页：worker 按 UTF-8 读输出，脚本显式把
 *    `[Console]::OutputEncoding` 设为 UTF-8（沿用 processIdentity.ts 的做法），
 *    否则中文任务名在非 UTF-8 代码页的机器上会读成乱码，无法匹配历史工具消息。
 */
export const WINDOWS_SCHEDULED_TASK_SCAN_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false);',
  "$root = Join-Path $env:SystemRoot 'System32\\Tasks'",
  "Get-ScheduledTask | Where-Object { $_.TaskPath -notlike '\\Microsoft\\*' } | ForEach-Object {",
  '  $task = $_',
  '  $action = @($task.Actions) | Select-Object -First 1',
  '  $info = $null',
  '  try { $info = Get-ScheduledTaskInfo -TaskName $task.TaskName -TaskPath $task.TaskPath } catch {}',
  '  $id = $task.TaskPath + $task.TaskName',
  '  $mtime = 0',
  `  try { $mtime = [long]([DateTimeOffset](Get-Item -LiteralPath (Join-Path $root ($id.TrimStart('\\'))) -ErrorAction Stop).LastWriteTimeUtc).ToUnixTimeMilliseconds() } catch {}`,
  '  $last = 0',
  '  if ($info -and $info.LastRunTime -and $info.LastRunTime.Year -gt 1990) { $last = [long]([DateTimeOffset]$info.LastRunTime.ToUniversalTime()).ToUnixTimeMilliseconds() }',
  '  $triggers = (@($task.Triggers) | ForEach-Object { $_.CimClass.CimClassName }) -join ","',
  '  [ordered]@{',
  '    id = $id',
  '    name = $task.TaskName',
  '    state = [string]$task.State',
  "    exec = [string]$action.Execute",
  "    args = [string]$action.Arguments",
  '    triggers = $triggers',
  '    last = $last',
  '    mtime = $mtime',
  '  } | ConvertTo-Json -Compress',
  '}',
].join('\n');

export interface RawScheduledTask {
  /** `\airlink-autopm` / `\folder\name`。 */
  id: string;
  name: string;
  /** Windows 的 `Ready` / `Running` / `Disabled` 原值。 */
  state: string;
  exec: string;
  args: string;
  triggers: string;
  lastRunAtMs: number | null;
  /** 任务定义文件修改时间；0 = 读不到（无权限 / 非标准路径）。 */
  definitionMtimeMs: number | null;
}

function toPositiveMs(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

/** 解析扫描输出。坏行直接丢弃：一条任务读失败不该让整张清单消失。 */
export function parseScheduledTaskScan(stdout: string): RawScheduledTask[] {
  const tasks: RawScheduledTask[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    const id = typeof raw.id === 'string' ? raw.id : '';
    const name = typeof raw.name === 'string' ? raw.name : '';
    if (!id.startsWith('\\') || !name) continue;
    tasks.push({
      id,
      name,
      state: typeof raw.state === 'string' ? raw.state : '',
      exec: typeof raw.exec === 'string' ? raw.exec : '',
      args: typeof raw.args === 'string' ? raw.args : '',
      triggers: typeof raw.triggers === 'string' ? raw.triggers : '',
      lastRunAtMs: toPositiveMs(raw.last),
      definitionMtimeMs: toPositiveMs(raw.mtime),
    });
  }
  return tasks;
}

/** 系统自带任务（`\Microsoft\...`）永不可操作。 */
export function isSystemScheduledTaskId(id: string): boolean {
  return id.toLowerCase().startsWith('\\microsoft\\');
}

/** `\folder\name` → { taskPath: '\folder\', taskName: 'name' }。 */
export function splitScheduledTaskId(id: string): { taskPath: string; taskName: string } | null {
  if (!id.startsWith('\\') || id.length < 2) return null;
  const index = id.lastIndexOf('\\');
  const taskName = id.slice(index + 1);
  if (!taskName) return null;
  return { taskPath: id.slice(0, index + 1), taskName };
}

function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function buildActionScript(id: string, statements: ((target: string) => string)[]): string | null {
  const parts = splitScheduledTaskId(id);
  if (!parts || isSystemScheduledTaskId(id)) return null;
  const target = `-TaskName ${psQuote(parts.taskName)} -TaskPath ${psQuote(parts.taskPath)}`;
  return [
    "$ErrorActionPreference = 'Stop'",
    'try {',
    ...statements.map((statement) => `  ${statement(target)}`),
    "  Write-Output 'ok'",
    '} catch {',
    '  [Console]::Error.WriteLine($_.Exception.Message)',
    '  exit 1',
    '}',
  ].join('\n');
}

/** Stop-ScheduledTask 没有 -Confirm（只结束当前实例，不改任务定义）。 */
export function buildStopScheduledTaskScript(id: string): string | null {
  return buildActionScript(id, [(target) => `Stop-ScheduledTask ${target}`]);
}

/**
 * 先结束正在跑的实例再注销：Unregister 只删定义，不会带走运行中的进程；不先停，
 * 就会留下「页面说删了、进程还在跑、下次扫描也找不到它」的残留。
 * 任务已经不在时 Get-ScheduledTask 报错中止，不会把「没删成」报成成功。
 */
export function buildDeleteScheduledTaskScript(id: string): string | null {
  return buildActionScript(id, [
    (target) => `if ((Get-ScheduledTask ${target}).State -eq 'Running') { Stop-ScheduledTask ${target} }`,
    (target) => `Unregister-ScheduledTask ${target} -Confirm:$false`,
  ]);
}

/** 立即跑一次；停止之后用户要靠它把任务重新拉起来。 */
export function buildRunScheduledTaskScript(id: string): string | null {
  // 交给 Task Scheduler 执行：动作里的程序、参数与「起始于」目录都按任务定义走，
  // 不在这里复现一遍（复现就会丢掉任务的执行上下文）。
  return buildActionScript(id, [(target) => `Start-ScheduledTask ${target}`]);
}

export async function scanScheduledTasks(): Promise<RawScheduledTask[]> {
  if (process.platform !== 'win32') return [];
  const stdout = await runWindowsScriptWorker(WINDOWS_SCHEDULED_TASK_SCAN_SCRIPT, {
    timeoutMs: 20_000,
  });
  return parseScheduledTaskScan(stdout);
}

/** 停止一次运行（不动任务定义）。调用方必须先做归属校验。 */
export async function stopScheduledTask(id: string): Promise<void> {
  const script = buildStopScheduledTaskScript(id);
  if (!script) throw new Error('scheduled task id is not stoppable');
  await runWindowsScriptWorker(script, { timeoutMs: 15_000 });
}

/** 从这台电脑删除任务。调用方必须先做归属校验。 */
export async function deleteScheduledTask(id: string): Promise<void> {
  const script = buildDeleteScheduledTaskScript(id);
  if (!script) throw new Error('scheduled task id is not deletable');
  await runWindowsScriptWorker(script, { timeoutMs: 15_000 });
}

/** 立即运行一次。调用方必须先做归属校验。 */
export async function runScheduledTask(id: string): Promise<void> {
  const script = buildRunScheduledTaskScript(id);
  if (!script) throw new Error('scheduled task id is not runnable');
  await runWindowsScriptWorker(script, { timeoutMs: 15_000 });
}

/** Windows 的 `Ready` / `Running` / `Disabled` 三个原值之外都当读不到。 */
export function toHostDaemonState(raw: string): HostDaemonState {
  switch (raw.toLowerCase()) {
    case 'running':
      return 'running';
    case 'disabled':
      return 'disabled';
    case 'ready':
      return 'ready';
    default:
      return 'unknown';
  }
}

/**
 * 触发器折成界面上的四档：`BootTrigger` 才是开机，`LogonTrigger` 是登录。
 * 其余（时间／每日／每周／闲置／注册时）一律算「按计划」。
 */
export function toHostDaemonTrigger(triggers: string): HostDaemonTrigger {
  const classes = triggers.toLowerCase();
  if (classes.includes('msft_taskboottrigger')) return 'startup';
  if (classes.includes('msft_tasklogontrigger')) return 'logon';
  if (classes.includes('msft_task')) return 'schedule';
  return 'other';
}

/** 扫描结果 → 编排层用的归一化条目。 */
export function toRawHostDaemon(task: RawScheduledTask): RawHostDaemon {
  const command = `${task.exec} ${task.args}`.trim();
  return {
    id: task.id,
    name: task.name,
    kind: 'scheduled-task',
    state: toHostDaemonState(task.state),
    command,
    // 归属追溯词得是「实际被执行的东西」：历史里存的是命令行，
    // 任务名一般不出现在命令行里，只拿任务名匹配几乎永远不命中。
    attributionNeedles: [command, task.name],
    trigger: toHostDaemonTrigger(task.triggers),
    definitionMtimeMs: task.definitionMtimeMs,
    lastRunAtMs: task.lastRunAtMs,
  };
}

/**
 * Windows 上唯一的来源。id 就是任务路径（`\airlink-autopm`），所以前缀是反斜杠；
 * 系统任务（`\Microsoft\...`）在扫描阶段已被排除，动作侧还会再挡一次。
 */
export const windowsScheduledTaskAdapter: HostDaemonAdapter = {
  idPrefix: '\\',
  async scan() {
    return (await scanScheduledTasks()).map(toRawHostDaemon);
  },
  stop: stopScheduledTask,
  run: runScheduledTask,
  remove: deleteScheduledTask,
};
