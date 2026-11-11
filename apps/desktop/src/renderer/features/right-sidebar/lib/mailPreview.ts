import { REMOTE_RESOURCE_GET_CHANNEL, REMOTE_RESOURCE_PROTOCOL_VERSION } from '@cindy/device-link';
import { parseMailMessage, parseMailReaderChoices, parseMailDraftCallId } from '@cindy/maker-shared/mail-message';
import { pendingGhostCardFormDelivery } from '@cindy/maker-shared/ghost-card-form';
import { getSessionDeviceId } from '@/features/device-link/remoteProjectsStore';
import { addOrFocusSingletonTab, ensureHydrated, patchTabState } from '../store';
import { routeSidebarCommand } from './detachedSidebarRouting';
import { requestRightSidebarVisibility } from './sidebarCommands';

/** Link opening and card enlargement must both see the last typed edit. */
async function waitForMailEdits(sessionId: string): Promise<void> {
  if (await pendingGhostCardFormDelivery(sessionId) === false) throw new Error('Draft sync failed');
}

export async function readMailPreview(sessionId: string, url: string, read: boolean, deviceId: string | null | undefined = getSessionDeviceId(sessionId), opened = false, providerId?: string) {
  if (read && opened) await waitForMailEdits(sessionId);
  const raw = deviceId ? await window.electronAPI.deviceLink.invoke(deviceId, REMOTE_RESOURCE_GET_CHANNEL, [{
    client: { protocolVersion: REMOTE_RESOURCE_PROTOCOL_VERSION, primitives: ['mail-message'] },
    ref: { collectionId: 'mail-messages', kind: 'message', id: JSON.stringify([sessionId, url, read]) },
    ...(providerId ? { query: JSON.stringify({ opened, providerId }) } : opened ? { query: 'open' } : {}),
  }]) : await window.electronAPI.ghosts.mailPreview(sessionId, url, read, opened, providerId);
  const value = deviceId ? (raw as { blocks?: { data?: unknown }[] })?.blocks?.[0]?.data : raw;
  const result = value as { supported?: unknown; message?: unknown; draftCallId?: unknown; error?: unknown; providerId?: unknown; providers?: unknown } | undefined;
  // A downgraded remote host may ignore query. Never display another reader's
  // body when an explicit selection was requested but not acknowledged.
  if (providerId && result?.providerId !== providerId && result?.message)
    return { supported: true, message: null, error: 'MAIL_PROVIDER_UNAVAILABLE', draftCallId: undefined, providerId: undefined, providers: undefined };
  return { supported: result?.supported === true, message: parseMailMessage(result?.message), error: typeof result?.error === 'string' ? result.error : undefined,
    draftCallId: opened ? parseMailDraftCallId(result?.draftCallId) : undefined,
    providerId: typeof result?.providerId === 'string' && result.providerId.length <= 512 ? result.providerId : undefined,
    providers: parseMailReaderChoices(result?.providers) };
}
export async function openMailPreview(sessionId: string, url: string): Promise<void> {
  await waitForMailEdits(sessionId);
  const routed = await routeSidebarCommand({ type: 'open-mail-preview', sessionId, url });
  if (routed !== 'attached') {
    if (routed === 'routed') requestRightSidebarVisibility('open', { sessionId });
    return;
  }
  await ensureHydrated(sessionId);
  const tab = await addOrFocusSingletonTab(sessionId, 'mail-preview', { url });
  await patchTabState(sessionId, tab.id, () => ({ url }));
  requestRightSidebarVisibility('open', { sessionId });
}

/** The sidebar refers to the existing card; it never creates a second draft. */
export async function openMailCard(sessionId: string, callId: string): Promise<void> {
  await waitForMailEdits(sessionId);
  const routed = await routeSidebarCommand({ type: 'open-mail-card', sessionId, callId });
  if (routed !== 'attached') {
    if (routed === 'routed') requestRightSidebarVisibility('open', { sessionId });
    return;
  }
  await ensureHydrated(sessionId);
  const state = { url: '', callId };
  const tab = await addOrFocusSingletonTab(sessionId, 'mail-preview', state);
  await patchTabState(sessionId, tab.id, () => state);
  requestRightSidebarVisibility('open', { sessionId });
}
