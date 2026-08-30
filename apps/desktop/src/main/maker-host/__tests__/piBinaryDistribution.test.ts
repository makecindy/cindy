/** Pi 正式版二进制必须与 Claude Code / Codex 一样只走 CDN，不能重新塞回安装包。 */

import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const desktopRoot = path.resolve(process.cwd());

describe('Pi binary distribution contract', () => {
  it('does not stage or copy Pi into packaged resources', () => {
    const forge = fs.readFileSync(path.join(desktopRoot, 'forge.config.ts'), 'utf8');

    expect(forge).not.toContain('function stagePi(');
    expect(forge).not.toContain("'resources/pi'");
    expect(forge).not.toContain('stagePi(targetPlatform');
  });

  it('resolves Pi only through the managed CDN/dev binary chain', () => {
    const host = fs.readFileSync(
      path.join(desktopRoot, 'src/main/maker-host/pi-host.ts'),
      'utf8',
    );

    expect(host).toContain("getReadyBinaryPath('pi')");
    expect(host).not.toContain("getCachedBinaryStatus('pi')");
    expect(host).not.toContain("path.join(process.resourcesPath, 'pi'");
    expect(host).not.toContain('安装包自带');
  });

  it('bounds optional Pi preparation so CDN trouble cannot hold the startup page', () => {
    const bootstrap = fs.readFileSync(
      path.join(desktopRoot, 'src/main/bootstrap-electron.ts'),
      'utf8',
    );
    const binaries = fs.readFileSync(
      path.join(desktopRoot, 'src/main/agent-binaries/index.ts'),
      'utf8',
    );

    expect(bootstrap).toContain('PI_AGENT_INSTALL_STARTUP_DEADLINE_MS = 60_000');
    expect(bootstrap).toContain('signal: piInstallSignal');
    expect(binaries).toContain('signal: opts.signal');
  });

  it('preserves a locally self-updated Pi when its real version is not below the manifest', () => {
    const binaries = fs.readFileSync(
      path.join(desktopRoot, 'src/main/agent-binaries/index.ts'),
      'utf8',
    );

    expect(binaries).toContain('preserveLocalVersion: true');
    expect(binaries).toContain('localVersionResolver: cfg.preserveLocalVersion');
  });

  it('does not expose an old Pi cache through the binary-version IPC', () => {
    const binaryVersion = fs.readFileSync(
      path.join(desktopRoot, 'src/main/maker-ipc/binary-version.ts'),
      'utf8',
    );

    expect(binaryVersion).toContain("if (kind === 'pi') return null;");
  });

  it('schedules Pi recovery after a failed optional prepare', () => {
    const bootstrap = fs.readFileSync(
      path.join(desktopRoot, 'src/main/bootstrap-electron.ts'),
      'utf8',
    );

    expect(bootstrap).toContain('createPiRuntimeRecovery');
    expect(bootstrap).toContain('piRuntimeRecovery.markUnavailable');
    expect(bootstrap).toContain('registerPiAgentIfAvailable');
  });

  it('does not override Pi memory when the runtime recovers', () => {
    const host = fs.readFileSync(
      path.join(desktopRoot, 'src/main/maker-host/index.ts'),
      'utf8',
    );

    expect(host).not.toContain("syncNativeAgentsOff(['pi'])");
  });
});
