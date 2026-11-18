/** Project-owned directory choices. Paths belong to the project's execution computer. */
export interface ProjectDirectory {
  path: string;
  access: 'read' | 'write';
}

export function parseProjectDirectories(value: unknown): ProjectDirectory[] | null {
  if (!Array.isArray(value) || value.length > 10) return null;
  const result: ProjectDirectory[] = [];
  const seen = new Set<string>();
  for (const row of value) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
    const { path, access } = row as Record<string, unknown>;
    if (
      typeof path !== 'string' ||
      !path.trim() ||
      path.length > 4096 ||
      path.includes('\0') ||
      (access !== 'read' && access !== 'write')
    )
      return null;
    if (!path.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(path) && !path.startsWith('\\\\'))
      return null;
    const clean = path.trim();
    if (seen.has(clean)) return null;
    seen.add(clean);
    result.push({ path: clean, access });
  }
  return result;
}
