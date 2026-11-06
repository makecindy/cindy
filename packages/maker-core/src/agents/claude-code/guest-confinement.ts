/**
 * Project confinement for a Claude Code session that serves a bound IM guest
 * (Desktop #8359). Claude Code has no native split read scope, so Cindy
 * enforces it in PreToolUse:
 *  - built-in file tools may only touch paths inside the project (after
 *    resolving symlinks), otherwise the call is denied;
 *  - shell tools cannot be checked statically (a command can read anything),
 *    so they always need the owner's confirmation.
 * Full access never applies to such a session.
 */
import fs from 'node:fs/promises';
import path from 'node:path';

const PATH_FIELDS = ['file_path', 'path', 'notebook_path'] as const;
const FILE_TOOLS = new Set(['Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'NotebookRead', 'Glob', 'Grep', 'LS']);
const SHELL_TOOLS = new Set(['Bash', 'BashOutput', 'PowerShell', 'KillShell', 'KillBash']);

export function isConfinedShellTool(toolName: string): boolean {
  return SHELL_TOOLS.has(toolName);
}

function contains(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/** Resolve symlinks of the longest existing prefix, so a link cannot leave the root. */
async function realPathOf(candidate: string): Promise<string> {
  let current = candidate;
  const rest: string[] = [];
  for (;;) {
    try {
      return path.join(await fs.realpath(current), ...rest);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return candidate;
      rest.unshift(path.basename(current));
      current = parent;
    }
  }
}

/**
 * Null when the call may run; otherwise the reason it is denied. Unknown tools
 * return null here: MCP and Cindy tools keep their own host checks.
 */
export async function guestConfinementDenial(
  toolName: string,
  input: Record<string, unknown> | undefined,
  workingDir: string,
): Promise<string | null> {
  if (!FILE_TOOLS.has(toolName)) return null;
  const root = await realPathOf(path.resolve(workingDir));
  const candidates: string[] = [];
  for (const field of PATH_FIELDS) {
    const value = input?.[field];
    if (typeof value === 'string' && value.trim()) candidates.push(value);
  }
  // A glob pattern can name another directory without a path field.
  const pattern = input?.pattern;
  if (toolName === 'Glob' && typeof pattern === 'string') {
    // The literal prefix before the first wildcard (`../other/**` or `C:/x/*`).
    candidates.push(pattern.split(/[*?[{]/, 1)[0] || '.');
  }
  for (const candidate of candidates) {
    const resolved = await realPathOf(path.resolve(workingDir, candidate));
    if (!contains(root, resolved)) {
      return 'This conversation can only access files inside its own project.';
    }
  }
  return null;
}
