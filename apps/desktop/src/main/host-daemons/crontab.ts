/**
 * host-daemons/crontab —— Linux 用户 crontab 条目的读取与删除。
 *
 * crontab 是一个纯文本文件，没有 id、没有状态、没有「这一次运行」的概念：条目要么
 * 在等下一次触发，要么处于某个瞬时进程里。所以这里的能力边界是明确的：
 *
 * - 能列出、能删（`crontab -l` / `crontab -`）。
 * - 不能停止。停一次运行得知道 crond 拉起的进程是谁，我们没有可靠的映射，
 *   宁可告诉用户「做不到」，也不提供会误杀别的进程的停止。`stoppable: false`
 *   由界面按条目能力决定按钮。
 * - 「立即运行」只做本地复现：把命令按同样的 shell 语义起一次，不经过 crond
 *   （MAILTO 之类语义差异由此说明，不假装等价）。
 *   复现的不只是命令文本：crond 起任务时的执行上下文也要复现 —— 由 crontab 里
 *   `SHELL=` 决定的 shell、`PATH=` 与自定义变量的环境赋值、HOME 工作目录、
 *   `%` 之后走 stdin 的那段输入。丢了这些，命令会跑在另一个环境里（变量为空、
 *   路径不对），界面还报「已启动」。
 *
 * 条目身份用整行的 hash：行本身就是用户 crontab 里的定义，改一行就是另一条。
 */

import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { homedir, userInfo } from 'node:os';

import { runCommand, type RunCommand } from './exec.js';
import type { HostDaemonAdapter, RawHostDaemon } from './target.js';

export interface CronEntry {
  /** 去掉首尾空白的原始行，用于改写 crontab 时精确定位。 */
  line: string;
  /** 前 5 个字段之后的命令部分。 */
  command: string;
  /** 命令里的第一个 token（去引号）作为可读名字。 */
  name: string;
  /**
   * 该条目之前生效的环境赋值。crontab 里 `NAME=value` 这样的行不是条目，
   * 而是环境变量，对它之后的每一条都生效（vixie-cron 语义）。
   */
  env: Record<string, string>;
}

const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*\s*=/;

/**
 * 日程部分的正则：vixie-cron 允许 `@reboot`/`@daily` 这类宏替代 5 个字段，
 * 其余是「5 个字段 + 空白」。用正则吃掉日程段、剩下全是命令，不能用
 * `indexOf(第几个字段)` 定位 —— 命令或日程里重复出现的 token 会把起点带偏。
 */
const MACRO_SCHEDULE = /^@\S+\s+/;
const FIVE_FIELD_SCHEDULE = /^(\S+\s+){5}/;

/** 一行 crontab → 条目；注释、空行、环境变量赋值、无效行都返回 null。 */
export function parseCronLine(raw: string): Omit<CronEntry, 'env'> | null {
  const line = raw.trim();
  if (!line || line.startsWith('#') || ENV_ASSIGNMENT.test(line)) return null;
  const schedule = line.startsWith('@') ? MACRO_SCHEDULE : FIVE_FIELD_SCHEDULE;
  if (!schedule.test(line)) return null;
  const command = line.replace(schedule, '').trim();
  if (!command) return null;
  return { line, command, name: firstName(command) };
}

/**
 * 一行 `NAME=value` → 环境赋值；不是环境赋值返回 null。
 * 值的成对引号去掉（`FOO="a b"` 与 `FOO=a b` 同义），其余原样保留。
 */
export function parseCronEnvAssignment(raw: string): { name: string; value: string } | null {
  const line = raw.trim();
  if (!line || line.startsWith('#')) return null;
  const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
  if (!match) return null;
  return { name: match[1], value: unquote(match[2].trim()) };
}

function unquote(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1);
    }
  }
  return value;
}

function firstName(command: string): string {
  const first = command.split(/\s+/)[0]?.replace(/^['"]|['"]$/g, '') ?? '';
  // 整个命令就是一个路径时，取文件名比整串更像个名字。
  const slash = first.lastIndexOf('/');
  return slash >= 0 ? first.slice(slash + 1) || first : first;
}

export function cronEntryId(line: string): string {
  const digest = createHash('sha1').update(line).digest('hex');
  return `cron-entry:${digest.slice(0, 12)}`;
}

export function parseCrontab(text: string): CronEntry[] {
  const entries: CronEntry[] = [];
  // 环境赋值对其后的所有条目生效：解析时按出现顺序累积，每个条目带上当下的快照。
  const env: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const assignment = parseCronEnvAssignment(raw);
    if (assignment) {
      env[assignment.name] = assignment.value;
      continue;
    }
    const entry = parseCronLine(raw);
    if (entry) entries.push({ ...entry, env: { ...env } });
  }
  return entries;
}

/** 删掉指定行（按 trim 后精确匹配）；返回改写后的全文与是否真的删掉了。 */
export function removeCronLine(text: string, line: string): { text: string; removed: boolean } {
  const kept: string[] = [];
  let removed = false;
  for (const raw of text.split(/\r?\n/)) {
    if (!removed && raw.trim() === line) {
      removed = true;
      continue;
    }
    kept.push(raw);
  }
  if (!removed) return { text, removed };
  // 末尾空行会被 cron 忽略，但保持原文件的换行习惯更安全。
  const body = kept.join('\n');
  return { text: body.endsWith('\n') ? body : `${body}\n`, removed };
}

/**
 * crond 对命令行的预处理结果。
 *
 * crond 在**第一个未被反斜杠转义的 `%`** 处把一行切成两段：前面那段交给 shell，
 * 后面那段走任务的标准输入（`%` 自身在输入里变成换行）。不照做的话，复现出来的
 * 命令会比 crond 真正跑的多一截 —— 用户写 `backup.sh %data`，crond 跑的是
 * `backup.sh` 且把 `data` 喂给 stdin，复现却会把 `%data` 当参数传进去。
 */
export interface CronCommand {
  /** 真正交给 shell 的命令（反斜杠转义已按 crond 的规则解开）。 */
  command: string;
  /** 走 stdin 的那段输入；没有 `%` 时为 undefined。 */
  stdin?: string;
}

/**
 * 按 crond 的规则切分命令行（Debian cron 3.0pl1 真机实测）。
 *
 * 命令部分只处理 cron 自己认的两种转义：`\%` → 字面 `%`（不再切分）、
 * `\\` → 一个反斜杠；其余反斜杠**原样留给 shell**（`\;` 仍是转义，shell 不会把
 * 它当命令分隔符）。把 `\;` 提前解成 `;` 会让「本来只打印一行」的命令多执行一条
 * ——cron 自己不会这么干，复现就更不能这么干。
 * 输入部分：`\%` → 字面 `%`，`\` 与其它字符成对保留（`\\` 仍是两个反斜杠），
 * `%` → 换行；非空且末尾没有换行时补一个换行。
 */
export function splitCronCommand(raw: string): CronCommand {
  let command = '';
  let index = 0;
  for (; index < raw.length; index += 1) {
    const char = raw[index];
    if (char === '\\') {
      const escaped = raw[index + 1];
      if (escaped === undefined) {
        command += '\\';
        break;
      }
      if (escaped === '%') {
        // `\%` → 字面 `%`，这个 `%` 不切分。
        command += '%';
        index += 1;
        continue;
      }
      if (escaped === '\\') {
        // `\\` → 一个反斜杠（cron 存下来时就已经并成一个）。
        command += '\\';
        index += 1;
        continue;
      }
      // 其它转义原样保留，交给 shell 自己解释（`\;` 仍是转义，不会变成命令分隔符）。
      command += '\\' + escaped;
      index += 1;
      continue;
    }
    if (char === '%') break;
    command += char;
  }
  // 尾部空白对 shell 没有意义，但留着会让归属匹配不上历史记录里的那条命令。
  command = command.replace(/[ \t]+$/, '');
  if (index >= raw.length) return { command };

  const rest = raw.slice(index + 1);
  let stdin = '';
  for (let i = 0; i < rest.length; i += 1) {
    const char = rest[i];
    if (char === '%') {
      stdin += '\n';
      continue;
    }
    if (char === '\\' && rest[i + 1] === '%') {
      stdin += '%';
      i += 1;
      continue;
    }
    stdin += char;
  }
  if (stdin && !stdin.endsWith('\n')) stdin += '\n';
  return { command, stdin };
}

/** 一次「立即运行」要用的执行上下文：由适配器决定，launch 只负责把它跑起来。 */
export interface CronExecution {
  /** 执行用的 shell（crond 用条目的 `SHELL=`，默认 `/bin/sh`）。 */
  shell: string;
  /** 交给 shell 的命令（已按 crond 的规则切开 `%`、解开反斜杠转义）。 */
  command: string;
  /** 生效的环境（crond 的基础环境 + 条目里的赋值）。 */
  env: Record<string, string>;
  /** 工作目录（crond 用 `$HOME`）。 */
  cwd: string;
  /** 走 stdin 的那段输入；没有 `%` 时为 undefined。 */
  stdin?: string;
}

export interface CrontabAdapterDeps {
  exec?: RunCommand;
  /** 「立即运行」的本地复现；resolve 表示进程已真正被拉起。 */
  launch?: (execution: CronExecution) => Promise<void>;
}

/** crond 起任务时的基础环境：不是 Cindy 自己的环境。 */
const CRON_BASE_PATH = '/usr/bin:/bin';

/** 起了之后留多久看退出码：立刻失败要如实报失败，长任务照旧只报「已启动」。 */
const RUN_RESULT_WINDOW_MS = 1_500;

function currentUser(): string {
  try {
    return userInfo().username;
  } catch {
    return process.env.USER ?? process.env.LOGNAME ?? '';
  }
}

/**
 * 条目的环境赋值 + crond 的基础环境 → 一次本地复现该用的执行上下文。
 *
 * crond 起任务时给的是固定环境（HOME、LOGNAME、PATH、SHELL），不是继承谁的 shell；
 * crontab 里的赋值覆盖它。带着 Cindy 进程自己的环境去跑，跑的就不是用户写的那件事。
 *
 * 基础环境按 crond 的实际行为定（Debian cron 3.0pl1 真机实测）：
 * - `SHELL` 默认 `/bin/sh`，不是用户的登录 shell；
 * - `PATH` 默认取系统 PATH（Cindy 进程继承的那份），crontab 里的 `PATH=` 覆盖它；
 * - `HOME` 默认用户家目录，工作目录就是 `$HOME`；
 * - `LOGNAME` 由 crond 强制设成真实用户名，crontab 改不动；
 * - `USER` 在 Linux 上 crond 不设（BSD/macOS 才设），crontab 里写 `USER=` 只是
 *   一个普通变量，照传即可。
 */
export function resolveCronEnvironment(env: Record<string, string>): {
  shell: string;
  env: Record<string, string>;
} {
  const user = currentUser();
  // 基础环境先建立，再让条目的赋值覆盖它；只有实测不可覆盖的变量才强制。
  const base: Record<string, string> = {
    HOME: homedir(),
    PATH: process.env.PATH || CRON_BASE_PATH,
    SHELL: '/bin/sh',
  };
  if (process.env.LANG) base.LANG = process.env.LANG;
  else if (process.env.LC_ALL) base.LC_ALL = process.env.LC_ALL;
  const merged: Record<string, string> = { ...base, ...env };
  // LOGNAME 由 crond 说了算，crontab 里的赋值覆盖不了它（实测：写 LOGNAME=zzz 无效）。
  merged.LOGNAME = user;
  // BSD/macOS 的 crond 默认给 USER；条目自己写了就以条目为准
  // （Linux 上 crond 根本不设它，条目里的 USER= 只是普通变量）。
  if (process.platform === 'darwin' && merged.USER === undefined) merged.USER = user;
  return { shell: merged.SHELL || '/bin/sh', env: merged };
}

/**
 * crond 起任务时的工作目录：就是 `$HOME`；HOME 不存在时才退回 cron 的表格目录。
 *
 * 目录检查必须异步：扫描与动作都走 IPC handler，同步 stat 会卡住主进程
 * （工程规范 §8.5）。
 */
export async function resolveCronCwd(env: Record<string, string>): Promise<string> {
  const home = homedir();
  const target = env.HOME || home;
  if (await isDirectory(target)) return target;
  const spool = '/var/spool/cron';
  if (await isDirectory(spool)) return spool;
  return home;
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * 真正起进程的那一步：把执行上下文跑起来。
 *
 * 导出是为了能在有 POSIX shell 的机器上真跑一遍（生产的唯一路径就是它），
 * 单测里那个假的 launch 只能证明参数被传对了，证明不了进程真的按那套环境起来了。
 */
export async function defaultLaunch(execution: CronExecution): Promise<void> {
  const { shell, command, env: childEnv, cwd, stdin } = execution;
  // 用条目自己的 shell 执行整条命令（crond 就是 `$SHELL -c '<命令>'`），
  // 不是把命令交给 Cindy 这边的默认 shell。
  const child = spawn(shell, ['-c', command], {
    env: childEnv,
    cwd,
    detached: true,
    // stdin 要接管道：crond 把 `%` 之后那段喂给任务的标准输入。
    stdio: [stdin === undefined ? 'ignore' : 'pipe', 'ignore', 'ignore'],
  });
  if (stdin !== undefined && child.stdin) {
    // 任务不读 stdin 就退出时，写管道会报 EOF/EPIPE：那是正常情况（这条任务本来
    // 就不收输入），不能让它变成主进程的未捕获异常。
    child.stdin.on('error', () => {});
    child.stdin.end(stdin);
  }
  // `spawn` 事件才是「内核真的接手了这个进程」；不能 spawn 就直接报错，
  // 否则界面会说「已运行」而实际什么都没起。
  await new Promise<void>((resolve, reject) => {
    child.once('spawn', () => resolve());
    child.once('error', reject);
  });
  child.unref();
  const exited = new Promise<number | null>((resolve) => {
    child.once('exit', (code) => resolve(code));
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), RUN_RESULT_WINDOW_MS);
  });
  const code = await Promise.race([exited, timedOut]);
  if (timer) clearTimeout(timer);
  // 立刻失败（命令不存在、路径不对、变量为空）要如实报失败，不能让界面显示「已启动」。
  if (code !== null && code !== 0) {
    throw new Error(`cron command exited with code ${code}`);
  }
}

export function createCrontabAdapter(deps: CrontabAdapterDeps = {}): HostDaemonAdapter {
  const exec = deps.exec ?? runCommand;
  const launch = deps.launch ?? defaultLaunch;

  /**
   * 读失败要抛出：读失败 ≠ 空表 —— 空表会让上层数以「条目都删了」，顺手清掉它们的
   * 记录（见 service.ts）。只有「成功读到」和两种固定的「本来就没有」才返回文本。
   */
  async function readCrontab(): Promise<string> {
    const result = await exec('crontab', ['-l']);
    if (!result.failed) return result.stdout;
    // 命令没启动起来 = 这台机器没装 cron：这个来源不存在，不是读失败。
    if (result.notInstalled) return '';
    // 没有 crontab 时以 1 退出，stderr 是「no crontab for <用户>」（Vixie cron 实测）。
    if (/^no crontab for \S+/m.test(result.stderr ?? '')) return '';
    throw new Error(`crontab -l failed (${result.code}): ${(result.stderr ?? '').trim()}`);
  }

  /**
   * 从一份表格文本解析出 id → 条目。
   * 扫描和每个动作都走这一处：动作侧绝不能拿「上次扫描的快照」定位条目 ——
   * 条目可能在两次扫描之间被改掉，快照会让停止/删除/立即运行作用到已经不存在
   * 或是别人重建过的行。
   */
  function entriesOf(text: string): Map<string, CronEntry> {
    const parsed = parseCrontab(text);
    const map = new Map<string, CronEntry>();
    // 同一行写两遍在 crontab 里合法（会跑两次），但两条要能被分别列出：
    // 行内容相同 → id 撞车，所以按出现序号补后缀。删哪一条都是一样的行。
    const occurrences = new Map<string, number>();
    for (const entry of parsed) {
      const base = cronEntryId(entry.line);
      const seen = occurrences.get(base) ?? 0;
      occurrences.set(base, seen + 1);
      map.set(seen > 0 ? `${base}-${seen}` : base, entry);
    }
    return map;
  }

  /**
   * crontab 只有一张整表，凡是「读全表 → 改 → 写回」的改动都在这里排队：
   * 同一进程里两个删除请求重叠时，不排队就会后写的把先删的条目写回来。
   * 跨进程的并发靠写前复读那一段兜住。
   */
  let mutationQueue: Promise<unknown> = Promise.resolve();
  function serialize<T>(task: () => Promise<T>): Promise<T> {
    const next = mutationQueue.then(task, task);
    mutationQueue = next.catch(() => undefined);
    return next;
  }

  return {
    idPrefix: 'cron-entry:',

    async scan() {
      const current = await readCrontab();
      const out: RawHostDaemon[] = [];
      for (const [id, entry] of entriesOf(current)) {
        // 归属只认「这条定义本身」：crontab 的条目没有名字，身份就是整行定义。
        // 把它当成「谁执行过同一条命令」会把用户自己写、只是恰好同名的任务算到
        // Cindy 头上（通用命令尤其容易撞名）。
        out.push({
          id,
          name: entry.name || entry.command,
          kind: 'cron-entry',
          // crontab 没有运行状态可言：条目存在就是「在等下一次」。
          state: 'ready',
          command: entry.command,
          // `@reboot` 是开机跑一次，和「等到某个时刻」不是一回事。
          trigger: entry.line.startsWith('@reboot') ? 'startup' : 'schedule',
          attributionNeedles: [entry.line],
          definitionMtimeMs: null,
          lastRunAtMs: null,
          stoppable: false,
        });
      }
      return out;
    },

    async stop() {
      throw new Error('crontab entries cannot be stopped individually');
    },

    async run(id) {
      const entry = entriesOf(await readCrontab()).get(id);
      if (!entry) throw new Error('cron entry is no longer present');
      // 连同条目当时生效的环境赋值一起执行：用另一套环境跑，跑的就不是用户写的那件事。
      // 命令按 crond 的规则切开：`%` 之后那段走 stdin，不进命令行。
      const split = splitCronCommand(entry.command);
      const context = resolveCronEnvironment(entry.env);
      await launch({
        shell: context.shell,
        command: split.command,
        env: context.env,
        cwd: await resolveCronCwd(entry.env),
        stdin: split.stdin,
      });
    },

    async remove(id) {
      return serialize(async () => {
        const current = await readCrontab();
        const entry = entriesOf(current).get(id);
        if (!entry) throw new Error('cron entry is no longer present');
        const result = removeCronLine(current, entry.line);
        if (!result.removed) throw new Error('cron entry is no longer present');
        // crontab 只有一份共享表格：整表写回会覆盖掉别人在这期间的改动。
        // 写前复读一次，表格变了就拒绝，宁可不删也不吞掉别人的条目。
        // shortcut: 复读与写回之间仍有毫秒级窗口，crontab 没有可用的锁；
        // 更严的保证要等出现真正需要时再做文件级加锁。
        if ((await readCrontab()) !== current) {
          throw new Error('crontab changed while updating; nothing was removed');
        }
        const { failed } = await exec('crontab', ['-'], { input: result.text });
        if (failed) throw new Error('crontab could not be updated');
      });
    },
  };
}
