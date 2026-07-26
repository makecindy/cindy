import path from 'node:path';
import { statSync } from 'node:fs';
import { lstat, mkdir, readdir, realpath } from 'node:fs/promises';
import {
  createFile,
  createFolder,
  deleteEntry,
  listAllFiles,
  listDir,
  loadIgnoreMatcher,
  readFile,
  renameEntry,
  statEntry,
  writeFile,
} from '@cindy/file-browser-core';
import type { HeadlessConfigStore } from './config.js';
import type { HeadlessSessionStorageContract } from './session-types.js';
import { isRemoteWorkdirAllowed } from './workdir-guard.js';

/**
 * Headless implementation of the established Device Link file-browser
 * aggregate channel. It uses the shared core so path, symlink, ignore and
 * size rules stay aligned with Desktop.
 */
export class HeadlessFileBrowserService {
  constructor(
    private readonly config: HeadlessConfigStore,
    private readonly sessions: HeadlessSessionStorageContract,
    private readonly rgPath?: string,
  ) {}

  async remoteOp(input: unknown): Promise<unknown> {
    const args = parseArgs(input);
    if (args.op === 'caps') return { ok: true, gzip: false };
    if (!await isRemoteWorkdirAllowed(this.config, args.workdir)) throw new Error(`workdir not allowed: ${args.workdir}`);
    switch (args.op) {
      case 'listDir': {
        const matcher = await loadIgnoreMatcher(args.workdir, { hideMetaFiles: args.hideMetaFiles ?? true, honorVcsIgnore: false });
        return listDir(args.workdir, args.relPath ?? '', matcher, { docMode: args.docMode });
      }
      case 'readFile': return readResult(args.workdir, args.relPath ?? '');
      case 'stat': return statEntry(args.workdir, args.relPath ?? '');
      case 'writeFile': return wrapWrite(() => writeFile(args.workdir, required(args.relPath, 'relPath'), args.content ?? ''));
      case 'createFile': return wrapWrite(async () => ({ stat: await createFile(args.workdir, required(args.relPath, 'relPath')) }));
      case 'createFolder': return wrapWrite(async () => ({ stat: await createFolder(args.workdir, required(args.relPath, 'relPath')) }));
      case 'renameEntry': return wrapWrite(async () => ({ stat: await renameEntry(args.workdir, required(args.fromRel, 'fromRel'), required(args.toRel, 'toRel')) }));
      case 'deleteEntry': return wrapWrite(async () => { await deleteEntry(args.workdir, required(args.relPath, 'relPath')); return {}; });
      case 'listAllFiles': {
        const rgPath = this.rgPath ?? resolveRipgrepBinary();
        if (!rgPath) return { files: [], truncated: false, elapsedMs: 0, error: 'ripgrep executable is unavailable' };
        return listAllFiles({ workdir: args.workdir, rgPath, ...(args.cap ? { cap: args.cap } : {}) });
      }
      default: return { ok: false, message: `unknown op: ${args.op}` };
    }
  }

  /** Narrow preview endpoint: absolute paths still have to be under a user-granted root. */
  async preview(absolutePath: unknown): Promise<unknown> {
    if (typeof absolutePath !== 'string' || !path.isAbsolute(absolutePath)) return { ok: false, code: 'INVALID_PATH' };
    const config = await this.config.read();
    for (const root of config.workdirRoots ?? []) {
      if (isInside(root, absolutePath) && await isRemoteWorkdirAllowed(this.config, root)) {
        return readResult(root, path.relative(root, absolutePath));
      }
    }
    // Keep the storage dependency explicit: a session's path remains metadata,
    // never an implicit authorization grant for a mobile controller.
    await this.sessions.list();
    return { ok: false, code: 'FORBIDDEN' };
  }

  /**
   * Compatibility endpoints for Mobile's pre-file-browser project picker.
   * They deliberately retain the same root guard as the richer remote-op
   * endpoint: an absolute path is never an authority grant by itself.
   */
  async listLegacyDirectory(requestedPath: string): Promise<unknown> {
    const resolvedPath = await this.resolveApprovedPath(requestedPath);
    const entries = await readdir(resolvedPath, { withFileTypes: true });
    const result = entries.map((entry) => ({
      name: entry.name,
      kind: entry.isDirectory() ? 'dir' : entry.isSymbolicLink() ? 'symlink' : 'file',
      path: path.join(resolvedPath, entry.name),
    })).sort((left, right) => left.name.localeCompare(right.name));
    return {
      resolvedPath,
      entries: result,
      parent: await this.parentWithinApprovedRoot(resolvedPath),
    };
  }

  async statLegacyPath(requestedPath: string): Promise<unknown> {
    const expandedPath = expandHomeDirectory(requestedPath);
    try {
      const resolvedPath = await this.resolveApprovedPath(expandedPath);
      const entry = await lstat(resolvedPath);
      return { kind: entry.isDirectory() ? 'dir' : 'file', resolvedPath };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        const resolvedPath = path.resolve(expandedPath);
        await this.assertMissingPathCanBeCreated(resolvedPath);
        return { kind: 'missing', resolvedPath };
      }
      throw error;
    }
  }

  async mkdirLegacyPath(requestedPath: string): Promise<{ resolvedPath: string }> {
    const destination = path.resolve(expandHomeDirectory(requestedPath));
    await this.assertMissingPathCanBeCreated(destination);
    await mkdir(destination, { recursive: true, mode: 0o700 });
    return { resolvedPath: await this.resolveApprovedPath(destination) };
  }

  private async resolveApprovedPath(requestedPath: string): Promise<string> {
    requestedPath = expandHomeDirectory(requestedPath);
    if (!path.isAbsolute(requestedPath)) throw new Error('path must be absolute');
    const resolvedPath = await realpath(requestedPath);
    if (!await isRemoteWorkdirAllowed(this.config, resolvedPath)) throw new Error('path is outside an allowed remote project root');
    return resolvedPath;
  }

  private async parentWithinApprovedRoot(resolvedPath: string): Promise<string | null> {
    const parent = path.dirname(resolvedPath);
    if (parent === resolvedPath || !await isRemoteWorkdirAllowed(this.config, parent)) return null;
    return parent;
  }

  /** For mkdir/stat of a missing path, resolve its nearest existing parent first to defeat symlink escapes. */
  private async assertMissingPathCanBeCreated(destination: string): Promise<void> {
    if (!path.isAbsolute(destination)) throw new Error('path must be absolute');
    let existing = destination;
    while (true) {
      try {
        existing = await realpath(existing);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        const parent = path.dirname(existing);
        if (parent === existing) throw new Error('path has no existing parent');
        existing = parent;
      }
    }
    if (!await isRemoteWorkdirAllowed(this.config, existing)) {
      throw new Error('path is outside an allowed remote project root');
    }
  }
}

/** Mobile's established project picker starts at `~`; expand only this shell-style home shorthand. */
function expandHomeDirectory(requestedPath: string): string {
  if (requestedPath !== '~' && !requestedPath.startsWith('~/')) return requestedPath;
  const home = process.env.HOME?.trim();
  if (!home || !path.isAbsolute(home)) throw new Error('home directory is unavailable');
  return requestedPath === '~' ? home : path.join(home, requestedPath.slice(2));
}

type RemoteOpArgs = { op: string; workdir: string; relPath?: string; fromRel?: string; toRel?: string; content?: string; hideMetaFiles?: boolean; docMode?: boolean; cap?: number };

function parseArgs(input: unknown): RemoteOpArgs {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('invalid remote-op args');
  const value = input as Record<string, unknown>;
  if (typeof value.op !== 'string' || !value.op) throw new Error('invalid remote-op args');
  if (value.op === 'caps') return { op: 'caps', workdir: '' };
  if (typeof value.workdir !== 'string' || !path.isAbsolute(value.workdir)) throw new Error('workdir must be an absolute path');
  for (const key of ['relPath', 'fromRel', 'toRel', 'content'] as const) if (value[key] !== undefined && typeof value[key] !== 'string') throw new Error(`${key} must be a string`);
  if (value.hideMetaFiles !== undefined && typeof value.hideMetaFiles !== 'boolean') throw new Error('hideMetaFiles must be a boolean');
  if (value.docMode !== undefined && typeof value.docMode !== 'boolean') throw new Error('docMode must be a boolean');
  if (value.cap !== undefined && (typeof value.cap !== 'number' || !Number.isInteger(value.cap) || value.cap < 1 || value.cap > 20_000)) throw new Error('cap must be an integer between 1 and 20000');
  return value as RemoteOpArgs;
}

async function readResult(workdir: string, relPath: string): Promise<unknown> {
  try { return { ok: true, data: await readFile(workdir, relPath) }; } catch (error) {
    return (error as Error & { code?: string }).code === 'BINARY_FILE'
      ? { ok: false, code: 'BINARY_FILE' }
      : { ok: false, code: 'READ_FAILED', message: error instanceof Error ? error.message : String(error) };
  }
}

async function wrapWrite(action: () => Promise<Record<string, unknown>>): Promise<unknown> {
  try { return { ok: true, ...await action() }; } catch (error) { return { ok: false, message: error instanceof Error ? error.message : String(error) }; }
}

function required(value: string | undefined, field: string): string { if (!value) throw new Error(`${field} must be a non-empty string`); return value; }
function isInside(root: string, candidate: string): boolean { const relative = path.relative(root, candidate); return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)); }

function resolveRipgrepBinary(env: NodeJS.ProcessEnv = process.env): string | null {
  const configured = env.CINDY_RIPGREP_BINARY?.trim();
  if (configured && isExecutable(configured)) return configured;
  for (const directory of (env.PATH ?? '').split(path.delimiter)) {
    const candidate = path.join(directory, 'rg');
    if (isExecutable(candidate)) return candidate;
  }
  return null;
}

function isExecutable(file: string): boolean {
  try { return path.isAbsolute(file) && statSync(file).isFile() && (statSync(file).mode & 0o111) !== 0; } catch { return false; }
}
