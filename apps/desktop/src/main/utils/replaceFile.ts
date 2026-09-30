import { rename } from 'node:fs/promises';
import path from 'node:path';

/** Publish a verified sibling file without deleting the previous destination. */
export async function replaceFile(source: string, destination: string): Promise<void> {
  try {
    await rename(source, destination);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (process.platform !== 'win32' || (code !== 'EEXIST' && code !== 'EPERM')) throw error;
    const { atomicReplaceWindowsDirectoryEntry } = await import('../windowsAtomicRename.js');
    await atomicReplaceWindowsDirectoryEntry(path.resolve(source), path.resolve(destination));
  }
}
