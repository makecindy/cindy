/**
 * Shared file metadata helpers for workdir-browse preview surfaces.
 */

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function formatMtime(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function basename(p: string): string {
  const slash = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return slash < 0 ? p : p.slice(slash + 1);
}

export function dirname(p: string): string {
  const slash = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return slash <= 0 ? '' : p.slice(0, slash);
}

export function joinPath(a: string, b: string): string {
  if (!b) return a;
  if (a.endsWith('/') || a.endsWith('\\')) return a + b;
  return `${a}/${b}`;
}

/**
 * 把 (workdir, relPath) 拼成当前 OS 的绝对路径,Windows 把所有 `/` 归一化为 `\`,
 * POSIX 保持 `/`。用于复制路径到剪贴板等需要 OS-native 形态的场景。
 *
 * 与 `joinPath` 的区别:`joinPath` 始终用 `/`(项目内部统一形态);本函数则按
 * 平台输出,只在"对外"场景(剪贴板 / "在系统中打开")用。
 */
export function toOsAbsolutePath(workdir: string, relPath: string): string {
  const isWin = window.electronAPI?.platform === 'win32';
  if (isWin) {
    const normalizedWd = workdir.replace(/\//g, '\\');
    const normalizedRel = relPath.replace(/\//g, '\\');
    const sep = normalizedWd.endsWith('\\') ? '' : '\\';
    return `${normalizedWd}${sep}${normalizedRel}`;
  }
  const sep = workdir.endsWith('/') ? '' : '/';
  return `${workdir}${sep}${relPath}`;
}

/** Display-only logical paths: the file may belong to Windows, SSH or another device. */
export function fileDirectoryLabel(relPath: string, peers?: readonly string[]): string {
  const directory = dirname(relPath).replace(/\\/g, '/') || (relPath.startsWith('/') ? '/' : '.');
  if (!peers) return directory;
  const otherDirectories = peers
    .filter((peer) => peer !== relPath && basename(peer) === basename(relPath))
    .map((peer) => dirname(peer).replace(/\\/g, '/') || '.');
  const parts = directory.split('/');
  for (let depth = 1; depth < parts.length; depth++) {
    const suffix = parts.slice(-depth).join('/');
    if (!otherDirectories.some((other) => other === suffix || other.endsWith(`/${suffix}`))) {
      return suffix;
    }
  }
  return directory;
}

export function fileDisplayPath(workdir: string, relPath: string): string {
  if (/^(?:[A-Za-z]:[\\/]|[\\/])/.test(relPath)) return relPath;
  const separator = workdir.includes('\\') ? '\\' : '/';
  return `${workdir.replace(/[\\/]+$/, '')}${separator}${relPath.replace(/[\\/]/g, separator)}`;
}

export function isTemplateRulePath(relPath: string): boolean {
  return relPath === 'AGENTS.md' || relPath === 'CLAUDE.md';
}

/** Provenance, not filename/content guessing or a claim about active harness instructions. */
export function hasCindyTemplateRule(relPath: string, recordContent: string): boolean {
  if (!isTemplateRulePath(relPath)) return false;
  try {
    const record: unknown = JSON.parse(recordContent);
    if (!record || typeof record !== 'object') return false;
    const { version, files } = record as { version?: unknown; files?: unknown };
    return typeof version === 'number' && Number.isInteger(version) && version > 0
      && !!files && typeof files === 'object' && !Array.isArray(files)
      && Object.hasOwn(files, relPath)
      && typeof (files as Record<string, unknown>)[relPath] === 'string'
      && /^[a-f0-9]{64}$/.test((files as Record<string, string>)[relPath]);
  } catch {
    return false;
  }
}
