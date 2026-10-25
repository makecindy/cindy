import { app, protocol } from 'electron';
import path from 'node:path';
import { access } from 'node:fs/promises';
import { mkdirSync, lstatSync, chmodSync } from 'node:fs';
import { TerminalService } from '../../../cindy-terminal/src/service';
import { configureTerminalDistribution } from '../../../cindy-terminal/src/version';
import { privateDirectory } from '../../../cindy-terminal/src/platform';
import { createTerminalDesktopPlatform } from './remote-desktop/terminalPlatform';
import { createTerminalFilePeerRuntime } from './remote-desktop/terminalFilePeerRuntime';
import { desktopDirectRuntime } from './device-link/directLink';
import { initLogger, createLogger } from './logger';
import { setMainLocale } from './i18n';

declare const __CINDY_SOURCE_NODE_BINARY__: string;
declare const __CINDY_PLATFORM_REGION__: 'global' | 'cn';

// This is a separate signed entry, never a general-purpose helper RPC. It owns
// the same profile lock, account, device-link and business services as Node.
protocol.registerSchemesAsPrivileged([
  { scheme: 'cindy-desktop-capture', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);
app.on('window-all-closed', () => { /* A temporary capture window is not the host lifetime. */ });

async function main() {
  const index = process.argv.indexOf('--state-dir');
  const directory = index >= 0 ? process.argv[index + 1] : undefined;
  if (!directory || !path.isAbsolute(directory) || /[\0\r\n]/.test(directory)) throw new Error('INVALID_STATE_DIRECTORY');
  const graphicalData = path.join(directory, 'desktop-platform');
  // Electron's session paths must be set before the first asynchronous yield,
  // including directory setup; otherwise Chromium can start on the old path.
  for (const root of [directory, graphicalData]) {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const stat = lstatSync(root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('UNSAFE_PROFILE_DIRECTORY');
    if (process.platform !== 'win32') {
      if (stat.uid !== process.getuid?.()) throw new Error('PROFILE_OWNER_MISMATCH');
      chmodSync(root, 0o700);
    }
  }
  app.setPath('userData', graphicalData);
  app.setPath('sessionData', graphicalData);
  await privateDirectory(directory);
  await privateDirectory(graphicalData);
  const distribution = app.isPackaged
    ? path.join(process.resourcesPath, 'terminal')
    : path.resolve(app.getAppPath(), '../cindy-terminal');
  const runtimeDirectory = app.isPackaged ? path.join(distribution, 'app/dist') : path.join(distribution, 'dist');
  const node = app.isPackaged
    ? path.join(distribution, 'runtime', process.platform === 'win32' ? 'node.exe' : 'node')
    : __CINDY_SOURCE_NODE_BINARY__;
  await Promise.all([access(node), access(path.join(runtimeDirectory, 'build-info.json'))]);
  configureTerminalDistribution({ directory: runtimeDirectory, node });
  initLogger();
  await app.whenReady();
  app.dock?.hide();
  const host = new TerminalService(directory, __CINDY_PLATFORM_REGION__, {
    desktopHost: { executable: process.execPath, args: app.isPackaged ? [] : [path.join(app.getAppPath(), '.cindy-terminal-platform.mjs')] },
    directRuntime: desktopDirectRuntime,
    createFilePeerRuntime: createTerminalFilePeerRuntime,
    createDesktopPlatform: context => {
      setMainLocale(context.settings.snapshot().effective.language);
      return createTerminalDesktopPlatform(context);
    },
  });
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    void host.close().then(() => app.exit(0), () => app.exit(1));
  };
  app.on('before-quit', event => { event.preventDefault(); stop(); });
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  process.on('message', message => {
    if ((message as { type?: unknown } | null)?.type === 'cindy:service-stop') stop();
  });
  if (process.send) process.once('disconnect', stop);
  await host.start();
  await host.stopped;
  app.exit(0);
}

void main().catch(error => {
  createLogger('terminal-platform').error('Platform host startup failed', error);
  const code = error instanceof Error && /^[A-Z][A-Z_]{0,63}$/.test(error.message) ? error.message : 'TERMINAL_PLATFORM_START_FAILED';
  process.stderr.write(`${code}\n`);
  app.exit(1);
});
