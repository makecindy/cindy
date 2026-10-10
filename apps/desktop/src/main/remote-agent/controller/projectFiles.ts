/**
 * 同步到对方影子目录的项目说明类文件(控制端读取)。
 *
 * 只同步 Agent 启动时需要从工作目录加载的东西：项目说明(CLAUDE.md / AGENTS.md)、Skill、
 * 子代理、命令模板，以及 Claude Code 项目设置里的权限规则。不同步会在对方电脑上执行代码的
 * 配置(hooks、扩展、MCP 启动命令、环境变量)，也不同步任何项目源码。
 *
 * 另外两类(都只读你这台的文件，不执行任何东西)：
 *  - 项目上级目录里的说明文件：本机任务里 Agent 会沿目录向上加载它们；
 *  - 你这台的个人配置(用户级说明、Skill、子代理、命令与权限规则)：个人配置以你这台为准，
 *    那台电脑只提供登录、供应商与网络。
 *
 * 符号链接一律跟随，与本机 Agent 加载时一致(CLAUDE.md -> AGENTS.md、链到 dotfiles 的个人 Skill 等)。
 * 供应商分享的受邀者任务(skipCredentials)：内容会经过分享者的电脑，凭证类文件(按链接目标的真实路径
 * 再判一次)不在启动时带过去；Agent 用到时经工具回到这台读取，由受邀者在确认卡上允许
 * (docs/product-rules/provider-sharing.md §9 第 7 条)。
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { RemoteAgentKind } from '@cindy/device-link';

import { isShareCredentialPath } from '../credentials';
import {
  ANCESTOR_INSTRUCTION_FILES,
  MAX_ANCESTOR_LEVELS,
  PROJECT_INSTRUCTION_DIRECTORIES as DIRECTORIES,
  PROJECT_INSTRUCTION_FILES as TOP_LEVEL_FILES,
  PROJECT_SETTINGS_FILES as SETTINGS_FILES,
  isSafeProjectFilePath,
  type RemoteAgentWireAncestorFile,
  type RemoteAgentWireFile,
  type RemoteAgentWirePersonal,
} from '../wire';
const MAX_FILES = 512;
const MAX_FILE_BYTES = 512 * 1024;
const MAX_TOTAL_BYTES = 4 * 1024 * 1024;
const MAX_DEPTH = 6;

export interface CollectOptions {
  /** 供应商分享的受邀者任务：凭证类文件不在启动时带过去。 */
  skipCredentials?: boolean;
}

interface Budget {
  files: number;
  bytes: number;
  skipCredentials: boolean;
}

function newBudget(options: CollectOptions = {}): Budget {
  return { files: 0, bytes: 0, skipCredentials: options.skipCredentials === true };
}

/**
 * 读一个文件(跟随链接)。超出数量与大小上限、不是普通文件，或受邀者任务里的凭证类文件返回 null。
 * `sanitized`：内容随后只保留权限规则(项目设置)，不按凭证类跳过。
 */
async function readLimited(file: string, budget: Budget, sanitized = false): Promise<Buffer | null> {
  if (budget.files >= MAX_FILES) return null;
  try {
    const stat = await fs.stat(file);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES || budget.bytes + stat.size > MAX_TOTAL_BYTES) return null;
    if (budget.skipCredentials && !sanitized
      && (isShareCredentialPath(file) || isShareCredentialPath(await fs.realpath(file)))) return null;
    const data = await fs.readFile(file);
    budget.files += 1;
    budget.bytes += data.length;
    return data;
  } catch {
    return null;
  }
}

/** 目录链接不能把整个磁盘或用户目录带进来：指向文件系统根、用户目录或其上级时不走。 */
function isTooBroad(realDir: string): boolean {
  if (path.dirname(realDir) === realDir) return true;
  const home = path.resolve(os.homedir());
  const relative = path.relative(realDir, home);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function walk(
  root: string,
  relative: string,
  depth: number,
  budget: Budget,
  out: RemoteAgentWireFile[],
  rename: (relative: string) => string = (value) => value,
  ancestors: ReadonlySet<string> = new Set(),
): Promise<void> {
  if (depth > MAX_DEPTH || budget.files >= MAX_FILES) return;
  const dir = path.join(root, relative);
  let realDir: string;
  let entries: import('node:fs').Dirent[];
  try {
    realDir = await fs.realpath(dir);
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  // 链接绕回自己的上级目录会无限展开；只看这条路径上的上级，同一个目录被两个链接引用时都照常带上。
  if (ancestors.has(realDir) || isTooBroad(realDir)) return;
  const inside = new Set(ancestors).add(realDir);
  for (const entry of entries) {
    if (entry.name === '.git' || entry.name === 'node_modules') continue;
    const child = `${relative}/${entry.name}`;
    const full = path.join(root, child);
    let isDir = entry.isDirectory();
    let isFile = entry.isFile();
    if (entry.isSymbolicLink()) {
      // 链接按指向的目标处理(与本机 Agent 加载时一致)；目标不存在的跳过。
      try {
        const target = await fs.stat(full);
        isDir = target.isDirectory();
        isFile = target.isFile();
      } catch {
        continue;
      }
    }
    if (isDir) await walk(root, child, depth + 1, budget, out, rename, inside);
    else if (isFile && isSafeProjectFilePath(rename(child))) {
      const data = await readLimited(full, budget);
      if (data) out.push({ path: rename(child), data: data.toString('base64') });
    }
  }
}

/** Claude Code 项目设置只保留权限规则：hooks、环境变量、状态栏命令等会在对方电脑上执行。 */
function sanitizeClaudeSettings(raw: Buffer): Buffer | null {
  try {
    const parsed = JSON.parse(raw.toString('utf8')) as Record<string, unknown>;
    const permissions = parsed.permissions;
    if (!permissions || typeof permissions !== 'object') return null;
    return Buffer.from(JSON.stringify({ permissions }, null, 2));
  } catch {
    return null;
  }
}

export async function collectProjectInstructionFiles(
  workingDir: string,
  options: CollectOptions = {},
): Promise<RemoteAgentWireFile[]> {
  const budget = newBudget(options);
  const out: RemoteAgentWireFile[] = [];
  for (const name of TOP_LEVEL_FILES) {
    const data = await readLimited(path.join(workingDir, name), budget);
    if (data) out.push({ path: name, data: data.toString('base64') });
  }
  for (const name of SETTINGS_FILES) {
    // 项目设置只带权限规则，受邀者任务也照常同步。
    const data = await readLimited(path.join(workingDir, name), budget, true);
    const sanitized = data ? sanitizeClaudeSettings(data) : null;
    if (sanitized) out.push({ path: name, data: sanitized.toString('base64') });
  }
  for (const dir of DIRECTORIES) await walk(workingDir, dir, 0, budget, out);
  return out;
}

/**
 * 项目上级目录里的说明文件(不含文件系统根)：本机任务里 Claude Code 与 Pi 会沿目录向上加载。
 * Codex 经执行环境在你这台直接读取，不需要同步。
 */
export async function collectAncestorInstructionFiles(
  workingDir: string,
  options: CollectOptions = {},
): Promise<RemoteAgentWireAncestorFile[]> {
  const budget = newBudget(options);
  const out: RemoteAgentWireAncestorFile[] = [];
  let dir = path.resolve(workingDir);
  for (let up = 1; up <= MAX_ANCESTOR_LEVELS; up += 1) {
    const parent = path.dirname(dir);
    if (parent === dir || path.dirname(parent) === parent) break;
    dir = parent;
    for (const name of ANCESTOR_INSTRUCTION_FILES) {
      const data = await readLimited(path.join(dir, name), budget);
      if (data) out.push({ up, name, data: data.toString('base64') });
    }
  }
  return out;
}

/** 本机 Claude Code 的配置目录(与 Cindy 启动本机 Claude Code 时一致：默认 ~/.claude)。 */
export function claudeConfigDir(env: NodeJS.ProcessEnv = process.env, home = os.homedir()): string {
  return env.CLAUDE_CONFIG_DIR && path.isAbsolute(env.CLAUDE_CONFIG_DIR) ? env.CLAUDE_CONFIG_DIR : path.join(home, '.claude');
}

/** 本机 Codex 的主目录(CODEX_HOME，默认 ~/.codex)。 */
export function codexHomeDir(env: NodeJS.ProcessEnv = process.env, home = os.homedir()): string {
  return env.CODEX_HOME && path.isAbsolute(env.CODEX_HOME) ? env.CODEX_HOME : path.join(home, '.codex');
}

const PERSONAL_CLAUDE_DIRECTORIES = ['skills', 'agents', 'commands'] as const;

function permissionRules(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.length > 0) : [];
}

export interface CollectedPersonalConfig {
  personal: RemoteAgentWirePersonal;
  /** 同步过去的个人 Skill / 子代理 / 命令目录：影子目录里的相对路径 → 你这台的真实目录。 */
  roots: Array<{ relative: string; local: string }>;
}

/**
 * 你这台的个人配置。项目里已有同名的 Skill / 子代理 / 命令时以项目为准(与本机加载顺序一致)。
 */
export async function collectPersonalConfig(
  kind: RemoteAgentKind,
  projectFiles: readonly RemoteAgentWireFile[],
  options: CollectOptions & { env?: NodeJS.ProcessEnv; home?: string } = {},
): Promise<CollectedPersonalConfig> {
  const env = options.env ?? process.env;
  const home = options.home ?? os.homedir();
  const budget = newBudget(options);
  const personal: RemoteAgentWirePersonal = { files: [] };
  const roots: CollectedPersonalConfig['roots'] = [];
  if (kind === 'claude-code') {
    const configDir = claudeConfigDir(env, home);
    const memory = await readLimited(path.join(configDir, 'CLAUDE.md'), budget);
    if (memory) personal.memory = memory.toString('utf8');
    const projectEntries = new Set(projectFiles.map((file) => file.path.split('/').slice(0, 3).join('/')));
    for (const dir of PERSONAL_CLAUDE_DIRECTORIES) {
      let entries: import('node:fs').Dirent[];
      try {
        entries = await fs.readdir(path.join(configDir, dir), { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        const relative = `.claude/${dir}/${entry.name}`;
        if (projectEntries.has(relative) || !isSafeProjectFilePath(relative)) continue;
        const local = path.join(configDir, dir, entry.name);
        const before = personal.files.length;
        let stat: import('node:fs').Stats;
        try {
          stat = await fs.stat(local);
        } catch {
          continue;
        }
        if (stat.isDirectory()) {
          await walk(configDir, `${dir}/${entry.name}`, 1, budget, personal.files, (value) => `.claude/${value}`);
        } else if (stat.isFile()) {
          const data = await readLimited(local, budget);
          if (data) personal.files.push({ path: relative, data: data.toString('base64') });
        }
        if (personal.files.length > before) roots.push({ relative, local });
      }
    }
    try {
      const settings = JSON.parse(await fs.readFile(path.join(configDir, 'settings.json'), 'utf8')) as {
        permissions?: Record<string, unknown>;
      };
      const allow = permissionRules(settings.permissions?.allow);
      const deny = permissionRules(settings.permissions?.deny);
      const ask = permissionRules(settings.permissions?.ask);
      if (allow.length || deny.length || ask.length) personal.permissions = { allow, deny, ask };
    } catch {
      // 没有个人设置或格式不对：不同步。
    }
  } else if (kind === 'codex') {
    const codexHome = codexHomeDir(env, home);
    // 与 Codex 的读取顺序一致：AGENTS.override.md 优先于 AGENTS.md。
    for (const name of ['AGENTS.override.md', 'AGENTS.md']) {
      const data = await readLimited(path.join(codexHome, name), budget);
      if (data && data.toString('utf8').trim()) {
        personal.instructions = data.toString('utf8');
        break;
      }
    }
  }
  return { personal, roots };
}
