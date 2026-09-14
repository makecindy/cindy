/**
 * Collect project Skill / prompt / extension paths for explicit Pi CLI flags.
 *
 * Local root tasks keep `--no-approve` (so `.pi/settings.json` stays unread)
 * and pass original in-repo paths via `--skill`, `--prompt-template`, and
 * `--extension`. Review, Bot, fork, and remote sessions do not use this.
 */

import fs from 'node:fs';
import path from 'node:path';

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

function collectSkillDirs(repoRoot: string, skillsDir: string, bucket: Set<string>): void {
  const resolvedDir = realpathOrNull(skillsDir);
  if (!resolvedDir || !isDir(resolvedDir) || !isWithinRoot(repoRoot, resolvedDir)) return;
  for (const entry of listDir(resolvedDir)) {
    if (entry.name.startsWith('.')) continue;
    const realFolder = realpathOrNull(path.join(resolvedDir, entry.name));
    if (!realFolder || !isDir(realFolder) || !isWithinRoot(repoRoot, realFolder)) continue;
    const skillMd = path.join(realFolder, 'SKILL.md');
    const realMd = realpathOrNull(skillMd);
    if (!realMd || !isFile(realMd) || !isWithinRoot(repoRoot, realMd)) continue;
    bucket.add(realFolder);
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

  const byPath = (left: string, right: string) => left.localeCompare(right);
  return Object.freeze({
    skills: Object.freeze([...skills].sort(byPath)),
    promptTemplates: Object.freeze([...promptTemplates].sort(byPath)),
    extensions: Object.freeze([...extensions].sort(byPath)),
  });
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
    if (path.basename(real) === 'SKILL.md') denied.add(path.dirname(real));
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
