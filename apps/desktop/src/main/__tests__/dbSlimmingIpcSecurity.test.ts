import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

describe('database slimming IPC security wiring', () => {
  it('checks the trusted Renderer boundary before every maintenance action', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '..', 'bootstrap-electron.ts'),
      'utf8',
    );
    const channels = [
      'scan',
      'choose-backup-directory',
      'schedule',
      'last-result',
      'open-last-backup-directory',
    ];

    for (const channel of channels) {
      const start = source.indexOf(`ipcMain.handle('local-db:maintenance:${channel}'`);
      const next = source.indexOf('\n    ipcMain.handle(', start + 1);
      const block = source.slice(start, next === -1 ? start + 500 : next);
      const guard = block.indexOf('assertTrustedAppRendererEvent(event);');
      const sanitizer = block.indexOf('invokeLocalDbMaintenanceIpc(');
      const action = block.indexOf('localDbMaintenanceHandlers.');

      expect(start, channel).toBeGreaterThanOrEqual(0);
      expect(guard, channel).toBeGreaterThanOrEqual(0);
      expect(sanitizer, channel).toBeGreaterThan(guard);
      expect(action, channel).toBeGreaterThan(guard);
      expect(action, channel).toBeGreaterThan(sanitizer);
    }
  });

  it('keeps unexpected maintenance details in Main and requires native no-backup consent', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '..', 'bootstrap-electron.ts'),
      'utf8',
    );
    const sanitizerStart = source.indexOf('const invokeLocalDbMaintenanceIpc');
    const firstHandler = source.indexOf("ipcMain.handle('local-db:maintenance:scan'", sanitizerStart);
    const sanitizer = source.slice(sanitizerStart, firstHandler);

    expect(sanitizerStart).toBeGreaterThanOrEqual(0);
    expect(sanitizer).toContain('if (isIpcError(error)) throw error;');
    expect(sanitizer).toContain("throwIpcError('INTERNAL', 'database maintenance request failed')");
    expect(source).toContain('confirmWithoutBackup: async () =>');
    expect(source).toContain('await dialog.showMessageBox');
  });
});
