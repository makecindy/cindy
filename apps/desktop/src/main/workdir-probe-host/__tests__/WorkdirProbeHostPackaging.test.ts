/** Directory probing stays asynchronous inside Electron main. */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const desktopRoot = path.resolve(process.cwd());

describe('workdir probe packaging contract', () => {
  it('does not package a utility-process probe host', () => {
    const forge = fs.readFileSync(path.join(desktopRoot, 'forge.config.ts'), 'utf8');
    const wiring = fs.readFileSync(
      path.join(desktopRoot, 'src/main/workdir-probe-host/index.ts'),
      'utf8',
    );
    expect(forge).not.toContain('workdir-probe-host/workdirProbeHostProcess.ts');
    expect(wiring).not.toContain('utilityProcess');
    expect(wiring).toContain('MainProcessWorkdirProbeClient');
  });

  it('keeps the probe deadline and quit cleanup in the main process', () => {
    const wiring = fs.readFileSync(
      path.join(desktopRoot, 'src/main/workdir-probe-host/index.ts'),
      'utf8',
    );
    expect(wiring).toContain('5_000');
    expect(wiring).toContain("app.once('before-quit'");
  });
});
