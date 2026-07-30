/**
 * Extract files from an OS drag without rebuilding them through a synthetic
 * DataTransfer. Electron associates the native filesystem path with the
 * original File object; rebuilding it can drop that metadata on Windows.
 */
export interface DroppedFileItems {
  files: File[];
  directories: File[];
  /**
   * Original File objects whose kind cannot be inferred synchronously because
   * the drag source omitted DataTransferItem entries.
   */
  unclassified: File[];
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
