import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { app, dialog, shell, type MenuItemConstructorOptions } from 'electron';

import { createLogger, getLogDir } from './logger';
import { t } from './i18n';

const log = createLogger('log-support');

/** Uses the active logger destination, including isolated/dev instances; requires no auth or DB. */
export async function openLogsDirectory(): Promise<{ success: boolean }> {
  try {
    const directory = getLogDir() || path.join(app.getPath('userData'), 'logs');
    await mkdir(directory, { recursive: true });
    const error = await shell.openPath(directory);
    if (error) {
      log.warn('could not open logs directory', error);
      return { success: false };
    }
    return { success: true };
  } catch (error) {
    log.warn('could not open logs directory', error);
    return { success: false };
  }
}

/** Native escape hatch: remains usable when the renderer cannot receive menu commands. */
export function createOpenLogsMenuItem(): MenuItemConstructorOptions {
  return {
    label: t('credentialStore.dialog.openLogs'),
    click: () => {
      void (async () => {
        const result = await openLogsDirectory();
        if (!result.success) {
          await dialog.showMessageBox({
            type: 'error',
            title: t('logSupport.title'),
            message: t('settings.about.openLogsDirError'),
            buttons: [t('logSupport.close')],
          });
        }
      })().catch((error) => log.warn('could not show logs directory error', error));
    },
  };
}
