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

/**
 * 每条任务输出一行 JSON。字段刻意保持扁平：
 *  - `mtime` = 任务定义文件（`C:\Windows\System32\Tasks\<id>`）的修改时间，是本功能
 *    判定「这条任务是什么时候被创建」的唯一可用证据（`RegistrationInfo.Date` 在
 *    schtasks 创建的任务上普遍为空）。
 *  - 非 ASCII 任务名由 ConvertTo-Json 转成 \uXXXX，因此不依赖控制台代码页。
 */
export const WINDOWS_SCHEDULED_TASK_SCAN_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
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

function buildActionScript(id: string, command: string, extraArgs: string): string | null {
  const parts = splitScheduledTaskId(id);
  if (!parts || isSystemScheduledTaskId(id)) return null;
  return [
    "$ErrorActionPreference = 'Stop'",
    'try {',
    `  ${command} -TaskName ${psQuote(parts.taskName)} -TaskPath ${psQuote(parts.taskPath)}${extraArgs}`,
    "  Write-Output 'ok'",
    '} catch {',
    '  [Console]::Error.WriteLine($_.Exception.Message)',
    '  exit 1',
    '}',
  ].join('\n');
}

/** Stop-ScheduledTask 没有 -Confirm（只结束当前实例，不改任务定义）。 */
export function buildStopScheduledTaskScript(id: string): string | null {
  return buildActionScript(id, 'Stop-ScheduledTask', '');
}

export function buildDeleteScheduledTaskScript(id: string): string | null {
  return buildActionScript(id, 'Unregister-ScheduledTask', ' -Confirm:$false');
}

/** 立即跑一次；停止之后用户要靠它把任务重新拉起来。 */
export function buildRunScheduledTaskScript(id: string): string | null {
  return buildActionScript(id, 'Start-ScheduledTask', '');
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
