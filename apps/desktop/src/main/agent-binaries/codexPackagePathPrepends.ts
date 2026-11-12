import fs from 'node:fs';
import path from 'node:path';

// Leaf module (no Electron) so the Node Host can share the Codex runtime config.
/** Windows keeps the inherited PATH; only prepend bin for an actual Codex package. */
export function codexPackagePathPrepends(binaryPath: string | undefined, platform: NodeJS.Platform): string[] {
  if (platform !== 'win32' || !binaryPath) return [];
  const paths = path.win32;
  const binDir = paths.dirname(binaryPath);
  if (paths.basename(binaryPath) !== 'codex.exe' || paths.basename(binDir) !== 'bin') return [];
  return fs.existsSync(paths.join(paths.dirname(binDir), 'codex-package.json')) ? [binDir] : [];
}
