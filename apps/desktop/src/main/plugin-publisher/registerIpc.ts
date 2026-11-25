import { ipcMain } from 'electron';
import { z } from 'zod';

import {
  getActiveAppSession,
  isAppSessionBoundaryPending,
} from '../appSessionState.js';
import { visibilityAudienceSchema, type AuthorVisibilityAudience } from '../../shared/pluginAuthor.js';
import { assertTrustedAppRendererEvent } from '../security/trustedAppRenderer.js';
import { requireObject, requireString, throwIpcError } from '../utils/ipcValidate.js';
import { mapContributionError } from '../plugin-contributions/host.js';
import {
  startInstalledPluginPublish,
  getPluginPublisherConfirmBridge,
  getPluginPublisherOrchestrator,
  trackPublisherConfirmRequester,
} from './host.js';

const startInstalledSchema = z
  .object({
    instanceId: z.string().min(1).max(256),
    expected: z
      .object({ directory: z.string().min(1).max(4096), approvalToken: z.string().min(1).max(256) })
      .strict()
      .optional(),
  })
  .strict();

let registered = false;

export function registerPluginPublisherIpc(): void {
  if (registered) return;
  registered = true;

  // Renderer never supplies a file path (an XSS could forge one). It names an installed local
  // plugin; Main snapshots that exact approved installation, and the user still confirms the
  // publish on the confirmation screen.
  ipcMain.handle('plugin-publisher:start-installed', async (event, raw: unknown) => {
    assertTrustedAppRendererEvent(event);
    const parsed = startInstalledSchema.safeParse(raw);
    if (!parsed.success) throwIpcError('INVALID_PARAMS', 'Invalid publish request');
    try {
      return await startInstalledPluginPublish(parsed.data.instanceId, parsed.data.expected, event.sender);
    } catch (error) {
      mapContributionError(error);
    }
  });

  ipcMain.handle('plugin-publisher:status', (event, transferId: unknown) => {
    assertTrustedAppRendererEvent(event);
    const id = requireString(transferId, 'transferId');
    if (isAppSessionBoundaryPending()) return { progress: null };
    return {
      progress: getPluginPublisherOrchestrator().snapshotForOwner(
        id,
        getActiveAppSession(),
      ),
    };
  });

  ipcMain.handle('plugin-publisher:cancel', (event, transferId: unknown) => {
    assertTrustedAppRendererEvent(event);
    const id = requireString(transferId, 'transferId');
    if (isAppSessionBoundaryPending()) return { cancelled: false };
    return getPluginPublisherOrchestrator().cancelForOwner(
      id,
      getActiveAppSession(),
    );
  });

  ipcMain.handle('plugin-publisher:resolve-confirm', (event, raw: unknown) => {
    assertTrustedAppRendererEvent(event);
    trackPublisherConfirmRequester(event.sender);
    const payload = requireObject(raw);
    const requestId = requireString(payload.requestId, 'requestId');
    if (requestId.length > 128) throwIpcError('INVALID_PARAMS', 'requestId is too long');
    let visibilityAudience: AuthorVisibilityAudience | undefined;
    if (payload.visibilityAudience !== undefined) {
      const parsed = visibilityAudienceSchema.safeParse(payload.visibilityAudience);
      if (!parsed.success) throwIpcError('INVALID_PARAMS', 'Invalid visibility audience');
      visibilityAudience = parsed.data;
    }
    return {
      handled: getPluginPublisherConfirmBridge().resolve(
        event.sender.id,
        requestId,
        payload.confirmed,
        visibilityAudience,
      ),
    };
  });
}
