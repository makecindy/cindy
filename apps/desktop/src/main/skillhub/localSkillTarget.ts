import fs from 'node:fs';
import path from 'node:path';

/** Main-owned scan snapshot. Renderer never chooses the physical deletion target. */
export interface LocalSkillTarget {
  sourcePath: string;
  operationPath: string;
  linkOnly: boolean;
  identity: string;
  aliases: string[];
}

const skillDiscoveryRoot = /(?:^|\/)(?:\.(?:claude|agents|codex|pi)\/skills|\.pi\/agent\/skills|(?:codex-home|pi-agent-home)\/skills)(?=\/|$)/i;

function standalonePathParts(value: string): { root: string; relative: string[] } | null {
  const normalized = path.resolve(value).replace(/\\/g, '/');
  const match = skillDiscoveryRoot.exec(normalized);
  if (!match) return null;
  const rootEnd = (match.index ?? 0) + match[0].length;
  const relative = normalized.slice(rootEnd).split('/').filter(Boolean);
  if (!relative.length || relative.some((segment) => segment.startsWith('.'))) return null;
  return { root: normalized.slice(0, rootEnd), relative };
}

function isStandaloneSkillPath(value: string): boolean {
  return standalonePathParts(value) !== null;
}

function isDirectSkillEntry(value: string): boolean {
  const parts = standalonePathParts(value);
  if (!parts) return false;
  let current = path.resolve(value);
  const discoveryRoot = path.dirname(path.resolve(parts.root));
  const ownerRoot = path.basename(discoveryRoot).toLowerCase() === 'agent'
    ? path.dirname(path.dirname(discoveryRoot))
    : path.dirname(discoveryRoot);
  // Check the entry, namespace segments and every discovery-layout segment.
  // The owner prefix may itself be a tracked project alias.
  while (current !== ownerRoot) {
    if (fs.lstatSync(current).isSymbolicLink()) return false;
    current = path.dirname(current);
  }
  return true;
}

function targetIdentity(operationPath: string): string {
  const entry = fs.lstatSync(operationPath);
  const source = fs.realpathSync.native(operationPath);
  const physical = fs.statSync(source);
  return JSON.stringify([source, entry.dev, entry.ino, physical.dev, physical.ino]);
}

/** Ownership comes from Host-managed roots, never a link name or a directory-name heuristic. */
export function isPluginManagedSkillPath(source: string, managedRoots: readonly string[]): boolean {
  const canonical = (value: string) => {
    let resolved = path.resolve(value);
    try { resolved = fs.realpathSync.native(resolved); } catch { /* Missing roots have no live targets. */ }
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  const target = canonical(source);
  return managedRoots.some((root) => {
    const relative = path.relative(canonical(root), target);
    return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
  });
}

/** Only standalone Skill entities may be trashed; never an enclosing package or discovery root. */
export function inspectLocalSkillTarget(source: string, discoveryPaths: readonly string[], managedRoots: readonly string[] = []): LocalSkillTarget | null {
  try {
    const sourcePath = fs.realpathSync.native(source);
    if (isPluginManagedSkillPath(sourcePath, managedRoots)) return null;
    const stat = fs.statSync(sourcePath);
    if (stat.isDirectory()) {
      if (!['SKILL.md', 'skill.md'].some((name) => fs.statSync(path.join(sourcePath, name), { throwIfNoEntry: false })?.isFile())) return null;
    } else if (!stat.isFile() || !sourcePath.toLowerCase().endsWith('.md')) return null;
    const aliases = [...new Set(discoveryPaths.map((value) => path.resolve(value)))].filter((value) => {
      try { return isStandaloneSkillPath(value) && fs.realpathSync.native(value) === sourcePath; }
      catch { return false; }
    });
    let operationPath = sourcePath;
    let linkOnly = false;
    const hasDirectEntry = aliases.some(isDirectSkillEntry);
    if (!isStandaloneSkillPath(sourcePath) || !hasDirectEntry) {
      // A link into an external checkout is an import reference, not ownership of that checkout.
      // The checkout's own directory layout does not establish local ownership.
      const externalLink = aliases.find((value) => fs.lstatSync(value).isSymbolicLink());
      if (!externalLink) return null;
      operationPath = externalLink;
      linkOnly = true;
    }
    return { sourcePath, operationPath, linkOnly, identity: targetIdentity(operationPath), aliases };
  } catch { return null; }
}

export function isLocalSkillTargetCurrent(target: LocalSkillTarget): boolean {
  try { return targetIdentity(target.operationPath) === target.identity; }
  catch { return false; }
}
