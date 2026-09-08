import path from 'node:path';
import {
  openOrCreateFixedDirectory,
  type OpenFixedDirectoryOptions,
} from '../cindy-media/fixedDirectory.js';
import { throwIpcError } from '../utils/ipcValidate.js';

/** userData comes from main, never from an IPC argument. */
export async function openMakeToolsDirectory(
  userData: string,
  options: OpenFixedDirectoryOptions,
): Promise<{ success: boolean }> {
  try {
    const opened = await openOrCreateFixedDirectory(
      path.join(userData, 'cindy-make', 'tools'),
      options,
    );
    if (opened) return { success: true };
  } catch {
    // Do not send private filesystem paths or OS error messages over IPC.
  }
  throwIpcError('INTERNAL', 'Unable to open Cindy Make tools directory');
}
