/** workdirProbeHostPackaging.test — 目录探测隔离进程的打包与权限边界契约。 */

import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const desktopRoot = path.resolve(process.cwd());

describe('workdir probe host packaging contract', () => {
  it('将 utility-process 入口打成独立 CJS bundle', () => {
    const forge = fs.readFileSync(path.join(desktopRoot, 'forge.config.ts'), 'utf8');
    const wiring = fs.readFileSync(
      path.join(desktopRoot, 'src/main/workdir-probe-host/index.ts'),
      'utf8',
    );

    expect(forge).toContain("entry: 'src/main/workdir-probe-host/workdirProbeHostProcess.ts'");
    expect(forge).toContain("config: 'vite.preload.config.ts'");
    expect(forge).toContain("target: 'preload'");
    expect(wiring).toContain("path.join(__dirname, 'workdirProbeHostProcess.js')");
    expect(wiring).toContain('utilityProcess.fork');
    expect(wiring).toContain("app.once('before-quit'");
  });

  it('不向探测进程继承完整环境或宿主 cwd', () => {
    const wiring = fs.readFileSync(
      path.join(desktopRoot, 'src/main/workdir-probe-host/index.ts'),
      'utf8',
    );

    expect(wiring).toContain('const env: NodeJS.ProcessEnv = {}');
    expect(wiring).not.toContain('...process.env');
    expect(wiring).toContain('cwd: os.tmpdir()');
  });
});
