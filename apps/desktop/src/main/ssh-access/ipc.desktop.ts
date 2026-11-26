/**
 * Settings IPC for "allow my other devices to SSH into this computer" (shared/sshAccess.ts). One channel, a validated
 * request union, Cindy's own top-level app frames only; the business body is `handleSshAccessRequest`, testable
 * without Electron. Errors use the IPC error protocol and never carry paths or key material.
 */
import { BrowserWindow, ipcMain } from 'electron';
import { z } from 'zod';
import { SSH_ACCESS_MAX_KEY_TEXT_CHARS } from '@cindy/device-link';
import { SSH_ACCESS_CHANGED_CHANNEL, SSH_ACCESS_IPC_CHANNEL, type SshAccessRequest } from '../../shared/sshAccess.js';
import { assertTrustedAppRendererEvent, isTrustedAppRendererWindow } from '../security/trustedAppRenderer.js';
import { throwIpcError } from '../utils/ipcValidate.js';
import type { IpcErrorCode } from '../../shared/ipc-errors.js';
import { SshAccessTargetError, type SshAccessTarget } from './sshAccessTargetCore.js';
import { SSH_ACCESS_MAX_LABEL_CHARS } from './sshAccessRecord.js';
import { currentSshAccessTarget } from './sshAccessTarget.desktop.js';

const requestSchema = z.discriminatedUnion('operation', [
  z.strictObject({ operation: z.literal('read') }),
  z.strictObject({ operation: z.literal('set-enabled'), enabled: z.boolean().nullable() }),
  z.strictObject({
    operation: z.literal('add-key'),
    publicKey: z.string().min(1).max(SSH_ACCESS_MAX_KEY_TEXT_CHARS),
    label: z.string().max(SSH_ACCESS_MAX_LABEL_CHARS * 4).optional(),
  }),
  z.strictObject({ operation: z.literal('remove-key'), fingerprint: z.string().regex(/^SHA256:[A-Za-z0-9+/]{43}$/) }),
  z.strictObject({ operation: z.literal('remove-device'), deviceId: z.string().min(1).max(128) }),
  z.strictObject({ operation: z.literal('end-sessions') }),
]);

const IPC_CODES: Record<SshAccessTargetError['code'], IpcErrorCode> = {
  SSH_ACCESS_INVALID: 'INVALID_PARAMS',
  SSH_ACCESS_KEY_IN_USE: 'ALREADY_EXISTS',
  SSH_ACCESS_DISABLED: 'PRECONDITION_FAILED',
  SSH_ACCESS_UNAVAILABLE: 'PRECONDITION_FAILED',
  SSH_ACCESS_WRITE_FAILED: 'INTERNAL',
};

/** The IPC body: validates, runs the operation, maps target errors to IPC codes. */
export async function handleSshAccessRequest(target: SshAccessTarget | null, raw: unknown): Promise<unknown> {
  const parsed = requestSchema.safeParse(raw);
  if (!parsed.success) throwIpcError('INVALID_PARAMS', 'Invalid SSH access request');
  if (!target) throwIpcError('PRECONDITION_FAILED', 'SSH access is not available yet');
  const request: SshAccessRequest = parsed.data;
  try {
    switch (request.operation) {
      case 'read': return await target.readLocal();
      case 'set-enabled': return await target.setEnabled(request.enabled);
      case 'add-key': return await target.addManualKey(request.publicKey, request.label);
      case 'remove-key': return await target.removeManualKey(request.fingerprint);
      case 'remove-device': return await target.removeDevice(request.deviceId);
      case 'end-sessions': return await target.endAllSessions();
    }
  } catch (error) {
    if (error instanceof SshAccessTargetError) throwIpcError(IPC_CODES[error.code], error.message);
    throwIpcError('INTERNAL', 'SSH access request failed');
  }
}

export function registerSshAccessIpc(): void {
  ipcMain.handle(SSH_ACCESS_IPC_CHANNEL, (event, raw: unknown) => {
    assertTrustedAppRendererEvent(event);
    return handleSshAccessRequest(currentSshAccessTarget(), raw);
  });
}

/** Main → Cindy's own app windows: the SSH access state changed. */
export function broadcastSshAccessChanged(): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed() && isTrustedAppRendererWindow(window)) window.webContents.send(SSH_ACCESS_CHANGED_CHANNEL);
  }
}
