import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { app } from 'electron';

import launcher from '../../../../../tools/codex-package/codex-path-launcher.sh?raw';
import { createLogger } from '../logger.js';

const log = createLogger('agent-binaries/codex-cli-launcher');
const managedMarker = launcher.split('\n')[1];

/** Windows keeps the inherited PATH; only prepend bin for an actual Codex package. */
export function codexPackagePathPrepends(binaryPath: string | undefined, platform: NodeJS.Platform): string[] {
  if (platform !== 'win32' || !binaryPath) return [];
  const paths = path.win32;
  const binDir = paths.dirname(binaryPath);
  if (paths.basename(binaryPath) !== 'codex.exe' || paths.basename(binDir) !== 'bin') return [];
  return fs.existsSync(paths.join(paths.dirname(binDir), 'codex-package.json')) ? [binDir] : [];
}

/**
 * Codex restores the login shell PATH on Unix, then prepends its own codex-path.
 * Patch only the selected packaged runtime. Dev installs own their strict manifest.
 * Failure must never prevent an otherwise usable Codex runtime from starting.
 */
export function ensureCodexCliLauncher(
  binaryPath: string,
  { isPackaged = app.isPackaged, platform = process.platform, userDataPath = app.getPath('userData') } = {},
): void {
  if (!isPackaged || platform === 'win32') return;
  let tempPath: string | undefined;
  try {
    const packageRoot = path.dirname(path.dirname(binaryPath));
    if (path.basename(binaryPath) !== 'codex'
      || path.basename(path.dirname(binaryPath)) !== 'bin'
      || path.dirname(packageRoot) !== path.resolve(userDataPath, 'codex-package')) return;
    const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, 'codex-package.json'), 'utf8'));
    if (manifest.pathDir !== 'codex-path') return;
    const pathDir = path.join(packageRoot, 'codex-path');
    if (!fs.statSync(pathDir).isDirectory()) return;
    const destination = path.join(pathDir, 'codex');
    if (fs.existsSync(destination)) {
      const existing = fs.readFileSync(destination, 'utf8');
      if (existing === launcher || existing.split(/\r?\n/)[1] !== managedMarker) return;
    }
    tempPath = `${destination}.launcher-${randomUUID()}`;
    fs.writeFileSync(tempPath, launcher, { encoding: 'utf8', mode: 0o755 });
    fs.chmodSync(tempPath, 0o755);
    fs.renameSync(tempPath, destination);
  } catch (error) {
    log.warn('Could not prepare bundled Codex shell launcher', { error });
  } finally {
    if (tempPath) {
      try { fs.rmSync(tempPath, { force: true }); } catch { /* best effort */ }
    }
  }
}
