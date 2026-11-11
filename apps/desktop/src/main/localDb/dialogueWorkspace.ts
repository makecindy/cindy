import fs from 'node:fs';
import path from 'node:path';
import { dialogueWorkspaceRoots, readDialogueWorkspaceSettings } from '../dialogue-workspace-settings.js';
import { matchDialogueWorkspacePath } from './dialogueWorkdirSelfHeal.js';

export { dialogueWorkspaceRoots } from '../dialogue-workspace-settings.js';

/**
 * Build the local date bucket used for XDT-created standalone dialogues.
 *
 * Use local calendar time instead of UTC so the folder layout matches what the
 * user sees in the desktop app on that machine.
 */
export function dialogueWorkspaceDayKey(nowMs: number): string {
  const date = new Date(nowMs);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** Root directory owned by xdt-maker for folderless dialogue workspaces. */
export function dialogueWorkspaceRootDir(): string {
  return readDialogueWorkspaceSettings().directory;
}

export function isManagedDialogueWorkspace(workingDir: string): boolean {
  if (!workingDir) return false;
  return dialogueWorkspaceRoots().some((root) => {
    if (matchDialogueWorkspacePath(workingDir, root) !== null) return true;
    const relative = path.relative(path.join(root, 'dialogue-recovery'), workingDir);
    return /^[a-f0-9]{64}$/.test(relative);
  });
}

/**
 * App-managed cwd for an XDT-created dialogue that did not receive an explicit
 * folder. Imported Codex dialogues, or future explicitly-foldered dialogues,
 * keep their original workingDir and do not call this helper.
 */
export function buildDialogueWorkspaceDir(sessionId: string, nowMs: number): string {
  return path.join(
    dialogueWorkspaceRootDir(),
    dialogueWorkspaceDayKey(nowMs),
    sessionId,
  );
}

/** Create and return the app-managed dialogue cwd. */
export function ensureDialogueWorkspaceDir(sessionId: string, nowMs: number): string {
  const { directory, isCustomized } = readDialogueWorkspaceSettings();
  const dayDir = path.join(directory, dialogueWorkspaceDayKey(nowMs));
  const dir = path.join(dayDir, sessionId);
  if (!isCustomized) {
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }
  // Custom roots are created by the picker. Never recreate a missing root or its
  // ancestors: an unmounted volume may leave a writable local mount point behind.
  // Non-recursive creation also fails if the root disappears between these steps.
  for (const child of [dayDir, dir]) {
    try {
      fs.mkdirSync(child);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || !fs.statSync(child).isDirectory()) throw error;
    }
  }
  return dir;
}
