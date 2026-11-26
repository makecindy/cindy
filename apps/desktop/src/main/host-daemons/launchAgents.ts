/**
 * host-daemons/launchAgents —— macOS 用户级 LaunchAgents 的读取与操作。
 *
 * 只看 `~/Library/LaunchAgents/*.plist`：系统级 `/Library/LaunchAgents`、
 * `/Library/LaunchDaemons` 里的条目与「我让 Cindy 做过什么」无关（也不需要 root）。
 *
 * 定义时刻用 plist 文件 mtime，和 Windows 计划任务同一条判据。运行状态只有
 * `launchctl list` 能回答（plist 本身不记状态），一次调用返回所有已加载 job，
 * 所以按 Label 建表，扫描成本不随条目数增长。
 *
 * plist 解析走 `plutil -convert json`：不引第三方 XML 解析器，也不会被注释、
 * 二进制 plist（`plutil` 两种都能读）绊倒。
 */

import { readdir, stat, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

import type { HostDaemonState, HostDaemonTrigger } from '../../shared/hostDaemons.js';
import { runCommand, type RunCommand } from './exec.js';
import type { HostDaemonAdapter, RawHostDaemon } from './target.js';

export const LAUNCH_AGENTS_DIR = 'Library/LaunchAgents';

/** 界面上的名字与归属追溯词都用 Label（会话里建它时必然出现过这个名字）。 */
export interface LaunchAgentPlist {
  label: string;
  /** `Program` 或 `ProgramArguments[0]` + 其余参数。 */
  command: string;
  runAtLoad: boolean;
  /** 有 StartInterval / StartCalendarInterval / WatchPaths 之类的时间或事件触发。 */
  timeTriggered: boolean;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

/** plutil 输出的 JSON → 归一化字段。字段缺失都按「没有」，不让整条失效。 */
export function parseLaunchAgentPlist(json: string, fallbackLabel: string): LaunchAgentPlist | null {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(json) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object') return null;
  const label = typeof raw.Label === 'string' && raw.Label ? raw.Label : fallbackLabel;
  if (!label) return null;
  const program = typeof raw.Program === 'string' ? raw.Program : '';
  const args = asStringArray(raw.ProgramArguments);
  const command = program || args.join(' ');
  return {
    label,
    command,
    runAtLoad: raw.RunAtLoad === true,
    timeTriggered:
      raw.StartInterval !== undefined ||
      raw.StartCalendarInterval !== undefined ||
      raw.WatchPaths !== undefined,
  };
}

export function toHostDaemonTrigger(plist: LaunchAgentPlist): HostDaemonTrigger {
  if (plist.runAtLoad) return 'logon';
  if (plist.timeTriggered) return 'schedule';
  return 'other';
}

/**
 * `launchctl list` 三列：`PID\tStatus\tLabel`，未运行时 PID 是 `-`。
 * 只在 `gui/<uid>` 域里加载的用户 agent 会出现在这里。
 */
export function parseLaunchctlList(stdout: string): Map<string, { running: boolean }> {
  const jobs = new Map<string, { running: boolean }>();
  for (const line of stdout.split(/\r?\n/)) {
    const parts = line.trim().split(/\t/);
    if (parts.length < 3) continue;
    const [pid, , label] = parts;
    if (!label || label === 'Label') continue;
    jobs.set(label, { running: pid !== '-' && pid !== '' });
  }
  return jobs;
}

function stateOf(plist: LaunchAgentPlist, jobs: Map<string, { running: boolean }>): HostDaemonState {
  const job = jobs.get(plist.label);
  // 没加载也是「定义还在、下次登录会被 launchd 捡起来」，所以按 ready 展示；
  // 只有已加载且真有进程时才敢说 running。
  if (!job) return 'ready';
  return job.running ? 'running' : 'ready';
}

function guiDomain(): string {
  return `gui/${process.getuid?.() ?? 0}`;
}

async function scanJobs(): Promise<Map<string, { running: boolean }>> {
  const { stdout, failed } = await runCommand('launchctl', ['list']);
  return failed ? new Map() : parseLaunchctlList(stdout);
}

export interface LaunchAgentsAdapterDeps {
  dir?: string;
  exec?: RunCommand;
  /** 删定义时用；默认走 fs.unlink。 */
  removeFile?: (path: string) => Promise<void>;
}

export function createLaunchAgentsAdapter(deps: LaunchAgentsAdapterDeps = {}): HostDaemonAdapter {
  const exec = deps.exec ?? runCommand;
  const dir = deps.dir ?? join(homedir(), LAUNCH_AGENTS_DIR);
  const removeFile = deps.removeFile ?? ((path: string) => unlink(path));
  /** 一次扫描内记下 Label → plist 路径，动作侧要靠它删文件 / 定位未加载的 job。 */
  let seen = new Map<string, { path: string; command: string }>();

  async function plistPathFor(label: string): Promise<string> {
    const cached = seen.get(label);
    if (cached) return cached.path;
    throw new Error('launch agent is no longer present');
  }

  return {
    idPrefix: 'launch-agent:',

    async scan() {
      const jobs = await scanJobs();
      let names: string[];
      try {
        names = await readdir(dir);
      } catch {
        // 目录不存在 = 这台机器上没有任何用户 agent，不是错误。
        seen = new Map();
        return [];
      }
      const next = new Map<string, { path: string; command: string }>();
      const entries: RawHostDaemon[] = [];
      for (const name of names) {
        if (!name.endsWith('.plist')) continue;
        const path = join(dir, name);
        const { stdout, failed } = await exec('plutil', ['-convert', 'json', '-o', '-', path]);
        if (failed) continue;
        const plist = parseLaunchAgentPlist(stdout, basename(name, '.plist'));
        if (!plist) continue;
        let definitionMtimeMs: number | null = null;
        try {
          definitionMtimeMs = (await stat(path)).mtimeMs;
        } catch {
          // 读不到 mtime 的条目退化成「首次扫描到它的时刻」锚点，仍可归属。
        }
        next.set(plist.label, { path, command: plist.command });
        entries.push({
          id: `launch-agent:${plist.label}`,
          name: plist.label,
          kind: 'launch-agent',
          state: stateOf(plist, jobs),
          command: plist.command || path,
          trigger: toHostDaemonTrigger(plist),
          definitionMtimeMs,
          lastRunAtMs: null,
        });
      }
      seen = next;
      return entries;
    },

    // 只结束这一次运行，不动定义：以后登录仍会被捡起来。信号名写全 `SIGTERM`，
    // launchctl 接受的名字里它是最稳的写法。
    async stop(id) {
      const label = id.slice('launch-agent:'.length);
      const { failed } = await exec('launchctl', ['kill', 'SIGTERM', `${guiDomain()}/${label}`]);
      if (failed) throw new Error('launch agent could not be stopped');
    },

    // kickstart 要求 job 已加载；没加载就先 bootstrap 进当前 gui 域（bootstrap 本身也会启动它）。
    async run(id) {
      const label = id.slice('launch-agent:'.length);
      const kicked = await exec('launchctl', ['kickstart', '-k', `${guiDomain()}/${label}`]);
      if (!kicked.failed) return;
      const path = await plistPathFor(label);
      const booted = await exec('launchctl', ['bootstrap', guiDomain(), path]);
      if (booted.failed) throw new Error('launch agent could not be started');
    },

    async remove(id) {
      const label = id.slice('launch-agent:'.length);
      const path = await plistPathFor(label);
      // 先 bootout 再删文件：删掉文件后 launchd 仍持有已加载的 job，直到注销。
      await exec('launchctl', ['bootout', `${guiDomain()}/${label}`]);
      await removeFile(path);
      seen.delete(label);
    },
  };
}
