import { lstat, readlink, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { isPathInsideDir } from '../cindy-brain/dirDeposit.js';
import { PluginTaskError } from './pluginTaskService.js';

function localDirectory(directory: string): string {
  // Preserve the supported local-drive long-path spelling, never UNC devices.
  if (process.platform === 'win32') directory = directory.replace(/^\\\\\?\\(?=[A-Za-z]:\\)/, '');
  // Reject UNC, Win32 device and NT namespace paths before filesystem APIs can
  // open an SMB/WebDAV connection (including slash/mixed-separator spellings).
  if (!path.isAbsolute(directory) || directory.includes('\0') || /^(?:[\\/]{2}|[\\/]\?\?[\\/])/.test(directory)) {
    throw new PluginTaskError('PERMISSION_DENIED', 'Plugin task directory must be a local absolute path');
  }
  return path.normalize(directory);
}

// Inspect each Windows link before any API follows it. This handles existing
// network links, not concurrent directory replacement or mapped network drives.
async function localRealpath(directory: string): Promise<string> {
  if (process.platform !== 'win32') return localDirectory(await realpath(directory));
  let remaining = localDirectory(directory);
  for (let hops = 0; hops < 40; hops += 1) {
    const root = path.parse(remaining).root;
    const parts = remaining.slice(root.length).split(path.sep).filter(Boolean);
    let current = root;
    let redirected = false;
    for (let index = 0; index < parts.length; index += 1) {
      current = path.join(current, parts[index]!);
      if (!(await lstat(current)).isSymbolicLink()) continue;
      const target = await readlink(current);
      // Absolute link targets pass the raw namespace check before normalization.
      // Drive-relative targets depend on process state rather than this directory.
      if (/^[A-Za-z]:/.test(target) && !path.isAbsolute(target)) {
        throw new PluginTaskError('PERMISSION_DENIED', 'Plugin task link must have a local unambiguous target');
      }
      const checkedTarget = path.isAbsolute(target) ? localDirectory(target) : target;
      const localTarget = localDirectory(path.resolve(path.dirname(current), checkedTarget));
      remaining = path.join(localTarget, ...parts.slice(index + 1));
      redirected = true;
      break;
    }
    if (!redirected) return localDirectory(await realpath(remaining));
  }
  throw new PluginTaskError('PERMISSION_DENIED', 'Plugin task directory contains too many links');
}

type DirectoryScope = {
  requested: string;
  leadDirectory?: string;
  configuredDirectory?: string;
  isPickedDirectory: (directory: string) => boolean;
};

/** Synchronous Host grant check, also used after the last asynchronous admission read. */
export function assertPluginWorkerDirectoryScope(input: DirectoryScope): void {
  const candidate = localDirectory(input.requested);
  const lead = input.leadDirectory ? localDirectory(input.leadDirectory) : undefined;
  const configured = input.configuredDirectory ? localDirectory(input.configuredDirectory) : undefined;
  if (!(lead && isPathInsideDir(lead, candidate))
    && !(configured && isPathInsideDir(configured, candidate) && isPathInsideDir(candidate, configured))
    && !input.isPickedDirectory(candidate)) {
    throw new PluginTaskError('PERMISSION_DENIED', 'Worker directory is outside the plugin task scope');
  }
}

/** Plans describe work; only host directory facts authorize it. */
export async function resolvePluginWorkerDirectory(input: DirectoryScope & {
  assertCurrent: () => void;
}): Promise<string> {
  const deny = () => new PluginTaskError('PERMISSION_DENIED', 'Worker directory is outside the plugin task scope');
  const candidate = localDirectory(input.requested);
  input.assertCurrent();
  const sameDirectory = (a: string, b: string) => isPathInsideDir(a, b) && isPathInsideDir(b, a);
  const localRoot = (root: string | undefined) => {
    return root ? localDirectory(root) : undefined;
  };
  const leadRoot = localRoot(input.leadDirectory);
  const configuredRoot = localRoot(input.configuredDirectory);
  assertPluginWorkerDirectoryScope(input);
  const resolved = await localRealpath(candidate);
  if (!(await stat(resolved)).isDirectory()) throw deny();
  // Stored Host roots are canonical identities, not aliases to resolve into new grants.
  const unchangedRoot = async (stored: string) => {
    const current = await localRealpath(stored);
    return sameDirectory(stored, current) ? current : null;
  };
  let allowed = false;
  if (leadRoot && isPathInsideDir(leadRoot, candidate)) {
    const lead = await unchangedRoot(leadRoot);
    allowed = lead !== null && isPathInsideDir(lead, resolved);
  }
  if (!allowed && configuredRoot && sameDirectory(configuredRoot, candidate)) {
    const configured = await unchangedRoot(configuredRoot);
    allowed = configured !== null && sameDirectory(configured, resolved);
  }
  // Pick grants are exact-directory grants, not permission for an arbitrary Library root.
  if (!allowed) allowed = input.isPickedDirectory(resolved);
  input.assertCurrent();
  if (!allowed) throw deny();
  return resolved;
}
