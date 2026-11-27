/**
 * host-daemons/systemdUser —— Linux 用户级 systemd 单元的读取与操作。
 *
 * 单元文件的位置以 systemd 自己的回答为准：`systemctl --user show '*' -p Id
 * -p FragmentPath` 一次拿全部单元的真实路径，只保留落在「非发行版的持久用户目录」
 * （`$XDG_CONFIG_HOME/systemd/user`、`$XDG_DATA_HOME/systemd/user`、`/etc/systemd/user`）
 * 里的单元。真实 Ubuntu 桌面（systemd 259 实测 98 个用户单元）里这三处的分布是
 * 8 / 0 / 4：只扫配置目录会漏掉 /etc 下 snap 装的常驻项与 link 进来的单元；
 * 而发行版目录（/usr/lib、/lib）仍按既有口径排除——那是发行版装的东西，与
 * 「我让 Cindy 做过什么」无关。`show` 回答不了（老 systemd / 无会话总线）时
 * 退回按同样的目录清单列表。
 *
 * FragmentPath 为空的单元（transient / not-found）没有文件可删，与「读不到的
 * 单元文件不进清单」同一口径跳过；generator 产物（/run 下）注销即消失，也不列。
 *
 * 状态从 `systemctl --user list-units --all --plain --no-legend` 一次读全；定义
 * （ExecStart / 时间表达式）从单元文件本身读 —— 前者回答「现在在跑吗」，后者回答
 * 「删了以后怎么恢复」，两者都不需要为每个单元再起一个子进程。
 *
 * `foo.timer` 与 `foo.service` 是同一项常驻物的两半：只列 timer（schedule 语义），
 * 跳过被它拉起的 service，避免界面上出现两条几乎一样的条目。执行面按 timer 的
 * `Unit=` 认（没写才同名），删除时只连同能确认属于它、且没有别的单元在用的另一半
 * 一起删。
 *
 * 模板实例（`foo@bar.service`）的定义在模板 `foo@.service` 里：动作按模板定义核对，
 * systemd 的调用对象仍是实例名。模板是共享定义——删实例不动模板文件；但实例若有自己的
 * 同名文件（直接创建的 `foo@bar.service`），那个文件正是这次删除的对象。模板自身还有
 * 实例在跑时也删不得。
 */

import type { Dirent } from 'node:fs';
import { readdir, readFile, stat, unlink, writeFile as writeFileFsp } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';

import type { HostDaemonState, HostDaemonTrigger } from '../../shared/hostDaemons.js';
import { runCommand, type RunCommand } from './exec.js';
import type { HostDaemonAdapter, RawHostDaemon } from './target.js';

/** systemd 用户单元的持久目录，按真实优先序排列（config > /etc > 数据目录）。 */
export function userUnitDirs(): string[] {
  const config = process.env.XDG_CONFIG_HOME?.trim();
  const data = process.env.XDG_DATA_HOME?.trim();
  return [
    join(config || join(homedir(), '.config'), 'systemd', 'user'),
    join(sep, 'etc', 'systemd', 'user'),
    join(data || join(homedir(), '.local', 'share'), 'systemd', 'user'),
  ];
}

/** 只有落在持久用户目录里的单元文件才是「我让 Cindy 做过什么」的那一类。 */
function isUserUnitFile(file: string, dirs: string[]): boolean {
  const resolved = resolve(file);
  return dirs.some((dir) => resolved.startsWith(resolve(dir) + sep));
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
 * `systemctl --user show '*' -p Id -p FragmentPath` 输出 → 单元名 → 单元文件路径。
 *
 * show 的键值输出按空行分段；FragmentPath 为空（transient / not-found）的单元
 * 没有文件可删，不进表。名字里 `\x2d` 这类转义是 systemd 单元名的正文（list-units
 * 与 show 打的是同一个字符串），不解码——解码反而会把名字改错。
 */
export function parseUnitFragmentPaths(stdout: string): Map<string, string> {
  const paths = new Map<string, string>();
  let id: string | null = null;
  for (const line of stdout.split(/\r?\n/)) {
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq);
    const value = line.slice(eq + 1);
    if (key === 'Id') {
      id = value;
    } else if (key === 'FragmentPath' && id !== null) {
      if (value) paths.set(id, value);
      id = null;
    }
  }
  return paths;
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

/** 单元名是不是模板文件本身（`foo@.service`）：有 @，且 @ 与后缀之间没有实例段。 */
export function isTemplateUnit(unit: string): boolean {
  const at = unit.indexOf('@');
  const dot = unit.lastIndexOf('.');
  return at > 0 && dot > at && unit.slice(at + 1, dot) === '';
}

/** `foo@bar.service` → 模板名 `foo@.service`；不是实例（没有实例段）返回 null。 */
export function templateOf(unit: string): string | null {
  const at = unit.indexOf('@');
  const dot = unit.lastIndexOf('.');
  if (at <= 0 || dot <= at || unit.slice(at + 1, dot) === '') return null;
  return `${unit.slice(0, at + 1)}${unit.slice(dot)}`;
}

/** `foo@bar.service` 是不是模板 `foo@.service` 的实例：前缀、后缀一致且实例段非空。 */
export function isTemplateInstanceOf(name: string, template: string): boolean {
  const at = template.indexOf('@');
  const dot = template.lastIndexOf('.');
  if (at <= 0 || dot <= at) return false;
  const prefix = template.slice(0, at + 1);
  const suffix = template.slice(dot);
  return (
    name.startsWith(prefix) && name.endsWith(suffix) && name.length > prefix.length + suffix.length
  );
}

export interface SystemdUserAdapterDeps {
  /** 单元目录候选，按真实优先序；默认 `userUnitDirs()`。测试注入临时目录。 */
  dirs?: string[];
  exec?: RunCommand;
  removeFile?: (path: string) => Promise<void>;
  /** 部分删除失败时的补偿恢复（把执行面原样写回）；默认 fs/promises。 */
  writeFile?: (path: string, text: string) => Promise<void>;
  reload?: () => Promise<void>;
}

export function createSystemdUserAdapter(deps: SystemdUserAdapterDeps = {}): HostDaemonAdapter {
  const exec = deps.exec ?? runCommand;
  const dirs = deps.dirs ?? userUnitDirs();
  const removeFile = deps.removeFile ?? ((path: string) => unlink(path));
  // Recovery must never overwrite a file created by another process after deletion.
  const writeFile = deps.writeFile ?? ((file: string, text: string) => writeFileFsp(file, text, { flag: 'wx' }));
  const reload = deps.reload ?? (async () => {
    const { failed } = await exec('systemctl', ['--user', 'daemon-reload']);
    // 失败意味着 systemd 仍持有内存单元：此时删文件会留下「文件没了、进程还在」。
    if (failed) throw new Error('systemd could not reload units');
  });
  /**
   * 动作时刻重新读单元文件：`Unit=`、文件还在不在、在哪个目录，都以当下为准。
   * 用上次扫描留下的快照，扫描到动作之间被改过的条目就会照旧关系去停 / 删别的单元。
   * 模板实例（`foo@bar.service`）没有同名文件：定义在模板 `foo@.service` 里
   * （show 给实例的 FragmentPath 就是模板文件，与扫描口径一致），动作按模板定义
   * 核对，systemd 的调用对象仍是实例名。
   */
  /**
   * 单元**自己**的文件路径：只看同名文件，不回退到模板。
   *
   * 删除动作只能用这个口径。读定义可以回退到模板（模板实例没有同名文件，定义就在模板
   * 里），删除不行——回退过去的路径是共享定义，删它等于删掉别的实例的执行面。
   */
  async function ownUnitFilePath(unit: string): Promise<string | null> {
    // 目录互不重叠，同名先到先得就是 systemd 自己的加载结果（优先序见 userUnitDirs）。
    for (const dir of dirs) {
      const candidate = join(dir, unit);
      if (await exists(candidate)) return candidate;
    }
    return null;
  }

  async function unitFilePath(unit: string): Promise<string | null> {
    const own = await ownUnitFilePath(unit);
    if (own) return own;
    const template = templateOf(unit);
    if (template !== null) {
      for (const dir of dirs) {
        const candidate = join(dir, template);
        if (await exists(candidate)) return candidate;
      }
    }
    return null;
  }

  async function readUnit(unit: string): Promise<SystemdUnitFile | null> {
    const file = await unitFilePath(unit);
    if (!file) return null;
    try {
      return parseSystemdUnitFile(await readFile(file, 'utf8'));
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
   * 文件。timer / path / socket 不写 `Unit=` 时对同名执行面有默认配对（`backup.path`
   * 照样启动 `backup.service`），只看显式引用会把它漏掉。目录读不了、单元文件读不了时
   * 都按「有人用」处理 —— 判断不了就不删。
   *
   * shortcut: 只看这几个持久用户目录，看不到别处 link 进来的单元和系统级单元，若要支持再改为问 systemd 的反向依赖
   */
  async function sharedByOthers(target: string, self: string): Promise<boolean> {
    for (const dir of dirs) {
      let entries: Dirent[];
      try {
        entries = await readdir(dir, { recursive: true, withFileTypes: true });
      } catch (error) {
        // 目录不存在只是「这里没有单元」；读不了才是判断不了，按有人用处理。
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return true;
        continue;
      }
      for (const entry of entries) {
        const path = join(entry.parentPath, entry.name);
        if (path === join(dir, self) || path === join(dir, target)) continue;
        if (/[.](wants|requires)$/.test(entry.parentPath) && entry.name === target) return true;
        const isUnitFile =
          entry.parentPath === dir && entry.name.includes('.') && !NON_UNIT_SUFFIX.test(entry.name);
        const isDropIn = entry.parentPath.endsWith('.d') && entry.name.endsWith('.conf');
        if (!isUnitFile && !isDropIn) continue;
        // 文件读不了 = 判断不了它是否引用执行面：按有人用处理，不删（fail closed）。
        const text = await readFile(path, 'utf8').catch(() => null);
        if (text === null) return true;
        if (unitTextDependsOn(text, target)) return true;
        // timer / path / socket 与执行面同名且没写 `Unit=`：默认配对就是它在用。
        const activationStem = entry.name.replace(/\.(timer|path|socket)$/, '');
        if (
          activationStem !== entry.name &&
          activationStem === stem(target) &&
          !/^\s*Unit\s*=/m.test(text)
        ) {
          return true;
        }
      }
    }
    return false;
  }

  /** 一次子进程拿全部单元的真实定义路径；show 回答不了就返回 null（目录列表兜底）。 */
  async function unitFragmentPaths(): Promise<Map<string, string> | null> {
    const { stdout, failed } = await exec('systemctl', ['--user', 'show', '*', '-p', 'Id', '-p', 'FragmentPath']);
    if (failed) return null;
    return parseUnitFragmentPaths(stdout);
  }

  return {
    idPrefix: 'systemd-user:',

    async scan() {
      const runtime = await listUnits();
      const parsed = new Map<string, SystemdUnitFile>();
      // 本次扫描读到的单元名 → 文件路径，只用于这一次扫描内的 mtime 锚点。
      const paths = new Map<string, string>();
      // 已被 show 条目占用的定义文件：模板实例（Id=实例名）与模板文件指向同一份
      // 定义，目录再扫到它时不重复列。
      const usedPaths = new Set<string>();
      // show 与目录并读：show 只看得到 systemd 已加载的单元，刚写入还没 reload 的
      // 文件只有目录里才有；show 回答不了时目录就是唯一来源（模板实例以模板名出现）。
      const fragments = await unitFragmentPaths();
      if (fragments !== null) {
        for (const [unit, path] of fragments) {
          if (!unit.endsWith('.service') && !unit.endsWith('.timer')) continue;
          if (!isUserUnitFile(path, dirs)) continue;
          try {
            parsed.set(unit, parseSystemdUnitFile(await readFile(path, 'utf8')));
            paths.set(unit, path);
            usedPaths.add(path);
          } catch {
            // 读不到的单元文件不进清单：连「删了以后怎么恢复」都答不上来。
          }
        }
      }
      for (const dir of dirs) {
        let names: string[];
        try {
          names = await readdir(dir);
        } catch (error) {
          // 目录不存在 = 这里没有单元，不是错误；其余读失败不能当成空目录。
          if ((error as NodeJS.ErrnoException | undefined)?.code !== 'ENOENT') throw error;
          continue;
        }
        for (const name of names) {
          if (parsed.has(name)) continue;
          if (!name.endsWith('.service') && !name.endsWith('.timer')) continue;
          const path = join(dir, name);
          if (usedPaths.has(path)) continue;
          try {
            parsed.set(name, parseSystemdUnitFile(await readFile(path, 'utf8')));
            paths.set(name, path);
          } catch {
            // 读不到的单元文件不进清单：连「删了以后怎么恢复」都答不上来。
          }
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
          definitionMtimeMs = (await stat(paths.get(unit)!)).mtimeMs;
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
      // 模板（foo@.service）是共享定义：还有实例在跑时删模板会把它们一并带走。
      // 实例的停用与删除走各自的条目（只停用，不动模板文件），先拒绝删模板。
      if (isTemplateUnit(unit)) {
        const runtime = await listUnits();
        const hasInstances =
          runtime !== null && [...runtime.keys()].some((name) => isTemplateInstanceOf(name, unit));
        if (hasInstances) throw new Error('systemd template unit still has loaded instances');
      }
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
      // 模板实例不一定只有模板里的定义：直接创建的 `foo@bar.service` 可以有自己的文件。
      // 共享的模板文件不能跟着这次删除一起删（别的实例、乃至从未加载过的实例名都可能用它）；
      // 实例自己的文件正是这次删除的对象——只停用不删会留下残档，而服务层随后清掉归属
      // 并报告成功，页面上再也找不回这个条目。
      // 因此删除一律按「同名文件」找：模板实例没有同名文件时什么都不删，模板原样留着。
      // 执行面先删、条目自己的文件最后删：中途失败时条目还列在清单里、还带着归属，能重试。
      // 反过来先删 timer，就会留下一个没有归属记录、从页面上再也删不掉的 service。
      const pairedPath = await ownUnitFilePath(target);
      const ownExecution =
        unit.endsWith('.timer') && isOwnCounterpart(unit, declaredUnit) && pairedPath !== null;
      if (ownExecution && !(await sharedByOthers(target, unit))) {
        // If the original cannot be saved, leave both definitions intact.
        const pairedText = await readFile(pairedPath, 'utf8');
        await removeFile(pairedPath);
        // 自己的文件删失败时把执行面原样写回：timer 的 command 仍来自配对服务的
        // ExecStart，归属不丢，下次扫描还能带着归属重试。留着半删状态反而会让
        // command 退化成时间表达式，原会话再也认不出这个条目。写回后无需再
        // reload——reload 发生在删除之前，systemd 内存里本来就还持有这个单元。
        const ownPath = await ownUnitFilePath(unit);
        if (ownPath) {
          try {
            await removeFile(ownPath);
          } catch (error) {
            try {
              await writeFile(pairedPath, pairedText);
            } catch (restoreError) {
              throw new AggregateError([error, restoreError], 'systemd unit removal failed and the service could not be restored');
            }
            throw error;
          }
        }
      } else {
        // 文件已经不在了（扫描后被别的东西删掉）时目标状态已达成，不需要再报一次错。
        const ownPath = await ownUnitFilePath(unit);
        if (ownPath) await removeFile(ownPath);
      }
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
