/**
 * Collect project Skill / prompt / extension paths for explicit Pi CLI flags.
 *
 * Local root tasks keep `--no-approve` (so `.pi/settings.json` stays unread)
 * and pass original in-repo paths via `--skill`, `--prompt-template`, and
 * `--extension`. Review, Bot, fork, and remote sessions do not use this.
 */

import fs from 'node:fs';
import path from 'node:path';
import { shouldPruneSkillScanDirectory } from '../shared/skill-scan-limits.js';

export interface PiProjectResourceCliPaths {
  readonly skills: readonly string[];
  readonly promptTemplates: readonly string[];
  readonly extensions: readonly string[];
}

export function emptyPiProjectResourceCliPaths(): PiProjectResourceCliPaths {
  return Object.freeze({
    skills: Object.freeze([]),
    promptTemplates: Object.freeze([]),
    extensions: Object.freeze([]),
  });
}

function realpathOrNull(target: string): string | null {
  try {
    return fs.realpathSync(target);
  } catch {
    return null;
  }
}

function isDir(target: string): boolean {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

function isFile(target: string): boolean {
  try {
    return fs.statSync(target).isFile();
  } catch {
    return false;
  }
}

function hasGitMarker(dir: string): boolean {
  try {
    const marker = fs.statSync(path.join(dir, '.git'));
    return marker.isDirectory() || marker.isFile();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code !== 'ENOENT' && code !== 'ENOTDIR';
  }
}

function findNearestGitRoot(workingDir: string): string | null {
  let current = workingDir;
  while (true) {
    if (hasGitMarker(current)) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function isWithinRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function listDir(dir: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function isSymlinkDirectory(target: string): boolean {
  try {
    return fs.lstatSync(target).isSymbolicLink();
  } catch {
    return false;
  }
}

function hasSkillFile(dir: string): boolean {
  return ['SKILL.md', 'skill.md'].some((name) => isFile(path.join(dir, name)));
}

function collectSkillDirs(repoRoot: string, skillsDir: string, bucket: Set<string>): void {
  const resolvedDir = realpathOrNull(skillsDir);
  if (!resolvedDir || !isDir(resolvedDir) || !isWithinRoot(repoRoot, resolvedDir)) return;

  const addSkill = (realFolder: string): void => {
    const skillMd = ['SKILL.md', 'skill.md']
      .map((name) => path.join(realFolder, name))
      .find(isFile);
    const realMd = skillMd ? realpathOrNull(skillMd) : null;
    if (realMd && isFile(realMd) && isWithinRoot(repoRoot, realMd)) bucket.add(realFolder);
  };

  for (const entry of listDir(resolvedDir)) {
    if (entry.name.startsWith('.') || /\.bak\.\d+$/.test(entry.name)) continue;
    const candidatePath = path.join(resolvedDir, entry.name);
    const realFolder = realpathOrNull(candidatePath);
    if (!realFolder || !isDir(realFolder) || !isWithinRoot(repoRoot, realFolder)) continue;
    if (hasSkillFile(realFolder)) {
      addSkill(realFolder);
      continue;
    }
    // Direct symlinked Skills remain supported above; a symlinked namespace
    // could escape the repo or cycle and is intentionally not walked.
    // lstat must see the unresolved path: a Windows junction may be reported
    // as a directory by readdir and by the resolved realpath.
    const isSymlink = entry.isSymbolicLink()
      || (entry.isDirectory() && isSymlinkDirectory(candidatePath));
    if (isSymlink || shouldPruneSkillScanDirectory(entry.name)) continue;

    // At most one namespace/author level: <root>/<namespace>/<skill>.
    for (const nested of listDir(realFolder)) {
      if (nested.name.startsWith('.') || /\.bak\.\d+$/.test(nested.name)) continue;
      const nestedFolder = realpathOrNull(path.join(realFolder, nested.name));
      if (!nestedFolder || !isDir(nestedFolder) || !isWithinRoot(repoRoot, nestedFolder)) continue;
      if (hasSkillFile(nestedFolder)) addSkill(nestedFolder);
    }
  }
}

export function collectPiProjectResourceCliPaths(workingDir: string): PiProjectResourceCliPaths {
  if (!workingDir || !path.isAbsolute(workingDir) || !isDir(workingDir)) {
    return emptyPiProjectResourceCliPaths();
  }
  const scanRoot = realpathOrNull(workingDir) ?? path.resolve(workingDir);
  const repoRoot = findNearestGitRoot(scanRoot) ?? scanRoot;
  const skills = new Set<string>();
  const promptTemplates = new Set<string>();
  const extensions = new Set<string>();

  collectSkillDirs(repoRoot, path.join(scanRoot, '.pi', 'skills'), skills);
  let current = scanRoot;
  while (true) {
    collectSkillDirs(repoRoot, path.join(current, '.agents', 'skills'), skills);
    if (current === repoRoot) break;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  const realPrompts = realpathOrNull(path.join(scanRoot, '.pi', 'prompts'));
  if (realPrompts && isDir(realPrompts) && isWithinRoot(repoRoot, realPrompts)) {
    for (const entry of listDir(realPrompts)) {
      if (entry.name.startsWith('.') || !entry.name.endsWith('.md')) continue;
      const realFile = realpathOrNull(path.join(realPrompts, entry.name));
      if (!realFile || !isFile(realFile) || !isWithinRoot(repoRoot, realFile)) continue;
      promptTemplates.add(realFile);
    }
  }

  const realExt = realpathOrNull(path.join(scanRoot, '.pi', 'extensions'));
  if (realExt && isDir(realExt) && isWithinRoot(repoRoot, realExt)) {
    for (const entry of listDir(realExt)) {
      if (entry.name.startsWith('.')) continue;
      const realChild = realpathOrNull(path.join(realExt, entry.name));
      if (!realChild || !isWithinRoot(repoRoot, realChild)) continue;
      if (isFile(realChild) && realChild.endsWith('.ts')) {
        extensions.add(realChild);
        continue;
      }
      if (!isDir(realChild)) continue;
      const realIndex = realpathOrNull(path.join(realChild, 'index.ts'));
      if (realIndex && isFile(realIndex) && isWithinRoot(repoRoot, realIndex)) {
        extensions.add(realIndex);
      }
    }
  }

  return Object.freeze({
    skills: Object.freeze([...skills].sort(comparePiResourcePaths)),
    promptTemplates: Object.freeze([...promptTemplates].sort(comparePiResourcePaths)),
    extensions: Object.freeze([...extensions].sort(comparePiResourcePaths)),
  });
}

/** Locale-independent path order so duplicate Skill names pick the same winner everywhere. */
export function comparePiResourcePaths(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

/** Conservative CreateProcess command-line budget; the hard Windows cap is 32767. */
export const PI_WINDOWS_SPAWN_ARGV_BUDGET = 30_000;
/** Leave headroom under typical macOS/Linux ARG_MAX, which is shared with env. */
export const PI_POSIX_SPAWN_ARGV_BUDGET = 128_000;

export function estimateSpawnArgvLength(args: readonly string[]): number {
  return args.reduce((total, arg) => total + arg.length + 3, 0);
}

export function piSpawnArgvBudget(platform: NodeJS.Platform): number | null {
  if (platform === 'win32') return PI_WINDOWS_SPAWN_ARGV_BUDGET;
  if (platform === 'darwin' || platform === 'linux') return PI_POSIX_SPAWN_ARGV_BUDGET;
  return null;
}

export function assertPiSpawnArgvFitsPlatform(
  args: readonly string[],
  platform: NodeJS.Platform = process.platform,
): void {
  const budget = piSpawnArgvBudget(platform);
  if (budget === null || estimateSpawnArgvLength(args) <= budget) return;
  throw new Error(
    'This project has too many Pi skills, prompts, or extensions to start a task. Remove some and try again.',
  );
}

export function filterPiProjectCliSkills(
  skills: readonly string[],
  disabledSkillPaths: readonly string[],
): readonly string[] {
  if (disabledSkillPaths.length === 0) return skills;
  const denied = new Set<string>();
  for (const disabled of disabledSkillPaths) {
    const real = realpathOrNull(disabled) ?? path.resolve(disabled);
    denied.add(real);
    if (path.basename(real).toLowerCase() === 'skill.md') denied.add(path.dirname(real));
  }
  return Object.freeze(skills.filter((skillPath) => !denied.has(skillPath)));
}

export function piProjectResourceCliArgs(paths: PiProjectResourceCliPaths): string[] {
  return [
    ...paths.skills.flatMap((skillPath) => ['--skill', skillPath]),
    ...paths.promptTemplates.flatMap((promptPath) => ['--prompt-template', promptPath]),
    ...paths.extensions.flatMap((extensionPath) => ['--extension', extensionPath]),
  ];
}
