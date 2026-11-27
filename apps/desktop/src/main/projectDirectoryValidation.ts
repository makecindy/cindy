import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { ProjectDirectory } from '@cindy/maker-shared/project-alias-sync';
import { throwIpcError } from './utils/ipcValidate.js';

type RemoteDirectoryProbe = (host: string, directory: string) => Promise<string>;
let remoteProbe: RemoteDirectoryProbe | undefined;
export function configureProjectDirectoryProbe(probe: RemoteDirectoryProbe): void {
  remoteProbe = probe;
}

export function sameProjectDirectory(a: string, b: string, remote = false): boolean {
  return (remote ? path.posix : path).relative(a, b) === '';
}

export function requireCanonicalProjectDirectory(
  requested: string,
  actual: string,
  remote = false,
): void {
  if (!sameProjectDirectory(requested, actual, remote))
    throwIpcError(
      'WRITABLE_DIRECTORY_TARGET_CHANGED',
      `Select or submit the actual directory: ${actual}`,
    );
}

async function resolveDirectory(host: string | null, directory: string): Promise<string> {
  const paths = host ? path.posix : path;
  if (!paths.isAbsolute(directory) || /[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/u.test(directory))
    throwIpcError('INVALID_PARAMS', 'Invalid project directory path');
  let resolved: string;
  if (host) {
    if (!remoteProbe) throwIpcError('UNSUPPORTED_CAPABILITY', 'SSH directory access unavailable');
    resolved = await remoteProbe(host, directory);
  } else {
    resolved = await fs.realpath(directory);
    if (!(await fs.stat(resolved)).isDirectory())
      throwIpcError('INVALID_PARAMS', 'Not a directory');
  }
  if (
    !paths.isAbsolute(resolved) ||
    /[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/u.test(resolved) ||
    resolved !== resolved.trim()
  )
    throwIpcError('INVALID_PARAMS', 'Invalid resolved project directory');
  return resolved;
}

/** Each entry contains the names of a single root (selected and physical). */
export function assertDisjointProjectPaths(selections: readonly string[][], remote: boolean): void {
  const paths = remote ? path.posix : path;
  const contains = (parent: string, child: string) => {
    const relative = paths.relative(parent, child);
    return (
      !relative ||
      (!paths.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${paths.sep}`))
    );
  };
  const seen: string[] = [];
  for (const paths of selections) {
    if (paths.some((p) => seen.some((q) => contains(p, q) || contains(q, p))))
      throwIpcError('INVALID_PARAMS', 'Project directories must not overlap');
    seen.push(...paths);
  }
}

/** Compare both the selection and its target. Only a trusted SSH confirmation may approve an alias inline. */
export async function validateProjectDirectories(
  projectKey: string,
  directories: readonly ProjectDirectory[],
  confirmResolved = false,
): Promise<ProjectDirectory[]> {
  if (!directories.length) return [];
  const remote = projectKey.startsWith('remote:');
  const separator = remote ? projectKey.indexOf(':', 7) : -1;
  const host = remote ? decodeURIComponent(projectKey.slice(7, separator)) : null;
  const root = remote ? projectKey.slice(separator + 1) : projectKey.slice(6);
  const selections = root ? [[root, await resolveDirectory(host, root)]] : [];
  const result: ProjectDirectory[] = [];
  for (const directory of directories) {
    const resolved = await resolveDirectory(host, directory.path);
    selections.push([directory.path, resolved]);
    result.push({ path: resolved, access: directory.access });
  }
  assertDisjointProjectPaths(selections, remote);
  if (!confirmResolved)
    result.forEach((item, i) =>
      requireCanonicalProjectDirectory(directories[i]!.path, item.path, remote),
    );
  return result;
}
