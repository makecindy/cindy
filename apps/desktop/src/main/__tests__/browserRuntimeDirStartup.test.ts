import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Chrome --user-data-dir joins CONFIG_DIR at launch. Vite's main bundle
 * require()s @cindy/browser-control-runtime before index.ts body, so the pin
 * must sit after the last userData setPath, refresh the live CONFIG_DIR
 * binding, and happen before dispatch.
 */
describe('browser runtime dir startup pin', () => {
  const indexSource = readFileSync(resolve(process.cwd(), 'src/main/index.ts'), 'utf8').replace(
    /\r\n/g,
    '\n',
  );

  it('pins XDT_BROWSER_RUNTIME_DIR after the last userData path and before bootstrap', () => {
    const lastSetPathIdx = indexSource.lastIndexOf("app.setPath('userData'");
    const pinIdx = indexSource.indexOf("process.env.XDT_BROWSER_RUNTIME_DIR = path.join(app.getPath('userData'), 'browser-runtime')");
    const refreshIdx = indexSource.indexOf('refreshBrowserRuntimeConfigDir()');
    const bootstrapIdx = indexSource.indexOf("import('./bootstrap-electron.js')");
    expect(lastSetPathIdx).toBeGreaterThan(-1);
    expect(pinIdx).toBeGreaterThan(lastSetPathIdx);
    expect(refreshIdx).toBeGreaterThan(pinIdx);
    expect(bootstrapIdx).toBeGreaterThan(refreshIdx);
    expect(indexSource).toContain("if (!process.env.XDT_BROWSER_RUNTIME_DIR)");
    expect(indexSource).toContain("from '@cindy/browser-control-runtime/config-dir'");
    expect(indexSource).not.toMatch(/from ['"]@cindy\/browser-control-runtime['"]/);
  });
});
