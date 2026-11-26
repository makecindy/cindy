/**
 * Filesystem boundary verification for ACP tool permission requests.
 *
 * Keeps external ACP harnesses aligned with Cindy's built-in engine boundaries:
 * - Write/delete/move requests outside the task working directory and current
 *   `writableDirs` (or targeting sensitive credential paths / read-only library
 *   roots / dangling symlinks) are never auto-approved.
 * - Read-only `/review` mode permits only `read` / `search` tool calls whose
 *   targets resolve inside the granted review read scope and do not touch
 *   sensitive credential paths or escape via globs/symlinks/hard links.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  resolveReviewReadPath,
  type ReviewReadGrant,
} from '../shared/review-read-scope.js';
import {
  isReviewSensitiveCredentialSelector,
  isSensitiveCredentialPath,
} from '../shared/sensitive-credential-paths.js';
import type { AcpToolCallFields } from './protocol.js';

const WRITE_TOOL_KINDS: ReadonlySet<string> = new Set(['edit', 'delete', 'move']);
const REVIEW_READ_TOOL_KINDS: ReadonlySet<string> = new Set(['read', 'search']);

const SINGLE_PATH_KEYS: readonly string[] = [
  'path',
  'file_path',
  'filePath',
  'target_path',
  'targetPath',
  'destination',
  'dest',
  'dst',
  'new_path',
  'newPath',
  'old_path',
  'oldPath',
  'source',
  'src',
  'notebook_path',
  'notebookPath',
  'directory',
  'dir',
  'filename',
  'file',
  'cwd',
  'workdir',
  'root',
  'folder',
];

const ARRAY_PATH_KEYS: readonly string[] = [
  'paths',
  'files',
  'targets',
  'file_paths',
  'filePaths',
  'directories',
  'dirs',
];

const MOVE_EXTRA_PATH_KEYS: readonly string[] = ['from', 'to'];
const NESTED_EDIT_LIST_KEYS: readonly string[] = ['edits', 'changes', 'operations'];
const SEARCH_SELECTOR_KEYS: readonly string[] = [
  'glob',
  'include',
  'file_pattern',
  'filePattern',
  'file_glob',
  'fileGlob',
  'filter',
];
const SEARCH_SELECTOR_ARRAY_KEYS: readonly string[] = ['globs', 'includes'];

const MAX_ANCESTOR_STEPS = 64;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function isAcpWriteToolKind(kind: string | undefined): boolean {
  return typeof kind === 'string' && WRITE_TOOL_KINDS.has(kind);
}

function isPathInsideRoot(candidate: string, root: string): boolean {
  const compareRoot = process.platform === 'win32' ? root.toLowerCase() : root;
  const compareCandidate = process.platform === 'win32' ? candidate.toLowerCase() : candidate;
  const relative = path.relative(compareRoot, compareCandidate);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== '..' &&
      !path.isAbsolute(relative))
  );
}

function normalizeLocalPath(rawPath: string, cwd: string): string | null {
  const value = rawPath.trim();
  if (!value || value.includes('\0')) return null;
  if (path.isAbsolute(value)) return path.normalize(value);
  if (/^file:/i.test(value)) {
    try {
      return path.normalize(fileURLToPath(value));
    } catch {
      return null;
    }
  }
  // Refuse URL-like schemes instead of letting path.resolve turn them into misleading local paths.
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return null;
  return path.resolve(cwd, value);
}

/**
 * Resolves the canonical filesystem target a write/delete/move would touch.
 * Existing paths resolve through `realpath`; missing paths walk up to the
 * nearest existing ancestor and fail closed on dangling/circular symlinks.
 */
async function resolveWriteTargetPath(candidate: string): Promise<string | null> {
  if (!candidate || candidate.includes('\0')) return null;
  try {
    return await fs.realpath(candidate);
  } catch {
    try {
      // Target exists lexically (for example a dangling symlink) yet failed realpath: fail closed.
      await fs.lstat(candidate);
      return null;
    } catch (lstatError) {
      const code = (lstatError as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') return null;
    }
    let dir = path.dirname(candidate);
    for (let i = 0; i < MAX_ANCESTOR_STEPS; i += 1) {
      try {
        const realDir = await fs.realpath(dir);
        return path.join(realDir, path.relative(dir, candidate));
      } catch {
        try {
          await fs.lstat(dir);
          return null;
        } catch (lstatError) {
          const code = (lstatError as NodeJS.ErrnoException).code;
          if (code !== 'ENOENT' && code !== 'ENOTDIR') return null;
        }
        const parent = path.dirname(dir);
        if (parent === dir) return null;
        dir = parent;
      }
    }
    return null;
  }
}

function collectPathsFromRecord(
  record: Record<string, unknown>,
  includeMoveKeys: boolean,
  paths: string[],
): boolean {
  let unverifiable = false;
  const singleKeys = includeMoveKeys
    ? [...SINGLE_PATH_KEYS, ...MOVE_EXTRA_PATH_KEYS]
    : SINGLE_PATH_KEYS;
  for (const key of singleKeys) {
    if (!Object.hasOwn(record, key)) continue;
    const value = record[key];
    if (value === undefined || value === null) continue;
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (trimmed) paths.push(trimmed);
      else unverifiable = true;
    } else if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === 'string' && item.trim()) paths.push(item.trim());
        else unverifiable = true;
      }
    } else if (!MOVE_EXTRA_PATH_KEYS.includes(key)) {
      unverifiable = true;
    }
  }
  for (const key of ARRAY_PATH_KEYS) {
    if (!Object.hasOwn(record, key)) continue;
    const value = record[key];
    if (value === undefined || value === null) continue;
    if (!Array.isArray(value)) {
      unverifiable = true;
      continue;
    }
    for (const item of value) {
      if (typeof item === 'string' && item.trim()) paths.push(item.trim());
      else unverifiable = true;
    }
  }
  for (const key of NESTED_EDIT_LIST_KEYS) {
    if (!Object.hasOwn(record, key)) continue;
    const value = record[key];
    if (!Array.isArray(value)) continue;
    for (const entry of value) {
      if (isPlainObject(entry)) {
        if (collectPathsFromRecord(entry, includeMoveKeys, paths)) unverifiable = true;
      }
    }
  }
  return unverifiable;
}

export function extractAcpToolCallPaths(
  toolCall: Pick<AcpToolCallFields, 'kind' | 'locations' | 'rawInput'>,
): { paths: string[]; unverifiable: boolean } {
  const paths: string[] = [];
  let unverifiable = false;
  if (toolCall.locations) {
    for (const loc of toolCall.locations) {
      if (typeof loc.path === 'string' && loc.path.trim()) {
        paths.push(loc.path.trim());
      }
    }
  }
  if (toolCall.rawInput !== undefined) {
    if (!isPlainObject(toolCall.rawInput)) {
      unverifiable = true;
    } else if (collectPathsFromRecord(toolCall.rawInput, toolCall.kind === 'move', paths)) {
      unverifiable = true;
    }
  }
  return { paths: [...new Set(paths)], unverifiable };
}

/**
 * Verifies every target path of a write/delete/move tool call resolves inside
 * `cwd` or one of the currently granted `writableDirs`, excluding sensitive
 * credential paths and any read-only plugin library root.
 */
export async function isAcpWriteWithinAllowedDirs(
  toolCall: Pick<AcpToolCallFields, 'kind' | 'locations' | 'rawInput'>,
  cwd: string,
  writableDirs: readonly string[],
  libraryRoot?: string | null,
): Promise<boolean> {
  const { paths, unverifiable } = extractAcpToolCallPaths(toolCall);
  if (unverifiable || paths.length === 0) return false;

  const normalizedCwd = normalizeLocalPath(cwd, cwd);
  if (!normalizedCwd) return false;
  const realCwd = await resolveWriteTargetPath(normalizedCwd);
  if (!realCwd) return false;

  const allowedRoots: string[] = [realCwd];
  for (const dir of writableDirs) {
    const normalizedDir = normalizeLocalPath(dir, cwd);
    if (!normalizedDir) continue;
    const realDir = await resolveWriteTargetPath(normalizedDir);
    if (realDir) allowedRoots.push(realDir);
  }

  let realLibraryRoot: string | null = null;
  if (typeof libraryRoot === 'string' && libraryRoot.trim()) {
    const normalizedLib = normalizeLocalPath(libraryRoot, cwd);
    if (normalizedLib) {
      realLibraryRoot = (await resolveWriteTargetPath(normalizedLib)) ?? normalizedLib;
    }
  }

  for (const raw of paths) {
    if (isSensitiveCredentialPath(raw)) return false;
    const candidate = normalizeLocalPath(raw, cwd);
    if (!candidate || isSensitiveCredentialPath(candidate)) return false;
    const resolved = await resolveWriteTargetPath(candidate);
    if (!resolved || isSensitiveCredentialPath(resolved)) return false;
    if (realLibraryRoot && isPathInsideRoot(resolved, realLibraryRoot)) return false;
    if (!allowedRoots.some((root) => isPathInsideRoot(resolved, root))) return false;
  }
  return true;
}

function reviewGlobPatternEscapesScope(pattern: string): boolean {
  const value = pattern.trim();
  if (!value) return false;
  if (path.isAbsolute(value) || path.win32.isAbsolute(value)) return true;
  if (/[\\[\]]/.test(value) || value.includes('..')) return true;
  return /(^|[{(,|])(?:\/|[a-zA-Z]:\/)/.test(value);
}

function reviewFileSelectorIsAllowed(selector: unknown): selector is string {
  return (
    typeof selector === 'string' &&
    !reviewGlobPatternEscapesScope(selector) &&
    !isReviewSensitiveCredentialSelector(selector)
  );
}

function isFileFinderSearchTool(toolCall: Pick<AcpToolCallFields, 'name' | 'title'>): boolean {
  const label = `${toolCall.name ?? ''} ${toolCall.title ?? ''}`;
  if (/\b(grep|ripgrep|rg|grep_search|search_content)\b/i.test(label)) return false;
  return /\b(glob|find_by_name|find_files|find|ls|list_dir|list_files)\b/i.test(label);
}

/**
 * Mandatory read-only `/review` permission check for ACP tool calls.
 * Fails closed on any non-read/search kind, unverifiable input, escaping file
 * selector, sensitive credential path, hard-link escape, or path outside the
 * granted `ReviewReadGrant[]` scope.
 */
export async function isAcpReviewToolCallAllowed(
  toolCall: Pick<AcpToolCallFields, 'kind' | 'name' | 'title' | 'locations' | 'rawInput'>,
  cwd: string,
  grants: readonly ReviewReadGrant[],
): Promise<boolean> {
  if (!toolCall.kind || !REVIEW_READ_TOOL_KINDS.has(toolCall.kind)) return false;
  const { paths, unverifiable } = extractAcpToolCallPaths(toolCall);
  if (unverifiable) return false;

  if (toolCall.kind === 'search' && isPlainObject(toolCall.rawInput)) {
    for (const key of SEARCH_SELECTOR_KEYS) {
      if (!Object.hasOwn(toolCall.rawInput, key)) continue;
      const value = toolCall.rawInput[key];
      if (value !== undefined && value !== null && !reviewFileSelectorIsAllowed(value)) {
        return false;
      }
    }
    for (const key of SEARCH_SELECTOR_ARRAY_KEYS) {
      if (!Object.hasOwn(toolCall.rawInput, key)) continue;
      const value = toolCall.rawInput[key];
      if (value === undefined || value === null) continue;
      if (!Array.isArray(value) || !value.every((entry) => reviewFileSelectorIsAllowed(entry))) {
        return false;
      }
    }
    if (
      isFileFinderSearchTool(toolCall) &&
      Object.hasOwn(toolCall.rawInput, 'pattern') &&
      toolCall.rawInput.pattern !== undefined &&
      toolCall.rawInput.pattern !== null &&
      !reviewFileSelectorIsAllowed(toolCall.rawInput.pattern)
    ) {
      return false;
    }
  }

  if (toolCall.kind === 'read' && paths.length === 0) return false;
  const targets = paths.length > 0 ? paths : [cwd];
  for (const raw of targets) {
    const resolved = await resolveReviewReadPath(raw, cwd, grants);
    if (!resolved) return false;
  }
  return true;
}
