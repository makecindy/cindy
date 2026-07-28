/**
 * Extract files from an OS drag without rebuilding them through a synthetic
 * DataTransfer. Electron associates the native filesystem path with the
 * original File object; rebuilding it can drop that metadata on Windows.
 */
export interface DroppedFileItems {
  files: File[];
  directories: File[];
}

export function getDroppedFileItems(dataTransfer: DataTransfer): DroppedFileItems {
  const files: File[] = [];
  const directories: File[] = [];

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
  // Keep the original File objects in that case rather than manufacturing a
  // new FileList, so webUtils.getPathForFile() can still resolve their paths.
  if (files.length === 0 && directories.length === 0) {
    files.push(...Array.from(dataTransfer.files ?? []));
  }

  return { files, directories };
}
