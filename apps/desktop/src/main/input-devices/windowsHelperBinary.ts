import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { app } from 'electron';

const execFileAsync = promisify(execFile);

/** Only these bundled, main-owned input helpers may be compiled/launched. */
export async function resolveWindowsInputHelper(kind: 'gamepad' | 'micro'): Promise<string> {
  const group = kind === 'gamepad' ? 'xbox-gamepad' : 'worklouder';
  const crate = `windows-${kind}-helper`;
  const name = `cindy-windows-${kind}-helper.exe`;
  if (app.isPackaged) return path.join(process.resourcesPath, 'tools', group, name);
  const relative = path.join('native', group, crate);
  const fromApp = path.join(app.getAppPath(), relative);
  const source = fs.existsSync(fromApp) ? fromApp : path.join(__dirname, '..', '..', relative);
  const target =
    process.arch === 'arm64'
      ? 'aarch64-pc-windows-msvc'
      : process.arch === 'x64'
        ? 'x86_64-pc-windows-msvc'
        : null;
  if (!target) throw new Error('Unsupported Windows input helper architecture');
  // The default dev profile is shared across checkouts. A newer binary in one
  // checkout must never satisfy another checkout's source-mtime check.
  const checkoutId = createHash('sha256')
    .update(fs.realpathSync(source))
    .digest('hex')
    .slice(0, 16);
  const targetDir = path.join(app.getPath('userData'), group, 'build', checkoutId);
  const binary = path.join(targetDir, target, 'release', name);
  const sources = [
    'Cargo.toml',
    'Cargo.lock',
    ...fs
      .readdirSync(path.join(source, 'src'))
      .filter((file) => file.endsWith('.rs'))
      .map((file) => path.join('src', file)),
  ];
  if (fs.existsSync(binary)) {
    const builtAt = fs.statSync(binary).mtimeMs;
    if (sources.every((file) => fs.statSync(path.join(source, file)).mtimeMs <= builtAt))
      return binary;
  }
  const userCargo = process.env.USERPROFILE
    ? path.join(process.env.USERPROFILE, '.cargo', 'bin', 'cargo.exe')
    : 'cargo';
  await execFileAsync(
    fs.existsSync(userCargo) ? userCargo : 'cargo',
    [
      'build',
      '--locked',
      '--release',
      '--target',
      target,
      '--manifest-path',
      path.join(source, 'Cargo.toml'),
      '--target-dir',
      targetDir,
    ],
    { timeout: 120_000, windowsHide: true },
  );
  return binary;
}
