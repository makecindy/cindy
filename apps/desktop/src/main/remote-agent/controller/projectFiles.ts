/**
 * 同步到对方影子目录的项目说明类文件(控制端读取)。
 *
 * 只同步 Agent 启动时需要从工作目录加载的东西：项目说明(CLAUDE.md / AGENTS.md)、规则、Skill、
 * 子代理、命令模板，以及 Claude Code 项目设置里的权限规则。不同步会在对方电脑上执行代码的
 * 配置(hooks、扩展、MCP 启动命令、环境变量)，也不同步任何项目源码。
 *
 * 另外三类(都只读你这台的文件，不执行任何东西)：
 *  - 项目上级目录里的说明文件：本机任务里 Agent 会沿目录向上加载它们；
 *  - 你这台的个人配置(用户级说明、规则、Skill、子代理、命令与权限规则；Codex / Pi 的个人 Skill)：
 *    个人配置以你这台为准，那台电脑只提供登录、供应商与网络；
 *  - Claude Code 说明文件里 `@路径` 导入的文件(collectInstructionImports)。
 *
 * 额度先给入口文件(Agent 启动时自己从磁盘加载的 SKILL.md、子代理、命令、规则、提示词模板)，剩下的
 * 额度再给附属文件(脚本、参考资料等)：一个大 Skill 不会把其它 Skill 挤掉；没带过去的附属文件，
 * Agent 用到时经工具回到这台读取。
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
  type RemoteAgentWireImportFile,
  type RemoteAgentWirePersonal,
} from '../wire';
const MAX_FILES = 512;
const MAX_FILE_BYTES = 512 * 1024;
const MAX_TOTAL_BYTES = 4 * 1024 * 1024;
const MAX_DEPTH = 6;
/** 扫描时最多看这么多个文件：链接指向很大的目录时不一直扫下去。 */
const MAX_CANDIDATES = 8 * MAX_FILES;
/** `@` 导入最多嵌套这么多层(与 Claude Code 一致)。 */
const MAX_IMPORT_HOPS = 5;

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

/** 一个要扫描的目录：本机位置、在影子目录里的位置，以及是不是 Skill 目录(决定哪些是入口文件)。 */
interface ScanRoot {
  local: string;
  wire: string;
  skills: boolean;
}

/** 扫描到的待同步文件；entry = Agent 启动时自己从磁盘加载的入口文件，先占额度。 */
interface Candidate {
  path: string;
  local: string;
  entry: boolean;
}

/** Skill 目录里只有 `<名字>/SKILL.md`(以及单文件的 `<名字>.md`)是入口；其它目录里的 Markdown 都是入口。 */
function isEntry(skills: boolean, within: string): boolean {
  const parts = within.split('/');
  if (!skills) return /\.md$/i.test(parts[parts.length - 1]);
  return (parts.length === 2 && parts[1] === 'SKILL.md') || (parts.length === 1 && /\.md$/i.test(parts[0]));
}

function scanRoot(local: string, wire: string): ScanRoot {
  return { local, wire, skills: /(^|\/)skills$/.test(wire) };
}

async function scan(
  root: ScanRoot,
  within: string,
  depth: number,
  out: Candidate[],
  ancestors: ReadonlySet<string> = new Set(),
): Promise<void> {
  if (depth > MAX_DEPTH || out.length >= MAX_CANDIDATES) return;
  const dir = within ? path.join(root.local, ...within.split('/')) : root.local;
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
    if (out.length >= MAX_CANDIDATES) return;
    if (entry.name === '.git' || entry.name === 'node_modules') continue;
    const child = within ? `${within}/${entry.name}` : entry.name;
    const local = path.join(dir, entry.name);
    let isDir = entry.isDirectory();
    let isFile = entry.isFile();
    if (entry.isSymbolicLink()) {
      // 链接按指向的目标处理(与本机 Agent 加载时一致)；目标不存在的跳过。
      try {
        const target = await fs.stat(local);
        isDir = target.isDirectory();
        isFile = target.isFile();
      } catch {
        continue;
      }
    }
    if (isDir) await scan(root, child, depth + 1, out, inside);
    else if (isFile) {
      const wirePath = `${root.wire}/${child}`;
      if (isSafeProjectFilePath(wirePath)) out.push({ path: wirePath, local, entry: isEntry(root.skills, child) });
    }
  }
}

/** 先读入口文件，再用剩下的额度读附属文件。 */
async function readCandidates(candidates: readonly Candidate[], budget: Budget, out: RemoteAgentWireFile[]): Promise<void> {
  for (const entry of [true, false]) {
    for (const candidate of candidates) {
      if (candidate.entry !== entry) continue;
      const data = await readLimited(candidate.local, budget);
      if (data) out.push({ path: candidate.path, data: data.toString('base64') });
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
    const data = await readLimited(path.join(workingDir, ...name.split('/')), budget);
    if (data) out.push({ path: name, data: data.toString('base64') });
  }
  for (const name of SETTINGS_FILES) {
    // 项目设置只带权限规则，受邀者任务也照常同步。
    const data = await readLimited(path.join(workingDir, ...name.split('/')), budget, true);
    const sanitized = data ? sanitizeClaudeSettings(data) : null;
    if (sanitized) out.push({ path: name, data: sanitized.toString('base64') });
  }
  const candidates: Candidate[] = [];
  for (const dir of DIRECTORIES) await scan(scanRoot(path.join(workingDir, ...dir.split('/')), dir), '', 0, candidates);
  await readCandidates(candidates, budget, out);
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

const PERSONAL_CLAUDE_DIRECTORIES = ['skills', 'agents', 'commands', 'rules'] as const;

/**
 * Codex / Cindy 自己管理的 Skill 目录项：Codex 自带的 `.system`，Cindy 投影进 Codex 的 `xdt-*` / `cindy-*`
 * 链接。那台电脑上的 Codex 与 Cindy 自己会准备这些，不随个人配置同步。
 */
function isManagedSkillEntry(name: string): boolean {
  return name.startsWith('.') || name.startsWith('xdt-') || name.startsWith('cindy-');
}

function permissionRules(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.length > 0) : [];
}

export interface CollectedPersonalConfig {
  personal: RemoteAgentWirePersonal;
  /** 同步过去的个人 Skill / 子代理 / 命令 / 规则：影子目录里的相对路径 → 你这台的真实位置。 */
  roots: Array<{ relative: string; local: string }>;
}

/**
 * 你这台的个人配置。项目里已有同名的 Skill / 子代理 / 命令 / 规则时以项目为准(与本机加载顺序一致)。
 * Claude Code：~/.claude 里的说明、规则、Skill、子代理、命令与权限规则；Codex：个人说明与 ~/.agents/skills、
 * CODEX_HOME/skills 里的 Skill；Pi：~/.agents/skills 里的 Skill。个人 Skill 放进影子目录里 Agent 会找
 * 项目 Skill 的位置(`.claude/skills`、`.agents/skills`、`.codex/skills`)。
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
  const projectEntries = new Set(projectFiles.map((file) => file.path.split('/').slice(0, 3).join('/')));
  const candidates: Candidate[] = [];
  const entries: Array<{ relative: string; local: string }> = [];
  const addSource = async (root: ScanRoot, skipManaged: boolean) => {
    let items: import('node:fs').Dirent[];
    try {
      items = await fs.readdir(root.local, { withFileTypes: true });
    } catch {
      return;
    }
    for (const item of items) {
      if (skipManaged && isManagedSkillEntry(item.name)) continue;
      const relative = `${root.wire}/${item.name}`;
      if (projectEntries.has(relative) || !isSafeProjectFilePath(relative)) continue;
      const local = path.join(root.local, item.name);
      let stat: import('node:fs').Stats;
      try {
        stat = await fs.stat(local);
      } catch {
        continue;
      }
      if (stat.isDirectory()) await scan(root, item.name, 1, candidates);
      else if (stat.isFile()) candidates.push({ path: relative, local, entry: isEntry(root.skills, item.name) });
      else continue;
      entries.push({ relative, local });
    }
  };

  if (kind === 'claude-code') {
    const configDir = claudeConfigDir(env, home);
    const memory = await readLimited(path.join(configDir, 'CLAUDE.md'), budget);
    if (memory) personal.memory = memory.toString('utf8');
    for (const dir of PERSONAL_CLAUDE_DIRECTORIES) await addSource(scanRoot(path.join(configDir, dir), `.claude/${dir}`), false);
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
    await addSource(scanRoot(path.join(home, '.agents', 'skills'), '.agents/skills'), true);
    await addSource(scanRoot(path.join(codexHome, 'skills'), '.codex/skills'), true);
  } else if (kind === 'pi') {
    await addSource(scanRoot(path.join(home, '.agents', 'skills'), '.agents/skills'), true);
  }
  await readCandidates(candidates, budget, personal.files);
  const synced = new Set(personal.files.map((file) => file.path));
  const roots = entries.filter(({ relative }) => synced.has(relative)
    || personal.files.some((file) => file.path.startsWith(`${relative}/`)));
  return { personal, roots };
}

// ─── Claude Code 的 `@` 导入 ─────────────────────────────────────

/** 与 Claude Code 一致：`@` 前是行首、空白或左括号；代码块与行内代码里的不算。 */
const IMPORT_TOKEN = /(^|[\s(])@([^\s`'"()<>[\]{}]+)/g;

/** 逐个处理文本里代码之外的片段(代码块与行内代码原样保留)。 */
function mapOutsideCode(text: string, map: (part: string) => string): string {
  let fence: string | null = null;
  return text.split(/(\r?\n)/).map((line) => {
    if (line === '\n' || line === '\r\n') return line;
    const marker = /^\s*(```|~~~)/.exec(line)?.[1];
    if (fence) {
      if (marker === fence) fence = null;
      return line;
    }
    if (marker) {
      fence = marker;
      return line;
    }
    return line.split(/(`+[^`]*`+)/).map((part, index) => (index % 2 === 1 ? part : map(part))).join('');
  }).join('');
}

function importTokens(text: string): string[] {
  const tokens: string[] = [];
  mapOutsideCode(text, (part) => {
    for (const match of part.matchAll(IMPORT_TOKEN)) tokens.push(match[2]);
    return part;
  });
  return tokens;
}

function replaceImportTokens(text: string, replacements: ReadonlyMap<string, string>): string {
  if (!replacements.size) return text;
  return mapOutsideCode(text, (part) => part.replace(IMPORT_TOKEN, (whole, prefix: string, token: string) => {
    const next = replacements.get(token);
    return next === undefined ? whole : `${prefix}@${next}`;
  }));
}

function toPosix(value: string): string {
  return value.split(path.sep).join('/');
}

/** 两个相对位置(可带 `..`)之间的相对路径；锚在一个足够深的假根上算，不依赖当前目录。 */
function relativeBetween(fromDir: string, to: string): string {
  const anchor = `/${Array.from({ length: 64 }, () => 'a').join('/')}`;
  const relative = path.posix.relative(path.posix.join(anchor, fromDir), path.posix.join(anchor, to));
  return relative || '.';
}

type ImportBase = RemoteAgentWireImportFile['base'];

/** 一个会处理 `@` 导入的说明文件：在你这台的目录，以及在那台电脑上的位置(相对 base 根)。 */
interface Importer {
  text: string;
  localDir: string;
  base: ImportBase;
  placedDir: string;
  hops: number;
  update(text: string): void;
}

export interface InstructionImportInput {
  workingDir: string;
  projectFiles: RemoteAgentWireFile[];
  ancestorFiles: RemoteAgentWireAncestorFile[];
  personal: RemoteAgentWirePersonal;
}

/**
 * Claude Code 说明文件里的 `@路径` 导入(只对 Claude Code)：项目说明、`.claude/rules` 里的规则、上级目录
 * 里的说明与个人说明导入的文件一起带过去，放到那台电脑上对应的位置，引用改写成在那里也能找到的相对
 * 路径(就地改写传入的说明文件内容)。导入的 Markdown 里的导入继续跟随，最多 5 层(与 Claude Code 一致)。
 *
 * 能带的位置：工作目录与它的各级上级目录下(那台电脑按同样的层级放)，个人说明里 ~/.claude 下的文件
 * (放在个人说明旁边)。其它位置(另一个盘、个人说明导入 ~/.claude 之外)的导入原样保留，在那台电脑上
 * 找不到。
 */
export async function collectInstructionImports(
  input: InstructionImportInput,
  options: CollectOptions & { env?: NodeJS.ProcessEnv; home?: string } = {},
): Promise<RemoteAgentWireImportFile[]> {
  const env = options.env ?? process.env;
  const home = options.home ?? os.homedir();
  const configDir = claudeConfigDir(env, home);
  const workingDir = path.resolve(input.workingDir);
  const budget = newBudget(options);
  const out: RemoteAgentWireImportFile[] = [];
  const seen = new Set<string>();
  const queue: Importer[] = [];
  const projectByPath = new Map(input.projectFiles.map((file) => [file.path, file]));
  const isClaudeInstruction = (file: string) =>
    file === 'CLAUDE.md' || file === 'CLAUDE.local.md' || file === '.claude/CLAUDE.md'
    || (file.startsWith('.claude/rules/') && /\.md$/i.test(file));
  const fileImporter = (file: RemoteAgentWireFile, localDir: string, hops: number): Importer => ({
    text: Buffer.from(file.data, 'base64').toString('utf8'),
    localDir,
    base: 'workspace',
    placedDir: path.posix.dirname(file.path) === '.' ? '' : path.posix.dirname(file.path),
    hops,
    update: (text) => {
      file.data = Buffer.from(text, 'utf8').toString('base64');
    },
  });

  for (const file of input.projectFiles) {
    if (!isClaudeInstruction(file.path)) continue;
    seen.add(`workspace:${file.path}`);
    queue.push(fileImporter(file, path.dirname(path.join(workingDir, ...file.path.split('/'))), 0));
  }
  for (const file of input.ancestorFiles) {
    if (file.name !== 'CLAUDE.md' && file.name !== 'CLAUDE.local.md') continue;
    let dir = workingDir;
    for (let level = 0; level < file.up; level += 1) dir = path.dirname(dir);
    queue.push({
      text: Buffer.from(file.data, 'base64').toString('utf8'),
      localDir: dir,
      base: 'workspace',
      placedDir: Array.from({ length: file.up }, () => '..').join('/'),
      hops: 0,
      update: (text) => {
        file.data = Buffer.from(text, 'utf8').toString('base64');
      },
    });
  }
  // 个人规则放在影子目录的 .claude/rules 里，但导入按它在 ~/.claude/rules 的位置解析。
  for (const file of input.personal.files) {
    if (!file.path.startsWith('.claude/rules/') || !/\.md$/i.test(file.path)) continue;
    const local = path.join(configDir, ...file.path.split('/').slice(1));
    queue.push(fileImporter(file, path.dirname(local), 0));
  }
  if (input.personal.memory) {
    const personal = input.personal;
    queue.push({
      text: personal.memory!,
      localDir: configDir,
      base: 'session',
      placedDir: '',
      hops: 0,
      update: (text) => {
        personal.memory = text;
      },
    });
  }

  /** 导入目标在那台电脑上的位置；带不过去时返回 null。 */
  const placementOf = (base: ImportBase, target: string): string | null => {
    const from = base === 'workspace' ? workingDir : configDir;
    const relative = path.relative(from, target);
    if (!relative || path.isAbsolute(relative)) return null;
    const posix = toPosix(relative);
    if (base === 'session' && (posix.startsWith('..') || posix === 'CLAUDE.md' || posix.split('/')[0] === 'fs')) return null;
    return posix;
  };

  const resolveToken = async (token: string, localDir: string): Promise<{ target: string; consumed: string } | null> => {
    const trimmed = token.replace(/[.,;:!?]+$/, '');
    for (const candidate of trimmed && trimmed !== token ? [token, trimmed] : [token]) {
      const target = candidate === '~' || /^~[\\/]/.test(candidate)
        ? path.join(home, candidate.slice(2))
        : path.isAbsolute(candidate) ? path.resolve(candidate) : path.resolve(localDir, candidate);
      try {
        if ((await fs.stat(target)).isFile()) return { target, consumed: candidate };
      } catch {
        // 不是文件(或是 @提到的人名之类)：试下一个写法。
      }
    }
    return null;
  };

  while (queue.length) {
    const importer = queue.shift()!;
    // 第 5 层导入的文件照样带过去，但它里面的导入不再跟随。
    if (importer.hops >= MAX_IMPORT_HOPS) continue;
    const replacements = new Map<string, string>();
    for (const token of new Set(importTokens(importer.text))) {
      const resolved = await resolveToken(token, importer.localDir);
      if (!resolved) continue;
      const placed = placementOf(importer.base, resolved.target);
      if (placed === null) continue;
      const key = `${importer.base}:${placed}`;
      const existing = importer.base === 'workspace' ? projectByPath.get(placed) : undefined;
      if (!seen.has(key)) {
        seen.add(key);
        const md = /\.md$/i.test(placed);
        if (existing) {
          // 已经随项目文件同步(如 CLAUDE.md 里的 @AGENTS.md)：不再重复带，里面的导入照样跟随。
          if (md) queue.push(fileImporter(existing, path.dirname(resolved.target), importer.hops + 1));
        } else {
          const data = await readLimited(resolved.target, budget);
          if (!data) continue;
          const file: RemoteAgentWireImportFile = { base: importer.base, path: placed, data: data.toString('base64') };
          out.push(file);
          if (md) {
            queue.push({
              text: data.toString('utf8'),
              localDir: path.dirname(resolved.target),
              base: importer.base,
              placedDir: path.posix.dirname(placed) === '.' ? '' : path.posix.dirname(placed),
              hops: importer.hops + 1,
              update: (text) => {
                file.data = Buffer.from(text, 'utf8').toString('base64');
              },
            });
          }
        }
      }
      // 相对写法在那台电脑上也落在同一个位置时保持原样；`~/`、绝对路径等改写成相对路径。
      const rewritten = relativeBetween(importer.placedDir, placed);
      const original = resolved.consumed.replace(/\\/g, '/');
      const sameRelative = !path.isAbsolute(resolved.consumed) && !resolved.consumed.startsWith('~')
        && path.posix.normalize(original) === path.posix.normalize(rewritten);
      if (!sameRelative) replacements.set(token, token === resolved.consumed ? rewritten : rewritten + token.slice(resolved.consumed.length));
    }
    if (replacements.size) importer.update(replaceImportTokens(importer.text, replacements));
  }
  return out;
}
