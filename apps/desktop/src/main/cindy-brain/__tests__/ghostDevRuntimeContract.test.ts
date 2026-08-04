import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

describe('dev-only plugin QA call boundary', () => {
  it('保持 packaged 隔离、可信 Renderer 校验和固定 preload 方法', () => {
    const main = fs.readFileSync(
      path.resolve(process.cwd(), 'src/main/cindy-brain/index.ts'),
      'utf8',
    );
    const preload = fs.readFileSync(path.resolve(process.cwd(), 'src/preload/preload.ts'), 'utf8');
    const devOnlyStart = main.indexOf("if (!app.isPackaged) {");
    const handlerStart = main.indexOf("ipcMain.handle('ghosts:dev-runtime'", devOnlyStart);
    const handlerEnd = main.indexOf("\n    });", handlerStart);
    const handler = main.slice(handlerStart, handlerEnd);

    expect(devOnlyStart).toBeGreaterThanOrEqual(0);
    expect(handlerStart).toBeGreaterThan(devOnlyStart);
    expect(handler).toContain('assertTrustedAppRendererEvent(event)');
    expect(handler).toContain("case 'call'");
    expect(handler).toContain('getGhostPipeDispatcher().callGhostTool');
    expect(preload).toContain("ipcRenderer.invoke('ghosts:dev-runtime', 'call', id, { tool, args })");
    expect(preload).not.toContain("devCall: (channel:");
  });
});
