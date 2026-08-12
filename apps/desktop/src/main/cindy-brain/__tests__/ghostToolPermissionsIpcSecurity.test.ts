import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

describe('Ghost tool-permission read IPC security contract', () => {
  it('checks the trusted renderer before reading owner-scoped tool permissions', () => {
    const main = fs.readFileSync(
      path.resolve(process.cwd(), 'src/main/cindy-brain/index.ts'),
      'utf8',
    );
    const handlerStart = main.indexOf("ipcMain.on('ghosts:tool-permissions'");
    const handlerEnd = main.indexOf('\n  });', handlerStart);
    const handler = main.slice(handlerStart, handlerEnd);

    expect(handlerStart).toBeGreaterThanOrEqual(0);
    expect(handlerEnd).toBeGreaterThan(handlerStart);
    expect(handler).toContain('assertTrustedAppRendererEvent(event);');
    expect(handler.indexOf('assertTrustedAppRendererEvent(event);')).toBeLessThan(
      handler.indexOf('readGhostToolPermissions('),
    );
  });
});
