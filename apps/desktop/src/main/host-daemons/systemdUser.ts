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
 * 跳过被它拉起的 service，避免界面上出现两条几乎一样的条目。执行面按 timer 的
 * `Unit=` 认（没写才同名），删除时只连同能确认属于它的另一半一起删。
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
  /** timer 的 `Unit=` 显式指名的 service；没写就空，由 `pairedUnit` 退成同名。 */
  declaredUnit: string;
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
  let declaredUnit = '';
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
    } else if (key === 'Unit' && !declaredUnit) {
      // timer 的 [Timer] Unit= 可以指名任意 service；按同名猜会把动作作用到别的条目上。
      declaredUnit = value;
    } else if (
      !schedule &&
      (key === 'OnCalendar' || key === 'OnBootSec' || key === 'OnStartupSec' || key === 'OnUnitActiveSec')
    ) {
      schedule = `${key}=${value}`;
    }
  }
  return { execStart, description, schedule, declaredUnit };
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

/**
 * 条目真正被执行、被停止、被删掉的对象：timer 的 `Unit=` 指名优先，没写才同名。
 *
 * 按同名猜会把状态、启动、停止、删除都作用到错误对象上（timer 可以指名任意 service，
 * 同名那个可能属于另一项）。
 */
export function pairedUnit(unit: string, declaredUnit = ''): string {
  if (!unit.endsWith('.timer')) return unit;
  if (declaredUnit) return declaredUnit.endsWith('.service') ? declaredUnit : `${declaredUnit}.service`;
  return `${stem(unit)}.service`;
}

export function stateOf(
  unit: string,
  runtime: Map<string, SystemdUnitRuntime> | null,
  declaredUnit = '',
): HostDaemonState {
  // runtime 读不到（没有 systemd / dbus 断了）时不敢说它在跑，也不能说它没跑。
  if (!runtime) return 'unknown';
  // timer 自己的 active 是「等待下一次触发」；它对应的 service 在跑才算正在运行。
  const unitRuntime = runtime.get(pairedUnit(unit, declaredUnit));
  if (!unitRuntime) return 'ready';
  if (unitRuntime.active === 'inactive' || unitRuntime.active === 'failed') return 'ready';
  return unitRuntime.sub === 'running' ? 'running' : 'ready';
}

/**
 * 配对文件只有在能确认属于这个 timer 时才是它的另一半：没写 `Unit=`、或写的就是同基名。
 * 显式指名别的单元时，那个 service 可能属于别的 timer 或别的程序，跟着删就是删别人的东西。
 */
function isOwnCounterpart(unit: string, declaredUnit: string): boolean {
  return !declaredUnit || stem(declaredUnit) === stem(unit);
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
    const { failed } = await exec('systemctl', ['--user', 'daemon-reload']);
    // 失败意味着 systemd 仍持有内存单元：此时删文件会留下「文件没了、进程还在」。
    if (failed) throw new Error('systemd could not reload units');
  });
  /** 一次扫描内记下单元名 → 文件路径，动作侧靠它删文件。 */
  let paths = new Map<string, string>();
  /** 一次扫描内记下单元名 → 解析结果，动作侧靠它认准对象（不靠同名猜）。 */
  let files = new Map<string, SystemdUnitFile>();

  /** 条目的执行面：`Unit=` 优先，没写才同名。 */
  function targetOf(unit: string): string {
    return pairedUnit(unit, files.get(unit)?.declaredUnit ?? '');
  }

  async function pathFor(unit: string): Promise<string> {
    const cached = paths.get(unit);
    if (cached) return cached;
    throw new Error('systemd unit is no longer present');
  }

  async function listUnits(): Promise<Map<string, SystemdUnitRuntime> | null> {
    const { stdout, failed } = await exec('systemctl', [
      '--user',
      'list-units',
      '--type=service',
      '--type=timer',
      '--all',
      '--plain',
      '--no-legend',
    ]);
    return failed ? null : parseSystemdListUnits(stdout);
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
        files = new Map();
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
      // timer 指名的执行面（`Unit=` 优先、没写才同名）：一个 service 只能有一行。
      const timerTargets = new Set<string>();
      for (const [unit, file] of parsed) {
        if (unit.endsWith('.timer')) timerTargets.add(pairedUnit(unit, file.declaredUnit));
      }
      for (const [unit, file] of parsed) {
        // service 只是 timer 拉起来的执行面，清单里只留 timer 那一行。
        if (!unit.endsWith('.timer') && timerTargets.has(unit)) continue;
        let definitionMtimeMs: number | null = null;
        try {
          definitionMtimeMs = (await stat(join(dir, unit))).mtimeMs;
        } catch {
          // 读不到 mtime 时退化成「首次扫描到它的时刻」锚点，仍可归属。
        }
        const serviceFile = parsed.get(targetOf(unit));
        entries.push({
          id: `systemd-user:${unit}`,
          name: unit,
          kind: 'systemd-unit',
          state: stateOf(unit, runtime, file.declaredUnit),
          command: file.execStart || serviceFile?.execStart || file.schedule,
          trigger: triggerOf(file),
          attributionNeedles: [unit],
          definitionMtimeMs,
          lastRunAtMs: null,
        });
      }
      paths = next;
      files = parsed;
      return entries;
    },

    // 只结束这一次运行：停的是这个条目的执行面（`Unit=` 指名或同名），定义都还在。
    async stop(id) {
      const unit = id.slice('systemd-user:'.length);
      const { failed } = await exec('systemctl', ['--user', 'stop', targetOf(unit)]);
      if (failed) throw new Error('systemd unit could not be stopped');
    },

    // timer 的 start 只是「开始等下一次」，用户点「立即运行」要的是一次真实执行。
    async run(id) {
      const unit = id.slice('systemd-user:'.length);
      const { failed } = await exec('systemctl', ['--user', 'start', targetOf(unit)]);
      if (failed) throw new Error('systemd unit could not be started');
    },

    async remove(id) {
      const unit = id.slice('systemd-user:'.length);
      const path = await pathFor(unit);
      const target = targetOf(unit);
      const declared = files.get(unit)?.declaredUnit ?? '';
      const pairedPath =
        unit.endsWith('.timer') && isOwnCounterpart(unit, declared) ? paths.get(target) : undefined;
      // 先停执行面：`disable --now` 只停 timer 自己，正在跑的 service 不受影响；
      // 不先停，就会出现「页面说删了、进程还在跑、下次扫描也找不到它」。
      if (target !== unit) {
        const stopped = await exec('systemctl', ['--user', 'stop', target]);
        // 单元本来就没加载时 stop 也是 0，所以这里非 0 只能是真失败。
        if (stopped.failed) throw new Error('systemd unit could not be stopped');
      }
      // 再让 systemd 交还这个单元：disable 失败时它还挂着开机自启，只删文件等于什么都没做。
      const { failed } = await exec('systemctl', ['--user', 'disable', '--now', unit]);
      if (failed) throw new Error('systemd unit could not be disabled');
      // reload 必须在 unlink 之前：失败时文件还在，条目可被下次扫描重新找回，不会留下
      // 「文件已删、daemon 仍持有内存单元」的半删状态。
      await reload();
      await removeFile(path);
      // timer 与它自带的执行面是同一项常驻物的两半：只删一半会留下一个谁也不触发的残留。
      if (pairedPath) {
        await removeFile(pairedPath);
        paths.delete(target);
      }
      paths.delete(unit);
    },
  };
}
