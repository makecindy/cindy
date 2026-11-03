const GHOST_PATH_SEGMENT_RE = /^[a-zA-Z0-9_][a-zA-Z0-9._-]{0,63}$/;
export function isSafeGhostRelativePath(p: unknown): p is string {
  if (typeof p !== 'string' || p.length === 0 || p.length > 256) return false;
  if (p.includes('\\')) return false;
  const segments = p.split('/');
  return segments.every(
    (seg) =>
      GHOST_PATH_SEGMENT_RE.test(seg) && seg !== '.' && seg !== '..' && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(seg),
  );
}
