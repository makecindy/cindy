import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createWindowsRustHelper, type WindowsHelperPaths } from './windowsRustHelper.js';

export type WindowsAtomicRenamePaths = WindowsHelperPaths;
const helper = createWindowsRustHelper('cindy-windows-atomic-rename.exe');
export const configureWindowsAtomicRename = helper.configure;

export async function atomicReplaceWindowsDirectoryEntry(
  source: string,
  destination: string,
): Promise<void> {
  const binary = await helper.resolve();
  await promisify(execFile)(binary, [source, destination], {
    timeout: 15_000,
    windowsHide: true,
    maxBuffer: 64 * 1024,
  });
}
