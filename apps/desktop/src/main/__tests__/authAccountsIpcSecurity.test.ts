import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

describe('desktop saved-account IPC boundary', () => {
  const source = readFileSync(resolve(__dirname, '..', 'bootstrap-electron.ts'), 'utf8');
  const channels = [
    'auth:accounts:list',
    'auth:accounts:sync',
    'auth:accounts:switch',
    'auth:accounts:begin-add',
    'auth:accounts:cancel-add',
  ];

  it.each(channels)('%s rejects an untrusted renderer before calling authManager', (channel) => {
    const start = source.indexOf(`ipcMain.handle('${channel}'`);
    const end = source.indexOf('\n  });', start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const handler = source.slice(start, end);
    expect(handler).toContain('assertTrustedAppRendererEvent(event);');
    expect(handler.indexOf('assertTrustedAppRendererEvent(event);')).toBeLessThan(
      handler.indexOf('authManager.'),
    );
  });

  it.each([
    'auth:accounts:sync',
    'auth:accounts:switch',
    'auth:accounts:begin-add',
  ])('%s converts auth failures to the shared IPC error protocol', (channel) => {
    const start = source.indexOf(`ipcMain.handle('${channel}'`);
    const end = source.indexOf('\n  });', start);
    const handler = source.slice(start, end);
    expect(handler).toContain('catch (error)');
    expect(handler).toContain('throwAuthAccountIpcError(error);');
  });
});
