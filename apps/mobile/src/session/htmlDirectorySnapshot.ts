/** Bounded, complete directory snapshot. No native or React dependency. */
export const HTML_SNAPSHOT_MAX_ENTRIES = 2000;
export const HTML_SNAPSHOT_MAX_BYTES = 100 * 1024 * 1024;

/** RN's AbortController polyfill does not implement AbortSignal.throwIfAborted. */
export function assertHtmlSnapshotActive(signal: AbortSignal): void {
  if (signal.aborted) throw new Error('PREVIEW_CANCELLED');
}

export interface HtmlSnapshotEntry {
  name: string;
  relPath: string;
  type: 'file' | 'directory';
  size: number;
}

export function htmlSnapshotLocation(absPath: string) {
  const windows = /^[A-Za-z]:[\\/]|^\\\\/.test(absPath);
  const path = windows ? absPath.replace(/\\/g, '/') : absPath;
  const split = path.lastIndexOf('/');
  if ((!path.startsWith('/') && !/^[A-Za-z]:\//.test(path)) || split < 0
    || !/\.html?$/i.test(path) || /[\0\r\n]/.test(path)) throw new Error('BAD_ARGS');
  const root = path.slice(0, split) || '/';
  return { root: /^[A-Za-z]:$/.test(root) ? `${root}/` : root, entry: path.slice(split + 1) };
}

export async function collectHtmlSnapshot(
  entry: string,
  list: (relPath: string) => Promise<unknown>,
  signal: AbortSignal,
): Promise<HtmlSnapshotEntry[]> {
  const pending = [''];
  const seen = new Set<string>();
  const files: HtmlSnapshotEntry[] = [];
  let bytes = 0;
  while (pending.length) {
    assertHtmlSnapshotActive(signal);
    const rel = pending.pop()!;
    if (rel.split('/').length > 32) throw new Error('PREVIEW_TOO_LARGE');
    const entries = await list(rel);
    assertHtmlSnapshotActive(signal);
    if (!Array.isArray(entries)) throw new Error('PREVIEW_LIST_FAILED');
    if (entries.length > HTML_SNAPSHOT_MAX_ENTRIES) throw new Error('PREVIEW_TOO_LARGE');
    for (const value of entries) {
      const item = value as HtmlSnapshotEntry | null;
      if (!item || typeof item.name !== 'string' || !item.name || /[\\/:\0\r\n]/.test(item.name)
        || item.name === '.' || item.name === '..') throw new Error('PREVIEW_LIST_FAILED');
      const expected = rel ? `${rel}/${item.name}` : item.name;
      if (item.relPath !== expected || seen.has(expected)
        || !Number.isSafeInteger(item.size) || item.size < 0
        || !['file', 'directory'].includes(item.type)) throw new Error('PREVIEW_LIST_FAILED');
      seen.add(expected);
      if (seen.size > HTML_SNAPSHOT_MAX_ENTRIES) throw new Error('PREVIEW_TOO_LARGE');
      // Publishing policy, independent of the generic file browsing interface.
      if (item.name.startsWith('.')) continue;
      if (item.type === 'directory') pending.push(expected);
      else {
        bytes += item.size;
        if (bytes > HTML_SNAPSHOT_MAX_BYTES) throw new Error('PREVIEW_TOO_LARGE');
        files.push(item);
      }
    }
  }
  if (!files.some((file) => file.relPath === entry)) throw new Error('NOT_FOUND');
  return files;
}

/** Only guarded HTML documents can become the top-level WebView document. */
export function snapshotDocumentPaths(files: HtmlSnapshotEntry[]): string[] {
  return files.filter((f) => /\.html?$/i.test(f.relPath)).flatMap((f) => {
    const path = '/' + f.relPath.split('/').map(encodeURIComponent).join('/');
    return /(^|\/)index\.html$/.test(f.relPath)
      ? [path, path.slice(0, -'index.html'.length)] : [path];
  });
}
