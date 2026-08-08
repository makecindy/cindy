/**
 * SkillHub Scanner — 商店层 (registry / market) 视图组装。
 *
 * v0.7 之后，agent 自己的 customization 发现（扫盘 / RPC）收口到 maker-core。
 * 当前 SkillHub 视图只消费 Claude Code 的 global/project scope；Codex 的
 * user/repo/system/admin scope 需要单独映射，不能直接塞进现有 SkillhubScope。
 *
 * 本模块的职责只剩两件:
 *   1. scanAllSkills: 把 maker 给的 AgentCustomization[] join 上商店 registry,
 *      并补齐 renderer 期望的 SkillhubSkill 字段集 (id / projectHash / registryEntry / sources)。
 *   2. read* / write* / rename* IPC 后端: 都是受白名单约束的本地文件 IO,
 *      跟 agent 概念无关, 留在 main 是合理的。
 *
 * Read-only for scan; write helpers gated by SKILL_PATH_WHITELIST.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import matter from 'gray-matter';
import type { AgentCustomization, Maker, PiRuntimeCapabilityStatus } from '@cindy/maker-core';
import { registryService, type StoredInstall } from './registry';
import { isIgnoredSkillPackagePath } from './packageIgnore';

import { createLogger } from '../logger';

const log = createLogger('skillhub:scanner');

export type SkillKind = 'skill' | 'command' | 'agent';
export type SkillScope = 'global' | 'project';

export interface SkillFileEntry {
  /** filename or sub-folder name (one level only, no recursion) */
  name: string;
  /** 'file' | 'dir' — for icon selection in the FILES panel */
  kind: 'file' | 'dir';
}

export interface Skill {
  /**
   * Stable id — React key，含 engine 前缀防跨引擎同名冲突。
   *   global  → `${engine}:${kind}:global:${name}`
   *   project → `${engine}:${kind}:project:${projectHash}:${name}`
   */
  id: string;
  /**
   * URL 匹配键 — 不含 engine，和路由格式一致，用于侧栏选中高亮。
   *   global  → `${kind}:global:${name}`
   *   project → `${kind}:project:${projectHash}:${name}`
   */
  urlKey: string;
  /** 来自哪个 agent 引擎。 */
  engine: 'claude-code' | 'codex' | 'pi';
  /** 发现该 skill 的所有引擎专属路径（去重后）。~/.agents/ 通用路径不算引擎。 */
  linkedEngines: Array<{
    engine: 'claude-code' | 'codex' | 'pi';
    label: string;
    runtimeStatus?: PiRuntimeCapabilityStatus;
  }>;
  kind: SkillKind;
  scope: SkillScope;
  /** Folder name for kind=skill; basename without `.md` for kind=command/agent. */
  name: string;
  /** Frontmatter `description` (string), trimmed and capped at 500 chars. */
  description?: string;
  /**
   * Absolute path to the entity:
   *   - skill:   folder containing SKILL.md
   *   - command: the .md file itself
   *   - agent:   the .md file itself
   * The renderer uses this for the toolbar path display and as the
   * MarkdownRenderer workingDir (for skill: the folder; for command/agent:
   * the file's parent dir, computed renderer-side via path utilities).
   */
  absolutePath: string;
  /** Full path to the .md file we render (SKILL.md for skill, the file itself for command/agent). */
  mdPath: string;
  /** Sibling files / subfolders inside the skill folder. Always empty for command/agent. */
  files: SkillFileEntry[];
  /** Full frontmatter object (raw parse output) — for the FRONTMATTER panel. */
  frontmatter?: Record<string, unknown>;
  /** Set when frontmatter parsing failed; UI surfaces a hint without crashing. */
  parseError?: string;
  /** 仅 project scope：项目资产归属根目录，不等同于 session 的运行 cwd。 */
  projectRoot?: string;
  /** 仅 project scope：调用方提供的项目 URL hash。 */
  projectHash?: string;
  /**
   * Registry 记录（来自 <userData>/skillhub/manifests/<name>.json）。
   * 市场装的 skill 且目录存在 → 非 null；本地手写或旧版 xdt-manifest 的 → null。
   * 仅 kind=skill 才会填；command/agent 始终 null。
   */
  registryEntry: StoredInstall | null;
}

export type SourceStatus =
  | { state: 'ok'; count: number }
  | { state: 'missing' }
  | { state: 'error'; message: string };

export interface SourceReport {
  kind: SkillKind;
  scope: SkillScope;
  /** project source 对应的项目资产归属根目录；global source 不填。 */
  projectRoot?: string;
  /** Absolute path that was probed (informational). */
  path: string;
  status: SourceStatus;
}

export interface ScanResult {
  skills: Skill[];
  sources: SourceReport[];
}

/** 调用方传入的项目描述；hash 留在 renderer 侧生成。 */
export interface ProjectInput {
  /** 项目资产归属根目录，来自会话分组后的 project root，不是 agent 的运行 cwd。 */
  projectRoot: string;
  /** 来自 `lib/projectHash.ts` 的稳定 URL hash，原样写入 Skill.projectHash。 */
  hash: string;
}

/**
 * Scan all known Claude customizations + 商店元数据组装。
 *
 * v0.7 起所有扫盘/解析 frontmatter/列文件都由 maker-core 的 ClaudeCodeAgent.listCustomizations
 * 完成 (走 packages/maker-core/src/agents/claude-code/customization-scanner.ts)。
 * 本函数只负责:
 *   1. 把 AgentCustomization 转成 renderer 期望的 SkillhubSkill 形态 (补 id / projectHash)
 *   2. join registry: 装机记录 (StoredInstall) 是商店概念, 不在 maker 范围
 *   3. orphan cleanup: registry 有但盘上没了的, 异步删
 *
 * sources[] 字段保留兼容 renderer (但当前 renderer 只存不读), 用 maker 的 errors 还原 'error'
 * 状态; ok 状态简化为按 (kind/scope) 聚合 count。失败不抛, 单个 errors 收进 sources。
 */
/**
 * Codex/Pi scope → SkillScope 映射。
 * Codex/Pi: 'user'|'system'|'admin' → 'global', 'repo' → 'project'。
 * Claude: 已经是 'global'|'project'，直通。
 */
function normalizeScope(engine: string, rawScope: string): SkillScope {
  if (engine === 'codex' || engine === 'pi') {
    return rawScope === 'repo' ? 'project' : 'global';
  }
  return rawScope as SkillScope;
}

function normalizeSkillEntityPath(c: AgentCustomization): AgentCustomization {
  if (
    c.kind === 'skill' &&
    path.basename(c.absolutePath).toLowerCase() === 'skill.md'
  ) {
    return {
      ...c,
      absolutePath: path.dirname(c.absolutePath),
      mdPath: c.mdPath ?? c.absolutePath,
    };
  }
  return c;
}

function filterSkillPackageFileEntries(rootDir: string, entries: SkillFileEntry[]): SkillFileEntry[] {
  return entries.filter((entry) => {
    const childPath = path.join(rootDir, entry.name);
    return !isIgnoredSkillPackagePath(skillPackageRelPath(rootDir, childPath, entry.name));
  });
}

export async function scanAllSkills(
  params: { projects?: ProjectInput[] },
  maker: Maker,
): Promise<ScanResult> {
  const projects = params.projects ?? [];
  // ProjectInput 带 hash，maker 只要 project root；建反查表用于补回 projectHash 字段。
  const hashByProjectRoot = new Map<string, string>();
  for (const p of projects) {
    if (p.projectRoot && path.isAbsolute(p.projectRoot)) {
      hashByProjectRoot.set(p.projectRoot, p.hash);
    }
  }
  const workingDirs = Array.from(hashByProjectRoot.keys());

  let listed: { items: AgentCustomization[]; errors: Array<{ path?: string; message: string }> };
  try {
    listed = await maker.listCustomizations({
      workingDirs,
      forceReload: false,
    });
  } catch (err) {
    log.error('maker.listCustomizations failed', err);
    listed = { items: [], errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }

  // ── 过滤 + 跨引擎去重 ──────────────────────────────────────────────────────
  // ~/.agents/skills/ 是 agent-agnostic 的共享路径（canonical），实体文件在此。
  // 当同一逻辑 skill 被多个来源发现时，优先保留公共路径作为显示路径。
  const HIDDEN_SCOPES = new Set(['system', 'admin']);
  const isBackupPath = (p: string) => /\.bak\.\d+$/.test(path.basename(p));
  const isGenericPath = (p: string) => /\/\.agents\/skills\//.test(p.replace(/\\/g, '/'));
  const seenItems = new Map<string, { winner: AgentCustomization; all: AgentCustomization[] }>();
  for (const item of listed.items) {
    const c = normalizeSkillEntityPath(item);
    if (HIDDEN_SCOPES.has(c.scope)) continue;
    if (isBackupPath(c.absolutePath)) continue;
    let realKey: string;
    try {
      realKey = fs.realpathSync(c.absolutePath);
    } catch {
      realKey = c.absolutePath;
    }
    const existing = seenItems.get(realKey);
    if (existing) {
      existing.all.push(c);
      if (!isGenericPath(existing.winner.absolutePath) && isGenericPath(c.absolutePath)) {
        existing.winner = c;
      }
      continue;
    }
    seenItems.set(realKey, { winner: c, all: [c] });
  }
  const deduped = Array.from(seenItems.entries()).map(([realPath, v]) => ({ ...v, realPath }));

  // ── AgentCustomization → SkillhubSkill ──────────────────────────────────────
  const skills: Skill[] = deduped.map(({ winner: c, all, realPath }) => {
    const engine = c.engine as Skill['engine'];
    const projectHash = c.workingDir ? hashByProjectRoot.get(c.workingDir) : undefined;
    // skill 类型的 identity 始终是目录名（= market slug），不依赖 frontmatter name。
    // Codex RPC 可能从 frontmatter 取 name 导致与目录名不一致，统一用 basename(realPath)。
    const canonicalName = c.kind === 'skill' ? path.basename(realPath) : c.name;
    // Codex RPC may return 'repo' scope for user-level skills when homedir is
    // used as fallback cwd. If the workingDir doesn't map to a tracked project,
    // treat the skill as global — it's effectively user-level.
    const rawScope = normalizeScope(engine, c.scope);
    const scope: SkillScope = (rawScope === 'project' && !projectHash) ? 'global' : rawScope;
    const urlKey = scope === 'global'
      ? `${c.kind}:global:${canonicalName}`
      : `${c.kind}:project:${projectHash}:${canonicalName}`;
    const id = `${engine}:${urlKey}`;

    const engineSet = new Map<Skill['engine'], Skill['linkedEngines'][number]>();
    for (const item of all) {
      const eng = item.engine;
      if (!engineSet.has(eng)) {
        engineSet.set(eng, {
          engine: eng,
          label: eng === 'claude-code' ? 'Claude' : eng === 'codex' ? 'Codex' : 'Pi',
          ...(item.runtimeStatus ? { runtimeStatus: item.runtimeStatus } : {}),
        });
      }
    }
    const linkedEngines = Array.from(engineSet.values());

    const skill: Skill = {
      id,
      urlKey,
      engine,
      linkedEngines,
      kind: c.kind as SkillKind,
      scope,
      name: canonicalName,
      description: c.description,
      absolutePath: realPath,
      mdPath: c.mdPath ?? realPath,
      files: c.kind === 'skill'
        ? filterSkillPackageFileEntries(realPath, (c.files ?? []) as SkillFileEntry[])
        : [],
      frontmatter: c.frontmatter,
      parseError: c.parseError,
      registryEntry: null,            // 下面 join 阶段填
      ...(c.workingDir ? { projectRoot: c.workingDir } : {}),
      ...(projectHash ? { projectHash } : {}),
    };
    return skill;
  });

  // ── join registry ──────────────────────────────────────────────────────────
  let registryEntries: Awaited<ReturnType<typeof registryService.listAllInstalls>>;
  try {
    registryEntries = await registryService.listAllInstalls();
  } catch (err) {
    log.warn('registry list failed, fallback to empty:', err);
    registryEntries = [];
  }
  const registryByPath = new Map<string, StoredInstall>();
  const registryLiveKeys = new Map<string, string>();
  for (const r of registryEntries) {
    const installPathKey = path.normalize(r.installPath);
    registryByPath.set(installPathKey, r.entry);
    registryLiveKeys.set(installPathKey, installPathKey);
    try {
      const realInstallPathKey = path.normalize(fs.realpathSync(r.installPath));
      registryByPath.set(realInstallPathKey, r.entry);
      registryLiveKeys.set(installPathKey, realInstallPathKey);
    } catch {
      // If the path no longer exists, keep the original key so orphan cleanup
      // below can still test access(r.installPath) and remove stale records.
    }
  }
  const liveRealPaths = new Set<string>();
  for (const s of skills) {
    if (s.kind !== 'skill') continue;
    let resolved: string;
    try {
      resolved = fs.realpathSync(s.absolutePath);
    } catch {
      resolved = s.absolutePath;
    }
    const normPath = path.normalize(resolved);
    // path 是物理唯一标识；允许 registry skillName 和 scanner directory name 不一致
    // （历史数据或 frontmatter name 与目录名不同步时会出现）
    s.registryEntry = registryByPath.get(normPath) ?? null;
    liveRealPaths.add(normPath);
  }

  // ── orphan cleanup (fire-and-forget) ───────────────────────────────────────
  // 只删除磁盘上目录已不存在的条目；未被当前 scan 覆盖但目录仍在的不算孤儿
  // （可能只是该项目不在本次 workingDirs 里）。
  const orphans = registryEntries.filter((r) => {
    const installPathKey = path.normalize(r.installPath);
    return !liveRealPaths.has(registryLiveKeys.get(installPathKey) ?? installPathKey);
  });
  if (orphans.length > 0) {
    void Promise.all(
      orphans.map(async (o) => {
        try {
          await fs.promises.access(o.installPath);
        } catch {
          await registryService.removeInstall(o.skillName, o.installPath).catch((err) =>
            log.warn(`orphan cleanup failed for ${o.skillName}@${o.installPath}:`, err),
          );
        }
      }),
    );
  }

  // ── Claude symlink repair (fire-and-forget) ────────────────────────────────
  // 存量安装可能缺少 .claude/skills/ symlink（Codex 原生扫 .agents/ 但 Claude 只扫 .claude/）。
  // 每次 scan 时检测并补建，确保 Claude Code 能稳定发现。
  void Promise.all(
    registryEntries
      .filter((r) => /[/\\]\.agents[/\\]skills[/\\]/.test(r.installPath))
      .map(async (r) => {
        try {
          await fs.promises.access(r.installPath);
        } catch { return; }
        const agentsIdx = r.installPath.replace(/\\/g, '/').lastIndexOf('/.agents/skills/');
        if (agentsIdx < 0) return;
        const base = r.installPath.slice(0, agentsIdx);
        const claudeLink = path.join(base || os.homedir(), '.claude', 'skills', r.skillName);
        try {
          const stat = await fs.promises.lstat(claudeLink);
          if (stat.isSymbolicLink()) {
            const target = path.resolve(path.dirname(claudeLink), await fs.promises.readlink(claudeLink));
            if (path.normalize(target) === path.normalize(r.installPath)) return;
            await fs.promises.unlink(claudeLink);
          } else {
            return;
          }
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return;
        }
        await fs.promises.mkdir(path.dirname(claudeLink), { recursive: true });
        await fs.promises.symlink(
          r.installPath, claudeLink,
          process.platform === 'win32' ? 'junction' : 'dir',
        ).catch((e) => log.warn(`claude symlink repair failed for ${r.skillName}:`, e));
      }),
  );

  // ── sources[] 兼容 (renderer 只存不读) ─────────────────────────────────────
  const sources: SourceReport[] = listed.errors.map((e) => ({
    kind: 'skill',
    scope: 'global',
    path: e.path ?? '',
    status: { state: 'error', message: e.message },
  }));

  return { skills, sources };
}

/**
 * Read a single .md file's content (markdown body, frontmatter stripped) for
 * the detail view. Defensive checks reject paths outside the expected
 * `.claude/{skills,commands,agents}/` layout so the IPC can't be coerced
 * into a generic file reader.
 */
export async function readSkillContent(params: { mdPath: string }): Promise<{
  success: boolean;
  content?: string;
  error?: string;
}> {
  const { mdPath } = params;
  if (!mdPath || !path.isAbsolute(mdPath)) {
    return { success: false, error: 'mdPath must be an absolute path' };
  }

  // Defensive scope: only allow .md files. The renderer always sources the
  // path from a previous scan result, but cheap to verify.
  if (!mdPath.toLowerCase().endsWith('.md')) {
    return { success: false, error: 'only .md files may be read via this channel' };
  }

  if (!isAllowedSkillPath(mdPath)) {
    return { success: false, error: 'path is not under a recognized skills directory' };
  }
  if (isIgnoredSkillFilePath(mdPath)) {
    return { success: false, error: 'path is excluded from SkillHub packages' };
  }

  try {
    const raw = fs.readFileSync(mdPath, 'utf-8');
    const parsed = matter(raw);
    return { success: true, content: parsed.content };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Read a sibling file inside a skill folder for in-app preview. Unlike
 * readSkillContent (which strips frontmatter for markdown rendering), this
 * returns the raw text verbatim. Caller is expected to wrap it in a code
 * fence on the renderer side when the file isn't a .md.
 *
 * Caps: rejects files larger than 1 MB so a stray binary doesn't blow up
 * the preview pane.
 */
const PREVIEW_SIZE_CAP = 1024 * 1024; // 1 MB

export async function readSkillSiblingFile(params: { filePath: string }): Promise<{
  success: boolean;
  content?: string;
  error?: string;
}> {
  const { filePath } = params;
  if (!filePath || !path.isAbsolute(filePath)) {
    return { success: false, error: 'filePath must be an absolute path' };
  }

  if (!isAllowedSkillPath(filePath)) {
    return { success: false, error: 'path is not under a recognized skills directory' };
  }

  try {
    if (isIgnoredSkillFilePath(filePath)) {
      return { success: false, error: 'path is excluded from SkillHub packages' };
    }

    const stat = fs.statSync(filePath);
    if (!stat.isFile()) {
      return { success: false, error: 'path is not a file' };
    }
    if (stat.size > PREVIEW_SIZE_CAP) {
      return { success: false, error: `文件超过 ${Math.round(PREVIEW_SIZE_CAP / 1024)} KB,无法在面板中预览` };
    }
    const content = fs.readFileSync(filePath, 'utf-8');
    return { success: true, content };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * List one level of children inside a directory under `.claude/skills/`.
 * Used by the FILES panel to lazy-expand subfolders without recursing the
 * whole tree on initial scan. Same defensive layout check as readSkillContent
 * — only paths within a skill folder are accepted, so commands / agents
 * (single .md files) can't trigger directory traversal here.
 */
export async function listSkillFolderChildren(params: { dirPath: string }): Promise<{
  success: boolean;
  entries?: SkillFileEntry[];
  error?: string;
}> {
  const { dirPath } = params;
  if (!dirPath || !path.isAbsolute(dirPath)) {
    return { success: false, error: 'dirPath must be an absolute path' };
  }

  if (!isAllowedSkillPath(dirPath)) {
    return { success: false, error: 'path is not under a recognized skills directory' };
  }

  try {
    const stat = fs.statSync(dirPath);
    if (!stat.isDirectory()) {
      return { success: false, error: 'path is not a directory' };
    }
    const skillRoot = findSkillRootForPath(dirPath);
    const entries: SkillFileEntry[] = fs
      .readdirSync(dirPath, { withFileTypes: true })
      .filter((s) => {
        const childPath = path.join(dirPath, s.name);
        return !isIgnoredSkillPackagePath(skillPackageRelPath(skillRoot, childPath, s.name));
      })
      .map((s) => ({
        name: s.name,
        kind: s.isDirectory() ? ('dir' as const) : ('file' as const),
      }))
      .sort((a, b) => {
        if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
    return { success: true, entries };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ── v0.2.2 edit-md slice ───────────────────────────────────────────────────
// Raw read + atomic write for in-app markdown editing. The renderer uses
// readSkillContent for view (frontmatter stripped) and readRawFile here for
// edit (frontmatter intact). Writes are gated by SKILL_PATH_WHITELIST.

const EDIT_SIZE_CAP_READ = 256 * 1024;   // 256 KB read cap (matches detail-view edit-button gate)
const EDIT_SIZE_CAP_WRITE = 1024 * 1024; // 1 MB write cap (defensive against paste-of-binary)

// 统一白名单：所有引擎的 skill/command/agent 目录共用。
// 新增引擎时只需在此 regex 加一个分支。
const SKILL_PATH_WHITELIST = /\/(\.(claude\/(skills|commands|agents)|agents\/skills|codex\/skills|pi\/skills)|codex-home\/skills)\//;

function isAllowedSkillPath(absolutePath: string): boolean {
  // path.resolve 解析 .. 和 . 段，防止遍历绕过白名单
  const norm = path.resolve(absolutePath).replace(/\\/g, '/');
  return SKILL_PATH_WHITELIST.test(norm);
}

function findSkillRootForPath(absolutePath: string): string | null {
  const norm = path.resolve(absolutePath).replace(/\\/g, '/');
  const markerMatch = /\/(?:\.claude\/(?:skills|commands|agents)|\.agents\/skills|\.codex\/skills|\.pi\/skills|codex-home\/skills)\//.exec(norm);
  if (!markerMatch) return null;

  const afterMarker = norm.slice((markerMatch.index ?? 0) + markerMatch[0].length);
  const skillName = afterMarker.split('/').filter(Boolean)[0];
  if (!skillName) return null;

  return norm.slice(0, (markerMatch.index ?? 0) + markerMatch[0].length) + skillName;
}

function skillPackageRelPath(rootDir: string | null, childPath: string, fallbackName: string): string {
  if (!rootDir) return fallbackName;
  const rel = path.relative(rootDir, childPath).split(path.sep).join('/');
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : fallbackName;
}

function isIgnoredSkillFilePath(filePath: string): boolean {
  const skillRoot = findSkillRootForPath(filePath);
  return isIgnoredSkillPackagePath(skillPackageRelPath(skillRoot, filePath, path.basename(filePath)));
}

export async function readSkillRawFile(params: { filePath: string }): Promise<{
  success: boolean;
  content?: string;
  error?: string;
}> {
  const { filePath } = params;
  if (!filePath || !path.isAbsolute(filePath)) {
    return { success: false, error: 'filePath must be an absolute path' };
  }
  // Reject `..` segments after normalize — defensive against caller bugs.
  if (path.normalize(filePath).split(path.sep).includes('..')) {
    return { success: false, error: 'filePath contains traversal segments' };
  }
  if (!isAllowedSkillPath(filePath)) {
    return { success: false, error: 'path is not under a recognized skills directory' };
  }
  if (isIgnoredSkillFilePath(filePath)) {
    return { success: false, error: 'path is excluded from SkillHub packages' };
  }
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return { success: false, error: 'path is not a file' };
    if (stat.size > EDIT_SIZE_CAP_READ) {
      return { success: false, error: `文件超过 ${Math.round(EDIT_SIZE_CAP_READ / 1024)} KB,请用外部编辑器` };
    }
    const content = fs.readFileSync(filePath, 'utf-8');
    return { success: true, content };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function writeSkillFile(params: { filePath: string; content: string }): Promise<{
  success: boolean;
  error?: string;
}> {
  const { filePath, content } = params;
  if (!filePath || !path.isAbsolute(filePath)) {
    return { success: false, error: 'filePath must be an absolute path' };
  }
  if (path.normalize(filePath).split(path.sep).includes('..')) {
    return { success: false, error: 'filePath contains traversal segments' };
  }
  if (!isAllowedSkillPath(filePath)) {
    return { success: false, error: 'path is not under a recognized skills directory' };
  }
  if (isIgnoredSkillFilePath(filePath)) {
    return { success: false, error: 'path is excluded from SkillHub packages' };
  }
  // Existence requirement — v0.2.2 disallows creating new files.
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return { success: false, error: '文件不存在,本期不允许创建新文件' };
  }
  if (!stat.isFile()) {
    return { success: false, error: 'path is not a file' };
  }
  const byteLen = Buffer.byteLength(content, 'utf-8');
  if (byteLen > EDIT_SIZE_CAP_WRITE) {
    return { success: false, error: `内容超过 ${Math.round(EDIT_SIZE_CAP_WRITE / 1024)} KB,拒绝写入` };
  }
  // Atomic write: tmp + rename. fsync the tmp file before rename so a crash
  // mid-write doesn't leave a half-written file at the target path.
  const tmpPath = `${filePath}.xdt-tmp`;
  try {
    const fd = fs.openSync(tmpPath, 'w');
    try {
      fs.writeSync(fd, content);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmpPath, filePath);
    return { success: true };
  } catch (err) {
    // Best-effort tmp cleanup — ignore failures.
    try { fs.unlinkSync(tmpPath); } catch { /* noop */ }
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Rename a local skill (folder + SKILL.md frontmatter `name`) atomically-ish.
 *
 * 用于"市场名字被占,本地需改名再发布"流程。先校验、再改盘、最后改 frontmatter。
 * 改 frontmatter 失败会回滚目录 rename,保证盘上要么全成要么全不动。
 *
 * 仅支持 kind=skill (folder-shaped). command/agent 是单 .md 文件,本期不需要。
 */
export async function renameLocalSkill(params: {
  absolutePath: string;
  newName: string;
}): Promise<{ success: true; newAbsolutePath: string } | { success: false; error: string }> {
  const { absolutePath, newName } = params;

  if (!absolutePath || !path.isAbsolute(absolutePath)) {
    return { success: false, error: 'absolutePath must be an absolute path' };
  }
  if (path.normalize(absolutePath).split(path.sep).includes('..')) {
    return { success: false, error: 'absolutePath contains traversal segments' };
  }
  if (!isAllowedSkillPath(absolutePath)) {
    return { success: false, error: 'path is not under a recognized skills directory' };
  }
  if (!/^[a-z0-9-]+$/.test(newName)) {
    return { success: false, error: '新名字格式必须是 [a-z0-9-]+' };
  }

  // 必须是已有的 skill folder
  let stat: fs.Stats;
  try {
    stat = fs.statSync(absolutePath);
  } catch {
    return { success: false, error: '目录不存在' };
  }
  if (!stat.isDirectory()) {
    return { success: false, error: 'absolutePath 不是目录' };
  }

  const oldName = path.basename(absolutePath);
  if (oldName === newName) {
    // 名字没变 — 视为 noop 成功,免得调用方还要分支处理
    return { success: true, newAbsolutePath: absolutePath };
  }

  const parentDir = path.dirname(absolutePath);
  const newAbsolutePath = path.join(parentDir, newName);

  // 目标目录必须不存在 — 撞名直接退出,避免覆盖别的 skill
  if (fs.existsSync(newAbsolutePath)) {
    return { success: false, error: `本地已存在同名 skill: ${newName}` };
  }

  // 必须有 SKILL.md
  const oldSkillMd = path.join(absolutePath, 'SKILL.md');
  if (!fs.existsSync(oldSkillMd) || !fs.statSync(oldSkillMd).isFile()) {
    return { success: false, error: 'SKILL.md 不存在,无法改名' };
  }

  // ── Step 1: rename 目录
  try {
    fs.renameSync(absolutePath, newAbsolutePath);
  } catch (err) {
    return { success: false, error: `重命名目录失败: ${err instanceof Error ? err.message : String(err)}` };
  }

  // ── Step 2: 改写 SKILL.md frontmatter 的 name 字段
  const newSkillMd = path.join(newAbsolutePath, 'SKILL.md');
  try {
    const raw = fs.readFileSync(newSkillMd, 'utf-8');
    const parsed = matter(raw);
    const data = (parsed.data && typeof parsed.data === 'object'
      ? parsed.data
      : {}) as Record<string, unknown>;
    // 只在 frontmatter 真有 name 字段时才覆写,没有就插入
    data.name = newName;
    const next = matter.stringify(parsed.content, data);

    // Atomic tmp + rename 一致地写
    const tmpPath = `${newSkillMd}.xdt-tmp`;
    const fd = fs.openSync(tmpPath, 'w');
    try {
      fs.writeSync(fd, next);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmpPath, newSkillMd);
  } catch (err) {
    // 回滚:把目录改回去,避免本地处于"目录新名 + frontmatter 旧名"的半完成状态
    try {
      fs.renameSync(newAbsolutePath, absolutePath);
    } catch {
      // 回滚也失败 — 报双重失败,让调用方提示用户手动修
      return {
        success: false,
        error: `改写 SKILL.md 失败且回滚也失败: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    return {
      success: false,
      error: `改写 SKILL.md frontmatter 失败,已回滚目录: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  return { success: true, newAbsolutePath };
}
