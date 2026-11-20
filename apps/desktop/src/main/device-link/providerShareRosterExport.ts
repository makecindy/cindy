import { randomUUID } from 'node:crypto';
import { open, unlink } from 'node:fs/promises';
import path from 'node:path';
import { BrowserWindow, dialog, type IpcMainInvokeEvent } from 'electron';
import { getActiveDataOwnerPushStamp } from '../appSessionState.js';
import { getDeviceId } from '../authManager.js';
import { captureProviderManagementScope } from '../provider-group/managementScope.js';
import { assertTrustedAppRendererEvent } from '../security/trustedAppRenderer.js';
import { replaceFile } from '../utils/replaceFile.js';
import { throwIpcError } from '../utils/ipcValidate.js';
import { isIpcError } from '../../shared/ipc-errors.js';
import { isDataOwnerPushStamp } from '../../shared/dataOwnerPush.js';
import { getDeviceLinkInvokeContext } from './invoke-context.js';
import { providerShareApi } from './providerShareApi.js';
import { providerShareMemberNotes } from './providerShareMemberNotes.js';

function cell(value: string): string {
  const safe = /^(?:'|[\t\r\n]|\s*[=+\-@＝＋－＠])/.test(value) ? "'" + value : value;
  return '"' + safe.replace(/"/g, '""') + '"';
}

async function readRoster(providerId: string, capturedAt: string, assertCaller: () => void): Promise<{ csv: string; membership: string }> {
  assertCaller();
  const snapshot = await providerShareApi.listOwned()
    .catch(() => throwIpcError('PRECONDITION_FAILED', 'The current member roster is unavailable'));
  assertCaller();
  if (snapshot.authorityIncomplete || snapshot.unavailableShareIds?.length) {
    throwIpcError('PRECONDITION_FAILED', 'The current member roster is unavailable');
  }
  const notes = await providerShareMemberNotes.readStrict();
  assertCaller();
  const deviceId = getDeviceId();
  const shares = snapshot.filter(
    share => share.providerId === providerId && share.hostDeviceId === deviceId && share.members.length > 0,
  );
  if (!shares?.length) throwIpcError('PRECONDITION_FAILED', 'The local member roster is unavailable');
  const lines = ['share_id,member_id,display_name,note,status,captured_at'];
  for (const share of shares) {
    for (const member of share.members) {
      lines.push([share.shareId, member.memberId, member.displayName, notes[member.memberId] ?? '', member.status, capturedAt]
        .map(cell).join(','));
    }
  }
  const membership = JSON.stringify(shares.map(share => ({
    shareId: share.shareId,
    members: share.members.map(member => [member.memberId, member.joinedAt]),
  })));
  return { csv: '\uFEFF' + lines.join('\r\n') + '\r\n', membership };
}

export async function exportProviderShareRoster(event: IpcMainInvokeEvent, rawProviderId: unknown, owner: unknown): Promise<void> {
  if (getDeviceLinkInvokeContext()) throwIpcError('PERMISSION_DENIED', 'Roster export is local only');
  assertTrustedAppRendererEvent(event);
  if (typeof rawProviderId !== 'string' || !rawProviderId.trim() || rawProviderId.length > 256 || !isDataOwnerPushStamp(owner)) {
    throwIpcError('INVALID_PARAMS', 'Invalid roster export request');
  }
  const providerId = rawProviderId.trim();
  const assertOwner = captureProviderManagementScope();
  const current = getActiveDataOwnerPushStamp();
  if (!current.dataOwnerId || current.dataOwnerId !== owner.dataOwnerId || current.ownerGeneration !== owner.ownerGeneration) {
    throwIpcError('PRECONDITION_FAILED', 'The account changed');
  }
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) throwIpcError('PERMISSION_DENIED', 'No window for roster export');
  const assertCaller = () => {
    assertOwner();
    assertTrustedAppRendererEvent(event);
  };
  const capturedAt = new Date().toISOString();
  const prepared = await readRoster(providerId, capturedAt, assertCaller);

  assertCaller();
  const picked = await dialog.showSaveDialog(win, {
    defaultPath: 'cindy-member-roster-' + capturedAt.replace(/[:.]/g, '-') + '.csv',
    filters: [{ name: 'CSV', extensions: ['csv'] }],
  }).catch(() => throwIpcError('INTERNAL', 'Could not open the save dialog'));
  if (picked.canceled || !picked.filePath) return;
  assertCaller();

  // Only a complete, still-authorized export may replace the user-selected file.
  const temp = path.join(path.dirname(picked.filePath), '.cindy-roster-' + randomUUID() + '.tmp');
  const file = await open(temp, 'wx', 0o600).catch(() => throwIpcError('INTERNAL', 'Could not create the roster file'));
  try {
    try {
      assertCaller();
      await file.writeFile(prepared.csv, 'utf8');
    } finally {
      await file.close();
    }
    const latest = await readRoster(providerId, capturedAt, assertCaller);
    if (latest.csv !== prepared.csv || latest.membership !== prepared.membership) {
      throwIpcError('PRECONDITION_FAILED', 'The member roster changed');
    }
    assertCaller();
    // Admit publication under the current owner before handing it to the filesystem.
    await replaceFile(temp, picked.filePath);
  } catch (error) {
    await unlink(temp).catch(() => {});
    if (isIpcError(error)) throw error;
    throwIpcError('INTERNAL', 'Could not save the member roster');
  }
}
