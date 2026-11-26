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
 *   （vixie-cron 的 `%` 转义与 MAILTO 之类语义差异由此说明，不假装等价）。
 *
 * 条目身份用整行的 hash：行本身就是用户 crontab 里的定义，改一行就是另一条。
 */

import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';

import { runCommand, type RunCommand } from './exec.js';
import type { HostDaemonAdapter, RawHostDaemon } from './target.js';

export interface CronEntry {
  /** 去掉首尾空白的原始行，用于改写 crontab 时精确定位。 */
  line: string;
  /** 前 5 个字段之后的命令部分。 */
  command: string;
  /** 命令里的第一个 token（去引号）作为可读名字。 */
  name: string;
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
export function parseCronLine(raw: string): CronEntry | null {
  const line = raw.trim();
  if (!line || line.startsWith('#') || ENV_ASSIGNMENT.test(line)) return null;
  const schedule = line.startsWith('@') ? MACRO_SCHEDULE : FIVE_FIELD_SCHEDULE;
  if (!schedule.test(line)) return null;
  const command = line.replace(schedule, '').trim();
  if (!command) return null;
  return { line, command, name: firstName(command) };
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
  for (const raw of text.split(/\r?\n/)) {
    const entry = parseCronLine(raw);
    if (entry) entries.push(entry);
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

export interface CrontabAdapterDeps {
  exec?: RunCommand;
  /** 「立即运行」的本地复现；默认 detached spawn 后立刻脱离。 */
  launch?: (command: string) => void;
}

function defaultLaunch(command: string): void {
  // crond 以用户 HOME 为工作目录起任务，本地复现也用它，才不会在应用目录里跑。
  const child = spawn(command, { shell: true, detached: true, stdio: 'ignore', cwd: homedir() });
  child.unref();
}

export function createCrontabAdapter(deps: CrontabAdapterDeps = {}): HostDaemonAdapter {
  const exec = deps.exec ?? runCommand;
  const launch = deps.launch ?? defaultLaunch;
  /** 扫描时见到的 id → 条目本身，动作侧靠它定位原始行与命令。 */
  let entries = new Map<string, CronEntry>();

  async function readCrontab(): Promise<string> {
    const { stdout, failed } = await exec('crontab', ['-l']);
    // 没有 crontab 时 crontab -l 以非 0 退出且 stderr 说 no crontab；按空处理。
    return failed ? '' : stdout;
  }

  return {
    idPrefix: 'cron-entry:',

    async scan() {
      const parsed = parseCrontab(await readCrontab());
      const next = new Map<string, CronEntry>();
      // 同一行写两遍在 crontab 里合法（会跑两次），但两条要能被分别列出：
      // 行内容相同 → id 撞车，所以按出现序号补后缀。删哪一条都是一样的行。
      const occurrences = new Map<string, number>();
      const out: RawHostDaemon[] = [];
      for (const entry of parsed) {
        const base = cronEntryId(entry.line);
        const seen = occurrences.get(base) ?? 0;
        occurrences.set(base, seen + 1);
        const id = seen > 0 ? `${base}-${seen}` : base;
        next.set(id, entry);
        out.push({
          id,
          name: entry.name || entry.command,
          kind: 'cron-entry',
          // crontab 没有运行状态可言：条目存在就是「在等下一次」。
          state: 'ready',
          command: entry.command,
          trigger: 'schedule',
          attributionNeedles: [entry.command],
          definitionMtimeMs: null,
          lastRunAtMs: null,
          stoppable: false,
        });
      }
      entries = next;
      return out;
    },

    async stop() {
      throw new Error('crontab entries cannot be stopped individually');
    },

    async run(id) {
      const entry = entries.get(id);
      if (!entry) throw new Error('cron entry is no longer present');
      launch(entry.command);
    },

    async remove(id) {
      const entry = entries.get(id);
      if (!entry) throw new Error('cron entry is no longer present');
      const current = await readCrontab();
      const result = removeCronLine(current, entry.line);
      if (!result.removed) throw new Error('cron entry is no longer present');
      const { failed } = await exec('crontab', ['-'], { input: result.text });
      if (failed) throw new Error('crontab could not be updated');
      entries.delete(id);
    },
  };
}
