import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { ProjectDirectory } from '@cindy/maker-shared/project-alias-sync';
import { throwIpcError } from './utils/ipcValidate.js';

type RemoteDirectoryProbe = (host: string, directory: string) => Promise<boolean>;
let remoteProbe: RemoteDirectoryProbe | undefined;
export function configureProjectDirectoryProbe(probe: RemoteDirectoryProbe): void {
  remoteProbe = probe;
}

/** Validate paths on the owning host, including symlink aliases and overlapping grants. */
export async function validateProjectDirectories(
  projectKey: string,
  directories: readonly ProjectDirectory[],
): Promise<void> {
  const remote = projectKey.startsWith('remote:');
  const separator = remote ? projectKey.indexOf(':', 7) : -1;
  const host = remote ? decodeURIComponent(projectKey.slice(7, separator)) : null;
  const root = remote ? projectKey.slice(separator + 1) : projectKey.slice(6);
  const paths = remote ? path.posix : path;
  const canonical = async (directory: string): Promise<string> => {
    if (!paths.isAbsolute(directory)) throwIpcError('INVALID_PARAMS', 'Directory must be absolute');
    if (host) {
      if (!remoteProbe) throwIpcError('UNSUPPORTED_CAPABILITY', 'SSH directory access unavailable');
      if (!(await remoteProbe(host, directory)))
        throwIpcError('INVALID_PARAMS', 'Directory does not exist');
      return paths.normalize(directory);
    }
    if (!(await fs.stat(directory)).isDirectory())
      throwIpcError('INVALID_PARAMS', 'Not a directory');
    const resolved = await fs.realpath(directory);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  const main = await canonical(root);
  const seen: string[] = [main];
  const contains = (parent: string, child: string) => {
    const relative = paths.relative(parent, child);
    return (
      !relative ||
      (!paths.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${paths.sep}`))
    );
  };
  for (const directory of directories) {
    const resolved = await canonical(directory.path);
    if (seen.some((previous) => contains(previous, resolved) || contains(resolved, previous)))
      throwIpcError('INVALID_PARAMS', 'Project directories must not overlap');
    seen.push(resolved);
  }
}
