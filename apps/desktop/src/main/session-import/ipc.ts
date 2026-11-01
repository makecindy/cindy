/**
 * 设置 → 任务导入 的 IPC。扫描只读；只有用户勾选并确认后才写入。
 */

import { ipcMain } from 'electron';

import { throwIpcError } from '../utils/ipcValidate.js';
import {
  cancelImport,
  importJob,
  latestImportJob,
  recoverInterruptedImports,
  relocateImportedSession,
  startImport,
} from './executor.js';
import { registerSessionImportRemoteResource } from './remoteResource.js';
import { invalidateImportScan, scanImportSources } from './scan.js';
import type { ImportJobView, ImportScanResult } from './types.js';

const MAX_KEYS = 5000;

function keysOf(request: unknown): string[] {
  const raw = (request as { keys?: unknown } | null)?.keys;
  if (!Array.isArray(raw)) throwIpcError('INVALID_PARAMS', 'keys must be an array');
  const keys = raw.filter((k): k is string => typeof k === 'string' && /^[a-z]+:[^\s]{1,512}$/.test(k));
  if (keys.length === 0) throwIpcError('INVALID_PARAMS', 'no valid keys');
  if (keys.length > MAX_KEYS) throwIpcError('INVALID_PARAMS', 'too many keys');
  return keys;
}

export function registerSessionImportIpc(): void {
  invalidateImportScan();
  registerSessionImportRemoteResource();

  ipcMain.handle('local-db:session-import:scan', async (_e, request?: { force?: unknown }): Promise<ImportScanResult> => {
    void recoverInterruptedImports();
    return scanImportSources(request?.force === true);
  });

  ipcMain.handle('local-db:session-import:start', async (_e, request: unknown): Promise<ImportJobView> => {
    return startImport(keysOf(request));
  });

  ipcMain.handle('local-db:session-import:status', async (_e, request?: { requestId?: unknown }): Promise<ImportJobView | null> => {
    await recoverInterruptedImports();
    const id = typeof request?.requestId === 'string' ? request.requestId : null;
    return id ? importJob(id) : latestImportJob();
  });

  ipcMain.handle('local-db:session-import:cancel', async (_e, request: { requestId?: unknown }): Promise<boolean> => {
    if (typeof request?.requestId !== 'string') throwIpcError('INVALID_PARAMS', 'requestId is required');
    return cancelImport(request.requestId);
  });

  ipcMain.handle('local-db:session-import:relocate', async (_e, request: { sessionId?: unknown; workingDir?: unknown }) => {
    if (typeof request?.sessionId !== 'string' || typeof request?.workingDir !== 'string') {
      throwIpcError('INVALID_PARAMS', 'sessionId and workingDir are required');
    }
    await relocateImportedSession(request.sessionId, request.workingDir);
    return { ok: true };
  });
}
