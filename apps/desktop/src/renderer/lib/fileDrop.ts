/**
 * Extract files from an OS drag without rebuilding them through a synthetic
 * DataTransfer. Electron associates the native filesystem path with the
 * original File object; rebuilding it can drop that metadata on Windows.
 */
import { COMPOSER_MENTION_MIME } from './composerMentionDrag';

export interface DroppedFileItems {
  files: File[];
  directories: File[];
  /**
   * Original File objects whose kind cannot be inferred synchronously because
   * the drag source omitted DataTransferItem entries.
   */
  unclassified: File[];
}

const VSCODE_RESOURCE_URLS_MIME = 'ResourceURLs';
const VSCODE_CODE_FILES_MIME = 'CodeFiles';

function safeGetData(dataTransfer: DataTransfer, type: string): string {
  try {
    return dataTransfer.getData(type) ?? '';
  } catch {
    return '';
  }
}

function isAbsoluteLocalPath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || /^\\\\[^\\]/.test(value) || value.startsWith('/');
}

/**
 * Decode a file: drag URI into the local path Electron expects.
 * VS Code percent-encodes the Windows drive colon (file:///c%3A/...).
 */
function fileUriToPath(uri: string): string | null {
  if (!/^file:\/\//i.test(uri)) return null;
  let rest = uri.slice('file://'.length);
  // A selection may be carried in the query; local filenames cannot contain
  // '?' on Windows, and VS Code appends it only for editor selections.
  const queryAt = rest.indexOf('?');
  if (queryAt >= 0) rest = rest.slice(0, queryAt);
  const fragmentAt = rest.indexOf('#');
  if (fragmentAt >= 0) rest = rest.slice(0, fragmentAt);

  let decoded: string;
  try {
    decoded = decodeURIComponent(rest);
  } catch {
    return null;
  }

  if (decoded.startsWith('/')) {
    const withoutRootSlash = decoded.slice(1);
    if (/^[A-Za-z]:[\\/]/.test(withoutRootSlash)) {
      return withoutRootSlash.replace(/\//g, '\\');
    }
    return decoded;
  }

  // file://server/share becomes a UNC path.
  const slash = decoded.indexOf('/');
  if (slash <= 0) return null;
  return '\\\\' + decoded.slice(0, slash) + decoded.slice(slash).replace(/\//g, '\\');
}

function dedupePaths(paths: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const path of paths) {
    const key = /^[A-Za-z]:/.test(path) || path.startsWith('\\\\')
      ? path.toLowerCase()
      : path;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(path);
  }
  return out;
}

/**
 * Recover local file paths from a drag that does not expose native File
 * objects. VS Code's explorer writes the file path as plain text plus its own
 * ResourceURLs JSON list; Chromium gives an external Electron renderer those
 * text formats but no DataTransfer.files entries.
 *
 * Only absolute local paths are returned, and text/plain counts only as a
 * whole path list (see below): dragging a code selection or a link from VS Code
 * must keep its existing text/link drop behaviour.
 */
export function getDroppedExternalFilePaths(dataTransfer: DataTransfer | null): string[] {
  if (!dataTransfer) return [];
  // Cindy's own file tree already carries a typed mention payload. Its
  // text/plain fallback must not also become an attachment: the internal
  // mention path owns files, directories and remote paths.
  if (safeGetData(dataTransfer, COMPOSER_MENTION_MIME)) return [];
  // Native file drags already carry File objects with Electron path metadata;
  // do not attach the same file again through the text fallback.
  if ((dataTransfer.files?.length ?? 0) > 0) return [];

  const candidates: string[] = [];
  const pushUri = (value: string) => {
    const path = fileUriToPath(value.trim());
    if (path && isAbsoluteLocalPath(path)) candidates.push(path);
  };

  const resourceUrls = safeGetData(dataTransfer, VSCODE_RESOURCE_URLS_MIME);
  if (resourceUrls) {
    try {
      const parsed: unknown = JSON.parse(resourceUrls);
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (typeof item === 'string') pushUri(item);
        }
      }
    } catch {
      // Not VS Code's JSON form; fall back to the plain-text formats below.
    }
  }

  const uriList = safeGetData(dataTransfer, 'text/uri-list');
  if (uriList) {
    for (const line of uriList.split(/\r?\n/)) {
      if (!line || line.startsWith('#')) continue;
      pushUri(line);
    }
  }

  const codeFiles = safeGetData(dataTransfer, VSCODE_CODE_FILES_MIME);
  if (codeFiles) {
    try {
      const parsed: unknown = JSON.parse(codeFiles);
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (typeof item === 'string' && isAbsoluteLocalPath(item)) candidates.push(item);
        }
      }
    } catch {
      // Ignore malformed third-party payloads.
    }
  }

  // text/plain is also what a code selection or a log line carries. Accept it
  // as a path list only when every non-empty line is a local path or a file:
  // URI: a snippet that merely contains one path line must stay text, or the
  // drop silently turns into an attachment and the pasted text disappears.
  const plainText = safeGetData(dataTransfer, 'text/plain');
  if (plainText) {
    const lines = plainText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const isPathList = lines.length > 0
      && lines.every((line) => /^file:\/\//i.test(line) || isAbsoluteLocalPath(line));
    if (isPathList) {
      for (const line of lines) {
        if (/^file:\/\//i.test(line)) pushUri(line);
        else candidates.push(line);
      }
    }
  }

  return dedupePaths(candidates);
}

interface DroppedPathClassifier {
  getFilePath: (file: File) => string;
  classifyPath: (path: string) => Promise<{ kind: 'share' | 'directory' | 'other' }>;
}

export function getDroppedFileItems(dataTransfer: DataTransfer): DroppedFileItems {
  const files: File[] = [];
  const directories: File[] = [];
  const unclassified: File[] = [];

  let fileIndex = 0;
  for (const item of Array.from(dataTransfer.items ?? [])) {
    if (item.kind !== 'file') continue;
    // Prefer the FileList entry: it is the same native object exposed by the
    // OS drag source and is the most reliable one for Electron path lookup.
    const file = dataTransfer.files[fileIndex] ?? item.getAsFile();
    fileIndex += 1;
    if (!file) continue;
    const entry = item.webkitGetAsEntry?.();
    if (entry?.isDirectory) directories.push(file);
    else files.push(file);
  }

  // Some Windows drag sources expose files but no DataTransferItem entries.
  // Keep those original File objects unresolved rather than manufacturing a
  // new FileList or assuming that every entry is a regular file. Callers can
  // classify their native paths without losing Electron's path metadata.
  if (files.length === 0 && directories.length === 0) {
    unclassified.push(...Array.from(dataTransfer.files ?? []));
  }

  return { files, directories, unclassified };
}

/**
 * Resolve item-less Windows drops by asking the main process about each
 * original File object's native path. Fail open as a regular file so a
 * transient classification failure does not make valid attachments vanish.
 */
export async function classifyUnclassifiedDroppedItems(
  unclassified: readonly File[],
  classifier: DroppedPathClassifier,
): Promise<Pick<DroppedFileItems, 'files' | 'directories'>> {
  const files: File[] = [];
  const directories: File[] = [];

  const kinds = await Promise.all(
    unclassified.map(async (file) => {
      let path = '';
      try {
        path = classifier.getFilePath(file);
      } catch {
        return 'file' as const;
      }
      if (!path) return 'file' as const;
      try {
        const result = await classifier.classifyPath(path);
        return result.kind === 'directory' ? ('directory' as const) : ('file' as const);
      } catch {
        return 'file' as const;
      }
    }),
  );

  unclassified.forEach((file, index) => {
    if (kinds[index] === 'directory') directories.push(file);
    else files.push(file);
  });

  return { files, directories };
}
