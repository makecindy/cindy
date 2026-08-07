import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const bootstrapSource = readFileSync(resolve(__dirname, '..', 'bootstrap-electron.ts'), 'utf8');

describe('persisted page zoom menu accelerators', () => {
  it('keeps both macOS zoom-in accelerator paths', () => {
    expect(bootstrapSource).toContain("'CommandOrControl+Plus'");
    expect(bootstrapSource).toContain("accelerator: 'CommandOrControl+='");
    expect(bootstrapSource).toContain('acceleratorWorksWhenHidden: true');
    expect(bootstrapSource).toContain("id: 'persisted-page-zoom-in-unshifted'");
  });

  it('guards every persistent renderer zoom write with the app-content sender check', () => {
    for (const channel of ['page-zoom:in', 'page-zoom:out', 'page-zoom:reset']) {
      const start = bootstrapSource.indexOf(`ipcMain.handle('${channel}'`);
      const end = bootstrapSource.indexOf('\n  });', start);
      const handler = bootstrapSource.slice(start, end);

      expect(start).toBeGreaterThanOrEqual(0);
      expect(handler).toContain('assertTrustedAppRendererEvent(event);');
      expect(handler.indexOf('assertTrustedAppRendererEvent(event);')).toBeLessThan(
        handler.indexOf('updatePersistedWindowZoom('),
      );
      expect(handler).not.toContain('mainWindowRef');
    }
  });
});
