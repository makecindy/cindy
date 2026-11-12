import os from 'node:os';
import path from 'node:path';
import fs, { promises as fsp } from 'node:fs';
import { shouldPruneSkillScanDirectory } from '@cindy/maker-core/skill-scan-limits';

type LinkStatus = 'linked' | 'kept' | 'conflict' | 'skipped' | 'error';

type SkillRootName = 'shared' | 'claude' | 'codex';

interface SkillEntry {
  name: string;
  root: SkillRootName;
  path: string;
  realPath: string;
  isSymlink: boolean;
  identity: string;
}

interface LinkAction {
  name: string;
  source: string;
  target: string;
  status: LinkStatus;
  reason?: string;
}

export interface SharedGlobalSkillLinksResult {
  homeDir: string;
  sharedSkillsDir: string;
  claudeSkillsDir: string;
  codexSkillsDir: string;
  changed: boolean;
  actions: LinkAction[];
  warnings: string[];
  /**
   * Subset of `warnings` that describe stable user-owned state rather than a failed
   * attempt: the cross-agent sync opt-out and user paths we deliberately never
   * overwrite. Retrying cannot clear them, so callers may cache past them and report
   * them once instead of on every run.
   */
  persistentWarnings: string[];
}

export const SHARED_GLOBAL_SKILL_SYNC_DISABLED_NOTICE =
  'cross-agent global skill sync is disabled; set crossAgentSyncEnabled to opt in';

interface PrepareOptions {
  homeDir?: string;
  /** Optional owner-bound caller guard for Ghost-managed fanout. */
  assertOwnerStable?: () => void;
  /**
   * 跨 Agent 链接的显式 opt-in 判定（#2930）。缺省时读
   * shared-global-skills-settings（默认关）；注入用于单测确定性控制。
   */
  isCrossAgentSyncEnabled?: () => boolean;
}

export interface SharedProjectSkillLinksResult {
  workingDir: string;
  sharedSkillsDir: string;
  claudeSkillsDir: string;
  changed: boolean;
  actions: LinkAction[];
  warnings: string[];
}

interface PrepareProjectOptions {
  workingDir: string;
}

// Keep read-only path helpers importable outside Electron. Actual mutations
// resolve the Main-owned lease only when they execute.
async function withLinkMutation<T>(names: string[], operation: () => Promise<T>): Promise<T | undefined> {
  const { withSkillMutation } = await import('../skillhub/sharedMutationLease');
  return withSkillMutation(names, operation);
}

function sourceIdentity(file: string): string | null {
  try {
    const stat = fs.statSync(file);
    return JSON.stringify([normalizeForCompare(fs.realpathSync.native(file)), stat.dev, stat.ino, stat.birthtimeMs]);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function linkIdentity(file: string): string {
  const stat = fs.lstatSync(file);
  return JSON.stringify([stat.dev, stat.ino, stat.birthtimeMs, fs.readlinkSync(file)]);
}

function normalizeForCompare(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isSameOrInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

async function realPathOrNull(value: string): Promise<string | null> {
  try {
    return normalizeForCompare(await fsp.realpath(value));
  } catch {
    return null;
  }
}

async function isDirectory(value: string): Promise<boolean> {
  try {
    return (await fsp.stat(value)).isDirectory();
  } catch {
    return false;
  }
}

function isSymlinkDirectory(target: string): boolean {
  try {
    return fs.lstatSync(target).isSymbolicLink();
  } catch {
    return false;
  }
}

async function hasSkillFile(dirPath: string): Promise<boolean> {
  const candidates = ['SKILL.md', 'skill.md'];
  for (const name of candidates) {
    try {
      if ((await fsp.stat(path.join(dirPath, name))).isFile()) return true;
    } catch {
      // continue
    }
  }
  return false;
}

export function sharedGlobalSkillsPaths(homeDir = os.homedir()) {
  return {
    homeDir,
    sharedSkillsDir: path.join(homeDir, '.agents', 'skills'),
    claudeSkillsDir: path.join(homeDir, '.claude', 'skills'),
    codexSkillsDir: path.join(homeDir, '.codex', 'skills'),
  };
}

/** Project skills keep their single source of truth under either supported discovery root. */
export function sharedProjectSkillsPaths(workingDir: string) {
  const resolvedWorkingDir = path.resolve(workingDir);
  return {
    workingDir: resolvedWorkingDir,
    sharedSkillsDir: path.join(resolvedWorkingDir, '.agents', 'skills'),
    claudeSkillsDir: path.join(resolvedWorkingDir, '.claude', 'skills'),
  };
}

/** Returns the project root for a Skill below a `.agents`/`.claude` discovery root. */
export function projectWorkingDirFromSkillPath(skillPath: string): string | null {
  const normalized = path.resolve(skillPath).replace(/\\/g, '/');
  const match = /(?:^|\/)\.(?:agents|claude)\/skills(?=\/|$)/i.exec(normalized);
  if (!match) return null;
  const skillsRoot = path.resolve(normalized.slice(0, (match.index ?? 0) + match[0].length));
  return path.dirname(path.dirname(skillsRoot));
}

async function listSkillEntries(
  root: SkillRootName,
  rootPath: string,
): Promise<SkillEntry[]> {
  if (!(await isDirectory(rootPath))) return [];
  const skills: SkillEntry[] = [];

  const addSkill = async (skillPath: string, isSymlink: boolean): Promise<void> => {
    let realPath: string;
    let identity: string | null;
    try {
      realPath = normalizeForCompare(fs.realpathSync.native(skillPath));
      identity = sourceIdentity(skillPath);
    } catch {
      return;
    }
    if (!identity) return;
    skills.push({
      name: path.basename(skillPath),
      root,
      path: skillPath,
      realPath,
      isSymlink,
      identity,
    });
  };

  let entries;
  try {
    entries = await fsp.readdir(rootPath, { withFileTypes: true });
  } catch {
    return skills;
  }

  // Direct Skills win over nested Skills with the same leaf name, matching the
  // `/` panel's priority; collect them before walking namespaces.
  const namespaces: string[] = [];
  for (const ent of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (ent.name.startsWith('.')) continue;
    if (/\.bak\.\d+$/.test(ent.name)) continue;
    const skillPath = path.join(rootPath, ent.name);
    // Dirent can report a Windows junction as a directory; lstat keeps the
    // no-recursive-symlink guarantee consistent across platforms.
    const isSymlink = ent.isSymbolicLink() || (ent.isDirectory() && isSymlinkDirectory(skillPath));
    if (await hasSkillFile(skillPath)) {
      await addSkill(skillPath, isSymlink);
      continue;
    }
    // Direct symlinked Skills remain supported; a symlinked namespace is not walked.
    if (isSymlink || !ent.isDirectory() || shouldPruneSkillScanDirectory(ent.name)) continue;
    namespaces.push(skillPath);
  }

  // At most one namespace/author level: <root>/<namespace>/<skill>.
  for (const namespacePath of namespaces) {
    let namespaceEntries;
    try {
      namespaceEntries = await fsp.readdir(namespacePath, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const nested of namespaceEntries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (nested.name.startsWith('.')) continue;
      if (/\.bak\.\d+$/.test(nested.name)) continue;
      if (skills.some((skill) => skill.name === nested.name)) continue;
      const nestedPath = path.join(namespacePath, nested.name);
      if (!(await hasSkillFile(nestedPath))) continue;
      const nestedIsSymlink = nested.isSymbolicLink()
        || (nested.isDirectory() && isSymlinkDirectory(nestedPath));
      await addSkill(nestedPath, nestedIsSymlink);
    }
  }
  return skills;
}

function pointsInto(entry: SkillEntry, roots: string[]): boolean {
  return roots.some((root) => isSameOrInside(entry.realPath, normalizeForCompare(root)));
}

function matchesManagedSkillTargetShape(
  targetPath: string,
  skillName: string,
  discoveryRoots: string[],
): boolean {
  const equalsName = (actual: string, expected: string) =>
    process.platform === 'win32'
      ? actual.toLowerCase() === expected.toLowerCase()
      : actual === expected;
  const segments = path.resolve(targetPath).split(/[\\/]+/).filter(Boolean);
  const leaf = segments[segments.length - 1];
  if (!leaf || !equalsName(leaf, skillName)) return false;
  for (let index = 0; index + 2 < segments.length; index += 1) {
    const isDiscoveryRoot = discoveryRoots.some((root) => equalsName(segments[index], root));
    if (!isDiscoveryRoot || !equalsName(segments[index + 1], 'skills')) continue;
    // Only the shapes this module projects: flat `<skills>/<leaf>` and one
    // namespace level `<skills>/<namespace>/<leaf>`. Deeper paths are not ours.
    const levelsBelowSkills = segments.length - (index + 2);
    if (levelsBelowSkills === 1 || levelsBelowSkills === 2) return true;
  }
  return false;
}

async function cleanupBrokenManagedLinks(
  rootPath: string,
  managedRoots: string[],
  staleManagedDiscoveryRoots: string[] = [],
  assertMutationAllowed?: () => void,
): Promise<boolean> {
  let entries;
  try {
    entries = await fsp.readdir(rootPath, { withFileTypes: true });
  } catch {
    return false;
  }

  let changed = false;
  for (const ent of entries) {
    if (!ent.isSymbolicLink()) continue;

    const linkPath = path.join(rootPath, ent.name);
    let identity: string;
    try { identity = linkIdentity(linkPath); } catch { continue; }
    if (await realPathOrNull(linkPath)) continue;

    let targetPath: string;
    try {
      const rawTarget = await fsp.readlink(linkPath);
      targetPath = path.isAbsolute(rawTarget) ? rawTarget : path.resolve(rootPath, rawTarget);
    } catch {
      continue;
    }

    const targetCompare = normalizeForCompare(targetPath);
    const pointsIntoCurrentRoots = managedRoots.some((root) => isSameOrInside(targetCompare, root));
    const matchesMovedProjectLink = matchesManagedSkillTargetShape(
      targetPath,
      ent.name,
      staleManagedDiscoveryRoots,
    );
    if (!pointsIntoCurrentRoots && !matchesMovedProjectLink) continue;

    try {
      const removed = await withLinkMutation([ent.name, path.basename(targetPath)], async () => {
        if (linkIdentity(linkPath) !== identity || sourceIdentity(linkPath) !== null) return false;
        assertMutationAllowed?.();
        fs.unlinkSync(linkPath);
        return true;
      });
      changed = removed === true || changed;
    } catch {
      // Replaced entries and inaccessible paths are not proof of a broken link.
    }
  }
  return changed;
}

async function ensureDirectoryLink(
  source: SkillEntry,
  targetPath: string,
  useRelativeTarget = false,
  assertMutationAllowed?: () => void,
): Promise<{ status: LinkStatus; changed: boolean; reason?: string }> {
  const targetReal = await realPathOrNull(targetPath);
  if (targetReal && targetReal === source.realPath) {
    return { status: 'kept', changed: false };
  }

  try {
    const stat = await fsp.lstat(targetPath);
    return {
      status: 'conflict',
      changed: false,
      reason: stat.isSymbolicLink()
        ? 'path exists as a symlink/junction to a different target'
        : 'path exists and is not a managed symlink/junction',
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      return { status: 'error', changed: false, reason: (err as Error).message };
    }
  }

  assertMutationAllowed?.();
  try {
    await fsp.mkdir(path.dirname(targetPath), { recursive: true });
  } catch (err) {
    return { status: 'error', changed: false, reason: (err as Error).message };
  }

  assertMutationAllowed?.();
  try {
    const linkTarget = useRelativeTarget && process.platform !== 'win32'
      ? path.relative(path.dirname(targetPath), source.path)
      : source.path;
    await fsp.symlink(linkTarget, targetPath, process.platform === 'win32' ? 'junction' : 'dir');
    return { status: 'linked', changed: true };
  } catch (err) {
    return { status: 'error', changed: false, reason: (err as Error).message };
  }
}

async function linkEntriesIntoRoot(
  entries: SkillEntry[],
  targetRoot: string,
  useRelativeTarget = false,
  assertMutationAllowed?: () => void,
): Promise<{ actions: LinkAction[]; changed: boolean; warnings: string[]; persistentWarnings: string[] }> {
  const actions: LinkAction[] = [];
  const warnings: string[] = [];
  const persistentWarnings: string[] = [];
  let changed = false;
  const targetRootCompare = (await realPathOrNull(targetRoot)) ?? normalizeForCompare(targetRoot);

  for (const entry of entries) {
    if (isSameOrInside(entry.realPath, targetRootCompare)) {
      actions.push({
        name: entry.name,
        source: entry.path,
        target: path.join(targetRoot, entry.name),
        status: 'skipped',
        reason: 'source is already inside target root',
      });
      continue;
    }

    const targetPath = path.join(targetRoot, entry.name);
    const result = await withLinkMutation([entry.name, path.basename(entry.realPath)], async () => {
      if (sourceIdentity(entry.path) !== entry.identity) return { status: 'skipped' as const, changed: false };
      return ensureDirectoryLink(entry, targetPath, useRelativeTarget, () => {
        assertMutationAllowed?.();
        if (sourceIdentity(entry.path) !== entry.identity) throw new Error('Skill source changed during link projection');
      });
    }) ?? { status: 'skipped' as const, changed: false };
    changed = changed || result.changed;
    const action: LinkAction = {
      name: entry.name,
      source: entry.path,
      target: targetPath,
      status: result.status,
      ...(result.reason ? { reason: result.reason } : {}),
    };
    actions.push(action);
    if (result.status === 'conflict' || result.status === 'error') {
      const warning = `cannot link skill ${entry.name} from ${entry.path} to ${targetPath}: ${result.reason ?? result.status}`;
      warnings.push(warning);
      // A conflict is a user-owned path we never overwrite; only I/O errors are retryable.
      if (result.status === 'conflict') persistentWarnings.push(warning);
    }
  }

  return { actions, changed, warnings, persistentWarnings };
}

/**
 * #9282：是否允许主动创建/写入 `~/.claude` 下的 Skill 投影。
 *
 * 显式 opt-in（`crossAgentSyncEnabled`，#2930）、本地已存在 `~/.claude`，或本进程
 * 已在拉起 Claude（`markClaudeSessionObserved`，首次会话不等 CLI 自己建目录）时才
 * 创建目录与链接；三者皆无时不创建（多引擎隔离的最小权限）。这里只决定「要不要
 * 主动建」——存量目录与链接一律不删。
 */
let claudeSessionObserved = false;

/** Cindy 即将/已经拉起 Claude Code CLI：视为用户在用 Claude，打开投影门。 */
export function markClaudeSessionObserved(): void {
  claudeSessionObserved = true;
}

/** 仅测试用：回到「未观察到 Claude 会话」的初始门状态。 */
export function resetClaudeSessionObservedForTest(): void {
  claudeSessionObserved = false;
}

export async function shouldProjectToClaudeSkills(
  opts: { homeDir?: string; isCrossAgentSyncEnabled?: () => boolean } = {},
): Promise<boolean> {
  if (claudeSessionObserved) return true;
  const homeDir = opts.homeDir ?? os.homedir();
  if (fs.existsSync(path.join(homeDir, '.claude'))) return true;
  if (opts.isCrossAgentSyncEnabled) return opts.isCrossAgentSyncEnabled();
  // 延迟 import：本模块是纯 Node（无 electron 静态依赖），settings store 引
  // electron 的 app.getPath，静态引入会拖坏单测环境。
  const { readSharedGlobalSkillsSettings } = await import('./shared-global-skills-settings.js');
  return readSharedGlobalSkillsSettings().crossAgentSyncEnabled;
}

/**
 * Makes global skills usable from Claude Code, Codex, and Pi without moving user data.
 *
 * Rules:
 * - ~/.agents/skills is the shared index that Cindy Codex and Pi scan.
 * - Existing ~/.claude/skills and ~/.codex/skills entries are linked into ~/.agents/skills.
 * - ~/.agents/skills and ~/.codex/skills entries are linked into ~/.claude/skills
 *   only when Claude projection is allowed (#9282: opt-in or ~/.claude already exists).
 * - Existing non-symlink paths are never overwritten.
 */
export async function prepareSharedGlobalSkillLinks(
  opts: PrepareOptions = {},
): Promise<SharedGlobalSkillLinksResult> {
  opts.assertOwnerStable?.();
  const paths = sharedGlobalSkillsPaths(opts.homeDir);
  // #2930：跨 Agent 的「拉入」默认关闭，必须显式 opt-in（Claude→shared、
  // Codex→Claude、Codex→shared）。Cindy 自有索引向 Claude 的投影（shared→Claude）
  // 曾为 Ghost skill 的 .claude 兼容链接无条件保留（#3031）；#9282 起与
  // shouldProjectToClaudeSkills 挂钩（Ghost 已收敛到私有投影，见 skillSlot.ts）。
  const crossAgentSyncEnabled = opts.isCrossAgentSyncEnabled
    ? opts.isCrossAgentSyncEnabled()
    : // 延迟 import：本模块是纯 Node（无 electron 静态依赖），settings store 引
      // electron 的 app.getPath，静态引入会拖坏单测环境。
      (await import('./shared-global-skills-settings.js'))
        .readSharedGlobalSkillsSettings().crossAgentSyncEnabled;
  const claudeProjectionEnabled = crossAgentSyncEnabled
    || claudeSessionObserved
    || fs.existsSync(path.join(paths.homeDir, '.claude'));
  opts.assertOwnerStable?.();
  await fsp.mkdir(paths.sharedSkillsDir, { recursive: true });
  opts.assertOwnerStable?.();
  if (claudeProjectionEnabled) {
    await fsp.mkdir(paths.claudeSkillsDir, { recursive: true });
  }
  const sharedRootCompare = (await realPathOrNull(paths.sharedSkillsDir)) ?? normalizeForCompare(paths.sharedSkillsDir);
  const claudeRootCompare = (await realPathOrNull(paths.claudeSkillsDir)) ?? normalizeForCompare(paths.claudeSkillsDir);
  const codexRootCompare = (await realPathOrNull(paths.codexSkillsDir)) ?? normalizeForCompare(paths.codexSkillsDir);

  const warnings: string[] = [];
  const persistentWarnings: string[] = [];
  const actions: LinkAction[] = [];
  let changed = false;
  const managedRoots = Array.from(new Set([
    sharedRootCompare,
    claudeRootCompare,
    codexRootCompare,
    normalizeForCompare(paths.sharedSkillsDir),
    normalizeForCompare(paths.claudeSkillsDir),
    normalizeForCompare(paths.codexSkillsDir),
  ]));

  changed = (await cleanupBrokenManagedLinks(
    paths.sharedSkillsDir,
    managedRoots,
    [],
    opts.assertOwnerStable,
  )) || changed;
  if (claudeProjectionEnabled) {
    changed = (await cleanupBrokenManagedLinks(
      paths.claudeSkillsDir,
      managedRoots,
      [],
      opts.assertOwnerStable,
    )) || changed;
  }

  // 其它 Agent 根里、且不是「指向受管根」投影的用户技能，才是跨 Agent 拉入的对象。
  const claudeEntries = (await listSkillEntries('claude', paths.claudeSkillsDir))
    .filter((entry) => !(entry.isSymlink && pointsInto(entry, [sharedRootCompare, codexRootCompare])));
  const codexEntries = (await listSkillEntries('codex', paths.codexSkillsDir))
    .filter((entry) => !(entry.isSymlink && pointsInto(entry, [sharedRootCompare, claudeRootCompare])));

  if (crossAgentSyncEnabled) {
    const claudeToShared = await linkEntriesIntoRoot(
      claudeEntries,
      paths.sharedSkillsDir,
      false,
      opts.assertOwnerStable,
    );
    actions.push(...claudeToShared.actions);
    warnings.push(...claudeToShared.warnings);
    persistentWarnings.push(...claudeToShared.persistentWarnings);
    changed = changed || claudeToShared.changed;

    const codexToClaude = await linkEntriesIntoRoot(
      codexEntries,
      paths.claudeSkillsDir,
      false,
      opts.assertOwnerStable,
    );
    actions.push(...codexToClaude.actions);
    warnings.push(...codexToClaude.warnings);
    persistentWarnings.push(...codexToClaude.persistentWarnings);
    changed = changed || codexToClaude.changed;

    const codexToShared = await linkEntriesIntoRoot(
      codexEntries,
      paths.sharedSkillsDir,
      false,
      opts.assertOwnerStable,
    );
    actions.push(...codexToShared.actions);
    warnings.push(...codexToShared.warnings);
    persistentWarnings.push(...codexToShared.persistentWarnings);
    changed = changed || codexToShared.changed;
  } else if (claudeEntries.length > 0 || codexEntries.length > 0) {
    // 未 opt-in 且存在可同步的用户技能时才提示；纯 Ghost 对账不打扰。
    warnings.push(SHARED_GLOBAL_SKILL_SYNC_DISABLED_NOTICE);
    persistentWarnings.push(SHARED_GLOBAL_SKILL_SYNC_DISABLED_NOTICE);
  }

  if (claudeProjectionEnabled) {
    const sharedEntries = await listSkillEntries('shared', paths.sharedSkillsDir);
    const sharedToClaude = await linkEntriesIntoRoot(
      sharedEntries,
      paths.claudeSkillsDir,
      false,
      opts.assertOwnerStable,
    );
    actions.push(...sharedToClaude.actions);
    warnings.push(...sharedToClaude.warnings);
    persistentWarnings.push(...sharedToClaude.persistentWarnings);
    changed = changed || sharedToClaude.changed;
  }

  opts.assertOwnerStable?.();
  return {
    ...paths,
    changed,
    actions,
    warnings,
    persistentWarnings,
  };
}

/**
 * Cheap inputs of `prepareSharedGlobalSkillLinks` for completion caches: the opt-in
 * setting, whether Claude projection is currently allowed (setting / observed Claude
 * session / existing `~/.claude`), plus each global root's mtime (adding, removing or
 * renaming a top-level skill entry bumps it). A cached run must not hide a settings
 * toggle, a first Claude launch, or a new/removed skill.
 */
export async function sharedGlobalSkillLinksFingerprint(
  opts: Pick<PrepareOptions, 'homeDir' | 'isCrossAgentSyncEnabled'> = {},
): Promise<string> {
  const paths = sharedGlobalSkillsPaths(opts.homeDir);
  let crossAgentSyncEnabled: boolean | null;
  try {
    crossAgentSyncEnabled = opts.isCrossAgentSyncEnabled
      ? opts.isCrossAgentSyncEnabled()
      : (await import('./shared-global-skills-settings.js')).readSharedGlobalSkillsSettings().crossAgentSyncEnabled;
  } catch {
    crossAgentSyncEnabled = null;
  }
  const claudeProjectionAllowed =
    claudeSessionObserved ||
    crossAgentSyncEnabled === true ||
    fs.existsSync(path.join(paths.homeDir, '.claude'));
  const mtimes = await Promise.all(
    [paths.sharedSkillsDir, paths.claudeSkillsDir, paths.codexSkillsDir].map(async (dir) => {
      try { return (await fsp.stat(dir)).mtimeMs; } catch { return null; }
    }),
  );
  return JSON.stringify([crossAgentSyncEnabled, claudeProjectionAllowed, ...mtimes]);
}

/**
 * Makes project skills visible to both engines without copying or rewriting them.
 *
 * Rules:
 * - Codex discovers `<workingDir>/.agents/skills` and Claude Code discovers
 *   `<workingDir>/.claude/skills`.
 * - A real skill directory on either side is exposed to the other side with a link.
 * - Existing non-managed paths are never overwritten; conflicts are reported as warnings.
 * - Empty projects are left untouched, so merely opening a project does not create folders.
 * - The home directory is not a project: it is the global scope, so it goes through the
 *   gated global projection instead (#9282 — a Codex/Pi user without Claude must not
 *   get a `~/.claude` directory from merely opening a task in their home directory).
 */
export async function prepareSharedProjectSkillLinks(
  opts: PrepareProjectOptions,
): Promise<SharedProjectSkillLinksResult> {
  const paths = sharedProjectSkillsPaths(opts.workingDir);
  if (paths.workingDir === path.resolve(os.homedir())) {
    const global = await prepareSharedGlobalSkillLinks({ homeDir: paths.workingDir });
    return {
      ...paths,
      changed: global.changed,
      actions: global.actions,
      warnings: global.warnings,
    };
  }
  const sharedRootCompare = (await realPathOrNull(paths.sharedSkillsDir))
    ?? normalizeForCompare(paths.sharedSkillsDir);
  const claudeRootCompare = (await realPathOrNull(paths.claudeSkillsDir))
    ?? normalizeForCompare(paths.claudeSkillsDir);

  const managedRoots = Array.from(new Set([
    sharedRootCompare,
    claudeRootCompare,
    normalizeForCompare(paths.sharedSkillsDir),
    normalizeForCompare(paths.claudeSkillsDir),
  ]));
  let changed = false;
  // Windows junctions use absolute targets. After a checkout moves, repair only broken links
  // whose target still has the exact opposite discovery-root + skill-name shape we create.
  changed = (await cleanupBrokenManagedLinks(
    paths.sharedSkillsDir,
    managedRoots,
    ['.claude'],
  )) || changed;
  changed = (await cleanupBrokenManagedLinks(
    paths.claudeSkillsDir,
    managedRoots,
    ['.agents'],
  )) || changed;

  const initialClaudeEntries = (await listSkillEntries('claude', paths.claudeSkillsDir))
    .filter((entry) => !(entry.isSymlink && pointsInto(entry, [sharedRootCompare])));
  const initialSharedEntries = (await listSkillEntries('shared', paths.sharedSkillsDir))
    .filter((entry) => !(entry.isSymlink && pointsInto(entry, [claudeRootCompare])));
  if (initialClaudeEntries.length === 0 && initialSharedEntries.length === 0) {
    return { ...paths, changed, actions: [], warnings: [] };
  }

  const actions: LinkAction[] = [];
  const warnings: string[] = [];

  const claudeToShared = await linkEntriesIntoRoot(
    initialClaudeEntries,
    paths.sharedSkillsDir,
    true,
  );
  actions.push(...claudeToShared.actions);
  warnings.push(...claudeToShared.warnings);
  changed = claudeToShared.changed || changed;

  const sharedToClaude = await linkEntriesIntoRoot(
    initialSharedEntries,
    paths.claudeSkillsDir,
    true,
  );
  actions.push(...sharedToClaude.actions);
  warnings.push(...sharedToClaude.warnings);
  changed = sharedToClaude.changed || changed;

  return { ...paths, changed, actions, warnings };
}
