import { BrowserWindow, type IpcMainInvokeEvent } from 'electron';
import { t } from '../i18n.js';
import { createLogger } from '../logger.js';
import { assertTrustedAppRendererEvent } from '../security/trustedAppRenderer.js';
import type { ReviewArtifactConfirmationItem } from './reviewArtifactAuthorization.js';
import { buildReviewArtifactConfirmationDialog } from './reviewArtifactDialog.js';
import { showReviewArtifactConfirmWindow } from './reviewArtifactConfirmWindow.js';

const log = createLogger('review:artifact-confirmation');

export async function confirmReviewArtifacts(
  event: IpcMainInvokeEvent,
  items: ReviewArtifactConfirmationItem[],
): Promise<boolean> {
  assertTrustedAppRendererEvent(event);
  const parent = BrowserWindow.fromWebContents(event.sender);
  if (!parent || parent.isDestroyed()) return false;
  return showReviewArtifactConfirmWindow(parent, buildReviewArtifactConfirmationDialog(items, t), { log });
}
