import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { DialogueWorkspaceSettingsState } from '../shared/dialogueWorkspaceSettings.js';
import { throwIpcError } from './utils/ipcValidate.js';

interface Deps {
  captureScope(): string;
  isScopeCurrent(scope: string): boolean;
  read(): DialogueWorkspaceSettingsState;
  write(directory: string | null): Promise<void>;
  chooseDirectory(): Promise<string | null>;
  resolveDirectory(selected: string): string;
  checkWritable(directory: string): Promise<void>;
  openDirectory(directory: string): Promise<string>;
}

export function customDialogueWorkspaceRoot(
  selected: string,
  ownerKey: string,
  paths: Pick<typeof path, 'join'> = path,
): string {
  return paths.join(selected, 'dialogues', ownerKey);
}

/** Use an exclusive probe: never overwrite an existing user file. */
export async function checkDialogueDirectoryWritable(directory: string): Promise<void> {
  await fs.mkdir(directory, { recursive: true });
  const probe = path.join(directory, '.cindy-write-probe-' + randomUUID());
  const file = await fs.open(probe, 'wx');
  try {
    await file.writeFile('');
  } finally {
    await file.close();
    await fs.unlink(probe);
  }
}

export function createDialogueWorkspaceHandlers(deps: Deps) {
  let busy = false;
  const assertCurrent = (scope: string) => {
    if (!deps.isScopeCurrent(scope)) {
      throwIpcError('PRECONDITION_FAILED', 'dialogue workspace owner changed');
    }
  };
  const mutate = async (choose: boolean) => {
    const scope = deps.captureScope();
    if (busy) throwIpcError('PRECONDITION_FAILED', 'dialogue workspace settings are busy');
    busy = true;
    try {
      let directory: string | null = null;
      if (choose) {
        const selected = await deps.chooseDirectory();
        assertCurrent(scope);
        if (selected === null) return deps.read();
        directory = deps.resolveDirectory(selected);
        await deps.checkWritable(directory);
        assertCurrent(scope);
      }
      await deps.write(directory);
      assertCurrent(scope);
      return deps.read();
    } finally {
      busy = false;
    }
  };
  return {
    get: () => { deps.captureScope(); return deps.read(); },
    open: async () => {
      const scope = deps.captureScope();
      const { directory, isCustomized } = deps.read();
      if (isCustomized) {
        // The picker already created this root. Recreating it could write beneath an offline mount.
        if (!(await fs.stat(directory)).isDirectory()) {
          throwIpcError('PRECONDITION_FAILED', 'dialogue workspace directory unavailable');
        }
      } else {
        await fs.mkdir(directory, { recursive: true });
      }
      assertCurrent(scope);
      return { success: (await deps.openDirectory(directory)) === '' };
    },
    choose: () => mutate(true),
    reset: () => mutate(false),
  };
}
