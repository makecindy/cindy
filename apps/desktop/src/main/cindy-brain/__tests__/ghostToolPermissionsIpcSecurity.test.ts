import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

describe('Ghost tool-permission read IPC security contract', () => {
  it('gates the owner-scoped read on the trusted renderer without throwing out of the sendSync handler', () => {
    const main = fs.readFileSync(
      path.resolve(process.cwd(), 'src/main/cindy-brain/index.ts'),
      'utf8',
    );
    const handlerStart = main.indexOf("ipcMain.on('ghosts:tool-permissions'");
    const handlerEnd = main.indexOf('\n  });', handlerStart);
    const handler = main.slice(handlerStart, handlerEnd);

    expect(handlerStart).toBeGreaterThanOrEqual(0);
    expect(handlerEnd).toBeGreaterThan(handlerStart);
    // 来源闸仍在,且必须先于读取。
    expect(handler).toContain('isTrustedAppRendererEvent(event)');
    expect(handler.indexOf('isTrustedAppRendererEvent(event)')).toBeLessThan(
      handler.indexOf('readGhostToolPermissions('),
    );
    // sendSync 的 handler 抛出 => event.returnValue 永不赋值 => Electron 不回
    // reply => 调用方 renderer 同步卡死。断言这里不用抛出式的来源闸,
    // 并且任何路径都会给 returnValue 赋值(读盘异常也被 try/catch 兜住)。
    expect(handler).not.toContain('assertTrustedAppRendererEvent(');
    expect(handler).toContain('event.returnValue');
    expect(handler).toContain('} catch (error) {');
  });

  it('validates installed ghost and manifest tool allowlist before persisting permissions', () => {
    const main = fs.readFileSync(
      path.resolve(process.cwd(), 'src/main/cindy-brain/index.ts'),
      'utf8',
    );
    const handlerStart = main.indexOf("ipcMain.handle('ghosts:tool-permissions:set'");
    const handlerEnd = main.indexOf('\n  });', handlerStart);
    const handler = main.slice(handlerStart, handlerEnd);

    expect(handlerStart).toBeGreaterThanOrEqual(0);
    expect(handler).toContain('manager.list().find(');
    expect(handler).toContain('undeclaredToolPermissionKeys(config, installed.manifest.tools)');
    expect(handler).toContain("throwIpcError('NOT_FOUND'");
    expect(handler).toMatch(/throwIpcError\(\r?\n\s*'INVALID_PARAMS'/);
    expect(handler.indexOf('manager.list().find(')).toBeLessThan(
      handler.indexOf('writeGhostToolPermissions('),
    );
    expect(handler.indexOf('undeclaredToolPermissionKeys(')).toBeLessThan(
      handler.indexOf('writeGhostToolPermissions('),
    );
  });
});
