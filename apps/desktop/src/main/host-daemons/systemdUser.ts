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
 * `Unit=` 认（没写才同名），删除时只连同能确认属于它、且没有别的单元在用的另一半
 * 一起删。
 */

import type { Dirent } from 'node:fs';
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
/** `Unit=` 的值可以不带后缀；执行面一律补成 `.service`。 */
function serviceOf(name: string): string {
  return name.endsWith('.service') ? name : `${name}.service`;
}

export function pairedUnit(unit: string, declaredUnit = ''): string {
  if (!unit.endsWith('.timer')) return unit;
  return declaredUnit ? serviceOf(declaredUnit) : `${stem(unit)}.service`;
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

/** 不是单元文件的目录项：drop-in、enable 建立的依赖目录、编辑器残留。 */
const NON_UNIT_SUFFIX = /\.(d|wants|requires|conf)$/;

/** `systemctl stop` 对「单元未加载」的退出码；文件在的单元即使没跑过也返回 0。 */
const EXIT_NOT_LOADED = 5;

/**
 * 单元文件是否依赖某个执行面：timer / path / socket 用 `Unit=` 指名它，或把它列进
 * 依赖（`Requires=` / `Wants=` …，值可以省略 `.service` 后缀）。
 */
export function unitTextDependsOn(text: string, target: string): boolean {
  // 续行先接回同一行，否则 `Wants=a b \` + 下一行的 `backup.service` 会被漏掉。
  for (const line of text.replace(/\\\r?\n\s*/g, ' ').split(/\r?\n/)) {
    const match =
      /^\s*(?:Unit|Wants|Requires|Requisite|BindsTo|Upholds|Also)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    if (match[1].trim().split(/\s+/).some((value) => serviceOf(value) === target)) return true;
  }
  return false;
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
  /**
   * 动作时刻重新读单元文件：`Unit=`、文件还在不在，都以当下为准。
   * 用上次扫描留下的快照，扫描到动作之间被改过的条目就会照旧关系去停 / 删别的单元。
   */
  async function readUnit(unit: string): Promise<SystemdUnitFile | null> {
    try {
      return parseSystemdUnitFile(await readFile(join(dir, unit), 'utf8'));
    } catch {
      return null;
    }
  }

  async function requireUnit(unit: string): Promise<SystemdUnitFile> {
    const file = await readUnit(unit);
    if (!file) throw new Error('systemd unit is no longer present');
    return file;
  }

  /**
   * 停执行面。返回码 5 = 单元未加载（systemd 259 实测，如 timer 指向的 service 文件早已被删）：
   * 没有实例在跑，等于已经停了。其余非 0 才是真失败，必须中断后面的删除。
   */
  async function stopUnit(name: string): Promise<void> {
    const { failed, code } = await exec('systemctl', ['--user', 'stop', name]);
    if (failed && code !== EXIT_NOT_LOADED) throw new Error('systemd unit could not be stopped');
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

  /**
   * 执行面是否还有别的单元在用：别的 timer / path / socket 用 `Unit=` 指名它，被列进
   * 别的单元的依赖，或被 `enable` 挂进了某个 target 的 wants / requires。
   *
   * 同名不等于独有。`foo.timer` 的默认执行面 `foo.service` 可以同时是 `bar.timer`
   * （`Unit=foo.service`）的执行面：删 `foo.timer` 时把它一起删，就删掉了别人还在用的
   * 文件。目录读不了时按「有人用」处理 —— 判断不了就不删。
   *
   * shortcut: 只看这个用户级目录，看不到别处 link 进来的单元和系统级单元，若要支持再改为问 systemd 的反向依赖
   */
  async function sharedByOthers(target: string, self: string): Promise<boolean> {
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { recursive: true, withFileTypes: true });
    } catch {
      return true;
    }
    for (const entry of entries) {
      const path = join(entry.parentPath, entry.name);
      if (path === join(dir, self) || path === join(dir, target)) continue;
      if (/[.](wants|requires)$/.test(entry.parentPath) && entry.name === target) return true;
      const isUnitFile =
        entry.parentPath === dir && entry.name.includes('.') && !NON_UNIT_SUFFIX.test(entry.name);
      const isDropIn = entry.parentPath.endsWith('.d') && entry.name.endsWith('.conf');
      if (!isUnitFile && !isDropIn) continue;
      const text = await readFile(path, 'utf8').catch(() => null);
      if (text !== null && unitTextDependsOn(text, target)) return true;
    }
    return false;
  }

  return {
    idPrefix: 'systemd-user:',

    async scan() {
      const runtime = await listUnits();
      let names: string[];
      try {
        names = await readdir(dir);
      } catch (error) {
        // 目录不存在 = 没有任何用户单元，不是错误；其余读失败不能当成空目录。
        if ((error as NodeJS.ErrnoException | undefined)?.code !== 'ENOENT') throw error;
        return [];
      }
      const parsed = new Map<string, SystemdUnitFile>();
      for (const name of names) {
        if (!name.endsWith('.service') && !name.endsWith('.timer')) continue;
        const path = join(dir, name);
        try {
          parsed.set(name, parseSystemdUnitFile(await readFile(path, 'utf8')));
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
        const serviceFile = parsed.get(pairedUnit(unit, file.declaredUnit));
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
      return entries;
    },

    // 只结束这一次运行：停的是这个条目的执行面（`Unit=` 指名或同名），定义都还在。
    async stop(id) {
      const unit = id.slice('systemd-user:'.length);
      const { declaredUnit } = await requireUnit(unit);
      await stopUnit(pairedUnit(unit, declaredUnit));
    },

    // timer 的 start 只是「开始等下一次」，用户点「立即运行」要的是一次真实执行。
    async run(id) {
      const unit = id.slice('systemd-user:'.length);
      const { declaredUnit } = await requireUnit(unit);
      const { failed } = await exec('systemctl', ['--user', 'start', pairedUnit(unit, declaredUnit)]);
      if (failed) throw new Error('systemd unit could not be started');
    },

    async remove(id) {
      const unit = id.slice('systemd-user:'.length);
      const { declaredUnit } = await requireUnit(unit);
      const target = pairedUnit(unit, declaredUnit);
      // 先停执行面：`disable --now` 只停 timer 自己，正在跑的 service 不受影响；
      // 不先停，就会出现「页面说删了、进程还在跑、下次扫描也找不到它」。
      if (target !== unit) await stopUnit(target);
      // 再让 systemd 交还这个单元：disable 失败时它还挂着开机自启，只删文件等于什么都没做。
      const { failed } = await exec('systemctl', ['--user', 'disable', '--now', unit]);
      if (failed) throw new Error('systemd unit could not be disabled');
      // reload 必须在 unlink 之前：失败时文件还在，条目可被下次扫描重新找回，不会留下
      // 「文件已删、daemon 仍持有内存单元」的半删状态。
      await reload();
      // 执行面先删、条目自己的文件最后删：中途失败时条目还列在清单里、还带着归属，能重试。
      // 反过来先删 timer，就会留下一个没有归属记录、从页面上再也删不掉的 service。
      const pairedPath = join(dir, target);
      const ownExecution =
        unit.endsWith('.timer') && isOwnCounterpart(unit, declaredUnit) && (await exists(pairedPath));
      if (ownExecution && !(await sharedByOthers(target, unit))) await removeFile(pairedPath);
      await removeFile(join(dir, unit));
    },
  };
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
