import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import type { ControlResult } from '@cindy/mcps';
const fail = (errorCode: string, message: string) => ({ok:false as const,errorCode,message});
export function createProjectDirectoryValidation(host: {
 dialogueWorkspaceRoots(): string[];
 normalizeRecentWorkdirPath(value: string): string | null;
}) {
const {dialogueWorkspaceRoots,normalizeRecentWorkdirPath} = host;
function validateLocalProjectDirectory(
  workingDir: string,
): ControlResult<{ workingDir: string }, string> {
  if (!path.isAbsolute(workingDir) || workingDir.includes('\0')) {
    return fail('INVALID_ARGS', 'working_dir must be an absolute local directory path.');
  }
  // Shared project identity treats backslashes as separators, even on POSIX.
  if (process.platform !== 'win32' && workingDir.includes('\\')) {
    return fail(
      'INVALID_ARGS',
      'Cindy project paths cannot contain literal backslashes on this platform.',
    );
  }
  const directory = normalizeRecentWorkdirPath(path.normalize(workingDir));
  return directory
    ? { ok: true, workingDir: directory }
    : fail('INVALID_ARGS', 'Managed task worktrees cannot be registered as separate projects.');
}

function isWithinDirectory(directory: string, root: string): boolean {
  const relative = path.relative(root, directory);
  return (
    relative === '' ||
    (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

/** Check physical targets without changing the caller's normalized project identity. */
async function validateExistingLocalProjectDirectory(workingDir: string) {
  const roots = dialogueWorkspaceRoots();
  if (roots.some((root) => isWithinDirectory(workingDir, root))) {
    return fail('INVALID_ARGS', 'Managed dialogue workspaces cannot be registered as projects.');
  }
  if (!(await stat(workingDir)).isDirectory())
    return fail('NOT_A_DIRECTORY', 'working_dir is not a directory.');
  // Resolve both sides: userData itself may use a symlink (e.g. /var on macOS).
  const physicalDirectory = await realpath(workingDir);
  for (const root of roots) {
    const physicalRoot = await realpath(root).catch((error: NodeJS.ErrnoException) => {
      // Unavailable current or historical roots must not block unrelated projects.
      // Keep their lexical boundary (also checked above), and still resolve accessible aliases.
      if (typeof error.code === 'string') return root;
      throw error;
    });
    if (isWithinDirectory(physicalDirectory, physicalRoot)) {
      return fail('INVALID_ARGS', 'Managed dialogue workspaces cannot be registered as projects.');
    }
  }
  return validateLocalProjectDirectory(physicalDirectory);
}
return {validateLocalProjectDirectory,validateExistingLocalProjectDirectory};
}
