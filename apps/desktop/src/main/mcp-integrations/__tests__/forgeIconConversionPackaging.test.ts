import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const desktopRoot = path.resolve(process.cwd());

describe('Forge icon conversion process packaging contract', () => {
  it('将 Sharp 转换器打成独立 utility-process bundle', () => {
    const forge = fs.readFileSync(path.join(desktopRoot, 'forge.config.ts'), 'utf8');
    const wiring = fs.readFileSync(
      path.join(desktopRoot, 'src/main/mcp-integrations/forgeIconConversionHost.ts'),
      'utf8',
    );

    expect(forge).toContain(
      "entry: 'src/main/mcp-integrations/forgeIconConversionProcess.ts'",
    );
    expect(forge).toContain("config: 'vite.forge-icon-conversion-process.config.ts'");
    expect(forge).toContain("target: 'preload'");
    expect(wiring).toContain("path.join(__dirname, 'forgeIconConversionProcess.js')");
    expect(wiring).toContain('utilityProcess.fork');
  });

  it('不向转换进程继承完整环境或宿主 cwd', () => {
    const wiring = fs.readFileSync(
      path.join(desktopRoot, 'src/main/mcp-integrations/forgeIconConversionHost.ts'),
      'utf8',
    );

    expect(wiring).toContain('const env: NodeJS.ProcessEnv = {}');
    expect(wiring).not.toContain('...process.env');
    expect(wiring).toContain('cwd: os.tmpdir()');
  });
});
