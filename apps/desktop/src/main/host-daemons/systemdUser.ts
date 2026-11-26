/**
 * host-daemons/systemdUser —— Linux 用户级 systemd 单元的读取与操作。
 *
 * 只看用户级单元目录（`$XDG_CONFIG_HOME/systemd/user`，默认
 * `~/.config/systemd/user`）：系统单元是发行版装的东西，与「我让 Cindy 做过什么」
 * 无关，用户级才可能由会话创建。
 *
 * 状态从 `systemctl --user list-units --all --plain --no-legend` 一次读全；定义
 * （ExecStart / 时间表达式）从单元文件本身读 —— 前者回答「现在在跑吗」，后者回答
 * 「删了以后怎么恢复」，两者都不需要为每个单元再起一个子进程。
 *
 * `foo.timer` 与 `foo.service` 是同一项常驻物的两半：只列 timer（schedule 语义），
 * 跳过同名 service，避免界面上出现两条几乎一样的条目；删除时两半一起删。
 */

import { readdir, readFile, stat, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { HostDaemonState, HostDaemonTrigger } from '../../shared/hostDaemons.js';
import { runCommand, type RunCommand } from './exec.js';
import type { HostDaemonAdapter, RawHostDaemon } from './target.js';

export function userUnitDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  return join(xdg && xdg.trim() ? xdg : join(homedir(), '.config'), 'systemd', 'user');
}

export interface SystemdUnitFile {
  /** ExecStart 里的可执行文件 + 参数；`-`/`@`/`+` 这些前缀已剥掉。 */
  execStart: string;
  description: string;
  /** OnCalendar / OnBootSec / OnUnitActiveSec 之类的时间表达式，没有就是空。 */
  schedule: string;
}

/** `systemctl list-units` 里的一行：名字 + ACTIVE + SUB。 */
export interface SystemdUnitRuntime {
  active: string;
  sub: string;
}

/** 解析单元文件正文。只认第一个 ExecStart（多行 ExecStart 是罕见的高级用法）。 */
export function parseSystemdUnitFile(text: string): SystemdUnitFile {
  let execStart = '';
  let description = '';
  let schedule = '';
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith(';')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (key === 'ExecStart' && !execStart) {
      // `-` 忽略非 0 退出、`@` 传 argv[0]、`+` 提权：都是 systemd 语法前缀，不是命令。
      execStart = value.replace(/^[-@+]{1,2}/, '').trim();
    } else if (key === 'Description' && !description) {
      description = value;
    } else if (
      !schedule &&
      (key === 'OnCalendar' || key === 'OnBootSec' || key === 'OnStartupSec' || key === 'OnUnitActiveSec')
    ) {
      schedule = `${key}=${value}`;
    }
  }
  return { execStart, description, schedule };
}

/** `list-units --all --plain --no-legend` 输出 → 单元名 → 运行状态。 */
export function parseSystemdListUnits(stdout: string): Map<string, SystemdUnitRuntime> {
  const units = new Map<string, SystemdUnitRuntime>();
  for (const line of stdout.split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 4) continue;
    const [name, , active, sub] = parts;
    if (!name || !name.includes('.')) continue;
    if (active === 'ACTIVE') continue; // 表头
    units.set(name, { active, sub });
  }
  return units;
}

export function stateOf(unit: string, runtime: Map<string, SystemdUnitRuntime>): HostDaemonState {
  // timer 自己的 active 是「等待下一次触发」；它对应的 service 在跑才算正在运行。
  const key = unit.endsWith('.timer') ? `${stem(unit)}.service` : unit;
  const unitRuntime = runtime.get(key);
  if (!unitRuntime) return 'ready';
  if (unitRuntime.active === 'inactive' || unitRuntime.active === 'failed') return 'ready';
  return unitRuntime.sub === 'running' ? 'running' : 'ready';
}

function triggerOf(file: SystemdUnitFile): HostDaemonTrigger {
  if (!file.schedule) return 'other';
  return file.schedule.startsWith('OnBootSec') || file.schedule.startsWith('OnStartupSec')
    ? 'startup'
    : 'schedule';
}

/** `foo.timer` ↔ `foo.service` 是同一项常驻物的时间面与执行面。 */
function stem(unit: string): string {
  return unit.replace(/\.(service|timer)$/, '');
}

export interface SystemdUserAdapterDeps {
  dir?: string;
  exec?: RunCommand;
  removeFile?: (path: string) => Promise<void>;
  reload?: () => Promise<void>;
}

export function createSystemdUserAdapter(deps: SystemdUserAdapterDeps = {}): HostDaemonAdapter {
  const exec = deps.exec ?? runCommand;
  const dir = deps.dir ?? userUnitDir();
  const removeFile = deps.removeFile ?? ((path: string) => unlink(path));
  const reload = deps.reload ?? (async () => {
    await exec('systemctl', ['--user', 'daemon-reload']);
  });
  /** 一次扫描内记下单元名 → 文件路径，动作侧靠它删文件。 */
  let paths = new Map<string, string>();

  async function pathFor(unit: string): Promise<string> {
    const cached = paths.get(unit);
    if (cached) return cached;
    throw new Error('systemd unit is no longer present');
  }

  async function listUnits(): Promise<Map<string, SystemdUnitRuntime>> {
    const { stdout, failed } = await exec('systemctl', [
      '--user',
      'list-units',
      '--type=service',
      '--type=timer',
      '--all',
      '--plain',
      '--no-legend',
    ]);
    return failed ? new Map() : parseSystemdListUnits(stdout);
  }

  return {
    idPrefix: 'systemd-user:',

    async scan() {
      const runtime = await listUnits();
      let names: string[];
      try {
        names = await readdir(dir);
      } catch {
        paths = new Map();
        return [];
      }
      const next = new Map<string, string>();
      const parsed = new Map<string, SystemdUnitFile>();
      for (const name of names) {
        if (!name.endsWith('.service') && !name.endsWith('.timer')) continue;
        const path = join(dir, name);
        try {
          parsed.set(name, parseSystemdUnitFile(await readFile(path, 'utf8')));
          next.set(name, path);
        } catch {
          // 读不到的单元文件不进清单：连「删了以后怎么恢复」都答不上来。
        }
      }

      const entries: RawHostDaemon[] = [];
      for (const [unit, file] of parsed) {
        // 有同名 timer 时只列 timer：service 只是被它拉起来的执行面。
        if (unit.endsWith('.service') && parsed.has(`${stem(unit)}.timer`)) continue;
        let definitionMtimeMs: number | null = null;
        try {
          definitionMtimeMs = (await stat(join(dir, unit))).mtimeMs;
        } catch {
          // 读不到 mtime 时退化成「首次扫描到它的时刻」锚点，仍可归属。
        }
        const serviceFile = parsed.get(`${stem(unit)}.service`);
        entries.push({
          id: `systemd-user:${unit}`,
          name: unit,
          kind: 'systemd-unit',
          state: stateOf(unit, runtime),
          command: file.execStart || serviceFile?.execStart || file.schedule,
          trigger: triggerOf(file),
          attributionNeedles: [unit],
          definitionMtimeMs,
          lastRunAtMs: null,
        });
      }
      paths = next;
      return entries;
    },

    // 只结束这一次运行：timer 停它对应的 service，service 停自己；定义都还在。
    async stop(id) {
      const unit = id.slice('systemd-user:'.length);
      const target = unit.endsWith('.timer') ? `${stem(unit)}.service` : unit;
      const { failed } = await exec('systemctl', ['--user', 'stop', target]);
      if (failed) throw new Error('systemd unit could not be stopped');
    },

    // timer 的 start 只是「开始等下一次」，用户点「立即运行」要的是一次真实执行。
    async run(id) {
      const unit = id.slice('systemd-user:'.length);
      const target = unit.endsWith('.timer') ? `${stem(unit)}.service` : unit;
      const { failed } = await exec('systemctl', ['--user', 'start', target]);
      if (failed) throw new Error('systemd unit could not be started');
    },

    async remove(id) {
      const unit = id.slice('systemd-user:'.length);
      const path = await pathFor(unit);
      // 先停再删：删了文件 daemon 仍持有内存里的单元，disable 才会清掉开机自启。
      await exec('systemctl', ['--user', 'disable', '--now', unit]);
      await removeFile(path);
      // timer 与 service 是同一项常驻物的两半：只删 timer 会留下一个谁也不触发的 service。
      const paired = `${stem(unit)}.${unit.endsWith('.timer') ? 'service' : 'timer'}`;
      const pairedPath = paths.get(paired);
      if (pairedPath) {
        await removeFile(pairedPath);
        paths.delete(paired);
      }
      paths.delete(unit);
      await reload();
    },
  };
}
