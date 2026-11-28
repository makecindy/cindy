/**
 * Settings IPC for SSH access (shared/sshAccess.ts): "allow my other devices to SSH into this computer" (the target,
 * `ssh-access:request`) and the hosts this computer keeps for the person's other devices (the controller,
 * `ssh-device-hosts:request`). One channel each, a validated request union, Cindy's own top-level app frames only;
 * the business bodies are `handleSshAccessRequest` and `handleSshDeviceHostsRequest`, testable without Electron.
 * Errors use the IPC error protocol and never carry paths or key material.
 */
import { BrowserWindow, ipcMain } from 'electron';
import { z } from 'zod';
import { SSH_ACCESS_MAX_KEY_TEXT_CHARS } from '@cindy/device-link';
import {
  SSH_ACCESS_CHANGED_CHANNEL,
  SSH_ACCESS_IPC_CHANNEL,
  SSH_DEVICE_HOSTS_CHANGED_CHANNEL,
  SSH_DEVICE_HOSTS_IPC_CHANNEL,
  type SshAccessLocalRequest,
  type SshDeviceHostView,
  type SshDeviceHostsRequest,
} from '../../shared/sshAccess.js';
import { assertTrustedAppRendererEvent, isTrustedAppRendererWindow } from '../security/trustedAppRenderer.js';
import { throwIpcError } from '../utils/ipcValidate.js';
import type { IpcErrorCode } from '../../shared/ipc-errors.js';
import { SshAccessKeyLimitError, SshAccessTargetError, type SshAccessTarget } from './sshAccessTargetCore.js';
import { SSH_ACCESS_MAX_LABEL_CHARS } from './sshAccessRecord.js';
import { currentSshAccessTarget } from './sshAccessTarget.desktop.js';
import type { SshAccessController } from './sshAccessController.js';

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
  const request: SshAccessLocalRequest = parsed.data;
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
    // The add-key dialog names the limit instead of "try again later".
    if (error instanceof SshAccessKeyLimitError) throwIpcError('SSH_ACCESS_KEY_LIMIT', error.message);
    if (error instanceof SshAccessTargetError) throwIpcError(IPC_CODES[error.code], error.message);
    throwIpcError('INTERNAL', 'SSH access request failed');
  }
}

/**
 * The controller the device-link service created (sshAccessController.desktop.ts binds it here), so this IPC module
 * stays free of the SSH host list and its imports.
 */
let deviceHostsController: Pick<SshAccessController, 'readState' | 'restoreHost'> | null = null;

export function bindSshDeviceHostsController(controller: Pick<SshAccessController, 'readState' | 'restoreHost'> | null): void {
  deviceHostsController = controller;
}

const deviceHostsRequestSchema = z.discriminatedUnion('operation', [
  z.strictObject({ operation: z.literal('read') }),
  z.strictObject({ operation: z.literal('restore'), deviceId: z.string().min(1).max(128) }),
]);

/** The controller's IPC body: the device hosts this computer keeps, and 「添加到 SSH 远程主机」. */
export async function handleSshDeviceHostsRequest(
  controller: Pick<SshAccessController, 'readState' | 'restoreHost'> | null,
  raw: unknown,
): Promise<SshDeviceHostView[]> {
  const parsed = deviceHostsRequestSchema.safeParse(raw);
  if (!parsed.success) throwIpcError('INVALID_PARAMS', 'Invalid SSH device hosts request');
  // Not created yet (signed out, device link not started): there is nothing to show.
  if (!controller) return [];
  const request: SshDeviceHostsRequest = parsed.data;
  try {
    return request.operation === 'read' ? await controller.readState() : await controller.restoreHost(request.deviceId);
  } catch {
    throwIpcError('INTERNAL', 'SSH device hosts request failed');
  }
}

export function registerSshAccessIpc(): void {
  ipcMain.handle(SSH_ACCESS_IPC_CHANNEL, (event, raw: unknown) => {
    assertTrustedAppRendererEvent(event);
    return handleSshAccessRequest(currentSshAccessTarget(), raw);
  });
  ipcMain.handle(SSH_DEVICE_HOSTS_IPC_CHANNEL, (event, raw: unknown) => {
    assertTrustedAppRendererEvent(event);
    return handleSshDeviceHostsRequest(deviceHostsController, raw);
  });
}

/** Main → Cindy's own app windows: the SSH access state changed. */
export function broadcastSshAccessChanged(): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed() && isTrustedAppRendererWindow(window)) window.webContents.send(SSH_ACCESS_CHANGED_CHANNEL);
  }
}

/** Main → Cindy's own app windows: the hosts kept for the person's other devices changed. */
export function broadcastSshDeviceHostsChanged(): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed() && isTrustedAppRendererWindow(window)) window.webContents.send(SSH_DEVICE_HOSTS_CHANGED_CHANNEL);
  }
}
