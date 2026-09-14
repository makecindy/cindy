import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { PiRemoteFileOps } from '../base-agent.js';

// Pi's native candidate order, including case-sensitive filesystem aliases.
// SYSTEM.md / APPEND_SYSTEM.md are different resources, not context files.
export const PI_GLOBAL_CONTEXT_FILE_NAMES = ['AGENTS.override.md', 'AGENTS.md', 'AGENTS.MD', 'CLAUDE.md', 'CLAUDE.MD'] as const;
const REMOTE_READ_LIMIT = 4_194_304;

/** A launch-time snapshot; never link the writable runtime back to user files. */
export interface PiGlobalContextFile {
  name: (typeof PI_GLOBAL_CONTEXT_FILE_NAMES)[number];
  content: string;
}

export async function readPiGlobalContext(
  home: string | undefined,
  remote?: PiRemoteFileOps,
): Promise<PiGlobalContextFile[]> {
  if (!home) return [];
  for (const name of PI_GLOBAL_CONTEXT_FILE_NAMES) {
    const source = (remote ? path.posix : path).join(home, name);
    if (remote) {
      if (!(await remote.stat(source))?.isFile) continue;
      const content = await remote.readFile(source, REMOTE_READ_LIMIT);
      // Remote reads are bounded. Never silently deliver truncated instructions.
      if (Buffer.byteLength(content, 'utf8') >= REMOTE_READ_LIMIT) {
        throw new Error(`Pi global context exceeds remote read limit: ${name}`);
      }
      return [{ name, content }];
    }
    try {
      // Follow user symlinks outside Pi home, then freeze the target's bytes.
      if (!(await fs.stat(source)).isFile()) continue;
      return [{ name, content: await fs.readFile(source, 'utf8') }];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
  }
  return [];
}
