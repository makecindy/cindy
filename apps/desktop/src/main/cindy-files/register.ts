import path from 'node:path';
import { ipcMain } from 'electron';
import { CindyFileError, type CindyFileOpenResult } from '../../shared/cindyFile';
import { activeOwnerScopeKey, isAppSessionBoundaryPending } from '../appSessionState';
import { createLogger } from '../logger';
import { getLocalThemesDir } from '../local-themes/loader';
import { installThemePackage } from '../local-themes/packages';
import { broadcastLocalThemes } from '../local-themes/register';
import { assertTrustedAppRendererEvent } from '../security/trustedAppRenderer.js';
import { inspectCindyFile } from './reader';

const log = createLogger('cindy-files');

async function openCindyFile(filePath: unknown): Promise<CindyFileOpenResult> {
  if (typeof filePath !== 'string' || filePath.length > 4096 || filePath.includes('\0')
    || !path.isAbsolute(filePath) || !filePath.toLowerCase().endsWith('.cindy')) return { type: 'invalid' };
  const owner = activeOwnerScopeKey();
  const assertCurrent = () => {
    if (isAppSessionBoundaryPending() || activeOwnerScopeKey() !== owner) throw new Error('Application session changed');
  };
  try {
    assertCurrent();
    const inspected = await inspectCindyFile(filePath);
    assertCurrent();
    if (inspected.type === 'plugin') return { type: 'plugin' };
    const names = await installThemePackage(inspected, getLocalThemesDir(), assertCurrent);
    assertCurrent();
    await broadcastLocalThemes();
    assertCurrent();
    return { type: 'theme', names };
  } catch (error) {
    if (error instanceof CindyFileError) return { type: error.code };
    log.warn('Cindy file import did not complete.');
    return { type: 'failed' };
  }
}

export function registerCindyFileIpc(): void {
  // Only the existing local file-open/drop/picker UI may use this capability.
  // It is not a remote/device-link channel and cannot execute package code.
  ipcMain.handle('cindy-files:open', async (event, filePath: unknown) => {
    assertTrustedAppRendererEvent(event);
    return openCindyFile(filePath);
  });
}
