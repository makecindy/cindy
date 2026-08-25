import { describe, expect, it } from 'vitest';
import fs from 'node:fs';

describe('legacy image cache settings', () => {
  it('does not scan message history during startup', () => {
    const bootstrap = fs.readFileSync(
      new URL('../bootstrap-electron.ts', import.meta.url),
      'utf8',
    );

    expect(bootstrap).not.toContain('sweepStartupDraftImages');
    expect(bootstrap).not.toContain('image-cache-orphan-sweep');
  });

  it('does not expose automatic scan or cleanup handlers', () => {
    const storageIpc = fs.readFileSync(
      new URL('../cindy-media/storageIpc.ts', import.meta.url),
      'utf8',
    );

    expect(storageIpc).not.toContain('scanLegacyDraftImages');
    expect(storageIpc).not.toContain('cleanupLegacyDraftImages');
    expect(storageIpc).not.toContain('FROM messages INDEXED BY');
  });

  it('guards the fixed directory opener with the trusted renderer check', () => {
    const bootstrap = fs.readFileSync(
      new URL('../bootstrap-electron.ts', import.meta.url),
      'utf8',
    );
    const start = bootstrap.indexOf("ipcMain.handle('cindy-media:legacy-images-open-dir'");
    expect(start).toBeGreaterThan(-1);
    expect(bootstrap.slice(start, start + 300)).toContain('assertTrustedAppRendererEvent(event)');
  });
});
