/**
 * Claude Code 用户可手动调用的 slash command 识别。
 *
 * 为什么需要这个判断：环境说明（`[客户端说明]`、`[消息来源]` 等）按设计排在用户消息前面，但引擎的原生命令必须留在消息**最开头**。说明一旦插到前面，`/<command>` 就不再被引擎当命令解析，整段变成普通文本发给模型。用户自己装的 Skill 尤其吃亏：带 `disable-model-invocation: true` 的 Skill 只禁模型调用、不禁用户手输，模型看不到它，就完全不执行（#11637）。
 *
 * 名单怎么来（这决定了会不会误伤）：
 *  - 用 Claude Code 本地 customization 的**全集**：commands + skills 都算。`/` 菜单是渲染
 *    视图（只含 enabled 的、且经过扁平化），模型可用技能列表是另一份子集 —— 两者都不能当
 *    "用户能手动敲出来的命令全名"。
 *  - 名字取目录名 / 文件名（Claude Code 的 slash 命名空间按这个建），同时把 frontmatter 里
 *    的 `name` 也收进来：两者不一致时，真实命令名是哪个都能命中。
 *  - `disable-model-invocation: true` 的 Skill 照样算：它只禁模型调用，不禁用户手输。
 *
 * 目录口径：全局目录必须与当前会话一致。默认是 `~/.claude`（或显式
 * `CLAUDE_CONFIG_DIR`）；绑定独立 Claude 订阅账号时，只读启动时登记的账号配置目录。
 * 不把默认目录或其它账号目录合并进来，否则别处的同名命令会把「未安装」误判成「已安装」。
 *
 * 不做的事：不把所有 `/` 开头的文本都放行。宽匹配会把 `/compactness`、`/Users/x` 这类
 * 普通输入误判成命令（#7907 已经在这条路上翻过车）。判定必须落在"确实存在这个名字的
 * 命令"上。
 *
 * 工程约束（docs/dev-rules/engineering-conventions.md）：
 *  - §8.5 发送是 IPC 热路径 → 这里只用异步 fs，不用 `fs.*Sync`。
 *  - §8.4 缓存必须有界 → 容量上限 + TTL，插入时淘汰最旧条目。
 */

import { promises as fsp, type Dirent } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { getSessionSubscriptionAccount } from '../subscription-accounts/session.js';
import { singleTextContent } from './mobileClientPromptNote';

/** 命令名提取：只认消息**最开头**的 `/<name>`。 */
export function extractSlashCommandName(text: string): string | null {
  if (!text.startsWith('/')) return null;
  const match = /^\/(\S+)/.exec(text);
  if (!match) return null;
  const token = match[1];
  // `/Users/name` 这类路径不是命令。
  if (token.includes('/')) return null;
  return token.toLowerCase();
}

const EMPTY_NAMES: ReadonlySet<string> = new Set<string>();

const CACHE_TTL_MS = 30_000;
/** §8.4：条目上限。超过后淘汰最旧的一条，不让 Map 长期无上限增长。 */
const CACHE_MAX_ENTRIES = 16;
/** frontmatter 只在文件头，读够解析出 name 就停，不整篇读进内存。 */
const FRONTMATTER_HEAD_BYTES = 2048;
type CommandRoster = { commands: Set<string>; skills: Map<string, Set<string>> };
type CacheEntry = { at: number; roster: CommandRoster };
const cache = new Map<string, CacheEntry>();

function readCache(key: string): CacheEntry | undefined {
  const entry = cache.get(key);
  if (!entry) return undefined;
  if (Date.now() - entry.at >= CACHE_TTL_MS) {
    cache.delete(key);
    return undefined;
  }
  return entry;
}

function writeCache(key: string, roster: CommandRoster): void {
  // 插入前先清掉过期条目，再按容量淘汰最旧的一条。
  for (const [existingKey, existing] of cache) {
    if (Date.now() - existing.at >= CACHE_TTL_MS) cache.delete(existingKey);
  }
  while (cache.size >= CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    cache.delete(oldest.value);
  }
  cache.set(key, { at: Date.now(), roster });
}

async function readEntries(dir: string): Promise<Dirent[]> {
  try {
    return await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fsp.stat(target);
    return true;
  } catch {
    return false;
  }
}

async function readHead(file: string): Promise<string> {
  let handle: Awaited<ReturnType<typeof fsp.open>> | undefined;
  try {
    handle = await fsp.open(file, 'r');
    const buffer = Buffer.alloc(FRONTMATTER_HEAD_BYTES);
    const { bytesRead } = await handle.read({
      buffer,
      offset: 0,
      length: FRONTMATTER_HEAD_BYTES,
      position: 0,
    });
    return buffer.subarray(0, bytesRead).toString('utf8');
  } catch {
    return '';
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/** frontmatter 里的 `name:`（只认文件头那一段）。 */
function frontmatterName(head: string): string | null {
  if (!head.startsWith('---')) return null;
  const end = head.indexOf('\n---', 3);
  const block = end === -1 ? head : head.slice(0, end);
  const match = /^name:\s*["']?([^"'\n]+)["']?\s*$/m.exec(block);
  return match ? match[1].trim() : null;
}

async function addSkillNames(skillsRoot: string, depth: number, out: CommandRoster['skills']): Promise<void> {
  for (const entry of await readEntries(skillsRoot)) {
    if (entry.name.startsWith('.') || /\.bak\.\d+$/.test(entry.name)) continue;
    const full = path.join(skillsRoot, entry.name);
    let skillFile: string | null = null;
    for (const candidate of ['SKILL.md', 'skill.md']) {
      if (await pathExists(path.join(full, candidate))) {
        skillFile = path.join(full, candidate);
        break;
      }
    }
    if (skillFile) {
      const declared = frontmatterName(await readHead(skillFile));
      for (const alias of [entry.name.toLowerCase(), declared?.toLowerCase()]) {
        if (!alias) continue;
        const directories = out.get(alias) ?? new Set<string>();
        directories.add(entry.name);
        out.set(alias, directories);
      }
      continue;
    }
    // Direct linked Skills are supported. Descend only into real namespace directories.
    if (depth < 2 && entry.isDirectory() && (await fsp.lstat(full).catch(() => null))?.isDirectory()) {
      await addSkillNames(full, depth + 1, out);
    }
  }
}

async function addCommandNames(commandsRoot: string, out: Set<string>): Promise<void> {
  for (const entry of await readEntries(commandsRoot)) {
    if (entry.name.startsWith('.') || /\.bak\.\d+$/.test(entry.name)) continue;
    if (!entry.name.endsWith('.md')) continue;
    out.add(path.basename(entry.name, '.md').toLowerCase());
  }
}

/** 未登记独立账号时，与 CLI 一样：显式环境目录替代默认目录，而不是与其合并。 */
function resolveGlobalConfigDir(configDir?: string): string {
  return path.resolve(
    configDir?.trim() || process.env.CLAUDE_CONFIG_DIR?.trim() || path.join(os.homedir(), '.claude'),
  );
}

/** 项目目录：引擎自己的发现会一路走到 git 根，这里同样向上找。 */
async function resolveProjectDirs(workingDir: string): Promise<string[]> {
  const dirs: string[] = [];
  let current = workingDir;
  while (true) {
    dirs.push(current);
    if (await pathExists(path.join(current, '.git'))) break;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return dirs;
}

async function scanCommandNames(workingDir: string, configDir: string): Promise<CommandRoster> {
  const roster: CommandRoster = { commands: new Set(), skills: new Map() };
  await addSkillNames(path.join(configDir, 'skills'), 1, roster.skills);
  await addCommandNames(path.join(configDir, 'commands'), roster.commands);
  for (const projectDir of await resolveProjectDirs(workingDir)) {
    const claudeDir = path.join(projectDir, '.claude');
    await addSkillNames(path.join(claudeDir, 'skills'), 1, roster.skills);
    await addCommandNames(path.join(claudeDir, 'commands'), roster.commands);
  }
  return roster;
}

/**
 * 解析当前工作目录下的 Claude Code 用户可调用命令名集合（小写）。
 *
 * `messageText` 是这一轮用户消息的正文：不是命令开头就直接返回空集合，不扫盘。
 * 扫不动（目录不存在 / 读失败）同样按"没有可调用命令"处理 —— 保持旧行为，而不是
 * 猜一个名字放行。
 */
async function readClaudeCommandRoster(
  workingDir: string | undefined,
  messageText: string | null,
  configDir?: string,
): Promise<CommandRoster | undefined> {
  if (!workingDir || !path.isAbsolute(workingDir)) return undefined;
  if (!messageText || !extractSlashCommandName(messageText)) return undefined;

  // 与引擎的发现入口一致：先解引用，再从真实子目录向上找 Git 根。
  // 词法 path.resolve 会误读软链外侧的 .claude，并漏掉真实仓库里的命令。
  let resolvedWorkingDir: string;
  try {
    resolvedWorkingDir = await fsp.realpath(path.resolve(workingDir));
  } catch {
    return undefined;
  }
  const resolvedConfigDir = resolveGlobalConfigDir(configDir);
  // §8.4：同一项目在不同 Claude 账号下是不同命令集合，配置目录必须进入缓存键。
  const key = `${resolvedWorkingDir}\0${resolvedConfigDir}`;
  let roster = readCache(key)?.roster;
  if (!roster) {
    roster = await scanCommandNames(resolvedWorkingDir, resolvedConfigDir).catch(() => ({
      commands: new Set<string>(), skills: new Map<string, Set<string>>(),
    }));
    writeCache(key, roster);
  }
  return roster;
}

export async function resolveClaudeUserInvocableCommandNames(
  workingDir: string | undefined,
  messageText: string | null,
  configDir?: string,
): Promise<ReadonlySet<string>> {
  const roster = await readClaudeCommandRoster(workingDir, messageText, configDir);
  return roster ? new Set([...roster.commands, ...roster.skills.keys()]) : EMPTY_NAMES;
}

export function resetClaudeUserInvocableCommandCache(): void {
  cache.clear();
}

/**
 * 这一轮的用户消息是不是"当前会话可手动调用的 Claude Code 命令"。
 *
 * 供发送链在补环境说明前判断：命中就不补说明，让命令原样留在消息最前面。
 *
 * 远端（SSH）会话的技能装在远端机上，本机扫不到 → 按"不是命令"处理，保持旧行为，
 * 不猜名字放行。
 */
export async function isUserInvocableClaudeCommand(
  message: unknown,
  session: { id?: string | null; agentKind?: string | null; workDir?: string | null; remoteHostId?: string | null;
    getDisabledClaudeSkillNames?(): ReadonlySet<string> | undefined },
): Promise<boolean> {
  if (session.agentKind !== 'claude-code') return false;
  if (session.remoteHostId) return false;
  const text = singleTextContent(message);
  const name = text && extractSlashCommandName(text);
  if (!name) return false;
  const configDir = getSessionSubscriptionAccount(session.id)?.configDir;
  const roster = await readClaudeCommandRoster(session.workDir ?? undefined, text, configDir);
  if (!roster) return false;
  const disabledSkills = session.getDisabledClaudeSkillNames?.();
  // Claude also applies an off override to a legacy command with the same name.
  if (disabledSkills?.has(name)) return false;
  if (roster.commands.has(name)) return true;
  // Launch settings use directory names. Keep per-session state out of the discovery cache.
  for (const directory of roster.skills.get(name) ?? []) {
    if (!disabledSkills?.has(directory)) return true;
  }
  return false;
}
