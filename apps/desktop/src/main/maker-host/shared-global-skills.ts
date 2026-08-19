import os from 'node:os';
import path from 'node:path';
import { promises as fsp } from 'node:fs';

type LinkStatus = 'linked' | 'kept' | 'conflict' | 'skipped' | 'error';

type SkillRootName = 'shared' | 'claude' | 'codex';

interface SkillEntry {
  name: string;
  root: SkillRootName;
  path: string;
  realPath: string;
  isSymlink: boolean;
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
}

interface PrepareOptions {
  homeDir?: string;
  /** Optional owner-bound caller guard for Ghost-managed fanout. */
  assertOwnerStable?: () => void;
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

/** Returns the root only for a direct `<root>/.{agents,claude}/skills/<name>` child. */
export function projectWorkingDirFromSkillPath(skillPath: string): string | null {
  const resolved = path.resolve(skillPath);
  const skillsDir = path.dirname(resolved);
  const agentsDir = path.dirname(skillsDir);
  const equalsName = (actual: string, expected: string) =>
    process.platform === 'win32'
      ? actual.toLowerCase() === expected.toLowerCase()
      : actual === expected;
  if (!equalsName(path.basename(skillsDir), 'skills')) return null;
  const discoveryRoot = path.basename(agentsDir);
  if (!equalsName(discoveryRoot, '.agents') && !equalsName(discoveryRoot, '.claude')) {
    return null;
  }
  return path.dirname(agentsDir);
}

async function listSkillEntries(
  root: SkillRootName,
  rootPath: string,
): Promise<SkillEntry[]> {
  if (!(await isDirectory(rootPath))) return [];

  let entries;
  try {
    entries = await fsp.readdir(rootPath, { withFileTypes: true });
  } catch {
    return [];
  }

  const skills: SkillEntry[] = [];
  for (const ent of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (ent.name.startsWith('.')) continue;
    if (!ent.isDirectory() && !ent.isSymbolicLink()) continue;

    const skillPath = path.join(rootPath, ent.name);
    if (!(await hasSkillFile(skillPath))) continue;

    const realPath = await realPathOrNull(skillPath);
    if (!realPath) continue;

    skills.push({
      name: ent.name,
      root,
      path: skillPath,
      realPath,
      isSymlink: ent.isSymbolicLink(),
    });
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
  const skillsDir = path.dirname(targetPath);
  const discoveryDir = path.dirname(skillsDir);
  return equalsName(path.basename(targetPath), skillName)
    && equalsName(path.basename(skillsDir), 'skills')
    && discoveryRoots.some((root) => equalsName(path.basename(discoveryDir), root));
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

    assertMutationAllowed?.();
    try {
      await fsp.unlink(linkPath);
      changed = true;
    } catch {
      // Broken symlink cleanup is best-effort; later link creation will report conflicts if needed.
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
): Promise<{ actions: LinkAction[]; changed: boolean; warnings: string[] }> {
  const actions: LinkAction[] = [];
  const warnings: string[] = [];
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
    const result = await ensureDirectoryLink(
      entry,
      targetPath,
      useRelativeTarget,
      assertMutationAllowed,
    );
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
      warnings.push(
        `cannot link skill ${entry.name} from ${entry.path} to ${targetPath}: ${result.reason ?? result.status}`,
      );
    }
  }

  return { actions, changed, warnings };
}

/**
 * Makes global skills usable from Claude Code, Codex, and Pi without moving user data.
 *
 * Rules:
 * - ~/.agents/skills is the shared index that Cindy Codex and Pi scan.
 * - Existing ~/.claude/skills and ~/.codex/skills entries are linked into ~/.agents/skills.
 * - ~/.agents/skills and ~/.codex/skills entries are linked into ~/.claude/skills.
 * - Existing non-symlink paths are never overwritten.
 */
export async function prepareSharedGlobalSkillLinks(
  opts: PrepareOptions = {},
): Promise<SharedGlobalSkillLinksResult> {
  opts.assertOwnerStable?.();
  const paths = sharedGlobalSkillsPaths(opts.homeDir);
  opts.assertOwnerStable?.();
  await fsp.mkdir(paths.sharedSkillsDir, { recursive: true });
  opts.assertOwnerStable?.();
  await fsp.mkdir(paths.claudeSkillsDir, { recursive: true });
  const sharedRootCompare = (await realPathOrNull(paths.sharedSkillsDir)) ?? normalizeForCompare(paths.sharedSkillsDir);
  const claudeRootCompare = (await realPathOrNull(paths.claudeSkillsDir)) ?? normalizeForCompare(paths.claudeSkillsDir);
  const codexRootCompare = (await realPathOrNull(paths.codexSkillsDir)) ?? normalizeForCompare(paths.codexSkillsDir);

  const warnings: string[] = [];
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
  changed = (await cleanupBrokenManagedLinks(
    paths.claudeSkillsDir,
    managedRoots,
    [],
    opts.assertOwnerStable,
  )) || changed;

  const initialClaudeEntries = (await listSkillEntries('claude', paths.claudeSkillsDir))
    .filter((entry) => !(entry.isSymlink && pointsInto(entry, [sharedRootCompare, codexRootCompare])));
  const claudeToShared = await linkEntriesIntoRoot(
    initialClaudeEntries,
    paths.sharedSkillsDir,
    false,
    opts.assertOwnerStable,
  );
  actions.push(...claudeToShared.actions);
  warnings.push(...claudeToShared.warnings);
  changed = changed || claudeToShared.changed;

  const sharedEntries = await listSkillEntries('shared', paths.sharedSkillsDir);
  const sharedToClaude = await linkEntriesIntoRoot(
    sharedEntries,
    paths.claudeSkillsDir,
    false,
    opts.assertOwnerStable,
  );
  actions.push(...sharedToClaude.actions);
  warnings.push(...sharedToClaude.warnings);
  changed = changed || sharedToClaude.changed;

  const codexEntries = (await listSkillEntries('codex', paths.codexSkillsDir))
    .filter((entry) => !(entry.isSymlink && pointsInto(entry, [sharedRootCompare, claudeRootCompare])));
  const codexToClaude = await linkEntriesIntoRoot(
    codexEntries,
    paths.claudeSkillsDir,
    false,
    opts.assertOwnerStable,
  );
  actions.push(...codexToClaude.actions);
  warnings.push(...codexToClaude.warnings);
  changed = changed || codexToClaude.changed;

  const codexToShared = await linkEntriesIntoRoot(
    codexEntries,
    paths.sharedSkillsDir,
    false,
    opts.assertOwnerStable,
  );
  actions.push(...codexToShared.actions);
  warnings.push(...codexToShared.warnings);
  changed = changed || codexToShared.changed;

  opts.assertOwnerStable?.();
  return {
    ...paths,
    changed,
    actions,
    warnings,
  };
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
 */
export async function prepareSharedProjectSkillLinks(
  opts: PrepareProjectOptions,
): Promise<SharedProjectSkillLinksResult> {
  const paths = sharedProjectSkillsPaths(opts.workingDir);
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
