import path from 'node:path';
export interface GhostWorkdirPrefs { disabledByWorkdir: Record<string, string[]>; }
export function normalizeWorkdirKey(dir: string): string {
  if (dir.trim().length === 0) return '';
  const looksWindows = /^[A-Za-z]:[\\/]/.test(dir) || dir.includes('\\');
  if (looksWindows) {
    // win32.normalize 统一分隔符并折叠 '..';根目录(C:\)保留尾分隔符。
    let n = path.win32.normalize(dir);
    if (n.length > 3 && (n.endsWith('\\') || n.endsWith('/'))) n = n.slice(0, -1);
    return n.toLowerCase();
  }
  let n = path.posix.normalize(dir);
  if (n.length > 1 && n.endsWith('/')) n = n.slice(0, -1);
  return n;
}

export function normalizeGhostWorkdirPrefs(raw: unknown): GhostWorkdirPrefs {
  if (!raw || typeof raw !== 'object') return { disabledByWorkdir: {} };
  const mapRaw = (raw as { disabledByWorkdir?: unknown }).disabledByWorkdir;
  const disabledByWorkdir: Record<string, string[]> = {};
  if (mapRaw && typeof mapRaw === 'object' && !Array.isArray(mapRaw)) {
    for (const [dirKey, idsRaw] of Object.entries(mapRaw as Record<string, unknown>)) {
      if (!Array.isArray(idsRaw)) continue;
      const key = normalizeWorkdirKey(dirKey);
      if (key.length === 0) continue;
      const ids = [...new Set(idsRaw.filter((v): v is string => typeof v === 'string' && v.trim().length > 0))].sort();
      if (ids.length === 0) continue;
      // 同一目录两种写法归一后撞键 → 并集(手改文件的容错)。
      const merged = disabledByWorkdir[key] ? [...new Set([...disabledByWorkdir[key], ...ids])].sort() : ids;
      disabledByWorkdir[key] = merged;
    }
  }
  return { disabledByWorkdir };
}
