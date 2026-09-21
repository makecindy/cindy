import * as fs from 'node:fs';
import * as path from 'node:path';

/** Prepare node-pty in the disposable package copy, never in the source checkout. */
export function preparePackagedNodePty(buildPath: string, platform: string, arch: string) {
  const packageDir = path.join(buildPath, 'node_modules', 'node-pty');
  // The pinned npm package ships macOS/Windows prebuilds; Linux still builds from source.
  if (platform !== 'win32' && platform !== 'darwin') {
    return {
      rebuild: true,
      nativePath: path.join(packageDir, 'build', 'Release', 'pty.node'),
    };
  }

  const prebuildDir = path.join(packageDir, 'prebuilds', `${platform}-${arch}`);
  const required =
    platform === 'win32'
      ? [
          'pty.node',
          'conpty.node',
          'conpty_console_list.node',
          'winpty-agent.exe',
          'winpty.dll',
          path.join('conpty', 'conpty.dll'),
          path.join('conpty', 'OpenConsole.exe'),
        ]
      : ['pty.node', 'spawn-helper'];
  const missing = required.filter((file) => {
    try {
      const info = fs.statSync(path.join(prebuildDir, file));
      return !info.isFile() || info.size === 0;
    } catch {
      return true;
    }
  });
  if (missing.length) {
    throw new Error(
      `[forge:afterCopy] node-pty prebuild for ${platform}-${arch} is incomplete: ${missing.join(', ')}. ` +
        'Reinstall workspace dependencies with pnpm install --force --frozen-lockfile, then package again.',
    );
  }

  // node-pty loads build/Release and build/Debug before prebuilds. Remove copied
  // local bindings so a stale Node ABI or another architecture cannot shadow the target.
  for (const variant of ['Release', 'Debug']) {
    for (const file of ['pty.node', 'conpty.node', 'conpty_console_list.node']) {
      fs.rmSync(path.join(packageDir, 'build', variant, file), { force: true });
    }
  }
  if (platform === 'darwin') {
    // pnpm can lose the executable bit while importing spawn-helper from its store.
    fs.chmodSync(path.join(prebuildDir, 'spawn-helper'), 0o755);
  }
  return { rebuild: false, nativePath: path.join(prebuildDir, 'pty.node') };
}
