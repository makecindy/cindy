import { toWorkdirRel } from '../../shared/workdirPath';

/** A resolved file reference; coordinates are one-based, as in Markdown targets. */
export interface FileLocation {
  absPath: string;
  line?: number;
  column?: number;
}

/** Clipboard locations use workspace-relative POSIX separators on every host. */
export function formatFileLocation(workingDir: string, location: FileLocation): string | null {
  const { absPath, line, column } = location;
  if (line === undefined || !Number.isSafeInteger(line) || line < 1) return null;
  if (column !== undefined && (!Number.isSafeInteger(column) || column < 1)) return null;
  const relativePath = toWorkdirRel(workingDir, absPath);
  if (!relativePath) return null;
  return `${relativePath}:${line}${column === undefined ? '' : `:${column}`}`;
}
