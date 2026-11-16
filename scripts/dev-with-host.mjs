#!/usr/bin/env node
/**
 * Run the desktop against a cindy-host.
 *
 * This explicit developer entry reads host-endpoint.json and sets CINDY_HOST_API
 * for its desktop child. Normal desktop startup does not discover a host.
 * The wrapper starts a host when needed and reuses an existing one as-is.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveHostDataDir } from '../apps/host/src/profile-path.mjs';
import { ensureBackgroundHost, existingHost } from '../apps/host/src/background.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const userDataDir = resolveHostDataDir();

/**
 * The host serves the real renderer bundle, and a desktop build wipes it. Build
 * it first so `pnpm dev:host` never serves a 404 to the browser client.
 */
async function ensureRendererBundle() {
  const entry = path.join(repoRoot, 'apps/desktop/.vite/renderer/main_window/index.html');
  if (fs.existsSync(entry)) return;
  console.log('[dev:host] building the renderer bundle');
  const build = spawn(process.execPath, [process.env.npm_execpath, '--filter', 'desktop', 'exec', 'vite', 'build', '--config', 'vite.renderer.config.ts'], {
    cwd: repoRoot,
    stdio: 'inherit',
  });
  const code = await new Promise((resolve) => build.on('exit', resolve));
  if (code !== 0) {
    console.error('[dev:host] renderer build failed');
    process.exit(code ?? 1);
  }
}

await ensureRendererBundle();
const host = await ensureBackgroundHost({ profile: userDataDir, command: process.execPath,
  args: ['--import', 'tsx', '--import', './apps/host/src/loaders/register-raw.mjs', 'apps/host/src/main.ts', 'serve'],
  cwd: repoRoot });
console.log(`[dev:host] ${host.started ? 'started' : 'reusing'} background Host PID ${host.pid}`);
console.log('[dev:host] Closing this desktop leaves tasks running. Use cindy-host stop to stop the backend explicitly.');
// Recheck after preparation and never silently choose a replacement backend.
const attached = await existingHost(userDataDir);
if (attached?.instanceId !== host.instanceId) throw new Error('Host changed before desktop attachment; retry explicitly');

const desktop = spawn(process.execPath, [process.env.npm_execpath, '--filter', 'desktop', 'dev', ...process.argv.slice(2)], {
  cwd: repoRoot,
  stdio: 'inherit',
  env: { ...process.env, XDT_USER_DATA_DIR: userDataDir, CINDY_HOST_API: host.baseUrl, CINDY_HOST_INSTANCE: host.instanceId },
});

process.on('SIGINT', () => desktop.kill('SIGINT'));
process.on('SIGTERM', () => desktop.kill('SIGTERM'));
desktop.on('error', error => { console.error(error.message); process.exitCode = 1; });

desktop.on('exit', (code) => {
  process.exitCode = code ?? 1;
});
