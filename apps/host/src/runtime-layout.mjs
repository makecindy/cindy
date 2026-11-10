import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Replaced by the release builder in every entry, including child workers.
// A release never guesses a checkout or reads a neighboring desktop install.
const release = typeof __CINDY_HOST_RELEASE__ === 'undefined' ? null : __CINDY_HOST_RELEASE__;
const root = release
  ? fileURLToPath(new URL('..', import.meta.url))
  : fileURLToPath(new URL('../../..', import.meta.url));

export function hostRuntimeLayout() {
  if (release && (release.platform !== process.platform || release.arch !== process.arch
      || release.modules !== process.versions.modules)) {
    throw new Error('HOST_RELEASE_PLATFORM_MISMATCH: use the bundled Node runtime for this platform');
  }
  const desktop = path.join(root, 'apps', 'desktop');
  const resource = (...parts) => path.join(root, 'resources', ...parts);
  const vec = process.platform === 'win32' ? 'vec0.dll' : process.platform === 'darwin' ? 'vec0.dylib' : 'vec0.so';
  return {
    packaged: Boolean(release),
    version: release?.version ?? JSON.parse(fs.readFileSync(path.join(desktop, 'package.json'), 'utf8')).version,
    configDir: release ? resource('config') : path.join(root, 'config'),
    drizzleDir: release ? resource('drizzle') : path.join(desktop, 'drizzle'),
    sqliteVecPath: release ? resource('native', vec) : path.join(desktop, 'native', 'sqlite-vec', `${process.platform}-${process.arch}`, vec),
    webDir: release ? resource('web') : path.join(desktop, '.vite', 'renderer', 'main_window'),
    shimPath: release ? resource('web', 'shim.js') : path.join(root, 'apps', 'web', 'shim.js'),
    snapshotWorker: release ? path.join(root, 'bin', 'snapshot-worker.cjs') : path.join(desktop, 'src', 'main', 'cindy-brain', 'ghostSnapshotWorkerProcess.ts'),
    libraryWorker: release ? path.join(root, 'bin', 'library-worker.mjs') : null,
    atomicRenameBinary: release ? resource('tools', 'windows-atomic-rename', 'cindy-windows-atomic-rename.exe') : null,
    atomicRenameSource: release ? null : path.join(desktop, 'native', 'windows-atomic-rename', 'main.rs'),
    nodeWorker: release ? path.join(root, 'bin', 'node-worker.cjs') : null,
    pluginBridge: release ? resource('plugin-bridge.js') : null,
    credentialScript: release ? path.join(root, 'bin', 'electron-codec.cjs') : path.join(root, 'apps', 'host', 'src', 'credentials', 'electron-codec.cjs'),
    electronBinary: release?.electronBinary ? path.join(root, release.electronBinary) : null,
    chromiumExecutable: release?.chromiumExecutable ? path.join(root, release.chromiumExecutable) : null,
    harnessRoot: release ? resource('harnesses') : path.join(root, 'apps'),
  };
}
