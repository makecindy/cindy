import path from 'node:path';

import { BrowserWindow, dialog, type IpcMainInvokeEvent } from 'electron';

import { t } from '../i18n.js';
import { assertTrustedAppRendererEvent } from '../security/trustedAppRenderer.js';

/** No changes were found in the task's directory. Let the user choose the
 * actual checkout, or explicitly review the current code without a diff.
 * Selection grants only this Review read access; it never moves the source task.
 */
export async function selectReviewWorkspace(
  event: IpcMainInvokeEvent,
  workingDir: string,
): Promise<string | null> {
  assertTrustedAppRendererEvent(event);
  const parent = BrowserWindow.fromWebContents(event.sender);
  if (!parent || parent.isDestroyed()) return null;
  const choice = await dialog.showMessageBox(parent, {
    type: 'question',
    title: t('review.workspaceSelection.title'),
    message: t('review.workspaceSelection.message'),
    detail: workingDir,
    buttons: [
      t('review.workspaceSelection.current'),
      t('review.workspaceSelection.choose'),
      t('common.cancel'),
    ],
    defaultId: 1,
    cancelId: 2,
    noLink: true,
  });
  if (parent.isDestroyed() || choice.response === 2) return null;
  if (choice.response === 0) return workingDir;
  const picked = await dialog.showOpenDialog(parent, {
    title: t('review.workspaceSelection.title'),
    buttonLabel: t('review.workspaceSelection.open'),
    defaultPath: path.dirname(workingDir),
    properties: ['openDirectory'],
  });
  return !parent.isDestroyed() && !picked.canceled && picked.filePaths[0] ? picked.filePaths[0] : null;
}
