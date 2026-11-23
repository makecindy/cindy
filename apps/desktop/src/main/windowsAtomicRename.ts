import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createWindowsHelperResolver, type WindowsHelperPaths } from './windowsRustHelper.js';

export type WindowsAtomicRenamePaths = WindowsHelperPaths;
const binaryName = 'cindy-windows-atomic-rename.exe';
let resolveBinary = createWindowsHelperResolver(binaryName);

export function configureWindowsAtomicRename(paths: WindowsAtomicRenamePaths): void {
  resolveBinary = createWindowsHelperResolver(binaryName, paths);
}

export async function atomicReplaceWindowsDirectoryEntry(
  source: string,
  destination: string,
): Promise<void> {
  const binary = await resolveBinary();
  await promisify(execFile)(binary, [source, destination], {
    timeout: 15_000,
    windowsHide: true,
    maxBuffer: 64 * 1024,
  });
}
