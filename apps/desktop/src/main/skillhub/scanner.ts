import { isLexicallyAllowedSkillPath, isPathWithin, resolveAllowedExistingSkillPath, resolveExistingSkillPathForGrant } from './skillPathPolicy';
export { resolveExistingSkillPathForGrant } from './skillPathPolicy';
import { readDisabledSkillPathsForListing, renameSkillWithActivation } from './activationPreferences';
import { skillInstallLockKey, tryAcquireSkillInstallLock } from './installLock';
import { acquireSharedSkillMutationLease, type SkillMutationRelease } from './sharedMutationLease';
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

import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import type { ListCustomizationsResult, Maker, PiRuntimeCapabilityStatus } from '@cindy/maker-core';
import type { BuiltInSkillDescriptor } from '../maker-host/built-in-skills';
import { registryService, type StoredInstall } from './registry';
import { app } from 'electron';
import { projectSkillList } from './customizationScanHost';
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
  /** Local Cindy override, independent of each engine's native availability. */
  cindyEnabled?: boolean;
  canUninstall?: boolean;
  managedByPlugin?: boolean;
  builtIn?: boolean;
  uninstallLinkOnly?: boolean;
  /** All lexical discovery aliases; Main owns their validation. */
  discoveryPaths?: string[];
  /**
   * Stable id — React key，含 engine 前缀防跨引擎同名冲突。同一 engine 下
   * 若 URL 基键重复，会再追加 canonical source path 的不可逆 hash。
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
  /** Pi customization 的 canonical physical source hash；Pi 条目始终提供。 */
  sourceKey?: string;
  /** 同一 URL 基键存在多个来源时，详情路由必须携带 sourceKey。 */
  requiresSourceKey?: boolean;
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
  /** Lexical path reported by discovery before canonical realpath deduplication. */
  discoveredPath: string;
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
  /** Original market slug from the registry joined by physical path. */
  registrySkillName?: string;
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
  /** Existing IPC flag, derived without resolving user aliases on Main. */
  learnSkillEnabled?: boolean;
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
 *   3. 列表只读，不触发 orphan 删除或发现链接维护；写操作由显式安装/卸载负责
 *
 * sources[] 字段保留兼容 renderer (但当前 renderer 只存不读), 用 maker 的 errors 还原 'error'
 * 状态; ok 状态简化为按 (kind/scope) 聚合 count。失败不抛, 单个 errors 收进 sources。
 */
export async function scanAllSkills(
  params: { projects?: ProjectInput[] },
  maker: Maker,
  managedSkillRoots: readonly string[] = [],
  builtInSkills: readonly BuiltInSkillDescriptor[] = [],
): Promise<ScanResult> {
  const projects = params.projects ?? [];
  let listed: ListCustomizationsResult;
  try {
    listed = await maker.listCustomizations({
      workingDirs: projects.filter((p) => p.projectRoot && path.isAbsolute(p.projectRoot)).map((p) => p.projectRoot),
      forceReload: false,
    });
  } catch (err) {
    log.error('maker.listCustomizations failed', err);
    listed = { items: [], errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
  let registryEntries: Awaited<ReturnType<typeof registryService.listAllInstalls>> = [];
  try { registryEntries = await registryService.listAllInstalls({ readOnly: true }); }
  catch (err) { log.warn('registry list failed, fallback to empty:', err); }
  // Listing must never start filesystem maintenance. Install/uninstall keep
  // their existing mutation leases and final on-disk validation in Main.
  return projectSkillList({ projects, listed, registryEntries, managedSkillRoots, builtInSkills,
    disabledPaths: readDisabledSkillPathsForListing(), userDataDir: app.getPath('userData'), appDataDir: app.getPath('appData') });
}

/**
 * Read a single .md file's content (markdown body, frontmatter stripped) for
 * the detail view. Defensive checks reject paths outside the expected
 * `.claude/{skills,commands,agents}/` layout so the IPC can't be coerced
 * into a generic file reader.
 */
export async function readSkillContent(params: { mdPath: string; attestedRoot?: string }): Promise<{
  success: boolean;
  content?: string;
  error?: string;
}> {
  const { mdPath, attestedRoot } = params;
  if (!mdPath || !path.isAbsolute(mdPath)) {
    return { success: false, error: 'mdPath must be an absolute path' };
  }

  // Defensive scope: only allow .md files. The renderer always sources the
  // path from a previous scan result, but cheap to verify.
  if (!mdPath.toLowerCase().endsWith('.md')) {
    return { success: false, error: 'only .md files may be read via this channel' };
  }

  const resolvedMdPath = resolveReadableExistingSkillPath(mdPath, attestedRoot);
  if (!resolvedMdPath) {
    return { success: false, error: 'path is not under a recognized skills directory' };
  }
  if (isIgnoredSkillFilePath(attestedRoot ? resolvedMdPath : mdPath, attestedRoot)) {
    return { success: false, error: 'path is excluded from SkillHub packages' };
  }

  try {
    const raw = fs.readFileSync(resolvedMdPath, 'utf-8');
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

export async function readSkillSiblingFile(params: { filePath: string; attestedRoot?: string }): Promise<{
  success: boolean;
  content?: string;
  error?: string;
}> {
  const { filePath, attestedRoot } = params;
  if (!filePath || !path.isAbsolute(filePath)) {
    return { success: false, error: 'filePath must be an absolute path' };
  }

  const resolvedFilePath = resolveReadableExistingSkillPath(filePath, attestedRoot);
  if (!resolvedFilePath) {
    return { success: false, error: 'path is not under a recognized skills directory' };
  }

  try {
    if (isIgnoredSkillFilePath(attestedRoot ? resolvedFilePath : filePath, attestedRoot)) {
      return { success: false, error: 'path is excluded from SkillHub packages' };
    }

    const stat = fs.statSync(resolvedFilePath);
    if (!stat.isFile()) {
      return { success: false, error: 'path is not a file' };
    }
    if (stat.size > PREVIEW_SIZE_CAP) {
      return { success: false, error: `文件超过 ${Math.round(PREVIEW_SIZE_CAP / 1024)} KB,无法在面板中预览` };
    }
    const content = fs.readFileSync(resolvedFilePath, 'utf-8');
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
export async function listSkillFolderChildren(params: { dirPath: string; attestedRoot?: string }): Promise<{
  success: boolean;
  entries?: SkillFileEntry[];
  error?: string;
}> {
  const { dirPath, attestedRoot } = params;
  if (!dirPath || !path.isAbsolute(dirPath)) {
    return { success: false, error: 'dirPath must be an absolute path' };
  }

  const resolvedDirPath = resolveReadableExistingSkillPath(dirPath, attestedRoot);
  if (!resolvedDirPath) {
    return { success: false, error: 'path is not under a recognized skills directory' };
  }

  try {
    const stat = fs.statSync(resolvedDirPath);
    if (!stat.isDirectory()) {
      return { success: false, error: 'path is not a directory' };
    }
    const listedDirPath = attestedRoot ? resolvedDirPath : dirPath;
    const skillRoot = attestedRoot
      ? fs.realpathSync.native(attestedRoot)
      : findSkillRootForPath(dirPath);
    const entries: SkillFileEntry[] = fs
      .readdirSync(resolvedDirPath, { withFileTypes: true })
      .filter((s) => {
        const childPath = path.join(listedDirPath, s.name);
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
/**
 * Read-only built-ins can live outside the user-facing discovery whitelist.
 * Main may pass an attested physical root from the sender's latest scan; keep
 * every final target physically contained by that root so child symlinks
 * cannot turn this into a generic file-read primitive.
 */
function resolveReadableExistingSkillPath(
  absolutePath: string,
  attestedRoot?: string,
): string | null {
  if (!attestedRoot) return resolveAllowedExistingSkillPath(absolutePath);
  if (!path.isAbsolute(attestedRoot)) return null;
  try {
    const realRoot = fs.realpathSync.native(attestedRoot);
    const realTarget = fs.realpathSync.native(path.resolve(absolutePath));
    return isPathWithin(realRoot, realTarget) ? realTarget : null;
  } catch {
    return null;
  }
}

/**
 * Canonicalize a path previously surfaced by SkillHub discovery for an IPC
 * grant. This deliberately reuses the same lexical whitelist and physical
 * symlink boundary as the eventual read/write operation.
 */
/** Return whether an existing target belongs to one of the sender's scanned roots. */
export function isExistingSkillPathGranted(
  absolutePath: string,
  grantedRoots: ReadonlySet<string>,
): boolean {
  const realTarget = resolveExistingSkillPathForGrant(absolutePath);
  if (!realTarget) return false;
  for (const root of grantedRoots) {
    if (isPathWithin(root, realTarget)) return true;
  }
  return false;
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

function isIgnoredSkillFilePath(filePath: string, attestedRoot?: string): boolean {
  let skillRoot = attestedRoot ?? findSkillRootForPath(filePath);
  if (attestedRoot) {
    try { skillRoot = fs.realpathSync.native(attestedRoot); } catch { return true; }
  }
  return isIgnoredSkillPackagePath(skillPackageRelPath(skillRoot, filePath, path.basename(filePath)));
}

export async function readSkillRawFile(params: { filePath: string; attestedRoot?: string }): Promise<{
  success: boolean;
  content?: string;
  error?: string;
}> {
  const { filePath, attestedRoot } = params;
  if (!filePath || !path.isAbsolute(filePath)) {
    return { success: false, error: 'filePath must be an absolute path' };
  }
  // Reject `..` segments after normalize — defensive against caller bugs.
  if (path.normalize(filePath).split(path.sep).includes('..')) {
    return { success: false, error: 'filePath contains traversal segments' };
  }
  const resolvedFilePath = resolveReadableExistingSkillPath(filePath, attestedRoot);
  if (!resolvedFilePath) {
    return { success: false, error: 'path is not under a recognized skills directory' };
  }
  if (isIgnoredSkillFilePath(attestedRoot ? resolvedFilePath : filePath, attestedRoot)) {
    return { success: false, error: 'path is excluded from SkillHub packages' };
  }
  try {
    const stat = fs.statSync(resolvedFilePath);
    if (!stat.isFile()) return { success: false, error: 'path is not a file' };
    if (stat.size > EDIT_SIZE_CAP_READ) {
      return { success: false, error: `文件超过 ${Math.round(EDIT_SIZE_CAP_READ / 1024)} KB,请用外部编辑器` };
    }
    const content = fs.readFileSync(resolvedFilePath, 'utf-8');
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
  if (!isLexicallyAllowedSkillPath(filePath)) {
    return { success: false, error: 'path is not under a recognized skills directory' };
  }
  try {
    // Parent-directory compatibility symlinks remain supported, but the final
    // editable file must be a regular lexical entry. Otherwise resolving it
    // first would let an atomic rename overwrite the symlink's external target.
    if (fs.lstatSync(filePath).isSymbolicLink()) {
      return { success: false, error: 'refusing to write through a symbolic link' };
    }
  } catch {
    return { success: false, error: '文件不存在,本期不允许创建新文件' };
  }
  const resolvedFilePath = resolveAllowedExistingSkillPath(filePath);
  if (!resolvedFilePath) {
    return { success: false, error: 'path is not under a recognized skills directory' };
  }
  if (isIgnoredSkillFilePath(filePath)) {
    return { success: false, error: 'path is excluded from SkillHub packages' };
  }
  // Existence requirement — v0.2.2 disallows creating new files.
  let stat: fs.Stats;
  try {
    stat = fs.statSync(resolvedFilePath);
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
  const tmpPath = `${resolvedFilePath}.xdt-tmp`;
  try {
    const fd = fs.openSync(tmpPath, 'w');
    try {
      fs.writeSync(fd, content);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmpPath, resolvedFilePath);
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
}, canMutate: () => boolean = () => true): Promise<{ success: true; newAbsolutePath: string } | { success: false; error: string }> {
  const { absolutePath, newName } = params;

  if (!absolutePath || !path.isAbsolute(absolutePath)) {
    return { success: false, error: 'absolutePath must be an absolute path' };
  }
  if (path.normalize(absolutePath).split(path.sep).includes('..')) {
    return { success: false, error: 'absolutePath contains traversal segments' };
  }
  if (!resolveAllowedExistingSkillPath(absolutePath)) {
    return { success: false, error: 'path is not under a recognized skills directory' };
  }
  if (!/^[a-z0-9-]+$/.test(newName)) {
    return { success: false, error: '新名字格式必须是 [a-z0-9-]+' };
  }

  // 必须是已有的 skill folder
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(absolutePath);
  } catch {
    return { success: false, error: '目录不存在' };
  }
  if (stat.isSymbolicLink()) {
    return { success: false, error: '符号链接 skill 不支持重命名' };
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
  let skillMdStat: fs.Stats;
  try {
    skillMdStat = fs.lstatSync(oldSkillMd);
  } catch {
    return { success: false, error: 'SKILL.md 不存在,无法改名' };
  }
  if (skillMdStat.isSymbolicLink()) {
    return { success: false, error: '符号链接 SKILL.md 不支持重命名' };
  }
  if (!skillMdStat.isFile()) {
    return { success: false, error: 'SKILL.md 不存在,无法改名' };
  }

  const releases: Array<() => void> = [];
  for (const name of new Set([oldName, newName].map(skillInstallLockKey))) {
    const release = tryAcquireSkillInstallLock(name, 'local-rename');
    if (!release) {
      releases.forEach((unlock) => unlock());
      return { success: false, error: 'Skill is busy; retry after the current operation' };
    }
    releases.push(release);
  }
  const newSkillMd = path.join(newAbsolutePath, 'SKILL.md');
  const tmpPath = `${newSkillMd}.xdt-tmp`;
  const backupPath = `${newSkillMd}.xdt-rename-${randomUUID()}`;
  let renamed = false;
  let backedUp = false;
  let releaseShared: SkillMutationRelease | null = null;
  try {
    releaseShared = await acquireSharedSkillMutationLease([oldName, newName]);
    if (!releaseShared) return { success: false, error: 'Skill is busy; retry after the current operation' };
    await renameSkillWithActivation(absolutePath, newAbsolutePath, () => {
      if (!canMutate()) throw new Error('Skill mutation context changed');
      // Recheck after waiting for the preferences lock; never replace a new entity.
      const current = fs.lstatSync(absolutePath);
      if (current.dev !== stat.dev || current.ino !== stat.ino || fs.existsSync(newAbsolutePath)) {
        throw new Error('Skill changed; refresh and retry');
      }
      const currentMd = fs.lstatSync(oldSkillMd);
      if (currentMd.isSymbolicLink() || currentMd.dev !== skillMdStat.dev || currentMd.ino !== skillMdStat.ino) {
        throw new Error('Skill content changed; refresh and retry');
      }
      const parsed = matter(fs.readFileSync(oldSkillMd, 'utf-8'));
      const data = (parsed.data && typeof parsed.data === 'object' ? parsed.data : {}) as Record<string, unknown>;
      data.name = newName;
      const next = matter.stringify(parsed.content, data);
      fs.renameSync(absolutePath, newAbsolutePath);
      renamed = true;
      const fd = fs.openSync(tmpPath, 'w');
      try { fs.writeSync(fd, next); fs.fsyncSync(fd); }
      finally { fs.closeSync(fd); }
      fs.renameSync(newSkillMd, backupPath);
      backedUp = true;
      fs.renameSync(tmpPath, newSkillMd);
    });
    // packageIgnore excludes this reserved backup from browsing, hashes,
    // snapshots and ZIPs even if Windows keeps it locked after commit.
    try { fs.unlinkSync(backupPath); } catch { /* Do not roll back committed preferences. */ }
    return { success: true, newAbsolutePath };
  } catch (err) {
    if (renamed) {
      try {
        // Keep the original file until preferences commit, so even a full disk
        // can roll back with renames instead of writing the contents again.
        if (backedUp) fs.renameSync(backupPath, newSkillMd);
        try { fs.unlinkSync(tmpPath); } catch { /* No staging file after a completed switch. */ }
        fs.renameSync(newAbsolutePath, absolutePath);
      } catch (rollbackError) {
        return { success: false, error: `Skill rename and rollback failed: ${String(rollbackError)}` };
      }
    }
    return { success: false, error: `Skill rename failed: ${String(err)}` };
  } finally {
    await releaseShared?.();
    releases.forEach((unlock) => unlock());
  }
}
