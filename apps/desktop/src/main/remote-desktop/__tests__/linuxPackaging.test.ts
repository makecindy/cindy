import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { expect, it } from 'vitest';

const forge = fs.readFileSync(
  path.resolve(import.meta.dirname, '../../../../forge.config.ts'),
  'utf8',
);
const start = forge.indexOf('      // Optional, ABI-pinned compositor integration.');
const end = forge.indexOf('      const credentialsDir', start);
if (start < 0 || end < 0) throw new Error('Missing Linux privacy packaging block');
const privacyBuild = forge.slice(start, end);

it.each(['missing', 'mismatch', 'failure', 'success'])(
  'never packages stale privacy artifacts when the optional build is %s',
  (scenario) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-privacy-package-'));
    const destDir = path.join(directory, 'resources');
    const temporary = path.join(directory, 'build');
    const names = ['cindy-hyprland-privacy.so', 'cindy-hyprland-privacy.json'];
    fs.mkdirSync(destDir);
    fs.mkdirSync(temporary);
    for (const name of names) fs.writeFileSync(path.join(destDir, name), 'old revision');
    fs.writeFileSync(path.join(destDir, 'cindy-linux-desktop-input'), 'unrelated helper');
    let builds = 0;
    try {
      const run = () =>
        vm.runInNewContext(privacyBuild, {
          fs,
          path,
          destDir,
          temporary,
          __dirname: directory,
          process: { execPath: 'fixture-node' },
          spawnSync(command: string) {
            // Cleanup must precede even the header probe (including probe failure).
            for (const name of names) expect(fs.existsSync(path.join(destDir, name))).toBe(false);
            if (command === 'pkg-config')
              return {
                status: scenario === 'missing' ? 1 : 0,
                stdout: scenario === 'mismatch' ? '0.56.3\n' : '0.56.2\n',
              };
            builds++;
            if (scenario === 'failure') return { status: 1 };
            for (const name of names) fs.writeFileSync(path.join(temporary, name), 'new revision');
            return { status: 0 };
          },
        });
      if (scenario === 'failure') expect(run).toThrow('Linux desktop privacy build failed');
      else run();
      expect(builds).toBe(['success', 'failure'].includes(scenario) ? 1 : 0);
      for (const name of names) {
        const destination = path.join(destDir, name);
        if (scenario === 'success')
          expect(fs.readFileSync(destination, 'utf8')).toBe('new revision');
        else expect(fs.existsSync(destination)).toBe(false);
      }
      expect(fs.readFileSync(path.join(destDir, 'cindy-linux-desktop-input'), 'utf8')).toBe(
        'unrelated helper',
      );
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  },
);
