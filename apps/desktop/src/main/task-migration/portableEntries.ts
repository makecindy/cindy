import path from 'node:path';
import type { FileEvidence } from '../worktree/recoveryArchiveIO';

/** Why one project entry was left out of a task copy. */
export type SkipCode =
  | 'MIGRATION_NONPORTABLE_PATH'
  | 'MIGRATION_PATH_COLLISION'
  | 'MIGRATION_EXTERNAL_LINK'
  | 'MIGRATION_UNSUPPORTED_ENTRY';
/** `path` is project-relative and `/`-separated; a skipped directory stands for its whole subtree. */
export interface SkippedEntry {
  path: string;
  code: SkipCode;
}

// Same bound as POSIX SYMLOOP_MAX on common systems.
const MAX_LINK_HOPS = 40;

function nonportable(name: string): boolean {
  const parts = name.split('/');
  return (
    !name ||
    name.length > 4096 ||
    name.includes('\\') ||
    parts.some(
      (part) =>
        !part ||
        part === '.' ||
        part === '..' ||
        part.toLowerCase() === '.git' ||
        // eslint-disable-next-line no-control-regex -- control characters are not portable names.
        /[\x00-\x1f:*?"<>|]/.test(part) ||
        /[ .]$/.test(part) ||
        /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part),
    )
  );
}

function unsafeLinkText(target: string): boolean {
  return (
    !target || target.includes('\\') || path.posix.isAbsolute(target) || /^[a-z]:/i.test(target)
  );
}

/** Case- and normalization-insensitive key: the target filesystem may fold either way. */
const fold = (name: string) => name.normalize('NFC').toLowerCase();

function ancestorsOf(name: string): string[] {
  const parts = name.split('/');
  return parts.slice(0, -1).map((_, index) => parts.slice(0, index + 1).join('/'));
}

/**
 * Resolve `link` the way the filesystem would, following links through `folded` (kept
 * entries by `fold`ed path, so a case variant cannot slip past a link on a folding target).
 * Inside means every step stays under the root and never touches `.git`; a missing
 * component is fine (a dangling link cannot reach anything), so it continues lexically.
 */
function linkStaysInside(folded: Map<string, FileEvidence>, link: string): boolean {
  const resolved = link.split('/').slice(0, -1);
  let pending = folded.get(fold(link))!.hash.split('/');
  let hops = 0;
  while (pending.length) {
    const part = pending.shift()!;
    if (!part || part === '.') continue;
    if (part === '..') {
      if (!resolved.length) return false;
      resolved.pop();
      continue;
    }
    if (part.toLowerCase() === '.git') return false;
    resolved.push(part);
    const entry = folded.get(fold(resolved.join('/')));
    if (entry?.kind !== 'link') continue;
    if (++hops > MAX_LINK_HOPS || unsafeLinkText(entry.hash)) return false;
    resolved.pop();
    pending = [...entry.hash.split('/'), ...pending];
  }
  return true;
}

function assertEvidence(entry: FileEvidence | undefined): void {
  if (
    !entry ||
    !['file', 'directory', 'link'].includes(entry.kind) ||
    !Number.isInteger(entry.mode) ||
    entry.mode < 0 ||
    entry.mode > 0o777 ||
    typeof entry.hash !== 'string' ||
    (entry.kind === 'file' && !/^[a-f0-9]{64}$/.test(entry.hash)) ||
    (entry.kind === 'directory' && entry.hash !== '')
  )
    throw new Error('MIGRATION_INVALID_MANIFEST');
}

/**
 * Split a workspace inventory into what a copy can carry and what it leaves behind.
 * Keys may use the platform separator; kept keys are returned unchanged. Only links whose
 * resolution leaves the root are refused — chains and dangling links inside it are copied
 * as they are. A malformed manifest still throws: that is corruption, not a project entry.
 */
export function selectPortableEntries(
  files: Record<string, FileEvidence>,
  unsupported: readonly string[] = [],
  separator = path.sep,
): { files: Record<string, FileEvidence>; skipped: SkippedEntry[] } {
  const posix = (name: string) => (separator === '/' ? name : name.split(separator).join('/'));
  const byPosix: Record<string, FileEvidence> = Object.create(null);
  for (const [name, entry] of Object.entries(files)) {
    assertEvidence(entry);
    byPosix[posix(name)] = entry;
  }
  const reason = new Map<string, SkipCode>();
  // A skipped directory takes its subtree with it: those entries are neither kept nor reported.
  const dropped = (name: string) => ancestorsOf(name).some((ancestor) => reason.has(ancestor));
  // Parents decide first, so a skipped directory's subtree never competes with what is kept.
  const byDepth = Object.keys(byPosix).sort((a, b) => a.split('/').length - b.split('/').length);
  const folded = new Map<string, FileEvidence>();
  for (const name of byDepth) {
    if (dropped(name)) continue;
    if (nonportable(name)) reason.set(name, 'MIGRATION_NONPORTABLE_PATH');
    else if (folded.has(fold(name))) reason.set(name, 'MIGRATION_PATH_COLLISION');
    else folded.set(fold(name), byPosix[name]);
  }
  // Resolve links against what the target will hold; a link into a skipped entry just dangles.
  for (const name of byDepth) {
    const entry = byPosix[name];
    if (entry.kind !== 'link' || reason.has(name) || dropped(name)) continue;
    if (unsafeLinkText(entry.hash) || !linkStaysInside(folded, name))
      reason.set(name, 'MIGRATION_EXTERNAL_LINK');
  }
  const skipped: SkippedEntry[] = unsupported
    .map(posix)
    .filter((name) => !dropped(name))
    .map((name) => ({ path: name, code: 'MIGRATION_UNSUPPORTED_ENTRY' }));
  const kept: Record<string, FileEvidence> = Object.create(null);
  for (const [name, entry] of Object.entries(files)) {
    const relative = posix(name);
    if (dropped(relative)) continue;
    const code = reason.get(relative);
    if (code) {
      skipped.push({ path: relative, code });
      continue;
    }
    if (ancestorsOf(relative).some((ancestor) => byPosix[ancestor]?.kind !== 'directory'))
      throw new Error('MIGRATION_INVALID_MANIFEST');
    kept[name] = entry;
  }
  return { files: kept, skipped };
}
