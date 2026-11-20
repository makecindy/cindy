import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Replaced by the release builder in every entry, including child workers.
// A release never guesses a checkout or reads a neighboring desktop install.
const release = typeof __CINDY_HOST_RELEASE__ === 'undefined' ? null : __CINDY_HOST_RELEASE__;
const root = release
  ? fileURLToPath(new URL('..', import.meta.url))
  : fileURLToPath(new URL('../../..', import.meta.url));

/** The edition a release was built for (scripts/build.mjs --region); null when running from source. */
export function hostReleaseRegion() {
  return release?.region ?? null;
}

// Electron's npm entry can synchronously run its installer. Read the installed
// package's marker directly so source commands never start a download.
// 源码方式不读 ELECTRON_OVERRIDE_DIST_PATH。
export function resolveSourceElectronBinary() {
  try {
    const manifest = createRequire(new URL('../../desktop/package.json', import.meta.url)).resolve('electron/package.json');
    const directory = path.dirname(manifest);
    const dist = path.join(directory, 'dist');
    const binary = path.resolve(dist, fs.readFileSync(path.join(directory, 'path.txt'), 'utf8').trim());
    return binary.startsWith(dist + path.sep) && fs.statSync(binary).isFile() ? binary : null;
  } catch {
    return null;
  }
}

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
    // The built-in Skill bundle the Host publishes (user decision: the personal Host ships its own
    // copy; release table row 25). From source: the desktop's own development bundle.
    systemSkillsDir: release ? resource('system-skills') : path.join(desktop, 'resources', 'system-skills'),
    sqliteVecPath: release ? resource('native', vec) : path.join(desktop, 'native', 'sqlite-vec', `${process.platform}-${process.arch}`, vec),
    webDir: release ? resource('web') : path.join(desktop, '.vite', 'renderer', 'main_window'),
    shimPath: release ? resource('web', 'shim.js') : path.join(root, 'apps', 'web', 'shim.js'),
    snapshotWorker: release ? path.join(root, 'bin', 'snapshot-worker.cjs') : path.join(desktop, 'src', 'main', 'cindy-brain', 'ghostSnapshotWorkerProcess.ts'),
    libraryWorker: release ? path.join(root, 'bin', 'library-worker.mjs') : null,
    atomicRenameBinary: release ? resource('tools', 'windows-atomic-rename', 'cindy-windows-atomic-rename.exe') : null,
    atomicRenameSource: release ? null : path.join(desktop, 'native', 'windows-atomic-rename', 'main.rs'),
    nodeWorker: release ? path.join(root, 'bin', 'node-worker.cjs') : null,
    piSubagentRunner: release ? path.join(root, 'bin', 'pi-subagent-runner.cjs') : path.join(root, 'apps', 'host', 'src', 'agent', 'pi-subagent-runner-process.cts'),
    pluginBridge: release ? resource('plugin-bridge.js') : null,
    powerWorker: release ? path.join(root, 'bin', 'power-worker.cjs') : null,
    // Agent-Net node: the encrypted core runs in this worker beside its wasm (docs/agent-net-session-plan.md 阶段 5).
    agentNetWorker: release ? path.join(root, 'bin', 'agent-net-worker.mjs') : path.join(root, 'packages', 'agent-net', 'dist', 'node-worker.mjs'),
    agentNetCore: release ? resource('agent-net', 'core.wasm') : path.join(root, 'packages', 'agent-net-core', 'dist', 'core.wasm'),
    credentialScript: release ? path.join(root, 'bin', 'electron-codec.cjs') : path.join(root, 'apps', 'host', 'src', 'credentials', 'electron-codec.cjs'),
    // The Chromium proxy helper (chromium-proxy-worker.cjs, row 28c), run by electronBinary; macOS and Windows releases only.
    proxyWorker: release?.electronBinary ? path.join(root, 'bin', 'chromium-proxy-worker.cjs') : null,
    electronBinary: release?.electronBinary ? path.join(root, release.electronBinary) : null,
    chromiumExecutable: release?.chromiumExecutable ? path.join(root, release.chromiumExecutable) : null,
    harnessRoot: release ? resource('harnesses') : path.join(root, 'apps'),
  };
}
