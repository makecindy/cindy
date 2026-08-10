/**
 * Source-tree entries excluded by the canonical .cindy packer. Keep this
 * predicate shared with recovery hashing so both paths describe the same
 * package bytes.
 */
export function shouldSkipGhostPackEntry(name: string): boolean {
  if (name.startsWith('.')) return true;
  if (name.toLowerCase() === 'node_modules') return true;
  if (name.toLowerCase().endsWith('.cindy')) return true;
  return false;
}
