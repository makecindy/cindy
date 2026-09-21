#!/usr/bin/env node

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'darwin' || process.arch !== 'arm64') {
  throw new Error('This local installer requires an Apple Silicon Mac.');
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const installedApp = '/Applications/Cindy.app';
const builtApp = path.join(repoRoot, 'apps/desktop/out/Cindy-darwin-arm64/Cindy.app');
const macosSdk = execFileSync('/usr/bin/xcrun', ['--sdk', 'macosx', '--show-sdk-path'], {
  encoding: 'utf8',
}).trim();
if (!macosSdk || !fs.existsSync(macosSdk)) {
  throw new Error(`Could not resolve a usable macOS SDK: ${macosSdk || '(empty)'}`);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    stdio: 'inherit',
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} exited with status ${result.status}`);
  }
}

function cindyIsRunning() {
  return spawnSync('/usr/bin/pgrep', ['-f', '/Cindy\.app/Contents/MacOS/Cindy$'], {
    stdio: 'ignore',
  }).status === 0;
}

console.log('==> Closing Cindy...');
if (cindyIsRunning()) try {
  execFileSync('/usr/bin/osascript', ['-e', 'tell application "Cindy" to quit'], {
    stdio: 'ignore',
  });
} catch {
  // The check below fails closed if the running application did not quit.
}

const deadline = Date.now() + 15_000;
while (cindyIsRunning() && Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, 250));
}
if (cindyIsRunning()) {
  throw new Error('Cindy is still running after the close request; refusing to delete the app.');
}

console.log('==> Building and packaging the ARM64 global desktop app...');
run('pnpm', [
  '--filter',
  'desktop',
  'release:package',
  '--',
  '--arch',
  'arm64',
  '--region',
  'global',
  '--no-sign',
  '--skip-smoke',
], {
  env: {
    ...process.env,
    SDKROOT: macosSdk,
    NODE_OPTIONS: '--max-old-space-size=12288',
    CINDY_SKIP_IOS_SIMULATOR_RELEASE_GATE: '1',
  },
});

if (!fs.existsSync(builtApp)) {
  throw new Error(`Build completed without producing ${builtApp}`);
}

run('/usr/bin/codesign', ['--verify', '--deep', '--strict', builtApp]);
// Build and verify before replacing the installed app. Stage on the same
// filesystem so installation and rollback use renames, never a partial copy.
const installDir = fs.mkdtempSync('/Applications/.cindy-install-');
const stagedApp = path.join(installDir, 'Cindy.app');
const previousApp = path.join(installDir, 'Cindy-previous.app');
run('/usr/bin/ditto', [builtApp, stagedApp]);
run('/usr/bin/codesign', ['--verify', '--deep', '--strict', stagedApp]);
if (cindyIsRunning()) {
  throw new Error(`Cindy was reopened during the build. Close it before installing ${stagedApp}`);
}
let backedUp = false;
try {
  if (fs.existsSync(installedApp)) {
    fs.renameSync(installedApp, previousApp);
    backedUp = true;
  }
  fs.renameSync(stagedApp, installedApp);
} catch (error) {
  if (backedUp && !fs.existsSync(installedApp)) fs.renameSync(previousApp, installedApp);
  throw error;
}
if (backedUp) console.log(`==> Previous app retained at ${previousApp}`);
const shouldLaunch = process.env.CINDY_LAUNCH_AFTER_INSTALL === '1';
if (shouldLaunch) {
  run('/usr/bin/open', ['-a', installedApp]);
  console.log('==> Cindy is installed and launching.');
} else {
  console.log('==> Cindy is installed and left closed (set CINDY_LAUNCH_AFTER_INSTALL=1 to launch).');
}
